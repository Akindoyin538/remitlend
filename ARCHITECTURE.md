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

## Cross-Contract Interface Compatibility

The loan manager, lending pool, NFT, and backend clients evolve independently.
A function rename or changed return semantics can compile locally yet break a
deployed contract integration at runtime. To prevent this, public contract
interfaces are pinned by **versioned compatibility fixtures** and checked in CI
before any contract or client ABI change merges.

### Versioned Fixtures

Fixtures live under `contracts/compatibility/fixtures/` and are named by
interface version (for example `loan_manager.v1.json`). Each fixture captures
the surface used by production flows:

- Function names and argument order/types.
- Return shape.
- Emitted events.
- Error codes.

### Compatibility Check

A deterministic check (`contracts/compatibility/check.ts`) compares the current
contract artifacts and client adapters against the declared baseline fixture.
It requires no mainnet credentials and runs entirely against local artifacts.

- A **breaking change** (removed/renamed function, reordered or retyped
  argument, changed return shape, removed event, or changed error code) fails
  the check unless the fixture declares an explicit version bump.
- Additive, backward-compatible changes pass without a version bump.

### CI Enforcement

The check is wired into the reusable contract-compatibility workflow so it runs
before contract or client ABI changes merge. At least one end-to-end loan
lifecycle test exercises the loan manager against the compatibility fixture.

### Supported Version Matrix

Supported contract/client version combinations are documented in the
network-contract matrix (`docs/network-contract-matrix.md`). A client must only
be deployed against a contract version listed as compatible for it.

## Observability

- Structured errors are emitted for budget violations and dependency failures.
- Metrics are recorded for route load, render, and bundle dimensions.
- Operational diagnostics distinguish between unsupported environments and genuine regressions.
- Transaction failures are classified before they reach the UI, and carry a
  non-identifying support code (failure category, truncated transaction hash,
  attempt counter) so a support ticket can be correlated without exposing user
  data.

## Testing

Focused automated tests cover success, boundary values, invalid configuration, unsupported environments, and dependency failure paths for route budgets, alongside existing routing and offline tests. Loan cost disclosure and transaction recovery have dedicated unit and component suites covering rounding boundaries, every typed error and failure state, hostile input, stale and unavailable authoritative data, retry safety, and the double-submission invariant. Cross-contract interface compatibility is covered by fixture-driven checks and an end-to-end loan lifecycle test.
