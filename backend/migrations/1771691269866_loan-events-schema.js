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
  pgm.createTable('loan_events', {
    id: 'id',
    event_id: { type: 'varchar(255)', notNull: true, unique: true },
    event_type: { type: 'varchar(50)', notNull: true },
    loan_id: { type: 'integer' },
    borrower: { type: 'varchar(255)', notNull: true },
    amount: { type: 'numeric' },
    ledger: { type: 'integer', notNull: true },
    ledger_closed_at: { type: 'timestamp', notNull: true },
    tx_hash: { type: 'varchar(255)', notNull: true },
    contract_id: { type: 'varchar(255)', notNull: true },
    topics: { type: 'jsonb' },
    value: { type: 'text' },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('loan_events', 'event_type');
  pgm.createIndex('loan_events', 'borrower');
  pgm.createIndex('loan_events', 'loan_id');
  pgm.createIndex('loan_events', 'ledger');
  pgm.createIndex('loan_events', 'tx_hash');

  // Table to track indexer state
  pgm.createTable('indexer_state', {
    id: 'id',
    last_indexed_ledger: { type: 'integer', notNull: true, default: 0 },
    last_indexed_cursor: { type: 'varchar(255)' },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // Insert initial state
  pgm.sql(`
    INSERT INTO indexer_state (last_indexed_ledger)
    VALUES (0)
  `);

  // ---------------------------------------------------------------------------
  // Model monitoring: calibration & population drift with rollback thresholds
  // (issue #558). All tables store aggregate, bounded-cardinality indicators
  // only. No borrower identifiers or borrower-level scores are persisted here.
  // ---------------------------------------------------------------------------

  // Registry of model versions. Only one version may be the active version
  // used for new originations at a time. Existing loans keep their own
  // origination-time snapshot (see loan_model_snapshots) and are never
  // rewritten by a rollback.
  pgm.createTable('model_versions', {
    id: 'id',
    version: { type: 'varchar(64)', notNull: true, unique: true },
    status: { type: 'varchar(20)', notNull: true, default: 'candidate' },
    approved_at: { type: 'timestamp' },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });
  pgm.addConstraint('model_versions', 'model_versions_status_check', {
    check: "status IN ('candidate', 'active', 'rolled_back', 'retired')",
  });

  // Immutable origination-time parameter snapshot. One row per loan, written
  // once at origination. Rollback of new originations must not touch these.
  pgm.createTable('loan_model_snapshots', {
    id: 'id',
    loan_id: { type: 'integer', notNull: true, unique: true },
    model_version: { type: 'varchar(64)', notNull: true },
    parameters: { type: 'jsonb', notNull: true },
    originated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });
  pgm.createIndex('loan_model_snapshots', 'model_version');

  // Aggregate calibration/drift indicators per model version and window.
  // Bounded cardinality: cohort is a coarse bucket, never a borrower id.
  pgm.createTable('model_monitoring_metrics', {
    id: 'id',
    model_version: { type: 'varchar(64)', notNull: true },
    window_start: { type: 'timestamp', notNull: true },
    window_end: { type: 'timestamp', notNull: true },
    cohort: { type: 'varchar(64)', notNull: true, default: 'all' },
    sample_size: { type: 'integer', notNull: true, default: 0 },
    expected_sample_size: { type: 'integer', notNull: true, default: 0 },
    data_completeness: { type: 'numeric', notNull: true, default: 0 },
    calibration_error: { type: 'numeric' },
    population_drift: { type: 'numeric' },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });
  pgm.createIndex('model_monitoring_metrics', ['model_version', 'window_end']);
  pgm.createIndex('model_monitoring_metrics', 'cohort');

  // Alert thresholds. min_sample_size and min_data_completeness are the
  // data-quality guardrails that suppress alerts on sparse/incomplete cohorts.
  pgm.createTable('model_monitoring_thresholds', {
    id: 'id',
    model_version: { type: 'varchar(64)', notNull: true, unique: true },
    max_calibration_error: { type: 'numeric', notNull: true, default: 0.1 },
    max_population_drift: { type: 'numeric', notNull: true, default: 0.2 },
    min_sample_size: { type: 'integer', notNull: true, default: 100 },
    min_data_completeness: { type: 'numeric', notNull: true, default: 0.9 },
    rollback_on_breach: { type: 'boolean', notNull: true, default: false },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // Alert log. Records the reason and whether the guardrails were satisfied,
  // so operators can distinguish real breaches from sparse-cohort noise.
  pgm.createTable('model_monitoring_alerts', {
    id: 'id',
    model_version: { type: 'varchar(64)', notNull: true },
    metric_id: { type: 'integer' },
    alert_type: { type: 'varchar(32)', notNull: true },
    severity: { type: 'varchar(16)', notNull: true, default: 'warning' },
    guardrails_passed: { type: 'boolean', notNull: true, default: false },
    details: { type: 'jsonb' },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });
  pgm.addConstraint('model_monitoring_alerts', 'model_monitoring_alerts_type_check', {
    check: "alert_type IN ('calibration', 'population_drift', 'data_quality')",
  });
  pgm.createIndex('model_monitoring_alerts', ['model_version', 'created_at']);

  // Rollback audit trail. A rollback only changes which model version is used
  // for NEW originations; it never mutates loan_model_snapshots or existing
  // loan obligations.
  pgm.createTable('model_rollback_events', {
    id: 'id',
    from_version: { type: 'varchar(64)', notNull: true },
    to_version: { type: 'varchar(64)', notNull: true },
    reason: { type: 'text', notNull: true },
    triggered_by: { type: 'varchar(64)', notNull: true, default: 'system' },
    created_at: {
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
  pgm.dropTable('model_rollback_events');
  pgm.dropTable('model_monitoring_alerts');
  pgm.dropTable('model_monitoring_thresholds');
  pgm.dropTable('model_monitoring_metrics');
  pgm.dropTable('loan_model_snapshots');
  pgm.dropTable('model_versions');
  pgm.dropTable('indexer_state');
  pgm.dropTable('loan_events');
};
