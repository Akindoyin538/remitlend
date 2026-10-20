# Bounded Yield Distribution Authorization: Architecture and API Documentation

## Architecture Overview

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ LendingPool Contract (v4)                                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Core Pool Operations (unchanged from v3)                     │ │
│  │ ├─ deposit(provider, token, amount, min_shares)              │ │
│  │ ├─ withdraw(provider, token, shares, min_assets)             │ │
│  │ ├─ emergency_withdraw(provider, token, shares, min_assets)   │ │
│  │ ├─ initialize(admin)                                         │ │
│  │ └─ set_withdrawal_cooldown(cooldown)                         │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Bounded Yield Authorization (new in v4)                      │ │
│  │ ├─ distribute_yield(from, token, amount)                     │ │
│  │ │  └─ [NEW] Checks: authorization + per-dist limit + cumul  │ │
│  │ ├─ authorize_yield_distributor(admin, token, distributor)    │ │
│  │ ├─ revoke_yield_distributor(admin, token, distributor)       │ │
│  │ ├─ set_per_distribution_yield_limit(admin, token, limit)     │ │
│  │ ├─ set_cumulative_yield_limit(admin, token, limit)           │ │
│  │ └─ set_yield_distribution_period(admin, token, period)       │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Query Functions (new in v4)                                  │ │
│  │ ├─ get_authorized_distributors(token) -> Vec<Address>        │ │
│  │ ├─ get_yield_limits(token) -> (per_dist, cumul, period)      │ │
│  │ └─ get_distributor_yield_used(distributor, token) -> i128    │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Storage (extended in v4)                                      │ │
│  │ ├─ YieldDistributorsSet(token) -> Set<Address>               │ │
│  │ ├─ PerDistributionYieldLimit(token) -> i128                  │ │
│  │ ├─ CumulativeYieldLimit(token) -> i128                       │ │
│  │ ├─ YieldDistributionPeriod(token) -> u32                     │ │
│  │ ├─ YieldDistributionPeriodReset(token) -> u32                │ │
│  │ └─ DistributorCumulativeYield(dist, token) -> i128           │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Events (extended in v4)                                       │ │
│  │ ├─ YieldDistributorAuthorized(token, distributor)            │ │
│  │ ├─ YieldDistributorRevoked(token, distributor)               │ │
│  │ ├─ PerDistributionLimitUpdated(token, limit)                 │ │
│  │ ├─ CumulativeYieldLimitUpdated(token, limit)                 │ │
│  │ └─ YieldDistributionPeriodUpdated(token, period)             │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Authorization Flow

```
distribute_yield(from, token, amount)
│
├─ from.require_auth()
│
├─ assert_not_paused() && assert_yield_not_paused()
│  │
│  └─ ✗ PoolError::OperationPaused
│
├─ amount > 0?
│  │
│  └─ ✗ PoolError::InvalidAmount
│
├─ check_yield_authorization(from, token, amount)
│  │
│  ├─ from == admin?
│  │  ├─ YES → Authorization path: ADMIN (no per-dist limit)
│  │  │
│  │  └─ NO → Is from in YieldDistributorsSet(token)?
│  │     │
│  │     ├─ YES → Authorization path: DISTRIBUTOR
│  │     │  │
│  │     │  └─ Check per_distribution_yield_limit
│  │     │     └─ amount > limit? → ✗ YieldExceedsPerDistributionLimit
│  │     │
│  │     └─ NO → ✗ YieldDistributorNotAuthorized
│  │
│  └─ ✓ Authorization granted
│
├─ check_and_update_cumulative_yield(from, token, amount)
│  │
│  ├─ Cumulative limit disabled (0)?
│  │  └─ YES → Continue
│  │
│  └─ Period elapsed since last reset?
│     ├─ YES → Reset cumulative counter to 0, update reset timestamp
│     │
│     └─ Check: current_cumulative + amount > cumulative_limit?
│        └─ YES → ✗ YieldExceedsCumulativeLimit
│        └─ NO → Update distributor_cumulative_yield
│
├─ Transfer amount from (from) to pool
│
├─ Update TotalManagedAssets += amount
│
├─ Emit YieldDistributed(token, amount)
│
└─ Emit PriceUpdated(token, ledger_seq, total_managed_assets, total_shares)
   │
   └─ ✓ Success
```

### Data Model

#### Storage Schema (new in v4)

```rust
// Authorization state
YieldDistributorsSet(token: Address)
  → Vec<Address> of authorized distributors

// Per-distribution limits
PerDistributionYieldLimit(token: Address)
  → i128 (stroops, 0 = unlimited)

// Cumulative limits
CumulativeYieldLimit(token: Address)
  → i128 (stroops, 0 = unlimited)

// Period configuration
YieldDistributionPeriod(token: Address)
  → u32 (ledgers, 0 = no resets)

YieldDistributionPeriodReset(token: Address)
  → u32 (ledger sequence of last reset)

// Cumulative tracking (resets per period)
DistributorCumulativeYield(distributor: Address, token: Address)
  → i128 (stroops accumulated in current period)
```

#### Error Codes (new in v4)

```rust
pub enum PoolError {
    // ... existing codes 1-15 ...
    
    // New bounded yield errors
    YieldDistributorNotAuthorized = 16,
    YieldExceedsPerDistributionLimit = 17,
    YieldExceedsCumulativeLimit = 18,
    UnauthorizedYieldPath = 19,
}
```

## API Reference

### Admin Functions (Bounded Yield)

All admin functions require `admin.require_auth()` and return `Result<(), PoolError>`.

#### `authorize_yield_distributor(admin: Address, token: Address, distributor: Address) -> Result<(), PoolError>`

**Purpose**: Grant yield distribution privileges to a specific account.

**Parameters**:
- `admin` (Address): The pool admin (must have signature)
- `token` (Address): The token address (identified which pool to configure)
- `distributor` (Address): Address to authorize

**Behavior**:
- Requires admin auth
- Adds `distributor` to `YieldDistributorsSet(token)`
- Idempotent: authorizing already-authorized account is a no-op
- Emits `YieldDistributorAuthorized(token, distributor)` event

**Errors**:
- `UnauthorizedYieldPath`: Caller is not the pool admin

**Example**:
```bash
soroban contract invoke \
  --contract <POOL_ID> \
  --source <ADMIN_KEY> \
  -- authorize_yield_distributor \
  --admin <ADMIN_ADDRESS> \
  --token <TOKEN_ADDRESS> \
  --distributor <DISTRIBUTOR_ADDRESS>
```

#### `revoke_yield_distributor(admin: Address, token: Address, distributor: Address) -> Result<(), PoolError>`

**Purpose**: Revoke yield distribution privileges.

**Parameters**:
- `admin` (Address): The pool admin (must have signature)
- `token` (Address): The token address
- `distributor` (Address): Address to revoke

**Behavior**:
- Requires admin auth
- Removes `distributor` from `YieldDistributorsSet(token)`
- Idempotent: revoking non-authorized account is a no-op
- Emits `YieldDistributorRevoked(token, distributor)` event

**Errors**:
- `UnauthorizedYieldPath`: Caller is not the pool admin

**Example**:
```bash
soroban contract invoke \
  --contract <POOL_ID> \
  --source <ADMIN_KEY> \
  -- revoke_yield_distributor \
  --admin <ADMIN_ADDRESS> \
  --token <TOKEN_ADDRESS> \
  --distributor <DISTRIBUTOR_ADDRESS>
```

#### `set_per_distribution_yield_limit(admin: Address, token: Address, limit: i128) -> Result<(), PoolError>`

**Purpose**: Set the maximum yield amount per single distribution call.

**Parameters**:
- `admin` (Address): The pool admin (must have signature)
- `token` (Address): The token address
- `limit` (i128): Max stroops per distribution (0 = unlimited)

**Behavior**:
- Requires admin auth
- Sets `PerDistributionYieldLimit(token) = limit`
- Applies only to distributor-path callers (admin bypasses)
- Takes effect on next `distribute_yield` call
- Emits `PerDistributionLimitUpdated(token, limit)` event

**Errors**:
- `InvalidAmount`: limit < 0
- `UnauthorizedYieldPath`: Caller is not the pool admin

**Example**:
```bash
# Set 1M stroops per distribution
soroban contract invoke \
  --contract <POOL_ID> \
  --source <ADMIN_KEY> \
  -- set_per_distribution_yield_limit \
  --admin <ADMIN_ADDRESS> \
  --token <TOKEN_ADDRESS> \
  --limit 1000000000
```

#### `set_cumulative_yield_limit(admin: Address, token: Address, limit: i128) -> Result<(), PoolError>`

**Purpose**: Set the cumulative yield limit for a distribution period.

**Parameters**:
- `admin` (Address): The pool admin (must have signature)
- `token` (Address): The token address
- `limit` (i128): Max cumulative stroops per period (0 = unlimited)

**Behavior**:
- Requires admin auth
- Sets `CumulativeYieldLimit(token) = limit`
- Applies to all distributors (including admin)
- Takes effect on next `distribute_yield` call
- Emits `CumulativeYieldLimitUpdated(token, limit)` event

**Errors**:
- `InvalidAmount`: limit < 0
- `UnauthorizedYieldPath`: Caller is not the pool admin

#### `set_yield_distribution_period(admin: Address, token: Address, period_ledgers: u32) -> Result<(), PoolError>`

**Purpose**: Configure the period over which cumulative limits apply (with auto-reset).

**Parameters**:
- `admin` (Address): The pool admin (must have signature)
- `token` (Address): The token address
- `period_ledgers` (u32): Period length in ledgers (0 = no resets)

**Behavior**:
- Requires admin auth
- Sets `YieldDistributionPeriod(token) = period_ledgers`
- Initializes `YieldDistributionPeriodReset(token)` to current ledger
- When period elapses, cumulative counters auto-reset on next `distribute_yield`
- 0 = cumulative never resets (monotonically increasing)
- Max allowed: 17280 * 365 (~1 year)
- Emits `YieldDistributionPeriodUpdated(token, period_ledgers)` event

**Errors**:
- `InvalidAmount`: period_ledgers > 17280 * 365
- `UnauthorizedYieldPath`: Caller is not the pool admin

**Example**:
```bash
# Set ~1 day period (86400 ledgers = 5 mins * 288 slots, or ~120 seconds per ledger)
soroban contract invoke \
  --contract <POOL_ID> \
  --source <ADMIN_KEY> \
  -- set_yield_distribution_period \
  --admin <ADMIN_ADDRESS> \
  --token <TOKEN_ADDRESS> \
  --period_ledgers 86400
```

### Yield Distribution (Modified in v4)

#### `distribute_yield(from: Address, token: Address, amount: i128) -> Result<(), PoolError>`

**Purpose**: Record yield distributed to the pool (recognizes price appreciation).

**Parameters**:
- `from` (Address): Yield source (must have signature and token balance)
- `token` (Address): Token address
- `amount` (i128): Stroops to distribute (must be > 0)

**Behavior** (modified in v4):
1. Requires `from` auth
2. Checks pool/yield not paused
3. **NEW**: Validates authorization
   - If `from == admin` → ADMIN path (no per-dist limit)
   - Else if `from in YieldDistributorsSet(token)` → DISTRIBUTOR path (check per-dist limit)
   - Else → Error: `YieldDistributorNotAuthorized`
4. **NEW**: Validates cumulative limit
   - If cumulative limit enabled and period elapsed → reset counter
   - Check cumulative + amount <= limit
5. Transfers `amount` from `from` to pool
6. Updates `TotalManagedAssets += amount`
7. Emits events: `YieldDistributed(token, amount)`, `PriceUpdated(...)`

**Errors**:
- `OperationPaused`: Yield distribution paused via granular flags
- `InvalidAmount`: amount <= 0
- `YieldDistributorNotAuthorized`: `from` not authorized to distribute
- `YieldExceedsPerDistributionLimit`: amount > per-distribution limit
- `YieldExceedsCumulativeLimit`: cumulative would exceed limit

**Example**:
```bash
# Distributor contributes 500,000 stroops to yield
soroban contract invoke \
  --contract <POOL_ID> \
  --source <DISTRIBUTOR_KEY> \
  -- distribute_yield \
  --from <DISTRIBUTOR_ADDRESS> \
  --token <TOKEN_ADDRESS> \
  --amount 500000000
```

**Backward Compatibility**: 
- v3 behavior: Anyone with tokens could distribute
- v4 behavior: Only admin or pre-authorized distributors can distribute
- **Breaking change**: Existing non-admin distributors must be pre-authorized

### Query Functions (New in v4)

All query functions are read-only and return immediately.

#### `get_authorized_distributors(token: Address) -> Vec<Address>`

**Purpose**: Retrieve list of all authorized yield distributors for a token.

**Parameters**:
- `token` (Address): Token address

**Returns**: Vector of authorized distributor addresses (empty if none authorized)

**Example**:
```bash
soroban contract invoke \
  --contract <POOL_ID> \
  -- get_authorized_distributors \
  --token <TOKEN_ADDRESS>

# Output: ["GBR2K4O3...", "GCZST3SM...", ...]
```

#### `get_yield_limits(token: Address) -> (i128, i128, u32)`

**Purpose**: Retrieve all yield limit configurations for a token.

**Parameters**:
- `token` (Address): Token address

**Returns**: Tuple of `(per_distribution_limit, cumulative_limit, period_ledgers)`
- `per_distribution_limit`: Max stroops per single distribution (0 = unlimited)
- `cumulative_limit`: Max cumulative stroops per period (0 = unlimited)
- `period_ledgers`: Period length in ledgers (0 = no resets)

**Example**:
```bash
soroban contract invoke \
  --contract <POOL_ID> \
  -- get_yield_limits \
  --token <TOKEN_ADDRESS>

# Output: (1000000000, 50000000000, 86400)
# Meaning: 1M per distribution, 50M per day
```

#### `get_distributor_yield_used(distributor: Address, token: Address) -> i128`

**Purpose**: Query cumulative yield distributed by a distributor in the current period.

**Parameters**:
- `distributor` (Address): Distributor address
- `token` (Address): Token address

**Returns**: Stroops distributed in current period (resets when period elapses)

**Example**:
```bash
soroban contract invoke \
  --contract <POOL_ID> \
  -- get_distributor_yield_used \
  --distributor <DISTRIBUTOR_ADDRESS> \
  --token <TOKEN_ADDRESS>

# Output: 3500000000 (3.5M of current period used)
```

## Integration Guide

### Backend Integration

1. **Event Indexing**
   - Listen for `YieldDistributorAuthorized`, `YieldDistributorRevoked` events
   - Index in `audit_logs` table for compliance
   - Index `YieldDistributionPeriodUpdated` for operational visibility

2. **Pre-Authorization**
   - Query backend logs: "Which addresses called `distribute_yield` in the last 30 days?"
   - Call `authorize_yield_distributor` for each non-admin address
   - Verify with `get_authorized_distributors`

3. **Monitoring**
   - Track `get_distributor_yield_used` periodically
   - Alert if cumulative > 80% of limit
   - Alert if authorization failures spike

### Frontend Integration

1. **Authorization Checks**
   - Before user can "distribute yield", query `get_authorized_distributors`
   - Show "Not authorized" UI if user not in list
   - Admin can see authorization management UI

2. **Limit Display**
   - Show current limits via `get_yield_limits`
   - Show remaining capacity: `limit - get_distributor_yield_used`
   - Warn if amount would exceed per-distribution limit

## Upgrade Path: v3 → v4

### Pre-Upgrade
- Snapshot current state: `get_total_yield_distributed`, `get_total_shares`, `get_total_deposits`
- Identify all non-admin yield distributors from transaction logs

### Post-Upgrade
- Pre-authorize all known distributors before hard cutover
- Verify snapshot data matches: `get_total_yield_distributed`, `get_total_shares`
- Run commission invariant tests (INV-LP-1 through INV-LP-6)

### Testing Checklist
- [ ] Admin can distribute yield without limits
- [ ] Authorized distributors can distribute up to per-dist limit
- [ ] Unauthorized distributors are rejected
- [ ] Cumulative limits enforced
- [ ] Period resets work correctly
- [ ] Deposit/withdraw/yield flow works correctly
- [ ] Share prices remain stable
- [ ] No regression in performance

## Troubleshooting

### "YieldDistributorNotAuthorized" Error

**Symptom**: Distribution call fails with error 16

**Cause**: Caller not authorized to distribute yield

**Fix**:
1. Verify caller is admin: `admin.require_auth()`
2. If admin: Verify pool state via `get_admin()`
3. If not admin: Call `authorize_yield_distributor(admin, token, caller)`

### "YieldExceedsPerDistributionLimit" Error

**Symptom**: Distribution call fails with error 17, amount valid for cumulative

**Cause**: Single distribution exceeds per-distribution limit

**Fix**:
1. Query limit: `get_yield_limits(token)` → first value
2. If amount > limit: Either split distribution or admin increases limit via `set_per_distribution_yield_limit`

### "YieldExceedsCumulativeLimit" Error

**Symptom**: Distribution call fails with error 18

**Cause**: Cumulative yield already at limit for this period

**Fix**:
1. Query usage: `get_distributor_yield_used(distributor, token)`
2. Query limit: `get_yield_limits(token)` → second value
3. Wait for period reset (ledgers specified by third value of `get_yield_limits`)
4. Or admin increases limit via `set_cumulative_yield_limit`

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 3 | 2026-09-15 | Original LendingPool (unbounded yield) |
| 4 | 2026-10-16 | Bounded yield authorization (this release) |

## Further Reading

- [Bounded Yield Specification](./BOUNDED_YIELD_SPEC.md)
- [Migration Strategy](./BOUNDED_YIELD_MIGRATION.md)
- [Audit Events and Metrics](./BOUNDED_YIELD_AUDIT_AND_METRICS.md)
- [Threat Model](./BOUNDED_YIELD_THREAT_MODEL.md)
