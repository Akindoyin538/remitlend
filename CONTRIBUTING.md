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

- **feat**: A new feature (corresponds to `MINOR` in Semantic Versioning).
- **fix**: A bug fix (corresponds to `PATCH` in Semantic Versioning).
- **docs**: Documentation only changes.
- **style**: Changes that do not affect the meaning of the code (white-space, formatting, etc).
- **refactor**: A code change that neither fixes a bug nor adds a feature.
- **perf**: A code change that improves performance.
- **test**: Adding missing tests or correcting existing tests.
- **chore**: Changes to the build process or auxiliary tools/libraries.

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

### Contracts Change Requirements

Changes under `contracts/` affect deployed, stateful on-chain code, so PRs touching them must additionally document:

- **Threat model**: who can call the new/changed entry points, what they can influence, and the abuse cases considered (reentrancy, griefing, front-running, unauthorized callers).
- **Authorization**: the exact auth checks (e.g. `require_auth`, admin/role gates) guarding each state-changing path, and the failure mode when they are not met.
- **Compatibility impact**: whether storage keys, event shapes, or entry-point signatures change, and how existing deployed contracts, API consumers, and persisted data remain readable (or the migration path if not).
- **Rollout & rollback**: ordered deployment steps (e.g. initialize → configure → enable) and how to safely revert if a step misbehaves.
- **Verification evidence**: the narrowest relevant `cargo test` output plus any integration/e2e scenario exercising the full workflow.

#### Liquidation & Unwind Policy

When a loan becomes delinquent, contracts must resolve it through a **deterministic unwind policy** rather than ad-hoc admin action. Contributors implementing or modifying this path must ensure:

- **Authorization**: only the configured liquidator role (or an authorized keeper) may trigger an unwind; unauthorized callers fail with an explicit error and emit no state change.
- **Determinism**: the unwind outcome (collateral seizure, remaining balance, status transition) is a pure function of on-chain state — no wall-clock or off-chain inputs beyond the ledger timestamp already recorded.
- **Bounded work**: any iteration over collateral, tranches, or schedules is capped by a configured maximum; exceeding the cap fails closed rather than looping unbounded.
- **Idempotency & retries**: re-invoking an unwind on an already-unwound loan is a no-op or explicit error, never a double-seizure; partial failures leave state consistent for a safe retry.
- **Observability**: emit structured events (loan id, prior status, seized amount, remaining balance, caller) and expose read-only status derived from authoritative on-chain state.
- **Tests**: cover success, authorization failure, boundary values (zero/at-cap collateral), retry/idempotency, and stale or dependency-failure paths.

#### Loan Cancellation & Expired-Request Cleanup

Loan requests that are cancelled or expire before disbursement must be resolved through explicit, auditable entry points. Contributors implementing or modifying this path must ensure:

- **Authorization**: cancellation is permitted only for the borrower, the assigned lender, or an admin, and only while the loan is in a pre-disbursement state (e.g. `Pending`/`Requested`). Any other caller or state fails with an explicit error and emits no state change.
- **State guard**: cancellation is rejected once funds have been disbursed; terminal states (`Cancelled`, `Repaid`, `Liquidated`) are never re-cancelled.
- **Expired-request cleanup**: a cleanup entry point processes requests whose deadline has passed relative to the recorded ledger timestamp. Iteration is capped by a configured maximum per invocation so a single call cannot loop unbounded; callers page through remaining requests.
- **Idempotency & retries**: re-running cleanup over an already-cancelled/expired request is a no-op (or explicit `AlreadyTerminal` error), never a double state transition; partial progress leaves state consistent for a safe retry.
- **Compatibility**: cancellation/cleanup must not change existing storage keys or entry-point signatures for already-deployed loans; any new keys or event shapes are additive and documented in the PR's compatibility-impact section.
- **Observability**: emit structured events (loan id, prior status, caller, reason: `Cancelled`/`Expired`) and structured errors for `Unauthorized`, `AlreadyTerminal`, and `NotExpired` outcomes.
- **Tests**: cover success, authorization failure, already-terminal, not-yet-expired boundary, at-cap cleanup batch, and retry/idempotency paths.

## Environment Variables

```
[risk-gate] money-arithmetic: missing property/fuzz test
  required: npm run test:property -- --grep "money"
  or link a reviewed rationale in the PR description under "## Risk rationale".
```

## Contract Storage Migration Manifests

Every contract version that changes persisted storage **must** ship a storage
migration manifest. The manifest is the single source of truth for how on-chain
state moves from the previous version to the new one, and it is reviewed as part
of the contract PR.

### What a manifest must contain

- **Version identifiers**: the `from` and `to` contract versions (semver) and the
  on-chain storage schema version each maps to.
- **Storage layout**: every key/namespace the version reads or writes, its
  encoding, and whether it is added, unchanged, or removed.
- **Migration steps**: the ordered, idempotent operations that transform `from`
  state into `to` state, one manifest per consecutive version pair.

### Compatibility rules

- Migrations must be **additive** by default: new keys are introduced without
  rewriting existing entries, so deployed contracts and persisted data keep
  working.
- Any **breaking** change (key rename, encoding change, removal) must be called
  out explicitly in the manifest with a documented rollback path.
- A manifest is required for **every** contract version, including no-op
  versions, so the version chain is never ambiguous.

### Validation and resource bounds

- Migrations validate preconditions before mutating state: the stored schema
  version must match the manifest's `from` version, and the expected storage
  shape must be present. A mismatch aborts the migration without partial writes.
- Migration work is bounded: process a fixed maximum number of entries per
  invocation and resume from a recorded cursor rather than looping unbounded.

### Authorization, failure, and rollback

- Only the contract admin (per the contract's authorization model) may trigger a
  migration; unauthorized callers are rejected before any state is read or
  written.
- Migrations are idempotent and safe to retry: a failed or interrupted run
  leaves the recorded version unchanged and can be re-invoked.
- Stale data (a version behind the manifest's `from`) is rejected with a
  structured error rather than silently coerced.
- Rollback restores the previous version marker and reverses only the additive
  steps documented in the manifest; breaking migrations must document their
  manual rollback procedure.

When you add or bump a contract version, add its manifest alongside the
contract and reference it in the PR description under compatibility impact and
rollout steps.

## Testing Requirements

## Exemptions

Two narrow exemptions exist, and both are path-scoped:

- **Documentation-only changes** — a PR whose diff touches only `*.md`, `docs/**`,
  or `LICENSE` is exempt from the gate.
- **Generated changes** — a PR whose diff touches only files marked generated
  (for example `**/*.generated.*`, `**/dist/**`, lockfiles) is exempt.

A PR that mixes an exempt path with a risk-class path is *not* exempt; the risk
class applies to the whole PR.

### Smart Contracts Fuzzing (Soroban)
For consensus-critical changes to smart contracts, fuzz testing is an expected part of the workflow.

Refer to [`contracts/FUZZING_README.md`](contracts/FUZZING_README.md) for full setup instructions, invariant definitions, and running fuzz campaign scripts (`./fuzz_campaign.sh`).

## Accessibility Requirements

RemitLend serves migrant workers on a wide range of devices and assistive
technologies, so accessibility is a correctness requirement, not a nice-to-have.

**Baseline expectations for every frontend change:**

- Meet **WCAG 2.1 Level AA**. Every interactive element must be reachable and
  operable by keyboard, expose an accessible name, and show a visible focus ring.
- Respect the existing focus-management and `prefers-reduced-motion` conventions
  in `src/app/[locale]/globals.css`.
- Provide text alternatives for icons and charts; never encode meaning in colour
  alone.
- Reuse the shared primitives (`components/ui/floating` for tooltips/popovers,
  `components/ui/Modal`, etc.) rather than re-implementing focus traps and ARIA
  wiring.

**Charts and data visualisations:**

- Every chart must ship an accessible data table that exposes the same values as
  the visualisation. Render it with the shared `ChartDataTable` primitive
  (`components/charts/ChartDataTable`) so the table is visually hidden by default
  but remains in the accessibility tree, and is reachable via a visible
  "View as table" toggle.
- Chart elements (bars, points, slices, legend entries) must be keyboard
  navigable: focusable with `Tab`, traversable with the arrow keys, and
  activatable with `Enter`/`Space` where the element has an action. Announce the
  focused datum through an `aria-live` region or `aria-describedby`.
- Bound the rendered table: cap rows at the shared `MAX_CHART_TABLE_ROWS` limit
  and paginate or virtualise beyond it so large datasets cannot exhaust the DOM.
- Add a focused test for each chart covering the table contents, keyboard
  traversal, and the row cap.

**Automated checks:**

- The **Accessibility** GitHub Actions workflow (`.github/workflows/a11y.yml`)
  runs axe-core against critical pages via `e2e/a11y.spec.ts` and **fails the PR
  on any new WCAG A/AA violation**. Run it locally with:

  ```bash
  cd frontend
  npm run build
  npx playwright test e2e/a11y.spec.ts --project=chromium
  ```

- When adding a new top-level page, add its route to `CRITICAL_PAGES` in
  `e2e/a11y.spec.ts`.
- Storybook ships the **@storybook/addon-a11y** panel; check it while developing
  components in isolation (`npm run storybook`).
- For live feedback while running the dev server, enable the in-browser axe
  overlay by rendering `@axe-core/react` from a client component in development
  only (dependency already declared in `frontend/package.json`).

## Visual Regression Requirements

Critical financial states must not change visually without an explicit,
reviewable diff. Visual regression coverage lives alongside the Playwright e2e
suite and runs in CI.

**What counts as a critical financial state:**

- Loan amounts, outstanding balances, accrued interest, and repayment
  schedules.
- Transaction lifecycle states: pending, submitted, confirmed, failed, and
  retried.
- Stale or unavailable data (dependency failure) and authorization failure
  states.
- Boundary value
