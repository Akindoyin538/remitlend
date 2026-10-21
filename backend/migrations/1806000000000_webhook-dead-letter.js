/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Durable dead-letter state for webhook deliveries (#517).
 * The signed payload and event_id are never modified; re-drive only bumps
 * delivery_generation so consumers can dedupe on (event_id) and observe retries.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('webhook_deliveries', {
    dead_lettered_at: { type: 'timestamp' },
    dead_letter_reason: { type: 'text' },
    delivery_generation: { type: 'integer', notNull: true, default: 1 },
    last_redriven_at: { type: 'timestamp' },
    last_redriven_by: { type: 'varchar(255)' },
  });
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS webhook_deliveries_dead_lettered_at_index
      ON webhook_deliveries (dead_lettered_at)
      WHERE dead_lettered_at IS NOT NULL;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS webhook_deliveries_dead_lettered_at_index;`);
  pgm.dropColumns('webhook_deliveries', [
    'dead_lettered_at',
    'dead_letter_reason',
    'delivery_generation',
    'last_redriven_at',
    'last_redriven_by',
  ]);
};
