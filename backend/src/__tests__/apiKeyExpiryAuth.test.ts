import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError.js';

describe('user API keys – expiry and rotation (#792)', () => {
  it('rejects an expired key with 401 and WWW-Authenticate, accepts a valid one', async () => {
    const { jest } = await import('@jest/globals');
    const lookupApiKey = jest.fn<(s: string) => Promise<unknown>>();
    jest.resetModules();
    jest.unstable_mockModule('../services/apiKeyService.js', () => ({
      API_KEY_PREFIX: 'rlk_',
      lookupApiKey,
    }));
    const { requireJwtAuth } = await import('../middleware/jwtAuth.js');
    const headers: Record<string, string> = {};
    const res = { set: (k: string, v: string) => (headers[k] = v) } as unknown as Response;
    const req = { headers: { authorization: 'Bearer rlk_abc' } } as unknown as Request;

    lookupApiKey.mockResolvedValueOnce({ status: 'expired' });
    await expect(requireJwtAuth(req, res, (() => {}) as NextFunction)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(headers['WWW-Authenticate']).toBe('Bearer error="invalid_token"');

    lookupApiKey.mockResolvedValueOnce({
      status: 'valid',
      key: { id: 1, owner: 'GABC', scopes: [], expiresAt: new Date(Date.now() + 1000) },
    });
    const next = jest.fn();
    await requireJwtAuth(req, res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(req.user?.publicKey).toBe('GABC');
  });
});
