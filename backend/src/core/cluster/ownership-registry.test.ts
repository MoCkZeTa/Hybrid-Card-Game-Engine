import { describe, expect, it } from 'vitest';
import { LocalOwnershipRegistry } from './ownership-registry.js';

const NODE_A = 'node-a';
const NODE_B = 'node-b';

describe('OwnershipRegistry leases', () => {
  it('gives the lease to the first claimant and reports it to the second', async () => {
    const registry = new LocalOwnershipRegistry();

    expect(await registry.claim('m1', NODE_A, 1000)).toBe(NODE_A);
    // The loser gets the incumbent's id back — that's how it learns where to route.
    expect(await registry.claim('m1', NODE_B, 1000)).toBe(NODE_A);
    expect(await registry.owner('m1')).toBe(NODE_A);
  });

  it('lets the holder renew, and refuses a renewal from anyone else', async () => {
    const registry = new LocalOwnershipRegistry();
    await registry.claim('m1', NODE_A, 1000);

    expect(await registry.renew('m1', NODE_A, 1000)).toBe(true);
    expect(await registry.renew('m1', NODE_B, 1000)).toBe(false);
    expect(await registry.owner('m1')).toBe(NODE_A);
  });

  it('frees the match once the lease expires, so a dead node cannot hold it forever', async () => {
    const registry = new LocalOwnershipRegistry();
    await registry.claim('m1', NODE_A, 20);

    await delay(40);

    expect(await registry.owner('m1')).toBeNull();
    expect(await registry.claim('m1', NODE_B, 1000)).toBe(NODE_B);
  });

  it('will not let a late renewal reclaim a lease that has moved on', async () => {
    const registry = new LocalOwnershipRegistry();
    await registry.claim('m1', NODE_A, 20);
    await delay(40);
    await registry.claim('m1', NODE_B, 1000);

    // This is node A waking up after a long GC pause and trying to carry on.
    expect(await registry.renew('m1', NODE_A, 1000)).toBe(false);
    expect(await registry.owner('m1')).toBe(NODE_B);
  });

  it('only releases a lease the caller still holds', async () => {
    const registry = new LocalOwnershipRegistry();
    await registry.claim('m1', NODE_A, 1000);

    await registry.release('m1', NODE_B); // not yours to release
    expect(await registry.owner('m1')).toBe(NODE_A);

    await registry.release('m1', NODE_A);
    expect(await registry.owner('m1')).toBeNull();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
