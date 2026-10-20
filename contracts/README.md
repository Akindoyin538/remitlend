# Contracts

This directory contains the Soroban smart contracts that power the protocol.

## Layout

- `loan_manager/` — pool accounting, loan origination, disbursement, and repayment.
- `token/` — SEP-41 style token used by the pool in tests and local development.

## Token assumptions

Pool accounting must never assume that a token API call moved the exact
requested units. The contracts rely on the following enforceable assumptions,
and each one has test evidence in `loan_manager/src/test.rs`:

1. **Transfers are all-or-nothing.** A token either moves the full requested
   amount or fails. Short transfers (moving less than requested) are treated as
   a rejected transfer and must not mutate pool state.
2. **Failures are surfaced, not swallowed.** A token that returns an error, or
   that returns a malformed/non-boolean value, is treated as a failed transfer.
   The pool must not commit balances, shares, liabilities, or events in that
   case.
3. **Observed balances are authoritative.** After every state transition the
   pool reconciles its internal accounting against the observed token balance
   of the pool account. Any mismatch aborts the transition.
4. **Unsupported token semantics are rejected at configuration time.** Tokens
   that do not satisfy the assumptions above (for example, fee-on-transfer or
   rebasing tokens) must be rejected when the pool is configured, rather than
   silently tolerated at runtime.

## Test doubles

`loan_manager/src/test.rs` includes focused token test doubles:

- `RejectingToken` — every transfer returns an error.
- `MalformedToken` — transfers return a non-boolean / unexpected value.
- `ShortTransferToken` — transfers succeed but move less than requested.
- `MockToken` — a well-behaved token used to assert reconciliation on success.

State-transition tests cover deposit, withdrawal, disbursement, and repayment
paths, including rollback behavior: failed or rejected transfers leave
balances, shares, liabilities, and events unchanged, while successful
operations reconcile observed token balances with internal accounting after
each transition.
