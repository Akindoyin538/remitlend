/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.addColumn('webhook_subscriptions', {
    owner_public_key: { type: 'varchar(255)' },
  });
  pgm.createIndex('webhook_subscriptions', 'owner_public_key');

  pgm.createTable('webhook_subscription_audit', {
    id: 'id',
    subscription_id: { type: 'integer', notNull: true },
    owner_public_key: { type: 'varchar(255)', notNull: true },
    change_type: { type: 'varchar(20)', notNull: true },
    previous_callback_url: { type: 'text' },
    callback_url: { type: 'text' },
    previous_event_types: { type: 'jsonb' },
    event_types: { type: 'jsonb' },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });
  pgm.addConstraint('webhook_subscription_audit', 'webhook_subscription_audit_change_type_check', {
    check: "change_type IN ('created', 'updated', 'deleted')",
  });
  pgm.createIndex('webhook_subscription_audit', ['owner_public_key', 'subscription_id', 'created_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('webhook_subscription_audit');
  pgm.dropIndex('webhook_subscriptions', 'owner_public_key');
  pgm.dropColumn('webhook_subscriptions', 'owner_public_key');
};
