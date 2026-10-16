# Contributing

Thanks for contributing. This document covers the change-classification gate that
CI applies to high-risk paths, how to satisfy it, and the clean-checkout setup
that CI continuously verifies.

## Contributor quick start (clean checkout)

CI runs the commands below on a fresh runner for every change to this guide, so
they are guaranteed to match the package scripts and required environment. Run
them in order from a clean checkout:

```bash
# 1. Install dependencies (uses the committed lockfile)
npm ci

# 2. Environment setup — copy the example and fill in local-only values
cp .env.example .env

# 3. Migrations
npm run migrate

# 4. Seed local data
npm run seed

# 5. Focused test for the area you changed
npm run test
```

Every script referenced above (`migrate`, `seed`, `test`) must exist in
`package.json`; the docs-verification workflow fails and points at the exact
section and command when a referenced script is missing. Required environment
variables are checked against `.env.example`, so add new variables there when you
introduce them.

The workflow uses only local, non-production values. It never uses production
secrets and never performs external value-bearing transactions.

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

## Troubleshooting

Supported toolchain: Node.js 20 LTS (or newer 20.x) and npm 10+, on Linux
(Ubuntu 22.04+), macOS 13+, or Windows 11 with WSL2. CI runs on Ubuntu; other
platforms are supported for local development.

Common recovery steps:

- **`npm ci` fails on a lockfile mismatch** — do not edit the lockfile by hand.
  Run `npm install` locally, commit the updated `package-lock.json`, and re-run
  `npm ci`.
- **A documented script is missing** — the docs-verification workflow reports the
  file/section and the exact command that drifted. Add the script to
  `package.json` or correct the guide so they match.
- **A required variable is unset** — compare your `.env` against `.env.example`;
  the workflow checks documented variables against that file. Copy any missing
  keys and restart the failing command.
- **Migrations or seed fail on a fresh checkout** — confirm the database is
  reachable with the values from `.env.example`, then re-run `npm run migrate`
  followed by `npm run seed`.
- **Tests pass locally but fail in CI** — ensure you ran the focused command from
  the quick start on a clean checkout; CI starts from a fresh runner with no
  cached state.
