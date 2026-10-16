# Architecture

## Overview

This document describes the high-level architecture of the frontend application, its boundaries, and the operational contracts it must uphold.

## Package Boundaries

This repository is a monorepo with four top-level package groups. Each group owns a
narrow responsibility and may only import from the groups listed as allowed below.
Imports that cross a prohibited edge are rejected in CI (see
[Dependency Enforcement](#dependency-enforcement)).

| Package group | Owns | May import from |
| --- | --- | --- |
| `frontend/` | Presentation, routing, client-side state, offline behavior | `contracts/` (generated types only) |
| `backend/` | API implementation, persistence, chain interaction | `contracts/` (generated types only) |
| `contracts/` | Canonical API schemas, generated types, money policy | nothing in `frontend/`, `backend/`, or `scripts/` |
| `scripts/` | Build, codegen, and CI tooling | `contracts/` (generated types only) |

### Allowed Imports

- `frontend/` → `contracts/` generated artifacts (e.g. `contracts/generated/*`).
- `backend/` → `contracts/` generated artifacts.
- `scripts/` → `contracts/` generated artifacts.
- Any package → its own internal modules.

### Prohibited Imports

- `frontend/` → `backend/` (no direct API implementation coupling).
- `backend/` → `frontend/` (no presentation coupling).
- `contracts/` → `frontend/`, `backend/`, or `scripts/` (contracts must stay dependency-free).
- `scripts/` → `frontend/` or `backend/` (tooling must not depend on app internals).
- Any package importing a hand-copied definition of a shared API or money type
  instead of the canonical artifact in `contracts/`.

### Dependency Cycles

Cycles between package groups are prohibited. Cycles within a single package are
reported as warnings and tracked as exceptions until resolved.

## Dependency Enforcement

CI runs an import-boundary check that:

1. Parses import statements across `frontend/`, `backend/`, `contracts/`, and `scripts/`.
2. Rejects any import matching a prohibited edge above.
3. Builds the package-group import graph and fails on any cycle.
4. Fails when a shared API or money type is defined outside `contracts/` and
   imported from more than one package group.

The check runs on every pull request and blocks merge on failure. New prohibited
imports cannot land without an explicit, reviewed exception.

## Shared Contracts and Money Policy

- API request/response types are generated from the canonical schemas in
  `contracts/` and consumed from the generated artifacts. They are never copied
  into `frontend/` or `backend/`.
- Money policy (minor-unit representation, rounding, and rate units) is owned by
  `contracts/`. Consumers import the canonical money types rather than
  re-declaring them.
- The frontend's loan cost disclosure engine remains the single borrower-facing
  computation surface, but its money types come from `contracts/`.

## Boundary Exceptions

Intentional exceptions to the rules above are inventoried here. Each exception
has an owner and a removal condition; an exception without both is not valid and
must be rejected in review.

| Exception | Owner | Removal condition |
| --- | --- | --- |
| _None currently recorded._ | — | — |

When adding an exception, append a row with the exact import path, the owning
team, and the concrete condition under which the exception will be removed.

## Changing a Cross-Package Contract

To safely change a contract that crosses package boundaries:

1. Update the canonical schema or money type in `contracts/` first.
2. Regenerate the shared artifacts so `frontend/`, `backend/`, and `scripts/`
   consume the new definitions.
3. Update consumers in the same change; do not leave a copied definition behind.
4. Run the dependency-boundary check locally; a new prohibited import or cycle
   fails the build.
5. If a temporary exception is unavoidable, record it in
   [Boundary Exceptions](#boundary-exceptions) with an owner and a removal
   condition before merging.

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

## Observability

- Structured errors are emitted for budget violations and dependency failures.
- Metrics are recorded for route load, render, and bundle dimensions.
- Operational diagnostics distinguish between unsupported environments and genuine regressions.
- Transaction failures are classified before they reach the UI, and carry a
  non-identifying support code (failure category, truncated transaction hash,
  attempt counter) so a support ticket can be correlated without exposing user
  data.

## Testing

Focused automated tests cover success, boundary values, invalid configuration, unsupported environments, and dependency failure paths for route budgets, alongside existing routing and offline tests. Loan cost disclosure and transaction recovery have dedicated unit and component suites covering rounding boundaries, every typed error and failure state, hostile input, stale and unavailable authoritative data, retry safety, and the double-submission invariant.
