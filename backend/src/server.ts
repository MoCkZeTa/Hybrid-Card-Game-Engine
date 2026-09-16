/**
 * Application entry point (PRD directive 7): boots the plugin catalog, the
 * LLM provider, persistence, auth, Redis, and the HTTP+WebSocket server, then
 * hands client traffic to `WsServer` → `MatchGateway` → `MatchManager`.
 *
 * HTTP and WebSocket share one port: `/api/*` is handled by the HTTP routers,
 * `/health` and `/ready` answer probes, and everything else upgrades to a
 * WebSocket.
 *
 * **Redis is optional.** Without `REDIS_URL` the process runs exactly as it
 * always has — one node, all state in memory — because every Redis-backed
 * component has an in-memory sibling behind the same interface. With it, the
 * same build runs as many instances as you like behind any load balancer:
 * matches are owned by one node at a time and commands are routed there
 * (`core/cluster/match-gateway.ts`).
 */

import { config as loadEnv } from 'dotenv';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { PluginManager } from './core/plugin/plugin-manager.js';
import { InMemoryPluginRepository, type PluginRepository } from './core/plugin/plugin-repository.js';
import { MongoPluginRepository } from './core/plugin/mongo-plugin-repository.js';
import { createBotTiersFromEnv, createDesignerProviderFromEnv } from './core/ai/provider-router.js';
import { GameDesigner } from './core/authoring/game-designer.js';
import { DesignService } from './core/authoring/design-service.js';
import {
  InMemoryDesignSessionRepository,
  type DesignSessionRepository,
} from './core/authoring/design-session-repository.js';
import { MongoDesignSessionRepository } from './core/authoring/mongo-design-session-repository.js';
import { InMemoryMatchRepository, type MatchRepository } from './core/persistence/match-repository.js';
import { MongoMatchRepository } from './core/persistence/mongo-match-repository.js';
import { AsyncPersistenceWriter } from './core/persistence/persist-writer.js';
import { MatchManager } from './core/match/match-manager.js';
import { createConsoleDecisionLogger, logMatchStart } from './core/ai/decision-logger.js';
import { AuthService } from './core/auth/auth-service.js';
import { InMemoryUserRepository, type UserRepository } from './core/auth/user-repository.js';
import { MongoUserRepository } from './core/auth/mongo-user-repository.js';
import { InMemorySessionCache, RedisSessionCache, type SessionCache } from './core/auth/session-cache.js';
import { createEmailSenderFromEnv } from './core/auth/email-sender.js';
import { createAuthHandler } from './http/auth-routes.js';
import { createStaticHandler } from './http/static-files.js';
import { assertEnvUsable } from './config/env.js';
import { createPluginHandler } from './http/plugin-routes.js';
import { createDesignHandler } from './http/design-routes.js';
import { createRedisBundle, redisConfigFromEnv, type RedisBundle } from './core/redis/redis-client.js';
import { LocalEventBus, RedisEventBus, type EventBus } from './core/cluster/event-bus.js';
import {
  LocalOwnershipRegistry,
  RedisOwnershipRegistry,
  type OwnershipRegistry,
} from './core/cluster/ownership-registry.js';
import { MatchGateway } from './core/cluster/match-gateway.js';
import {
  LocalConnectionRegistry,
  RedisConnectionRegistry,
  type ConnectionRegistry,
} from './core/cluster/connection-registry.js';
import { InMemoryRateLimiter, RedisRateLimiter, type RateLimiter } from './core/ratelimit/rate-limiter.js';
import { WsServer } from './ws/ws-server.js';
import { parseAllowedOrigins } from './ws/origin.js';
import { installShutdownHandlers } from './lifecycle/shutdown.js';

// Loaded from the repo root regardless of the workspace's own cwd — `npm run
// dev --workspace backend` runs with cwd=backend/, where no .env exists.
loadEnv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') });

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'games');
const PORT = Number(process.env.PORT ?? 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const APP_BASE_URL = process.env.APP_BASE_URL ?? CORS_ORIGIN;

async function main(): Promise<void> {
  // Before anything opens a socket or a connection pool: every optional
  // dependency in this server degrades quietly by design, which is right in
  // development and indistinguishable from working in production. This throws
  // instead of booting when a production process is configured to degrade.
  assertEnvUsable(process.env);

  const { tiers: botTiers, defaultLevel: defaultBotLevel } = createBotTiersFromEnv(process.env);
  // `createBotTiersFromEnv` always populates every `BotLevel` — `!` because
  // `Record` indexing is widened to `| undefined` under `noUncheckedIndexedAccess`.
  const easyProvider = botTiers.easy!.provider;
  const keyCount = (easyProvider as { keyCount?: number }).keyCount;
  console.log(
    `AI provider: ${easyProvider.name}${keyCount ? ` (${keyCount} key${keyCount === 1 ? '' : 's'} in rotation)` : ''}, default bot level: ${defaultBotLevel}`,
  );
  for (const level of ['easy', 'medium', 'hard', 'extreme'] as const) {
    console.log(`  bot level "${level}": timeout ${botTiers[level]!.llmTimeoutMs}ms`);
  }

  // --- Redis (optional) ----------------------------------------------------
  let redis: RedisBundle | null = null;
  const redisConfig = redisConfigFromEnv(process.env);
  if (redisConfig) {
    try {
      redis = await createRedisBundle(redisConfig);
      console.log(`Connected to Redis — clustering, shared rate limits, and session caching are active`);
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      if (IS_PRODUCTION) {
        // In production, REDIS_URL being set means someone is running more
        // than one instance. Booting without it would silently split the
        // cluster into nodes that cannot see each other's matches — far worse
        // than failing to start.
        throw new Error(`REDIS_URL is set but Redis is unreachable, and NODE_ENV=production: ${detail}`);
      }
      console.error(`\n  Redis connection FAILED: ${detail}`);
      console.error('  Falling back to single-node, in-memory coordination.');
      console.error('  → Fine for local development; do not run more than one instance like this.\n');
    }
  } else {
    console.log('REDIS_URL not set — running single-node (in-memory coordination)');
  }

  const bus: EventBus = redis ? new RedisEventBus(redis) : new LocalEventBus();
  const registry: OwnershipRegistry = redis ? new RedisOwnershipRegistry(redis) : new LocalOwnershipRegistry();
  const rateLimiter: RateLimiter = redis ? new RedisRateLimiter(redis) : new InMemoryRateLimiter();
  const sessionCache: SessionCache = redis ? new RedisSessionCache(redis) : new InMemorySessionCache();
  const connectionRegistry: ConnectionRegistry = redis
    ? new RedisConnectionRegistry(redis)
    : new LocalConnectionRegistry();

  // --- Storage -------------------------------------------------------------
  let matchRepository: MatchRepository;
  let userRepository: UserRepository;
  let pluginRepository: PluginRepository;
  let designSessionRepository: DesignSessionRepository;
  let mongoClient: MongoClient | null = null;

  if (process.env.MONGODB_URI) {
    try {
      mongoClient = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      await mongoClient.connect();
      const db = mongoClient.db();
      matchRepository = await MongoMatchRepository.fromDb(db);
      userRepository = await MongoUserRepository.create(db);
      pluginRepository = await MongoPluginRepository.fromDb(db);
      designSessionRepository = await MongoDesignSessionRepository.fromDb(db);
      console.log('Connected to MongoDB — matches, accounts, imported plugins, and game designs are durable');
    } catch (err) {
      const detail = (err instanceof Error ? err.message.split('\n')[0] : String(err)) ?? 'unknown error';
      if (IS_PRODUCTION) {
        // In production, silently losing durability is worse than not booting.
        throw new Error(`MongoDB setup failed and NODE_ENV=production: ${detail}`);
      }

      console.error(`\n  MongoDB setup FAILED: ${detail}`);
      console.error('  Falling back to in-memory storage.');
      console.error('  → Accounts and games will be LOST on restart.');
      // Point at the actual cause rather than guessing — a failed index build
      // means we reached the server fine and the problem is the data itself.
      if (/E11000|duplicate key|Index build failed/i.test(detail)) {
        console.error('  → Cause: an index could not be built because existing documents violate it.');
        console.error('    Check for pre-existing collections in this database that conflict.');
      } else {
        console.error('  → Check the Atlas Network Access allowlist and that the cluster is not paused.');
      }
      console.error('');

      mongoClient = null;
      matchRepository = new InMemoryMatchRepository();
      userRepository = new InMemoryUserRepository();
      pluginRepository = new InMemoryPluginRepository();
      designSessionRepository = new InMemoryDesignSessionRepository();
    }
  } else {
    if (IS_PRODUCTION) throw new Error('MONGODB_URI is required when NODE_ENV=production');
    console.warn('MONGODB_URI not set — using in-memory storage (nothing survives a restart)');
    matchRepository = new InMemoryMatchRepository();
    userRepository = new InMemoryUserRepository();
    pluginRepository = new InMemoryPluginRepository();
    designSessionRepository = new InMemoryDesignSessionRepository();
  }

  const emailSender = createEmailSenderFromEnv(process.env);
  const authService = new AuthService(userRepository, sessionCache, {
    emailSender,
    appBaseUrl: APP_BASE_URL,
  });
  console.log(`Email sender: ${emailSender.name} (reset links point at ${APP_BASE_URL})`);
  const persistence = new AsyncPersistenceWriter(matchRepository);

  const plugins = await PluginManager.loadAll(gamesRoot, pluginRepository);
  console.log(`Loaded built-in game plugins: ${plugins.list().map((p) => p.gameId).join(', ')}`);

  // AI decision logging is on by default — set LOG_AI=false to silence it.
  // LOG_AI_VERBOSE=true prints full reasoning instead of truncating it.
  const aiLogging = process.env.LOG_AI !== 'false';
  const manager = new MatchManager({
    plugins,
    botTiers,
    defaultBotLevel,
    persistence,
    ...(aiLogging
      ? { onDecision: createConsoleDecisionLogger({ verbose: process.env.LOG_AI_VERBOSE === 'true' }) }
      : {}),
  });

  const gateway = new MatchGateway({
    manager,
    bus,
    registry,
    repository: matchRepository,
    ...(process.env.NODE_ID ? { nodeId: process.env.NODE_ID } : {}),
    ...(process.env.MATCH_LEASE_TTL_MS ? { leaseTtlMs: Number(process.env.MATCH_LEASE_TTL_MS) } : {}),
  });
  await gateway.start();
  console.log(`Node id: ${gateway.nodeId}`);

  // --- AI game designer (optional) -----------------------------------------
  // The one feature here with no degraded mode: drafting a rules.json needs a
  // generative call, and there is no `legal_moves[0]` to fall back on. With no
  // key the routes still mount and report *why* they are unavailable, so the
  // client hides the feature instead of offering a button that always fails.
  const designerProvider = createDesignerProviderFromEnv(process.env);
  const designService = designerProvider.available
    ? new DesignService(
        new GameDesigner(designerProvider.provider, {
          ...(process.env.DESIGNER_TIMEOUT_MS ? { timeoutMs: Number(process.env.DESIGNER_TIMEOUT_MS) } : {}),
          ...(process.env.DESIGNER_MAX_TOKENS ? { maxTokens: Number(process.env.DESIGNER_MAX_TOKENS) } : {}),
        }),
        designSessionRepository,
        plugins,
      )
    : null;
  if (designService) {
    console.log(`AI game designer: enabled (${designService.modelLabel})`);
  } else if (!designerProvider.available) {
    console.log(`AI game designer: disabled — ${designerProvider.reason}`);
  }

  // --- HTTP + WebSocket on one port ----------------------------------------
  const handleAuth = createAuthHandler(authService, CORS_ORIGIN, IS_PRODUCTION, rateLimiter);
  const handlePlugins = createPluginHandler(plugins, authService, CORS_ORIGIN, IS_PRODUCTION);
  const handleDesign = createDesignHandler({
    service: designService,
    ...(designerProvider.available ? {} : { unavailableReason: designerProvider.reason }),
    authService,
    allowedOrigin: CORS_ORIGIN,
    isProduction: IS_PRODUCTION,
    rateLimiter,
  });

  /** Flipped false at the first shutdown signal so a load balancer drains us before we stop. */
  let ready = true;

  // Optional single-container mode: serve the built client from this process
  // too, so there is one origin, one deploy, and no CORS to configure.
  const staticRoot =
    process.env.FRONTEND_DIST ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'dist');
  const handleStatic = process.env.SERVE_STATIC === 'true' ? createStaticHandler({ root: staticRoot }) : null;
  if (handleStatic) console.log(`Serving built frontend from ${staticRoot}`);

  const httpServer = createServer((req, res) => {
    const url = req.url ?? '';

    // Liveness: is the process up at all? Never fails while we can answer.
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', nodeId: gateway.nodeId, uptimeSeconds: Math.round(process.uptime()) }));
      return;
    }

    // Readiness: should traffic be sent here? Goes false the moment we start
    // draining, which is the signal a load balancer needs to stop routing new
    // connections while existing ones finish.
    if (url === '/ready') {
      // Redis health is read live rather than reported from the boot-time
      // outcome. A node whose Redis died can no longer see the rest of the
      // cluster's matches, and a probe that keeps answering 200 because the
      // *connect* succeeded hours ago is how a balancer keeps feeding it
      // traffic.
      const redisHealth = redis?.health() ?? null;
      const degraded = redisHealth !== null && !redisHealth.healthy;
      res.writeHead(ready && !degraded ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ready: ready && !degraded,
          draining: !ready,
          nodeId: gateway.nodeId,
          connections: wsServer.connectionCount,
          redis: redisHealth ? { configured: true, ...redisHealth } : { configured: false },
          mongo: mongoClient !== null,
        }),
      );
      return;
    }

    // Plugin and design routes first — the auth handler claims all of /api/*
    // and would otherwise 404 them. Static files last, so a route never
    // shadows the API.
    void handlePlugins(req, res)
      .then((handled) => (handled ? true : handleDesign(req, res)))
      .then((handled) => (handled ? true : handleAuth(req, res)))
      .then((handled) => (handled || !handleStatic ? handled : handleStatic(req, res)))
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        }
      })
      .catch((err) => {
        console.error('[http] unhandled error:', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      });
  });

  // A client that opens a connection and sends nothing must not hold a socket
  // forever; `ws` upgrades happen well inside these.
  httpServer.headersTimeout = 20_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 65_000;

  const wsServer = new WsServer({
    httpServer,
    gateway,
    authService,
    rateLimiter,
    originPolicy: {
      allowed: parseAllowedOrigins(process.env.CORS_ORIGIN ?? CORS_ORIGIN),
      isProduction: IS_PRODUCTION,
    },
    listGames: (userId) => plugins.summaries(userId),
    connectionRegistry,
    ...(aiLogging ? { onMatchStart: logMatchStart } : {}),
    ...(process.env.WS_HEARTBEAT_MS ? { heartbeatIntervalMs: Number(process.env.WS_HEARTBEAT_MS) } : {}),
    ...(process.env.WS_MAX_CONNECTIONS ? { maxConnections: Number(process.env.WS_MAX_CONNECTIONS) } : {}),
  });
  wsServer.start();

  httpServer.listen(PORT, () => {
    console.log(`HTTP  auth API   : http://localhost:${PORT}/api/auth`);
    console.log(`HTTP  plugin API : http://localhost:${PORT}/api/plugins`);
    console.log(`HTTP  design API : http://localhost:${PORT}/api/design`);
    console.log(`HTTP  probes     : http://localhost:${PORT}/health, /ready`);
    console.log(`WS    game server: ws://localhost:${PORT}`);
    console.log(`CORS  allowed from: ${CORS_ORIGIN}`);
  });

  installShutdownHandlers({
    /**
     * Order matters. Stop advertising readiness first so the balancer drains
     * us; close sockets next so clients reconnect elsewhere immediately rather
     * than waiting out a heartbeat; hand back match ownership after that so a
     * surviving node can pick the matches up; and only then close the stores
     * the last in-flight persistence writes are still using.
     */
    drain: async () => {
      ready = false;
    },
    steps: [
      { name: 'websocket clients', run: () => wsServer.close() },
      { name: 'match ownership', run: () => gateway.close() },
      { name: 'http server', run: () => new Promise<void>((resolve) => httpServer.close(() => resolve())) },
      { name: 'event bus', run: () => bus.close() },
      {
        name: 'rate limiter',
        run: async () => {
          // Both implementations own an interval; the Redis one owns its
          // fallback's. Unref'd, so this is tidiness rather than a leak.
          (rateLimiter as { stop?: () => void }).stop?.();
        },
      },
      { name: 'redis', run: async () => redis?.close() },
      { name: 'mongo', run: async () => mongoClient?.close() },
    ],
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exitCode = 1;
});
