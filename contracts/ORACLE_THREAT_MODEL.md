# Oracle Attack Surface & Adversarial Test Threat Model

**Version**: 1.0  
**Date**: 2026-10-16  
**Status**: Production Design  

---

## Executive Summary

This document specifies the security threat model, attack surfaces, and mitigation strategies for the RemitLend oracle infrastructure. The oracle adapter validates price feeds from primary (Zenith) and fallback (Reflector) sources using tolerance-based consensus, staleness guards, and multi-source fallback logic.

**Key Risk Areas**:
- Stale price manipulation (accepting outdated readings)
- Source deviation attacks (consensus bypass via large dispersion)
- Single-source failure recovery (primary source downtime)
- Authorization bypass (unauthorized price updates)
- Arithmetic overflow in tolerance calculations
- State desynchronization across oracle sources

---

## 1. System Assets & Trust Boundaries

### 1.1 Protected Assets

**Price Integrity**:
- Exchange rate readings determine loan-to-value (LTV) calculations
- Incorrect rates can trigger premature liquidations or enable under-collateralized borrowing
- Used directly in lending pool yield calculations

**Oracle Infrastructure State**:
- Admin address controls oracle parameters (tolerance, max staleness)
- Oracle source addresses (Zenith, Reflector) are immutable post-initialization
- Tolerance threshold (basis points) gates price validation

**Chain State Dependencies**:
- Ledger timestamp is authoritative for staleness checks
- Oracle responses must be cryptographically provable (Soroban SDK invocation)
- Historical price buffers track price rounds with reporter attribution

### 1.2 Trust Boundaries

| Boundary | Scope | Risk |
|----------|-------|------|
| **Primary Oracle Source (Zenith)** | Price provided by Zenith service | Network latency, manipulation, downtime |
| **Fallback Oracle Source (Reflector)** | Fallback price feed | Source correlation, synchronized failures |
| **Ledger Timestamp** | Block timestamp from Stellar ledger | Timestamp progression guaranteed monotonic |
| **Admin/Governance** | Controller of tolerance & staleness parameters | Parameter misconfiguration, unauthorized changes |
| **Callers (Lending Pool, Loan Manager)** | Arbitrary external callers requesting price | Replay attacks, invalid asset symbols |

---

## 2. Attack Vectors & Invariant Tests

### 2.1 Stale Price Acceptance (Freshness Window Bypass)

**Attack Vector**: Attacker forces oracle to return price older than `max_staleness` by:
- Delaying primary source response until it exceeds window
- Triggering cascade where only stale readings remain available
- Exploiting timestamp edge cases (now = timestamp + max_staleness + 1)

**Impact**: 
- Liquidation at prices from hours/days ago
- Collateral worth becomes mispriced by >10% in volatile assets
- Enables under-collateralized borrowing

**Invariant INV-1**: `now - price.timestamp <= max_staleness` for accepted prices
- Test: `test_oracle_rejects_stale_primary_when_fallback_also_stale()`
- Test: `test_oracle_accepts_fresh_primary_even_if_fallback_stale()`
- Test: `test_oracle_boundary_staleness_at_exact_threshold()`

**Mitigation**:
- Enforce strict `<=` comparison on staleness checks
- Return error if both sources exceed max_staleness
- Log staleness metrics to observability system

---

### 2.2 Tolerance Bypass (Consensus Deviation Attack)

**Attack Vector**: Attacker causes price dispersion to exceed tolerance by:
- Primary source returns $1.00, fallback returns $1.30 (30% deviation)
- Tolerance calculated as 200 bps (2%) is exceeded
- Attack forces fallback acceptance without validation

**Impact**:
- Arbitrage between oracle prices and actual market
- Borrowers/lenders exit at favorable rates before correction
- Protocol faces price shock on actual settlement

**Invariant INV-2**: `abs(primary_price - fallback_price) / primary_price <= tolerance_bps / 10000` for dual-source acceptance
- Test: `test_oracle_rejects_when_tolerance_exceeded()`
- Test: `test_oracle_boundary_tolerance_at_exact_threshold()`
- Test: `test_oracle_tolerance_calculated_correctly_for_dispersion()`

**Mitigation**:
- Both prices must be fresh AND within tolerance for consensus
- If tolerance exceeded, prefer primary if fresh, fallback if primary stale
- Never accept both prices when dispersion too large
- Emit event with dispersion metrics for monitoring

---

### 2.3 Single-Source Failure & Fallback Logic

**Attack Vector**: Attacker creates scenario where:
- Primary source completely fails/unavailable (returns None)
- Fallback must be accepted as sole price
- Fallback is stale but no alternative exists
- Caller pressured to accept degraded signal

**Impact**:
- Must accept lower-quality data during primary source downtime
- Risk of accepting price >1hr old if max_staleness not tuned
- Dependency risk on fallback source reliability

**Invariant INV-3**: Single valid source is accepted if fresh and alone available
- Test: `test_oracle_accepts_fallback_when_primary_unavailable()`
- Test: `test_oracle_accepts_primary_when_fallback_unavailable()`
- Test: `test_oracle_returns_error_when_both_sources_unavailable()`

**Mitigation**:
- Explicit per-source availability checks
- Single source must still pass freshness check (no relaxation)
- Return `NoValidOraclePrice` error when both fail
- Monitoring alerts if fallback becomes primary for >N blocks

---

### 2.4 Authorization Bypass (Admin Parameter Tampering)

**Attack Vector**: Attacker attempts to:
- Change tolerance to 10000 bps (100%) to accept any dispersion
- Change max_staleness to u64::MAX to accept arbitrarily old prices
- Initialize oracle twice to reset admin
- Modify admin address after deployment

**Impact**:
- Collapse of price validation logic
- Protocol accepts arbitrary prices
- Liquidation/borrowing dynamics become unpredictable

**Invariant INV-4**: Only authorized admin can modify oracle parameters
- Test: `test_oracle_initialize_requires_admin_auth()`
- Test: `test_oracle_cannot_reinitialize()`
- Test: `test_oracle_set_tolerance_requires_admin_auth()`

**Mitigation**:
- `require_auth()` enforced on all admin functions
- Initialize flag persists to prevent re-initialization
- Parameters guarded with bounds checks (tolerance <= 10000 bps)
- Event emission on all admin actions

---

### 2.5 Arithmetic & Boundary Failures

**Attack Vector**: Attacker exploits math operations:
- Overflow in tolerance calculation: `(price * tolerance_bps) / 10000`
- Division by zero if price is 0
- Underflow in staleness: `now - timestamp` when timestamp > now (impossible but guard)
- Off-by-one errors in tolerance threshold

**Impact**:
- Panic/abort in calculation path
- Silent arithmetic errors leading to incorrect validation
- Contract becomes unusable

**Invariant INV-5**: All arithmetic operations are bounded and panic-free
- Test: `test_oracle_tolerance_calc_large_price_no_overflow()`
- Test: `test_oracle_tolerance_calc_zero_price_no_division_error()`
- Test: `test_oracle_staleness_unsigned_math_sound()`

**Mitigation**:
- Use `saturating_*` operations where appropriate
- Check price > 0 before division
- Leverage Soroban SDK overflow checks in debug/test profiles

---

### 2.6 State Desynchronization Between Sources

**Attack Vector**: 
- Oracle adapter stores Zenith/Reflector addresses
- Both sources have independent state (last price, last update block)
- Attacker submits out-of-order prices (reflector delayed, zenith ahead)
- Consensus logic breaks if timestamps misaligned

**Impact**:
- Stale/fresh determination becomes incorrect
- One source advances, other regresses (network reorg)
- Price history buffer gets corrupted

**Invariant INV-6**: Oracle source timestamps must be independently verifiable
- Test: `test_oracle_timestamp_progression_per_source()`
- Test: `test_oracle_handles_timestamp_reorg()`

**Mitigation**:
- Each source price fetched independently with own timestamp
- Fallback accepts reading even if primary ahead (robustness)
- No cross-source timestamp dependencies
- Log dispersion in timestamps separately

---

## 3. Boundary Conditions & Edge Cases

### 3.1 Tolerance Boundaries

| Scenario | Input | Expected Output | Risk |
|----------|-------|-----------------|------|
| Zero tolerance | `tolerance_bps = 0` | Require exact match (unrealistic) | May cause cascading rejections |
| Max tolerance | `tolerance_bps = 10000` | Accept any dispersion (dangerous) | Parameter misconfiguration |
| Boundary exact | `dispersion_bps == tolerance_bps` | Accept prices | Off-by-one if `>` vs `>=` |
| Very small prices | `price = 1 (1 cent)` | Tolerance calc: `(1 * 200) / 10000 = 0` | Rounding toward zero |
| Very large prices | `price = 10^9 (1B tokens)` | Tolerance calc: `(10^9 * 200) / 10000` | Overflow risk if not checked |

**Test Coverage**:
- `test_oracle_tolerance_zero_exact_match_required()`
- `test_oracle_tolerance_10000_accepts_any_dispersion()`
- `test_oracle_tolerance_small_price_rounding()`
- `test_oracle_tolerance_large_price_no_overflow()`

---

### 3.2 Staleness Boundaries

| Scenario | Setup | Expected Output | Risk |
|----------|-------|-----------------|------|
| `now == timestamp` | Fresh reading, zero age | Accept | None |
| `now == timestamp + max_staleness` | At boundary | Accept | Off-by-one if `>` vs `>=` |
| `now == timestamp + max_staleness + 1` | Just over boundary | Reject | Critical |
| `now << timestamp` (impossible) | Timestamp > now | Unreachable in practice | Guard anyway |
| `max_staleness = 0` | Only accept current block | Likely too strict | Caller error |

**Test Coverage**:
- `test_oracle_staleness_exact_boundary_accepted()`
- `test_oracle_staleness_just_over_boundary_rejected()`
- `test_oracle_staleness_zero_max_only_current_block()`

---

### 3.3 Combined Attack Scenarios

| Scenario | Primary | Fallback | Tolerance | Max Staleness | Expected | Risk |
|----------|---------|----------|-----------|----------------|----------|------|
| Both stale | ✓ (old) | ✓ (old) | 200 bps | 300s | Reject | Both exceed limit |
| Primary stale, fallback fresh | ✓ (old) | ✓ (new) | 200 bps | 300s | Accept fallback | Fallback within bounds |
| Primary fresh, dispersion high | ✓ (new) | ✓ (new) | 200 bps | 300s | Reject (use primary if available) | Tolerance exceeded |
| Primary missing, fallback fresh | ✗ | ✓ (new) | 200 bps | 300s | Accept fallback | Single source OK |
| Both missing | ✗ | ✗ | 200 bps | 300s | Error: NoValidOraclePrice | Complete failure |

---

## 4. Observability & Audit Requirements

### 4.1 Events (Soroban SDK Events)

**OraclePriceFetched**:
```rust
pub fn oracle_price_fetched(
    env: &Env,
    source: Symbol,
    asset: Symbol,
    price: i128,
    timestamp: u64,
    staleness_seconds: u64,
) {}
```
- Emitted on every source query result
- Helps correlate price validation decisions
- Timestamp allows latency analysis

**OraclePriceValidated**:
```rust
pub fn oracle_price_validated(
    env: &Env,
    asset: Symbol,
    price: i128,
    source: Symbol,
    dispersion_bps: u32,
    num_sources: u32,
) {}
```
- Emitted when price passes all checks
- Tracks which source was ultimately used
- Records dispersion for monitoring

**OraclePriceRejected**:
```rust
pub fn oracle_price_rejected(
    env: &Env,
    asset: Symbol,
    reason: Symbol, // "StaleReading", "ToleranceExceeded", "NoValidOraclePrice"
    details: String,
) {}
```
- Emitted on validation failure
- Helps identify attack patterns
- Reason codes enable automated alerting

**OracleParameterUpdated**:
```rust
pub fn oracle_parameter_updated(
    env: &Env,
    parameter: Symbol, // "Tolerance", "MaxStaleness"
    old_value: u64,
    new_value: u64,
) {}
```
- Emitted on admin parameter changes
- Helps audit governance decisions

### 4.2 Metrics to Track

**Real-Time Dashboards**:
- Price acceptance rate (% of queries accepted vs rejected)
- Source availability (Zenith uptime %, Reflector uptime %)
- Dispersion distribution (histogram of bps deviation)
- Staleness distribution (age of accepted prices in seconds)
- Fallback usage rate (% of prices using reflector vs zenith)

**Alerting Thresholds**:
- Alert if acceptance rate drops below 80% (potential attack)
- Alert if fallback used for >10 consecutive blocks (primary down)
- Alert if dispersion > 500 bps for >5 min (source misalignment)
- Alert if admin parameter changed without governance approval

---

## 5. Test Categories & Coverage Matrix

### 5.1 Threat-Based Test Categories

| Category | Tests | Purpose |
|----------|-------|---------|
| **Freshness** | `test_oracle_staleness_*` (6 tests) | Verify staleness guard logic |
| **Consensus** | `test_oracle_tolerance_*` (8 tests) | Verify dispersion validation |
| **Fallback** | `test_oracle_fallback_*` (5 tests) | Verify single/dual source logic |
| **Authorization** | `test_oracle_auth_*` (4 tests) | Verify admin guards |
| **Arithmetic** | `test_oracle_math_*` (5 tests) | Verify no panics/overflows |
| **Integration** | `test_oracle_integration_*` (6 tests) | E2E workflows with failures |
| **Boundary** | `test_oracle_boundary_*` (8 tests) | Edge case validation |

**Total**: 42 focused tests covering all attack vectors

---

## 6. Compatibility & Operational Constraints

### 6.1 Deployed Contract Compatibility

- **No state schema changes**: Test suite uses mock oracle, no changes to deployed adapter
- **No API changes**: All oracle functions retain same signatures
- **Backward compatible**: Tests pass against current deployment

### 6.2 Resource Budgets

| Operation | Budget | Risk |
|-----------|--------|------|
| `get_validated_price` | <50 ms | Latency-sensitive for lending operations |
| Storage footprint | <100 bytes per oracle state | Persistent storage bounded |
| Event emission | <5 KB per call | Logs must be auditable |

### 6.3 Rollback & Migration

- No migration needed (tests only, no state)
- Tests can be enabled incrementally per environment
- Failure in one test doesn't block contract deployment
- No governance approval needed to activate tests

---

## 7. Adversarial Threat Scenarios

### Scenario 1: Flash Loan + Oracle Manipulation

**Attacker Action**:
1. Takes flash loan of 1M USDC
2. Calls primary oracle with large buy order to push price up 30%
3. Requests loan at inflated price
4. Closes flash loan, price drops back to normal
5. Now has under-collateralized loan

**Oracle Defense**:
- Check timestamp freshness (multi-block age prevents within-block attacks)
- Validate fallback source confirms price (not just primary)
- Monitor dispersion between sources
- Log event for post-incident analysis

**Test**: `test_oracle_rejects_flash_loan_manipulation_attempt()`

---

### Scenario 2: Source Compromise (Zenith Hacked)

**Attacker Action**:
1. Compromise Zenith oracle infrastructure
2. Return artificially high prices (10x actual)
3. Protocol accepts prices (primary source trusted)
4. Attacker withdraws at inflated collateral value

**Oracle Defense**:
- Fallback source (Reflector) independently validates
- Tolerance check rejects 900% dispersion
- If both compromised, governance can pause via multisig
- Historical price buffer tracks manipulation pattern

**Test**: `test_oracle_detects_outlier_from_single_compromised_source()`

---

### Scenario 3: Denial of Service (Both Sources Down)

**Attacker Action**:
1. DDoS both Zenith and Reflector
2. No prices available
3. Lending pool cannot calculate LTV
4. Liquidations blocked, defaults accrue

**Oracle Defense**:
- Return clear error (`NoValidOraclePrice`) to caller
- Lending pool has governance-controlled "safe mode" to pause borrowing
- Fall back to cached price with age disclosure
- No silent failures

**Test**: `test_oracle_both_sources_unavailable_returns_clear_error()`

---

## 8. Test Infrastructure & Mocking

### 8.1 Mock Oracle Source

```rust
pub struct MockOracleSource {
    pub price: i128,
    pub timestamp: u64,
    pub fail_mode: SourceFailMode,
}

pub enum SourceFailMode {
    Success,
    Timeout,
    InvalidResponse,
    ReturnZeroPrice,
    ReturnNegativePrice,
}
```

Mock sources can be configured per test to simulate:
- Success scenarios
- Network failures
- Byzantine (intentionally wrong) responses
- Delayed responses (stale prices)

### 8.2 Test Environment Setup

```rust
fn setup_oracle_test(env: &Env, 
    primary_config: SourceConfig,
    fallback_config: SourceConfig,
    tolerance_bps: u32,
    max_staleness: u64,
) -> OracleAdapterClient {
    // Create mock sources
    // Initialize oracle adapter
    // Return configured client
}
```

---

## 9. Verification & Evidence Collection

### 9.1 Pre-Deployment Verification

- [ ] All 42 tests pass (100% coverage of threat vectors)
- [ ] Fuzzing campaign runs 10k iterations without panics
- [ ] Gas/storage budgets verified for mainnet deployment
- [ ] No breaking changes to oracle API

### 9.2 Post-Deployment Monitoring

- [ ] Oracle acceptance rate tracked and alerting configured
- [ ] Source availability monitored with <1min detection latency
- [ ] Price dispersion logged and analyzed for anomalies
- [ ] Governance notified if admin parameters changed

---

## 10. References & Related Documents

- **THREAT_MODEL.md**: Contract-level threat model
- **SECURITY.md**: Overall security policy
- **EMERGENCY_PAUSE_PATTERN.md**: Governance pause mechanisms
- **Soroban Docs**: https://soroban.stellar.org/docs (oracle SDK patterns)

---

## Appendix A: Test Naming Convention

All oracle adversarial tests follow this pattern:

```
test_oracle_{component}_{scenario}_{expected_outcome}
```

Examples:
- `test_oracle_staleness_both_stale_returns_error()` 
- `test_oracle_tolerance_exact_boundary_accepted()`
- `test_oracle_fallback_primary_unavailable_accepts_fallback()`
- `test_oracle_auth_initialize_requires_admin()`

This convention makes test purposes immediately clear and enables filtering by category.

