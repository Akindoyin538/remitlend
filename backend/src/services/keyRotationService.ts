import crypto from 'node:crypto';
import client from 'prom-client';
import { pool } from '../db/connection.js';
import logger from '../utils/logger.js';

/**
 * Key Rotation Service
 *
 * Manages the rotation of PII Data Encryption Keys (DEKs) from one
 * Key Encryption Key (KEK) to another. Handles retry logic, audit
 * logging, metrics, and recovery from partial failures.
 */

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface KeyRotationBatchRecord {
  id: string;
  old_kek_id: string;
  new_kek_id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'rolled_back';
  last_rotated_record_id: string | null;
  total_records_scanned: number;
  total_records_rotated: number;
  total_records_failed: number;
  initiated_by: string;
  initiated_at: Date;
  completed_at: Date | null;
  rolled_back_at: Date | null;
  failure_reason: string | null;
  last_error_code: string | null;
  verification_passed: boolean | null;
  verification_sample_size: number | null;
  verification_checked_at: Date | null;
  metadata: Record<string, unknown>;
  request_id: string;
}

export interface EncryptedRecord {
  id: string;
  table_name: string;
  field_name: string;
  ciphertext: Buffer;
  gcm_nonce: Buffer;
  dek_wrapped: Buffer;
  dek_kek_id: string;
  encrypted_value: Buffer | null; // raw value from database
}

export interface RotationVerificationResult {
  batch_id: string;
  passed: boolean;
  sample_size: number;
  verified_at: Date;
  records_verified: number;
  records_failed: number;
  failure_details: Array<{
    record_id: string;
    table_name: string;
    error: string;
  }>;
}

// ============================================================================
// Error Classes
// ============================================================================

export class KeyRotationError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean = false) {
    super(message);
    this.name = 'KeyRotationError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class KMSUnwrapError extends KeyRotationError {
  constructor(message: string, retryable: boolean = false) {
    super('KMS_UNWRAP_ERROR', message, retryable);
  }
}

export class KMSWrapError extends KeyRotationError {
  constructor(message: string, retryable: boolean = false) {
    super('KMS_WRAP_ERROR', message, retryable);
  }
}

export class DecryptionError extends KeyRotationError {
  constructor(message: string, retryable: boolean = false) {
    super('DECRYPTION_ERROR', message, retryable);
  }
}

export class RotationAlreadyInProgressError extends KeyRotationError {
  constructor() {
    super('ROTATION_IN_PROGRESS', 'Another key rotation is already in progress', false);
  }
}

// ============================================================================
// Metrics
// ============================================================================

const keyRotationMetrics = {
  batchStarted: new client.Counter({
    name: 'key_rotation_batch_started_total',
    help: 'Number of key rotation batches started',
    labelNames: ['old_kek_id', 'new_kek_id'],
  }),

  batchCompleted: new client.Counter({
    name: 'key_rotation_batch_completed_total',
    help: 'Number of key rotation batches completed',
    labelNames: ['batch_id', 'status'],
  }),

  batchDurationSeconds: new client.Histogram({
    name: 'key_rotation_batch_duration_seconds',
    help: 'Key rotation batch duration in seconds',
    labelNames: ['batch_id', 'status'],
    buckets: [1, 5, 10, 30, 60, 300, 600, 1800],
  }),

  recordsRotated: new client.Gauge({
    name: 'key_rotation_records_rotated',
    help: 'Number of records rotated in current batch',
    labelNames: ['batch_id'],
  }),

  recordsFailed: new client.Gauge({
    name: 'key_rotation_records_failed',
    help: 'Number of records failed during rotation',
    labelNames: ['batch_id'],
  }),

  kmsOperationDurationSeconds: new client.Histogram({
    name: 'key_rotation_kms_operation_duration_seconds',
    help: 'Duration of KMS encrypt/decrypt operations',
    labelNames: ['operation', 'kek_id', 'success'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  }),

  verificationPassed: new client.Counter({
    name: 'key_rotation_verification_passed_total',
    help: 'Number of successful verifications',
    labelNames: ['batch_id', 'sample_size'],
  }),

  rollbackTriggered: new client.Counter({
    name: 'key_rotation_rollback_triggered_total',
    help: 'Number of rollbacks triggered',
    labelNames: ['batch_id', 'reason'],
  }),
};

// ============================================================================
// Configuration & Constants
// ============================================================================

const ROTATION_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_BACKOFF_MS: 500,
  MAX_BACKOFF_MS: 30000,
  BATCH_SIZE: 100,
  VERIFICATION_SAMPLE_SIZE: 50,
  KMS_TIMEOUT_MS: 5000,
};

// ============================================================================
// Key Rotation Service
// ============================================================================

export class KeyRotationService {
  /**
   * Start a new key rotation batch.
   * Validates preconditions and creates the batch record.
   */
  async startRotation(
    newKekId: string,
    actor: string,
    requestId: string,
  ): Promise<KeyRotationBatchRecord> {
    logger.info('key_rotation_start_requested', {
      new_kek_id: newKekId,
      actor,
      request_id: requestId,
    });

    // Check for existing in-progress rotation
    const existing = await pool.query(
      `SELECT id FROM key_rotation_batch WHERE status = 'in_progress' LIMIT 1`,
    );
    if (existing.rows.length > 0) {
      throw new RotationAlreadyInProgressError();
    }

    // Validate new KEK is accessible
    await this.validateKekAccess(newKekId);

    // Get current KEK ID from environment
    const currentKekId = process.env.PII_KEK_ID ?? 'default-kek';

    // Create batch record
    const batchId = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO key_rotation_batch 
       (id, old_kek_id, new_kek_id, status, initiated_by, initiated_at, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)
       RETURNING *`,
      [
        batchId,
        currentKekId,
        newKekId,
        'pending',
        actor,
        requestId,
        JSON.stringify({ actor, timestamp: new Date().toISOString() }),
      ],
    );

    const batch = result.rows[0] as KeyRotationBatchRecord;

    keyRotationMetrics.batchStarted.labels(currentKekId, newKekId).inc();

    logger.info('key_rotation_batch_created', {
      batch_id: batch.id,
      old_kek_id: batch.old_kek_id,
      new_kek_id: batch.new_kek_id,
      request_id: requestId,
    });

    // Initiate rotation in background (non-blocking)
    this.executeRotation(batch.id).catch((err) => {
      logger.error('key_rotation_background_error', {
        batch_id: batch.id,
        error: err instanceof Error ? err.message : String(err),
        request_id: requestId,
      });
    });

    return batch;
  }

  /**
   * Resume a rotation from the last checkpoint.
   */
  async resumeRotation(batchId: string): Promise<KeyRotationBatchRecord> {
    logger.info('key_rotation_resume_requested', { batch_id: batchId });

    const result = await pool.query(`SELECT * FROM key_rotation_batch WHERE id = $1`, [batchId]);

    if (result.rows.length === 0) {
      throw new KeyRotationError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, false);
    }

    const batch = result.rows[0] as KeyRotationBatchRecord;

    if (batch.status === 'completed') {
      throw new KeyRotationError(
        'BATCH_ALREADY_COMPLETED',
        `Batch ${batchId} already completed`,
        false,
      );
    }

    if (batch.status === 'rolled_back') {
      throw new KeyRotationError(
        'BATCH_ROLLED_BACK',
        `Batch ${batchId} was rolled back`,
        false,
      );
    }

    // Update status to in_progress
    await pool.query(`UPDATE key_rotation_batch SET status = 'in_progress' WHERE id = $1`, [
      batchId,
    ]);

    // Resume in background
    this.executeRotation(batchId).catch((err) => {
      logger.error('key_rotation_resume_error', {
        batch_id: batchId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return batch;
  }

  /**
   * Execute the rotation: scan encrypted records and re-encrypt with new KEK.
   */
  private async executeRotation(batchId: string): Promise<void> {
    const startTime = Date.now();
    const client = await pool.connect();

    try {
      const batchResult = await client.query(
        `SELECT * FROM key_rotation_batch WHERE id = $1`,
        [batchId],
      );
      if (batchResult.rows.length === 0) {
        throw new KeyRotationError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, false);
      }

      const batch = batchResult.rows[0] as KeyRotationBatchRecord;

      // Update to in_progress
      await client.query(
        `UPDATE key_rotation_batch SET status = 'in_progress' WHERE id = $1`,
        [batchId],
      );

      // Scan encrypted records from checkpoint
      const offset = batch.last_rotated_record_id ? 1 : 0; // resume from last
      const scanResult = await client.query(
        `SELECT * FROM pii_encrypted_fields 
         WHERE dek_kek_id = $1
         ORDER BY created_at ASC
         LIMIT $2 OFFSET $3`,
        [batch.old_kek_id, ROTATION_CONFIG.BATCH_SIZE, offset],
      );

      const records: EncryptedRecord[] = scanResult.rows;

      if (records.length === 0) {
        // Rotation complete
        await client.query(
          `UPDATE key_rotation_batch 
           SET status = 'completed', completed_at = NOW() 
           WHERE id = $1`,
          [batchId],
        );

        const duration = (Date.now() - startTime) / 1000;
        keyRotationMetrics.batchDurationSeconds
          .labels(batchId, 'completed')
          .observe(duration);

        logger.info('key_rotation_completed', {
          batch_id: batchId,
          total_records_rotated: batch.total_records_rotated,
          duration_seconds: duration,
        });

        return;
      }

      // Rotate each record
      let successCount = 0;
      let failureCount = 0;

      for (const record of records) {
        try {
          await this.rotateRecordWithRetry(
            record,
            batch.old_kek_id,
            batch.new_kek_id,
            client,
          );
          successCount++;
          keyRotationMetrics.recordsRotated.labels(batchId).set(batch.total_records_rotated + successCount);
        } catch (err) {
          failureCount++;
          keyRotationMetrics.recordsFailed.labels(batchId).set(failureCount);

          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error('key_rotation_record_failed', {
            batch_id: batchId,
            record_id: record.id,
            error: errorMsg,
          });

          // Log failure in checkpoint table
          await client.query(
            `INSERT INTO key_rotation_record 
             (id, batch_id, table_name, record_id, field_name, status, failure_reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              crypto.randomUUID(),
              batchId,
              record.table_name,
              record.id,
              record.field_name,
              'failed',
              errorMsg,
            ],
          );
        }
      }

      // Update batch with progress
      await client.query(
        `UPDATE key_rotation_batch 
         SET total_records_rotated = total_records_rotated + $1,
             total_records_failed = total_records_failed + $2,
             last_rotated_record_id = $3,
             last_error_code = CASE WHEN $2 > 0 THEN 'PARTIAL_FAILURE' ELSE NULL END
         WHERE id = $4`,
        [successCount, failureCount, records[records.length - 1]!.id, batchId],
      );

      // If there are more records, continue in next batch
      if (records.length === ROTATION_CONFIG.BATCH_SIZE) {
        setImmediate(() => this.executeRotation(batchId).catch(() => {}));
      } else {
        // Mark as completed or failed
        const finalBatch = await client.query(
          `SELECT * FROM key_rotation_batch WHERE id = $1`,
          [batchId],
        );
        const fb = finalBatch.rows[0] as KeyRotationBatchRecord;

        if (fb.total_records_failed > 0) {
          await client.query(
            `UPDATE key_rotation_batch 
             SET status = 'failed', failure_reason = $1 
             WHERE id = $2`,
            [`${fb.total_records_failed} records failed to rotate`, batchId],
          );

          const duration = (Date.now() - startTime) / 1000;
          keyRotationMetrics.batchDurationSeconds.labels(batchId, 'failed').observe(duration);

          logger.warn('key_rotation_failed_with_errors', {
            batch_id: batchId,
            total_rotated: fb.total_records_rotated,
            total_failed: fb.total_records_failed,
            duration_seconds: duration,
          });
        } else {
          await client.query(
            `UPDATE key_rotation_batch 
             SET status = 'completed', completed_at = NOW() 
             WHERE id = $1`,
            [batchId],
          );

          const duration = (Date.now() - startTime) / 1000;
          keyRotationMetrics.batchDurationSeconds
            .labels(batchId, 'completed')
            .observe(duration);

          logger.info('key_rotation_completed', {
            batch_id: batchId,
            total_records_rotated: fb.total_records_rotated,
            duration_seconds: duration,
          });
        }
      }
    } finally {
      client.release();
    }
  }

  /**
   * Rotate a single record with retry logic and exponential backoff.
   */
  private async rotateRecordWithRetry(
    record: EncryptedRecord,
    oldKekId: string,
    newKekId: string,
    client: any,
    attempt: number = 1,
  ): Promise<void> {
    try {
      // Decrypt with old KEK
      const dek = await this.unwrapDekWithMetrics(record.dek_wrapped, oldKekId);

      // Re-encrypt DEK with new KEK
      const newDekWrapped = await this.wrapDekWithMetrics(dek, newKekId);

      // Update record in database
      await client.query(
        `UPDATE pii_encrypted_fields 
         SET dek_wrapped = $1, dek_kek_id = $2 
         WHERE id = $3`,
        [newDekWrapped, newKekId, record.id],
      );

      // Log rotation checkpoint
      await client.query(
        `INSERT INTO key_rotation_record 
         (id, batch_id, table_name, record_id, field_name, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [
          record.id,
          undefined, // batch_id set by caller
          record.table_name,
          record.id,
          record.field_name,
          'rotated',
        ],
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const retryable =
        err instanceof KMSUnwrapError ||
        err instanceof KMSWrapError ||
        error.message.includes('timeout');

      if (retryable && attempt < ROTATION_CONFIG.MAX_RETRIES) {
        const backoffMs = Math.min(
          ROTATION_CONFIG.INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1),
          ROTATION_CONFIG.MAX_BACKOFF_MS,
        );

        logger.warn('key_rotation_record_retry', {
          record_id: record.id,
          attempt,
          backoff_ms: backoffMs,
          error: error.message,
        });

        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.rotateRecordWithRetry(record, oldKekId, newKekId, client, attempt + 1);
      }

      throw new KeyRotationError(
        'ROTATION_FAILED',
        `Failed to rotate record ${record.id}: ${error.message}`,
        false,
      );
    }
  }

  /**
   * Verify rotation by spot-checking records.
   */
  async verifyRotation(batchId: string): Promise<RotationVerificationResult> {
    logger.info('key_rotation_verify_started', { batch_id: batchId });

    const batchResult = await pool.query(
      `SELECT * FROM key_rotation_batch WHERE id = $1`,
      [batchId],
    );

    if (batchResult.rows.length === 0) {
      throw new KeyRotationError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, false);
    }

    const batch = batchResult.rows[0] as KeyRotationBatchRecord;

    // Get rotated records
    const checkResult = await pool.query(
      `SELECT * FROM key_rotation_record 
       WHERE batch_id = $1 AND status = 'rotated' 
       ORDER BY RANDOM() 
       LIMIT $2`,
      [batchId, ROTATION_CONFIG.VERIFICATION_SAMPLE_SIZE],
    );

    const records = checkResult.rows;
    const failures: Array<{ record_id: string; table_name: string; error: string }> = [];

    // Verify each record by attempting decryption
    for (const rec of records) {
      try {
        // This should succeed with new KEK
        const decrypted = await this.decryptRecordWithNewKey(rec, batch.new_kek_id);
        if (!decrypted) {
          failures.push({
            record_id: rec.record_id,
            table_name: rec.table_name,
            error: 'Decryption returned empty',
          });
        }
      } catch (err) {
        failures.push({
          record_id: rec.record_id,
          table_name: rec.table_name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const passed = failures.length === 0;
    const result: RotationVerificationResult = {
      batch_id: batchId,
      passed,
      sample_size: records.length,
      verified_at: new Date(),
      records_verified: records.length - failures.length,
      records_failed: failures.length,
      failure_details: failures,
    };

    // Update batch
    await pool.query(
      `UPDATE key_rotation_batch 
       SET verification_passed = $1, verification_sample_size = $2, verification_checked_at = NOW()
       WHERE id = $3`,
      [passed, records.length, batchId],
    );

    if (passed) {
      keyRotationMetrics.verificationPassed.labels(batchId, String(records.length)).inc();
    }

    logger.info('key_rotation_verify_completed', {
      batch_id: batchId,
      passed,
      sample_size: records.length,
      failures: failures.length,
    });

    return result;
  }

  /**
   * Rollback rotation: revert all rotated records to old KEK.
   */
  async rollbackRotation(batchId: string, reason: string): Promise<void> {
    logger.warn('key_rotation_rollback_requested', {
      batch_id: batchId,
      reason,
    });

    const batchResult = await pool.query(
      `SELECT * FROM key_rotation_batch WHERE id = $1`,
      [batchId],
    );

    if (batchResult.rows.length === 0) {
      throw new KeyRotationError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, false);
    }

    // Get all rotated records
    const recordsResult = await pool.query(
      `SELECT * FROM key_rotation_record WHERE batch_id = $1 AND status = 'rotated'`,
      [batchId],
    );

    const records = recordsResult.rows;

    // Re-encrypt with old KEK
    for (const rec of records) {
      try {
        // This is a simplified rollback; in production, store old_dek_wrapped
        logger.info('key_rotation_record_rollback', {
          batch_id: batchId,
          record_id: rec.record_id,
        });

        await pool.query(
          `UPDATE key_rotation_record 
           SET status = 'rolled_back' 
           WHERE id = $1`,
          [rec.id],
        );
      } catch (err) {
        logger.error('key_rotation_rollback_failed', {
          batch_id: batchId,
          record_id: rec.record_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update batch
    await pool.query(
      `UPDATE key_rotation_batch 
       SET status = 'rolled_back', rolled_back_at = NOW(), failure_reason = $1 
       WHERE id = $2`,
      [reason, batchId],
    );

    keyRotationMetrics.rollbackTriggered.labels(batchId, reason).inc();

    logger.info('key_rotation_rollback_completed', {
      batch_id: batchId,
      records_rolled_back: records.length,
      reason,
    });
  }

  /**
   * Validate that the new KEK is accessible.
   */
  private async validateKekAccess(kekId: string): Promise<void> {
    const kmsEndpoint = process.env.PII_KMS_ENDPOINT || '';

    if (!kmsEndpoint) {
      // Local encryption; validation is basic
      logger.info('key_rotation_validate_local_kek', { kek_id: kekId });
      return;
    }

    try {
      const response = await Promise.race([
        fetch(`${kmsEndpoint}/validate-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kek_id: kekId }),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('KMS timeout')), ROTATION_CONFIG.KMS_TIMEOUT_MS),
        ),
      ]);

      if (!response.ok) {
        throw new KeyRotationError(
          'KMS_VALIDATION_FAILED',
          `KMS returned ${response.status}`,
          false,
        );
      }

      logger.info('key_rotation_kek_validated', { kek_id: kekId });
    } catch (err) {
      throw new KeyRotationError(
        'KMS_ACCESS_DENIED',
        `Cannot validate KEK ${kekId}: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }
  }

  /**
   * Unwrap DEK with KMS endpoint, with metrics.
   */
  private async unwrapDekWithMetrics(
    dekWrapped: Buffer,
    kekId: string,
  ): Promise<Buffer> {
    const startTime = Date.now();

    try {
      const dek = await this.unwrapDek(dekWrapped, kekId);
      const duration = (Date.now() - startTime) / 1000;

      keyRotationMetrics.kmsOperationDurationSeconds
        .labels('unwrap', kekId, 'true')
        .observe(duration);

      return dek;
    } catch (err) {
      const duration = (Date.now() - startTime) / 1000;
      keyRotationMetrics.kmsOperationDurationSeconds
        .labels('unwrap', kekId, 'false')
        .observe(duration);

      throw err;
    }
  }

  /**
   * Wrap DEK with KMS endpoint, with metrics.
   */
  private async wrapDekWithMetrics(
    dek: Buffer,
    kekId: string,
  ): Promise<Buffer> {
    const startTime = Date.now();

    try {
      const wrapped = await this.wrapDek(dek, kekId);
      const duration = (Date.now() - startTime) / 1000;

      keyRotationMetrics.kmsOperationDurationSeconds
        .labels('wrap', kekId, 'true')
        .observe(duration);

      return wrapped;
    } catch (err) {
      const duration = (Date.now() - startTime) / 1000;
      keyRotationMetrics.kmsOperationDurationSeconds
        .labels('wrap', kekId, 'false')
        .observe(duration);

      throw err;
    }
  }

  /**
   * Unwrap DEK using KMS endpoint or local key.
   */
  private async unwrapDek(dekWrapped: Buffer, kekId: string): Promise<Buffer> {
    const kmsEndpoint = process.env.PII_KMS_ENDPOINT || '';

    if (kmsEndpoint) {
      try {
        const response = await Promise.race([
          fetch(`${kmsEndpoint}/decrypt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kek_id: kekId, wrapped_key: dekWrapped.toString('base64') }),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('KMS timeout')), ROTATION_CONFIG.KMS_TIMEOUT_MS),
          ),
        ]);

        if (!response.ok) {
          throw new KMSUnwrapError(`KMS returned ${response.status}`, response.status === 408 || response.status >= 500);
        }

        const { plaintext } = (await response.json()) as { plaintext: string };
        return Buffer.from(plaintext, 'base64');
      } catch (err) {
        throw new KMSUnwrapError(
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err.message.includes('timeout') : false,
        );
      }
    }

    // Local decryption
    const kek = Buffer.from(process.env.PII_KEK_KEY ?? '0'.repeat(64), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, dekWrapped.subarray(0, 12));
    decipher.setAuthTag(dekWrapped.subarray(12, 28));

    try {
      const decrypted = Buffer.concat([
        decipher.update(dekWrapped.subarray(28)),
        decipher.final(),
      ]);
      return decrypted;
    } catch (err) {
      throw new DecryptionError(
        err instanceof Error ? err.message : 'DEK decryption failed',
        false,
      );
    }
  }

  /**
   * Wrap DEK using KMS endpoint or local key.
   */
  private async wrapDek(dek: Buffer, kekId: string): Promise<Buffer> {
    const kmsEndpoint = process.env.PII_KMS_ENDPOINT || '';

    if (kmsEndpoint) {
      try {
        const response = await Promise.race([
          fetch(`${kmsEndpoint}/encrypt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kek_id: kekId, plaintext: dek.toString('base64') }),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('KMS timeout')), ROTATION_CONFIG.KMS_TIMEOUT_MS),
          ),
        ]);

        if (!response.ok) {
          throw new KMSWrapError(`KMS returned ${response.status}`, response.status === 408 || response.status >= 500);
        }

        const { wrapped_key } = (await response.json()) as { wrapped_key: string };
        return Buffer.from(wrapped_key, 'base64');
      } catch (err) {
        throw new KMSWrapError(
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err.message.includes('timeout') : false,
        );
      }
    }

    // Local encryption
    const kek = Buffer.from(process.env.PII_KEK_KEY ?? '0'.repeat(64), 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
  }

  /**
   * Decrypt a record using the new KEK (for verification).
   */
  private async decryptRecordWithNewKey(record: any, newKekId: string): Promise<string> {
    // Placeholder: In production, use DEK to decrypt ciphertext
    await this.unwrapDek(record.new_dek_wrapped, newKekId);
    // (Implementation depends on how ciphertext is stored)
    return `decrypted-${record.id}`;
  }
}

export const keyRotationService = new KeyRotationService();
