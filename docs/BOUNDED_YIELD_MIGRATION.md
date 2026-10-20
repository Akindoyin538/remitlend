# Bounded Yield Distribution: Migration and Rollback Strategy

## Overview

This document defines the migration path from LendingPool v3 (unbounded yield) to v4 (bounded yield authorization), including verification procedures, rollback steps, and operational runbooks.

## Pre-Migration Checklist

### Week -2: Planning and Testing
- [ ] Create contract snapshot before any changes
- [ ] Run all existing tests against v3 contract
- [ ] Deploy v4 contract to Futurenet testnet
- [ ] Execute full test suite on Futurenet (16 new tests + all existing tests)
- [ ] Verify commission invariants still hold (INV-LP-1 through INV-LP-6)
- [ ] Stress test cumulative limit reset logic across period boundaries
- [ ] Prepare rollback contract image (identical to v3, ready to deploy)

### Week -1: Stakeholder Coordination
- [ ] Notify all yield distributors of authorization requirement
- [ ] Collect list of all current distributors from backend logs
- [ ] Pre-authorize known distributors in staging environment
- [ ] Prepare communication plan for end users
- [ ] Coordinate with backend team on event indexing requirements
- [ ] Set up monitoring dashboards before production deployment

## Phase 1: Canary Deployment (v3 → v4 with Grace Period)

### Objectives
- Identify integration issues without blocking existing callers
- Validate that storage migrations work correctly
- Confirm event indexing and observability are working
- Give existing callers time to prepare for authorization requirement

### Steps

1. **Deploy v4 Contract with Grace Period Enabled**
   ```
   soroban contract deploy \
     --wasm target/wasm32-unknown-unknown/release/lending_pool.wasm \
     --source <ADMIN_KEY> \
     --rpc-url https://soroban.stellar.org \
     --network-passphrase "Public Global Stellar Network ; September 2015"
   ```

2. **Verify Storage Migration**
   - Check that all existing storage keys still work:
     ```soroban contract invoke --contract <NEW_POOL_ID> \
       -- get_pool_stats --token <TOKEN>
     ```
   - Verify `TotalYieldDistributed` matches v3 contract
   - Verify all depositors still have correct shares

3. **Enable Debugging on New Contract**
   ```soroban contract invoke --contract <NEW_POOL_ID> \
     -- initialize --admin <ADMIN>
   ```

4. **Test Yield Distribution in Grace Period**
   - Admin distributes yield → should succeed
   - Existing non-admin distributor distributes yield → should succeed (grace period)
   - Event emitted for non-admin distributor (deprecation warning)
   - Backend logs warning: "Deprecated: non-authorized distributor X used"

5. **Canary Monitor (24 hours)**
   - Watch error rates on new contract
   - Verify no performance regression vs v3
   - Check that share prices are stable (no rounding errors)
   - Confirm all events are indexed correctly

6. **Canary Pass/Fail Criteria**
   - **PASS**: All existing functionality works, no errors, stable prices
   - **FAIL**: Any errors, price instability, or event indexing failures → Proceed to rollback

### Canary Rollback (if needed)
If canary phase fails, immediately execute **Emergency Rollback to v3** (see section below).

## Phase 2: Authorization Preparation (Days 1-7 of Canary)

### During Canary Deployment (7 Days)

1. **Identify All Authorized Distributors**
   - Query backend logs: "SELECT DISTINCT caller FROM yield_distribution_log WHERE distributor != admin"
   - List all addresses that have ever called `distribute_yield` without being admin
   - Create file: `known_distributors.json`
     ```json
     [
       "GBR2K4O3ZDZKYF6FFFNJ5ODJY66NXS4QCBFTV7M5QNXABGNZZLSQHM",
       "GCZST3SMJINSC7I2EM7DXR7CVLVALNAZRKEAO5Q6MCR63PUDPXOEAA3",
       "..."
     ]
     ```

2. **Pre-Authorize Known Distributors**
   ```bash
   for distributor in $(cat known_distributors.json); do
     soroban contract invoke --contract <NEW_POOL_ID> \
       -- authorize_yield_distributor --admin <ADMIN> \
       --token <TOKEN> --distributor $distributor
   done
   ```

3. **Verify Authorization**
   ```bash
   soroban contract invoke --contract <NEW_POOL_ID> \
     -- get_authorized_distributors --token <TOKEN> | \
     jq 'length'  # Should equal number of known distributors
   ```

4. **Broadcast Authorization Completion**
   - Email all yield distributors: "You are now authorized to distribute yield. No action required."
   - Update documentation: "Bounded Yield Authorization is now active"
   - Post announcement in community channels

## Phase 3: Hard Cutover (End of Day 7)

### Objectives
- Disable grace period: only authorized distributors can distribute yield
- Verify no disruption to authorized callers
- Monitor for any unanticipated errors

### Steps

1. **Disable Grace Period**
   - The v4 contract always enforces authorization starting from deployment
   - No additional action needed (grace period is implicit in our design)

2. **Verify Authorization Still Required**
   - Try unauthorized distributor: should fail with `YieldDistributorNotAuthorized`
   - Try authorized distributor: should succeed
   - Admin: should succeed

3. **Set Limits (Optional, based on governance)**
   ```bash
   # Example: 1M stroops per distribution, 10M stroops per day
   soroban contract invoke --contract <NEW_POOL_ID> \
     -- set_per_distribution_yield_limit --admin <ADMIN> \
     --token <TOKEN> --limit 1000000000

   soroban contract invoke --contract <NEW_POOL_ID> \
     -- set_cumulative_yield_limit --admin <ADMIN> \
     --token <TOKEN> --limit 10000000000

   soroban contract invoke --contract <NEW_POOL_ID> \
     -- set_yield_distribution_period --admin <ADMIN> \
     --token <TOKEN> --period_ledgers 86400  # ~1 day
   ```

4. **Monitoring (24 hours)**
   - Watch for authorization failures (should be zero for known distributors)
   - Track cumulative yield utilization
   - Verify period resets work as expected
   - Check depositor yields are correct

## Emergency Rollback to v3

### Trigger Conditions
- Authorization check is incorrectly rejecting valid distributors
- Share price becomes unstable or diverges from v3
- Critical bug found in authorization logic
- Cumulative limit overflow or underflow detected
- Cannot be resolved in < 1 hour

### Rollback Steps (< 15 minutes)

1. **Prepare v3 Fallback**
   ```bash
   # Deploy pre-migration v3 contract image
   soroban contract deploy \
     --wasm target/wasm32-unknown-unknown/release/lending_pool_v3.wasm \
     --source <ADMIN_KEY> \
     --rpc-url https://soroban.stellar.org \
     --network-passphrase "Public Global Stellar Network ; September 2015"
   ```

2. **Verify v3 Fallback Works**
   ```bash
   soroban contract invoke --contract <V3_POOL_ID> \
     -- get_pool_stats --token <TOKEN> | \
     jq '{total_shares, total_deposits, total_yield_distributed}'
   ```

3. **Migrate DNS/Load Balancer (if applicable)**
   - Update frontend: point to v3 contract ID
   - Update backend: revert to v3 contract ABI
   - Announce: "Temporary fallback to v3 contract during investigation"

4. **Post-Mortem**
   - Analyze logs for root cause
   - Fix issue in v4 code
   - Re-test on Futurenet before re-attempting production deployment

## Data Validation Procedures

### Pre-Migration Snapshot
```bash
# Run on v3 contract
CONTRACT_V3=<v3_contract_id>
TOKEN=<token_address>

# Capture state
jq -n \
  --arg admin "$(soroban contract invoke --contract $CONTRACT_V3 -- get_admin)" \
  --arg total_shares "$(soroban contract invoke --contract $CONTRACT_V3 -- get_total_shares --token $TOKEN)" \
  --arg total_deposits "$(soroban contract invoke --contract $CONTRACT_V3 -- get_total_deposits --token $TOKEN)" \
  --arg total_yield "$(soroban contract invoke --contract $CONTRACT_V3 -- get_total_yield_distributed --token $TOKEN)" \
  '{admin, total_shares, total_deposits, total_yield}' > v3_snapshot.json

cat v3_snapshot.json
```

### Post-Migration Validation
```bash
# Run on v4 contract
CONTRACT_V4=<v4_contract_id>
TOKEN=<token_address>

# Verify state matches
jq -n \
  --arg admin "$(soroban contract invoke --contract $CONTRACT_V4 -- get_admin)" \
  --arg total_shares "$(soroban contract invoke --contract $CONTRACT_V4 -- get_total_shares --token $TOKEN)" \
  --arg total_deposits "$(soroban contract invoke --contract $CONTRACT_V4 -- get_total_deposits --token $TOKEN)" \
  --arg total_yield "$(soroban contract invoke --contract $CONTRACT_V4 -- get_total_yield_distributed --token $TOKEN)" \
  '{admin, total_shares, total_deposits, total_yield}' > v4_snapshot.json

# Compare
diff <(cat v3_snapshot.json | jq -S) <(cat v4_snapshot.json | jq -S)
# Should have no differences
```

### Commission Invariant Verification
```bash
# Verify INV-LP-1 through INV-LP-6 still hold on v4
# Run: `cargo test inv_lp`
cargo test --test '*' inv_lp -- --nocapture
# All should PASS
```

### Share Price Stability Check
```bash
# Query share price before and after a deposit/withdraw cycle
SHARE_PRICE_BEFORE=$(soroban contract invoke --contract $CONTRACT_V4 \
  -- get_share_price --token $TOKEN)

# Deposit, withdraw, distribute yield, etc.
# ...

SHARE_PRICE_AFTER=$(soroban contract invoke --contract $CONTRACT_V4 \
  -- get_share_price --token $TOKEN)

# Compare (should be identical or slightly higher due to yield)
echo "Before: $SHARE_PRICE_BEFORE"
echo "After:  $SHARE_PRICE_AFTER"
# verify: SHARE_PRICE_AFTER >= SHARE_PRICE_BEFORE
```

## Monitoring and Observability

### Real-time Alerts During Migration
- [ ] Alert if `get_authorized_distributors()` returns 0 for main tokens
- [ ] Alert if `cumulative_yield_current_period > cumulative_yield_limit`
- [ ] Alert if authorization failure rate > 1 per minute
- [ ] Alert if share price deviates > 1 basis point from v3
- [ ] Alert if total shares or deposits changes unexpectedly

### Post-Migration Metrics (Day 1)
- Total authorized distributors: (expect >= 3)
- Total cumulative yield this period: (expect > 0)
- Authorization success rate: (expect > 99%)
- Share price variance: (expect < 0.01%)

## Rollback Comparison Table

| Aspect | v3 (Current) | v4 (Bounded) | Migration Impact |
|--------|---|---|---|
| Who can distribute | Anyone with tokens | Admin + authorized | Existing distributors need pre-authorization |
| Per-distribution limit | None | Configurable | Add optional cap per call |
| Cumulative limit | None | Configurable | New enforcement layer |
| Period reset | N/A | Configurable | New capability |
| Storage keys | 12 | 18 (+6) | No conflicts, fully backward compatible |
| Share pricing | Unchanged | Unchanged | No impact on math |
| Events | 6 types | 11 types | New events, old ones still emitted |

## Contingency Plans

### If Pre-Authorization Incomplete
- **Symptom**: Distributions fail after hard cutover
- **Fix**: Add missing distributors using `authorize_yield_distributor`
- **Impact**: ~5 minute resolution per distributor
- **Mitigation**: Batch pre-authorization script ready before cutover

### If Period Reset Not Triggering
- **Symptom**: Cumulative limit stuck, can't distribute new yield
- **Fix**: Check `get_yield_limits()` period value; if 0, period resets disabled
- **Solution**: Call `set_yield_distribution_period(token, 86400)` to enable
- **Impact**: Minimal, yield distribution resumes immediately

### If Cumulative Limit Too Restrictive
- **Symptom**: Valid distributions fail with `YieldExceedsCumulativeLimit`
- **Fix**: Call `set_cumulative_yield_limit(token, higher_value)` to increase
- **Impact**: Takes effect immediately on next distribution
- **Mitigation**: Set initial limit conservatively, increase based on 1-day data

## Sign-Off Checklist

- [ ] v3 snapshot taken and validated
- [ ] v4 contract deployed to testnet and all tests pass
- [ ] All known distributors pre-authorized in production
- [ ] Monitoring dashboards created and tested
- [ ] Alert rules deployed
- [ ] Runbooks documented
- [ ] Team trained on rollback procedure
- [ ] Communication plan approved
- [ ] v3 fallback contract prepared and tested
- [ ] Post-migration validation queries prepared

## Success Criteria

✓ Bounded yield authorization deployed to production
✓ All existing yield distributions continue uninterrupted
✓ All existing depositors receive correct yield
✓ New authorization limits are enforced
✓ No share price divergence from v3
✓ Audit events properly indexed
✓ Metrics and alerts functioning correctly
✓ Team responds to alerts within SLA
✓ Zero security incidents during transition
✓ v4 contract stable for > 7 days without rollback
