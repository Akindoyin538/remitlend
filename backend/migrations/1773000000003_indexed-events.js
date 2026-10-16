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
    // Evidence trust taxonomy for scoring inputs (#559).
    // source_type: where the fact originated (on-chain record, indexer event, user claim).
    // verification_status: whether the fact has been verified against an authoritative source.
    // observed_ledger / observed_at: the ledger and time at which the fact was observed.
    // provenance_ref: reference to the authoritative record backing the fact (e.g. tx hash, event id).
    source_type: {
      type: 'varchar(50)',
      notNull: true,
      default: 'indexer_event',
    },
    verification_status: {
      type: 'varchar(50)',
      notNull: true,
      default: 'provisional',
    },
    observed_ledger: { type: 'integer' },
    observed_at: { type: 'timestamp' },
    provenance_ref: { type: 'varchar(255)' },
    // Versioned policy that permitted this evidence to affect the authoritative score, if any.
    policy_version: { type: 'varchar(50)' },
    // Reconciliation bookkeeping so a fact is never double-counted.
    reconciled_at: { type: 'timestamp' },
    invalidated_at: { type: 'timestamp' },
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
  pgm.createIndex('indexed_events', 'source_type');
  pgm.createIndex('indexed_events', 'verification_status');
  pgm.createIndex('indexed_events', 'provenance_ref');

  // Enforce the evidence trust taxonomy at the storage boundary: only known
  // source types and verification statuses may be persisted.
  pgm.addConstraint('indexed_events', 'indexed_events_source_type_check', {
    check:
      "source_type IN ('on_chain_record', 'indexer_event', 'self_reported')",
  });
  pgm.addConstraint('indexed_events', 'indexed_events_verification_status_check', {
    check:
      "verification_status IN ('verified', 'provisional', 'unverified', 'invalidated')",
  });

  // Unverified or provisional facts may only affect the authoritative score when
  // an explicit versioned policy permits it.
  pgm.addConstraint('indexed_events', 'indexed_events_authoritative_policy_check', {
    check:
      "verification_status = 'verified' OR policy_version IS NOT NULL",
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('indexed_events');
};
