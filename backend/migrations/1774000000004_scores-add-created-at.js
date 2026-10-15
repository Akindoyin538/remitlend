/**
 * Aligns `scores` with the documented schema: adds `created_at` for rows
 * created before this column existed (idempotent via IF NOT EXISTS).
 *
 * The `created_at` column is the authoritative ordering key for bounded
 * score-history pagination (issue #250). A composite index on
 * (created_at, id) is added so cursor-based reads use a deterministic
 * ordering with a stable tiebreaker and bounded resource usage.
 *
 * Issue #251: score updates must carry a validated `reason`. A bounded
 * `reason` column plus a CHECK constraint enforces the schema at the
 * contracts boundary so persisted data and API consumers stay compatible
 * (existing rows are backfilled to the `legacy` reason).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Allowed score update reasons. Kept in sync with the contracts schema
 * validation so the database and the API reject the same values.
 */
export const SCORE_UPDATE_REASONS = [
  'legacy',
  'game_result',
  'admin_adjustment',
  'penalty',
  'bonus',
  'correction',
];

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

  // Issue #251: bounded, validated reason for every score update. The
  // column is added with a safe default so existing rows and in-flight
  // writers remain compatible, then constrained to the allowed set.
  pgm.sql(`
    ALTER TABLE scores
    ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'legacy';
  `);

  // Backfill any rows persisted before the column existed so the CHECK
  // constraint below can be applied without rejecting legacy data.
  pgm.sql(`
    UPDATE scores
    SET reason = 'legacy'
    WHERE reason IS NULL OR reason = '';
  `);

  // Enforce the reason schema at the contracts boundary. Idempotent via
  // DROP IF EXISTS so re-running the migration is safe.
  pgm.sql(`
    ALTER TABLE scores
    DROP CONSTRAINT IF EXISTS scores_reason_check;
  `);

  pgm.sql(`
    ALTER TABLE scores
    ADD CONSTRAINT scores_reason_check
    CHECK (reason IN (${SCORE_UPDATE_REASONS.map((r) => `'${r}'`).join(', ')}));
  `);

  // Index supporting bounded lookups/audits of score updates by reason.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS scores_reason_idx
    ON scores (reason);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS scores_reason_idx;
  `);

  pgm.sql(`
    ALTER TABLE scores
    DROP CONSTRAINT IF EXISTS scores_reason_check;
  `);

  pgm.sql(`
    ALTER TABLE scores
    DROP COLUMN IF EXISTS reason;
  `);

  pgm.sql(`
    DROP INDEX IF EXISTS scores_created_at_id_idx;
  `);

  pgm.sql(`
    ALTER TABLE scores
    DROP COLUMN IF EXISTS created_at;
  `);
};
