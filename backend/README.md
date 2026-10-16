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

## Container Hardening (Production)

Production images and Compose services run with least privilege and an immutable
root filesystem. The backend container:

- Runs as the non-root `node` user (UID/GID 1000) with `no-new-privileges`.
- Drops all Linux capabilities and adds back none.
- Mounts the root filesystem read-only (`read_only: true`).
- Receives only the writable paths it needs through explicit `tmpfs` mounts:
  `/tmp` (build/scratch) and `/app/.cache` (runtime caches).
- Reads secrets from the approved runtime mechanism (environment/secret files
  injected by the orchestrator) — never baked into image layers.

### Local development differences

Local development is intentionally more permissive: `npm run dev` runs on the
host with a writable filesystem and hot reload, and the Compose dev profile does
not enable `read_only` or capability drops. Only the production profile applies
the hardened runtime settings.

### Production verification commands

```bash
# Confirm the process is not root and has no added capabilities
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backend id
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backend \
  grep -E 'Cap(Eff|Prm|Bnd)' /proc/1/status

# Confirm the root filesystem is read-only and tmpfs mounts are present
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backend \
  sh -c 'touch /app/forbidden 2>&1 || echo "rootfs is read-only"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backend mount | grep tmpfs

# Confirm health checks and graceful shutdown still work
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop backend

# Scan images for privileged settings and unexpected writable paths
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy image --severity HIGH,CRITICAL remitlend-backend:latest
```

Integration tests assert that the production Compose service sets
`read_only: true`, `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`,
and declares the expected `tmpfs` writable paths, so regressions are caught in CI.

## Backend Performance Budgets

The load-test workflow (`.github/workflows/load-test.yml`) enforces latency and
resource budgets for critical read and preview routes. Budgets are version-controlled
in `backend/perf/budgets.json` and compared against a stored baseline in
`backend/perf/baseline.json` on every run.

### Critical routes under budget

| Route                          | Method | p50 (ms) | p95 (ms) | Error rate | Heap (MB) | DB queries | RPC calls |
| ------------------------------ | ------ | -------- | -------- | ---------- | --------- | ---------- | --------- |
| `/api/health`                  | GET    | 25       | 75       | 0.5%       | 256       | 0          | 0         |
| `/api/score/:userId`           | GET    | 120      | 350      | 1.0%       | 384       | 4          | 0         |
| `/api/score/simulate` (preview)| POST   | 200      | 600      | 1.0%       | 384       | 2          | 0         |
