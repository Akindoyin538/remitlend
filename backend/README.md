# RemitLend Backend API

Express.js backend service for the RemitLend platform, providing API endpoints for credit scoring, remittance simulation, and NFT metadata management.

## Overview

The backend serves as a bridge between the frontend application and the Stellar blockchain, handling:

- **Loan Event Indexing**: A robust polling service that watches Soroban RPC for `LoanRequested`, `LoanApproved`, and `LoanRepaid` events.
- **Credit Scoring**: Generation and verification of borrower scores based on indexed history.
- **Remittance Simulation**: API support for generating mocked remittance data for testing.
- **NFT Metadata**: Serving metadata for the Remittance NFT collection.
- **Security**: Request validation, rate limiting, and centralized error handling.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js 5
- **Language**: TypeScript
- **Validation**: Zod
- **Testing**: Jest + Supertest
- **Documentation**: Swagger/OpenAPI
- **Code Quality**: ESLint + Prettier

## Service Level Objectives (SLOs)

This section defines the service-level indicators (SLIs) and objectives for the
critical borrower and lender journeys. Component health checks only prove that a
service responds; these SLOs measure whether a user can actually complete a
journey within an acceptable time. They span the frontend, API, indexer, RPC
confirmation, and notification dependencies.

### Critical journeys

| Journey | User | Steps |
| --- | --- | --- |
| Request a loan | Borrower | Submit request in UI → API accepts → tx submitted → chain finality → indexer projects loan |
| Repay a loan | Borrower | Submit repayment in UI → API accepts → tx submitted → chain finality → indexer projects repayment |
| Inspect eligible funds | Lender | Open pool view → API returns eligible funds → indexer projection is current |
| Withdraw eligible funds | Lender | Submit withdrawal in UI → API accepts → tx submitted → chain finality → indexer projects withdrawal |

### SLI definitions

Each SLI below has a precise event definition, an eligible denominator, and an
exclusion policy. Latency SLIs are measured as the fraction of eligible events
completed within the target; availability SLIs are measured as the fraction of
eligible requests that succeed.

#### 1. `api_request_latency` — API acceptance latency

- **Event definition**: Time from the API receiving a journey request
  (`POST /api/loans`, `POST /api/loans/:id/repay`, `POST /api/withdrawals`,
  `GET /api/pools/:id/eligible-funds`) to the API returning a 2xx response.
- **Eligible denominator**: All requests to those routes that reach the API and
  are not rejected by authentication, authorization, or request validation.
- **Exclusions**: 4xx client errors (auth, validation, rate limiting), requests
  from synthetic health probes, and requests during a declared dependency
  outage window.
- **Target**: 99% of eligible requests < 500 ms; 99.9% < 2 s.

#### 2. `tx_submission_latency` — transaction submission latency

- **Event definition**: Time from the API accepting a journey request to the
  signed transaction being accepted by Soroban RPC (`sendTransaction` returns a
  hash without a submission error).
- **Eligible denominator**: All journey requests that pass API validation and
  produce a signed transaction.
- **Exclusions**: Requests where the user abandons signing, wallet rejections,
  and requests during a declared RPC outage window.
- **Target**: 99% of eligible submissions < 3 s; 99.9% < 10 s.

#### 3. `chain_finality_latency` — chain finality latency

- **Event definition**: Time from RPC accepting the transaction to the
  transaction reaching ledger finality (successful `getTransaction` with a
  finalized ledger).
- **Eligible denominator**: All submitted transactions for the critical
  journeys.
- **Exclusions**: Transactions that fail on-chain for business reasons
  (insufficient balance, contract revert) and transactions during a declared
  network halt.
- **Target**: 99% of eligible transactions finalize < 30 s; 99.9% < 120 s.

#### 4. `indexer_projection_lag` — indexer projection lag

- **Event definition**: Difference between the latest finalized ledger and the
  ledger last projected into `loan_events` / `indexed_events` by the indexer.
- **Eligible denominator**: All polling intervals where the indexer is running
  and the RPC is reachable.
- **Exclusions**: Intervals during a declared RPC outage, during a planned
  indexer restart, and while a backfill is explicitly in progress.
- **Target**: 99% of intervals have lag < 5 ledgers; 99.9% < 20 ledgers.

#### 5. `journey_success_rate` — end-to-end journey success

- **Event definition**: Fraction of journey attempts that reach a terminal
  success state (loan requested, loan repaid, eligible funds inspected,
  withdrawal completed) within the journey deadline.
- **Eligible denominator**: All journey attempts started from the frontend.
- **Exclusions**: User-cancelled attempts, attempts rejected by validation, and
  attempts during a declared dependency outage window.
- **Target**: 99.5% success over a 28-day window.

#### 6. `notification_delivery_latency` — notification delivery

- **Event definition**: Time from a journey reaching a terminal state to the
  corresponding notification being delivered to the user.
- **Eligible denominator**: All terminal journey events that have a notification
  subscription.
- **Exclusions**: Users with notifications disabled and events during a declared
  notification-provider outage.
- **Target**: 99% of eligible notifications delivered < 60 s.

### Error budgets

Each SLO has a 28-day rolling error budget equal to `1 - target`. When more than
50% of a budget is consumed, the owning team pauses non-urgent feature work on
the affected journey and prioritizes reliability fixes. When a budget is fully
exhausted, the journey is frozen for feature work until the budget recovers.

### Alerts

Alerts are tied to user impact and each has an owner, a runbook, and an
actionable threshold. Alerts fire on the burn rate of the error budget over a
short window (fast burn) and a long window (slow burn).

| Alert | Condition | User impact | Owner | Runbook |
| --- | --- | --- | --- | --- |
| `ApiLatencyFastBurn` | `api_request_latency` budget burn > 14.4x over 1 h | Borrowers/lenders wait on every action | Backend on-call | `docs/runbooks/api-latency.md` |
| `TxSubmissionFastBurn` | `tx_submission_latency` budget burn > 14.4x over 1 h | Loan requests and repayments stall before submission | Backend on-call | `docs/runbooks/tx-submission.md` |
| `ChainFinalitySlowBurn` | `chain_finality_latency` budget burn > 6x over 6 h | Loans and withdrawals take too long to confirm | Chain on-call | `docs/runbooks/chain-finality.md` |
| `IndexerLagHigh` | `indexer_projection_lag` > 20 ledgers for 10 min | Lenders see stale eligible funds; borrowers see stale loan state | Indexer on-call | `docs/runbooks/indexer-lag.md` |
| `JourneySuccessLow` | `journey_success_rate` < 99% over 1 h | Users cannot complete a critical journey | Product on-call | `docs/runbooks/journey-success.md` |
| `NotificationDeliverySlow` | `notification_delivery_latency` p99 > 5 min for 15 min | Users miss loan and repayment updates | Backend on-call | `docs/runbooks/notification-delivery.md` |

### Dashboards

Dashboards separate dependency outages from application failures so responders
can tell whether the API, the indexer, the RPC, or the notification provider is
at fault. Panels are grouped as:

- **Application**: API latency and error rate, journey success rate.
- **Dependencies**: RPC submission and finality latency, indexer projection lag,
  notification delivery latency.
- **Error budget**: Remaining budget per SLO over the 28-day window.

Labels are limited to `journey`, `route`, `status_class`, and `dependency` to
avoid high-cardinality series. User IDs, transaction hashes, and ledger numbers
are never used as metric labels; they belong in logs and traces.

### Review cadence

SLOs are reviewed every quarter, or sooner after a major journey change. The
review confirms targets still match user expectations, retires SLIs that no
longer map to a journey, and updates alert thresholds and runbooks. Error-budget
consumption is reviewed weekly by the owning teams.

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Apply database migrations (requires PostgreSQL and DATABASE_URL in .env)
npm run migrate:up

# Start development server
npm run dev
```

### Database and migrations

The API expects a PostgreSQL database. Set `DATABASE_URL` in `.env` (see `.env.example`).

Apply schema migrations from the `backend` directory:

```bash
npm run migrate:up
```

Rollback last batch (when needed):

```bash
npm run migrate:down
```

Scripts use `migrate:up` and `migrate:down` (colon-separated names), which work reliably across shells and CI.

Core tables are created by these migrations (run in filename order):

| Migration                                    | Tables                                             |
| -------------------------------------------- | -------------------------------------------------- |
| `1771691269865_initial-schema.js`            | `scores`, `remittance_history`                     |
| `1771691269866_loan-events-schema.js`        | `loan_events`, `indexer_state`                     |
| `1772000000000_webhook-subscriptions.js`     | `webhook_subscriptions`                            |
| `1773000000001_user-profiles.js`             | `user_profiles`                                    |
| `1773000000002_loan-history.js`              | `loan_history`                                     |
| `1773000000003_indexed-events.js`            | `indexed_events`                                   |
| `1774000000004_scores-add-created-at.js`     | adds `created_at` to `scores` (idempotent)         |
| `1777000000007_unique-loan-status-events.js` | dedupes and enforces unique status events per loan |

With Docker Compose from the repo root, the `backend` service runs `migrate:up` before `npm run dev` so the schema is applied automatically when the database is healthy.

Full database schema documentation, including every table, column, index, and
historical renames, is available in [`docs/DATABASE.md`](../docs/DATABASE.md).

### Environment Variables

Create a `.env` file in the backend directory:

```env
# Server Configuration
PORT=3001

# CORS Configuration
FRONTEND_URL=http://localhost:3000
# Optional backward-compatible fallback for multiple allowed origins during migration
# CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001

# Stellar Configuration
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
LOAN_MANAGER_CONTRACT_ID=
LOAN_MANAGER_ADMIN_SECRET=

# Future: Add API keys for remittance services
# WISE_API_KEY=your_key_here
# WESTERN_UNION_API_KEY=your_key_here
```

## Available Scripts

```bash
# Development
npm run dev          # Start dev server with hot reload

# Database
npm run migrate:up   # Apply migrations (requires DATABASE_URL)
npm run migrate:down # Roll back last migration batch
npm run seed         # Seed realistic local development data
npm run seed:reset   # Reset and reseed development data

# Production
npm run build        # Compile TypeScript to JavaScript
npm start            # Run production build

# Testing
npm test             # Run test suite
npm test -- --watch  # Run tests in watch mode
npm test -- --coverage  # Run tests with coverage

# Code Quality
npm run lint         # Check code quality
npm run lint:fix     # Fix linting issues
npm run format       # Format code with Prettier
npm run format:check # Check code formatting
```

### Development seed data

New contributors can populate a realistic local dataset after running migrations:

```bash
npm run seed
```

This seeds:

- `user_profiles` with sample borrowers and a lender
- `scores` with varied borrower scores
- `remittance_history` with completed, late, missed, and pending records
- `loan_history` with pending, active, repaid, and defaulted loans
- `loan_events` so borrower dashboards, loan details, pool stats, and SSE endpoints have data
- `notifications` with both read and unread sample messages
- `indexer_state` so interest calculations have a seeded latest ledger

To wipe those local development rows and recreate them from scratch:

```bash
npm run seed:reset
```

## API Endpoints

### Health Check

**GET** `/api/health`

Check if the API is running.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Credit Score

**GET** `/api/score/:userId`

Get the credit score for a specific user based on their remittance history.

**Parameters:**

- `userId` (string) - User identifier

**Response:**

```json
{
  "userId": "user123",
  "score": 750,
  "history": {
    "totalTransactions": 24,
    "averageAmount": 500,
    "consistency": 0.95
  },
  "calculatedAt": "2024-01-15T10:30:00.000Z"
}
```

**Error Responses:**

- `400` - Invalid user ID
- `404` - User not found
- `500` - Server error

### Simulate Remittance

**POST** `/api/score/simulate`

Simulate remittance history for testing purposes.

**Request Body:**

```json
{
  "userId": "user123",
  "transactions": [
    {
      "amount": 500,
      "date": "2024-01-01",
      "recipient": "family_member"
    }
  ]
}
```

**Response:**

```json
{
  "userId": "user123",
  "score": 750,
  "simulationId": "sim_abc123"
}
```

## API Documentation

Interactive API documentation is available via Swagger UI when the server is running outside production, or in production when `ENABLE_SWAGGER=true` is set:

**URL**: [http://localhost:3001/docs](http://localhost:3001/docs)

The raw OpenAPI document is available at [http://localhost:3001/docs.json](http://localhost:3001/docs.json) under the same environment gate.

The Swagger documentation provides:

- Complete endpoint specifications
- Request/response schemas
- Interactive API testing
- Authentication details

For the full auth model (challenge-signature-JWT flow, role-scope table,
API-key namespaces, cookie attributes) see
[docs/SECURITY-MODEL.md](../docs/SECURITY-MODEL.md).

## Project Structure

```
backend/
├── src/
│   ├── __tests__/           # Test files
│   │   ├── health.test.ts
│   │   ├── score.test.ts
│   │   ├── validation.test.ts
│   │   └── errorHandling.test.ts
│   ├── config/              # Configuration files
│   │   └── swagger.ts       # Swagger/OpenAPI config
│   ├── controllers/         # Request handlers
│   │   ├── scoreController.ts
│   │   └── simulationController.ts
│   ├── middleware/          # Express middleware
│   │   ├── asyncHandler.ts  # Async error wrapper
│   │   ├── auth.ts          # Authentication (planned)
│   │   ├── errorHandler.ts  # Error handling
│   │   ├── rateLimiter.ts   # Rate limiting
│   │   └── validation.ts    # Request validation
│   ├── routes/              # API routes
│   │   └── index.ts
│   ├── schemas/             # Zod validation schemas
│   │   ├── scoreSchemas.ts
│   │   └── simulationSchemas.ts
│   ├── e

/* … truncated 4977 chars — edit only what you need near the top … */
