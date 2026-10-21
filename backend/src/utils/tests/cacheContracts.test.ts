import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const store = new Map<string, unknown>();
let down = false;
const del = jest.fn(async (k: string) => {
  if (down) return false;
  store.delete(k);
  return true;
});
jest.unstable_mockModule('../../services/cacheService.js', () => ({
  cacheService: {
    get: jest.fn(async (k: string) => (down ? null : (store.get(k) ?? null))),
    set: jest.fn(async (k: string, v: unknown) => {
      if (!down) store.set(k, v);
    }),
    delete: del,
  },
}));

const { invalidateForChainEvents, invalidateKeys, readThrough, CACHE_CONTRACTS } = await import(
  '../cacheContracts.js'
);

describe('cache contracts', () => {
  beforeEach(() => {
    store.clear();
    down = false;
    del.mockClear();
  });

  it('documents source, staleness and trigger for every resource', () => {
    for (const c of Object.values(CACHE_CONTRACTS)) {
      expect(c.sourceOfTruth).toBeTruthy();
      expect(c.maxStalenessSeconds).toBeGreaterThan(0);
      expect(c.invalidationTrigger).toBeTruthy();
    }
  });

  it('invalidates exact keys on events and tolerates duplicates/out-of-order', async () => {
    store.set('pool:stats', 1);
    store.set('borrower:loans:GB', 1);
    const evs = [
      { eventType: 'LoanRepaid', address: 'GB' },
      { eventType: 'LoanApproved', address: 'GB' },
      { eventType: 'LoanRepaid', address: 'GB' },
    ];
    await invalidateForChainEvents(evs);
    await invalidateForChainEvents([...evs].reverse());
    expect(store.has('pool:stats')).toBe(false);
    expect(store.has('borrower:loans:GB')).toBe(false);
  });

  it('serves from cache until TTL-less miss, then loads', async () => {
    const load = jest.fn(async () => 'v');
    await readThrough('pool_stats', 'pool:stats', 60, load);
    await readThrough('pool_stats', 'pool:stats', 60, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('falls back to the loader when Redis is down and reports failed invalidation', async () => {
    down = true;
    const load = jest.fn(async () => 42);
    await expect(readThrough('pool_stats', 'pool:stats', 60, load)).resolves.toBe(42);
    await expect(invalidateKeys('pool_stats', ['pool:stats'])).resolves.toBe(false);
  });

  it('does not cache a result loaded across a concurrent invalidation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = readThrough('pool_stats', 'pool:stats', 60, async () => {
      await gate;
      return 'stale';
    });
    await invalidateKeys('pool_stats', ['pool:stats']);
    release();
    await expect(p).resolves.toBe('stale');
    expect(store.has('pool:stats')).toBe(false);
  });
});
