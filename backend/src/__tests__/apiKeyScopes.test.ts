import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError.js';

const originalEnv = process.env.INTERNAL_API_KEY;

function makeReq(apiKey?: string): Partial<Request> {
  return {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
  };
}

function makeRes(): Partial<Response> {
  return {};
}

function makeNext(): NextFunction & { calls: unknown[][] } {
  const fn = ((err?: unknown) => {
    fn.calls.push([err]);
  }) as NextFunction & { calls: unknown[][] };
  fn.calls = [];
  return fn;
}

async function loadMiddleware() {
  // Force module re-evaluation so env changes take effect
  const mod = await import('../middleware/auth.js');
  return mod.requireApiKey;
}

describe('requireApiKey – scope support', () => {
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.INTERNAL_API_KEY;
    } else {
      process.env.INTERNAL_API_KEY = originalEnv;
    }
  });

  describe('legacy key (no scope)', () => {
    beforeEach(() => {
      process.env.INTERNAL_API_KEY = 'legacy-value';
    });

    it('is accepted on a route with no required scope', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      requireApiKey()(makeReq('legacy-value') as Request, makeRes() as Response, next);
      expect(next.calls.length).toBe(1);
      expect(next.calls[0]![0]).toBeUndefined();
    });

    it('is accepted on a route with admin:disputes scope', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      requireApiKey('admin:disputes')(
        makeReq('legacy-value') as Request,
        makeRes() as Response,
        next,
      );
      expect(next.calls.length).toBe(1);
      expect(next.calls[0]![0]).toBeUndefined();
    });

    it('is accepted on any admin scope (admin:loans)', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      requireApiKey('admin:loans')(makeReq('legacy-value') as Request, makeRes() as Response, next);
      expect(next.calls.length).toBe(1);
      expect(next.calls[0]![0]).toBeUndefined();
    });
  });

  describe('scoped key', () => {
    beforeEach(() => {
      process.env.INTERNAL_API_KEY = 'admin:disputes:dispute-value';
    });

    it('is accepted on a matching scope', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      requireApiKey('admin:disputes')(
        makeReq('dispute-value') as Request,
        makeRes() as Response,
        next,
      );
      expect(next.calls.length).toBe(1);
      expect(next.calls[0]![0]).toBeUndefined();
    });

    it('is rejected on a route with no explicit scope', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      expect(() =>
        requireApiKey()(makeReq('dispute-value') as Request, makeRes() as Response, next),
      ).toThrow(AppError);
      expect(next.calls.length).toBe(0);
    });

    it('throws 403 on a different scope (admin:loans)', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      try {
        requireApiKey('admin:loans')(
          makeReq('dispute-value') as Request,
          makeRes() as Response,
          next,
        );
        throw new Error('expected middleware to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(403);
      }
      expect(next.calls.length).toBe(0);
    });

    it('throws when key is absent', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      expect(() =>
        requireApiKey('admin:disputes')(makeReq() as Request, makeRes() as Response, next),
      ).toThrow();
    });
  });

  describe('multiple keys configured', () => {
    beforeEach(() => {
      process.env.INTERNAL_API_KEY =
        'admin:disputes:dispute-one,admin:indexer:indexer-two,legacy-value';
    });

    it('accepts dispute-one for admin:disputes', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      requireApiKey('admin:disputes')(
        makeReq('dispute-one') as Request,
        makeRes() as Response,
        next,
      );
      expect(next.calls[0]![0]).toBeUndefined();
    });

    it('accepts indexer-two for admin:indexer', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      requireApiKey('admin:indexer')(
        makeReq('indexer-two') as Request,
        makeRes() as Response,
        next,
      );
      expect(next.calls[0]![0]).toBeUndefined();
    });

    it('rejects dispute-one for admin:indexer', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      expect(() =>
        requireApiKey('admin:indexer')(
          makeReq('dispute-one') as Request,
          makeRes() as Response,
          next,
        ),
      ).toThrow();
    });

    it('accepts legacy key for admin:webhooks', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      requireApiKey('admin:webhooks')(
        makeReq('legacy-value') as Request,
        makeRes() as Response,
        next,
      );
      expect(next.calls[0]![0]).toBeUndefined();
    });
  });

  describe('constant-time comparison', () => {
    beforeEach(() => {
      process.env.INTERNAL_API_KEY = 'correct-value';
    });

    it('rejects a wrong key that has the same length as the correct key', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      expect(() =>
        requireApiKey()(makeReq('wrong-valueXX') as Request, makeRes() as Response, next),
      ).toThrow();
      expect(next.calls.length).toBe(0);
    });
  });

  describe('INTERNAL_API_KEY not set', () => {
    beforeEach(() => {
      delete process.env.INTERNAL_API_KEY;
    });

    it('throws an internal error', async () => {
      const requireApiKey = await loadMiddleware();
      const next = makeNext();
      expect(() =>
        requireApiKey()(makeReq('any-value') as Request, makeRes() as Response, next),
      ).toThrow();
    });
  });
});

describe('user API keys – expiry and rotation (#792)', () => {
  it('validates expiry bounds (max 1 year, must be future)', async () => {
    const { resolveExpiry } = await import('../services/apiKeyService.js');
    const now = Date.now();
    expect(() => resolveExpiry(new Date(now - 1000).toISOString(), now)).toThrow();
    expect(() => resolveExpiry(new Date(now + 366 * 864e5).toISOString(), now)).toThrow();
    expect(resolveExpiry(new Date(now + 864e5).toISOString(), now).getTime()).toBe(now + 864e5);
  });

  it('rotates atomically in one transaction and notifies at T-7 days', async () => {
    const { jest } = await import('@jest/globals');
    jest.resetModules();
    const clientQuery = jest.fn<(sql: string, p?: unknown[]) => Promise<unknown>>(async (sql) => {
      if (sql.includes('FOR UPDATE'))
        return { rows: [{ id: 1, owner: 'GABC', name: 'k', scopes: ['a'], expires_at: new Date(), revoked_at: null }] };
      if (sql.includes('INSERT'))
        return { rows: [{ id: 2, owner: 'GABC', name: 'k', scopes: ['a'], expires_at: new Date() }] };
      return { rows: [] };
    });
    const withTransaction = jest.fn(async (fn: (c: unknown) => unknown) => fn({ query: clientQuery }));
    const dbQuery = jest.fn<(sql: string, p?: unknown[]) => Promise<unknown>>(async (sql) =>
      sql.includes('SELECT id, owner')
        ? { rows: [{ id: 2, owner: 'GABC', name: 'k', expires_at: new Date(Date.now() + 864e5) }] }
        : { rows: [] },
    );
    const createNotification = jest.fn(async () => ({}));
    jest.unstable_mockModule('../db/connection.js', () => ({ query: dbQuery, withTransaction }));
    jest.unstable_mockModule('../services/notificationService.js', () => ({
      notificationService: { createNotification },
    }));
    const svc = await import('../services/apiKeyService.js');

    const rotated = await svc.rotateApiKey(1, 'GABC');
    expect(withTransaction).toHaveBeenCalledTimes(1);
    const sqls = clientQuery.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => s.includes('SET revoked_at'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO user_api_keys'))).toBe(true);
    expect(rotated.key.startsWith('rlk_')).toBe(true);

    expect(await svc.notifyExpiringApiKeys()).toBe(1);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'GABC', type: 'api_key_expiring' }),
    );
  });
});
