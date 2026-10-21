/**
 * CONTRACT phase for notifications.read -> read_at. IRREVERSIBLE data-wise:
 * the boolean column is dropped. Only run after every running app version
 * reads/writes read_at exclusively (see docs/DEPLOYMENT.md release gates).
 *
 * Run with `npm run migrate:contract:up`. It is intentionally NOT part of
 * `npm run migrate:up`.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  // Gate: the expand migration must have been applied and fully backfilled.
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'notifications' AND column_name = 'read_at') THEN
        RAISE EXCEPTION 'contract gate: expand migration 1806000000000 not applied';
      END IF;
      IF EXISTS (SELECT 1 FROM notifications WHERE read = true AND read_at IS NULL) THEN
        RAISE EXCEPTION 'contract gate: unbackfilled rows remain (read = true AND read_at IS NULL)';
      END IF;
    END $$;
  `);
  pgm.sql('DROP TRIGGER IF EXISTS notifications_sync_read_trg ON notifications');
  pgm.sql('DROP FUNCTION IF EXISTS notifications_sync_read()');
  pgm.dropColumn('notifications', 'read', { ifExists: true });
};

/** Schema-only rollback; restores column and derives values from read_at. */
export const down = (pgm) => {
  pgm.addColumn('notifications', {
    read: { type: 'boolean', notNull: true, default: false },
  });
  pgm.sql('UPDATE notifications SET read = (read_at IS NOT NULL)');
  pgm.createIndex('notifications', 'read', { ifNotExists: true });
  pgm.createIndex('notifications', ['user_id', 'read'], { ifNotExists: true });
};
