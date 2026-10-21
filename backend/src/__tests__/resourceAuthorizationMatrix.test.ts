/**
 * Resource-level authorization matrix (#519).
 *
 * 1. CI guard: every route in the user-resource route files must be present in
 *    ROUTE_INVENTORY (and every inventory entry must still exist), so a new route
 *    cannot ship without an authorization mapping or an explicit exemption.
 * 2. Probes: for each non-exempt inventory entry, unauthenticated callers get 401 and a
 *    principal holding a different wallet is denied without revealing whether the
 *    target record exists (identical response to a missing record).
 */
import { jest, describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const OWNER = 'GOWNER0000000000000000000000000000000000000000000000001';
const ATTACKER = 'GATTACKER00000000000000000000000000000000000000000001';

type Res = { rows: unknown[]; rowCount: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<Res>>();
mockQuery.mockImplementation(async (_sql, params) => {
  // Loan lookups: loan "1" is owned by OWNER, anything else does not exist.
  if (params?.[0] === '1') return { rows: [{ address: OWNER }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});

jest.unstable_mockModule('../db/connection.js', () => {
  const connection = {
    query: mockQuery,
    getClient: jest.fn(),
    withTransaction: jest.fn(),
    on: jest.fn(),
    connect: jest.fn(),
  };
  return {
    default: connection,
    pool: connection,
    query: connection.query,
    getClient: connection.getClient,
    withTransaction: connection.withTransaction,
  };
});

const { AppError } = await import('../errors/AppError.js');
jest.unstable_mockModule('../services/remittanceService.js', () => ({
  remittanceService: {
    getRemittance: jest.fn(async (id: string) => {
      if (id === 'rem-owned') return { id, senderId: OWNER, status: 'pending' };
      throw AppError.notFound('Remittance not found');
    }),
  },
}));

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-resourcematrix';
const app = (await import('../app.js')).default;
const { ROUTE_INVENTORY, EXEMPT_ROUTE_FILES } =
  await import('./fixtures/routeAuthorizationInventory.js');

const routesDir = path.resolve(process.cwd(), 'src/routes');
const ROUTE_RE = /^\s*router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gm;

function scanRoutes(): Map<string, { method: string; path: string; file: string }> {
  const found = new Map<string, { method: string; path: string; file: string }>();
  for (const file of readdirSync(routesDir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(routesDir, file), 'utf8');
    for (const m of src.matchAll(ROUTE_RE)) {
      const method = m[1]!.toUpperCase();
      found.set(`${file} ${method} ${m[2]}`, { method, path: m[2]!, file });
    }
  }
  return found;
}

const SCOPES = {
  borrower: [
    'read:loans',
    'write:loans',
    'read:score',
    'read:notifications',
    'write:notifications',
    'read:remittances',
    'write:remittances',
  ],
};
const token = (publicKey: string) =>
  jwt.sign({ publicKey, role: 'borrower', scopes: SCOPES.borrower }, process.env.JWT_SECRET!, {
    expiresIn: '1h',
    algorithm: 'HS256',
  });

describe('route inventory guard (#519)', () => {
  const routes = scanRoutes();

  it('every route in a covered file has an inventory entry or an explicit exemption', () => {
    const missing = [...routes.keys()].filter((key) => {
      const file = routes.get(key)!.file;
      return !(key in ROUTE_INVENTORY) && !(file in EXEMPT_ROUTE_FILES);
    });
    expect(missing).toEqual([]);
  });

  it('every inventory entry still maps to a real route', () => {
    const stale = Object.keys(ROUTE_INVENTORY).filter((key) => !routes.has(key));
    expect(stale).toEqual([]);
  });

  it('every exemption states a reason', () => {
    for (const [key, entry] of Object.entries(ROUTE_INVENTORY)) {
      if (entry.exempt !== undefined) expect([key, entry.exempt.length > 10]).toEqual([key, true]);
    }
    for (const reason of Object.values(EXEMPT_ROUTE_FILES))
      expect(reason.length).toBeGreaterThan(10);
  });

  it('GraphQL is not mounted, so no nested GraphQL resource paths are exposed', () => {
    const appSrc = readFileSync(path.resolve(process.cwd(), 'src/app.ts'), 'utf8');
    expect(appSrc).not.toMatch(/graphql/i);
  });
});

function concretePath(entry: { mount: string }, route: string, foreignWallet: string): string {
  const resolved = route
    .replace(/:(loanId)/, '1')
    .replace(/:(borrower|userId|walletAddress|address)/, foreignWallet)
    .replace(/:id/, 'rem-owned');
  return `${entry.mount}${resolved === '/' ? '' : resolved}`;
}

describe('cross-principal probes', () => {
  const probed = Object.entries(ROUTE_INVENTORY).filter(
    ([, e]) => e.exempt === undefined && e.ownership !== 'none',
  );

  for (const [key, entry] of probed) {
    const [file, METHOD, route] = key.split(' ') as [string, string, string];
    void file;
    const method = METHOD.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const body = { amount: 1, signedXdr: 'AAAA', borrowerPublicKey: ATTACKER, ids: [1] };

    describe(key, () => {
      it('rejects unauthenticated callers with 401', async () => {
        const res = await request(app)
          [method](concretePath(entry, route, OWNER))
          .send(body);
        expect(res.status).toBe(401);
      });

      if (entry.ownership === 'loan-owner' || entry.ownership === 'loan-borrower') {
        it('denies a foreign borrower exactly like a missing loan', async () => {
          const foreign = await request(app)
            [method](concretePath(entry, route, OWNER))
            .set('Authorization', `Bearer ${token(ATTACKER)}`)
            .set('Idempotency-Key', 'k-foreign')
            .send(body);
          const missing = await request(app)
            [method](concretePath(entry, route, OWNER).replace('/1', '/999'))
            .set('Authorization', `Bearer ${token(ATTACKER)}`)
            .set('Idempotency-Key', 'k-missing')
            .send(body);
          expect(foreign.status).toBe(404);
          expect(missing.status).toBe(404);
          expect(foreign.body.message).toBe(missing.body.message);
        });
      }

      if (entry.ownership === 'sender-record') {
        it('denies a foreign sender exactly like a missing record', async () => {
          const foreign = await request(app)
            [method](concretePath(entry, route, OWNER))
            .set('Authorization', `Bearer ${token(ATTACKER)}`)
            .set('Idempotency-Key', 'k-foreign')
            .send(body);
          const missing = await request(app)
            [method](concretePath(entry, route, OWNER).replace('rem-owned', 'rem-missing'))
            .set('Authorization', `Bearer ${token(ATTACKER)}`)
            .set('Idempotency-Key', 'k-missing')
            .send(body);
          expect(foreign.status).toBe(404);
          expect(missing.status).toBe(404);
          expect(foreign.body.message).toBe(missing.body.message);
        });
      }

      if (entry.ownership === 'wallet-param') {
        it('denies access to another wallet with 403', async () => {
          const res = await request(app)
            [method](concretePath(entry, route, OWNER))
            .set('Authorization', `Bearer ${token(ATTACKER)}`);
          expect(res.status).toBe(403);
        });
      }
    });
  }
});
