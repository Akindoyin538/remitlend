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

### Compatibility impact
- [ ] Deployed contracts, API consumers, and persisted data remain compatible (or a migration is described below).
- [ ] Migration and rollback behavior are defined before implementation.

### Rollout & verification
- [ ] Rollout steps are documented.
- [ ] Verification evidence attached (narrowest relevant package tests, type checks, linting, contract tests, and an integration/e2e scenario).
- [ ] Metrics, structured errors, audit events, and operational diagnostics added where production behavior changed.
