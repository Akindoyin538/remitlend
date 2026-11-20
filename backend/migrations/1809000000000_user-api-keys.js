/**
 * User API keys with scopes, mandatory expiry and rotation lineage (#792).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.createTable('user_api_keys', {
    id: 'id',
    owner: { type: 'varchar(255)', notNull: true },
    name: { type: 'varchar(100)' },
    // sha256 of the secret; the plaintext key is only returned once at creation.
    key_hash: { type: 'varchar(64)', notNull: true, unique: true },
    scopes: { type: 'text[]', notNull: true, default: '{}' },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    rotated_from: { type: 'integer', references: 'user_api_keys', onDelete: 'SET NULL' },
    expiry_notified_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('user_api_keys', 'owner');
  pgm.createIndex('user_api_keys', 'expires_at');
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.dropTable('user_api_keys');
};
