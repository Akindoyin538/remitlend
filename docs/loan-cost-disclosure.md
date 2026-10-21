# Loan Cost & Fee Disclosure

How RemitLend shows a borrower the **complete** cost of a loan before they sign, and the rules contributors must follow when changing anything in that path.

Addresses issue [#320](https://github.com/JhayJ22/remitlend/issues/320).

---

## 1. Why this exists

Before this change the loan wizard showed an APR, a principal and a "Total Repayment" that were computed inline in the signature step with `principal * 12 * termDays / 36500`. That number:

- was derived from a `number` multiplication, so it could not be reconciled with the settlement amount on chain;
- omitted every fee except a hard-coded network estimate;
- hard-coded the interest rate in three different files, so the disclosed rate and the submitted rate could drift apart;
- never showed the *effective* rate — a loan with a large origination fee and a low headline APR looked cheaper than it was.

The disclosure engine replaces that with one exact-math implementation used by every surface.

---

## 2. The engine

`frontend/src/app/utils/loanCostDisclosure.ts`

| Export | Purpose |
|---|---|
| `computeLoanCostDisclosure(input)` | Pure function: loan terms in, complete disclosure out, or a typed error. Never throws. |
| `buildDisclosureRows(d)` | Display rows for a table, in a stable order. |
| `summarizeDisclosure(d)` | One-line summary for screen readers and toasts. |
| `reconcileWithAmortization(d, amort)` | Compares the local estimate with the backend schedule. |
| `applyAuthoritativeTotals(d, amort)` | Returns a disclosure whose totals come from the backend. |
| `formatBps`, `formatDisclosureAmount`, `addDaysIso`, `isZeroAmount` | Formatting helpers. |
| `parseDecimalToMinorUnits`, `minorUnitsToDecimal`, `mulDiv`, `divRoundHalfUp`, `numberToMinorUnits` | Exact bigint arithmetic. |
| `DEFAULT_LOAN_ANNUAL_RATE_BPS` | The single source of truth for the product rate (`1200` = 12 %). |

### Exact arithmetic, by rule

1. **Money is `bigint` minor units.** Never a `number`. `1000 USDC` is `100000n`.
2. **Rates are integer basis points.** `1200n` = 12 %. `12.5 %` is `1250n`.
3. **One rounding rule.** `divRoundHalfUp` — half away from zero — applied once, at the asset's own precision, and only at the end of a computation. Intermediate products are never rounded.
4. **The total is always the sum of the displayed components.** The panel renders the components and the total from the same disclosure object, so they cannot disagree.

```
principal + interest + originationFee + serviceFee === totalRepayment
```

This invariant is asserted in `loanCostDisclosure.test.ts`.

### Validation and bounds

`computeLoanCostDisclosure` returns `{ ok: false, error }` — never a throw, never a `NaN`:

| Code | Trigger |
|---|---|
| `invalid_principal` | Non-numeric, zero, negative, over-length, exponent form, signed, or missing asset. |
| `invalid_term` | Non-integer, `< 1`, or `> 1825` days. |
| `invalid_rate` | Rate outside `0 … 100 000` bps. |
| `invalid_fee` | A fee outside the same range. |
| `fees_exceed_principal` | Upfront fees `>=` principal (nothing would be disbursed). |
| `invalid_network_fee` | Malformed network fee or unknown fee asset. |
| `invalid_date` | Unparseable `startDate`. |

Bounded resources: amount strings are capped at `MAX_DISCLOSURE_INPUT_LENGTH` (40 chars), terms at `MAX_DISCLOSURE_TERM_DAYS` (1825), and the disclosure always contains at most one schedule row. There is no loop over a caller-supplied length, so a corrupt input cannot turn a render into an unbounded operation.

---

## 3. Authoritative source of truth

The **lending pool amortization** returned by `GET /loans/amortization-preview` is the settlement record. The local computation is an estimate.

- `reconcileWithAmortization` compares them in minor units with a tolerance of one minor unit and returns `matched`, `divergent` or `unavailable`.
- `applyAuthoritativeTotals` produces the disclosure actually rendered: interest, cost of credit and total repayment come from the server; the locally computed components (fees, effective APR, late-fee terms, due date) are kept because the server does not return them.
- A divergence is **surfaced**, never silently absorbed. The panel renders a warning naming the on-chain schedule as binding.

The signature step reads the amortization through `useLoanAmortizationPreview`, which is already cached from the repayment step, so the comparison is normally a cache hit and costs no extra request.

> If the preview is unavailable the panel shows the local estimate and says so
> (`data-testid="loan-cost-reconciliation-stale"`). It never shows a partial
> breakdown, and it never disables itself silently.

---

## 4. What the borrower sees

`frontend/src/app/components/loan/LoanCostDisclosurePanel.tsx`

- **Amount requested** and **amount disbursed to you** — these differ whenever an upfront fee is deducted, which was previously invisible.
- **Interest rate (nominal APR)** — the rate that is actually charged.
- **Interest over the term**, and each fee named individually (origination, service).
- **Total cost of credit** = interest + upfront fees.
- **Effective APR (all fees included)** — the headline number that annualises the all-in cost over the actual term. It is always `>=` the nominal APR.
- **Total repayment**, **first payment due**, and the **late-payment charge with its cap**.
- **Network fee** shown separately and labelled "not financed", because it is paid in XLM and is not repaid with the loan.
- Plain-language statements rendered verbatim, including a screen-reader-only summary.

`LoanCostDisclosureError` renders a typed failure instead of a broken panel. When the cost cannot be computed, `StepFinalSignature` disables **Sign & Submit** — a borrower is never asked to sign a request whose cost is unknown.

### Surfaces

| Surface | What it shows |
|---|---|
| `StepAmountAsset` | Live cost preview (interest, upfront fees, total you repay) and the effective APR next to the nominal one, updating as the amount or term changes. |
| `StepRepaymentSchedule` / `RepaymentScheduleTable` | Effective APR derived from the authoritative schedule, plus a divergence warning. |
| `StepFinalSignature` | The full panel, and the same line items in the transaction preview modal that the wallet signs. |
| `TransactionPreviewModal` | `details` now carry amount received, nominal APR, effective APR, interest, fees, cost of credit and total repayment. |

---

## 5. Partial repayment allocation (rule `ALLOCATION_V1`)

A partial repayment must reduce the outstanding balance by exactly one deterministic rule, shared by the contract, the backend preview and the borrower disclosure. The rule is versioned as **`ALLOCATION_V1`**; any change to the order, the accrual boundary or the rounding below requires a new version identifier and a migration note here.

### Allocation order

Every transferred amount is applied in this order, each step consuming only what remains:

1. **Accrued interest** — interest accrued up to the accrual boundary (below).
2. **Fees** — outstanding origination/service fees, in the order they were booked.
3. **Principal** — the remaining loan principal.

A payment smaller than the accrued interest reduces only interest; principal and fees are untouched. A payment exactly equal to accrued interest clears interest and leaves principal unchanged. A payment one minor unit below the payoff leaves exactly one minor unit outstanding.

### Accrual boundary

Accrued interest is computed at the **repayment ledger timestamp** — the close time of the ledger in which the repayment is applied — using simple interest on the outstanding principal since the last accrual boundary (loan disbursement or the previous repayment). The contract and the backend preview MUST use the same boundary; the backend preview uses the ledger close time of the simulated repayment, not wall-clock time at request handling.

### Rounding and dust

- Interest is computed with `mulDiv` (floor) at the asset's own precision, once, at the accrual boundary. No intermediate rounding.
- Any residual below one minor unit is **not** carried forward and is **not** added to principal; it is dropped at the boundary so the same interval is never double-counted.
- The sum of the applied components equals the transferred amount exactly: `appliedInterest + appliedFees + appliedPrincipal === transferred`. No wei is created or destroyed.
- A successful call MUST NOT reduce the pool receivable by more than the amount actually transferred. Overpayment beyond the full payoff is rejected (or refunded) rather than silently absorbed.

### Shared vectors

The contract and backend MUST return identical component balances for the shared regression vectors: payment below accrued interest, exactly accrued interest, one unit below payoff, overpayment, and repeated small payments. These vectors live alongside the contract tests and are replayed against the backend money calculations.

---

## 6. Compatibility

- **Contracts:** settlement now follows `ALLOCATION_V1` (interest → fees → principal) with the accrual boundary and dust rules above. No ledger entry shape changes.
- **API:** unchanged response shape; component balances now match the contract for the shared vectors.
- **Persisted data:** unchanged. Nothing is written to storage.
- **Behavioural change:** the disclosed "Total Repayment" and APR on the signature step now come from the exact engine and the authoritative schedule. Where the old inline float maths disagreed with the server by a fraction of a cent, the server value is now shown. Interest is still submitted at `DEFAULT_LOAN_ANNUAL_RATE_BPS / 100`, i.e. the same 12 % as before.

### Rollout

1. Merge behind the existing wizard (no feature flag required — the panel is additive).
2. Verify the disclosed total matches `/loans/amortization-preview` for a live loan request.
3. Confirm the effective APR reads `>=` the nominal APR for 30/60/90-day terms.
4. Rollback: revert the commit. There is no persisted state, no migration and no contract change, so rollback is a pure deploy revert.

---

## 7. Threat model notes

| Threat | Mitigation |
|---|---|
| **Misleading cost disclosure** — a borrower signs believing the loan is cheaper than it is. | Effective APR is always shown next to the nominal rate; the total is the exact sum of the disclosed components; server totals override local ones on divergence. |
| **Float rounding drift** — a float-derived total that does not match settlement. | All arithmetic is `bigint`; `number` only ever appears after `toFixed(decimals)` for display. |
| **Allocation divergence** — contract, preview and disclosure apply different rules, so the displayed payoff differs from settlement. | Single versioned rule `ALLOCATION_V1` with an explicit accrual boundary and dust handling, replayed against shared vectors. |
| **Receivable over-reduction** — a call reduces the pool receivable by more than was transferred. | Applied components sum exactly to the transferred amount; overpayment is rejected/refunded. |
