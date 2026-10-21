/**
 * Dual-control approval requests for high-impact admin operations (#520).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('privileged_action_requests', {
    id: 'id',
    action_type: { type: 'varchar(64)', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    // sha256 over action type + canonical payload; approval is bound to it.
    payload_hash: { type: 'varchar(64)', notNull: true },
    initiator: { type: 'varchar(255)', notNull: true },
    approver: { type: 'varchar(255)' },
    status: {
      type: 'varchar(16)',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending','approved','revoked','executing','executed','failed')",
    },
    expires_at: { type: 'timestamp', notNull: true },
    approved_at: { type: 'timestamp' },
    revoked_at: { type: 'timestamp' },
    revoked_by: { type: 'varchar(255)' },
    executed_at: { type: 'timestamp' },
    // Transaction hash or other reference on success.
    execution_ref: { type: 'varchar(255)' },
    execution_error: { type: 'text' },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
  });
  // Initiator and approver must be distinct principals, enforced in the database too.
  pgm.addConstraint(
    'privileged_action_requests',
    'privileged_action_distinct_principals',
    'CHECK (approver IS NULL OR approver <> initiator)',
  );
  pgm.createIndex('privileged_action_requests', ['status', 'expires_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('privileged_action_requests');
};
