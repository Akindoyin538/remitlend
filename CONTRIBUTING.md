# Contributing

Thanks for helping improve this project. Please read the guidelines below before opening a pull request.

## Getting started

1. Fork the repository and create a feature branch.
2. Make your changes with clear, focused commits.
3. Open a pull request describing the problem and the solution.

## Package boundaries

This monorepo is split into four top-level areas. Dependencies between them are
intentionally constrained so that presentation code, API implementation details,
and contract internals stay decoupled.

| Package | May import from | Must not import from |
| --- | --- | --- |
| `frontend/` | `contracts/` (generated/canonical types only) | `backend/`, `scripts/` |
| `backend/` | `contracts/` (generated/canonical types only) | `frontend/`, `scripts/` |
| `contracts/` | nothing outside `contracts/` | `frontend/`, `backend/`, `scripts/` |
| `scripts/` | `contracts/` | `frontend/`, `backend/` |

Rules of thumb:

- `contracts/` is the single source of truth for shared API and money types.
  Consume them from the generated/canonical artifacts instead of copying
definitions into `frontend/` or `backend/`.
- `frontend/` and `backend/` must not import each other directly; they
  communicate through the shared contract surface.
- `scripts/` is tooling only and must not be imported by runtime packages.
- Dependency cycles across packages are prohibited.

### Automated checks

CI enforces these boundaries. New prohibited imports or dependency cycles will
fail the build. Run the boundary check locally before pushing:

```sh
npm run lint:boundaries
```

### Exceptions

Intentional exceptions to the rules above must be recorded here with an owner
and a removal condition. Do not add a new exception without both.

| Exception | Owner | Removal condition |
| --- | --- | --- |
| _None currently recorded._ | — | — |

## Changing a cross-package contract

When you need to change something shared across packages (an API shape, a money
type, an event payload), follow this sequence so consumers stay in sync:

1. Update the canonical definition in `contracts/` first.
2. Regenerate the shared artifacts (types, clients) from that definition.
3. Update `backend/` consumers to match the new contract.
4. Update `frontend/` consumers to match the new contract.
5. Run the boundary check and the relevant tests for both packages.
6. Note the change in the pull request so reviewers can verify all consumers
   were updated.

Never copy a contract definition into a consumer package to avoid a coordinated
change; that is exactly the coupling these boundaries prevent.

## Code style

- Keep changes focused and scoped to the issue you are solving.
- Match the existing structure, naming, and patterns of the files you touch.
- Avoid unrelated refactors in the same pull request.

## Reporting issues

Please include steps to reproduce, expected behavior, and actual behavior.
