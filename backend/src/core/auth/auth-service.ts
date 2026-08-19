/**
 * Registration, login, and token validation. Deliberately says as little as
 * possible in its failure messages — "Invalid email or password" for both an
 * unknown account and a wrong password, so the endpoint can't be used to
 * enumerate which emails are registered.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { AuthUser } from '@hcg/shared';
import { hashPassword, verifyPassword } from './password.js';
import { normalizeEmail, type UserRecord, type UserRepository } from './user-repository.js';
import type { SessionCache } from './session-cache.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_PASSWORD_LENGTH = 8;

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthResult {
  readonly token: string;
  readonly user: AuthUser;
  readonly expiresAt: number;
}

export class AuthService {
  constructor(
    private readonly repository: UserRepository,
    /** Optional read-through cache for `validateToken`. Omitted = always hit the database. */
    private readonly cache?: SessionCache,
  ) {}

  async register(email: string, password: string, displayName: string): Promise<AuthResult> {
    const normalized = normalizeEmail(email);
    if (!isPlausibleEmail(normalized)) throw new AuthError('Enter a valid email address', 400);
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
    }
    const name = displayName.trim() || normalized.split('@')[0]!;

    if (await this.repository.findByEmail(normalized)) {
      throw new AuthError('An account with that email already exists', 409);
    }

    const user: UserRecord = {
      id: randomUUID(),
      email: normalized,
      displayName: name,
      passwordHash: await hashPassword(password),
      createdAt: new Date(),
    };

    try {
      await this.repository.create(user);
    } catch (err) {
      // Unique-index violation — someone registered the same email between
      // our check and this insert.
      if ((err as { code?: number }).code === 11000) {
        throw new AuthError('An account with that email already exists', 409);
      }
      throw err;
    }

    return this.issueSession(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.repository.findByEmail(email);
    if (!user) {
      // Burn roughly the same CPU as a real verify so response timing doesn't
      // reveal whether the account exists.
      await hashPassword(password);
      throw new AuthError('Invalid email or password', 401);
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new AuthError('Invalid email or password', 401);
    }

    return this.issueSession(user);
  }

  async validateToken(token: string): Promise<AuthUser | null> {
    const cached = await this.cache?.get(token);
    if (cached !== undefined) return cached;

    const resolved = await this.lookupToken(token);
    await this.cache?.set(token, resolved);
    return resolved;
  }

  private async lookupToken(token: string): Promise<AuthUser | null> {
    const session = await this.repository.findSession(token);
    if (!session) return null;
    const user = await this.repository.findById(session.userId);
    if (!user) return null;
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  async logout(token: string): Promise<void> {
    // Invalidate first: if the delete succeeds but the invalidation fails, a
    // cached copy would keep the token working for the rest of its TTL.
    await this.cache?.invalidate(token);
    await this.repository.deleteSession(token);
    await this.cache?.invalidate(token);
  }

  private async issueSession(user: UserRecord): Promise<AuthResult> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.repository.createSession({ token, userId: user.id, expiresAt });
    return {
      token,
      user: { id: user.id, email: user.email, displayName: user.displayName },
      expiresAt: expiresAt.getTime(),
    };
  }
}

function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
