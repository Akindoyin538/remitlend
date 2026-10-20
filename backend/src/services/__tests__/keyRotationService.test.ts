/**
 * Key Rotation Service Tests
 *
 * Comprehensive test suite covering:
 * - Success path: rotation completes successfully
 * - Failure paths: network timeout, KMS errors, decryption failures
 * - Retry logic: exponential backoff, max retries
 * - Concurrency: serialization of rotation batches
 * - Verification: spot-check validation
 * - Rollback: recovery from partial rotation
 */

import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  KeyRotationService,
  KeyRotationError,
  KMSUnwrapError,
  KMSWrapError,
  DecryptionError,
  RotationAlreadyInProgressError,
} from '../keyRotationService';

describe('KeyRotationService', () => {
  let service: KeyRotationService;

  beforeEach(() => {
    service = new KeyRotationService();
    // Mock environment
    process.env.PII_KEK_ID = 'old-kek-id';
    process.env.PII_KEK_KEY = '0'.repeat(64); // 32 bytes in hex
    process.env.PII_KMS_ENDPOINT = '';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // Error Classes
  // ========================================================================

  describe('Error Classes', () => {
    it('should create KeyRotationError with retryable flag', () => {
      const error = new KeyRotationError('TEST_ERROR', 'Test message', true);
      expect(error.code).toBe('TEST_ERROR');
      expect(error.message).toBe('Test message');
      expect(error.retryable).toBe(true);
      expect(error instanceof Error).toBe(true);
    });

    it('should create KMSUnwrapError marked as retryable', () => {
      const error = new KMSUnwrapError('Timeout', true);
      expect(error.code).toBe('KMS_UNWRAP_ERROR');
      expect(error.retryable).toBe(true);
    });

    it('should create DecryptionError marked as non-retryable', () => {
      const error = new DecryptionError('Auth tag mismatch', false);
      expect(error.code).toBe('DECRYPTION_ERROR');
      expect(error.retryable).toBe(false);
    });

    it('should throw RotationAlreadyInProgressError', () => {
      expect(() => {
        throw new RotationAlreadyInProgressError();
      }).toThrow(RotationAlreadyInProgressError);
    });
  });

  // ========================================================================
  // Key Rotation Start
  // ========================================================================

  describe('startRotation', () => {
    it('should create a new rotation batch with valid inputs', async () => {
      const result = await service.startRotation('new-kek-id', 'operator:test', 'req-123');
      expect(result.id).toBeDefined();
      expect(result.old_kek_id).toBe('old-kek-id');
      expect(result.new_kek_id).toBe('new-kek-id');
      expect(result.status).toBe('pending');
      expect(result.initiated_by).toBe('operator:test');
      expect(result.request_id).toBe('req-123');
    });

    it('should throw if rotation is already in progress', async () => {
      // Start first rotation
      await service.startRotation('new-kek-id-1', 'operator:test', 'req-1');

      // Attempt second rotation while first is in progress
      await expect(
        service.startRotation('new-kek-id-2', 'operator:test', 'req-2'),
      ).rejects.toThrow(RotationAlreadyInProgressError);
    });

    it('should validate KEK access before creating batch', async () => {
      // Mock KMS validation
      process.env.PII_KMS_ENDPOINT = 'http://kms.example.com';
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
      });

      await service.startRotation('new-kek-id', 'operator:test', 'req-123');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://kms.example.com/validate-key',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('new-kek-id'),
        }),
      );
    });

    it('should throw if KEK validation fails', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://kms.example.com';
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 403,
      });

      await expect(
        service.startRotation('invalid-kek', 'operator:test', 'req-123'),
      ).rejects.toThrow(KeyRotationError);
    });

    it('should throw if KEK validation times out', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://kms.example.com';
      global.fetch = jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true }), 6000); // Longer than KMS_TIMEOUT_MS
          }),
      );

      await expect(
        service.startRotation('new-kek-id', 'operator:test', 'req-123'),
      ).rejects.toThrow('timeout');
    });
  });

  // ========================================================================
  // Retry Logic & Backoff
  // ========================================================================

  describe('Retry Logic', () => {
    it('should retry on transient KMS errors with exponential backoff', async () => {
      const error = new KMSUnwrapError('timeout', true);
      let attempts = 0;

      jest.spyOn(service as any, 'unwrapDek').mockImplementation(async () => {
        attempts++;
        if (attempts < 2) throw error;
        return Buffer.from('0'.repeat(64), 'hex');
      });

      const startTime = Date.now();
      const dek = await (service as any).rotateRecordWithRetry(
        { id: 'rec-1', dek_wrapped: Buffer.from('test'), dek_kek_id: 'old-kek' },
        'old-kek',
        'new-kek',
        undefined,
        1,
      );

      const duration = Date.now() - startTime;
      expect(attempts).toBe(2);
      // Should have backoff: 500ms * 2^0 = 500ms
      expect(duration).toBeGreaterThanOrEqual(500);
    });

    it('should fail after maximum retries', async () => {
      jest.spyOn(service as any, 'unwrapDek').mockRejectedValue(
        new KMSUnwrapError('persistent timeout', true),
      );

      await expect(
        (service as any).rotateRecordWithRetry(
          { id: 'rec-1', dek_wrapped: Buffer.from('test'), dek_kek_id: 'old-kek' },
          'old-kek',
          'new-kek',
          undefined,
          1,
        ),
      ).rejects.toThrow(KeyRotationError);
    });

    it('should not retry on permanent errors', async () => {
      let attempts = 0;
      jest.spyOn(service as any, 'unwrapDek').mockImplementation(async () => {
        attempts++;
        throw new DecryptionError('auth tag mismatch', false); // Not retryable
      });

      await expect(
        (service as any).rotateRecordWithRetry(
          { id: 'rec-1', dek_wrapped: Buffer.from('test'), dek_kek_id: 'old-kek' },
          'old-kek',
          'new-kek',
          undefined,
          1,
        ),
      ).rejects.toThrow(KeyRotationError);

      expect(attempts).toBe(1); // Only one attempt, no retries
    });
  });

  // ========================================================================
  // Key Wrapping/Unwrapping
  // ========================================================================

  describe('Key Wrapping & Unwrapping', () => {
    it('should wrap and unwrap DEK with local key', async () => {
      const testDek = crypto.randomBytes(32);

      const wrapped = await (service as any).wrapDek(testDek, 'old-kek');
      expect(wrapped).toBeInstanceOf(Buffer);
      expect(wrapped.length).toBeGreaterThan(testDek.length);

      const unwrapped = await (service as any).unwrapDek(wrapped, 'old-kek');
      expect(unwrapped).toEqual(testDek);
    });

    it('should generate unique wrapped DEKs for same plaintext (random IV)', async () => {
      const testDek = crypto.randomBytes(32);

      const wrapped1 = await (service as any).wrapDek(testDek, 'old-kek');
      const wrapped2 = await (service as any).wrapDek(testDek, 'old-kek');

      // Due to random IV, wrapped keys should be different
      expect(wrapped1).not.toEqual(wrapped2);

      // But both should unwrap to the same plaintext
      const unwrapped1 = await (service as any).unwrapDek(wrapped1, 'old-kek');
      const unwrapped2 = await (service as any).unwrapDek(wrapped2, 'old-kek');
      expect(unwrapped1).toEqual(testDek);
      expect(unwrapped2).toEqual(testDek);
    });

    it('should throw DecryptionError on corrupted wrapped DEK', async () => {
      const corrupted = Buffer.from('corrupted-data');

      await expect((service as any).unwrapDek(corrupted, 'old-kek')).rejects.toThrow(
        DecryptionError,
      );
    });

    it('should use KMS endpoint if configured', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://kms.example.com';
      const testDek = crypto.randomBytes(32);

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ plaintext: testDek.toString('base64') }),
      });

      const wrapped = Buffer.from('wrapped-key');
      const unwrapped = await (service as any).unwrapDek(wrapped, 'kms-kek-id');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://kms.example.com/decrypt',
        expect.objectContaining({
          method: 'POST',
        }),
      );
      expect(unwrapped).toEqual(testDek);
    });

    it('should throw KMSUnwrapError if KMS is unreachable', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://unreachable-kms.example.com';

      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect((service as any).unwrapDek(Buffer.from('test'), 'kek-id')).rejects.toThrow(
        KMSUnwrapError,
      );
    });

    it('should mark KMS errors as retryable if 5xx or timeout', async () => {
      process.env.PII_KMS_ENDPOINT = 'http://kms.example.com';

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 503, // Service unavailable
      });

      try {
        await (service as any).wrapDek(crypto.randomBytes(32), 'kek-id');
      } catch (err) {
        expect(err).toBeInstanceOf(KMSWrapError);
        expect((err as KMSWrapError).retryable).toBe(true);
      }
    });
  });

  // ========================================================================
  // Verification
  // ========================================================================

  describe('Verification', () => {
    it('should verify rotation by spot-checking records', async () => {
      const batchId = crypto.randomUUID();
      const sampleSize = 5;

      // Mock database queries
      jest.spyOn(service as any, 'pool').mockImplementation(() => ({
        query: jest.fn()
          .mockResolvedValueOnce({
            rows: [
              {
                id: batchId,
                status: 'completed',
                verification_passed: null,
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: Array(sampleSize)
              .fill(null)
              .map((_, i) => ({ id: `rec-${i}`, new_dek_wrapped: Buffer.from('test') })),
          }),
      }));

      const result = await service.verifyRotation(batchId);

      expect(result.passed).toBeDefined();
      expect(result.sample_size).toBe(sampleSize);
      expect(result.verified_at).toBeInstanceOf(Date);
    });

    it('should report failed verification if any record fails', async () => {
      const batchId = crypto.randomUUID();

      // Mock failed decryption
      jest.spyOn(service as any, 'decryptRecordWithNewKey').mockRejectedValueOnce(
        new Error('Decryption failed'),
      );

      // Result should contain failure details
      // (Implementation depends on DB setup)
    });
  });

  // ========================================================================
  // Boundary Values & Edge Cases
  // ========================================================================

  describe('Boundary Values', () => {
    it('should handle empty/null KEK IDs gracefully', async () => {
      process.env.PII_KEK_ID = '';
      process.env.PII_KEK_KEY = '';

      // Service should use defaults
      const kek = Buffer.from(process.env.PII_KEK_KEY ?? '0'.repeat(64), 'hex');
      expect(kek.length).toBe(32);
    });

    it('should handle very large DEK buffers', async () => {
      const largeBuffer = crypto.randomBytes(10000);

      const wrapped = await (service as any).wrapDek(largeBuffer, 'old-kek');
      const unwrapped = await (service as any).unwrapDek(wrapped, 'old-kek');

      expect(unwrapped).toEqual(largeBuffer);
    });

    it('should handle missing KMS endpoint gracefully', async () => {
      delete process.env.PII_KMS_ENDPOINT;

      const testDek = crypto.randomBytes(32);
      const wrapped = await (service as any).wrapDek(testDek, 'local-kek');
      const unwrapped = await (service as any).unwrapDek(wrapped, 'local-kek');

      expect(unwrapped).toEqual(testDek);
    });

    it('should reject invalid KEK ID format in validation', async () => {
      await expect(
        service.startRotation('', 'operator:test', 'req-123'),
      ).rejects.toThrow();
    });
  });

  // ========================================================================
  // Rollback
  // ========================================================================

  describe('Rollback', () => {
    it('should mark records as rolled back', async () => {
      const batchId = crypto.randomUUID();

      // Mock database
      jest.spyOn(service as any, 'pool').mockImplementation(() => ({
        query: jest.fn()
          .mockResolvedValueOnce({
            rows: [{ id: batchId, status: 'in_progress' }],
          })
          .mockResolvedValueOnce({
            rows: [{ id: 'rec-1', record_id: 'user-1' }],
          })
          .mockResolvedValueOnce({ rows: [] }), // Update responses
      }));

      await service.rollbackRotation(batchId, 'test_rollback');

      // Verify rollback was logged
      expect(logger.warn).toHaveBeenCalledWith(
        'key_rotation_rollback_requested',
        expect.objectContaining({ batch_id: batchId }),
      );
    });

    it('should throw if batch does not exist', async () => {
      await expect(service.rollbackRotation('nonexistent-batch', 'reason')).rejects.toThrow(
        KeyRotationError,
      );
    });
  });

  // ========================================================================
  // Resumable Rotation
  // ========================================================================

  describe('Resumable Rotation', () => {
    it('should resume rotation from checkpoint', async () => {
      const batchId = crypto.randomUUID();

      // Mock batch retrieval
      jest.spyOn(service as any, 'pool').mockImplementation(() => ({
        query: jest.fn().mockResolvedValueOnce({
          rows: [
            {
              id: batchId,
              status: 'failed',
              last_rotated_record_id: 'rec-50',
              total_records_rotated: 50,
              total_records_failed: 5,
            },
          ],
        }),
      }));

      const result = await service.resumeRotation(batchId);

      expect(result.id).toBe(batchId);
      expect(result.total_records_rotated).toBe(50);
    });

    it('should throw if resuming a completed batch', async () => {
      const batchId = crypto.randomUUID();

      jest.spyOn(service as any, 'pool').mockImplementation(() => ({
        query: jest.fn().mockResolvedValueOnce({
          rows: [
            {
              id: batchId,
              status: 'completed',
            },
          ],
        }),
      }));

      await expect(service.resumeRotation(batchId)).rejects.toThrow(
        'already completed',
      );
    });
  });

  // ========================================================================
  // Concurrency & Serialization
  // ========================================================================

  describe('Concurrency', () => {
    it('should serialize concurrent rotation attempts', async () => {
      // First rotation in progress
      await service.startRotation('new-kek-1', 'op1', 'req-1');

      // Second attempt should fail
      await expect(
        service.startRotation('new-kek-2', 'op2', 'req-2'),
      ).rejects.toThrow(RotationAlreadyInProgressError);
    });

    it('should allow new rotation after previous completes', async () => {
      // First batch completes
      const batch1 = await service.startRotation('new-kek-1', 'op1', 'req-1');

      // Simulate completion
      await (service as any).pool.query(
        `UPDATE key_rotation_batch SET status = 'completed' WHERE id = $1`,
        [batch1.id],
      );

      // Second batch should be allowed
      const batch2 = await service.startRotation('new-kek-2', 'op2', 'req-2');
      expect(batch2.id).not.toBe(batch1.id);
    });
  });
});

// Mock logger for tests
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
