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

## NFT Transfer Authorization

NFT transfers that require an off-chain signature use a domain-separated,
EIP-712-style typed digest. The digest binds the authorization to the chain
(`chainId`), the verifying contract address, and a transfer-specific typehash /
purpose tag, so a signature produced for one domain or purpose can never be
replayed against another. The signed payload additionally binds the token
address, `from`, `to`, `tokenId`, a per-signer `nonce`, and a `deadline`.

### Validation

- The domain (chain id, verifying contract, typehash) must match the deployed
  contract exactly; mismatches are rejected with an explicit error.
- The payload fields must match the transfer being executed; any mismatch is
  rejected.
- Expired authorizations (`deadline` in the past) are rejected.
- Nonces are single-use; a replayed nonce is rejected.

### Compatibility and Rollout

The existing transfer entrypoints remain unchanged and continue to work. The
domain-separated authorization path is versioned and opt-in, so deployed
contracts and existing API consumers are unaffected until they explicitly
adopt the new path. Rollout is staged: deploy the new path alongside the legacy
entrypoint, migrate consumers, then retire the legacy path in a later release.

### Failure, Retry, and Rollback

- Authorization failures are typed and surfaced to the caller; they are not
  retried automatically because a rejected signature will not become valid on
  retry.
- Transient dependency failures (e.g. RPC unavailability) are distinguished
  from authorization failures and may be retried with bounded attempts.
- Rollback is a configuration change: consumers can fall back to the legacy
  entrypoint without a contract redeploy.

### Observability

Authorization failures emit structured errors carrying the failure category
(domain mismatch, payload mismatch, expired, replayed nonce) without exposing
signature material, and are recorded as metrics for alerting.

## Bounded Authorized-Minter Rotation

Minter rotation is a privileged, owner/admin-only operation that replaces the
contract's authorized minter. It is deliberately bounded so a compromised or
buggy admin key cannot churn the minter set without limit.

### Authorization

- Only the contract owner/admin may call `rotateMinter`. Any other caller is
  rejected with a distinct `NotAuthorized` error before any state is read or
  written.
- Authorization is checked first so unauthorized callers cannot probe rotation
  state (current minter, rotation index, cooldown) through revert reasons.

### Validation and Structured Errors

Inputs are validated with distinct, documented error codes so callers and
monitoring can tell failure modes apart:

- `NotAuthorized` — caller is not the owner/admin.
- `ZeroAddress` — the proposed minter is the zero address.
- `UnchangedMinter` — the proposed minter equals the current minter.
- `RotationLimitReached` — the maximum number of rotations has been consumed.
- `RotationCooldown` — the cooldown between rotations has not elapsed.

### Bounded Resource Usage

- A hard `maxRotations` cap bounds the total number of rotations over the
  contract's lifetime; once reached, further rotations revert with
  `RotationLimitReached`.
- A `rotationCooldown` enforces a minimum interval between rotations, bounding
  the rate of change even while the cap is not yet exhausted.
- Both bounds are checked before mutating state, so a rejected rotation leaves
  the current minter, rotation index, and timestamps untouched.

### Observability and Audit

Every successful rotation emits a `MinterRotated` event carrying the previous
minter, the new minter, and the rotation index, providing an on-chain audit
trail. Rejected rotations revert with their structured error code and do not
emit the event.

### Compatibility and Rollback

- The existing minter authorization surface is preserved; rotation only changes
  which address is authorized, not how authorization is consumed.
- Rotation state (current minter, rotation index, last-rotation timestamp) is
  persisted on-chain and readable, so off-chain consumers can reconcile.

## Deterministic Liquidation Unwind Policy

When a loan becomes liquidatable, the contracts apply a **deterministic unwind
policy** rather than an open-ended auction. The policy is a pure function of
on-chain state (collateral, debt, oracle price, and configured parameters), so
the same inputs always produce the same unwind plan and settlement outcome.
This keeps financial arithmetic and user-visible status derived from
authoritative on-chain sources only.

### Authorization

- Anyone may trigger `liquidate(loanId)` once the loan is liquidatable; the
  policy itself constrains the outcome, so permissionless triggering cannot
  extract more than the deterministic plan allows.
- The liquidator receives a bounded incentive (capped liquidation bonus) taken
  from the collateral, never from other borrowers or the pool's principal.
- A privileged `pauseLiquidation` / `unpauseLiquidation` (owner/admin only) can
  halt unwinds during incident response; unauthorized callers are rejected with
  `NotAuthorized` before any state is read.

### Validation and Structured Errors

- `NotLiquidatable` — health factor is at or above the liquidation threshold.
- `AlreadyUnwinding` — the loan is already in the unwind state (idempotency
  guard against duplicate triggers).
- `StalePrice` — the oracle price is older than `maxPriceAge`; unwinds never
  settle against stale data.
- `InvalidPrice` — the oracle returned a non-positive price.
- `LiquidationPaused` — unwinds are administratively paused.
- `InsufficientCollateral` — the deterministic plan would exceed available
  collateral; the plan is clamped to the collateral actually held.

### Deterministic Plan and Bounded Resource Usage

- The unwind plan is computed in a single pass over the loan's collateral
  entries with a hard `maxCollateralEntries` cap; exceeding the cap reverts with
  `TooManyCollateralEntries` rather than looping unboundedly.
- The repay amount is `min(debt, collateralValue * closeFactor)` using integer
  minor units and basis points, so arithmetic is exact and never over-repays.
- The liquidation bonus is capped by `maxLiquidationBonusBps`; the plan never
  transfers more collateral than is held.
- No unbounded loops, external calls in loops, or unbounded retries exist in the
  unwind path.

### Failure, Retry, and Rollback

- Reverts are atomic: a failed unwind leaves debt, collateral, and loan status
  unchanged, so a caller can safely retry after fixing the precondition (e.g.
  waiting for a fresh oracle price).
- Transient dependency failures (oracle/RPC unavailability) surface as typed
  errors distinct from policy rejections and may be retried with bounded
  attempts off-chain.
- Rollback is administrative: `pauseLiquidation` halts unwinds without a
  redeploy, and unpausing restores the prior deterministic behavior.

### Observability and Audit

- Every unwind emits a `LiquidationUnwound` event carrying the loan id, repaid
  amount, seized collateral, bonus paid, and the oracle price used, forming an
  on-chain audit trail.
- Rejected unwinds revert with their structured error code and emit no event.
- Off-chain consumers derive loan status from these events and on-chain state,
  never from client-side estimates.

### Compatibility and Rollout

- The unwind policy is additive: existing loan, collateral, and repayment
  entrypoints are unchanged, and persisted loan records remain readable.
- Rollout is staged: deploy the policy, enable it behind the pause flag, verify
  against a staging oracle, then unpause in production.
- Because the plan is deterministic, off-chain indexers and API consumers can
  reproduce the expected outcome before the transaction lands.
