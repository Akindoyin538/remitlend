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
  pgm.createTable('remittances', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    sender_id: {
      type: 'varchar(56)',
      notNull: true,
    },
    recipient_address: {
      type: 'varchar(56)',
      notNull: true,
    },
    amount: {
      type: 'numeric(20,7)',
      notNull: true,
    },
    from_currency: {
      type: 'varchar(10)',
      notNull: true,
    },
    to_currency: {
      type: 'varchar(10)',
      notNull: true,
    },
    memo: {
      type: 'varchar(28)',
      allowNull: true,
    },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'processing', 'completed', 'failed')",
    },
    transaction_hash: {
      type: 'varchar(64)',
      allowNull: true,
    },
    xdr: {
      type: 'text',
      notNull: true,
    },
    error_message: {
      type: 'text',
      allowNull: true,
    },
    // Evidence trust taxonomy for scoring inputs (#559).
    // source_type: where the fact originated.
    // verification_status: how much the fact can be trusted.
    // observed_ledger / observed_at: when the fact was observed.
    // provenance_ref: reference to the originating record (tx hash, event id, claim id).
    source_type: {
      type: 'varchar(32)',
      notNull: true,
      default: 'self_reported',
      check:
        "source_type IN ('verified_onchain', 'provisional_indexer', 'self_reported')",
    },
    verification_status: {
      type: 'varchar(32)',
      notNull: true,
      default: 'unverified',
      check:
        "verification_status IN ('verified', 'provisional', 'unverified', 'invalidated')",
    },
    observed_ledger: {
      type: 'bigint',
      allowNull: true,
    },
    observed_at: {
      type: 'timestamp',
      allowNull: true,
    },
    provenance_ref: {
      type: 'varchar(128)',
      allowNull: true,
    },
    // Versioned policy that authorizes this evidence to affect the authoritative score.
    // NULL means the fact is non-authoritative and may only appear in previews.
    policy_version: {
      type: 'varchar(32)',
      allowNull: true,
    },
    // Deduplication key so reconciliation cannot double-count the same fact.
    fact_key: {
      type: 'varchar(128)',
      allowNull: true,
    },
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

  // Indexes for common queries
  pgm.createIndex('remittances', 'sender_id');
  pgm.createIndex('remittances', ['sender_id', 'status']);
  pgm.createIndex('remittances', 'created_at');
  pgm.createIndex('remittances', 'transaction_hash');

  // Scoring boundary: only verified evidence with an explicit policy may be authoritative.
  pgm.createIndex('remittances', ['verification_status', 'source_type']);
  // Prevent duplicate ingestion of the same fact during reconciliation.
  pgm.createIndex('remittances', 'fact_key', {
    unique: true,
    where: 'fact_key IS NOT NULL',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('remittances');
};
