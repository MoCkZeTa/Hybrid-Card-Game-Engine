import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';
import { AuthError, AuthService } from './auth-service.js';
import { InMemoryUserRepository } from './user-repository.js';

function service(): AuthService {
  return new AuthService(new InMemoryUserRepository());
}

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('never stores the plaintext password', async () => {
    const hash = await hashPassword('hunter2hunter2');
    expect(hash).not.toContain('hunter2');
  });

  it('produces a different hash each time (unique salt)', async () => {
    const a = await hashPassword('samepassword123');
    const b = await hashPassword('samepassword123');
    expect(a).not.toBe(b);
    expect(await verifyPassword('samepassword123', a)).toBe(true);
    expect(await verifyPassword('samepassword123', b)).toBe(true);
  });

  it('rejects a malformed stored hash rather than throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-real-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});

describe('AuthService', () => {
  it('registers a user and issues a working session token', async () => {
    const auth = service();
    const result = await auth.register('Player@Example.com', 'password123', 'Ankit');

    expect(result.user.email).toBe('player@example.com'); // normalized
    expect(result.user.displayName).toBe('Ankit');
    expect(result.token).toHaveLength(64);

    const validated = await auth.validateToken(result.token);
    expect(validated?.id).toBe(result.user.id);
  });

  it('rejects duplicate registration regardless of email casing', async () => {
    const auth = service();
    await auth.register('a@b.com', 'password123', 'First');
    await expect(auth.register('A@B.COM', 'password123', 'Second')).rejects.toThrow(AuthError);
  });

  it('rejects a short password and a malformed email', async () => {
    const auth = service();
    await expect(auth.register('a@b.com', 'short', 'X')).rejects.toThrow(/at least 8/);
    await expect(auth.register('not-an-email', 'password123', 'X')).rejects.toThrow(/valid email/);
  });

  it('logs in with correct credentials and refuses wrong ones', async () => {
    const auth = service();
    await auth.register('user@example.com', 'password123', 'User');

    const ok = await auth.login('user@example.com', 'password123');
    expect(ok.user.email).toBe('user@example.com');

    await expect(auth.login('user@example.com', 'wrongpassword')).rejects.toThrow(/Invalid email or password/);
  });

  it('gives the same error for an unknown account as for a wrong password (no user enumeration)', async () => {
    const auth = service();
    await auth.register('known@example.com', 'password123', 'Known');

    const capture = async (email: string): Promise<AuthError> => {
      try {
        await auth.login(email, 'nottherightone');
        throw new Error('expected login to fail');
      } catch (err) {
        return err as AuthError;
      }
    };

    const wrongPassword = await capture('known@example.com');
    const unknownUser = await capture('nobody@example.com');

    expect(wrongPassword.message).toBe(unknownUser.message);
    expect(wrongPassword.status).toBe(unknownUser.status);
  });

  it('rejects an invalid token and a logged-out token', async () => {
    const auth = service();
    const { token } = await auth.register('x@y.com', 'password123', 'X');

    expect(await auth.validateToken('bogus-token')).toBeNull();
    expect(await auth.validateToken(token)).not.toBeNull();

    await auth.logout(token);
    expect(await auth.validateToken(token)).toBeNull();
  });

  it('defaults displayName to the email local-part when omitted', async () => {
    const auth = service();
    const result = await auth.register('someone@example.com', 'password123', '   ');
    expect(result.user.displayName).toBe('someone');
  });
});
