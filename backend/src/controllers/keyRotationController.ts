/**
 * Key Rotation Admin Controller
 *
 * Provides admin endpoints for key rotation operations:
 * - POST /admin/key-rotation/start
 * - GET /admin/key-rotation/batch/:batchId
 * - POST /admin/key-rotation/batch/:batchId/verify
 * - POST /admin/key-rotation/batch/:batchId/complete
 * - POST /admin/key-rotation/batch/:batchId/rollback
 * - GET /admin/key-rotation/batches
 */

import type { Request, Response, NextFunction } from 'express';
import { keyRotationService } from '../services/keyRotationService.js';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';

/**
 * Start a new key rotation batch.
 * Authorization: admin:all only
 */
export async function startKeyRotation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { new_kek_id } = req.body as { new_kek_id?: string };

    if (!new_kek_id || typeof new_kek_id !== 'string') {
      throw new AppError('new_kek_id is required and must be a string', 400);
    }

    const actor = req.user?.publicKey || 'system:api';
    const requestId = (req as any).requestId || 'unknown';

    const batch = await keyRotationService.startRotation(new_kek_id, actor, requestId);

    // Audit log
    await query(
      `INSERT INTO audit_logs (action, actor, resource_type, resource_id, metadata, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        'key_rotation_started',
        actor,
        'pii_encryption_key',
        batch.id,
        JSON.stringify({
          old_kek_id: batch.old_kek_id,
          new_kek_id: batch.new_kek_id,
          request_id: requestId,
        }),
        'success',
      ],
    );

    res.json({
      batch_id: batch.id,
      old_kek_id: batch.old_kek_id,
      new_kek_id: batch.new_kek_id,
      status: batch.status,
      initiated_at: batch.initiated_at,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get key rotation batch status.
 */
export async function getKeyRotationBatch(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { batchId } = req.params as { batchId?: string };

    if (!batchId) {
      throw new AppError('batchId is required', 400);
    }

    const result = await query(`SELECT * FROM key_rotation_batch WHERE id = $1`, [batchId]);

    if (result.rows.length === 0) {
      throw new AppError(`Batch ${batchId} not found`, 404);
    }

    const batch = result.rows[0] as Record<string, unknown>;

    res.json({
      batch_id: batch.id,
      old_kek_id: batch.old_kek_id,
      new_kek_id: batch.new_kek_id,
      status: batch.status,
      total_records_scanned: batch.total_records_scanned,
      total_records_rotated: batch.total_records_rotated,
      total_records_failed: batch.total_records_failed,
      initiated_at: batch.initiated_at,
      completed_at: batch.completed_at,
      verification_passed: batch.verification_passed,
      failure_reason: batch.failure_reason,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Verify key rotation batch.
 * Spot-checks records to confirm rotation succeeded.
 */
export async function verifyKeyRotationBatch(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { batchId } = req.params as { batchId?: string };

    if (!batchId) {
      throw new AppError('batchId is required', 400);
    }

    const actor = req.user?.publicKey || 'system:api';

    const result = await keyRotationService.verifyRotation(batchId);

    // Audit log
    await query(
      `INSERT INTO audit_logs (action, actor, resource_type, resource_id, metadata, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        'key_rotation_verified',
        actor,
        'pii_encryption_key',
        batchId,
        JSON.stringify({
          passed: result.passed,
          sample_size: result.sample_size,
          records_verified: result.records_verified,
        }),
        result.passed ? 'success' : 'failed',
      ],
    );

    res.json({
      batch_id: result.batch_id,
      passed: result.passed,
      sample_size: result.sample_size,
      records_verified: result.records_verified,
      records_failed: result.records_failed,
      verified_at: result.verified_at,
      failure_details: result.failure_details.slice(0, 10), // Limit details
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Complete key rotation batch.
 * Marks batch as officially complete; operator may now revoke old KEK.
 */
export async function completeKeyRotationBatch(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { batchId } = req.params as { batchId?: string };

    if (!batchId) {
      throw new AppError('batchId is required', 400);
    }

    // Fetch batch
    const batchResult = await query(`SELECT * FROM key_rotation_batch WHERE id = $1`, [batchId]);

    if (batchResult.rows.length === 0) {
      throw new AppError(`Batch ${batchId} not found`, 404);
    }

    const batch = batchResult.rows[0] as Record<string, unknown>;

    if (batch.status !== 'completed') {
      throw new AppError(
        `Batch must be completed before marking as complete. Current status: ${batch.status}`,
        400,
      );
    }

    if (!batch.verification_passed) {
      throw new AppError(
        'Verification must pass before completing batch',
        400,
      );
    }

    const actor = req.user?.publicKey || 'system:api';

    // Mark as officially complete (can now revoke old KEK)
    await query(
      `UPDATE key_rotation_batch SET metadata = jsonb_set(metadata, '{officially_complete}', 'true'::jsonb), updated_at = NOW() WHERE id = $1`,
      [batchId],
    );

    // Audit log
    await query(
      `INSERT INTO audit_logs (action, actor, resource_type, resource_id, metadata, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        'key_rotation_completed',
        actor,
        'pii_encryption_key',
        batchId,
        JSON.stringify({
          total_records_rotated: batch.total_records_rotated,
          old_kek_id: batch.old_kek_id,
          new_kek_id: batch.new_kek_id,
        }),
        'success',
      ],
    );

    res.json({
      batch_id: batchId,
      status: 'completed',
      message: 'Key rotation batch marked as complete. Old KEK may now be revoked after 24 hours.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Rollback key rotation batch.
 * Reverts rotated records back to old KEK.
 */
export async function rollbackKeyRotationBatch(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { batchId } = req.params as { batchId?: string };
    const { reason } = req.body as { reason?: string };

    if (!batchId) {
      throw new AppError('batchId is required', 400);
    }

    if (!reason) {
      throw new AppError('reason is required for rollback', 400);
    }

    const actor = req.user?.publicKey || 'system:api';

    await keyRotationService.rollbackRotation(batchId, reason);

    // Audit log
    await query(
      `INSERT INTO audit_logs (action, actor, resource_type, resource_id, metadata, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        'key_rotation_rolled_back',
        actor,
        'pii_encryption_key',
        batchId,
        JSON.stringify({ reason }),
        'success',
      ],
    );

    res.json({
      batch_id: batchId,
      status: 'rolled_back',
      message: 'Key rotation batch rolled back. Records reverted to old KEK.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Resume key rotation batch.
 * Continues rotation from the last checkpoint.
 */
export async function resumeKeyRotationBatch(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { batchId } = req.params as { batchId?: string };

    if (!batchId) {
      throw new AppError('batchId is required', 400);
    }

    const actor = req.user?.publicKey || 'system:api';

    const batch = await keyRotationService.resumeRotation(batchId);

    // Audit log
    await query(
      `INSERT INTO audit_logs (action, actor, resource_type, resource_id, metadata, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        'key_rotation_resumed',
        actor,
        'pii_encryption_key',
        batchId,
        JSON.stringify({
          total_records_rotated: batch.total_records_rotated,
        }),
        'success',
      ],
    );

    res.json({
      batch_id: batch.id,
      status: 'in_progress',
      total_records_rotated: batch.total_records_rotated,
      message: 'Key rotation resumed from checkpoint.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * List key rotation batches.
 */
export async function listKeyRotationBatches(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const status = req.query.status as string | undefined;
    const limit = Math.min(Number(req.query.limit ?? 25), 100);
    const offset = Number(req.query.offset ?? 0);

    let whereClause = '';
    const params: (string | number)[] = [];

    if (status) {
      whereClause = `WHERE status = $1`;
      params.push(status);
    }

    const result = await query(
      `SELECT id, old_kek_id, new_kek_id, status, total_records_rotated, total_records_failed, 
              initiated_at, completed_at, verification_passed, failure_reason
       FROM key_rotation_batch
       ${whereClause}
       ORDER BY initiated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit + 1, offset],
    );

    const batches = result.rows as Array<Record<string, unknown>>;
    const hasNext = batches.length > limit;

    res.json({
      batches: batches.slice(0, limit),
      has_next: hasNext,
      offset,
      limit,
    });
  } catch (err) {
    next(err);
  }
}
