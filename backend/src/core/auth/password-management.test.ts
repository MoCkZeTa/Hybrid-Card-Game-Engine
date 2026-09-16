/**
 * Password change, password reset, and bulk session revocation.
 *
 * The theme running through these: a password operation is only meaningful if
 * it *ends the sessions that were opened with the old password*. Changing a
 * password while an intruder's session stays live achieves nothing, and that
 * failure is invisible — the form says "password updated" either way. So most
 * of what is asserted here is about which tokens stop working.
 */

import { describe, expect, it } from 'vitest';
import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { AuthError, AuthService } from './auth-service.js';
import { InMemoryUserRepository } from './user-repository.js';
import { InMemorySessionCache } from './session-cache.js';
import { needsRehash, verifyPassword } from './password.js';
import type { EmailMessage, EmailSender } from './email-sender.js';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

class CapturingEmailSender implements EmailSender {
  readonly name = 'capturing';
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  /** Pulls the reset token back out of the most recent link. */
  lastToken(): string {
    const link = /reset-password\?token=([a-f0-9]+)/.exec(this.sent.at(-1)?.text ?? '');
    if (!link) throw new Error('no reset link in the last email');
    return link[1]!;
  }
}

const EMAIL = 'player@example.com';
const PASSWORD = 'correct horse battery';

async function build(options: { cache?: boolean } = {}) {
  const repository = new InMemoryUserRepository();
  const mail = new CapturingEmailSender();
  const auth = new AuthService(repository, options.cache ? new InMemorySessionCache() : undefined, {
    emailSender: mail,
    appBaseUrl: 'https://play.example.com',
  });
  const { token } = await auth.register(EMAIL, PASSWORD, 'Player');
  return { auth, repository, mail, token };
}

describe('changing a password', () => {
  it('refuses without the current password', async () => {
    const { auth, token } = await build();
    await expect(auth.changePassword(token, 'not-the-password', 'a whole new password')).rejects.toBeInstanceOf(
      AuthError,
    );
    // And the old one still works, i.e. nothing was half-applied.
    await expect(auth.login(EMAIL, PASSWORD)).resolves.toBeTruthy();
  });

  it('refuses a new password identical to the current one', async () => {
    const { auth, token } = await build();
    await expect(auth.changePassword(token, PASSWORD, PASSWORD)).rejects.toThrow(/different/i);
  });

  it('refuses a new password that is too short', async () => {
    const { auth, token } = await build();
    await expect(auth.changePassword(token, PASSWORD, 'short')).rejects.toThrow(/at least 8/);
  });

  it('swaps which password works', async () => {
    const { auth, token } = await build();
    await auth.changePassword(token, PASSWORD, 'a whole new password');

    await expect(auth.login(EMAIL, 'a whole new password')).resolves.toBeTruthy();
    await expect(auth.login(EMAIL, PASSWORD)).rejects.toBeInstanceOf(AuthError);
  });

  it('revokes every other session but keeps the one that made the change', async () => {
    const { auth, token } = await build({ cache: true });
    // A second device — or an intruder.
    const other = await auth.login(EMAIL, PASSWORD);
    expect(await auth.validateToken(other.token)).not.toBeNull();

    await auth.changePassword(token, PASSWORD, 'a whole new password');

    // The intruder is out...
    expect(await auth.validateToken(other.token)).toBeNull();
    // ...and the tab the user did it in still works, so they are not bounced
    // to the sign-in screen for doing the right thing.
    expect(await auth.validateToken(token)).not.toBeNull();
  });

  it('kills a pending reset link, which is a credential for the old account state', async () => {
    const { auth, mail, token } = await build();
    await auth.requestPasswordReset(EMAIL);
    const resetToken = mail.lastToken();

    await auth.changePassword(token, PASSWORD, 'a whole new password');

    await expect(auth.resetPassword(resetToken, 'attacker chosen password')).rejects.toThrow(/invalid or has expired/i);
  });
});

describe('resetting a forgotten password', () => {
  it('emails a link that sets a new password and signs the user in', async () => {
    const { auth, mail } = await build();
    await auth.requestPasswordReset(EMAIL);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(EMAIL);
    expect(mail.sent[0]!.text).toContain('https://play.example.com/reset-password?token=');

    const result = await auth.resetPassword(mail.lastToken(), 'a whole new password');
    expect(result.user.email).toBe(EMAIL);
    await expect(auth.login(EMAIL, 'a whole new password')).resolves.toBeTruthy();
  });

  it('lets the token be used only once', async () => {
    const { auth, mail } = await build();
    await auth.requestPasswordReset(EMAIL);
    const resetToken = mail.lastToken();

    await auth.resetPassword(resetToken, 'a whole new password');
    await expect(auth.resetPassword(resetToken, 'another new password')).rejects.toThrow(/invalid or has expired/i);
  });

  it('invalidates the earlier link when a second is requested', async () => {
    const { auth, mail } = await build();
    await auth.requestPasswordReset(EMAIL);
    const first = mail.lastToken();
    await auth.requestPasswordReset(EMAIL);
    const second = mail.lastToken();

    expect(first).not.toBe(second);
    // Otherwise an older intercepted email stays valuable indefinitely.
    await expect(auth.resetPassword(first, 'a whole new password')).rejects.toThrow(/invalid or has expired/i);
    await expect(auth.resetPassword(second, 'a whole new password')).resolves.toBeTruthy();
  });

  it('rejects a token that was never issued', async () => {
    const { auth } = await build();
    await expect(auth.resetPassword('deadbeef'.repeat(8), 'a whole new password')).rejects.toThrow(
      /invalid or has expired/i,
    );
  });

  it('revokes every session, including the one asking — a reset means the account was lost', async () => {
    const { auth, mail, token } = await build({ cache: true });
    const second = await auth.login(EMAIL, PASSWORD);

    await auth.requestPasswordReset(EMAIL);
    const fresh = await auth.resetPassword(mail.lastToken(), 'a whole new password');

    expect(await auth.validateToken(token)).toBeNull();
    expect(await auth.validateToken(second.token)).toBeNull();
    // Only the session minted by the reset itself survives.
    expect(await auth.validateToken(fresh.token)).not.toBeNull();
  });

  it('says nothing and sends nothing for an address with no account', async () => {
    const { auth, mail } = await build();
    // Resolving quietly is the point: an error, a delay, or a different status
    // would turn this endpoint into a "which emails are registered" oracle.
    await expect(auth.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
    expect(mail.sent).toHaveLength(0);
  });

  it('still succeeds for the caller when the mail provider is down', async () => {
    const repository = new InMemoryUserRepository();
    const broken: EmailSender = {
      name: 'broken',
      send: () => Promise.reject(new Error('provider unreachable')),
    };
    const auth = new AuthService(repository, undefined, { emailSender: broken });
    await auth.register(EMAIL, PASSWORD, 'Player');

    // A thrown error here would be a 500 that only fires for real addresses —
    // the enumeration leak again, wearing a different hat.
    await expect(auth.requestPasswordReset(EMAIL)).resolves.toBeUndefined();
  });
});

describe('signing out everywhere', () => {
  it('revokes every session including the caller by default', async () => {
    const { auth, token } = await build({ cache: true });
    const second = await auth.login(EMAIL, PASSWORD);

    await auth.logoutEverywhere(token);

    expect(await auth.validateToken(token)).toBeNull();
    expect(await auth.validateToken(second.token)).toBeNull();
  });

  it('can spare the caller when asked', async () => {
    const { auth, token } = await build({ cache: true });
    const second = await auth.login(EMAIL, PASSWORD);

    await auth.logoutEverywhere(token, true);

    expect(await auth.validateToken(token)).not.toBeNull();
    expect(await auth.validateToken(second.token)).toBeNull();
  });

  it('counts live sessions', async () => {
    const { auth, token } = await build();
    await auth.login(EMAIL, PASSWORD);
    await auth.login(EMAIL, PASSWORD);
    expect(await auth.listSessionCount(token)).toBe(3);
  });

  it('refuses an unknown token', async () => {
    const { auth } = await build();
    await expect(auth.logoutEverywhere('not-a-token')).rejects.toBeInstanceOf(AuthError);
  });
});

describe('sliding session expiry', () => {
  it('pushes a session past its halfway point back out to the full window', async () => {
    // No cache, so every validate reaches the database and can renew.
    const repository = new InMemoryUserRepository();
    const auth = new AuthService(repository);
    const { token } = await auth.register(EMAIL, PASSWORD, 'Player');

    // Simulate a session most of the way through its 7 days.
    const nearlyExpired = new Date(Date.now() + 60_000);
    await repository.renewSession(token, nearlyExpired);

    expect(await auth.validateToken(token)).not.toBeNull();

    const after = await repository.findSession(token);
    // A fixed window would have left this at one minute and signed a daily
    // player out mid-hand on day seven.
    expect(after!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });

  it('leaves a freshly issued session alone', async () => {
    const repository = new InMemoryUserRepository();
    const auth = new AuthService(repository);
    const { token } = await auth.register(EMAIL, PASSWORD, 'Player');

    const before = (await repository.findSession(token))!.expiresAt.getTime();
    await auth.validateToken(token);
    const after = (await repository.findSession(token))!.expiresAt.getTime();

    // Renewing on every request would be a database write per WebSocket
    // handshake for no benefit.
    expect(after).toBe(before);
  });
});

describe('upgrading a password hash', () => {
  it('recognises a hash written under a weaker cost', async () => {
    expect(needsRehash('scrypt$1024$aabb$ccdd')).toBe(true);
    expect(needsRehash('scrypt$16384$aabb$ccdd')).toBe(false);
    // Unparseable is also "replace it" — better than leaving it in place.
    expect(needsRehash('bcrypt$whatever')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });

  it('rewrites the stored hash on the next successful login', async () => {
    const repository = new InMemoryUserRepository();
    const auth = new AuthService(repository);

    // An account created back when COST was lower.
    const salt = randomBytes(16);
    const weak = await scrypt(PASSWORD, salt, 64, { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    await repository.create({
      id: 'legacy-user',
      email: EMAIL,
      displayName: 'Legacy',
      passwordHash: `scrypt$1024$${salt.toString('hex')}$${weak.toString('hex')}`,
      createdAt: new Date(),
    });

    await expect(auth.login(EMAIL, PASSWORD)).resolves.toBeTruthy();

    const upgraded = (await repository.findById('legacy-user'))!.passwordHash;
    expect(needsRehash(upgraded)).toBe(false);
    // Still the same password — the upgrade must be invisible to the user.
    expect(await verifyPassword(PASSWORD, upgraded)).toBe(true);
  });
});
