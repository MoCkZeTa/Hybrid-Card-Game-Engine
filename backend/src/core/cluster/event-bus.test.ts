import { describe, expect, it } from 'vitest';
import { LocalBusBackplane, LocalEventBus, RemoteError, RequestTimeoutError } from './event-bus.js';

/** Two buses on one backplane stand in for two backend nodes on one Redis. */
function twoNodes(): { a: LocalEventBus; b: LocalEventBus } {
  const backplane = new LocalBusBackplane();
  return { a: new LocalEventBus(backplane), b: new LocalEventBus(backplane) };
}

describe('EventBus fan-out', () => {
  it('delivers a publish from one node to subscribers on another', async () => {
    const { a, b } = twoNodes();
    const seen: unknown[] = [];
    await b.subscribe('match:1', (payload) => seen.push(payload));

    await a.publish('match:1', { kind: 'STATE', turn: 3 });
    await tick();

    expect(seen).toEqual([{ kind: 'STATE', turn: 3 }]);
  });

  it('delivers to every subscriber of a channel, and to none after unsubscribe', async () => {
    const { a, b } = twoNodes();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const stop = await b.subscribe('match:1', (p) => first.push(p));
    await b.subscribe('match:1', (p) => second.push(p));

    await a.publish('match:1', 1);
    await tick();
    stop();
    await a.publish('match:1', 2);
    await tick();

    expect(first).toEqual([1]);
    expect(second).toEqual([1, 2]);
  });

  it('does not leak payloads across channels', async () => {
    const { a, b } = twoNodes();
    const seen: unknown[] = [];
    await b.subscribe('match:1', (p) => seen.push(p));

    await a.publish('match:2', 'other');
    await tick();

    expect(seen).toEqual([]);
  });

  it('hands subscribers a copy, so one node cannot mutate another node\'s payload', async () => {
    const { a, b } = twoNodes();
    const original = { seats: [1, 2] };
    let received: { seats: number[] } | null = null;
    await b.subscribe('match:1', (p) => {
      received = p as { seats: number[] };
    });

    await a.publish('match:1', original);
    await tick();

    expect(received).toEqual(original);
    expect(received).not.toBe(original);
  });
});

describe('EventBus request/reply', () => {
  it('routes a request to the handler on another node and returns its reply', async () => {
    const { a, b } = twoNodes();
    await b.handleRequests('node:b:cmd', async (payload) => ({ echoed: payload }));

    const reply = await a.request('node:b:cmd', { move: 'H7' }, 1000);

    expect(reply).toEqual({ echoed: { move: 'H7' } });
  });

  it('keeps concurrent requests apart by correlation id', async () => {
    const { a, b } = twoNodes();
    await b.handleRequests('node:b:cmd', async (payload) => {
      const n = (payload as { n: number }).n;
      // Reply out of order on purpose — correlation, not arrival order, must decide.
      await delay(n === 1 ? 20 : 1);
      return n * 10;
    });

    const [first, second] = await Promise.all([
      a.request<number>('node:b:cmd', { n: 1 }, 1000),
      a.request<number>('node:b:cmd', { n: 2 }, 1000),
    ]);

    expect(first).toBe(10);
    expect(second).toBe(20);
  });

  it('propagates a remote failure as a RemoteError carrying the original class name', async () => {
    const { a, b } = twoNodes();
    await b.handleRequests('node:b:cmd', async () => {
      const err = new Error('Seat 2 is already claimed by another player');
      err.name = 'SeatTakenError';
      throw err;
    });

    await expect(a.request('node:b:cmd', {}, 1000)).rejects.toMatchObject({
      name: 'RemoteError',
      remoteName: 'SeatTakenError',
      message: 'Seat 2 is already claimed by another player',
    });
  });

  it('times out when nobody is listening on the target channel', async () => {
    const { a } = twoNodes();
    await expect(a.request('node:dead:cmd', {}, 50)).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('ignores a reply that arrives after its request already timed out', async () => {
    const { a, b } = twoNodes();
    await b.handleRequests('node:b:cmd', async () => {
      await delay(60);
      return 'late';
    });

    await expect(a.request('node:b:cmd', {}, 20)).rejects.toBeInstanceOf(RequestTimeoutError);
    // The late reply lands here — it must not throw or resolve anything.
    await delay(80);
  });

  it('rejects everything still in flight when the bus closes', async () => {
    const { a } = twoNodes();
    const pending = a.request('node:nobody:cmd', {}, 5000);
    // Let the reply inbox subscribe before closing.
    await tick();
    await a.close();
    await expect(pending).rejects.toThrow('Event bus closed');
  });
});

describe('RemoteError', () => {
  it('is a real Error, so existing catch blocks keep working', () => {
    expect(new RemoteError('boom', 'NotHostError')).toBeInstanceOf(Error);
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
