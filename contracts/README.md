# Contracts

This package contains the on-chain contracts, their storage layout, and the
operational tooling used to keep deployed instances healthy.

## Storage TTL liveness monitoring

Soroban persistent storage entries expire unless their TTL is extended. The
contracts expose **read-only** monitoring hooks so operators can observe TTL
liveness without mutating chain state.

### Hooks

- `ttl_status(keys: Vec<StorageKey>) -> Vec<TtlStatus>` — returns the remaining
  TTL (in ledgers) and a liveness classification for each requested key.
- `ttl_summary() -> TtlSummary` — aggregates liveness across the tracked key set
  (counts of `Live`, `Warning`, `Expired`, and the minimum remaining TTL).

Both hooks are pure reads: they never extend TTLs, write entries, or emit
state-changing events. Persisted data layout and existing entrypoints are
unchanged, so deployed contracts and API consumers remain compatible.

### Liveness classification

| Status    | Meaning                                                        |
|-----------|----------------------------------------------------------------|
| `Live`    | Remaining TTL is above the warning threshold.                  |
| `Warning` | Remaining TTL is at or below the warning threshold.            |
| `Expired` | The entry is missing or its TTL has elapsed.                   |

Thresholds are configuration values and are not persisted per key.

### Authorization

Monitoring hooks are **operator-gated**: callers must be authorized operators
(see `SECURITY.md`). Unauthorized callers receive a structured
`MonitoringError::Unauthorized` and no data is returned. Read-only callers that
are not operators cannot invoke the hooks.

### Resource bounds

- A single invocation scans at most `MAX_MONITORED_KEYS` keys.
- Requests exceeding the cap are rejected with
  `MonitoringError::TooManyKeys { requested, max }` before any storage read.
- Empty requests return an empty result rather than erroring.

### Failure behavior

- Missing or expired entries are reported as `Expired`, not as errors.
- Storage read failures surface as `MonitoringError::StorageUnavailable`.
- Hooks are idempotent and safe to retry; they hold no locks and mutate no
  state, so retries cannot corrupt data.

### Observability

Each invocation emits a structured diagnostic event containing the caller, the
number of keys scanned, the aggregate liveness counts, and the minimum remaining
TTL. These events are for operational diagnostics only and do not affect
contract state.

### Testing

Focused tests cover success, authorization failure, boundary values (empty
request, exactly-at-cap, over-cap), stale/expired entries, and storage
dependency failure. Run the narrowest relevant package tests plus contract
compatibility checks before merging.

### Rollout and rollback

Hooks are additive and read-only, so rollout requires no migration. Rollback is
a no-op for persisted data: removing the hooks leaves storage untouched.
