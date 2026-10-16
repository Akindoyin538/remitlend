# Backend

This directory contains the backend service for the application.

## Development

### Seeding local data

The seed tooling supports named, versioned scenarios so that local product
development can reproduce the boundary states that borrower, lender, support,
and admin contributors care about. Scenario data is synthetic and deterministic:
repeated seed runs produce the same stable identifiers and do not accumulate
duplicate records.

#### Available scenarios

| Scenario | Principal | Lifecycle state | Expected API/UI behavior |
| --- | --- | --- | --- |
| `borrower-pending` | borrower | pending | Loan application is visible in the borrower dashboard with a pending status; approval actions are unavailable. |
| `borrower-approved` | borrower | approved | Approved loan is listed with repayment schedule; borrower can view next payment. |
| `borrower-partially-repaid` | borrower | partially repaid | Outstanding balance reflects partial repayment; repayment history shows prior payments. |
| `borrower-repaid` | borrower | repaid | Loan is closed with zero balance; no further repayment actions are offered. |
| `borrower-defaulted` | borrower | defaulted | Loan is flagged as defaulted; collections messaging is shown and repayment is restricted. |
| `lender-disputed-score` | lender | disputed-score | Disputed score is surfaced with the dispute state; score-dependent actions are gated. |
| `support-degraded-service` | support | degraded-service | Degraded-service banner is shown; support tooling reflects limited availability. |

Each scenario produces stable identifiers (for example, deterministic user and
loan IDs) so that tests can reference them without hard-coding ad hoc values.

#### Running seed and reset

Seed and reset commands refuse to run against non-development environments
unless an explicit safe override is provided. This prevents accidental data
changes in staging or production.

```sh
# Seed a specific scenario (development only)
<seed-command> --scenario borrower-pending

# Reset seeded data (development only)
<reset-command>

# Explicit override for a non-development environment (use with care)
<seed-command> --scenario borrower-pending --allow-non-development
```

#### Smoke tests

Smoke tests validate scenario constraints and principal ownership. They assert
that each scenario is owned by the expected principal and that lifecycle
constraints (for example, a repaid loan has a zero balance) hold.
