/**
 * Issue #510: consumer-driven API contract tests for the critical financial
 * flows (loan application, repayment, pool reads, transaction status).
 *
 * Each contract is a strict zod shape declared by the consumer (borrower app,
 * lender app). Real Express routes are exercised through supertest; the chain
 * (sorobanService) and database are mocked. Request fixtures are parsed with the
 * same schemas the routes use (src/schemas), so they cannot drift from them.
 * Failures name the route, the consumer, and the mismatched field.
 *
 * To add a contract, see "Consumer contract tests" in CONTRIBUTING.md.
 */
import request from 'supertest';
import { jest } from '@jest/globals';
import { z } from 'zod';
import { Keypair } from '@stellar/stellar-sdk';
import { generateJwtToken } from '../services/authService.js';
import { submitTxSchema } from '../schemas/loanSchemas.js';

type MockQueryResult = { rows: unknown[]; rowCount?: number };

const BORROWER = Keypair.random().publicKey();
const LENDER = Keypair.random().publicKey();

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-long!!';
process.env.LENDER_WALLETS = LENDER;

const mockQuery: jest.MockedFunction<
  (text: string, params?: unknown[]) => Promise<MockQueryResult>
> = jest.fn();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    get: jest.fn<() => Promise<null>>().mockResolvedValue(null),
    set: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    delete: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ping: jest.fn<() => Promise<string>>().mockResolvedValue('ok'),
  },
}));

const mockBuildRequestLoanTx = jest.fn<() => Promise<unknown>>();
const mockBuildRepayTx = jest.fn<() => Promise<unknown>>();
const mockSubmitSignedTx = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule('../services/sorobanService.js', () => ({
  sorobanService: {
    buildRequestLoanTx: mockBuildRequestLoanTx,
    buildRepayTx: mockBuildRepayTx,
    submitSignedTx: mockSubmitSignedTx,
    getWithdrawalCooldownLedgers: jest.fn<() => Promise<number>>().mockResolvedValue(0),
  },
}));

const { default: app } = await import('../app.js');

const bearer = (key: string) => ({ Authorization: `Bearer ${generateJwtToken(key)}` });

// ---------------------------------------------------------------------------
// Consumer contracts. Bump `version` (and update the schema) only with an
// intentional, reviewed breaking change to the response.
// ---------------------------------------------------------------------------
interface Contract {
  route: string;
  consumer: string;
  version: number;
  schema: z.ZodTypeAny;
}

const unsignedTx = z
  .object({
    success: z.literal(true),
    unsignedTxXdr: z.string().min(1),
    networkPassphrase: z.string().min(1),
  })
  .strict();

const CONTRACTS = {
  loanRequest: {
    route: 'POST /api/loans/request',
    consumer: 'borrower-app',
    version: 1,
    schema: unsignedTx,
  },
  repay: {
    route: 'POST /api/loans/:loanId/repay',
    consumer: 'borrower-app',
    version: 1,
    schema: unsignedTx.extend({ loanId: z.number().int() }).strict(),
  },
  submit: {
    route: 'POST /api/loans/submit',
    consumer: 'borrower-app',
    version: 1,
    schema: z
      .object({
        success: z.literal(true),
        txHash: z.string().min(1),
        status: z.enum(['SUCCESS', 'PENDING', 'FAILED']),
      })
      .passthrough(),
  },
  poolStats: {
    route: 'GET /api/pool/stats',
    consumer: 'lender-app',
    version: 1,
    schema: z.object({
      success: z.literal(true),
      data: z.object({
        // Money units: plain numbers in token units, never strings.
        totalDeposits: z.number().nonnegative(),
        totalOutstanding: z.number().nonnegative(),
        utilizationRate: z.number().min(0).max(1),
        apy: z.number(),
        activeLoansCount: z.number().int().nonnegative(),
        withdrawalCooldownLedgers: z.number().int().nonnegative(),
      }),
    }),
  },
  transactionStatus: {
    route: 'GET /api/transactions/me',
    consumer: 'borrower-app',
    version: 1,
    schema: z.object({
      success: z.literal(true),
      data: z.array(
        z.object({
          id: z.number().int(),
          txHash: z.string(),
          status: z.string(),
          submittedBy: z.string(),
          transactionType: z.string().nullable().optional(),
        }),
      ),
      page_info: z.object({
        limit: z.number().int(),
        count: z.number().int(),
        next_cursor: z.string().nullable(),
        has_previous: z.boolean(),
        has_next: z.boolean(),
      }),
    }),
  },
  errorEnvelope: {
    route: '*',
    consumer: 'all',
    version: 1,
    schema: z.object({
      success: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).passthrough(),
    }),
  },
} satisfies Record<string, Contract>;

/** Fails with route, consumer and the exact mismatched field path(s). */
function expectContract(contract: Contract, body: unknown): void {
  const result = contract.schema.safeParse(body);
  if (!result.success) {
    const fields = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Contract violation [${contract.route}] consumer=${contract.consumer} v${contract.version}: ${fields}`,
    );
  }
}

beforeEach(() => {
  mockQuery.mockReset();
  jest.clearAllMocks();
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.LENDER_WALLETS;
});

describe('consumer contracts: loan application', () => {
  const body = { amount: 1000, borrowerPublicKey: BORROWER };

  it('honours the success contract', async () => {
    mockBuildRequestLoanTx.mockResolvedValueOnce({
      unsignedTxXdr: 'AAAA',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    const res = await request(app).post('/api/loans/request').set(bearer(BORROWER)).send(body);
    expect(res.status).toBe(200);
    expectContract(CONTRACTS.loanRequest, res.body);
  });

  it('rejects unauthenticated callers with the error envelope', async () => {
    const res = await request(app).post('/api/loans/request').send(body);
    expect(res.status).toBe(401);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });

  it('rejects a borrower acting for another wallet', async () => {
    const res = await request(app)
      .post('/api/loans/request')
      .set(bearer(BORROWER))
      .send({ ...body, borrowerPublicKey: Keypair.random().publicKey() });
    expect(res.status).toBe(403);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });

  it('requires amount (validation envelope)', async () => {
    const res = await request(app)
      .post('/api/loans/request')
      .set(bearer(BORROWER))
      .send({ borrowerPublicKey: BORROWER });
    expect(res.status).toBe(400);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });
});

describe('consumer contracts: repayment and submission', () => {
  it('honours the repay contract', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ address: BORROWER }] });
    mockBuildRepayTx.mockResolvedValueOnce({
      unsignedTxXdr: 'BBBB',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    const res = await request(app)
      .post('/api/loans/1/repay')
      .set(bearer(BORROWER))
      .send({ amount: 500, borrowerPublicKey: BORROWER });
    expect(res.status).toBe(200);
    expectContract(CONTRACTS.repay, res.body);
  });

  it('denies repayment on a loan owned by someone else', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ address: Keypair.random().publicKey() }] });
    const res = await request(app)
      .post('/api/loans/1/repay')
      .set(bearer(BORROWER))
      .send({ amount: 500, borrowerPublicKey: BORROWER });
    expect(res.status).toBe(403);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });

  it('honours the submit contract using a schema-valid fixture', async () => {
    const fixture = submitTxSchema.parse({ signedTxXdr: 'c2lnbmVkLXhkci1kYXRh' });
    mockSubmitSignedTx.mockResolvedValueOnce({ txHash: 'abc123', status: 'SUCCESS' });
    const res = await request(app).post('/api/loans/submit').set(bearer(BORROWER)).send(fixture);
    expect(res.status).toBe(200);
    expectContract(CONTRACTS.submit, res.body);
  });

  it('rejects a submit body missing signedTxXdr', async () => {
    const res = await request(app).post('/api/loans/submit').set(bearer(BORROWER)).send({});
    expect(res.status).toBe(400);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });
});

describe('consumer contracts: pool reads', () => {
  it('honours the pool stats contract for a lender', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total_deposits: '10000' }] })
      .mockResolvedValueOnce({ rows: [{ active_loans_count: '2', total_outstanding: '2500' }] });
    const res = await request(app).get('/api/pool/stats').set(bearer(LENDER));
    expect(res.status).toBe(200);
    expectContract(CONTRACTS.poolStats, res.body);
    expect(res.body.data.utilizationRate).toBeCloseTo(0.25, 4);
  });

  it('denies pool stats to a borrower', async () => {
    const res = await request(app).get('/api/pool/stats').set(bearer(BORROWER));
    expect(res.status).toBe(403);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });
});

describe('consumer contracts: transaction status', () => {
  it('honours the transaction list contract', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 7,
          tx_hash: 'abc123',
          status: 'success',
          submitted_at: new Date().toISOString(),
          submitted_by: BORROWER,
          transaction_type: 'repay',
          result_xdr: null,
        },
      ],
    });
    const res = await request(app).get('/api/transactions/me').set(bearer(BORROWER));
    expect(res.status).toBe(200);
    expectContract(CONTRACTS.transactionStatus, res.body);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/transactions/me');
    expect(res.status).toBe(401);
    expectContract(CONTRACTS.errorEnvelope, res.body);
  });
});

describe('contract harness', () => {
  it('names route, consumer and field on mismatch', () => {
    expect(() =>
      expectContract(CONTRACTS.loanRequest, { success: true, unsignedTxXdr: 1 }),
    ).toThrow(/\[POST \/api\/loans\/request\] consumer=borrower-app v1: unsignedTxXdr/);
  });
});
