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
  pgm.createTable('indexed_events', {
    id: 'id',
    event_id: { type: 'varchar(255)', notNull: true, unique: true },
    event_type: { type: 'varchar(50)', notNull: true },
    contract_id: { type: 'varchar(255)', notNull: true },
    tx_hash: { type: 'varchar(255)', notNull: true },
    ledger: { type: 'integer', notNull: true },
    ledger_closed_at: { type: 'timestamp', notNull: true },
    topics: { type: 'jsonb' },
    value: { type: 'text' },
    processed: { type: 'boolean', notNull: true, default: false },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('indexed_events', 'event_type');
  pgm.createIndex('indexed_events', 'contract_id');
  pgm.createIndex('indexed_events', 'ledger');
  pgm.createIndex('indexed_events', 'tx_hash');
  pgm.createIndex('indexed_events', 'processed');

  // Contracts boundary: validate the score update reason carried by indexed
  // score events. The reason is persisted inside the event `value` payload as
  // JSON (e.g. {"reason":"repayment"}). Enforce an explicit allow-list at the
  // database boundary so malformed or unknown reasons cannot be persisted,
  // while remaining backward compatible with existing rows (the constraint is
  // NOT VALID and only applies to new/updated rows until validated).
  pgm.addConstraint('indexed_events', 'indexed_events_score_reason_check', {
    check: `(
      event_type <> 'score_updated'
      OR (
        value IS NOT NULL
        AND jsonb_typeof((value::jsonb) -> 'reason') = 'string'
        AND (value::jsonb) ->> 'reason' IN (
          'repayment',
          'late_payment',
          'default',
          'loan_origination',
          'loan_closure',
          'manual_adjustment',
          'migration'
        )
      )
    )`,
    notValid: true,
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropConstraint('indexed_events', 'indexed_events_score_reason_check', {
    ifExists: true,
  });
  pgm.dropTable('indexed_events');
};
