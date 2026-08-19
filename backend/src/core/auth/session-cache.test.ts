import { describe, expect, it } from 'vitest';
import { AuthService } from './auth-service.js';
import { InMemoryUserRepository, type SessionRecord, type UserRecord, type UserRepository } from './user-repository.js';
import { InMemorySessionCache } from './session-cache.js';

/** Wraps a repository so a test can see how often it was actually consulted. */
class CountingRepository implements UserRepository {
  sessionLookups = 0;
  constructor(private readonly inner: UserRepository) {}
  findByEmail(email: string) {
    return this.inner.findByEmail(email);
  }
  findById(id: string) {
    return this.inner.findById(id);
  }
  create(user: UserRecord) {
    return this.inner.create(user);
  }
  createSession(session: SessionRecord) {
    return this.inner.createSession(session);
  }
  findSession(token: string) {
    this.sessionLookups++;
    return this.inner.findSession(token);
  }
  deleteSession(token: string) {
    return this.inner.deleteSession(token);
  }
}

async function build() {
  const repository = new CountingRepository(new InMemoryUserRepository());
  const cache = new InMemorySessionCache();
  const auth = new AuthService(repository, cache);
  const { token } = await auth.register('player@example.com', 'correct horse battery', 'Player');
  repository.sessionLookups = 0; // ignore anything registration did
  return { auth, repository, cache, token };
}

describe('session caching', () => {
  it('hits the database once and serves repeat validations from cache', async () => {
    const { auth, repository, token } = await build();

    const first = await auth.validateToken(token);
    const second = await auth.validateToken(token);
    const third = await auth.validateToken(token);

    expect(first?.displayName).toBe('Player');
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(repository.sessionLookups).toBe(1);
  });

  it('caches a rejection too, so a token-guessing flood cannot become a query flood', async () => {
    const { auth, repository } = await build();

    expect(await auth.validateToken('not-a-real-token')).toBeNull();
    expect(await auth.validateToken('not-a-real-token')).toBeNull();

    expect(repository.sessionLookups).toBe(1);
  });

  it('stops accepting a token the moment it is logged out, rather than serving a stale cache hit', async () => {
    const { auth, token } = await build();
    expect(await auth.validateToken(token)).not.toBeNull();

    await auth.logout(token);

    // This is the whole risk of caching auth; it must not survive a logout.
    expect(await auth.validateToken(token)).toBeNull();
  });

  it('works identically with no cache configured', async () => {
    const repository = new InMemoryUserRepository();
    const auth = new AuthService(repository);
    const { token } = await auth.register('nocache@example.com', 'correct horse battery', 'NoCache');

    expect((await auth.validateToken(token))?.displayName).toBe('NoCache');
    await auth.logout(token);
    expect(await auth.validateToken(token)).toBeNull();
  });

  it('keeps each token separate', async () => {
    const { auth } = await build();
    const second = await auth.register('other@example.com', 'correct horse battery', 'Other');

    await auth.logout(second.token);

    expect(await auth.validateToken(second.token)).toBeNull();
  });
});
