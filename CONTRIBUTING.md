# Contributing to RemitLend

First off, thank you for considering contributing to RemitLend! It's people like you who make RemitLend a powerful tool for providing fair lending access to migrant workers worldwide.

This document provides a set of guidelines for contributing to RemitLend and its packages. These are mostly guidelines, not rules. Use your best judgment, and feel free to propose changes to this document in a pull request.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Development Workflow](#development-workflow)
- [Branching Strategy](#branching-strategy)
- [Commit Message Guidelines](#commit-message-guidelines)
- [Pull Request Standards](#pull-request-standards)
- [Environment Variables](#environment-variables)
- [Testing Requirements](#testing-requirements)
- [Style Guides](#style-guides)

## Code of Conduct

By participating in this project, you agree to maintain a respectful, inclusive, and harassment-free environment for everyone. We are committed to providing a welcoming experience for contributors of all backgrounds and skill levels.

## Development Workflow

We follow a **Feature-Branch-to-Main** workflow. All development work should happen in feature branches and be merged into `main` via Pull Requests.

### Architecture & Contributor Wiki

If you're new to the codebase, start with:
- `docs/wiki/README.md` (high-level contributor wiki)
- `ARCHITECTURE.md` (system overview)
- `docs/deployed-contracts.md` (testnet/mainnet contract IDs and the env vars that consume them).

```mermaid
graph TD
    Main[main branch] -->|Checkout| Feat[feat/your-feature]
    Feat -->|Commits| Feat
    Feat -->|Push| Remote[Remote Branch]
    Remote -->|Open PR| PR[Pull Request]
    PR -->|Review & CI| Merge[Merged to main]
    Merge --> Main
```

### Steps to Contribute

1. **Fork & Clone**: Fork the repository and clone it locally.
2. **Branch**: Create a new branch from the latest `main`.
3. **Develop**: Implement your changes, following code style and quality standards.
4. **Test**: Ensure all tests pass (see [Testing Requirements](#testing-requirements)).
5. **Commit**: Use [Conventional Commits](#commit-message-guidelines).
6. **Push & PR**: Push your branch and open a Pull Request against `main`.

## Branching Strategy

Follow these naming conventions for your branches:

| Type | Prefix | Example |
| :--- | :--- | :--- |
| **Feature** | `feat/` | `feat/lender-dashboard` |
| **Bug Fix** | `fix/` | `fix/nft-minting-error` |
| **Docs** | `docs/` | `docs/update-api-guide` |
| **Refactor** | `refactor/` | `refactor/loan-logic` |
| **Performance**| `perf/` | `perf/optimize-queries` |
| **Maintenance**| `chore/` | `chore/update-deps` |

## Commit Message Guidelines

We strictly follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.

**Format**: `<type>(<scope>): <subject>`

### Common Types:

- **feat**: A new feature (corresponds to `MINOR` in Semantic Versioning).
- **fix**: A bug fix (corresponds to `PATCH` in Semantic Versioning).
- **docs**: Documentation only changes.
- **style**: Changes that do not affect the meaning of the code (white-space, formatting, etc).
- **refactor**: A code change that neither fixes a bug nor adds a feature.
- **perf**: A code change that improves performance.
- **test**: Adding missing tests or correcting existing tests.
- **chore**: Changes to the build process or auxiliary tools and libraries.

**Example**: `feat(contracts): add flash loan prevention to lending pool`

## Pull Request Standards

When opening a PR, ensure your description includes:
- **Linked Issue**: Close the relevant issue (e.g., `Closes #123`).
- **Description**: A clear summary of the changes.
- **Testing**: Evidence that the changes were tested.
- **Checklist**:
    - [ ] Code follows project style guides.
    - [ ] Tests have been added/updated and pass.
    - [ ] Documentation has been updated.
    - [ ] Commit messages follow standards.

## Environment Variables

Before setting up the project locally, review the full environment variable reference in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md). Each `.env.example` file contains a pointer to this canonical reference. If you add a new environment variable, update both the relevant `.env.example` and the table in `ENVIRONMENT.md`.

## Testing Requirements

Before submitting, verify your changes by running:

### Frontend (Next.js/React)
```bash
cd frontend
npm run lint
npm run test
```

### Backend (Node/Express)
```bash
cd backend
npm run lint
npm run test
```

### Contracts (Soroban/Rust)
```bash
cd contracts
cargo fmt --check
cargo clippy
cargo test
```

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

## Contracts: Protocol-Wide Debt Ceiling

Protocol-wide exposure is bounded by a single, admin-settable **debt ceiling**
stored in contract storage alongside the existing per-loan limits. The ceiling
caps the total outstanding principal across all active loans; it is enforced at
loan creation/origination so no new loan can push aggregate debt above the
configured value.

**Contributor expectations when touching the ceiling:**

- **Storage is additive only.** The ceiling lives in a new storage key; do not
  reorder or repurpose existing keys, and do not change existing entry-point
  signatures. Deployed contracts and API consumers must keep working unchanged.
- **Authorization is admin-only.** Only the configured admin may update the
  ceiling. Unauthorized callers must fail with an explicit, structured error
  (not a panic), and the failed attempt must not mutate storage.
- **Enforcement is at origination.** Reject any new loan whose principal would
  push total outstanding debt above the ceiling, returning a distinct structured
  error so callers can distinguish a ceiling breach from other validation
  failures. Boundary values (exactly at the ceiling, and one unit above) must be
  covered by tests.
- **Arithmetic is checked.** Use checked/saturating arithmetic for the aggregate
  comparison; never rely on wrapping. The ceiling and totals are derived from
  authoritative on-chain state, not cached or client-supplied values.
- **Observability.** Emit an audit event on every ceiling update (old value, new
  value, admin) and on every rejected origination, so operators can diagnose
  breaches from structured logs.
- **Migration & rollback.** Because storage is additive, no data migration is
  required; a fresh deployment initializes the ceiling explicitly. Rollback is a
  redeploy of the prior contract version — the new key is simply ignored by older
  code, so no state cleanup is needed.
- **Tests.** Add focused tests for: successful admin update, unauthorized update
  failure, origination at the boundary, origination one unit above the boundary,
  and dependency/stale-state failure paths. Run the narrowest relevant package
  tests plus `cargo fmt --check`, `cargo clippy`, and `cargo test` under
  `contracts/`.

## Style Guides

- **TypeScript/JavaScript**: Follow the existing ESLint and Prettier configuration.
- **Rust (Soroban)**: Run `cargo fmt` and `cargo clippy` before committing.
- **Markdown**: Keep lines reasonably wrapped and use fenced code blocks with a
  language hint.
