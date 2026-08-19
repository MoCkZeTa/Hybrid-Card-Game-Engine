import { describe, expect, it } from 'vitest';
import { isOriginAllowed, parseAllowedOrigins } from './origin.js';

const PROD = { allowed: ['https://cards.example.com'], isProduction: true };
const DEV = { allowed: ['http://localhost:5173'], isProduction: false };

describe('parseAllowedOrigins', () => {
  it('splits a comma-separated list and trims trailing slashes', () => {
    expect(parseAllowedOrigins('https://a.com/, https://b.com')).toEqual(['https://a.com', 'https://b.com']);
  });

  it('returns nothing for an unset or empty value', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('  ')).toEqual([]);
  });
});

describe('WebSocket origin policy', () => {
  it('accepts an allowlisted origin', () => {
    expect(isOriginAllowed('https://cards.example.com', PROD)).toBe(true);
  });

  it('rejects any other site — this is the cross-site hijacking defence', () => {
    expect(isOriginAllowed('https://evil.example', PROD)).toBe(false);
    // A prefix match would be a bug: this domain is not ours.
    expect(isOriginAllowed('https://cards.example.com.evil.example', PROD)).toBe(false);
  });

  it('ignores a trailing slash rather than treating it as a different origin', () => {
    expect(isOriginAllowed('https://cards.example.com/', PROD)).toBe(true);
  });

  it('allows connections with no Origin header — those are non-browser clients', () => {
    // A CLI bot or load test has no victim's session to ride on, which is the
    // only thing this check defends against.
    expect(isOriginAllowed(undefined, PROD)).toBe(true);
    expect(isOriginAllowed('', PROD)).toBe(true);
  });

  it('accepts any localhost port outside production, since Vite hops ports', () => {
    expect(isOriginAllowed('http://localhost:5199', DEV)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:4173', DEV)).toBe(true);
  });

  it('does not extend the localhost exemption to production', () => {
    expect(isOriginAllowed('http://localhost:5173', PROD)).toBe(false);
  });

  it('honours an explicit wildcard for deployments that really want one open', () => {
    expect(isOriginAllowed('https://anything.example', { allowed: ['*'], isProduction: true })).toBe(true);
  });
});
