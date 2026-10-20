# Bounded Yield Distribution: Audit Events and Operational Metrics

## Audit Events

All authorization and limit updates are published as Soroban contract events and should be indexed by the backend for audit trails.

### Authorization Events

**`YieldDistributorAuthorized(token, distributor)`**
- Emitted when: `authorize_yield_distributor` succeeds
- Indexing: Record `(admin, distributor, token, ledger_time, ledger_seq)` in `audit_logs` table
- Retention: 1 year (AUDIT_RETENTION policy)
- Purpose: Track who was authorized to distribute yield and when

**`YieldDistributorRevoked(token, distributor)`**
- Emitted when: `revoke_yield_distributor` succeeds
- Indexing: Record `(admin, distributor, token, revoked_ledger_seq, revoked_time)` in `audit_logs` table
- Retention: 1 year
- Purpose: Track authorization removals for incident investigation

### Limit Configuration Events

**`PerDistributionLimitUpdated(token, new_limit)`**
- Emitted when: `set_per_distribution_yield_limit` succeeds
- Indexing: Record `(admin, token, old_limit, new_limit, ledger_seq, ledger_time)` in `audit_logs` table
- Retention: 1 year
- Purpose: Track limit policy changes

**`CumulativeYieldLimitUpdated(token, new_limit)`**
- Emitted when: `set_cumulative_yield_limit` succeeds
- Indexing: Record `(admin, token, old_limit, new_limit, ledger_seq, ledger_time)` in `audit_logs` table
- Retention: 1 year
- Purpose: Track cumulative capacity changes

**`YieldDistributionPeriodUpdated(token, period_ledgers)`**
- Emitted when: `set_yield_distribution_period` succeeds
- Indexing: Record `(admin, token, old_period, new_period, ledger_seq, ledger_time)` in `audit_logs` table
- Retention: 1 year
- Purpose: Track reset period policy changes

### Yield Distribution Events

**`YieldDistributed(token, amount)`** (existing, unchanged)
- Emitted when: `distribute_yield` completes successfully
- Enhanced in v4: Distributor authentication now logged via indexed events
- Indexing: Record `(distributor, token, amount, ledger_seq, ledger_time, auth_path, cumulative_used)` in `yield_distribution_log` table
- Retention: Indefinite (permanent audit record)
- Purpose: Track all yield contributions to the pool

## Operational Metrics

### Time-series Metrics (Prometheus / CloudWatch)

#### Yield Distribution Volume
- **Metric**: `lending_pool_yield_distributed_stroops`
- **Type**: Counter (monotonically increasing)
- **Labels**: `token`, `distributor`, `auth_path` (admin|distributor|fee)
- **Frequency**: Updated on each `distribute_yield` call
- **Use**: Track total yield volume by path and contributor

Example:
```
lending_pool_yield_distributed_stroops{token="USDC",distributor="admin",auth_path="admin"} 5000000
lending_pool_yield_distributed_stroops{token="USDC",distributor="distributor_1",auth_path="distributor"} 2500000
```

#### Cumulative Yield Current Period
- **Metric**: `lending_pool_cumulative_yield_current_period_stroops`
- **Type**: Gauge (resets each period)
- **Labels**: `token`
- **Frequency**: Updated on each `distribute_yield` call, reset when period elapsed
- **Use**: Track headroom to cumulative limit for alerting

Example:
```
lending_pool_cumulative_yield_current_period_stroops{token="USDC"} 4500000
```

#### Yield Authorization Failures
- **Metric**: `lending_pool_yield_authorization_failures_total`
- **Type**: Counter (monotonically increasing)
- **Labels**: `error_code` (YieldDistributorNotAuthorized|YieldExceedsPerDistributionLimit|YieldExceedsCumulativeLimit), `token`
- **Frequency**: Incremented on each failed `distribute_yield` call
- **Use**: Alert on recurring authorization failures (suggests misconfiguration or attack)

Example:
```
lending_pool_yield_authorization_failures_total{error_code="YieldExceedsPerDistributionLimit",token="USDC"} 3
```

#### Authorized Distributors
- **Metric**: `lending_pool_authorized_distributors_count`
- **Type**: Gauge (count)
- **Labels**: `token`
- **Frequency**: Updated on each `authorize_yield_distributor` or `revoke_yield_distributor` call
- **Use**: Monitor role configuration drift

Example:
```
lending_pool_authorized_distributors_count{token="USDC"} 5
```

#### Cumulative Limit Configuration
- **Metric**: `lending_pool_cumulative_yield_limit_stroops`
- **Type**: Gauge
- **Labels**: `token`
- **Frequency**: Updated on each `set_cumulative_yield_limit` call
- **Use**: Alert if cumulative limit dropped below current period usage

Example:
```
lending_pool_cumulative_yield_limit_stroops{token="USDC"} 50000000
```

#### Period Reset Tracking
- **Metric**: `lending_pool_yield_distribution_period_resets_total`
- **Type**: Counter (monotonically increasing)
- **Labels**: `token`
- **Frequency**: Incremented when period elapsed during `distribute_yield` call
- **Use**: Verify period resets are working as configured

Example:
```
lending_pool_yield_distribution_period_resets_total{token="USDC"} 8
```

## Operational Dashboard (Grafana / DataDog)

### Yield Distribution Health Panel
- **Queries**:
  1. Cumulative yield vs limit: `lending_pool_cumulative_yield_current_period_stroops / lending_pool_cumulative_yield_limit_stroops`
  2. Authorization failure rate: `rate(lending_pool_yield_authorization_failures_total[5m])`
  3. Distributor count: `lending_pool_authorized_distributors_count`
  4. Period reset frequency: `rate(lending_pool_yield_distribution_period_resets_total[24h])`

- **Alerts**:
  - `cumulative_yield_ratio > 0.8` → "Cumulative yield limit utilization high"
  - `lending_pool_yield_authorization_failures_total(5m) > 5` → "Repeated authorization failures"
  - `lending_pool_authorized_distributors_count < 1` → "No authorized distributors configured"

## Backend Logging

### Structured Log Format

All bounded yield operations should log with structured JSON to facilitate searching and alerting:

```json
{
  "timestamp": "2026-10-16T12:26:04.545Z",
  "level": "INFO",
  "service": "backend",
  "operation": "yield.authorized_distributor_authorize",
  "pool_id": "CA23H...",
  "token": "USDC",
  "distributor": "GBR2K...",
  "admin": "GAB3Q...",
  "ledger_seq": 12345678,
  "result": "success",
  "distributor_count": 6
}
```

### Log Lines for Key Operations

#### authorize_yield_distributor
```json
{
  "operation": "yield.authorize_distributor",
  "pool_id": "<contract_id>",
  "admin": "<address>",
  "token": "<token_address>",
  "distributor": "<new_distributor>",
  "ledger_seq": 12345678,
  "result": "success|error",
  "error_code": "<if error>"
}
```

#### distribute_yield (success)
```json
{
  "operation": "yield.distribute",
  "pool_id": "<contract_id>",
  "distributor": "<caller>",
  "token": "<token_address>",
  "amount": 1500000000,
  "auth_path": "admin|distributor|fee",
  "ledger_seq": 12345678,
  "cumulative_before": 3000000000,
  "cumulative_after": 4500000000,
  "cumulative_limit": 50000000000,
  "per_dist_limit": 5000000000,
  "result": "success"
}
```

#### distribute_yield (failure)
```json
{
  "operation": "yield.distribute",
  "pool_id": "<contract_id>",
  "distributor": "<caller>",
  "token": "<token_address>",
  "amount": 5500000000,
  "auth_path": null,
  "ledger_seq": 12345678,
  "result": "error",
  "error_code": "YieldExceedsPerDistributionLimit",
  "reason": "Amount 5500000000 exceeds per-distribution limit of 5000000000"
}
```

#### set_cumulative_yield_limit
```json
{
  "operation": "yield.set_cumulative_limit",
  "pool_id": "<contract_id>",
  "admin": "<address>",
  "token": "<token_address>",
  "old_limit": 50000000000,
  "new_limit": 100000000000,
  "ledger_seq": 12345678,
  "result": "success"
}
```

## Alerting Rules

### Critical Alerts

1. **Authorization Failure Spike**: `rate(lending_pool_yield_authorization_failures_total[5m]) > 5`
   - Action: Review authorization configuration, check for unauthorized distribution attempts
   - Severity: HIGH

2. **Cumulative Limit Exceeded**: `lending_pool_cumulative_yield_current_period_stroops > lending_pool_cumulative_yield_limit_stroops`
   - Action: Emergency pause yield distribution or increase limit
   - Severity: CRITICAL

3. **No Authorized Distributors**: `lending_pool_authorized_distributors_count == 0 AND lending_pool_cumulative_yield_limit_stroops > 0`
   - Action: Reconfigure authorized distributors or disable bounds
   - Severity: MEDIUM

### Warning Alerts

4. **High Cumulative Utilization**: `lending_pool_cumulative_yield_current_period_stroops / lending_pool_cumulative_yield_limit_stroops > 0.8`
   - Action: Monitor for period reset or plan for increased limit
   - Severity: MEDIUM

5. **Repeated Authorization Rejections**: `lending_pool_yield_authorization_failures_total(5m-ago) != lending_pool_yield_authorization_failures_total(now)`
   - Action: Verify distributor credentials, check for misconfiguration
   - Severity: LOW

## Observability Best Practices

### Event Indexing
- Index all `YieldDistributor*` and `*LimitUpdated` events in a dedicated `yield_authorization_log` table
- Partition by `token` for efficient querying
- Create indexes on `(admin, timestamp)` and `(distributor, timestamp)` for audit queries

### Metrics Retention
- Keep time-series metrics for at least 1 year (annual compliance)
- Archive raw events to cold storage after 30 days (cost optimization)
- Aggregate daily summaries for long-term trending

### Audit Queries
- Support query: "Show all distributions by distributor X in last 30 days" → Searches `yield_distribution_log`
- Support query: "Show all authorization changes for token Y" → Searches `yield_authorization_log`
- Support query: "Show periods where cumulative limit was exceeded" → Filtered `yield_distribution_log` with limit violations

## Production Readiness Checklist

- [ ] All audit events indexed in backend database
- [ ] Prometheus metrics scraping configured
- [ ] Grafana dashboard created and tested
- [ ] Alert rules deployed to alerting system (PagerDuty, etc.)
- [ ] Runbook created for each alert (response procedure)
- [ ] Retention policies enforced (1 year audit, 30 days logs)
- [ ] Access controls on audit logs (read-only for compliance team)
- [ ] Dashboards tested with synthetic data
- [ ] Metrics naming aligned with org standards
- [ ] Team trained on interpreting dashboard and alerts
