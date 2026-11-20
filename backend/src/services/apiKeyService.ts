import crypto from 'node:crypto';
import { query, withTransaction } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { notificationService } from './notificationService.js';
import logger from '../utils/logger.js';

export const API_KEY_PREFIX = 'rlk_';
export const MAX_KEY_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
export const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

export interface ApiKeyRecord {
  id: number;
  owner: string;
  name: string | null;
  scopes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
}

export type ApiKeyLookup =
  | { status: 'valid'; key: ApiKeyRecord }
  | { status: 'expired' | 'revoked' | 'unknown' };

export const hashApiKey = (secret: string): string =>
  crypto.createHash('sha256').update(secret).digest('hex');

const generateSecret = (): string => API_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');

function mapRow(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: Number(row.id),
    owner: row.owner as string,
    name: (row.name as string | null) ?? null,
    scopes: (row.scopes as string[]) ?? [],
    expiresAt: new Date(row.expires_at as string | Date),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string | Date) : null,
  };
}

/** Validates the requested expiry (must be in the future, at most 1 year out). */
export function resolveExpiry(expiresAt: string | undefined, now = Date.now()): Date {
  if (!expiresAt) return new Date(now + MAX_KEY_LIFETIME_MS);
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) throw AppError.badRequest('expiresAt must be ISO 8601');
  if (date.getTime() <= now) throw AppError.badRequest('expiresAt must be in the future');
  if (date.getTime() > now + MAX_KEY_LIFETIME_MS) {
    throw AppError.badRequest('expiresAt must be within 1 year');
  }
  return date;
}

export async function createApiKey(input: {
  owner: string;
  name?: string | undefined;
  scopes: string[];
  expiresAt: Date;
}): Promise<{ key: string; record: ApiKeyRecord }> {
  const secret = generateSecret();
  const result = await query(
    `INSERT INTO user_api_keys (owner, name, key_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.owner, input.name ?? null, hashApiKey(secret), input.scopes, input.expiresAt],
  );
  return { key: secret, record: mapRow(result.rows[0]) };
}

/** Atomically revokes a key and issues a replacement with the same scopes and a fresh expiry. */
export async function rotateApiKey(
  id: number,
  owner: string,
  now = Date.now(),
): Promise<{ key: string; record: ApiKeyRecord }> {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT * FROM user_api_keys WHERE id = $1 AND owner = $2 FOR UPDATE`,
      [id, owner],
    );
    if (current.rows.length === 0) throw AppError.notFound('API key not found');
    const old = mapRow(current.rows[0]);
    if (old.revokedAt) throw AppError.badRequest('API key is already revoked');

    await client.query(`UPDATE user_api_keys SET revoked_at = NOW() WHERE id = $1`, [id]);

    const secret = generateSecret();
    const inserted = await client.query(
      `INSERT INTO user_api_keys (owner, name, key_hash, scopes, expires_at, rotated_from)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [owner, old.name, hashApiKey(secret), old.scopes, new Date(now + MAX_KEY_LIFETIME_MS), id],
    );
    return { key: secret, record: mapRow(inserted.rows[0]) };
  });
}

export async function lookupApiKey(secret: string, now = Date.now()): Promise<ApiKeyLookup> {
  const result = await query(`SELECT * FROM user_api_keys WHERE key_hash = $1`, [
    hashApiKey(secret),
  ]);
  if (result.rows.length === 0) return { status: 'unknown' };
  const key = mapRow(result.rows[0]);
  if (key.revokedAt) return { status: 'revoked' };
  if (key.expiresAt.getTime() <= now) return { status: 'expired' };
  return { status: 'valid', key };
}

/** Notifies owners of keys expiring within 7 days (once per key). Returns the number notified. */
export async function notifyExpiringApiKeys(now = Date.now()): Promise<number> {
  const result = await query(
    `SELECT id, owner, name, expires_at FROM user_api_keys
     WHERE revoked_at IS NULL AND expiry_notified_at IS NULL
       AND expires_at > $1 AND expires_at <= $2`,
    [new Date(now), new Date(now + EXPIRY_WARNING_MS)],
  );
  let notified = 0;
  for (const row of result.rows) {
    try {
      await notificationService.createNotification({
        userId: row.owner as string,
        type: 'api_key_expiring',
        title: 'API key expiring soon',
        message: `Your API key${row.name ? ` "${row.name}"` : ''} expires on ${new Date(
          row.expires_at as string,
        ).toISOString()}. Rotate it before then to avoid interruption.`,
        actionUrl: '/settings/api-keys',
      });
      await query(`UPDATE user_api_keys SET expiry_notified_at = NOW() WHERE id = $1`, [row.id]);
      notified += 1;
    } catch (error) {
      logger.withContext().error('Failed to send API key expiry notification', { error });
    }
  }
  return notified;
}
