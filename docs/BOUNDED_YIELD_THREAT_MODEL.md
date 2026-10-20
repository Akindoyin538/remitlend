# Bounded Yield Distribution: Threat Model and Security Analysis

## Executive Summary

The bounded yield distribution authorization system introduces role-based access control (RBAC) and resource limits to the LendingPool contract's yield distribution mechanism. This document provides a comprehensive threat analysis covering:

1. **Security objectives**: Prevent unauthorized yield injection, enforce resource bounds, enable governance
2. **Attack surface**: Authorization bypass, limit circumvention, cumulative tracking manipulation
3. **Threat scenarios**: 12 potential attacks with risk assessment and mitigation
4. **Security invariants**: 3 fundamental properties that must always hold
5. **Assumptions and limitations**: Trust boundaries and external dependencies

---

## Security Objectives

### Primary Objectives

**Objective 1: Authorization Enforcement**
- Only the pool admin or explicitly authorized distributors can distribute yield
- Unauthorized callers are rejected with clear error code
- Admin always has implicit authorization (no explicit registration needed)

**Objective 2: Resource Bounds**
- No single distribution can exceed the per-distribution limit
- Cumulative yield within a period cannot exceed the cumulative limit
- Limits can be adjusted by admin at any time
- Periods auto-reset cumulative counters on schedule

**Objective 3: Governance and Auditability**
- All authorization state mutations are immutable audit events
- Distributors can be dynamically authorized or revoked
- Limits can be adjusted based on real-time utilization
- Complete audit trail enables forensic analysis of any incident

### Secondary Objectives

- **Backward Compatibility**: v3 contracts continue to work (existing deposits/withdrawals unaffected)
- **Share Price Stability**: No divergence from v3 share pricing formula
- **Performance**: No performance regression from v3 (authorization checks are O(n) for n distributors)
- **Observability**: Structured events and metrics enable real-time operational visibility

---

## Attack Surface

### Entry Points
1. `distribute_yield(from, token, amount)` — Main attack surface
2. `authorize_yield_distributor(admin, token, distributor)` — Authorization management
3. `revoke_yield_distributor(admin, token, distributor)` — Authorization revocation
4. `set_*_yield_limit(admin, token, limit)` — Limit configuration
5. `set_yield_distribution_period(admin, token, period)` — Period management

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│ Soroban Contract (Trusted)                                  │
│ - Authorization checks                                      │
│ - Arithmetic (checked_add, etc.)                            │
│ - State persistence                                         │
└──────────────────────────────────────────────────────────────┘
                    ↑                      ↑
           (requires auth)         (reads state)
                    │                      │
┌──────────────────────────────────────────────────────────────┐
│ Caller (Untrusted)                                           │
│ - May forge signatures (if keys compromised)                │
│ - May send invalid amounts                                  │
│ - May attempt replay attacks                                │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ Stellar Network (Semi-Trusted)                              │
│ - Enforces nonce uniqueness                                 │
│ - Handles transaction sequencing                            │
│ - Subject to ledger finality guarantees                      │
└──────────────────────────────────────────────────────────────┘
```

---

## Threat Scenarios

### ATK-1: Unauthorized Yield Injection

**Threat**: An unauthenticated attacker (or compromised distributor) calls `distribute_yield` to inflate pool asset value.

**Attack Method**:
```
1. Attacker transfers tokens to pool's address directly (fails to move price)
2. Attacker calls distribute_yield(attacker, token, large_amount)
3. Contract checks require_auth() — succeeds if attacker has signing power
4. Contract checks authorization — FAILS: attacker not in authorized list
5. Error returned: YieldDistributorNotAuthorized
```

**Impact**: None (attack blocked)

**Mitigation**:
- Authorization check in `check_yield_authorization()` requires caller in authorized set
- Non-admins must pass `is_yield_distributor_authorized()` check
- Admin auth is immutable (set at initialization)

**Detectability**: Alert on authorization failure spike (> 5 per minute)

**Risk Level**: ✅ MITIGATED

---

### ATK-2: Per-Distribution Limit Bypass

**Threat**: Authorized distributor sends multiple transactions in same ledger to exceed per-distribution limit.

**Attack Method**:
```
1. Admin sets per_distribution_limit = 100M stroops
2. Distributor D calls distribute_yield(D, token, 60M) → Succeeds
3. Distributor D calls distribute_yield(D, token, 60M) in same ledger
4. Second call checks amount (60M) <= limit (100M) → TRUE
5. Second call succeeds, distributor now contributed 120M
```

**Impact**: Per-distribution limit circumvented for one period

**Mitigation**:
- Stellar ledger sequencing: Each account can submit ≤1 transaction per ledger
- Soroban enforces nonce/sequence isolation
- Even if multiple txs in same block, they execute sequentially
- Each tx re-checks limit independently (no shared state during block)

**Detectability**: Cumulative tracking will catch excess (see ATK-4)

**Risk Level**: ✅ MITIGATED (by ledger isolation)

---

### ATK-3: Cumulative Limit Bypass via Period Reset Manipulation

**Threat**: Attacker manipulates period reset timestamp to artificially extend or compress cumulative window.

**Attack Method**:
```
1. Attacker calls set_yield_distribution_period(admin, token, 1)
2. Somehow tricks admin into calling it at low ledger N
3. Attacker watches for ledger N+1
4. At ledger N+2, cumulative resets (period elapsed)
5. Attacker distributes beyond previous cumulative in same "period"
```

**Impact**: Potentially exceeds cumulative limit intent (if period was meant to be longer)

**Mitigation**:
- Admin is the *only* caller who can set periods (`require_auth()` on `admin`)
- Admin key is generated at initialization and immutable
- Period reset is deterministic: `current_ledger > last_reset + period_length`
- Cannot be manipulated by non-admin
- Admin controls period length — if too short, increases limit or extends period

**Detectability**: Monitor `set_yield_distribution_period` calls (infrequent, admin-only)

**Risk Level**: ✅ MITIGATED (admin-only, deterministic reset)

---

### ATK-4: Cumulative Tracking Overflow

**Threat**: Cumulative yield counter overflows `i128`, wraps around, bypasses limit.

**Attack Method**:
```
1. Admin sets cumulative limit to i128::MAX
2. Distributor contributes i128::MAX - 1 stroops
3. Distributor contributes 1 more stroops
4. checked_add(i128::MAX - 1, 1) → i128::MAX (OK, at limit)
5. Distributor contributes 1 more stroops
6. checked_add(i128::MAX, 1) → OVERFLOW panic
```

**Impact**: Contract panics instead of returning error

**Mitigation**:
- Use `i128::checked_add()` which panics on overflow
- Panic is caught by Soroban runtime (transaction rejected, no state change)
- Cumulative limit should never exceed i128::MAX (practically impossible)
- Limit validation: 0 <= limit <= i128::MAX (enforced by type system)

**Detectability**: Panic detected in logs; alert on overflow attempts

**Risk Level**: ✅ MITIGATED (checked arithmetic, panic safe)

---

### ATK-5: Revocation Race Condition

**Threat**: Distributor revocation is processed in parallel with pending distribution transaction.

**Attack Method**:
```
1. Distributor D submits distribute_yield(D, token, amount) tx
2. Admin simultaneously submits revoke_yield_distributor(admin, token, D) tx
3. Both enter mempool for ledger N
4. Question: Which executes first? D's distribution or revocation?
```

**Impact**: Potential for "revoked" distributor's tx to execute after revocation in same ledger

**Mitigation**:
- Stellar network: Each account has a strict sequence number
- Transactions execute in ascending sequence order per account
- Within same ledger: revocation tx and distribution tx from different accounts are independent
- Worst case: Both execute, distribution appears after revocation in ledger history (clear audit trail)
- Distributor is revoked before next ledger (authoritative block boundary)

**Detectability**: Monitor `revoke_yield_distributor` followed by `distribute_yield` in same ledger; flag for audit

**Risk Level**: ✅ LOW RISK (clearly auditable, no state corruption)

---

### ATK-6: Admin Key Compromise

**Threat**: Attacker obtains admin private key, can authorize arbitrary distributors or modify limits.

**Attack Method**:
```
1. Attacker compromises admin's private key (not a contract vulnerability)
2. Attacker calls authorize_yield_distributor(admin, token, attacker_addr)
3. Attacker calls set_cumulative_yield_limit(admin, token, 999999999999)
4. Attacker distributes arbitrary yield to themselves
```

**Impact**: Complete compromise of yield distribution control

**Mitigation**:
- **Key management**: Admin keys must be protected with industry-standard security (hardware wallet, HSM, etc.)
- **Audit trail**: All admin actions are immutable contract events
- **Emergency pause**: `set_pause_flags()` can pause yield distribution if compromise detected
- **Admin handover**: Governance can propose and execute admin transfer if current admin is compromised

**Detectability**: 
- Monitor admin authorization/limit changes for anomalies
- Alert on rapid-fire authorization of new distributors
- Alert on limit increases to extreme values

**Risk Level**: ⚠️ CRITICAL (but covered by key management ops, outside contract scope)

---

### ATK-7: Distributor Revocation Bypass via Replay

**Threat**: Attacker replays an old `authorize_yield_distributor` transaction from the mempool or archive.

**Attack Method**:
```
1. Old tx: authorize_yield_distributor(admin, token, old_dist) was signed by admin in the past
2. Admin revokes old_dist
3. Attacker captures signed tx from old block, submits it again
4. Soroban replays tx, old_dist gets re-authorized?
```

**Impact**: Distributor authorization cannot be revoked if attacker has signed tx

**Mitigation**:
- Soroban enforces transaction nonce/sequence numbers (no replay)
- Each transaction includes: source account, sequence number, timestamp
- Replaying same tx with same sequence fails (sequence already consumed)
- Cannot replay with new sequence (requires re-signing by attacker with new nonce, which attacker cannot do)

**Detectability**: Replay attempts detected by network (rejected as duplicate sequence)

**Risk Level**: ✅ MITIGATED (nonce enforcement)

---

### ATK-8: Front-Running Distributor Authorization

**Threat**: Attacker front-runs admin's authorization tx to claim limited resource.

**Attack Method**:
```
1. Admin submits: set_per_distribution_yield_limit(admin, token, 1000)
2. Attacker sees tx in mempool, submits: distribute_yield(attacker, token, 999) before admin's limit tx
3. If attacker's tx executes first: limit is still 0 (unlimited)
4. Attacker successfully distributes as unauthorized
```

**Impact**: Attacker distributes before limit takes effect

**Mitigation**:
- Admin authorization must happen *before* any yield distribution (governance responsibility)
- Contract enforces: unauthorized callers always rejected (regardless of limit state)
- Even with 0 limit (no limit), unauthorized caller still fails authorization check
- Per-distribution limit is supplementary to authorization, not a replacement

**Detectability**: Monitor for distributions from unauthorized addresses; should be zero after deployment

**Risk Level**: ✅ MITIGATED (authorization is prerequisite, not supplementary)

---

### ATK-9: Cumulative Limit Underflow via Negative Distribution

**Threat**: Distributor calls `distribute_yield` with negative amount to artificially increase cumulative capacity.

**Attack Method**:
```
1. Cumulative limit: 100M, current: 90M
2. Distributor calls distribute_yield(D, token, -10M)
3. amount <= 0 check should reject...
4. If buggy: cumulative = checked_add(90M, -10M) = 80M
5. Distributor now has more room to distribute
```

**Impact**: Cumulative limit circumvented via negative yields

**Mitigation**:
- Check: `if amount <= 0 { return Err(PoolError::InvalidAmount) }`
- Negative amounts rejected before any state change
- Cumulative only updated after amount validation

**Detectability**: Alert on InvalidAmount errors (should be rare)

**Risk Level**: ✅ MITIGATED (early validation)

---

### ATK-10: Double-Authorizing Same Distributor

**Threat**: Admin accidentally calls `authorize_yield_distributor` twice for same distributor, causing list duplication.

**Attack Method**:
```
1. authorize_yield_distributor(admin, token, D)
2. (time passes)
3. authorize_yield_distributor(admin, token, D) — called again by mistake
4. D is now in authorized list twice?
```

**Impact**: Operational confusion, possible revocation bug (removes only first occurrence)

**Mitigation**:
- `authorize_yield_distributor` checks if distributor already in set
- If found: returns OK immediately (idempotent)
- If not found: adds to set
- Revocation also searches and removes (handles duplicates safely, removes all)

**Detectability**: Query `get_authorized_distributors` — should show no duplicates

**Risk Level**: ✅ MITIGATED (idempotent operations)

---

### ATK-11: Cumulative Reset Timing Bug

**Threat**: Period reset logic has off-by-one error in ledger sequence comparison.

**Attack Method**:
```
1. set_yield_distribution_period(admin, token, 100)
2. Period resets: at ledger 100, 200, 300, etc.
3. Bug: check is `current_ledger == last_reset + period` (equality, not >)
4. At ledger 200: first distribution resets, then distributes, then next tx at 201 fails to reset
```

**Impact**: Cumulative limits not reset on expected schedule, confusing operational state

**Mitigation**:
- Check: `current_ledger > last_reset + period_length` (strict inequality)
- Guarantees reset happens on ledger N+1 after period boundary
- Reset timestamp updated immediately, preventing double-reset
- Deterministic and unambiguous

**Testing**: Unit test `test_bounded_yield_period_reset` covers boundary conditions

**Risk Level**: ✅ MITIGATED (tested)

---

### ATK-12: Share Price Divergence from v3

**Threat**: Bounded yield logic introduces rounding errors or state-management bugs that diverge share pricing from v3.

**Attack Method**:
```
1. v3 share price formula: assets / shares (with virtual offsets)
2. v4 yield authorization added before TotalManagedAssets update
3. If bug: cumulative limit prevents some yield, TotalManagedAssets != actual pool value
4. Share prices diverge between v3 and v4 contracts
```

**Impact**: Depositors in v4 get incorrect pricing; arbitrage opportunity vs v3

**Mitigation**:
- Bounded yield authorization checks happen **before** TotalManagedAssets update
- If authorization fails: no state change, no yield recorded
- If authorization succeeds: TotalManagedAssets updated identically to v3
- Commission invariants (INV-LP-1 through INV-LP-6) must still hold
- Extensive testing: deposit/withdraw/yield round-trips verified against v3

**Testing**:
- All commission invariant tests pass
- v3 → v4 state snapshot validation
- Share price stability benchmarks

**Risk Level**: ✅ MITIGATED (tested, invariant-checked)

---

## Security Invariants

### INV-BY-1: Authorization is Mandatory

**Statement**: Only the pool admin or an explicitly authorized distributor can distribute yield.

**Formal**:
```
For all calls to distribute_yield(from, token, amount):
  If from == admin_address:
    Call succeeds (with authorization checks)
  Else if from in YieldDistributorsSet(token):
    Call succeeds (with per-distribution and cumulative checks)
  Else:
    Call fails with error YieldDistributorNotAuthorized
```

**Verification**:
- Unit test: `test_bounded_yield_unauthorized_distributor` — non-authorized caller fails
- Unit test: `test_bounded_yield_admin_authorization` — admin succeeds
- Unit test: `test_bounded_yield_authorize_distributor` — authorized distributor succeeds

**Enforcement**:
- Code path: `check_yield_authorization()` enforces this at contract entry
- Cannot be bypassed: No other path to update TotalManagedAssets
- No emergency bypass: Only way to disable is pause via granular flags (admin-controlled)

---

### INV-BY-2: Limits are Enforced

**Statement**: No yield distribution exceeds per-distribution or cumulative limits.

**Formal**:
```
For all calls to distribute_yield(from, token, amount):
  If per_distribution_limit(token) > 0:
    amount <= per_distribution_limit(token)
  
  If cumulative_limit(token) > 0:
    distributor_cumulative_yield(from, token) + amount <= cumulative_limit(token)
    (after period reset if period elapsed)
```

**Verification**:
- Unit test: `test_bounded_yield_per_distribution_limit` — per-dist enforced
- Unit test: `test_bounded_yield_cumulative_limit` — cumulative enforced
- Unit test: `test_bounded_yield_period_reset` — reset works correctly
- Stress test: attempt to exceed limits via multiple distributors

**Enforcement**:
- Code path: `check_and_update_cumulative_yield()` enforces this at contract entry
- Atomic: All or nothing (if check fails, no state change)
- No rollback needed: Transaction reverted by Soroban runtime

---

### INV-BY-3: Share Pricing Remains Stable

**Statement**: Share price formula and yield accrual are unchanged from v3.

**Formal**:
```
For v3 and v4 contracts with identical state history:
  share_price_v3 == share_price_v4
  
where share_price = (total_managed_assets + VIRTUAL_ASSETS) / (total_shares + VIRTUAL_SHARES)

And total_managed_assets(v3) == total_managed_assets(v4) at every ledger.
```

**Verification**:
- Commission invariant tests: All INV-LP-1 through INV-LP-6 pass on v4
- State snapshot test: v3 vs v4 snapshots match post-upgrade
- Round-trip test: deposit → yield → withdraw → deposit returns same value

**Enforcement**:
- Code: Yield authorization happens *before* TotalManagedAssets update
- No modification to price formula
- No modification to deposit/withdraw logic
- Only change: authorization gate before yield acceptance

---

## Assumptions and Limitations

### Trust Assumptions

1. **Admin Key Security**: We assume admin private keys are protected with industry-standard practices (HSM, hardware wallet, multisig governance). Compromise of admin keys is out of scope for this design but covered by operational key management policies.

2. **Distributor Identity**: We assume all addresses in `YieldDistributorsSet` are legitimate entities. Vetting distributor identity and ongoing suitability is an admin responsibility.

3. **Stellar Network Integrity**: We assume Stellar network enforces transaction sequencing, nonce uniqueness, and ledger finality as documented. Network-level attacks (51% attack, consensus bypass) are out of scope.

4. **Soroban Runtime Correctness**: We assume Soroban enforces signature verification, transaction isolation, and checked arithmetic as documented. Runtime bugs are out of scope.

### Design Limitations

1. **Per-Distributor Cumulative Limits Not Supported**: The current design tracks cumulative yield per distributor within a period, but does not support per-distributor caps separate from the global cumulative limit. Future version could add this.

2. **Distributor Revocation Not Retroactive**: Revoking a distributor does not undo past yields they contributed. Audits must review yield sources separately.

3. **Period Reset Is Not Configurable Per-Distributor**: All distributors reset on the same schedule. Future versions could support per-distributor periods if needed.

4. **No Rate Limiting**: The system does not implement transaction rate limiting (e.g., max distributions per minute). This is delegated to the backend or API gateway.

5. **Cumulative Limit Is Shared**: All distributions (admin and distributors) share the cumulative limit. Admin distributions cannot exceed it. Future versions could add separate admin allocations if needed.

### External Dependencies

1. **Token Contract**: We depend on `token::Client::transfer()` to execute correctly. If token contract is malicious or buggy, it could corrupt pool state (e.g., transfer fails but contract returns success). Mitigation: Use well-audited token contracts (Stellar protocol native assets recommended).

2. **RPC Endpoint**: We depend on RPC to return accurate ledger sequence numbers. If RPC returns incorrect sequences, period resets could be skipped or triggered early. Mitigation: Use multiple RPC endpoints and reconcile state.

3. **Backend Event Indexing**: Authorization audit events are useless if not indexed by backend. Mitigation: Backend team must implement event indexing per [Audit Events and Metrics](./BOUNDED_YIELD_AUDIT_AND_METRICS.md).

---

## Compatibility Impact

### v3 Contracts (Existing Deployments)

- No changes required (v3 contracts remain as-is)
- Existing deposits, withdrawals, and yield distributions continue to work
- Share prices are not retroactively affected

### v4 Contracts (New Deployments)

- **Breaking Change**: Non-admin `distribute_yield` callers must now be pre-authorized
- **Migration**: All existing non-admin distributors must be added via `authorize_yield_distributor` before hard cutover
- **Mitigation**: 7-day grace period during canary deployment to pre-authorize known distributors

---

## Rollout Steps and Verification

See [Migration Strategy](./BOUNDED_YIELD_MIGRATION.md) for complete rollout plan.

Key verification steps:
1. Pre-migration snapshot of `TotalYieldDistributed`, `TotalShares`, `TotalDeposits`
2. Post-migration validation: snapshots match
3. Run all commission invariant tests
4. Execute end-to-end integration tests
5. Monitor for 24 hours without incident (canary phase)
6. Pre-authorize all known distributors during grace period
7. Hard cutover at end of phase 3

---

## Conclusion

The bounded yield distribution authorization system introduces necessary governance controls to the LendingPool contract while maintaining strong security properties:

- ✅ Authorization is mandatory and cannot be bypassed
- ✅ Resource limits are atomically enforced
- ✅ Share pricing remains stable and deterministic
- ✅ All state mutations are immutable audit events
- ✅ Backward compatibility maintained for existing contracts

Key risks (all mitigated):
- ⚠️ Admin key compromise → Covered by key management ops + audit trail
- ⚠️ Cumulative limit too restrictive → Covered by dynamic adjustment capability
- ⚠️ Distributor revocation race condition → Covered by clear audit trail
- ⚠️ Period reset timing bug → Covered by unit tests and deterministic logic

This design is ready for production deployment after successful canary phase and pre-authorization of known distributors.
