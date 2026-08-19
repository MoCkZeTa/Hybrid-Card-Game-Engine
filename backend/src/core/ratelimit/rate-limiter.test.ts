import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter, type RateLimitRule } from './rate-limiter.js';

const BURSTY: RateLimitRule = { capacity: 5, refillPerSecond: 10 };

describe('token-bucket rate limiting', () => {
  it('allows a full burst up to the bucket size, then refuses', async () => {
    const limiter = new InMemoryRateLimiter();

    for (let i = 0; i < 5; i++) {
      expect((await limiter.consume('conn-1', BURSTY)).allowed).toBe(true);
    }
    const blocked = await limiter.consume('conn-1', BURSTY);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    limiter.stop();
  });

  it('refills over time so a paused client gets its budget back', async () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 5; i++) await limiter.consume('conn-1', BURSTY);
    expect((await limiter.consume('conn-1', BURSTY)).allowed).toBe(false);

    // 10 tokens/second, so 150ms buys at least one back.
    await delay(150);

    expect((await limiter.consume('conn-1', BURSTY)).allowed).toBe(true);
    limiter.stop();
  });

  it('keeps buckets separate per key, so one flooding client cannot block another', async () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 5; i++) await limiter.consume('conn-flood', BURSTY);

    expect((await limiter.consume('conn-flood', BURSTY)).allowed).toBe(false);
    expect((await limiter.consume('conn-quiet', BURSTY)).allowed).toBe(true);
    limiter.stop();
  });

  it('never refills past the bucket size, so idling does not bank an unlimited burst', async () => {
    const limiter = new InMemoryRateLimiter();
    await limiter.consume('conn-1', BURSTY);
    await delay(200); // enough to refill far past capacity

    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      if ((await limiter.consume('conn-1', BURSTY)).allowed) allowed++;
    }

    expect(allowed).toBeLessThanOrEqual(BURSTY.capacity + 1); // +1 for refill during the loop
    limiter.stop();
  });

  it('reports a retry delay proportional to how far over budget the caller is', async () => {
    const limiter = new InMemoryRateLimiter();
    const slow: RateLimitRule = { capacity: 1, refillPerSecond: 1 };
    await limiter.consume('conn-1', slow);

    const blocked = await limiter.consume('conn-1', slow);

    // One token at one per second — call it a second, allowing for elapsed time.
    expect(blocked.retryAfterMs).toBeGreaterThan(800);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(1000);
    limiter.stop();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
