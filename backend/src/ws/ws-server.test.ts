/**
 * Transport-level tests: these drive a real HTTP server, a real `ws` client,
 * and real frames. The behaviours here — heartbeat termination, handshake
 * timeouts, close codes — are exactly the ones that cannot be verified by
 * calling methods directly, because they only exist as protocol on the wire.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { WS_CLOSE, type BotLevel, type ServerMessage } from '@hcg/shared';
import { PluginManager } from '../core/plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../core/plugin/plugin-repository.js';
import { InMemoryMatchRepository } from '../core/persistence/match-repository.js';
import { AsyncPersistenceWriter } from '../core/persistence/persist-writer.js';
import { MatchManager } from '../core/match/match-manager.js';
import { LocalEventBus } from '../core/cluster/event-bus.js';
import { LocalOwnershipRegistry } from '../core/cluster/ownership-registry.js';
import { MatchGateway } from '../core/cluster/match-gateway.js';
import { AuthService } from '../core/auth/auth-service.js';
import { InMemoryUserRepository } from '../core/auth/user-repository.js';
import { InMemoryRateLimiter } from '../core/ratelimit/rate-limiter.js';
import { WsServer } from './ws-server.js';
import type { LLMDecisionRequest, LLMDecisionResponse, LLMProvider } from '../core/ai/provider.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'games');
const ORIGIN = 'http://localhost:5173';

class AlwaysFirstMoveProvider implements LLMProvider {
  readonly name = 'always-first';
  decide(req: LLMDecisionRequest): Promise<LLMDecisionResponse> {
    return Promise.resolve({ moveId: req.legalMoveIds[0]!, reasoning: 'test stub' });
  }
}

function allTiers(provider: LLMProvider, llmTimeoutMs = 1000) {
  return {
    easy: { provider, llmTimeoutMs, memoryFraction: 1 },
    medium: { provider, llmTimeoutMs, memoryFraction: 1 },
    hard: { provider, llmTimeoutMs, memoryFraction: 1 },
    extreme: { provider, llmTimeoutMs, memoryFraction: 1 },
  } as const satisfies Record<
    BotLevel,
    { provider: LLMProvider; llmTimeoutMs: number; memoryFraction: number }
  >;
}

interface Harness {
  readonly url: string;
  readonly token: string;
  readonly wsServer: WsServer;
  readonly httpServer: Server;
  readonly limiter: InMemoryRateLimiter;
  stop(): Promise<void>;
}

const harnesses: Harness[] = [];

async function start(overrides: { heartbeatIntervalMs?: number; authTimeoutMs?: number } = {}): Promise<Harness> {
  const plugins = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
  const repository = new InMemoryMatchRepository();
  const manager = new MatchManager({
    plugins,
    botTiers: allTiers(new AlwaysFirstMoveProvider()),
    defaultBotLevel: 'easy',
    persistence: new AsyncPersistenceWriter(repository),
    aiMoveMinDelayMs: 0,
    roundIntermissionMs: 0,
  });
  const gateway = new MatchGateway({
    manager,
    bus: new LocalEventBus(),
    registry: new LocalOwnershipRegistry(),
    repository,
    nodeId: 'test-node',
  });
  await gateway.start();

  const authService = new AuthService(new InMemoryUserRepository());
  const { token } = await authService.register('ws@example.com', 'correct horse battery', 'Wanda');
  const limiter = new InMemoryRateLimiter();

  const httpServer = createServer();
  const wsServer = new WsServer({
    httpServer,
    gateway,
    authService,
    rateLimiter: limiter,
    originPolicy: { allowed: [ORIGIN], isProduction: true },
    listGames: (userId) => plugins.summaries(userId),
    ...overrides,
  });
  wsServer.start();

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as { port: number }).port;

  const harness: Harness = {
    url: `ws://127.0.0.1:${port}`,
    token,
    wsServer,
    httpServer,
    limiter,
    async stop() {
      limiter.stop();
      await wsServer.close();
      await gateway.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.allSettled(harnesses.splice(0).map((h) => h.stop()));
});

/** Opens a socket and collects every message it receives. */
function connect(h: Harness, origin: string = ORIGIN): { ws: WebSocket; seen: ServerMessage[] } {
  const ws = new WebSocket(h.url, { origin });
  const seen: ServerMessage[] = [];
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString()) as ServerMessage));
  return { ws, seen };
}

function authenticated(h: Harness): Promise<{ ws: WebSocket; seen: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const conn = connect(h);
    conn.ws.on('open', () => conn.ws.send(JSON.stringify({ type: 'AUTHENTICATE', token: h.token })));
    conn.ws.on('message', () => {
      if (conn.seen.some((m) => m.type === 'AUTHENTICATED')) resolve(conn);
    });
    conn.ws.on('error', reject);
    setTimeout(() => reject(new Error('never authenticated')), 4000);
  });
}

function closedWith(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

describe('WebSocket upgrade', () => {
  it('refuses an upgrade from an origin that is not allowlisted', async () => {
    const h = await start();
    const { ws } = connect(h, 'https://evil.example');

    // A rejected upgrade surfaces to the client as a connection error, since
    // the handshake never completes.
    await expect(new Promise((_, reject) => ws.on('error', reject))).rejects.toThrow();
  });

  it('accepts an upgrade from an allowlisted origin', async () => {
    const h = await start();
    const { ws } = connect(h);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.close();
  });
});

describe('WebSocket authentication', () => {
  it('closes with AUTH_FAILED on a bad token, so the client knows not to retry', async () => {
    const h = await start();
    const { ws, seen } = connect(h);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'AUTHENTICATE', token: 'nonsense' })));

    expect(await closedWith(ws)).toBe(WS_CLOSE.AUTH_FAILED);
    expect(seen.some((m) => m.type === 'ERROR' && m.code === 'UNAUTHENTICATED')).toBe(true);
  });

  it('closes a socket that never authenticates', async () => {
    const h = await start({ authTimeoutMs: 120 });
    const { ws } = connect(h);

    expect(await closedWith(ws)).toBe(WS_CLOSE.AUTH_TIMEOUT);
  });

  it('refuses every other message until the handshake completes', async () => {
    const h = await start();
    const { ws, seen } = connect(h);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'LIST_GAMES' })));

    await waitUntil(() => seen.length > 0);
    expect(seen[0]).toMatchObject({ type: 'ERROR', code: 'UNAUTHENTICATED' });
    ws.close();
  });
});

describe('WebSocket heartbeat', () => {
  it('terminates a connection that stops answering pings', async () => {
    const h = await start({ heartbeatIntervalMs: 80 });
    const conn = await authenticated(h);

    // Simulate a client whose link died without a close frame: swallow the
    // ping so no pong is ever sent back.
    conn.ws.removeAllListeners('ping');
    conn.ws.on('ping', () => {
      /* deliberately silent */
    });
    // `ws` auto-replies to pings at the protocol level, so suppress that too.
    (conn.ws as unknown as { _receiver: { removeAllListeners(e: string): void } })._receiver.removeAllListeners('ping');

    await closedWith(conn.ws);
    expect(h.wsServer.connectionCount).toBe(0);
  }, 10_000);

  it('answers an application-level PING, which is the only heartbeat a browser can send', async () => {
    const h = await start();
    const conn = await authenticated(h);

    conn.ws.send(JSON.stringify({ type: 'PING', nonce: 7 }));
    await waitUntil(() => conn.seen.some((m) => m.type === 'PONG'));

    expect(conn.seen.find((m) => m.type === 'PONG')).toMatchObject({ nonce: 7 });
    conn.ws.close();
  });
});

describe('WebSocket limits', () => {
  it('rate limits a flood without dropping the connection', async () => {
    const h = await start();
    const conn = await authenticated(h);

    for (let i = 0; i < 100; i++) conn.ws.send(JSON.stringify({ type: 'LIST_GAMES' }));
    await waitUntil(() => conn.seen.some((m) => m.type === 'ERROR' && m.code === 'RATE_LIMITED'));

    const limited = conn.seen.find((m) => m.type === 'ERROR' && m.code === 'RATE_LIMITED');
    expect(limited).toMatchObject({ code: 'RATE_LIMITED' });
    expect((limited as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    // Still connected — a flood is throttled, not fatal.
    expect(conn.ws.readyState).toBe(WebSocket.OPEN);
    conn.ws.close();
  });

  it('rejects an oversized frame instead of buffering it', async () => {
    const h = await start();
    const conn = await authenticated(h);

    conn.ws.send(JSON.stringify({ type: 'LIST_GAMES', padding: 'x'.repeat(64 * 1024) }));

    // 1009 is the RFC 6455 "message too big" code, sent by `ws` itself.
    expect(await closedWith(conn.ws)).toBe(1009);
  });

  it('answers malformed input with an error rather than falling over', async () => {
    const h = await start();
    const conn = await authenticated(h);

    conn.ws.send('this is not json');
    await waitUntil(() => conn.seen.some((m) => m.type === 'ERROR' && m.code === 'MALFORMED_MESSAGE'));

    expect(conn.ws.readyState).toBe(WebSocket.OPEN);
    conn.ws.close();
  });
});

describe('WebSocket shutdown', () => {
  it('closes clients with GOING_AWAY so they reconnect promptly instead of timing out', async () => {
    const h = await start();
    const conn = await authenticated(h);

    const closed = closedWith(conn.ws);
    await h.wsServer.close();

    expect(await closed).toBe(WS_CLOSE.GOING_AWAY);
  });

  it('refuses new upgrades once shutdown has begun', async () => {
    const h = await start();
    await h.wsServer.close();

    const { ws } = connect(h);
    await expect(new Promise((_, reject) => ws.on('error', reject))).rejects.toThrow();
  });
});

async function waitUntil(pred: () => boolean, ms = 4000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > ms) throw new Error('condition never became true');
    await new Promise((r) => setTimeout(r, 20));
  }
}
