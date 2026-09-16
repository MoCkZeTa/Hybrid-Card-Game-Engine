/**
 * Registration, login, session lifecycle, and password management.
 *
 * Deliberately says as little as possible in its failure messages — "Invalid
 * email or password" for both an unknown account and a wrong password, and a
 * cheerful "if that address has an account, a link is on its way" for reset
 * requests — so no endpoint can be used to enumerate which emails are
 * registered.
 *
 * Three behaviours here exist specifically because sessions are *opaque tokens
 * in a database* rather than JWTs. That choice was made for revocability, and
 * these are the things that actually cash it in:
 *
 *  - **Bulk revocation.** Changing or resetting a password kills every other
 *    session immediately, and `logoutEverywhere` does it on demand. A JWT
 *    deployment cannot do this without a blocklist.
 *  - **Sliding expiry.** An active session renews itself, so a player who
 *    shows up daily is never signed out mid-hand by a fixed 7-day wall.
 *  - **Rehash on login.** The stored scrypt cost travels inside the hash, so
 *    raising `COST` upgrades each account the next time its owner signs in —
 *    the one moment the plaintext is legitimately in memory.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuthUser } from '@hcg/shared';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import { normalizeEmail, type UserRecord, type UserRepository } from './user-repository.js';
import type { SessionCache } from './session-cache.js';
import { ConsoleEmailSender, type EmailSender } from './email-sender.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Renew once a session is past its halfway point. Bounds writes to ~1 per 3.5 days idle. */
const SESSION_RENEW_AFTER_MS = SESSION_TTL_MS / 2;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
/**
 * Reset links are short-lived on purpose: the token sits in an inbox, which is
 * exactly where an attacker with stale mailbox access goes looking.
 */
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

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

export interface AuthServiceOptions {
  /** Delivers reset links. Defaults to the console sender, which prints them. */
  readonly emailSender?: EmailSender;
  /** Origin the reset link points at, e.g. `https://play.example.com`. */
  readonly appBaseUrl?: string;
}

export class AuthService {
  private readonly emailSender: EmailSender;
  private readonly appBaseUrl: string;

  constructor(
    private readonly repository: UserRepository,
    /** Optional read-through cache for `validateToken`. Omitted = always hit the database. */
    private readonly cache?: SessionCache,
    options: AuthServiceOptions = {},
  ) {
    this.emailSender = options.emailSender ?? new ConsoleEmailSender();
    this.appBaseUrl = (options.appBaseUrl ?? 'http://localhost:5173').replace(/\/+$/, '');
  }

  // ---- Account creation and sign-in ----------------------------------------

  async register(email: string, password: string, displayName: string): Promise<AuthResult> {
    const normalized = normalizeEmail(email);
    if (!isPlausibleEmail(normalized)) throw new AuthError('Enter a valid email address', 400);
    assertPasswordAcceptable(password);
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

    // The password is correct and in memory — the only moment we can upgrade a
    // hash written under a weaker cost. Best-effort: a failed upgrade must not
    // turn a valid login into an error.
    if (needsRehash(user.passwordHash)) {
      try {
        await this.repository.updatePassword(user.id, await hashPassword(password));
      } catch (err) {
        console.error('[auth] password rehash failed (login still succeeded):', err);
      }
    }

    return this.issueSession(user);
  }

  // ---- Session lifecycle ----------------------------------------------------

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

    // Sliding expiry. Only reachable on a cache miss, so an active session
    // costs at most one write per cache TTL rather than one per request.
    if (session.expiresAt.getTime() - Date.now() < SESSION_RENEW_AFTER_MS) {
      const extended = new Date(Date.now() + SESSION_TTL_MS);
      await this.repository.renewSession(token, extended).catch((err: unknown) => {
        // A failed renewal is not a failed authentication — the session is
        // still valid right now, it just expires on its original schedule.
        console.error('[auth] session renewal failed:', err);
      });
    }

    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  async logout(token: string): Promise<void> {
    // Invalidate first: if the delete succeeds but the invalidation fails, a
    // cached copy would keep the token working for the rest of its TTL.
    await this.cache?.invalidate(token);
    await this.repository.deleteSession(token);
    // And again afterwards, in case a concurrent validate re-populated the
    // cache from the row we were in the middle of deleting.
    await this.cache?.invalidate(token);
  }

  /**
   * Revokes every session for the user behind `token`, including that one
   * unless `keepCurrent` is set. This is the "someone else is on my account"
   * button, and the thing a JWT deployment cannot offer.
   */
  async logoutEverywhere(token: string, keepCurrent = false): Promise<void> {
    const user = await this.validateToken(token);
    if (!user) throw new AuthError('Not authenticated', 401);
    await this.revokeSessions(user.id, keepCurrent ? token : undefined);
  }

  /** How many live sessions the account has — powers a "signed in on 3 devices" line. */
  async listSessionCount(token: string): Promise<number> {
    const user = await this.validateToken(token);
    if (!user) throw new AuthError('Not authenticated', 401);
    return (await this.repository.findSessionsByUser(user.id)).length;
  }

  /**
   * Deletes sessions and evicts each one from the cache. Listing the tokens
   * first is the only option available: the cache is keyed by token and cannot
   * answer "which entries belong to this user".
   */
  private async revokeSessions(userId: string, exceptToken?: string): Promise<void> {
    const sessions = await this.repository.findSessionsByUser(userId);
    await this.repository.deleteSessionsForUser(userId, exceptToken);
    await Promise.allSettled(
      sessions
        .filter((session) => session.token !== exceptToken)
        .map((session) => this.cache?.invalidate(session.token) ?? Promise.resolve()),
    );
  }

  // ---- Password management --------------------------------------------------

  /**
   * Changes the password of the session's own account. Every *other* session is
   * revoked: if the reason for the change is "someone else got in", leaving
   * their session alive would defeat the entire exercise. The caller's own
   * session survives, so the tab they did it in keeps working.
   */
  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    const authed = await this.validateToken(token);
    if (!authed) throw new AuthError('Not authenticated', 401);

    const user = await this.repository.findById(authed.id);
    if (!user) throw new AuthError('Not authenticated', 401);

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AuthError('Current password is incorrect', 401);
    }
    assertPasswordAcceptable(newPassword);
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new AuthError('New password must be different from the current one', 400);
    }

    await this.repository.updatePassword(user.id, await hashPassword(newPassword));
    // A pending reset link is a live credential for the old state of the
    // account; a deliberate password change should kill it.
    await this.repository.deletePasswordResetsForUser(user.id);
    await this.revokeSessions(user.id, token);
  }

  /**
   * Starts a reset. Resolves the same way whether or not the address exists —
   * the response must not tell an anonymous caller which emails are registered.
   * A send failure is logged rather than thrown, for that same reason.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.repository.findByEmail(normalizeEmail(email));
    if (!user) return;

    // One live link at a time: issuing a second should not leave the first
    // usable, or an older stolen email stays valuable indefinitely.
    await this.repository.deletePasswordResetsForUser(user.id);

    const token = randomBytes(32).toString('hex');
    await this.repository.createPasswordReset({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    });

    const link = `${this.appBaseUrl}/reset-password?token=${token}`;
    try {
      await this.emailSender.send({
        to: user.email,
        subject: 'Reset your password',
        text: [
          `Hi ${user.displayName},`,
          '',
          'Someone asked to reset the password on your account. Open this link to choose a new one:',
          '',
          link,
          '',
          'The link is good for one hour and can only be used once.',
          'If this was not you, you can ignore this email — your password has not changed.',
        ].join('\n'),
      });
    } catch (err) {
      // The token is already stored; failing loudly here would tell the caller
      // the address exists. Operators see it in the logs.
      console.error(`[auth] failed to send reset email to ${user.email}:`, err);
    }
  }

  /**
   * Completes a reset and signs the user in. Every existing session dies: a
   * reset is what you do when you have lost control of the account, so any
   * session already out there is exactly what you are trying to get rid of.
   */
  async resetPassword(resetToken: string, newPassword: string): Promise<AuthResult> {
    const reset = await this.repository.findPasswordReset(hashToken(resetToken));
    if (!reset) throw new AuthError('This reset link is invalid or has expired', 400);
    assertPasswordAcceptable(newPassword);

    const user = await this.repository.findById(reset.userId);
    if (!user) throw new AuthError('This reset link is invalid or has expired', 400);

    await this.repository.updatePassword(user.id, await hashPassword(newPassword));
    // Single use — consumed whether or not anything after this point fails.
    await this.repository.deletePasswordResetsForUser(user.id);
    await this.revokeSessions(user.id);

    return this.issueSession(user);
  }

  // ---- Internals ------------------------------------------------------------

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

function assertPasswordAcceptable(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
  // scrypt hashes any length, but an unbounded body is free CPU for an
  // attacker: each attempt costs us ~100ms regardless of how long the input is.
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`, 400);
  }
}

/**
 * Reset tokens are stored as SHA-256, so a database dump contains no usable
 * links. Plain SHA-256 rather than scrypt is right here and wrong for
 * passwords: this input is 32 random bytes, so there is no dictionary to run
 * against it and nothing a slow hash would buy.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
