/**
 * The rule these tests protect: the *same* configuration is a warning in
 * development and a refusal to boot in production. Getting that backwards in
 * either direction is bad — a dev environment that will not start without a
 * Mongo URI defeats the optional-dependency design, and a production process
 * that starts anyway is how accounts end up in memory on a live server.
 */

import { describe, expect, it } from 'vitest';
import { assertEnvUsable, validateEnv } from './env.js';

/** A production environment with nothing wrong with it. */
function goodProduction(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb+srv://user:pass@cluster.mongodb.net/cardgame',
    CORS_ORIGIN: 'https://play.example.com',
    APP_BASE_URL: 'https://play.example.com',
    RESEND_API_KEY: 're_live_key',
    GROQ_API_KEYS: 'gsk_one',
  };
}

function fatalVariables(env: NodeJS.ProcessEnv): string[] {
  return validateEnv(env)
    .issues.filter((issue) => issue.fatal)
    .map((issue) => issue.variable);
}

describe('environment validation', () => {
  it('accepts a fully configured production environment', () => {
    const report = validateEnv(goodProduction());
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.fatal)).toHaveLength(0);
  });

  it('accepts an empty development environment, warning only', () => {
    // This is the whole point of the optional-dependency design: `npm run dev`
    // with an empty .env has to work.
    const report = validateEnv({});
    expect(report.ok).toBe(true);
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.issues.every((issue) => !issue.fatal)).toBe(true);
    expect(() => assertEnvUsable({})).not.toThrow();
  });

  it('refuses a production boot with no database', () => {
    const env = goodProduction();
    delete env.MONGODB_URI;
    // Booting here looks healthy until the first restart takes every account
    // with it.
    expect(fatalVariables(env)).toContain('MONGODB_URI');
    expect(() => assertEnvUsable(env)).toThrow(/MONGODB_URI/);
  });

  it('refuses a production boot pointing at localhost', () => {
    const env = { ...goodProduction(), CORS_ORIGIN: 'http://localhost:5173' };
    expect(fatalVariables(env)).toContain('CORS_ORIGIN');
  });

  it('refuses a wildcard origin in production, because it disables the socket allowlist', () => {
    const env = { ...goodProduction(), CORS_ORIGIN: '*' };
    expect(fatalVariables(env)).toContain('CORS_ORIGIN');
  });

  it('refuses production email that would only ever reach the console', () => {
    const env = goodProduction();
    delete env.RESEND_API_KEY;
    expect(fatalVariables(env)).toContain('RESEND_API_KEY');
  });

  it('allows console email in production when that is stated deliberately', () => {
    const env: NodeJS.ProcessEnv = { ...goodProduction(), ALLOW_CONSOLE_EMAIL: 'true' };
    delete env.RESEND_API_KEY;
    expect(fatalVariables(env)).not.toContain('RESEND_API_KEY');
  });

  it('refuses reset links that would point at a developer machine', () => {
    const env = goodProduction();
    delete env.APP_BASE_URL;
    expect(fatalVariables(env)).toContain('APP_BASE_URL');
  });

  it('rejects a malformed numeric setting in any environment', () => {
    // `Number('30s')` is NaN, which becomes a timer that never fires. Never
    // something to carry on with, production or not.
    expect(fatalVariables({ MATCH_LEASE_TTL_MS: '30s' })).toContain('MATCH_LEASE_TTL_MS');
    expect(fatalVariables({ WS_HEARTBEAT_MS: '-5' })).toContain('WS_HEARTBEAT_MS');
    expect(fatalVariables({ LLM_TIMEOUT_MS: '0' })).toContain('LLM_TIMEOUT_MS');
    expect(fatalVariables({ PORT: '99999' })).toContain('PORT');
  });

  it('accepts numeric settings that are actually numbers', () => {
    const env = { ...goodProduction(), MATCH_LEASE_TTL_MS: '30000', PORT: '3001', WS_HEARTBEAT_MS: '30000' };
    expect(validateEnv(env).ok).toBe(true);
  });

  it('rejects a Redis URL with the wrong scheme', () => {
    expect(fatalVariables({ REDIS_URL: 'http://localhost:6379' })).toContain('REDIS_URL');
    expect(fatalVariables({ REDIS_URL: 'redis://localhost:6379' })).not.toContain('REDIS_URL');
    expect(fatalVariables({ REDIS_URL: 'rediss://user:pass@host:6380' })).not.toContain('REDIS_URL');
  });

  it('warns about an unencrypted remote Redis in production without blocking the boot', () => {
    const env = { ...goodProduction(), REDIS_URL: 'redis://user:pass@remote.example.com:6379' };
    const report = validateEnv(env);
    // Advisory: plenty of deployments run Redis on a private network where
    // this is fine, and refusing would be wrong for them.
    expect(report.ok).toBe(true);
    expect(report.issues.some((issue) => issue.variable === 'REDIS_URL' && !issue.fatal)).toBe(true);
  });

  it('warns, but does not block, when the AI has no key — the engine still plays', () => {
    const env = goodProduction();
    delete env.GROQ_API_KEYS;
    const report = validateEnv(env);
    expect(report.ok).toBe(true);
    expect(report.issues.some((issue) => issue.variable === 'GROQ_API_KEYS')).toBe(true);
  });

  it('warns that the Gemini provider is still a stub', () => {
    const env = { ...goodProduction(), LLM_PROVIDER: 'gemini' };
    const report = validateEnv(env);
    expect(report.ok).toBe(true);
    expect(report.issues.some((issue) => issue.variable === 'LLM_PROVIDER')).toBe(true);
  });
});
