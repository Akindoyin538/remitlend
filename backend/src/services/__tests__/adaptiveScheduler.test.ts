import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.setTimeout(10000);

const mockQuery = jest
  .fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>>()
  .mockResolvedValue({ rows: [], rowCount: 0 });

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  withContext: jest.fn(() => mockLogger),
};

jest.unstable_mockModule('../../db/connection.js', () => ({
  query: mockQuery,
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: mockLogger,
}));

describe('AdaptiveScheduler', () => {
  let AdaptiveScheduler: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const mod = await import('../adaptiveScheduler.js');
    AdaptiveScheduler = mod.AdaptiveScheduler;
  });

  describe('initialization', () => {
    it('creates scheduler with default config', () => {
      const scheduler = new AdaptiveScheduler('test-contract');
      expect(scheduler).toBeDefined();
    });

    it('initializes from database state', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { mode: 'catch_up', consecutive_failures: 2 },
        ],
        rowCount: 1,
      });

      const scheduler = new AdaptiveScheduler('test-contract');
      await scheduler.initialize();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT mode, consecutive_failures'),
        ['test-contract'],
      );
    });

    it('creates new database record if not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const scheduler = new AdaptiveScheduler('test-contract');
      await scheduler.initialize();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO indexer_scheduler_state'),
        expect.arrayContaining(['test-contract', 'caught_up', 0]),
      );
    });

    it('handles initialization database errors gracefully', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const scheduler = new AdaptiveScheduler('test-contract');
      await expect(scheduler.initialize()).resolves.not.toThrow();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to initialize'),
        expect.any(Object),
      );
    });
  });

  describe('mode transitions based on lag', () => {
    it('starts in caught_up mode', () => {
      const scheduler = new AdaptiveScheduler('test-contract');
      const result = scheduler.calculateNextPoll(0);
      expect(result.mode).toBe('caught_up');
      expect(result.intervalMs).toBe(30000);
      expect(result.batchSize).toBe(100);
    });

    it('transitions to behind mode when lag exceeds caught_up threshold', () => {
      const scheduler = new AdaptiveScheduler('test-contract', { caughtUpThreshold: 50 });
      const result = scheduler.calculateNextPoll(75);
      expect(result.mode).toBe('behind');
      expect(result.intervalMs).toBe(10000);
      expect(result.batchSize).toBe(200);
    });

    it('transitions to catch_up mode when lag exceeds aggressive threshold', () => {
      const scheduler = new AdaptiveScheduler('test-contract', { aggressiveThreshold: 100 });
      const result = scheduler.calculateNextPoll(150);
      expect(result.mode).toBe('catch_up');
      expect(result.intervalMs).toBe(3000);
      expect(result.batchSize).toBe(500);
    });

    it('transitions back to behind when lag decreases', () => {
      const scheduler = new AdaptiveScheduler('test-contract', {
        caughtUpThreshold: 50,
        aggressiveThreshold: 100,
      });

      // Start in catch_up
      scheduler.calculateNextPoll(150);

      // Drop to behind
      const result = scheduler.calculateNextPoll(75);
      expect(result.mode).toBe('behind');
    });

    it('transitions back to caught_up when lag is low', () => {
      const scheduler = new AdaptiveScheduler('test-contract', {
        caughtUpThreshold: 50,
      });

      // Start in behind
      scheduler.calculateNextPoll(75);

      // Drop to caught_up
      const result = scheduler.calculateNextPoll(25);
      expect(result.mode).toBe('caught_up');
    });

    it('respects custom configuration values', () => {
      const customConfig = {
        caughtUpThreshold: 100,
        aggressiveThreshold: 200,
        intervalCaughtUpMs: 60000,
        intervalBehindMs: 20000,
        intervalCatchUpMs: 5000,
        batchSizeCaughtUp: 50,
        batchSizeBehind: 150,
        batchSizeCatchUp: 300,
      };

      const scheduler = new AdaptiveScheduler('test-contract', customConfig);

      const caughtUp = scheduler.calculateNextPoll(50);
      expect(caughtUp.intervalMs).toBe(60000);
      expect(caughtUp.batchSize).toBe(50);

      const behind = scheduler.calculateNextPoll(150);
      expect(behind.intervalMs).toBe(20000);
      expect(behind.batchSize).toBe(150);

      const catchUp = scheduler.calculateNextPoll(250);
      expect(catchUp.intervalMs).toBe(5000);
      expect(catchUp.batchSize).toBe(300);
    });
  });

  describe('backoff on RPC failures', () => {
    it('returns no backoff initially', () => {
      const scheduler = new AdaptiveScheduler('test-contract');
      const result = scheduler.calculateNextPoll(0);
      expect(result.backoffMs).toBe(0);
    });

    it('increments consecutive failures on recordFailure', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const scheduler = new AdaptiveScheduler('test-contract');
      const result1 = await scheduler.recordFailure('RPC timeout');

      expect(result1.backoffMs).toBeGreaterThan(0);
    });

    it('applies exponential backoff formula', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const backoffConfig = {
        backoffBaseMs: 1000,
        backoffMultiplier: 2, // Easier math: 1000 * 2^0, 1000 * 2^1, etc.
      };

      const scheduler = new AdaptiveScheduler('test-contract', backoffConfig);

      // First failure: 1000 * 2^0 = 1000
      await scheduler.recordFailure('First failure');
      let next = scheduler.calculateNextPoll(0);
      expect(next.backoffMs).toBe(1000);

      // Second failure: 1000 * 2^1 = 2000
      await scheduler.recordFailure('Second failure');
      next = scheduler.calculateNextPoll(0);
      expect(next.backoffMs).toBe(2000);

      // Third failure: 1000 * 2^2 = 4000
      await scheduler.recordFailure('Third failure');
      next = scheduler.calculateNextPoll(0);
      expect(next.backoffMs).toBe(4000);
    });

    it('caps backoff at maximum', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const backoffConfig = {
        backoffBaseMs: 1000,
        backoffMultiplier: 3,
        backoffMaxMs: 5000,
      };

      const scheduler = new AdaptiveScheduler('test-contract', backoffConfig);

      // Record many failures to exceed cap
      for (let i = 0; i < 10; i++) {
        await scheduler.recordFailure(`Failure ${i}`);
      }

      const result = scheduler.calculateNextPoll(0);
      expect(result.backoffMs).toBeLessThanOrEqual(5000);
    });

    it('resets backoff after successful poll', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const scheduler = new AdaptiveScheduler('test-contract');

      // Generate failures
      await scheduler.recordFailure('First failure');
      await scheduler.recordFailure('Second failure');

      let result = scheduler.calculateNextPoll(0);
      const backoffBefore = result.backoffMs;
      expect(backoffBefore).toBeGreaterThan(0);

      // Record success
      await scheduler.recordSuccess(0);

      // Backoff should be cleared
      result = scheduler.calculateNextPoll(0);
      expect(result.backoffMs).toBe(0);
    });
  });

  describe('state persistence', () => {
    it('persists mode changes to database', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const scheduler = new AdaptiveScheduler('test-contract');
      scheduler.calculateNextPoll(150); // Transition to catch_up

      // Wait for async persistence
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check that UPDATE was called with catch_up mode
      const calls = mockQuery.mock.calls.filter((call) =>
        call[0]?.includes('UPDATE indexer_scheduler_state') && call[0]?.includes('mode = $1'),
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[calls.length - 1][1]).toContain('catch_up');
    });

    it('persists success state', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const scheduler = new AdaptiveScheduler('test-contract');
      await scheduler.recordSuccess(42);

      // Check that successful poll params include lag value and contract
      const calls = mockQuery.mock.calls.filter((call) =>
        call[0]?.includes('last_successful_poll_time'),
      );
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toContain(42); // lag ledgers
      expect(lastCall[1]).toContain('test-contract');
    });

    it('persists failure state with error message', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const scheduler = new AdaptiveScheduler('test-contract');
      const errorMsg = 'RPC connection timeout';
      await scheduler.recordFailure(errorMsg);

      // Check that failure was persisted with error message
      const calls = mockQuery.mock.calls.filter((call) =>
        call[0]?.includes('consecutive_failures = $1'),
      );
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toContain(errorMsg);
    });
  });

  describe('state retrieval', () => {
    it('returns current state from database', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            mode: 'behind',
            consecutive_failures: 1,
            last_poll_time: '2026-10-16T10:00:00Z',
            last_successful_poll_time: '2026-10-16T09:59:00Z',
            last_lag_ledgers: 75,
            last_error_message: 'RPC timeout',
          },
        ],
        rowCount: 1,
      });

      const scheduler = new AdaptiveScheduler('test-contract');
      const state = await scheduler.getState();

      expect(state.mode).toBe('behind');
      expect(state.consecutiveFailures).toBe(1);
      expect(state.lastLagLedgers).toBe(75);
      expect(state.lastErrorMessage).toBe('RPC timeout');
    });

    it('handles missing state gracefully', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const scheduler = new AdaptiveScheduler('test-contract');
      const state = await scheduler.getState();

      expect(state.mode).toBe('caught_up');
      expect(state.consecutiveFailures).toBe(0);
    });
  });

  describe('backoff reset', () => {
    it('resets backoff and persists to database', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const scheduler = new AdaptiveScheduler('test-contract');

      // Generate failures
      await scheduler.recordFailure('First');
      await scheduler.recordFailure('Second');

      let result = scheduler.calculateNextPoll(0);
      expect(result.backoffMs).toBeGreaterThan(0);

      // Reset backoff
      await scheduler.resetBackoff();

      result = scheduler.calculateNextPoll(0);
      expect(result.backoffMs).toBe(0);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('backoff reset'),
        expect.any(Object),
      );
    });
  });

  describe('boundary conditions', () => {
    it('handles lag exactly at threshold boundaries', () => {
      const scheduler = new AdaptiveScheduler('test-contract', {
        caughtUpThreshold: 50,
        aggressiveThreshold: 100,
      });

      // Exactly at caught_up threshold
      let result = scheduler.calculateNextPoll(50);
      expect(result.mode).toBe('caught_up');

      // Just over caught_up threshold
      result = scheduler.calculateNextPoll(51);
      expect(result.mode).toBe('behind');

      // Exactly at aggressive threshold
      result = scheduler.calculateNextPoll(100);
      expect(result.mode).toBe('behind');

      // Just over aggressive threshold
      result = scheduler.calculateNextPoll(101);
      expect(result.mode).toBe('catch_up');
    });

    it('handles zero lag', () => {
      const scheduler = new AdaptiveScheduler('test-contract');
      const result = scheduler.calculateNextPoll(0);
      expect(result.mode).toBe('caught_up');
      expect(result.intervalMs).toBe(30000);
    });

    it('handles very large lag', () => {
      const scheduler = new AdaptiveScheduler('test-contract');
      const result = scheduler.calculateNextPoll(1_000_000);
      expect(result.mode).toBe('catch_up');
      expect(result.intervalMs).toBe(3000);
      expect(result.batchSize).toBe(500);
    });
  });

  describe('mode transition logging', () => {
    it('logs mode transitions', () => {
      const scheduler = new AdaptiveScheduler('test-contract');

      mockLogger.info.mockClear();
      scheduler.calculateNextPoll(150);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('mode transition'),
        expect.objectContaining({
          from: 'caught_up',
          to: 'catch_up',
          lagLedgers: 150,
        }),
      );
    });

    it('logs backoff events', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const scheduler = new AdaptiveScheduler('test-contract');
      mockLogger.warn.mockClear();

      await scheduler.recordFailure('Test failure');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('RPC failure'),
        expect.objectContaining({
          consecutiveFailures: 1,
          backoffMs: expect.any(Number),
          reason: 'Test failure',
        }),
      );
    });
  });
});
