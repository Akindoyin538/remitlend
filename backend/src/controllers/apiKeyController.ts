import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createApiKey, resolveExpiry, rotateApiKey } from '../services/apiKeyService.js';

const view = (r: { id: number; name: string | null; scopes: string[]; expiresAt: Date }) => ({
  id: r.id,
  name: r.name,
  scopes: r.scopes,
  expiresAt: r.expiresAt.toISOString(),
});

export const createUserApiKey = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const { name, scopes, expiresAt } = req.body as {
    name?: string;
    scopes?: string[];
    expiresAt?: string;
  };
  const requested = scopes ?? user.scopes;
  const disallowed = requested.filter((s) => !user.scopes.includes(s));
  if (disallowed.length > 0) {
    throw AppError.forbidden(`Cannot grant scopes you do not hold: ${disallowed.join(', ')}`);
  }
  const { key, record } = await createApiKey({
    owner: user.publicKey,
    name,
    scopes: requested,
    expiresAt: resolveExpiry(expiresAt),
  });
  res.status(201).json({ success: true, data: { ...view(record), key } });
});

export const rotateUserApiKey = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('Invalid key id');
  const { key, record } = await rotateApiKey(id, req.user!.publicKey);
  res.json({ success: true, data: { ...view(record), key, rotatedFrom: id } });
});
