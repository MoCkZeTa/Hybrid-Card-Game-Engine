/**
 * Startup configuration checks.
 *
 * Every fallback in this server is deliberate and good: no Mongo means memory,
 * no Redis means single-node, no mail key means reset links print to the
 * console. Each one exists so `npm run dev` works with an empty `.env`.
 *
 * In production every one of them is a silent disaster. A process that boots
 * "fine" and stores accounts in memory looks healthy right up to the first
 * restart, and nothing in the logs after that explains where the accounts went.
 * So the same forgiving default becomes a refusal to start once
 * `NODE_ENV=production`: fail at boot, where a deploy will catch it, rather
 * than at 3am, where a user will.
 *
 * Development gets warnings for the same conditions — visible, but never in the
 * way.
 */

export interface EnvIssue {
  readonly variable: string;
  readonly message: string;
  /** Fatal issues abort a production boot. Everything else is advisory. */
  readonly fatal: boolean;
}

export interface EnvReport {
  readonly issues: readonly EnvIssue[];
  readonly ok: boolean;
}

interface Ctx {
  readonly env: NodeJS.ProcessEnv;
  readonly isProduction: boolean;
  readonly issues: EnvIssue[];
}

function get(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function fail(ctx: Ctx, variable: string, message: string): void {
  // Outside production the same condition is a warning, not a refusal — that is
  // the entire point of the optional-dependency design.
  ctx.issues.push({ variable, message, fatal: ctx.isProduction });
}

function warn(ctx: Ctx, variable: string, message: string): void {
  ctx.issues.push({ variable, message, fatal: false });
}

/** Rejects a value that is present but not a usable positive number. */
function checkPositiveNumber(ctx: Ctx, name: string): void {
  const raw = get(ctx.env, name);
  if (raw === undefined) return;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    // Always fatal: `Number('30s')` is NaN, which silently becomes a timeout
    // that never fires or an interval that throws. A typo here is never
    // something to carry on with.
    ctx.issues.push({ variable: name, message: `must be a positive number, got "${raw}"`, fatal: true });
  }
}

export function validateEnv(env: NodeJS.ProcessEnv): EnvReport {
  const isProduction = env.NODE_ENV === 'production';
  const ctx: Ctx = { env, isProduction, issues: [] };

  // ---- Port ----------------------------------------------------------------
  const port = get(env, 'PORT');
  if (port !== undefined) {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      ctx.issues.push({ variable: 'PORT', message: `must be a port number, got "${port}"`, fatal: true });
    }
  }

  // ---- Durability ----------------------------------------------------------
  if (!get(env, 'MONGODB_URI')) {
    fail(ctx, 'MONGODB_URI', 'not set — accounts, matches, and imported plugins are lost on every restart');
  }

  // ---- Origins -------------------------------------------------------------
  const cors = get(env, 'CORS_ORIGIN');
  if (!cors) {
    fail(ctx, 'CORS_ORIGIN', 'not set — defaults to http://localhost:5173, which no deployed client uses');
  } else if (cors === '*') {
    ctx.issues.push({
      variable: 'CORS_ORIGIN',
      // The WebSocket origin allowlist is built from this value, and it is the
      // defense against cross-site WebSocket hijacking. A wildcard removes it.
      message: 'is "*", which disables the origin allowlist that protects the game socket',
      fatal: isProduction,
    });
  } else if (isProduction && /localhost|127\.0\.0\.1/.test(cors)) {
    fail(ctx, 'CORS_ORIGIN', `points at localhost ("${cors}") in a production build`);
  }

  // ---- Redis ---------------------------------------------------------------
  const redisUrl = get(env, 'REDIS_URL');
  if (redisUrl && !/^rediss?:\/\//.test(redisUrl)) {
    ctx.issues.push({
      variable: 'REDIS_URL',
      message: 'must start with redis:// or rediss://',
      fatal: true,
    });
  }
  if (isProduction && redisUrl && !redisUrl.startsWith('rediss://') && !/localhost|127\.0\.0\.1/.test(redisUrl)) {
    warn(
      ctx,
      'REDIS_URL',
      'is an unencrypted redis:// connection to a remote host — session tokens and match state cross it in clear text',
    );
  }
  checkPositiveNumber(ctx, 'REDIS_COMMAND_TIMEOUT_MS');
  checkPositiveNumber(ctx, 'MATCH_LEASE_TTL_MS');

  // ---- Email ---------------------------------------------------------------
  // Password reset is a shipped feature; without a key it accepts the request,
  // stores a token, and prints the link to a log nobody reads. The user just
  // never gets their email.
  if (!get(env, 'RESEND_API_KEY') && env.ALLOW_CONSOLE_EMAIL !== 'true') {
    fail(
      ctx,
      'RESEND_API_KEY',
      'not set — password-reset links print to the console instead of being emailed (set ALLOW_CONSOLE_EMAIL=true to accept this deliberately)',
    );
  }
  const appBaseUrl = get(env, 'APP_BASE_URL');
  if (!appBaseUrl) {
    fail(ctx, 'APP_BASE_URL', 'not set — password-reset emails would link to http://localhost:5173');
  } else if (!/^https?:\/\//.test(appBaseUrl)) {
    ctx.issues.push({ variable: 'APP_BASE_URL', message: 'must start with http:// or https://', fatal: true });
  } else if (isProduction && appBaseUrl.startsWith('http://')) {
    warn(ctx, 'APP_BASE_URL', 'is http:// — reset tokens would travel over an unencrypted connection');
  }

  // ---- AI provider ---------------------------------------------------------
  const provider = get(env, 'LLM_PROVIDER') ?? 'groq';
  if (provider === 'groq' && !get(env, 'GROQ_API_KEYS') && !get(env, 'GROQ_API_KEY')) {
    // Not fatal by design: the engine's fallback is to play `legal_moves[0]`,
    // so the game still runs. It just plays badly, which is a product problem
    // rather than a safety one.
    warn(ctx, 'GROQ_API_KEYS', 'not set — every AI turn falls back to the first legal move');
  }
  if (provider === 'gemini') {
    warn(ctx, 'LLM_PROVIDER', 'is "gemini", whose provider is an unimplemented stub — every AI turn will fall back');
  }
  checkPositiveNumber(ctx, 'LLM_TIMEOUT_MS');
  checkPositiveNumber(ctx, 'WS_HEARTBEAT_MS');
  checkPositiveNumber(ctx, 'WS_MAX_CONNECTIONS');

  // ---- AI game designer ----------------------------------------------------
  // Advisory in production too, unlike the durability settings above. The
  // designer is an optional authoring feature, not a correctness guarantee: a
  // server without it serves every game it already has, and the client hides
  // the panel rather than offering a control that cannot work. Refusing to boot
  // over it would take a whole deployment down for a missing nice-to-have.
  checkPositiveNumber(ctx, 'DESIGNER_TIMEOUT_MS');
  checkPositiveNumber(ctx, 'DESIGNER_MAX_TOKENS');

  const designerMaxTokens = Number(get(env, 'DESIGNER_MAX_TOKENS') ?? '0');
  if (designerMaxTokens > 0 && designerMaxTokens < 2000) {
    // The visible answer alone — a rules.json plus a strategy.md — is ~2500
    // tokens. Below this the first draft of a session is truncated mid-JSON
    // every single time, which surfaces as "the model gave a cut-off reply"
    // rather than as the budget it actually is.
    warn(
      ctx,
      'DESIGNER_MAX_TOKENS',
      `is ${designerMaxTokens} — too small to hold a rules.json and a strategy.md, so first drafts will be truncated`,
    );
  }

  return { issues: ctx.issues, ok: !ctx.issues.some((issue) => issue.fatal) };
}

/**
 * Prints the report and, if anything fatal turned up, throws rather than
 * booting. Separated from `validateEnv` so the rules stay unit-testable
 * without capturing console output or catching exceptions.
 */
export function assertEnvUsable(env: NodeJS.ProcessEnv): void {
  const report = validateEnv(env);
  if (report.issues.length === 0) return;

  const fatal = report.issues.filter((issue) => issue.fatal);
  const advisory = report.issues.filter((issue) => !issue.fatal);

  for (const issue of advisory) {
    console.warn(`  [config] ${issue.variable}: ${issue.message}`);
  }

  if (fatal.length > 0) {
    const lines = fatal.map((issue) => `  - ${issue.variable}: ${issue.message}`);
    throw new Error(
      `Refusing to start — ${fatal.length} configuration problem${fatal.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
    );
  }
}
