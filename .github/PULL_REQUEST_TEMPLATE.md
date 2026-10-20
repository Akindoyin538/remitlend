# Pull Request

## Summary

<!-- Describe what this PR changes and why. Link the issue. -->

Closes #

## Scope

<!-- Which boundary does this touch (contracts, backend, frontend, infra)? -->

- [ ] Contracts
- [ ] Backend API
- [ ] Frontend
- [ ] Infrastructure / tooling
- [ ] Documentation only

## Threat model notes

<!-- Required when the change affects authorization, financial arithmetic, chain state, or persisted data. -->

- Actors and trust boundaries affected:
- Authorization checks added or changed (who may call what, and the failure path for unauthorized callers):
- Input validation and resource bounds (batch sizes, iteration limits, amount/reference validation):
- Replay / retry / idempotency considerations:
- Stale-data and dependency-failure behavior:

## Compatibility impact

<!-- Required for contract, API, or storage changes. -->

- [ ] Additive only — no breaking signature or storage-layout changes
- [ ] Breaking change (describe migration path below)
- Deployed-contract compatibility:
- API consumer compatibility:
- Persisted-data / storage-layout compatibility:

## Migration

<!-- Storage layout, data migration, or manifest changes. Include before/after measurements where relevant. -->

- Migration steps:
- Rollback steps:
- Before/after measurements (performance or data):

## Observability

<!-- Metrics, structured errors, audit events, and operational diagnostics added or changed. -->

- Metrics:
- Structured errors:
- Audit events:
- Operational diagnostics / alerts:

## Rollout

<!-- Ordered steps to safely ship and verify in production. -->

1.
2.
3.

## Verification evidence

<!-- Paste commands run and their results. Narrowest relevant package tests, type checks, linting, contract tests, and an integration/e2e scenario covering the full workflow. -->

- [ ] Package tests
- [ ] Type checks
- [ ] Linting
- [ ] Contract tests
- [ ] Integration / end-to-end scenario

```
# commands and results
```

## Checklist

- [ ] Financial arithmetic, chain state, and user-visible status derive from authoritative sources
- [ ] Success, authorization failure, boundary values, retries, stale data, and dependency-failure paths have focused automated tests
- [ ] Relevant architecture, API, environment, migration, or contributor documentation updated
- [ ] Scope limited to the linked issue; unrelated changes excluded
