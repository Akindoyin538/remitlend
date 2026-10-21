import { jest } from '@jest/globals';

type Res = { rows: unknown[]; rowCount?: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Res>>();
const mockSubmit = jest.fn<(xdr: string) => Promise<{ txHash: string; status: string }>>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
}));
jest.unstable_mockModule('../services/sorobanService.js', () => ({
  sorobanService: { submitSignedTx: mockSubmit },
}));
jest.unstable_mockModule('../services/discrepancyLedgerService.js', () => ({
  resolveDiscrepancy: jest.fn(),
}));

const {
  canonicalize,
  computePayloadHash,
  createRequest,
  approveRequest,
  executeRequest,
  revokeRequest,
} = await import('../services/privilegedActionService.js');

const payload = { description: 'set rate', signedXdr: 'AAAA' };
const hash = computePayloadHash('contract_config_change', payload);

describe('privileged action dual control', () => {
  afterEach(() => jest.resetAllMocks());

  it('canonical hash ignores key order but changes with any parameter', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(
      computePayloadHash('contract_config_change', { ...payload, signedXdr: 'BBBB' }),
    ).not.toBe(hash);
    expect(computePayloadHash('reconciliation_resolution', payload)).not.toBe(hash);
  });

  it('rejects unsupported action types', async () => {
    await expect(
      createRequest({ actionType: 'drop_db', payload: {}, initiator: 'GA' }),
    ).rejects.toThrow('Unsupported');
  });

  it('creates a request with an expiry and audits it', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 5 }] });
    const out = await createRequest({
      actionType: 'contract_config_change',
      payload,
      initiator: 'GA',
    });
    expect(out.id).toBe(5);
    expect(out.payloadHash).toBe(hash);
    expect(out.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(mockQuery.mock.calls[1]![0]).toContain('audit_logs');
    expect(mockQuery.mock.calls[1]![1]![1]).toBe('DUAL_CONTROL_REQUEST');
  });

  it('approval SQL requires distinct principal, unexpired, pending and matching hash', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 5 }] });
    await approveRequest(5, 'GB', hash);
    const sql = mockQuery.mock.calls[0]![0];
    expect(sql).toContain('initiator <> $2');
    expect(sql).toContain('expires_at > NOW()');
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('payload_hash = $3');
  });

  it('rejects self-approval', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ payload_hash: hash }] })
      .mockResolvedValueOnce({
        rows: [{ status: 'pending', initiator: 'GA', expires_at: new Date(Date.now() + 1000) }],
      });
    await expect(approveRequest(5, 'GA', hash)).rejects.toThrow('own request');
  });

  it('rejects approval of a changed payload (stale hash)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ payload_hash: hash }] });
    await expect(approveRequest(5, 'GB', 'f'.repeat(64))).rejects.toThrow('Payload hash');
  });

  it('rejects approval after expiry', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ payload_hash: hash }] })
      .mockResolvedValueOnce({
        rows: [{ status: 'pending', initiator: 'GA', expires_at: new Date(Date.now() - 1000) }],
      });
    await expect(approveRequest(5, 'GB', hash)).rejects.toThrow('expired');
  });

  function approvedRow() {
    return { action_type: 'contract_config_change', payload, payload_hash: hash };
  }

  it('executes once and records the transaction reference; a replay cannot claim', async () => {
    mockSubmit.mockResolvedValue({ txHash: 'tx123', status: 'SUCCESS' });
    let claimed = false;
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT action_type')) return { rows: [approvedRow()] };
      if (sql.includes("SET status = 'executing'")) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ initiator: 'GA', approver: 'GB' }] };
      }
      if (sql.includes('SELECT status, initiator')) {
        return {
          rows: [{ status: 'executed', initiator: 'GA', expires_at: new Date(Date.now() + 1e5) }],
        };
      }
      return { rows: [] };
    });

    const [a, b] = await Promise.allSettled([executeRequest(5, 'GA'), executeRequest(5, 'GB')]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    const finalUpdate = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("status = 'executed'"),
    );
    expect(finalUpdate![1]).toEqual([5, 'tx123']);
  });

  it('records a failure reference when the executor fails', async () => {
    mockSubmit.mockRejectedValue(new Error('rpc down'));
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT action_type')) return { rows: [approvedRow()] };
      if (sql.includes("SET status = 'executing'")) {
        return { rows: [{ initiator: 'GA', approver: 'GB' }] };
      }
      return { rows: [] };
    });
    const out = await executeRequest(5, 'GA');
    expect(out).toEqual({ status: 'failed', error: 'rpc down' });
    const failed = mockQuery.mock.calls.find((c) => String(c[0]).includes("status = 'failed'"));
    expect(failed![1]).toEqual([5, 'rpc down']);
  });

  it('refuses execution when the stored payload was altered after approval', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...approvedRow(), payload: { ...payload, signedXdr: 'EVIL' } }],
    });
    await expect(executeRequest(5, 'GA')).rejects.toThrow('no longer matches');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('claim requires approved, unexpired, matching hash and a party to the request', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('SELECT action_type')) return { rows: [approvedRow()] };
      if (sql.includes('SELECT status, initiator')) {
        return {
          rows: [{ status: 'revoked', initiator: 'GA', expires_at: new Date(Date.now() + 1e5) }],
        };
      }
      return { rows: [] };
    });
    await expect(executeRequest(5, 'GC')).rejects.toThrow('revoked');
    const claimSql = mockQuery.mock.calls.find((c) => String(c[0]).includes("'executing'"))![0];
    expect(claimSql).toContain("status = 'approved'");
    expect(claimSql).toContain('expires_at > NOW()');
    expect(claimSql).toContain('initiator = $3 OR approver = $3');
  });

  it('revocation only applies to pending or approved requests by a party', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 5 }] });
    await revokeRequest(5, 'GA');
    expect(mockQuery.mock.calls[0]![0]).toContain("status IN ('pending', 'approved')");
    expect(mockQuery.mock.calls[1]![1]![1]).toBe('DUAL_CONTROL_REVOKE');
  });
});
