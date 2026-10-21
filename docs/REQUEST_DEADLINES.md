# Request deadlines and cancellation

`requestDeadlineMiddleware` creates an `AbortSignal` per request, exposed via
`getRequestSignal()` (AsyncLocalStorage). It aborts on client disconnect or when
the deadline passes.

- Deadline: default 30s; clients may send `x-request-timeout-ms`, clamped to
  100ms..60s. Invalid values fall back to the default. Server max always wins.
- Deadline expiry returns 504; the signal reason is a `RequestAbortedError`
  with `reason` of `client_disconnect` or `deadline_exceeded`.
- Logs: `event=request_cancelled` at warn level with `reason`.
  Metric: `http_requests_cancelled_total{reason}` (2 label values only).
  Cancellation is not counted as a business failure.

## Propagation

- PostgreSQL: `query()` checks the signal before starting and rejects promptly
  on abort.
- Use `abortable(promise)` / `throwIfAborted()` for other dependencies.

## Limitations

- `pg` `pool.query` cannot be cancelled: on abort the caller stops waiting, but
  the statement may finish server-side (use `statement_timeout` as the backstop).
  `getClient`/`withTransaction` are not yet signal-aware.
- Redis and Soroban RPC clients are not wired yet; wrap them with `abortable`.
- Background jobs (cron, indexer) have no request signal.

## Irreversible boundary

`runIrreversible(submit)` throws if aborted before submission. Once submission
starts, it runs outside the request signal and always completes; the result is
`{ state: 'submitted', result, abortedAfterSubmit }` so callers report the
actual submission state, never "cancelled". Signed-transaction submission
ignores cancellation by design.
