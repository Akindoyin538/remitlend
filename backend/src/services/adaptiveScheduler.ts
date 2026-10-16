import { query } from '../db/connection.js';
import logger from '../utils/logger.js';

/**
 * Adaptive scheduler for EventIndexer polling
 *
 * Automatically adjusts poll intervals and batch sizes based on indexer lag:
 * - Caught-Up (lag ≤ 50): 30s intervals, batch 100
 * - Behind (50 < lag ≤ 100): 10s intervals, batch 200
 * - Catch-Up (lag > 100): 3s intervals, batch 500
 *
 * Additionally applies exponential backoff on RPC failures to gracefully
 * degrade during network degradation.
 */

export type SchedulerMode = 'caught_up' | 'behind' | 'catch_up';

export interface SchedulerConfig {
  /**
   * Switch to 'behind' mode when lag exceeds this threshold (ledgers).
   * Default: 50
   */
  caughtUpThreshold?: number;

  /**
   * Switch to 'catch_up' mode when lag exceeds this threshold (ledgers).
   * Default: 100
   */
  aggressiveThreshold?: number;

  // Interval configuration (milliseconds)
  intervalCaughtUpMs?: number; // Default: 30000
  intervalBehindMs?: number; // Default: 10000
  intervalCatchUpMs?: number; // Default: 3000

  // Batch size configuration (ledgers)
  batchSizeCaughtUp?: number; // Default: 100
  batchSizeBehind?: number; // Default: 200
  batchSizeCatchUp?: number; // Default: 500

  // Backoff configuration
  backoffBaseMs?: number; // Default: 5000
  backoffMaxMs?: number; // Default: 135000
  backoffMultiplier?: number; // Default: 3
}

interface SchedulerState {
  mode: SchedulerMode;
  consecutiveFailures: number;
  lastPollTime: Date | null;
  lastSuccessfulPollTime: Date | null;
  lastLagLedgers: number | null;
  lastErrorMessage: string | null;
}

/** Public alias for {@link SchedulerState} — exposed for diagnostics consumers. */
export type AdaptiveSchedulerState = SchedulerState;

export class AdaptiveScheduler {
  private readonly caughtUpThreshold: number;
  private readonly aggressiveThreshold: number;

  private readonly intervalCaughtUpMs: number;
  private readonly intervalBehindMs: number;
  private readonly intervalCatchUpMs: number;

  private readonly batchSizeCaughtUp: number;
  private readonly batchSizeBehind: number;
  private readonly batchSizeCatchUp: number;

  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly backoffMultiplier: number;

  private contractId: string;
  private currentMode: SchedulerMode = 'caught_up';
  private consecutiveFailures = 0;

  constructor(contractId: string, config: SchedulerConfig = {}) {
    this.contractId = contractId;

    // Thresholds
    this.caughtUpThreshold = config.caughtUpThreshold ?? 50;
    this.aggressiveThreshold = config.aggressiveThreshold ?? 100;

    // Intervals
    this.intervalCaughtUpMs = config.intervalCaughtUpMs ?? 30000;
    this.intervalBehindMs = config.intervalBehindMs ?? 10000;
    this.intervalCatchUpMs = config.intervalCatchUpMs ?? 3000;

    // Batch sizes
    this.batchSizeCaughtUp = config.batchSizeCaughtUp ?? 100;
    this.batchSizeBehind = config.batchSizeBehind ?? 200;
    this.batchSizeCatchUp = config.batchSizeCatchUp ?? 500;

    // Backoff
    this.backoffBaseMs = config.backoffBaseMs ?? 5000;
    this.backoffMaxMs = config.backoffMaxMs ?? 135000;
    this.backoffMultiplier = config.backoffMultiplier ?? 3;
  }

  /**
   * Initialize scheduler state from database or create new record.
   */
  async initialize(): Promise<void> {
    try {
      const result = await query(
        `SELECT mode, consecutive_failures
         FROM indexer_scheduler_state
         WHERE contract = $1`,
        [this.contractId],
      );

      if (result.rows.length > 0) {
        const row = result.rows[0] as { mode: SchedulerMode; consecutive_failures: number };
        this.currentMode = row.mode;
        this.consecutiveFailures = row.consecutive_failures;
        logger.withContext().info('Adaptive scheduler initialized from DB', {
          contract: this.contractId,
          mode: this.currentMode,
          consecutiveFailures: this.consecutiveFailures,
        });
      } else {
        // Create new record
        await query(
          `INSERT INTO indexer_scheduler_state (contract, mode, consecutive_failures)
           VALUES ($1, $2, $3)`,
          [this.contractId, 'caught_up', 0],
        );
        logger.withContext().info('Adaptive scheduler created', { contract: this.contractId });
      }
    } catch (error) {
      logger.withContext().warn('Failed to initialize adaptive scheduler from DB', {
        contract: this.contractId,
        error,
      });
      // Continue with defaults
    }
  }

  /**
   * Calculate next poll interval based on current lag and backoff state.
   *
   * Returns: { intervalMs, batchSize, mode, backoffMs }
   */
  calculateNextPoll(lagLedgers: number): {
    intervalMs: number;
    batchSize: number;
    mode: SchedulerMode;
    backoffMs: number;
  } {
    const newMode = this.getModeForLag(lagLedgers);

    // Detect mode transition
    if (newMode !== this.currentMode) {
      this.recordModeTransition(this.currentMode, newMode, lagLedgers);
      this.currentMode = newMode;
      // Reset failure counter on mode transition to adaptive mode
      this.consecutiveFailures = 0;
    }

    const { intervalMs, batchSize } = this.getIntervalAndBatchForMode(this.currentMode);
    const backoffMs = this.calculateBackoff();

    return {
      intervalMs,
      batchSize,
      mode: this.currentMode,
      backoffMs,
    };
  }

  /**
   * Record a successful poll. Resets failure counter and persists state.
   */
  async recordSuccess(lagLedgers: number): Promise<void> {
    const hadFailures = this.consecutiveFailures > 0;

    if (hadFailures) {
      this.consecutiveFailures = 0;
      logger.withContext().info('Adaptive scheduler: backoff cleared after successful poll', {
        contract: this.contractId,
        lagLedgers,
      });
    }

    // Update state in database
    try {
      await query(
        `UPDATE indexer_scheduler_state
         SET consecutive_failures = 0,
             last_poll_time = CURRENT_TIMESTAMP,
             last_successful_poll_time = CURRENT_TIMESTAMP,
             last_lag_ledgers = $1,
             last_error_message = NULL
         WHERE contract = $2`,
        [lagLedgers, this.contractId],
      );
    } catch (error) {
      logger.withContext().warn('Failed to update scheduler success state', {
        contract: this.contractId,
        error,
      });
    }
  }

  /**
   * Record a poll failure. Increments failure counter and applies backoff.
   */
  async recordFailure(reason: string): Promise<{ backoffMs: number }> {
    this.consecutiveFailures += 1;
    const backoffMs = this.calculateBackoff();

    logger.withContext().warn('Adaptive scheduler: RPC failure, applying backoff', {
      contract: this.contractId,
      consecutiveFailures: this.consecutiveFailures,
      backoffMs,
      reason,
    });

    // Persist failure state
    try {
      await query(
        `UPDATE indexer_scheduler_state
         SET consecutive_failures = $1,
             last_poll_time = CURRENT_TIMESTAMP,
             last_error_message = $2
         WHERE contract = $3`,
        [this.consecutiveFailures, reason, this.contractId],
      );
    } catch (error) {
      logger.withContext().warn('Failed to update scheduler failure state', {
        contract: this.contractId,
        error,
      });
    }

    return { backoffMs };
  }

  /**
   * Reset backoff state (for operators to manually recover).
   */
  async resetBackoff(): Promise<void> {
    this.consecutiveFailures = 0;

    try {
      await query(
        `UPDATE indexer_scheduler_state
         SET consecutive_failures = 0,
             last_error_message = NULL
         WHERE contract = $1`,
        [this.contractId],
      );
      logger.withContext().info('Adaptive scheduler: backoff reset', { contract: this.contractId });
    } catch (error) {
      logger.withContext().warn('Failed to reset backoff state', {
        contract: this.contractId,
        error,
      });
    }
  }

  /**
   * Get current state for diagnostics.
   */
  async getState(): Promise<SchedulerState> {
    try {
      const result = await query(
        `SELECT mode, consecutive_failures, last_poll_time, last_successful_poll_time,
                last_lag_ledgers, last_error_message
         FROM indexer_scheduler_state
         WHERE contract = $1`,
        [this.contractId],
      );

      if (result.rows.length > 0) {
        const row = result.rows[0] as {
          mode: SchedulerMode;
          consecutive_failures: number;
          last_poll_time: string | null;
          last_successful_poll_time: string | null;
          last_lag_ledgers: number | null;
          last_error_message: string | null;
        };

        return {
          mode: row.mode,
          consecutiveFailures: row.consecutive_failures,
          lastPollTime: row.last_poll_time ? new Date(row.last_poll_time) : null,
          lastSuccessfulPollTime: row.last_successful_poll_time
            ? new Date(row.last_successful_poll_time)
            : null,
          lastLagLedgers: row.last_lag_ledgers,
          lastErrorMessage: row.last_error_message,
        };
      }
    } catch (error) {
      logger.withContext().warn('Failed to fetch scheduler state', {
        contract: this.contractId,
        error,
      });
    }

    // Return in-memory state as fallback
    return {
      mode: this.currentMode,
      consecutiveFailures: this.consecutiveFailures,
      lastPollTime: null,
      lastSuccessfulPollTime: null,
      lastLagLedgers: null,
      lastErrorMessage: null,
    };
  }

  /**
   * Determine scheduler mode based on lag.
   */
  private getModeForLag(lagLedgers: number): SchedulerMode {
    if (lagLedgers > this.aggressiveThreshold) {
      return 'catch_up';
    }
    if (lagLedgers > this.caughtUpThreshold) {
      return 'behind';
    }
    return 'caught_up';
  }

  /**
   * Get interval and batch size for a given mode.
   */
  private getIntervalAndBatchForMode(
    mode: SchedulerMode,
  ): { intervalMs: number; batchSize: number } {
    switch (mode) {
      case 'caught_up':
        return { intervalMs: this.intervalCaughtUpMs, batchSize: this.batchSizeCaughtUp };
      case 'behind':
        return { intervalMs: this.intervalBehindMs, batchSize: this.batchSizeBehind };
      case 'catch_up':
        return { intervalMs: this.intervalCatchUpMs, batchSize: this.batchSizeCatchUp };
    }
  }

  /**
   * Calculate backoff delay based on consecutive failures.
   *
   * Formula: backoff_ms = backoff_base * (multiplier ^ failures), capped at backoff_max
   */
  private calculateBackoff(): number {
    if (this.consecutiveFailures === 0) {
      return 0;
    }

    const exponent = Math.min(this.consecutiveFailures, 10); // Prevent overflow
    const backoffMs = this.backoffBaseMs * Math.pow(this.backoffMultiplier, exponent - 1);
    return Math.min(backoffMs, this.backoffMaxMs);
  }

  /**
   * Record a mode transition with metrics and logging.
   */
  private recordModeTransition(
    fromMode: SchedulerMode,
    toMode: SchedulerMode,
    lagLedgers: number,
  ): void {
    const { intervalMs: newInterval, batchSize: newBatch } = this.getIntervalAndBatchForMode(
      toMode,
    );

    logger.withContext().info('Adaptive scheduler mode transition', {
      contract: this.contractId,
      from: fromMode,
      to: toMode,
      lagLedgers,
      newInterval: newInterval,
      newBatchSize: newBatch,
      caughtUpThreshold: this.caughtUpThreshold,
      aggressiveThreshold: this.aggressiveThreshold,
    });

    // Persist mode change to database
    query(
      `UPDATE indexer_scheduler_state
       SET mode = $1
       WHERE contract = $2`,
      [toMode, this.contractId],
    ).catch((error) => {
      logger.withContext().warn('Failed to persist mode transition', {
        contract: this.contractId,
        error,
      });
    });
  }
}
