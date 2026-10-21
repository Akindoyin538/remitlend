/**
 * Discrepancy ledger for cross-system financial reconciliation (#518).
 *
 * reconciliation_discrepancies holds immutable evidence. Only observation
 * metadata (last_observed_at, observation_count) and resolution state
 * (status, resolved_at) may change; a trigger enforces this and blocks deletes.
 * reconciliation_discrepancy_resolutions is append-only.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('reconciliation_discrepancies', {
    id: 'id',
    // sha256 over class, rule version, subject and compared values: repeat scans collapse onto it.
    dedupe_key: { type: 'varchar(64)', notNull: true, unique: true },
    discrepancy_class: { type: 'varchar(64)', notNull: true },
    rule_version: { type: 'varchar(32)', notNull: true },
    severity: {
      type: 'varchar(16)',
      notNull: true,
      check: "severity IN ('info', 'warning', 'critical')",
    },
    subject_ref: { type: 'varchar(255)', notNull: true },
    asset: { type: 'varchar(64)', notNull: true },
    unit: { type: 'varchar(32)', notNull: true },
    // Integer amounts in the smallest unit, never floats.
    contract_value: { type: 'numeric(40,0)', notNull: true },
    indexed_value: { type: 'numeric(40,0)', notNull: true },
    db_value: { type: 'numeric(40,0)', notNull: true },
    ledger: { type: 'bigint' },
    tx_hash: { type: 'varchar(128)' },
    source_snapshots: { type: 'jsonb', notNull: true },
    detected_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    last_observed_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    observation_count: { type: 'integer', notNull: true, default: 1 },
    status: {
      type: 'varchar(16)',
      notNull: true,
      default: 'open',
      check: "status IN ('open', 'resolved')",
    },
    resolved_at: { type: 'timestamp' },
  });
  pgm.createIndex('reconciliation_discrepancies', ['status', 'severity']);

  pgm.createTable('reconciliation_discrepancy_resolutions', {
    id: 'id',
    discrepancy_id: {
      type: 'integer',
      notNull: true,
      references: 'reconciliation_discrepancies',
      onDelete: 'RESTRICT',
    },
    actor: { type: 'varchar(255)', notNull: true },
    reason: { type: 'text', notNull: true },
    evidence: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.createIndex('reconciliation_discrepancy_resolutions', 'discrepancy_id');

  pgm.sql(`
    CREATE OR REPLACE FUNCTION reconciliation_discrepancy_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'reconciliation ledger rows are immutable';
      END IF;
      IF TG_TABLE_NAME = 'reconciliation_discrepancy_resolutions' THEN
        RAISE EXCEPTION 'reconciliation resolutions are append-only';
      END IF;
      IF (NEW.id, NEW.dedupe_key, NEW.discrepancy_class, NEW.rule_version, NEW.severity,
          NEW.subject_ref, NEW.asset, NEW.unit, NEW.contract_value, NEW.indexed_value,
          NEW.db_value, NEW.ledger, NEW.tx_hash, NEW.source_snapshots, NEW.detected_at)
         IS DISTINCT FROM
         (OLD.id, OLD.dedupe_key, OLD.discrepancy_class, OLD.rule_version, OLD.severity,
          OLD.subject_ref, OLD.asset, OLD.unit, OLD.contract_value, OLD.indexed_value,
          OLD.db_value, OLD.ledger, OLD.tx_hash, OLD.source_snapshots, OLD.detected_at) THEN
        RAISE EXCEPTION 'discrepancy evidence is immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    CREATE TRIGGER reconciliation_discrepancies_guard
      BEFORE UPDATE OR DELETE ON reconciliation_discrepancies
      FOR EACH ROW EXECUTE FUNCTION reconciliation_discrepancy_guard();
    CREATE TRIGGER reconciliation_resolutions_guard
      BEFORE UPDATE OR DELETE ON reconciliation_discrepancy_resolutions
      FOR EACH ROW EXECUTE FUNCTION reconciliation_discrepancy_guard();
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('reconciliation_discrepancy_resolutions');
  pgm.dropTable('reconciliation_discrepancies');
  pgm.sql('DROP FUNCTION IF EXISTS reconciliation_discrepancy_guard();');
};
