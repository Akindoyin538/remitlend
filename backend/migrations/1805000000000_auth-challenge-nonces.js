/**
 * One-time authentication challenge nonce storage.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.createTable('auth_challenge_nonces', {
    nonce_hash: {
      type: 'char(64)',
      primaryKey: true,
    },
    message_hash: {
      type: 'char(64)',
      notNull: true,
    },
    public_key: {
      type: 'varchar(56)',
      notNull: true,
    },
    issued_at_ms: {
      type: 'bigint',
      notNull: true,
    },
    expires_at: {
      type: 'timestamp with time zone',
      notNull: true,
    },
    consumed_at: {
      type: 'timestamp with time zone',
      null: true,
    },
    created_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('auth_challenge_nonces', ['expires_at'], {
    name: 'auth_challenge_nonces_expires_at_idx',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropTable('auth_challenge_nonces');
};
