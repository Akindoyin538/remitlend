# Architecture

This document describes the high-level architecture of the protocol, the
contract/backend boundary, and the money semantics shared between them.

## Components

- `contracts/` — on-chain pool, loan lifecycle, and settlement logic.
- `backend/` — off-chain previews, disclosures, and money calculations.
- `docs/` — borrower-facing documentation, including
  `docs/loan-cost-disclosure.md`.

## Repayment allocation (versioned)

Partial and final repayments follow a single deterministic allocation rule,
identified by `ALLOCATION_RULE_VERSION` (currently `1`). Contract settlement and
backend previews MUST use the same version; a mismatch is a bug.

Allocation order for an amount actually transferred:

1. **Accrued interest** — interest accrued up to the accrual boundary.
2. **Fees** — outstanding fees, in the order they were assessed.
3. **Principal** — remaining outstanding principal.

Each component is reduced by `min(remaining_amount, component_balance)` in that
order. Any amount left after principal is fully repaid is an overpayment and is
returned to the payer (or credited per the loan's terms); it never reduces the
pool receivable.

### Accrual boundary

Accrued interest is computed from the loan's `lastAccrualTimestamp` up to the
repayment's block timestamp (`block.timestamp` on-chain; the same value supplied
to the backend preview). Interest for the interval is accrued exactly once and
`lastAccrualTimestamp` is advanced to the boundary on settlement. No interest
accrues for zero-length intervals.

### Rounding and dust

- Interest is computed with integer arithmetic and rounded **down** to the
  smallest unit; the residual (dust) stays with the borrower and is never
  charged retroactively.
- Component reductions are exact integers; the sum of component reductions
  equals the amount applied and never exceeds the amount transferred.
- Dust below one unit is not carried forward as a separate balance; it is
  absorbed by the next accrual interval.

### Invariant

No successful settlement call may reduce the pool receivable by more than the
amount actually transferred. Contract and backend MUST return identical
component balances for shared test vectors, including payments below accrued
interest, exactly accrued interest, one unit below payoff, overpayment, and
repeated small payments.

## Documentation alignment

Borrower-facing semantics in `docs/loan-cost-disclosure.md` and the loan
state-machine documentation MUST reflect the allocation order, accrual
boundary, and rounding rules above whenever they change.
