# Architecture

## Overview

This document describes the high-level architecture of the frontend application, its boundaries, and the operational contracts it must uphold.

## Frontend Boundary

The frontend is a single-page application responsible for:

- Rendering user-visible status derived from authoritative backend sources.
- Managing client-side routing, data fetching, caching, and offline behavior.
- Enforcing client-side performance and resource budgets.

Backend APIs, persisted data, and chain state remain authoritative. The frontend never invents financial values or chain state; it only reflects them.

## Routing

Routes are declared centrally and each route is associated with a lazy-loaded module boundary. Route transitions must remain compatible with existing deep links and persisted navigation state.

## Route-Level Performance Budgets

To keep the application responsive and to catch regressions early, each route declares an explicit performance budget. Budgets are validated at runtime and reported through structured diagnostics.

### Budget Dimensions

- **Load time**: maximum time from route navigation start to the route's first meaningful render.
- **Render time**: maximum time for the route's initial render commit.
- **Bundle size**: maximum transferred JavaScript size attributable to the route's lazy chunk.

### Thresholds

Thresholds are defined per route and are intentionally conservative. A route without an explicit budget inherits the default budget. Budgets are validated to be positive, finite numbers; invalid budgets are rejected and fall back to the default rather than disabling enforcement.

### Enforcement and Bounded Resource Usage

- Measurement uses the browser Performance API when available and degrades gracefully when it is not.
- Observers are bounded: a single performance observer per route, disconnected after the route settles, to avoid unbounded listener growth.
- Budget checks are non-blocking and never delay rendering or navigation.

### Failure and Diagnostics

- A budget violation emits a structured error event containing the route, the dimension, the observed value, and the configured threshold.
- Violations are reported as metrics so they can be aggregated and alerted on in production.
- Missing or unsupported performance APIs are treated as a non-fatal condition and reported as a diagnostic, not an error.

### Compatibility and Rollback

- Budget enforcement is observational only; it does not alter routing, rendering, or user-visible status.
- Budgets can be relaxed or disabled per route without changing route behavior, providing a safe rollback path.
- Existing routes, deep links, and persisted navigation state remain fully compatible.

## Offline Support

Offline state is tracked centrally and surfaced through a banner. Data fetching uses a unified query key scheme so cached data remains consistent across hooks and components.

## Deferred Wallet SDK Loading

The wallet SDK is loaded lazily to keep the initial bundle small and to avoid blocking first paint. Route-level budgets account for the deferred load so that wallet-dependent routes still meet their thresholds.

## Loan Cost Disclosure

All borrower-facing money is computed by one exact-arithmetic engine
(`frontend/src/app/utils/loanCostDisclosure.ts`) and rendered by one component
(`LoanCostDisclosurePanel`). Amounts are `bigint` minor units and rates are
integer basis points, so the disclosed total is always the sum of the disclosed
components. The lending pool amortization returned by the backend is the
settlement source of record; the local computation is an estimate that is
reconciled against it, and any divergence is surfaced rather than absorbed. A
borrower is never asked to sign a request whose cost cannot be computed.

See [docs/loan-cost-disclosure.md](docs/loan-cost-disclosure.md).

## Transaction Recovery

Every wallet-connected failure is classified into a typed failure state
(`rejected`, `expired`, `failed`, `unknown`) and turned into a recovery plan by
a pure function (`planTransactionRecovery`). The plan always states whether
resubmission is safe. **Once a signed transaction has been handed to the
network, the plan contains no action that can create a second one** — the only
safe actions are re-polling the same hash, inspecting the explorer, copying the
transaction id, reloading, or contacting support. Status polling is bounded
(`maxAttempts`, `requestTimeoutMs`, overall `timeoutMs`) and abort-aware, and it
reports a dependency failure separately from a settled failure so an unreachable
node is never presented as a failed transaction.

See [docs/transaction-recovery-ux.md](docs/transaction-recovery-ux.md).

## Service-Level Objectives

Component health checks answer "is the service up?". They do not answer "can a
borrower request or repay a loan, or can a lender inspect and withdraw eligible
funds, within an acceptable time?". This section defines the service-level
indicators (SLIs) and objectives (SLOs) for those critical journeys, spanning the
frontend, API, indexer, RPC confirmation, and notification dependencies.

### SLI conventions

Every SLI below is defined by three things, and all three are required for the
SLI to be valid:

- **Event definition** — the precise, countable event, expressed as a ratio of
  `good events / eligible events`.
- **Eligible denominator** — exactly which requests or operations count toward
  the denominator. Anything not listed is out of scope for the SLI.
- **Exclusion policy** — the explicit, auditable reasons an event is dropped
  from both numerator and denominator. Exclusions are applied before the ratio
  is computed and are themselves counted, so an exclusion spike is visible
  rather than silently improving the SLI.

Latency SLIs are measured as the fraction of eligible events completing within
the stated threshold (a "good-over-total" ratio), not as an average, so a slow
tail cannot be hidden by fast median traffic.

### Journey SLIs

| Journey | SLI | Event definition (good / eligible) | Eligible denominator | Exclusion policy | Objective |
| --- | --- | --- | --- | --- | --- |
| Borrower — request loan | Request success | `POST /loans` returning a signed, accepted request / all `POST /loans` attempts | Authenticated borrower requests that reach the API | Client-side validation failures before submission; user-cancelled wallet prompts; duplicate submissions deduplicated by idempotency key | 99.5% over 28d |
| Borrower — request loan | Submission latency | Requests acknowledged by the API within 2s / all eligible requests | Same as above | Same as above | 95% within 2s |
| Borrower — repay loan | Repayment success | `POST /loans/{id}/repay` accepted / all repayment attempts | Authenticated repayments for an active loan | Client-side validation failures; user-cancelled wallet prompts; repayments for already-settled loans | 99.5% over 28d |
| Borrower — repay loan | Submission latency | Repayments acknowledged within 2s / all eligible repayments | Same as above | Same as above | 95% within 2s |
| Lender — inspect eligible funds | Eligibility read freshness | Eligibility reads served from a projection no more than 30s behind chain head / all eligibility reads | Authenticated lender eligibility reads | Reads served from cache younger than the projection TTL; reads for lenders with no position | 99% within 30s |
| Lender — withdraw | Withdrawal success | `POST /withdrawals` accepted / all withdrawal attempts | Authenticated withdrawals for a lender with eligible funds | Client-side validation failures; user-cancelled wallet prompts; withdrawals for ineligible balances | 99.5% over 28d |
| Lender — withdraw | Submission latency | Withdrawals acknowledged within 2s / all eligible withdrawals | Same as above | Same as above | 95% within 2s |

### Latency stages are measured separately

A single end-to-end number hides which dependency is slow. Each transaction
journey therefore reports three distinct stages, and each has its own objective:

- **Transaction submission** — from the user confirming in the wallet to the API
  acknowledging the request. This isolates frontend and API responsiveness.
- **Chain finality** — from submission acknowledgement to the transaction being
  observed as final on chain. This isolates RPC and network confirmation, and is
  reported separately from submission so a slow chain is never attributed to the
  application.
- **Indexer projection lag** — from chain finality to the indexer projection
  reflecting the change. This isolates the indexer and is the stage that governs
  eligibility-read freshness for lenders.

Submission, finality, and projection lag are never summed into one SLI; a
regression in one stage must be attributable without inspecting the others.

### Alerts

Every alert is tied to user impact, not to a component's internal state, and
carries an owner, a runbook, and an actionable threshold.

| Alert | User impact | Threshold | Owner | Runbook |
| --- | --- | --- | --- | --- |
| Borrower request/repay success below objective | Borrowers cannot request or repay loans | Burn rate > 2x over 1h | Payments on-call | `docs/runbooks/borrower-journey.md` |
| Submission latency below objective | Borrowers wait on an unresponsive request | 95th percentile > 2s for 10m | Frontend on-call | `docs/runbooks/submission-latency.md` |
| Chain finality below objective | Submitted transactions do not settle | 95th percentile > 60s for 15m | Chain on-call | `docs/runbooks/chain-finality.md` |
| Indexer projection lag above objective | Lenders see stale eligible funds | Lag > 30s for 10m | Indexer on-call | `docs/runbooks/indexer-lag.md` |
| Lender withdrawal success below objective | Lenders cannot withdraw eligible funds | Burn rate > 2x over 1h | Payments on-call | `docs/runbooks/lender-journey.md` |
| Notification delivery failure | Users miss status changes they depend on | Failure rate > 5% for 15m | Notifications on-call | `docs/runbooks/notifications.md` |

### Dashboards

Dashboards separate dependency outages from application failures so an
unreachable RPC node or indexer is never presented as an application bug:

- Application panels (frontend, API) and dependency panels (RPC, indexer,
  notifications) are distinct rows with distinct alerting.
- Dependency failures are reported as dependency failures, consistent with the
  transaction-recovery contract above.
- Labels are limited to low-cardinality dimensions (journey, stage, outcome,
  dependency). User identifiers, transaction hashes, and other unbounded values
  are never used as metric labels; they belong in logs and support codes.

### Review cadence and error-budget response

- SLOs are reviewed on a monthly cadence, and after any incident that consumes
  more than 25% of a journey's error budget.
- When a journey's error budget is exhausted, feature work for that journey
  pauses and reliability work takes priority until the budget recovers.
- When burn rate exceeds 2x, the owning on-call follows the linked runbook and
  records the outcome; recurring causes feed back into the next review.

## Observability

- Structured errors are emitted for budget violations and dependency failures.
- Metrics are recorded for route load, render, and bundle dimensions.
- Operational diagnostics distinguish between unsupported environments and genuine regressions.
- Transaction failures are classified before they reach the UI, and carry a
  non-identifying support code (failure category, truncated transaction hash,
  attempt counter) so a support ticket can be correlated without exposing user
  data.
- Journey SLIs are recorded per stage (submission, finality, projection lag) with
  low-cardinality labels, and dependency failures are recorded separately from
  application failures.

## Testing

Focused automated tests cover success, boundary values, invalid configuration, unsupported environments, and dependency failure paths for route budgets, alongside existing routing and offline tests. Loan cost disclosure and transaction recovery have dedicated unit and component suites covering rounding boundaries, every typed error and failure state, hostile input, stale and unavailable authoritative data, retry safety, and the double-submission invariant.
