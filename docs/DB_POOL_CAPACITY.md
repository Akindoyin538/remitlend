# PostgreSQL pool saturation and capacity

## Behavior
- Wait for a connection is bounded by `DB_CONN_TIMEOUT_MS` (default 5000).
- Wait queue is bounded by `DB_POOL_MAX_WAITING` (default `DB_POOL_MAX * 5`); beyond it requests are rejected immediately.
- Both cases return `503` with `Retry-After` and error code `SERVICE_OVERLOADED`. Statement runtime is bounded by `DB_STATEMENT_TIMEOUT_MS` (default 30000).
- Worst-case time to a 503 is about `DB_CONN_TIMEOUT_MS`.

## Metrics (no user labels)
`db_pool_wait_duration_seconds` (histogram, `getClient`/transactions), `db_pool_saturation_ratio`, `db_pool_waiting_requests`, `db_pool_acquire_timeouts_total`, `db_pool_rejected_total`.

## Load test
```
BASE_URL=http://localhost:3001 TARGET_PATH=/api/v1/pool \
  node backend/scripts/pool-load-test.mjs --levels 5,20,100 --duration 15
```
Run at normal (below `DB_POOL_MAX`) and overload (well above `DB_POOL_MAX + DB_POOL_MAX_WAITING`) concurrency. It fails if any status other than 200/503 appears or a 503 lacks `Retry-After`. For a saturation test, use a small `DB_POOL_MAX` (e.g. 2). Throughput is not recorded here: it depends on hardware and query mix and must be measured in your environment.

## Sizing procedure
1. Get `max_connections` from Postgres; reserve ~10% for admin/migrations.
2. Budget = usable connections / (API replicas + worker/indexer processes), counting every process sharing the database.
3. Set `DB_POOL_MAX` per process to at most that budget.
4. Run the load test at 1x, 2x and 10x of `DB_POOL_MAX` concurrency; record p95 latency, rps and 503 rate.
5. Raise `DB_POOL_MAX` only while p95 improves and DB CPU stays healthy; otherwise scale replicas or optimize queries.
6. Alert on sustained `db_pool_saturation_ratio` near 1, and any growth of the timeout/rejected counters.
