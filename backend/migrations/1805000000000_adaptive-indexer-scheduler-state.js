/**
 * Migration: Create indexer_scheduler_state table for adaptive scheduling
 *
 * This table tracks adaptive scheduler state to enable:
 * - Mode persistence across restarts (Caught-Up, Behind, Catch-Up)
 * - Failure tracking and backoff coordination
 * - Diagnostic metadata for operational dashboards
 */

exports.up = async (pgm) => {
  await pgm.sql(`
    -- Create enum type for scheduler mode
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scheduler_mode') THEN
        CREATE TYPE scheduler_mode AS ENUM ('caught_up', 'behind', 'catch_up');
      END IF;
    END
    $$;
  `);

  // Create the table if it doesn't already exist
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS indexer_scheduler_state (
      id SERIAL PRIMARY KEY,
      
      -- Contract identifier (matches indexer_state.contract)
      contract VARCHAR(56) NOT NULL UNIQUE,
      
      -- Current adaptive mode
      mode scheduler_mode NOT NULL DEFAULT 'caught_up',
      
      -- Backoff and failure tracking
      consecutive_failures INT NOT NULL DEFAULT 0,
      last_poll_time TIMESTAMP,
      last_successful_poll_time TIMESTAMP,
      
      -- Diagnostic metadata for observability
      last_lag_ledgers INT,
      last_error_message TEXT,
      
      -- Timestamps
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create index for quick lookups by contract
  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_indexer_scheduler_state_contract
    ON indexer_scheduler_state(contract);
  `);

  // Create a function to auto-update the updated_at column
  await pgm.sql(`
    CREATE OR REPLACE FUNCTION update_indexer_scheduler_state_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Attach the trigger
  await pgm.sql(`
    DROP TRIGGER IF EXISTS trigger_indexer_scheduler_state_updated_at
    ON indexer_scheduler_state;
    
    CREATE TRIGGER trigger_indexer_scheduler_state_updated_at
    BEFORE UPDATE ON indexer_scheduler_state
    FOR EACH ROW
    EXECUTE FUNCTION update_indexer_scheduler_state_updated_at();
  `);
};

exports.down = async (pgm) => {
  // Drop trigger
  await pgm.sql(`DROP TRIGGER IF EXISTS trigger_indexer_scheduler_state_updated_at ON indexer_scheduler_state`);

  // Drop function
  await pgm.sql(`DROP FUNCTION IF EXISTS update_indexer_scheduler_state_updated_at()`);

  // Drop table
  await pgm.dropTable('indexer_scheduler_state', { ifExists: true });

  // Drop enum type
  await pgm.sql(`DROP TYPE IF EXISTS scheduler_mode`);
};
