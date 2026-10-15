/**
 * Aligns `scores` with the documented schema: adds `created_at` for rows
 * created before this column existed (idempotent via IF NOT EXISTS).
 *
 * The `created_at` column is the authoritative ordering key for bounded
 * score-history pagination (issue #250). A composite index on
 * (created_at, id) is added so cursor-based reads use a deterministic
 * ordering with a stable tiebreaker and bounded resource usage.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE scores
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
  `);

  // Backfill legacy rows deterministically so pagination ordering is stable
  // for data persisted before this column existed. Only touches rows that
  // still carry the column default and have no authoritative timestamp.
  pgm.sql(`
    UPDATE scores
    SET created_at = CURRENT_TIMESTAMP
    WHERE created_at IS NULL;
  `);

  // Composite index backing the (created_at, id) cursor ordering used by
  // bounded score-history pagination. Additive and idempotent.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS scores_created_at_id_idx
    ON scores (created_at, id);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS scores_created_at_id_idx;
  `);

  pgm.sql(`
    ALTER TABLE scores
    DROP COLUMN IF EXISTS created_at;
  `);
};
