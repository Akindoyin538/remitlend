import crypto from 'node:crypto';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import logger from '../utils/logger.js';
import { resolveDiscrepancy } from './discrepancyLedgerService.js';
import { sorobanService } from './sorobanService.js';

/**
 * Two-person approval flow for a narrow set of high-impact actions (#520).
 * Approval is bound to a canonical payload hash, expires, and the action can
 * be claimed for execution exactly once.
 */

export type PrivilegedActionType = 'contract_config_change' | 'reconciliation_resolution';

interface ExecutorContext {
  initiator: string;
  approver: string;
}

type Executor = (payload: Record<string, unknown>, ctx: ExecutorContext) => Promise<string>;

const EXECUTORS: Record<PrivilegedActionType, Executor> = {
  // payload: { description, signedXdr } — a pre-signed contract configuration transaction.
  contract_config_change: async (payload) => {
    const result = await sorobanService.submitSignedTx(String(payload.signedXdr));
    return result.txHash;
  },
  // payload: { discrepancyId, reason, evidence }
  reconciliation_resolution: async (payload, ctx) => {
    await resolveDiscrepancy({
      discrepancyId: Number(payload.discrepancyId),
      actor: ctx.initiator,
      reason: String(payload.reason),
      evidence: { ...(payload.evidence as Record<string, unknown>), approvedBy: ctx.approver },
    });
    return `discrepancy:${String(payload.discrepancyId)}`;
  },
};

export const PRIVILEGED_ACTION_TYPES = Object.keys(EXECUTORS) as PrivilegedActionType[];
export const DEFAULT_APPROVAL_TTL_MS = 60 * 60 * 1000;

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computePayloadHash(actionType: string, payload: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(`${actionType}\n${canonicalize(payload)}`)
    .digest('hex');
}

async function audit(actor: string, action: string, requestId: number, detail: object) {
  try {
    await query(
      `INSERT INTO audit_logs (actor, action, target, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 200)`,
      [actor, action, `PrivilegedAction:${requestId}`, JSON.stringify(detail)],
    );
  } catch (error) {
    logger.error('Failed to write dual-control audit entry', { error, action, requestId });
  }
}

export async function createRequest(input: {
  actionType: string;
  payload: Record<string, unknown>;
  initiator: string;
  ttlMs?: number;
}): Promise<{ id: number; payloadHash: string; expiresAt: Date }> {
  if (!PRIVILEGED_ACTION_TYPES.includes(input.actionType as PrivilegedActionType)) {
    throw AppError.badRequest(`Unsupported privileged action: ${input.actionType}`);
  }
  const payloadHash = computePayloadHash(input.actionType, input.payload);
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS));
  const result = await query(
    `INSERT INTO privileged_action_requests
       (action_type, payload, payload_hash, initiator, expires_at)
     VALUES ($1, $2::jsonb, $3, $4, $5)
     RETURNING id`,
    [input.actionType, JSON.stringify(input.payload), payloadHash, input.initiator, expiresAt],
  );
  const id = Number((result.rows[0] as { id: number }).id);
  await audit(input.initiator, 'DUAL_CONTROL_REQUEST', id, {
    actionType: input.actionType,
    payloadHash,
    expiresAt,
  });
  return { id, payloadHash, expiresAt };
}

async function explainRejection(id: number, actor: string, fallback: string): Promise<AppError> {
  const r = await query(
    `SELECT status, initiator, expires_at FROM privileged_action_requests WHERE id = $1`,
    [id],
  );
  const row = r.rows[0] as { status: string; initiator: string; expires_at: Date } | undefined;
  if (!row) return AppError.notFound('Privileged action request not found');
  if (row.initiator === actor && fallback === 'approve') {
    return AppError.forbidden('Initiator cannot approve their own request');
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return AppError.conflict('Approval request has expired');
  }
  return AppError.conflict(`Request cannot be ${fallback}d in state "${row.status}"`);
}

/** The approver must present the payload hash they reviewed; a changed payload no longer matches. */
export async function approveRequest(id: number, approver: string, payloadHash: string) {
  const result = await query(
    `UPDATE privileged_action_requests
     SET status = 'approved', approver = $2, approved_at = NOW()
     WHERE id = $1
       AND status = 'pending'
       AND expires_at > NOW()
       AND initiator <> $2
       AND payload_hash = $3
     RETURNING id`,
    [id, approver, payloadHash],
  );
  if (result.rows.length === 0) {
    const r = await query(`SELECT payload_hash FROM privileged_action_requests WHERE id = $1`, [
      id,
    ]);
    const stored = (r.rows[0] as { payload_hash?: string } | undefined)?.payload_hash;
    if (stored && stored !== payloadHash) {
      throw AppError.conflict('Payload hash does not match the request');
    }
    throw await explainRejection(id, approver, 'approve');
  }
  await audit(approver, 'DUAL_CONTROL_APPROVE', id, { payloadHash });
}

export async function revokeRequest(id: number, actor: string) {
  const result = await query(
    `UPDATE privileged_action_requests
     SET status = 'revoked', revoked_at = NOW(), revoked_by = $2
     WHERE id = $1 AND status IN ('pending', 'approved')
       AND (initiator = $2 OR approver = $2)
     RETURNING id`,
    [id, actor],
  );
  if (result.rows.length === 0) throw await explainRejection(id, actor, 'revoke');
  await audit(actor, 'DUAL_CONTROL_REVOKE', id, {});
}

/**
 * Executes an approved request at most once. The claim is a single conditional
 * UPDATE (approved + unexpired + hash still matches the stored payload), so
 * concurrent or replayed executions cannot both proceed.
 */
export async function executeRequest(id: number, actor: string) {
  const current = await query(
    `SELECT action_type, payload, payload_hash FROM privileged_action_requests WHERE id = $1`,
    [id],
  );
  const row = current.rows[0] as
    | { action_type: PrivilegedActionType; payload: Record<string, unknown>; payload_hash: string }
    | undefined;
  if (!row) throw AppError.notFound('Privileged action request not found');
  if (computePayloadHash(row.action_type, row.payload) !== row.payload_hash) {
    throw AppError.conflict('Stored payload no longer matches the approved hash');
  }

  const claim = await query(
    `UPDATE privileged_action_requests
     SET status = 'executing'
     WHERE id = $1
       AND status = 'approved'
       AND expires_at > NOW()
       AND payload_hash = $2
       AND (initiator = $3 OR approver = $3)
     RETURNING initiator, approver`,
    [id, row.payload_hash, actor],
  );
  const claimed = claim.rows[0] as { initiator: string; approver: string } | undefined;
  if (!claimed) throw await explainRejection(id, actor, 'execute');

  await audit(actor, 'DUAL_CONTROL_EXECUTE', id, { payloadHash: row.payload_hash });
  try {
    const reference = await EXECUTORS[row.action_type](row.payload, {
      initiator: claimed.initiator,
      approver: claimed.approver,
    });
    await query(
      `UPDATE privileged_action_requests
       SET status = 'executed', executed_at = NOW(), execution_ref = $2 WHERE id = $1`,
      [id, reference],
    );
    return { status: 'executed' as const, reference };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown execution error';
    // Not retried: a failed action needs a fresh request and fresh approval.
    await query(
      `UPDATE privileged_action_requests
       SET status = 'failed', executed_at = NOW(), execution_error = $2 WHERE id = $1`,
      [id, message.slice(0, 500)],
    );
    return { status: 'failed' as const, error: message.slice(0, 500) };
  }
}

export async function getRequest(id: number) {
  const r = await query(
    `SELECT id, action_type, payload_hash, initiator, approver, status, expires_at, approved_at,
            revoked_at, revoked_by, executed_at, execution_ref, execution_error, created_at, payload
     FROM privileged_action_requests WHERE id = $1`,
    [id],
  );
  if (!r.rows[0]) throw AppError.notFound('Privileged action request not found');
  return r.rows[0];
}
