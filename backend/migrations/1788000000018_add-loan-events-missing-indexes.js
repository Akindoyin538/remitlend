/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Issue #438: add missing indexes used by borrower history, event filtering,
 * loan detail lookups, and date-range scans.
 *
 * Issue #250: bounded score-history pagination reads loan_events with a
 * deterministic (created_at, id) keyset ordering, so add a composite index
 * that supports the cursor scan without a sort.
 *
 * Uses explicit names + IF NOT EXISTS for safe re-runs.
 *
 * Issue #572: index builds on large tables can hold locks and consume disk/CPU
 * at production scale. Build each index CONCURRENTLY so writes are not blocked,
 * and record runtime/lock/resource evidence via the rehearsal harness
 * (scripts/migration-rehearsal) before release.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const up = (pgm) => {
  // CONCURRENTLY cannot run inside a transaction block.
  pgm.noTransaction();

  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loan_events_borrower
      ON loan_events (borrower);
  `);

  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loan_events_event_type
      ON loan_events (event_type);
  `);

  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loan_events_loan_id_event_type
      ON loan_events (loan_id, event_type);
  `);

  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loan_events_created_at
      ON loan_events (created_at);
  `);

  // Issue #250: keyset pagination for score history orders by
  // (created_at DESC, id DESC) with a tiebreaker on id. This composite index
  // lets the bounded page query walk the cursor deterministically without a
  // sort, keeping resource usage bounded for large histories.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_loan_events_created_at_id
      ON loan_events (created_at DESC, id DESC);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_loan_events_created_at_id;`);
  pgm.sql(`DROP INDEX IF EXISTS idx_loan_events_created_at;`);
  // Note: idx_loan_events_loan_id_event_type is also created by the earlier 1777 composite-indexes migration.
  // A partial rollback of just 1788 would drop an index 1777 also owns, but IF EXISTS keeps it safe.
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_loan_events_loan_id_event_type;`);
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_loan_events_event_type;`);
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS idx_loan_events_borrower;`);
};
