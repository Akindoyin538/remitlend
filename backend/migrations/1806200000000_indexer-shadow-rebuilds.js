/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Shadow projection rebuilds (issue #516).
 *
 * `indexer_rebuilds` records the rebuild input (network, contract set,
 * start/end ledger, decoder version) and lifecycle. `indexer_rebuild_events`
 * is the shadow projection: normalized rows replayed from finalized
 * `contract_events`, isolated from live reads. `indexer_active_projection`
 * is the operator-controlled pointer written only by promotion.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const up = (pgm) => {
  pgm.createTable('indexer_rebuilds', {
    id: 'id',
    network: { type: 'text', notNull: true },
    contract_ids: { type: 'text[]', notNull: true },
    start_ledger: { type: 'bigint', notNull: true },
    end_ledger: { type: 'bigint', notNull: true },
    decoder_version: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    last_replayed_ledger: { type: 'bigint' },
    event_count: { type: 'integer', notNull: true, default: 0 },
    digest: { type: 'text' },
    failure_reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
    validated_at: { type: 'timestamptz' },
    promoted_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('indexer_rebuilds', 'indexer_rebuilds_status_check', {
    check: "status IN ('pending','replaying','validated','failed','promoted')",
  });
  pgm.addConstraint('indexer_rebuilds', 'indexer_rebuilds_range_check', {
    check: 'end_ledger >= start_ledger',
  });

  pgm.createTable('indexer_rebuild_events', {
    id: 'id',
    rebuild_id: {
      type: 'integer',
      notNull: true,
      references: 'indexer_rebuilds',
      onDelete: 'CASCADE',
    },
    event_id: { type: 'varchar(255)', notNull: true },
    event_type: { type: 'varchar(50)', notNull: true },
    loan_id: { type: 'integer' },
    address: { type: 'text' },
    amount: { type: 'text' },
    ledger: { type: 'bigint', notNull: true },
    tx_hash: { type: 'text' },
    contract_id: { type: 'text' },
  });
  pgm.addConstraint('indexer_rebuild_events', 'uq_indexer_rebuild_events_rebuild_event', {
    unique: ['rebuild_id', 'event_id'],
  });
  pgm.createIndex('indexer_rebuild_events', ['rebuild_id', 'ledger', 'event_id'], {
    name: 'idx_indexer_rebuild_events_order',
  });

  pgm.createTable('indexer_active_projection', {
    network: { type: 'text', primaryKey: true },
    rebuild_id: { type: 'integer', notNull: true, references: 'indexer_rebuilds' },
    promoted_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const down = (pgm) => {
  pgm.dropTable('indexer_active_projection');
  pgm.dropTable('indexer_rebuild_events');
  pgm.dropTable('indexer_rebuilds');
};
