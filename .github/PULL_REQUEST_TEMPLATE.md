## Pull Request Checklist

Please ensure your PR follows these steps, mirroring our `CONTRIBUTING.md` guidelines.

- [ ] I have read the `CONTRIBUTING.md` document.
- [ ] My code follows the code style of this project.
- [ ] I have added tests to cover my changes.
- [ ] All new and existing tests passed.
- [ ] I have updated the documentation accordingly.
- [ ] I have verified the changes locally.

## Migration Rehearsal (required for any release that includes a database migration)

See issue #572. Every release migration must be rehearsed against production-scale sanitized data before release.

- [ ] Rehearsal dataset preserves production scale and key distribution while removing direct and indirect personal identifiers.
- [ ] Rehearsal recorded migration runtime, lock duration, and resource use (CPU, disk, I/O) against the defined safe thresholds.
- [ ] Concurrent reads/writes were exercised during the migration where the database supports it.
- [ ] If any threshold was exceeded, an approved online / expand-contract plan is linked below.
- [ ] Rehearsal evidence is linked to the exact migration commit (commit SHA + artifact/CI run link).

**Migration commit SHA:**

**Rehearsal evidence (CI run / report link):**

**Thresholds exceeded & approved online/expand-contract plan (if any):**
