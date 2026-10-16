# Handsoff

Handsoff is a decentralized lending protocol. This repository contains the
frontend, API, indexer, and supporting infrastructure for borrower and lender
critical journeys.

## Service Level Objectives (SLOs)

This section defines the service-level indicators (SLIs) and objectives for the
critical user journeys across the frontend, API, indexer, RPC confirmation, and
notification dependencies. It is the source of truth for alerting and
error-budget policy.

### Critical journeys

- **Borrower — loan request**: a borrower submits a loan request and it is
  accepted on-chain.
- **Borrower — loan repayment**: a borrower repays an outstanding loan and the
  repayment is reflected in the UI.
- **Lender — inspect eligible funds**: a lender loads the pool and sees eligible
  funds available to withdraw.
- **Lender — withdraw**: a lender submits a withdrawal and the funds are
  reflected in their wallet and in the UI.

### SLI definitions

Each SLI has a precise event definition, an eligible denominator, and an
exclusion policy. Latency SLIs are measured separately for **transaction
submission**, **chain finality**, and **indexer projection lag** so that a slow
chain or a lagging indexer is not conflated with an application failure.

| SLI | Event definition | Eligible denominator | Exclusions |
| --- | --- | --- | --- |
| `frontend_availability` | Successful page load (HTTP 2xx/3xx) of a journey entry route | All page-load requests to journey entry routes | Synthetic probes, bot traffic, requests from internal IPs |
| `api_request_success` | API request returns a non-5xx response | All API requests for journey endpoints | Client 4xx (user error), requests rejected by rate limiting |
| `tx_submission_latency` | Time from user submit to transaction accepted into the mempool | All user-initiated journey transactions | Transactions rejected client-side before submission |
| `chain_finality_latency` | Time from mempool acceptance to the configured confirmation depth | All submitted journey transactions | Reorged transactions, transactions dropped from the mempool |
| `indexer_projection_lag` | Time from on-chain finality to the event being queryable via the indexer | All indexed journey events | Events from blocks before the indexer's start height |
| `notification_delivery` | Notification delivered to the user's channel within the delivery window | All journey notifications enqueued | Notifications suppressed by user preferences |

### Objectives

| SLI | Objective | Window |
| --- | --- | --- |
| `frontend_availability` | 99.9% | 30 days |
| `api_request_success` | 99.9% | 30 days |
| `tx_submission_latency` | p95 < 2s | 30 days |
| `chain_finality_latency` | p95 < 60s | 30 days |
| `indexer_projection_lag` | p95 < 30s | 30 days |
| `notification_delivery` | 99% within 5 minutes | 30 days |

### Alerts

Alerts are tied to user impact. Each alert has an owner, a runbook reference,
and an actionable threshold. Dashboards separate dependency outages (RPC,
indexer, notification provider) from application failures and avoid
high-cardinality labels (no per-user, per-tx-hash, or per-address labels).

| Alert | Condition | Owner | Runbook |
| --- | --- | --- | --- |
| `FrontendAvailabilityBurn` | Fast burn: 2% budget in 1h | Frontend on-call | `docs/runbooks/frontend-availability.md` |
| `ApiRequestSuccessBurn` | Fast burn: 2% budget in 1h | API on-call | `docs/runbooks/api-request-success.md` |
| `TxSubmissionLatencyHigh` | p95 > 2s for 10m | Protocol on-call | `docs/runbooks/tx-submission-latency.md` |
| `ChainFinalityLatencyHigh` | p95 > 60s for 15m | Protocol on-call | `docs/runbooks/chain-finality-latency.md` |
| `IndexerProjectionLagHigh` | p95 > 30s for 10m | Indexer on-call | `docs/runbooks/indexer-projection-lag.md` |
| `NotificationDeliveryLow` | < 99% within 5m for 30m | Notifications on-call | `docs/runbooks/notification-delivery.md` |

Dependency outages are surfaced on a separate dashboard panel from application
failures so that an RPC or indexer outage does not page the application on-call
for an application defect.

### Review cadence and error-budget policy

- SLOs are reviewed monthly by the owning teams; targets and exclusions are
  updated when journeys or dependencies change.
- When an error budget is exhausted, feature work for the affected journey is
  paused and reliability work takes priority until the budget recovers.
- Fast-burn alerts page the owning on-call; slow-burn alerts open a ticket for
the next business day.
- Every alert must link to its runbook and have a named owner before it is
  enabled in production.
