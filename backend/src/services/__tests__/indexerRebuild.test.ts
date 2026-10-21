import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

type Res = { rows: unknown[]; rowCount: number };
let mockQuery: jest.Mock<(...a: unknown[]) => Promise<Res>>;
let clientQuery: jest.Mock<(...a: unknown[]) => Promise<Res>>;
let svc: typeof import('../indexerRebuild.js');

const input = {
  network: 'testnet',
  contractIds: ['C1'],
  startLedger: 100,
  endLedger: 2500,
  decoderVersion: 'v1',
};
const rebuildRow = (over: Record<string, unknown> = {}) => ({
  rows: [
    {
      status: 'pending',
      network: 'testnet',
      contract_ids: ['C1'],
      start_ledger: '100',
      end_ledger: '2500',
      decoder_version: 'v1',
      last_replayed_ledger: null,
      ...over,
    },
  ],
  rowCount: 1,
});
const empty: Res = { rows: [], rowCount: 0 };
const ev = (id: string, ledger: number) => ({
  event_id: id, event_type: 'LoanRepaid', loan_id: 1, address: 'G', amount: '5',
  ledger, tx_hash: 't', contract_id: 'C1',
});

beforeAll(async () => {
  mockQuery = jest.fn<(...a: unknown[]) => Promise<Res>>();
  clientQuery = jest.fn<(...a: unknown[]) => Promise<Res>>().mockResolvedValue(empty);
  jest.unstable_mockModule('../../db/connection.js', () => ({
    query: mockQuery,
    withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: clientQuery }),
  }));
  svc = await import('../indexerRebuild.js');
});

beforeEach(() => {
  mockQuery.mockReset();
  clientQuery.mockReset().mockResolvedValue(empty);
});

describe('indexer shadow rebuild', () => {
  it('rejects checkpoint mismatch before replaying', async () => {
    mockQuery
      .mockResolvedValueOnce(rebuildRow()) // loadRebuild
      .mockResolvedValueOnce(empty) // no suspect
      .mockResolvedValueOnce({ rows: [{ contract: 'C1', max_end: '2000' }], rowCount: 1 });
    await expect(svc.replayRebuild(1)).rejects.toThrow(/Checkpoint mismatch/);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('resumes an interrupted replay from last_replayed_ledger', async () => {
    mockQuery
      .mockResolvedValueOnce(rebuildRow({ last_replayed_ledger: '1099' }))
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ rows: [{ contract: 'C1', max_end: '3000' }], rowCount: 1 })
      .mockResolvedValue(empty);
    await svc.replayRebuild(1);
    const inserts = clientQuery.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO indexer_rebuild_events'));
    expect((inserts[0][1] as number[])[1]).toBe(1100);
    expect(inserts).toHaveLength(2); // 1100-2099, 2100-2500
  });

  it('replays idempotently: duplicates are ignored by unique key', async () => {
    mockQuery
      .mockResolvedValueOnce(rebuildRow())
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ rows: [{ contract: 'C1', max_end: '3000' }], rowCount: 1 })
      .mockResolvedValue(empty);
    await svc.replayRebuild(1);
    const sql = String(clientQuery.mock.calls[0][0]);
    expect(sql).toContain('ON CONFLICT (rebuild_id, event_id) DO NOTHING');
  });

  it('digest is order-stable and detects divergence', () => {
    const a = [ev('a', 1), ev('b', 2)];
    expect(svc.digestRows(a)).toBe(svc.digestRows([ev('a', 1), ev('b', 2)]));
    expect(svc.digestRows(a)).not.toBe(svc.digestRows([ev('a', 1), ev('c', 2)]));
  });

  it('fails validation when shadow differs from live', async () => {
    mockQuery
      .mockResolvedValueOnce(rebuildRow({ last_replayed_ledger: '2500' }))
      .mockResolvedValueOnce({ rows: [ev('a', 1)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ev('a', 1), ev('b', 2)], rowCount: 2 })
      .mockResolvedValue(empty);
    const r = await svc.validateRebuild(1);
    expect(r.ok).toBe(false);
    expect(String(mockQuery.mock.calls.at(-1)?.[0])).toContain("status='failed'");
  });

  it('validates when shadow equals live', async () => {
    mockQuery
      .mockResolvedValueOnce(rebuildRow({ last_replayed_ledger: '2500' }))
      .mockResolvedValueOnce({ rows: [ev('a', 1)], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ev('a', 1)], rowCount: 1 })
      .mockResolvedValue(empty);
    expect((await svc.validateRebuild(1)).ok).toBe(true);
  });

  it('promotion requires validation and is idempotent', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ status: 'pending', network: 'testnet' }], rowCount: 1 });
    await expect(svc.promoteRebuild(1)).rejects.toThrow(/not validated/);

    clientQuery.mockReset().mockResolvedValueOnce({ rows: [{ status: 'promoted', network: 'testnet' }], rowCount: 1 });
    expect(await svc.promoteRebuild(1)).toEqual({ promoted: true, alreadyPromoted: true });
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it('validates input on creation', async () => {
    await expect(svc.createRebuild({ ...input, endLedger: 1 })).rejects.toThrow();
  });
});
