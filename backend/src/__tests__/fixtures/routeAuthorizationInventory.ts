/**
 * Machine-checkable inventory of every route in the user-resource route files
 * (#519). `resourceAuthorizationMatrix.test.ts` fails when a route exists in code
 * but not here (or vice versa), and runs cross-principal probes derived from
 * `ownership`. Human-readable form: docs/security/authorization-matrix-tests.md.
 *
 * Key format: `<routeFile> <METHOD> <path as written in the router>`.
 *
 * ownership:
 *  - loan-owner:     :loanId must belong to the caller (borrower); foreign => 404, same as missing
 *  - loan-borrower:  borrower must own the loan; lenders/admins may read any loan
 *  - wallet-param:   path wallet must equal the JWT wallet; foreign => 403
 *  - sender-record:  record must belong to the caller; foreign => 404, same as missing
 *  - self:           data is derived from the JWT wallet; no client-supplied identifier
 *  - none:           no user-owned resource (explain in `note`)
 */
export type Ownership =
  'loan-owner' | 'loan-borrower' | 'wallet-param' | 'sender-record' | 'self' | 'none';

export interface InventoryEntry {
  mount: string;
  roles: Array<'borrower' | 'lender' | 'admin'>;
  ownership: Ownership;
  note?: string;
  /** Explicit exemption from the cross-principal probe; reason required. */
  exempt?: string;
}

const B: InventoryEntry['roles'] = ['borrower', 'admin'];
const ALL: InventoryEntry['roles'] = ['borrower', 'lender', 'admin'];

export const ROUTE_INVENTORY: Record<string, InventoryEntry> = {
  // Loans
  'loanRoutes.ts POST /': {
    mount: '/api/loans',
    roles: ALL,
    ownership: 'none',
    exempt: 'test/dev-only route, registered only when NODE_ENV is test or development',
  },
  'loanRoutes.ts POST /:loanId/mark-defaulted': {
    mount: '/api/loans',
    roles: ALL,
    ownership: 'loan-owner',
    exempt: 'test/dev-only route, registered only when NODE_ENV is test or development',
  },
  'loanRoutes.ts GET /config': {
    mount: '/api/loans',
    roles: ALL,
    ownership: 'none',
    exempt: 'public protocol configuration, no user data',
  },
  'loanRoutes.ts POST /:loanId/build-cancel': {
    mount: '/api/loans',
    roles: B,
    ownership: 'loan-owner',
  },
  'loanRoutes.ts POST /amortization-preview': {
    mount: '/api/loans',
    roles: ALL,
    ownership: 'none',
    exempt: 'pure calculation on request-supplied inputs, reads no stored records',
  },
  'loanRoutes.ts POST /:loanId/contest-default': {
    mount: '/api/loans',
    roles: B,
    ownership: 'loan-owner',
  },
  'loanRoutes.ts GET /borrower/:borrower': {
    mount: '/api/loans',
    roles: B,
    ownership: 'wallet-param',
  },
  'loanRoutes.ts GET /:loanId': { mount: '/api/loans', roles: ALL, ownership: 'loan-borrower' },
  'loanRoutes.ts GET /:loanId/amortization-schedule': {
    mount: '/api/loans',
    roles: ALL,
    ownership: 'loan-borrower',
  },
  'loanRoutes.ts GET /:loanId/events': {
    mount: '/api/loans',
    roles: ALL,
    ownership: 'loan-borrower',
  },
  'loanRoutes.ts POST /request': {
    mount: '/api/loans',
    roles: B,
    ownership: 'self',
    note: 'borrowerPublicKey in the body is checked against the JWT wallet in the controller',
  },
  'loanRoutes.ts POST /:loanId/build-deposit-collateral': {
    mount: '/api/loans',
    roles: B,
    ownership: 'loan-owner',
  },
  'loanRoutes.ts POST /:loanId/build-release-collateral': {
    mount: '/api/loans',
    roles: B,
    ownership: 'loan-owner',
  },
  'loanRoutes.ts POST /:loanId/build-refinance': {
    mount: '/api/loans',
    roles: B,
    ownership: 'loan-owner',
  },
  'loanRoutes.ts POST /:loanId/build-extend': {
    mount: '/api/loans',
    roles: B,
    ownership: 'loan-owner',
  },
  'loanRoutes.ts POST /:loanId/liquidate/build': {
    mount: '/api/loans',
    roles: ['lender', 'admin'],
    ownership: 'none',
    exempt:
      'liquidation is a third-party action on any defaulted loan; not an owner-scoped resource',
  },
  'loanRoutes.ts POST /submit': {
    mount: '/api/loans',
    roles: ALL,
    ownership: 'self',
    exempt: 'submits a transaction the caller signed; no stored record is addressed',
  },
  'loanRoutes.ts POST /:loanId/repay': { mount: '/api/loans', roles: B, ownership: 'loan-owner' },
  'loanRoutes.ts POST /:loanId/submit': { mount: '/api/loans', roles: B, ownership: 'loan-owner' },

  // Remittances
  'remittanceRoutes.ts POST /': { mount: '/api/remittances', roles: B, ownership: 'self' },
  'remittanceRoutes.ts GET /': { mount: '/api/remittances', roles: B, ownership: 'self' },
  'remittanceRoutes.ts GET /:id': {
    mount: '/api/remittances',
    roles: B,
    ownership: 'sender-record',
  },
  'remittanceRoutes.ts POST /:id/submit': {
    mount: '/api/remittances',
    roles: B,
    ownership: 'sender-record',
  },

  // Notifications / profile
  'notificationsRoutes.ts GET /': { mount: '/api/notifications', roles: ALL, ownership: 'self' },
  'notificationsRoutes.ts GET /preferences': {
    mount: '/api/notifications',
    roles: ALL,
    ownership: 'self',
  },
  'notificationsRoutes.ts PUT /preferences': {
    mount: '/api/notifications',
    roles: ALL,
    ownership: 'self',
  },
  'notificationsRoutes.ts GET /stream': {
    mount: '/api/notifications',
    roles: ALL,
    ownership: 'self',
  },
  'notificationsRoutes.ts POST /mark-read': {
    mount: '/api/notifications',
    roles: ALL,
    ownership: 'self',
    note: 'ids are filtered by the JWT wallet in notificationService.markRead',
  },
  'notificationsRoutes.ts POST /mark-all-read': {
    mount: '/api/notifications',
    roles: ALL,
    ownership: 'self',
  },
  'userRoutes.ts GET /profile': { mount: '/user', roles: ALL, ownership: 'self' },
  'userRoutes.ts PATCH /profile': { mount: '/user', roles: ALL, ownership: 'self' },

  // Score
  'scoreRoutes.ts GET /:userId': { mount: '/api/score', roles: ALL, ownership: 'wallet-param' },
  'scoreRoutes.ts GET /:walletAddress/history': {
    mount: '/api/score',
    roles: ALL,
    ownership: 'wallet-param',
  },
  'scoreRoutes.ts GET /:walletAddress/nft': {
    mount: '/api/score',
    roles: ALL,
    ownership: 'wallet-param',
  },
  'scoreRoutes.ts GET /:userId/breakdown': {
    mount: '/api/score',
    roles: ALL,
    ownership: 'wallet-param',
  },
  'scoreRoutes.ts POST /update': {
    mount: '/api/score',
    roles: [],
    ownership: 'none',
    exempt: 'internal API-key route, no user principal',
  },
  'scoreRoutes.ts GET /confidence/filter': {
    mount: '/api/score',
    roles: ['lender', 'admin'],
    ownership: 'none',
    exempt: 'lender-only aggregate view across borrowers by design',
  },

  // Pool (lender-owned)
  'poolRoutes.ts GET /stats': {
    mount: '/api/pool',
    roles: ['lender', 'admin'],
    ownership: 'none',
    exempt: 'aggregate pool statistics, no per-user data',
  },
  'poolRoutes.ts GET /depositor/:address': {
    mount: '/api/pool',
    roles: ['lender', 'admin'],
    ownership: 'wallet-param',
  },
  'poolRoutes.ts GET /depositor/:address/yield-history': {
    mount: '/api/pool',
    roles: ['lender', 'admin'],
    ownership: 'wallet-param',
  },
  'poolRoutes.ts GET /:token/share-price': {
    mount: '/api/pool',
    roles: ['lender', 'admin'],
    ownership: 'none',
    exempt: 'public pool metric per token',
  },
  'poolRoutes.ts POST /build-deposit': {
    mount: '/api/pool',
    roles: ['lender', 'admin'],
    ownership: 'self',
    exempt: 'builds an unsigned transaction for the caller; depositor key checked in controller',
  },
  'poolRoutes.ts POST /build-withdraw': {
    mount: '/api/pool',
    roles: ['lender', 'admin'],
    ownership: 'self',
    exempt: 'builds an unsigned transaction for the caller; depositor key checked in controller',
  },

  // Transactions / events
  'transactionRoutes.ts GET /me': { mount: '/api/transactions', roles: ALL, ownership: 'self' },
  'eventRoutes.ts GET /stream': { mount: '/api/events', roles: ALL, ownership: 'self' },
  'eventRoutes.ts GET /status': {
    mount: '/api/events',
    roles: [],
    ownership: 'none',
    exempt: 'admin API-key route, no user principal',
  },
};

/**
 * Route files that contain no user-owned resources. Every file in src/routes must
 * be either a key prefix in ROUTE_INVENTORY or listed here with a reason.
 */
export const EXEMPT_ROUTE_FILES: Record<string, string> = {
  'adminRoutes.ts': 'admin JWT role or scoped admin API key; no borrower/lender-owned resources',
  'authRoutes.ts': 'authentication flows (challenge/login/refresh); caller proves wallet ownership',
  'indexerRoutes.ts': 'scoped admin API key and signed indexer callbacks',
  'internalRoutes.ts': 'internal signed requests only',
  'simulationRoutes.ts': 'stateless simulations on request-supplied inputs',
  'statusRoutes.ts': 'public health/status endpoints',
};
