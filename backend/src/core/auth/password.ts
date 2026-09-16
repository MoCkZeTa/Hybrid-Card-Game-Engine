/**
 * Password hashing via Node's built-in scrypt — deliberately no `bcrypt`
 * dependency, which is a native module and a frequent source of build pain on
 * Windows. scrypt is memory-hard and is an appropriate choice here.
 *
 * Stored format: `scrypt$<N>$<saltHex>$<derivedHex>`. The cost parameter is
 * embedded so it can be raised later without invalidating existing hashes.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const COST = 16384; // N — ~100ms per hash on typical hardware
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: MAXMEM,
  });
  return `scrypt$${COST}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const salt = Buffer.from(parts[2]!, 'hex');
  const expected = Buffer.from(parts[3]!, 'hex');
  if (!Number.isFinite(cost) || salt.length === 0 || expected.length === 0) return false;

  const derived = await scryptAsync(password, salt, expected.length, {
    N: cost,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: MAXMEM,
  });
  // Constant-time comparison — a length check first, since timingSafeEqual throws on mismatched lengths.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * True when `stored` was produced with a weaker cost than we now use, so the
 * caller should re-hash the plaintext it is holding and store the result.
 *
 * Raising `COST` alone does nothing for accounts that already exist — their
 * hashes keep verifying at the old cost forever. The upgrade has to happen at
 * the one moment the plaintext is legitimately in memory: a successful login.
 * A hash we cannot parse also answers true; replacing it is strictly better
 * than leaving something unreadable in the database.
 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return true;
  const cost = Number(parts[1]);
  return !Number.isFinite(cost) || cost < COST;
}
