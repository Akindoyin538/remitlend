import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<unknown>>();
const mockAlert = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../../db/connection.js', () => ({ query: mockQuery }));
jest.unstable_mockModule('../scoresService.js', () => ({ setAbsoluteUserScoresBulk: jest.fn() }));
jest.unstable_mockModule('../sorobanService.js', () => ({ sorobanService: {} }));
jest.unstable_mockModule('../jobMetricsService.js', () => ({
  jobMetricsService: { recordSuccess: jest.fn(), recordFailure: jest.fn() },
}));
jest.unstable_mockModule('../failoverAlertService.js', () => ({ sendCriticalAlert: mockAlert }));

const mod = await import('../crossContractReconciler.js');

let divergent = 0;
const runSpy = jest.spyOn(mod.crossContractReconciler, 'run');

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mod.resetReconcilerStatus();
  divergent = 1;
  runSpy.mockImplementation(async () => ({
    backfilledRows: 0,
    processedRows: 1,
    reconciledCount: 0,
    halfAppliedCount: divergent,
    stillPendingCount: 0,
    correctedCount: 0,
    autoCorrectEnabled: false,
  }));
});

describe('scheduled cross-contract reconciliation', () => {
  it('alerts CRITICAL only after divergence persists for more than 2 runs', async () => {
    await mod.runScheduledReconciliation();
    await mod.runScheduledReconciliation();
    expect(mockAlert).not.toHaveBeenCalled();
    await mod.runScheduledReconciliation();
    expect(mockAlert).toHaveBeenCalledTimes(1);
  });

  it('resets the streak when a run is clean', async () => {
    await mod.runScheduledReconciliation();
    await mod.runScheduledReconciliation();
    divergent = 0;
    await mod.runScheduledReconciliation();
    divergent = 1;
    await mod.runScheduledReconciliation();
    await mod.runScheduledReconciliation();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('records each run in audit_logs and exposes status', async () => {
    await mod.runScheduledReconciliation();
    const audit = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO audit_logs'));
    expect(audit?.[1]).toEqual(expect.arrayContaining(['cross_contract_reconciliation']));
    const s = mod.getReconcilerStatus();
    expect(s.lastDivergenceCount).toBe(1);
    expect(s.lastRunAt).not.toBeNull();
    expect(typeof s.lastDurationMs).toBe('number');
  });

  it('validates cron schedule at startup', () => {
    expect(mod.validateReconcilerCronSchedule(undefined)).toBe('0 * * * *');
    expect(mod.validateReconcilerCronSchedule('*/5 * * * *')).toBe('*/5 * * * *');
    expect(() => mod.validateReconcilerCronSchedule('not a cron')).toThrow(
      /Invalid RECONCILER_CRON_SCHEDULE/,
    );
  });
});
