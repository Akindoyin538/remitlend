import { cacheService } from '../services/cacheService.js';
import {
  cacheInvalidationCounter,
  cacheInvalidationFailureCounter,
  cacheStaleReadCounter,
} from '../middleware/metrics.js';
import { CacheKeys, invalidateOnScoreUpdate } from './cacheKeys.js';
import logger from './logger.js';

/**
 * Freshness contracts for cache-backed financial reads (#513).
 *
 * Money calculations NEVER read from these caches: they use the database /
 * chain directly. The caches only back display projections. On any Redis
 * failure reads fall through to the authoritative loader.
 *
 * Invalidation is exact-key DELETE (no SCAN/KEYS). DELETE is idempotent and
 * commutative, so duplicate and out-of-order events are safe. The one hazard
 * is a reader that loaded pre-event data re-filling the cache after the
 * delete; `readThrough` guards that with a per-resource generation counter.
 */
export type CacheResource =
  | 'pool_stats'
  | 'borrower_loans'
  | 'score_response'
  | 'score_breakdown'
  | 'pool_share_price';

export interface CacheContract {
  sourceOfTruth: string;
  /** Upper bound on staleness if invalidation is lost (the key TTL). */
  maxStalenessSeconds: number;
  invalidationTrigger: string;
}

export const CACHE_CONTRACTS: Readonly<Record<CacheResource, CacheContract>> = {
  pool_stats: {
    sourceOfTruth: 'Postgres (indexed Deposit/Withdraw/Loan* events)',
    maxStalenessSeconds: 300,
    invalidationTrigger:
      'Indexer commit of Deposit/Withdraw/EmergencyWithdraw/LoanApproved/LoanRepaid/LoanDefaulted; API deposit/withdraw/repay/request',
  },
  borrower_loans: {
    sourceOfTruth: 'Postgres loan_events/loans (indexed from chain)',
    maxStalenessSeconds: 300,
    invalidationTrigger:
      'Indexer commit of Loan* events for the borrower address; API repay/request',
  },
  score_response: {
    sourceOfTruth: 'Postgres scores (updated from LoanRepaid/LoanDefaulted)',
    maxStalenessSeconds: 300,
    invalidationTrigger: 'invalidateOnScoreUpdate after score write; indexer Loan* events',
  },
  score_breakdown: {
    sourceOfTruth: 'Postgres scores + loan history',
    maxStalenessSeconds: 300,
    invalidationTrigger: 'invalidateOnScoreUpdate after score write; indexer Loan* events',
  },
  pool_share_price: {
    sourceOfTruth: 'Soroban pool contract get_share_price (chain)',
    maxStalenessSeconds: 30,
    invalidationTrigger: 'TTL expiry only (30s bound); no event invalidation',
  },
};

const generations: Record<CacheResource, number> = {
  pool_stats: 0,
  borrower_loans: 0,
  score_response: 0,
  score_breakdown: 0,
  pool_share_price: 0,
};

/** Delete exact keys; meter attempts and unconfirmed deletes. Never throws. */
export async function invalidateKeys(resource: CacheResource, keys: string[]): Promise<boolean> {
  generations[resource] += 1;
  cacheInvalidationCounter.inc({ resource });
  try {
    const results = await Promise.all(keys.map((k) => cacheService.delete(k)));
    const ok = results.every((r) => r !== false);
    if (!ok) cacheInvalidationFailureCounter.inc({ resource });
    return ok;
  } catch (error) {
    cacheInvalidationFailureCounter.inc({ resource });
    logger.withContext().error('Cache invalidation failed', { resource, error });
    return false;
  }
}

const POOL_EVENTS = new Set([
  'Deposit',
  'Withdraw',
  'EmergencyWithdraw',
  'LoanApproved',
  'LoanRepaid',
  'LoanDefaulted',
  'CollateralLiquidated',
  'LoanLiquidated',
]);
const LOAN_EVENTS = new Set([
  'LoanApproved',
  'LoanRepaid',
  'LoanDefaulted',
  'CollateralLiquidated',
  'LoanLiquidated',
]);

/**
 * Invalidate projections affected by committed chain events. Safe to call
 * with duplicates / any ordering; touches only keys derived from the events.
 */
export async function invalidateForChainEvents(
  events: ReadonlyArray<{ eventType: string; address?: string | null }>,
): Promise<void> {
  try {
    let pool = false;
    const borrowers = new Set<string>();
    for (const e of events) {
      if (POOL_EVENTS.has(e.eventType)) pool = true;
      if (LOAN_EVENTS.has(e.eventType) && e.address) borrowers.add(e.address);
    }
    if (pool) await invalidateKeys('pool_stats', [CacheKeys.poolStats()]);
    for (const b of borrowers) {
      await invalidateKeys('borrower_loans', [CacheKeys.borrowerLoans(b)]);
      await invalidateOnScoreUpdate(b);
      generations.score_response += 1;
      generations.score_breakdown += 1;
    }
  } catch (error) {
    cacheInvalidationFailureCounter.inc({ resource: 'pool_stats' });
    logger.withContext().error('Event cache invalidation failed', { error });
  }
}

/**
 * Cache-aside read with Redis-failure fallback and refill-race protection.
 * If an invalidation for the resource ran while `load` was in flight, the
 * (possibly pre-event) result is returned but NOT cached.
 */
export async function readThrough<T>(
  resource: CacheResource,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const ttl = Math.min(ttlSeconds, CACHE_CONTRACTS[resource].maxStalenessSeconds);
  let cached: T | null = null;
  try {
    cached = await cacheService.get<T>(key);
  } catch {
    cacheStaleReadCounter.inc({ resource, outcome: 'backend_error' });
  }
  if (cached !== null) {
    cacheStaleReadCounter.inc({ resource, outcome: 'fresh' });
    return cached;
  }
  cacheStaleReadCounter.inc({ resource, outcome: 'miss' });
  const genBefore = generations[resource];
  const value = await load();
  if (generations[resource] !== genBefore) {
    cacheStaleReadCounter.inc({ resource, outcome: 'race_skipped' });
    return value;
  }
  await cacheService.set(key, value, ttl);
  return value;
}
