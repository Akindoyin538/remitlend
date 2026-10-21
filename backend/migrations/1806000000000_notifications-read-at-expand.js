/**
 * EXPAND phase (expand-contract pattern, see docs/DEPLOYMENT.md
 * "Expand-contract migrations").
 *
 * Replaces notifications.read (boolean) with notifications.read_at (timestamptz).
 * This migration is additive and backward compatible with the currently
 * deployed application: the old column is untouched and a trigger keeps both
 * representations in sync for writes from either old or new code.
 *
 * The destructive step lives in backend/migrations-contract/ and is run
 * separately via `npm run migrate:contract:up`.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.addColumn('notifications', {
    read_at: { type: 'timestamptz', notNull: false },
  });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION notifications_sync_read() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.read_at IS NOT NULL THEN
          NEW.read := true;
        ELSIF NEW.read THEN
          NEW.read_at := now();
        END IF;
      ELSE
        IF NEW.read_at IS DISTINCT FROM OLD.read_at THEN
          NEW.read := (NEW.read_at IS NOT NULL);
        ELSIF NEW.read IS DISTINCT FROM OLD.read THEN
          NEW.read_at := CASE WHEN NEW.read THEN COALESCE(OLD.read_at, now()) ELSE NULL END;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER notifications_sync_read_trg
    BEFORE INSERT OR UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION notifications_sync_read();
  `);

  // Backfill existing rows (trigger is already live, so concurrent writes stay consistent).
  pgm.sql(`UPDATE notifications SET read_at = created_at WHERE read = true AND read_at IS NULL`);

  pgm.createIndex('notifications', ['user_id', 'read_at'], {
    name: 'idx_notifications_user_read_at',
    ifNotExists: true,
  });
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS notifications_sync_read_trg ON notifications');
  pgm.sql('DROP FUNCTION IF EXISTS notifications_sync_read()');
  pgm.dropIndex('notifications', ['user_id', 'read_at'], {
    name: 'idx_notifications_user_read_at',
    ifExists: true,
  });
  pgm.dropColumn('notifications', 'read_at', { ifExists: true });
};
