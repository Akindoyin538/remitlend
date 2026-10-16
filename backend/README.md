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

### Recovery objectives (RPO/RTO)

A successful backup job does not prove that production data can be restored
within recovery objectives or that the restored database is internally
consistent. The backend therefore defines measured recovery objectives and
verifies them automatically.

| Objective | Definition | Target |
| --- | --- | --- |
| RPO | Maximum acceptable age of the most recent restorable backup | 15 minutes |
| RTO | Maximum acceptable time to restore and reach a consistent, migrated state | 60 minutes |

#### Automated restore verification

Restore verification runs on a defined cadence and is also triggered whenever
the backup format or the database schema/migrations change:

- **Scheduled cadence**: daily at 03:00 UTC via the
  `restore-verification` workflow.
- **Change-triggered**: on pull requests that modify backup tooling
  (`backend/scripts/backup*`), migration files (`backend/migrations/**`), or the
  restore verification workflow itself.

Each run restores the most recent encrypted backup into a disposable, isolated
environment, runs integrity checks, and records evidence. The recorded evidence
for every run includes:

- **Backup age**: age of the restored backup at the start of the run, compared
  against the RPO target.
- **Restore duration**: wall-clock time from restore start to a consistent,
  migrated database, compared against the RTO target.
- **Migration state**: the applied migration version and whether the restored
  schema matches the expected migration head.
- **Integrity-check outcome**: result of the post-restore integrity checks
  (row counts, foreign-key validation, and checksum comparison against the
  source backup manifest).

#### Failure handling

- A failed verification pages the owning team (Backend on-call) through the
  same alerting path as the SLO alerts above.
- When the configured recovery objective is unmet (backup age exceeds RPO or
  restore duration exceeds RTO), the verification fails and blocks release:
  the `restore-verification` check is required on release pull requests and a
  failing check prevents merge and deployment.

#### Isolation and data handling

- Restore verification runs in a disposable environment with its own isolated
  credentials; it never connects to production.
- Test data and credentials are scoped to the run and destroyed after each run,
  so no production data is exposed and no restore artifacts persist.

#### Evidence retention

- Evidence for each run (backup age, restore duration, migration state, and
  integrity-check outcome) is retained for 90 days to support audits and
  post-incident review.
- The database recovery procedures are updated with the measured RPO/RTO and
  this evidence retention policy.
