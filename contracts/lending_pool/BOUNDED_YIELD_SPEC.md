# Bounded Yield Distribution Authorization Specification

## Overview

This document defines the bounded yield distribution authorization system for the RemitLend LendingPool contract. The feature implements role-based authorization, per-distribution limits, and cumulative bounds to prevent abuse and enable operational governance of yield distribution.

## Current State (v3)

- **Authorization**: `distribute_yield` requires caller auth (anyone can distribute yield if they provide tokens)
- **Limits**: None (unbounded yield distribution)
- **Roles**: Implicit (only token holder authorization)
- **Events**: `YieldDistributed` event emitted with amount
- **Failure modes**: Only if token transfer fails or total overflow

## Proposed State (v4)

### Authorization Model

**Three authorization paths** for distributing yield:

1. **Admin Path** (primary): Pool admin can distribute yield from any source without per-distribution limits
   - Admin auth required: `admin.require_auth()`
   - Per-distribution limit: None (uses cumulative bound only)
   - Cumulative bound: Configurable per-token, tracks lifetime yield

2. **Authorized Distributor Path** (secondary): Named distributors can distribute yield up to per-distribution limits
   - Admin must authorize specific addresses as `YieldDistributor` role
   - Per-distributor authorization stored and queryable
   - Per-distribution limit: Configurable ceiling per distribution event
   - Cumulative bound: Separate per-distributor or shared by role

3. **Fee/Protocol Path** (tertiary): Protocol sources distribute yield from designated recovery funds
   - Explicit `distribute_fee_yield` function
   - Requires pool's own authorization (self-call or designated account)
   - Per-distribution limit: Protocol-specific bound
   - Reserved for fee sweeps, liquidation proceeds, interest recovery

### Bounds Hierarchy

```
┌─ Per-Distribution Limit (per transaction) ─────────────────┐
│  Applies to: Distributor role only (paths 2 & 3)          │
│  Default: 0 (disabled), Admin can set per-token            │
│  Exceeded → PoolError::YieldExceedsPerDistributionLimit    │
└──────────────────────────────────────────────────────────┘

┌─ Cumulative Limit (per-distributor, per-token, per period) ─┐
│  Applies to: All roles (tracks all yield distributed)       │
│  Default: 0 (disabled), Admin can set globally or per-token │
│  Exceeded → PoolError::YieldExceedsCumulativeLimit          │
└────────────────────────────────────────────────────────────┘

┌─ Pool Utilization Ceiling ─────────────────────────────────┐
│  Implicit: Yield cannot exceed max pool size cap            │
│  Enforced by existing: MaxPoolSize storage key              │
│  Exceeded → PoolError::PoolSizeExceeded                     │
└────────────────────────────────────────────────────────────┘
```

### Storage Extensions

New `DataKey` variants (append to existing enum, preserve ordinals):

```rust
// Authorization and bounds
YieldDistributorAuthorized(Address),           // Set<Address> of authorized distributors
PerDistributionYieldLimit(Address),             // token → max per distribution (stroops)
CumulativeYieldLimit(Address),                  // token → cumulative limit (stroops)
YieldDistributedByDistributor(Address, Address),// (distributor, token) → lifetime total
YieldDistributionPeriod(Address),               // token → period length in ledgers (0=disabled)
YieldDistributionPeriodReset(Address),          // token → ledger seq of last period reset
DistributorCumulativeLimit(Address, Address),   // (distributor, token) → per-distributor cap
```

### Error Codes

Extend `PoolError` enum (append, preserve existing ordinals 1-15):

```rust
// Bounded yield authorization errors
YieldDistributorNotAuthorized = 16,
YieldExceedsPerDistributionLimit = 17,
YieldExceedsCumulativeLimit = 18,
UnauthorizedYieldPath = 19,
FeesNotAvailable = 20,
```

## API Changes

### New Functions (v4)

#### `authorize_yield_distributor(admin: Address, distributor: Address) -> Result<(), PoolError>`
- Admin-only
- Adds `distributor` to authorized set
- If already authorized → noop
- Emits: `YieldDistributorAuthorized(distributor)`

#### `revoke_yield_distributor(admin: Address, distributor: Address) -> Result<(), PoolError>`
- Admin-only
- Removes `distributor` from authorized set
- If not present → noop
- Emits: `YieldDistributorRevoked(distributor)`

#### `set_per_distribution_yield_limit(admin: Address, token: Address, limit: i128) -> Result<(), PoolError>`
- Admin-only
- Sets max yield per single distribution call
- Applies only to distributor role (admin bypasses)
- Emits: `PerDistributionLimitUpdated(token, limit)`

#### `set_cumulative_yield_limit(admin: Address, token: Address, limit: i128) -> Result<(), PoolError>`
- Admin-only
- Sets max cumulative yield that can be distributed in a period
- Applies to all roles
- Emits: `CumulativeLimitUpdated(token, limit)`

#### `set_yield_distribution_period(admin: Address, token: Address, period_ledgers: u32) -> Result<(), PoolError>`
- Admin-only
- Sets period length for cumulative limit resets
- 0 = disabled (cumulative never resets)
- Emits: `YieldDistributionPeriodUpdated(token, period_ledgers)`

#### `get_authorized_distributors(token: Address) -> Vec<Address>`
- Query function
- Returns all authorized distributors for token

#### `get_yield_limits(token: Address) -> (i128, i128, u32)`
- Query function
- Returns (per_distribution_limit, cumulative_limit, period_ledgers)

#### `get_distributor_yield_used(distributor: Address, token: Address) -> i128`
- Query function
- Returns lifetime yield distributed by distributor (unreset cumulative)

### Modified Functions

#### `distribute_yield(from: Address, token: Address, amount: i128) -> Result<(), PoolError>`

**New authorization logic**:
```
1. Check if yield distribution is paused → PoolError::OperationPaused
2. Determine caller's authorization path:
   a. If caller == admin → Admin path (skip per-distribution limit)
   b. If caller in authorized_distributors(token) → Distributor path (check per-distribution limit)
   c. Otherwise → PoolError::YieldDistributorNotAuthorized
3. Require auth from caller
4. Validate amount > 0 → PoolError::InvalidAmount
5. Check per-distribution limit (if Distributor path) → PoolError::YieldExceedsPerDistributionLimit
6. Check cumulative bound (all paths)
   - If period elapsed → reset cumulative, update period timestamp
   - If current + amount > cumulative_limit → PoolError::YieldExceedsCumulativeLimit
7. Transfer from caller to pool
8. Update TotalManagedAssets += amount
9. Emit: YieldDistributed(token, amount, caller_path, limit_check_result)
```

**Breaking change**: Callers must now be authorized (admin or registered distributor).
Existing deployments using arbitrary callers must re-authorize or migrate.

#### `deposit(provider: Address, token: Address, amount: i128, min_shares_out: i128) -> Result<i128, PoolError>`

Minor change: Pool size check now considers recent yield bounds when projecting capacity.

## Validation Rules

### Per-Distribution Limit
- Type: i128 stroops
- Range: 0 (disabled) to i128::MAX
- Validation: 0 <= limit <= i128::MAX (enforced by type)
- Admin-only setter
- Applied only to `Distributor` and `Fee` paths (admin bypasses)

### Cumulative Limit
- Type: i128 stroops
- Range: 0 (disabled) to i128::MAX
- Validation: 0 <= limit <= i128::MAX
- Resets every `period_ledgers` if > 0
- Applied to all paths

### Period Length
- Type: u32 ledgers
- Range: 0 (disabled) to 17280*365 (1 year)
- 0 means cumulative limit never resets
- Admin can change mid-period (resets counter at new ledger)

### Authorization Revocation
- Revoking distributor from active role prevents new distributions
- Existing yield remains credited to distributor's cumulative
- No rollback of past yield events

## Compatibility & Migration

### v3 → v4 Upgrade Path

**Phase 1: Backward compatibility (first block)**
- Deploy contract with authorization checks but with-defaults:
  - Default per-distribution limit: 0 (disabled)
  - Default cumulative limit: 0 (disabled)
  - Admin is auto-authorized
  - All existing callers (if anyone) get 7-day grace period in cumulative tracking

**Phase 2: Grace period (7 days)**
- Emit deprecation warnings in events when non-authorized callers invoke distribute_yield
- Backend monitors for deprecated patterns
- Contributors register new authorized distributors

**Phase 3: Hard cutover**
- Disable grace period
- Only admin and registered distributors can distribute yield
- No breaking change for honest actors (admin unchanged, new distributors pre-registered)

### Storage Migration
- All new `DataKey` entries are optional (default to None/0)
- Existing contracts never called these keys, so no reconciliation needed
- `TotalYieldDistributed` continues to accumulate (unchanged semantics)

### State Snapshots
- Pre-upgrade: Note current `TotalYieldDistributed` and admin per token
- Post-upgrade: Verify totals unchanged, verify admin still authorized
- Integration tests cover deposit → yield → withdraw round-trip

## Audit Events & Observability

### Events Emitted

```rust
pub fn yield_distributor_authorized(env: &Env, distributor: Address, token: Address)
pub fn yield_distributor_revoked(env: &Env, distributor: Address, token: Address)
pub fn per_distribution_limit_updated(env: &Env, token: Address, new_limit: i128)
pub fn cumulative_yield_limit_updated(env: &Env, token: Address, new_limit: i128)
pub fn yield_distribution_period_updated(env: &Env, token: Address, period_ledgers: u32)

// Enhanced YieldDistributed to include distributor path and limit info
pub fn yield_distributed_bounded(
    env: &Env,
    token: Address,
    amount: i128,
    distributor: Address,
    path: Symbol,  // "admin" | "distributor" | "fee"
    cumulative_used: i128,
    limit_applied: i128,
)
```

### Structured Logging (Backend)
- Log all authorize/revoke operations with timestamp and admin
- Log all limit updates with old/new values
- Log each distribution with path taken, amount, limit headroom
- Log cumulative resets with period info

### Metrics
- `yield_distribution_total` (cumulative, by token and path)
- `yield_distribution_current_period` (resetting gauge, by token)
- `yield_distributor_count` (gauge, by token)
- `yield_authorization_failures` (counter, by error code)

## Testing Strategy

### Unit Tests (Rust)

1. **Authorization path selection**
   - Admin can distribute without limit
   - Authorized distributor can distribute up to per-distribution limit
   - Unauthorized caller rejected with `YieldDistributorNotAuthorized`
   - Paused yield rejects all

2. **Per-distribution bounds**
   - Distribution within limit succeeds
   - Distribution exceeding limit rejected with `YieldExceedsPerDistributionLimit`
   - Admin bypass works

3. **Cumulative bounds**
   - Cumulative tracking enabled when limit > 0
   - Period resets cumulative counter
   - Distribution exceeding cumulative limit rejected with `YieldExceedsCumulativeLimit`
   - All paths share cumulative bound

4. **Authorization state mutations**
   - Authorize distributor → queryable
   - Revoke distributor → no longer authorized
   - Duplicate authorize is idempotent
   - Duplicate revoke is idempotent

5. **Limit mutations**
   - Admin can change per-distribution limit mid-stream
   - Admin can change cumulative limit mid-stream
   - Admin can enable/disable period resets
   - Changes apply to next distribution only (no retroactive)

6. **Deposit/withdraw compatibility**
   - Yield distribution increases share price
   - Withdraw after yield realizes distributor's gains
   - Pro-rata yield distribution among depositors

7. **Edge cases**
   - Zero distribution rejected
   - Negative distribution rejected
   - TotalManagedAssets overflow caught
   - Period edge (distribution at ledger T when period expires at T) handled correctly
   - Boundary values (i128::MAX-1, 0, 1)

### Integration Tests
- Authorize distributor → deposit → distribute yield → withdraw
- Multiple distributors tracking independent cumulative counters
- Period reset triggers correctly
- Admin revocation mid-period works
- Yield authorization failure does not leak partial state

### Formal Verification
- Commission invariant: All yield paths increase TotalManagedAssets correctly
- Authorization invariant: Only authorized + authed caller can distribute
- Bound invariant: No distribution exceeds per-distribution or cumulative limit
- Period invariant: Cumulative resets on schedule or stays monotonic

## Threat Model

### Potential Attacks

| ID | Attack | Mitigation |
|---|---|---|
| ATK-7 | Unauthorized yield distribution | Require admin or registered distributor auth; audit events; revocation |
| ATK-8 | Yield distribution beyond pool capacity | Cumulative limit + existing MaxPoolSize check |
| ATK-9 | Replay of authorized distribution | Soroban nonce handling + unique auth context per call |
| ATK-10 | Limit race condition (concurrent txs) | Ledger isolation: only one tx per account per ledger |
| ATK-11 | Distributor revocation during pending tx | Atomic: revocation takes effect before next block; pending tx fails cleanly |
| ATK-12 | Cumulative reset manipulation | Period length immutable during ledger; reset at scheduled boundary only |

### Assumptions

- Admin keys are secure and rotated per security policy
- Authorized distributors are vetted by admin
- Stellar RPC clock is within ±3 minutes (standard)
- No forking or ledger rollbacks mid-upgrade

## Rollback Plan

If critical bug found post-deployment:

1. **Immediate**: Admin revokes all distributors → only admin can distribute yield
2. **Short-term**: Emergency pause on yield via granular pause flags
3. **Long-term**: Redeploy with fixed logic, provide data migration script

To redeploy without losing state:
- Old contract state snapshot → new contract storage init
- Verify cumulative totals and limit tracking match pre-upgrade
- Resume with fixed authorization logic

## Success Criteria

✓ Bounded yield distribution authorized via admin + registered distributors
✓ Per-distribution and cumulative limits enforced
✓ Admin can manage authorized distributors
✓ Backward compatible with v3 (grace period with warnings)
✓ Comprehensive unit + integration test coverage
✓ Events, metrics, and audit logs enable operational visibility
✓ Threat model documented and reviewed
✓ PR includes before/after measurements and rollout plan
