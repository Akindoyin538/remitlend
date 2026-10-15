## Pull Request Checklist

Please ensure your PR follows these steps, mirroring our `CONTRIBUTING.md` guidelines.

- [ ] I have read the `CONTRIBUTING.md` document.
- [ ] My code follows the code style of this project.
- [ ] I have added tests to cover my changes.
- [ ] All new and existing tests passed.
- [ ] I have updated the documentation accordingly.
- [ ] I have verified the changes locally.

## Contracts Change Notes

Complete this section for any change under the `contracts` boundary (e.g. multi-asset pool accounting).

### Threat model
- [ ] Cross-token accounting: per-token balance/share isolation is enforced and every pool operation validates the asset explicitly.
- [ ] Authorization: caller/role checks and failure paths are documented.
- [ ] Boundary values, retries, stale data, and dependency failure paths are covered.
- [ ] Protocol-wide debt ceiling: the admin-only ceiling parameter is validated on update, and origination rejects loans that would push total outstanding debt above the ceiling with a structured error.

### Compatibility impact
- [ ] Deployed contracts, API consumers, and persisted data remain compatible (or a migration is described below).
- [ ] Migration and rollback behavior are defined before implementation.
- [ ] Debt ceiling storage/params are additive only; existing entry points and storage layout are unchanged.

### Rollout & verification
- [ ] Rollout steps are documented.
- [ ] Verification evidence attached (narrowest relevant package tests, type checks, linting, contract tests, and an integration/e2e scenario).
- [ ] Metrics, structured errors, audit events, and operational diagnostics added where production behavior changed.
- [ ] Debt ceiling enforcement verified at boundary values (at, just below, and just above the ceiling) and on the authorization-failure path.
