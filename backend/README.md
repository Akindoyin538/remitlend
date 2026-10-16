# Backend

## Database migration rehearsal

Before every release, each migration must be rehearsed against a production-scale,
sanitized dataset so that lock, disk, and execution-time limits are validated before
they can cause downtime. The rehearsal is repeatable and its evidence is linked to the
exact migration commit.

### 1. Build the sanitized rehearsal dataset

Generate a dataset that preserves production scale and key distribution while removing
direct and indirect personal identifiers.

- Preserve: row counts per table, primary/foreign key cardinality, index selectivity,
  and the distribution of hot keys (e.g. tenant/account IDs).
- Remove: names, emails, phone numbers, addresses, IPs, free-text notes, and any
  indirect identifiers (quasi-identifiers such as birth date + postal code) that could
  re-identify a person.
- Replace identifiers with deterministic synthetic values so repeated rehearsals are
  comparable and referential integrity is retained.

Record the dataset version and the sanitization ruleset used in the rehearsal report.

### 2. Run the rehearsal and capture evidence

Run the migration against the sanitized dataset and capture, per migration:

- total runtime and per-statement runtime;
- lock type and lock duration (including time spent waiting on locks);
- resource use: peak disk, WAL/redo volume, memory, and connection count;
- query plans (`EXPLAIN (ANALYZE, BUFFERS)`) for statements touching large tables.

Where the database supports it, run concurrent reads and writes against the affected
tables during the migration to observe contention and blocking behavior.

### 3. Compare against thresholds

Each rehearsal is checked against defined safe thresholds (runtime, lock duration,
peak disk, and blocking). The CI/release workflow records the measured values and
fails the release when a migration exceeds a threshold.

### 4. Online / expand-contract plan for unsafe migrations

A migration that exceeds a safe threshold must not ship as-is. It requires an approved
online or expand-contract plan (additive schema change, backfill in batches, dual-write
or compatibility window, then contract) reviewed and signed off before release.

### 5. Release checklist

- [ ] Sanitized rehearsal dataset built at production scale with identifiers removed.
- [ ] Migration rehearsed; runtime, lock duration, and resource use recorded.
- [ ] Concurrent read/write behavior observed where supported.
- [ ] Measured values compared against thresholds; failures block the release.
- [ ] Any threshold breach has an approved online/expand-contract plan.
- [ ] Rollback or forward-fix procedure documented and tested.
- [ ] Rehearsal evidence linked to the exact migration commit in the release notes.
