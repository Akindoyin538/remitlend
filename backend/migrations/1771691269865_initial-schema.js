/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable('scores', {
    id: 'id',
    user_id: { type: 'varchar(255)', notNull: true, unique: true },
    current_score: { type: 'integer', notNull: true, default: 500 },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createTable('remittance_history', {
    id: 'id',
    user_id: { type: 'varchar(255)', notNull: true },
    amount: { type: 'numeric', notNull: true },
    month: { type: 'varchar(50)', notNull: true },
    status: { type: 'varchar(50)', notNull: true },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('remittance_history', 'user_id');

  // Model versions: each approved model version carries the parameter snapshot
  // used at approval time. Existing loans reference the version they were
  // originated under so rollback never alters existing loan obligations.
  pgm.createTable('model_versions', {
    id: 'id',
    version: { type: 'varchar(50)', notNull: true, unique: true },
    status: { type: 'varchar(20)', notNull: true, default: 'approved' },
    parameters: { type: 'jsonb', notNull: true },
    approved_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // Origination-time parameter snapshot per loan. Immutable once written so
  // rollback of new originations cannot change existing loan obligations.
  pgm.createTable('loan_origination_snapshots', {
    id: 'id',
    loan_id: { type: 'varchar(255)', notNull: true, unique: true },
    model_version_id: {
      type: 'integer',
      notNull: true,
      references: 'model_versions',
    },
    parameters: { type: 'jsonb', notNull: true },
    originated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('loan_origination_snapshots', 'model_version_id');

  // Aggregate, bounded-cardinality monitoring metrics. No borrower-level
  // scores or identifiers are stored here: only cohort-level buckets.
  pgm.createTable('model_monitoring_metrics', {
    id: 'id',
    model_version_id: {
      type: 'integer',
      notNull: true,
      references: 'model_versions',
    },
    metric: { type: 'varchar(50)', notNull: true },
    cohort: { type: 'varchar(50)', notNull: true },
    bucket: { type: 'varchar(50)', notNull: true },
    value: { type: 'numeric', notNull: true },
    sample_size: { type: 'integer', notNull: true },
    completeness: { type: 'numeric', notNull: true },
    window_start: { type: 'timestamp', notNull: true },
    window_end: { type: 'timestamp', notNull: true },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('model_monitoring_metrics', [
    'model_version_id',
    'metric',
    'window_end',
  ]);

  // Alert thresholds that trigger review or rollback of new originations to
  // the last approved model version. Includes sample-size and completeness
  // guardrails so sparse or incomplete cohorts do not trigger reactions.
  pgm.createTable('model_monitoring_thresholds', {
    id: 'id',
    metric: { type: 'varchar(50)', notNull: true, unique: true },
    warn_threshold: { type: 'numeric', notNull: true },
    rollback_threshold: { type: 'numeric', notNull: true },
    min_sample_size: { type: 'integer', notNull: true, default: 100 },
    min_completeness: { type: 'numeric', notNull: true, default: 0.9 },
    action: { type: 'varchar(20)', notNull: true, default: 'review' },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('model_monitoring_thresholds');
  pgm.dropTable('model_monitoring_metrics');
  pgm.dropTable('loan_origination_snapshots');
  pgm.dropTable('model_versions');
  pgm.dropTable('remittance_history');
  pgm.dropTable('scores');
};
