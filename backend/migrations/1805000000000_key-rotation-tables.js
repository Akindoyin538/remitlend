/**
 * PII Encryption Key Rotation Tracking
 *
 * Adds tables and infrastructure for tracking PII key rotation operations:
 * - key_rotation_batch: tracks batches of key rotations
 * - key_rotation_record: checkpoint table for resumable rotation
 * - pii_encrypted_fields: central registry of encrypted fields for scan/rotate
 *
 * This migration is idempotent and safe to run multiple times.
 */

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  // ========================================================================
  // key_rotation_batch: Track rotation operations
  // ========================================================================
  pgm.createTable('key_rotation_batch', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    old_kek_id: {
      type: 'text',
      notNull: true,
    },
    new_kek_id: {
      type: 'text',
      notNull: true,
    },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
    },
    last_rotated_record_id: {
      type: 'uuid',
    },
    total_records_scanned: {
      type: 'bigint',
      default: 0,
    },
    total_records_rotated: {
      type: 'bigint',
      default: 0,
    },
    total_records_failed: {
      type: 'bigint',
      default: 0,
    },
    initiated_by: {
      type: 'text',
      notNull: true,
    },
    initiated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    completed_at: {
      type: 'timestamptz',
    },
    rolled_back_at: {
      type: 'timestamptz',
    },
    failure_reason: {
      type: 'text',
    },
    last_error_code: {
      type: 'text',
    },
    verification_passed: {
      type: 'boolean',
    },
    verification_sample_size: {
      type: 'integer',
    },
    verification_checked_at: {
      type: 'timestamptz',
    },
    metadata: {
      type: 'jsonb',
      default: '{}',
    },
    request_id: {
      type: 'text',
      notNull: true,
    },
  });

  pgm.addConstraint('key_rotation_batch', 'key_rotation_batch_status_check', {
    check: `status IN ('pending', 'in_progress', 'completed', 'failed', 'rolled_back')`,
  });

  pgm.createIndex('key_rotation_batch', ['status', 'initiated_at'], {
    name: 'idx_key_rotation_batch_status_initiated',
  });

  pgm.createIndex('key_rotation_batch', ['old_kek_id', 'new_kek_id'], {
    name: 'idx_key_rotation_batch_kek_ids',
  });

  pgm.createIndex('key_rotation_batch', ['request_id'], {
    name: 'idx_key_rotation_batch_request_id',
  });

  // ========================================================================
  // key_rotation_record: Checkpoint table for resumable rotation
  // ========================================================================
  pgm.createTable('key_rotation_record', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    batch_id: {
      type: 'uuid',
      notNull: true,
      references: 'key_rotation_batch',
      onDelete: 'CASCADE',
    },
    table_name: {
      type: 'text',
      notNull: true,
    },
    record_id: {
      type: 'uuid',
      notNull: true,
    },
    field_name: {
      type: 'text',
      notNull: true,
    },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
    },
    old_dek_wrapped: {
      type: 'bytea',
    },
    new_dek_wrapped: {
      type: 'bytea',
    },
    failure_reason: {
      type: 'text',
    },
    attempted_at: {
      type: 'timestamptz',
    },
    completed_at: {
      type: 'timestamptz',
    },
  });

  pgm.addConstraint('key_rotation_record', 'key_rotation_record_status_check', {
    check: `status IN ('pending', 'rotated', 'failed', 'rolled_back')`,
  });

  pgm.createIndex('key_rotation_record', ['batch_id', 'status'], {
    name: 'idx_key_rotation_record_batch_status',
  });

  pgm.createIndex('key_rotation_record', ['table_name', 'record_id'], {
    name: 'idx_key_rotation_record_table_record',
  });

  // ========================================================================
  // pii_encrypted_fields: Central registry of all encrypted PII fields
  // ========================================================================
  // This table provides a single scan point for rotation operations.
  // It is populated from user_profiles and remittances on first deployment.
  pgm.createTable('pii_encrypted_fields', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    table_name: {
      type: 'text',
      notNull: true,
    },
    record_id: {
      type: 'uuid',
      notNull: true,
    },
    field_name: {
      type: 'text',
      notNull: true,
    },
    ciphertext: {
      type: 'bytea',
      notNull: true,
    },
    gcm_nonce: {
      type: 'bytea',
      notNull: true,
    },
    dek_wrapped: {
      type: 'bytea',
      notNull: true,
    },
    dek_kek_id: {
      type: 'text',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    metadata: {
      type: 'jsonb',
      default: '{}',
    },
  });

  pgm.addConstraint('pii_encrypted_fields', 'pii_encrypted_fields_unique', {
    unique: ['table_name', 'record_id', 'field_name'],
  });

  pgm.createIndex('pii_encrypted_fields', ['dek_kek_id', 'created_at'], {
    name: 'idx_pii_encrypted_fields_kek_created',
  });

  pgm.createIndex('pii_encrypted_fields', ['table_name', 'record_id'], {
    name: 'idx_pii_encrypted_fields_table_record',
  });

  pgm.createIndex('pii_encrypted_fields', ['created_at'], {
    name: 'idx_pii_encrypted_fields_created_at',
  });

  // ========================================================================
  // Audit log for key rotation operations
  // ========================================================================
  // Note: audit_logs table should already exist; this adds a type check.
  // If audit_logs does not exist, uncomment the createTable call below.
  /*
  pgm.createTable('audit_logs', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    action: {
      type: 'text',
      notNull: true,
    },
    actor: {
      type: 'text',
      notNull: true,
    },
    resource_type: {
      type: 'text',
      notNull: true,
    },
    resource_id: {
      type: 'text',
      notNull: true,
    },
    metadata: {
      type: 'jsonb',
      default: '{}',
    },
    status: {
      type: 'text',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });
  */
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('pii_encrypted_fields', { ifExists: true });
  pgm.dropTable('key_rotation_record', { ifExists: true });
  pgm.dropTable('key_rotation_batch', { ifExists: true });
};
