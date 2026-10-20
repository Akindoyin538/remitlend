# Oracle Adapter Integration & Deployment Guide

## Overview

This guide documents how to integrate the RemitLend oracle adapter into lending pool and loan manager contracts, including complete failure path testing and operational rollout.

---

## 1. Contract Integration Points

### 1.1 Lending Pool Integration

The lending pool uses oracle prices for:
- **Yield calculation**: Price changes determine accrued interest
- **Health factor tracking**: LTV calculations for monitoring
- **Price updates**: Trigger rebalancing events

**Integration Call Flow**:

```
LendingPool.get_share_price()
  ├─> OracleAdapter.get_validated_price(asset = "USD")
  │   ├─> Fetch primary (Zenith)
  │   ├─> Fetch fallback (Reflector)
  │   ├─> Apply validation (staleness, tolerance)
  │   └─> Return OraclePriceReading or error
  └─> Update pool state based on price
```

**Failure Paths**:
- If `StaleReading` returned: Use cached price with age disclosure
- If `PriceToleranceExceeded` returned: Halt borrowing, alert governance
- If `NoValidOraclePrice` returned: Invoke emergency pause

### 1.2 Loan Manager Integration

The loan manager uses oracle prices for:
- **Collateral valuation**: Determine LTV when approving loans
- **Liquidation decisions**: Check if collateral < threshold
- **Default detection**: Evaluate health during grace period

**Integration Call Flow**:

```
LoanManager.approve_loan(borrower, amount, collateral_nft)
  ├─> Get collateral value using OracleAdapter.get_validated_price()
  ├─> Calculate LTV = amount / collateral_value
  ├─> Verify LTV <= max_ltv
  └─> Return approval or error
```

**Failure Paths**:
- If oracle fails to provide price: Return `InsufficientCollateralInfo` error
- If price indicates under-collateralization: Reject loan
- If price stale: Loan manager can use cached price (with governance approval)

---

## 2. Error Handling & Fallback Behavior

### 2.1 Oracle Error Mapping

| Oracle Error | Caller Behavior | Observability |
|--------------|-----------------|----------------|
| `NoValidOraclePrice` | Reject operation, emit error event | Log: "Oracle sources unavailable" |
| `StaleReading` | Use cached price (if available) | Log: "Using cached price (age: Xs)" |
| `PriceToleranceExceeded` | Halt borrowing, alert governance | Log: "Price dispersion {bps} > {threshold}" |
| `Unauthorized` | Return error to caller | Log: "Unauthorized oracle call" |
| `NotInitialized` | Return error, investigate deployment | Log: "Oracle not initialized" |

### 2.2 Cached Price Strategy

For graceful degradation during oracle source outages:

```rust
fn get_price_with_fallback(
    oracle: &OracleAdapter,
    asset: Symbol,
    max_staleness: u64,
    cache_ttl: u64,  // How long to use cached price
) -> Result<OraclePriceReading, PriceError> {
    match oracle.get_validated_price(asset, max_staleness) {
        Ok(price) => {
            update_cache(asset, price.clone());
            Ok(price)
        }
        Err(OracleAdapterError::StaleReading) => {
            // Fall back to cached price if available
            match get_cached_price(asset) {
                Some(cached) if now - cached.timestamp <= cache_ttl => {
                    emit_event("CachedPriceFallback", asset, cached.timestamp);
                    Ok(cached)
                }
                _ => Err(PriceError::NoCachedPrice),
            }
        }
        Err(e) => Err(PriceError::OracleError(e)),
    }
}
```

---

## 3. Complete Workflow Testing

### 3.1 Happy Path: Fresh Dual-Source Price

**Scenario**:
1. Primary (Zenith) returns $1.00 at T=100
2. Fallback (Reflector) returns $1.015 at T=99
3. Dispersion = 1.5% < 2% tolerance ✓
4. Both fresh (< 5 min old) ✓
5. Use primary price

**Test Coverage**:
- `test_oracle_integration_happy_path_dual_source_fresh_within_tolerance()`
- Verify: Price returned = primary price, source = "ZENITH"
- Verify: Event emitted with dispersion metrics

---

### 3.2 Failure Path 1: Primary Stale, Fallback Fresh

**Scenario**:
1. Primary returns $1.00 at T=50 (6 min old) ✗
2. Fallback returns $1.01 at T=100 (current) ✓
3. Primary exceeds max_staleness ✗
4. Fallback is fresh ✓
5. Use fallback price

**Test Coverage**:
- `test_oracle_integration_fallback_on_primary_stale()`
- Verify: Source returned = "REFLECTOR"
- Verify: Event indicates fallback usage
- Verify: Monitoring alert if fallback used repeatedly

---

### 3.3 Failure Path 2: Both Stale

**Scenario**:
1. Primary returns $1.00 at T=50 (6 min old) ✗
2. Fallback returns $1.01 at T=40 (7 min old) ✗
3. Both exceed max_staleness ✗
4. No fresh price available ✗
5. Return error: `StaleReading`

**Test Coverage**:
- `test_oracle_integration_both_stale_returns_error()`
- Verify: Error returned with reason "StaleReading"
- Verify: Lending pool halts new borrows
- Verify: Governance alert for manual intervention

**Recovery**:
- Governance calls emergency pause on lending pool
- Oracle sources brought back online
- Governance unpauses lending pool
- Operations resume with fresh prices

---

### 3.4 Failure Path 3: Tolerance Exceeded

**Scenario**:
1. Primary returns $1.00 at T=100
2. Fallback returns $1.30 at T=100
3. Both fresh ✓
4. Dispersion = 30% >> 2% tolerance ✗
5. Sources disagree significantly ✗
6. Use primary (preferred source), emit alert

**Test Coverage**:
- `test_oracle_integration_tolerance_exceeded_uses_fresh_primary()`
- Verify: Use primary price
- Verify: Event indicates tolerance exceeded
- Verify: Monitoring alert triggers

**Resolution**:
- Investigate source desynchronization
- Check for network partition or Byzantine behavior
- Manual validation of actual market price
- Consider parameter adjustment if tolerance too strict

---

### 3.5 Failure Path 4: No Oracle Available

**Scenario**:
1. Primary source offline (network error)
2. Fallback source offline (network error)
3. Both return None ✗
4. No price available anywhere ✗
5. Return error: `NoValidOraclePrice`

**Test Coverage**:
- `test_oracle_integration_both_unavailable_returns_error()`
- Verify: Error returned
- Verify: Lending pool reverts all price-dependent operations
- Verify: Governance can activate emergency mode

**Recovery Path**:
```
Both Sources Down
    ├─> Lending pool paused (automatically)
    ├─> Governance reviews situation
    ├─> Decision 1: Activate emergency pause (halt borrowing)
    │   └─> Resume when sources online + validated
    └─> Decision 2: Use cached price (if available)
        └─> Accept risk of stale prices for liquidity
```

---

## 4. Integration Test Scenarios

### 4.1 Loan Approval with Oracle Integration

**Test**: `test_oracle_integration_loan_approval_with_price_validation`

```rust
#[test]
fn test_oracle_integration_loan_approval_with_price_validation() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    
    let (oracle, loan_manager, lending_pool) = setup_integration(&env);
    let borrower = Address::generate(&env);
    
    // 1. Oracle returns valid price: $100
    oracle.mock_price(10_000_000); // $1.00
    
    // 2. Borrower requests $100 loan with $200 collateral
    let loan_request = LoanRequest {
        amount: 100_000_000,
        term_ledgers: 10_000,
    };
    
    // 3. Loan manager validates collateral:
    //    - Gets price from oracle
    //    - Calculates LTV = 100 / 200 = 50%
    //    - Verifies LTV <= max_ltv (e.g., 80%)
    
    let result = loan_manager.request_loan(&borrower, loan_request);
    
    assert_eq!(result, Ok(LoanId(1)));
    assert_eq!(loan_manager.get_loan(LoanId(1)).status, LoanStatus::Pending);
}
```

---

### 4.2 Liquidation Decision with Oracle Integration

**Test**: `test_oracle_integration_liquidation_with_collateral_pricing`

```rust
#[test]
fn test_oracle_integration_liquidation_with_collateral_pricing() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    
    let (oracle, loan_manager, _lending_pool) = setup_integration(&env);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);
    
    // 1. Create loan: $100 with $200 collateral (50% LTV, healthy)
    let loan_id = loan_manager.create_test_loan(&borrower, 100_000_000);
    oracle.mock_price(10_000_000); // $1.00 collateral
    
    // 2. Price drops: collateral now $50 (10x decrease)
    oracle.mock_price(1_000_000); // $0.10 per unit
    
    // 3. LTV now = 100 / 50 = 200% (liquidatable)
    assert!(loan_manager.is_liquidatable(&loan_id));
    
    // 4. Liquidator triggers liquidation
    let result = loan_manager.liquidate(&liquidator, loan_id);
    
    assert_eq!(result, Ok(LiquidationResult { /* ... */ }));
}
```

---

### 4.3 Oracle Failure Impact on Lending Pool

**Test**: `test_oracle_integration_pool_gracefully_handles_oracle_failure`

```rust
#[test]
fn test_oracle_integration_pool_gracefully_handles_oracle_failure() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    
    let (oracle, _loan_manager, lending_pool) = setup_integration(&env);
    let lender = Address::generate(&env);
    let token = create_test_token(&env);
    
    // 1. Lender deposits $1000
    lending_pool.deposit(&lender, 1_000_000_000);
    
    // 2. Oracle working normally
    oracle.mock_price(10_000_000);
    let price_1 = lending_pool.get_share_price();
    
    // 3. Oracle fails (both sources down)
    oracle.mock_failure(OracleAdapterError::NoValidOraclePrice);
    
    // 4. Share price calculation uses cached price
    let price_2 = lending_pool.get_share_price();
    
    // Verify: Price calculation succeeds with cached fallback
    assert_eq!(price_2.source, PriceSource::Cached);
    assert_eq!(price_2.age_seconds, 30); // Age of cached price
    
    // 5. When oracle recovers, revert to live prices
    oracle.mock_price(10_000_000);
    let price_3 = lending_pool.get_share_price();
    
    assert_eq!(price_3.source, PriceSource::Live);
}
```

---

## 5. Deployment & Rollout

### 5.1 Pre-Deployment Checklist

- [ ] All 42 oracle tests pass
- [ ] All 6 integration tests pass
- [ ] All invariants verified (INV-1 through INV-6)
- [ ] Gas budgets verified for mainnet
- [ ] Event schemas match indexer expectations
- [ ] Error codes documented for integrators
- [ ] Threat model reviewed by security team

### 5.2 Deployment Steps

**Phase 1: Testnet Deployment**

```bash
# 1. Compile oracle adapter for testnet
cd contracts
cargo build --target wasm32-unknown-unknown --release

# 2. Deploy oracle adapter
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/oracle_adapter.wasm \
  --source <DEPLOYER_KEY> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"

# 3. Initialize oracle adapter
soroban contract invoke \
  --id <ORACLE_ADAPTER_ID> \
  --source <ADMIN_KEY> \
  --rpc-url https://soroban-testnet.stellar.org \
  -- initialize \
  --admin <ADMIN_ADDRESS> \
  --zenith-oracle <ZENITH_ADDRESS> \
  --reflector-oracle <REFLECTOR_ADDRESS> \
  --tolerance-bps 200

# 4. Update lending pool to use oracle adapter
# (Update lending pool contract code to reference oracle)

# 5. Run integration tests
cargo test --lib integration

# 6. Monitor testnet for 7 days
# - Track oracle acceptance rate
# - Monitor source availability
# - Verify price accuracy against external feeds
```

**Phase 2: Mainnet Deployment**

```bash
# 1. Governance vote to approve mainnet deployment
# 2. Execute deployment via multisig governance
# 3. Monitor mainnet for 30 days
# - Ensure high availability (>99% uptime)
# - Validate price accuracy
# - Monitor for anomalies
```

### 5.3 Rollout Plan

**Week 1-2**: Testnet testing
- Deploy on testnet
- Run all 42 tests
- Validate integration with lending pool
- Monitor for 2 weeks

**Week 3-4**: Pre-mainnet validation
- Security audit of oracle integration
- Review event schemas and indexing
- Prepare governance proposal

**Week 5**: Governance vote
- Submit proposal to multisig governance
- 3-day timelock for review
- Community discussion

**Week 6+**: Mainnet deployment
- Execute governance proposal
- Deploy oracle adapter to mainnet
- Gradual rollout:
  - Day 1: Enabled but non-critical (logs only)
  - Day 7: Use for new loans (with circuit breaker)
  - Day 30: Full production (all loan types)

---

## 6. Operational Monitoring

### 6.1 Key Metrics

**Real-Time Dashboard**:
- Oracle availability (% uptime per source)
- Price acceptance rate (% of queries accepted)
- Fallback usage rate (% of prices from reflector)
- Dispersion (average bps between sources)
- Staleness (average age of accepted prices)

**Alerts**:
- Alert if acceptance rate < 80%
- Alert if primary source down > 1 hour
- Alert if dispersion > 500 bps (> 5%)
- Alert if average staleness > 2 min

### 6.2 Events to Index

Enable indexer to track:
```
Events:
  - oracle_price_fetched (every source query)
  - oracle_price_validated (every accepted price)
  - oracle_price_rejected (every failed validation)
  - oracle_tolerance_updated (parameter changes)
  - oracle_max_staleness_updated (parameter changes)
  - oracle_initialized (deployment)
```

### 6.3 Manual Intervention Procedures

**If oracle consistently fails**:
1. Check source availability (network status)
2. Verify oracle adapter is initialized
3. Check tolerance and max_staleness parameters
4. Review recent contract deployments (possible incompatibility)
5. If unfixable: Activate emergency pause via multisig

**If source desynchronization (tolerance exceeded)**:
1. Analyze prices from both sources
2. Determine if market gap is real or data issue
3. Temporarily increase tolerance if market is truly volatile
4. Revert tolerance once sources realign

---

## 7. References

- **ORACLE_THREAT_MODEL.md**: Security threat model
- **ORACLE_TEST_COVERAGE.md**: Test suite documentation
- **lib.rs**: Oracle adapter implementation
- **test.rs**: 42 comprehensive tests
- **EMERGENCY_PAUSE_PATTERN.md**: Governance pause mechanisms

