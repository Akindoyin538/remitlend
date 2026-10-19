# Pull Request

## Summary

<!-- Describe what this PR changes and why. Link the issue(s) it closes. -->

Closes #

## Scope & Compatibility Impact

<!--
- Which contracts / modules / APIs are touched?
- Does this change storage layout, event signatures, error codes, or public entrypoints?
- Is it backward compatible with deployed contracts and existing API consumers / persisted data?
- If not, describe the migration path and rollback plan.
-->

- [ ] No storage-layout change
- [ ] No breaking change to public entrypoints / events / error codes
- [ ] Migration required (describe below)
- [ ] Rollback plan documented

## Threat Model Notes

<!--
For authorization, financial, or state-transition changes, document:
- Who can call the new/changed entrypoints (borrower / lender / admin / anyone)?
- What states are valid inputs, and what happens on invalid or terminal states?
- Reentrancy, replay, and idempotency considerations.
- Bounded resource usage (iteration limits, gas ceilings).
-->

## Rollout Steps

<!-- Ordered steps to deploy safely: migrations, feature flags, admin actions, monitoring. -->

1.

## Verification Evidence

<!--
List the narrowest relevant checks you ran and their results:
- Package tests / type checks / lint
- Contract tests
- Integration or end-to-end scenario covering the full workflow
- Before/after measurements for performance or data migrations
-->

- [ ] Unit tests (success, authorization failure, boundary values, retries, stale data, dependency failure)
- [ ] Contract tests
- [ ] Type checks / lint
- [ ] Integration / end-to-end scenario

## Observability

<!-- Metrics, structured errors, audit events, and operational diagnostics added or changed. -->

## Checklist

- [ ] Tests added/updated for new behavior and failure paths
- [ ] Documentation updated (architecture / API / environment / migration / contributor docs)
- [ ] No unrelated changes included
