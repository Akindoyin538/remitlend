# Contributing

Thanks for contributing. This document covers the change-classification gate that
CI applies to high-risk paths, and how to satisfy it.

## Risk classification

CI classifies every pull request by the paths it changes. The classification is
derived from the diff, so it cannot be bypassed by editing labels or checkboxes.
A contributor may *refine* the classification (for example, to add a risk class
that the path heuristic missed) by adding entries to the `risk-classes` section
of `.ci/risk-classes.json` in the same PR. Refinement can only add required
evidence, never remove it: the path-derived classes are always enforced.

| Risk class | Triggered by changed paths | Minimum evidence |
| --- | --- | --- |
| `money-arithmetic` | `backend/**/money*`, `backend/**/ledger*`, `backend/**/interest*`, `backend/**/fees*` | Unit tests for the arithmetic plus a property/fuzz test over the boundary (rounding, overflow, zero/negative amounts). |
| `loan-transitions` | `backend/**/loan*`, `backend/**/state-machine*`, `backend/migrations/**` | Integration test exercising the transition, plus a property/fuzz test asserting no illegal state is reachable. |
| `contract-authorization` | `contracts/**`, `backend/**/auth*`, `backend/**/permissions*` | Unit tests for the authorization predicate plus an E2E test for the allowed and denied paths. |
| `indexing` | `backend/**/index*`, `backend/**/search*`, `backend/**/query*` | Integration test against the real index, plus a property/fuzz test for idempotent re-indexing. |
| `key-custody` | `backend/**/keys*`, `backend/**/custody*`, `backend/**/signing*` | Unit tests for key handling plus an E2E test covering rotation and revocation. |

## Reporting missing evidence

When a required class has no linked evidence, CI fails with the exact command or
test category that is missing, for example:

```
[risk-gate] money-arithmetic: missing property/fuzz test
  required: npm run test:property -- --grep "money"
  or link a reviewed rationale in the PR description under "## Risk rationale".
```

A reviewed rationale is accepted only when a maintainer approves it; it does not
replace the unit or integration evidence, which is always required.

## Exemptions

Two narrow exemptions exist, and both are path-scoped:

- **Documentation-only changes** — a PR whose diff touches only `*.md`, `docs/**`,
  or `LICENSE` is exempt from the gate.
- **Generated changes** — a PR whose diff touches only files marked generated
  (for example `**/*.generated.*`, `**/dist/**`, lockfiles) is exempt.

A PR that mixes an exempt path with a risk-class path is *not* exempt; the risk
class applies to the whole PR.

## Rollout

The gate is trialed in **report-only** mode first: it posts the missing-evidence
report as a comment but does not block the merge. After the trial period it is
switched to merge-blocking. The mode is controlled by `risk-gate.mode` in
`.ci/risk-classes.json` (`report` or `block`).
