import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type Res = { rows: unknown[]; rowCount?: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Res>>();
const clientQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Res>>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
}));
jest.unstable_mockModule('../db/transaction.js', () => ({
  withTransaction: async (fn: (c: { query: typeof clientQuery }) => Promise<unknown>) =>
    fn({ query: clientQuery }),
}));

const { recordDiscrepancy, valuesDiffer, computeDedupeKey, resolveDiscrepancy } =
  await import('../services/discrepancyLedgerService.js');

const base = {
  discrepancyClass: 'loan_principal',
  subjectRef: 'loan:1',
  asset: 'USDC',
  unit: 'stroops',
  contractValue: '9007199254740993',
  indexedValue: '9007199254740993',
  dbValue: '9007199254740992',
};

describe('discrepancy ledger', () => {
  afterEach(() => jest.resetAllMocks());

  it('compares exact integers beyond float precision', () => {
    expect(valuesDiffer('9007199254740993', '9007199254740993', '9007199254740992')).toBe(true);
    expect(valuesDiffer('5', '5', '5')).toBe(false);
    expect(() => valuesDiffer('1.5', '1', '1')).toThrow();
  });

  it('does not record when all sources agree', async () => {
    const out = await recordDiscrepancy({ ...base, dbValue: base.contractValue });
    expect(out).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('is idempotent: repeat detection upserts observation metadata only', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 3, created: false }] });
    const out = await recordDiscrepancy(base);
    expect(out).toEqual({ id: 3, created: false });
    const sql = mockQuery.mock.calls[0]![0];
    expect(sql).toContain('ON CONFLICT (dedupe_key) DO UPDATE');
    expect(sql).not.toMatch(/SET[^;]*(contract_value|source_snapshots)/);
    expect(computeDedupeKey(base, 'v1')).toBe(computeDedupeKey({ ...base }, 'v1'));
    expect(computeDedupeKey(base, 'v1')).not.toBe(computeDedupeKey(base, 'v2'));
  });

  it('requires actor, reason and evidence to resolve', async () => {
    const ok = { discrepancyId: 1, actor: 'GADMIN', reason: 'confirmed manual fix', evidence: {} };
    await expect(resolveDiscrepancy({ ...ok, evidence: { tx: 'abc' }, actor: '' })).rejects.toThrow();
    await expect(resolveDiscrepancy({ ...ok, reason: 'x', evidence: { tx: 'a' } })).rejects.toThrow();
    await expect(resolveDiscrepancy(ok)).rejects.toThrow();
  });

  it('resolution writes an append-only record and an audit entry', async () => {
    clientQuery.mockImplementation(async (sql) =>
      sql.includes('FOR UPDATE')
        ? { rows: [{ id: 1, discrepancy_class: 'loan_principal', status: 'open' }] }
        : { rows: [] },
    );
    await resolveDiscrepancy({
      discrepancyId: 1,
      actor: 'GADMIN',
      reason: 'confirmed manual fix',
      evidence: { tx: 'abc' },
    });
    const sqls = clientQuery.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('reconciliation_discrepancy_resolutions'))).toBe(true);
    expect(sqls.some((s) => s.includes('audit_logs'))).toBe(true);
  });

  it('rejects resolving an already-resolved discrepancy', async () => {
    clientQuery.mockResolvedValue({
      rows: [{ id: 1, discrepancy_class: 'loan_principal', status: 'resolved' }],
    });
    await expect(
      resolveDiscrepancy({
        discrepancyId: 1,
        actor: 'GADMIN',
        reason: 'confirmed manual fix',
        evidence: { tx: 'abc' },
      }),
    ).rejects.toThrow('already resolved');
  });

  it('migration guards evidence and resolutions against update/delete', () => {
    const sql = readFileSync(
      path.resolve(process.cwd(), 'migrations/1807000000000_discrepancy-ledger.js'),
      'utf8',
    );
    expect(sql).toContain('discrepancy evidence is immutable');
    expect(sql).toContain('append-only');
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
  });
});
