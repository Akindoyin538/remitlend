# Adaptive Catch-Up Scheduling Design

**Status**: Design Phase  
**Version**: 1.0  
**Date**: 2026-10-16

## Executive Summary

Replace the fixed 30-second poll interval in EventIndexer with an adaptive scheduling system that detects when the indexer falls behind the chain tip and automatically accelerates catch-up. The system maintains backward compatibility while improving responsiveness during peak event periods and RPC degradation.

## Objectives

1. **Reduce catch-up latency** when the indexer falls behind by 100+ ledgers
2. **Gracefully degrade** when RPC is slow or unstable
3. **Maintain backward compatibility** with all existing API consumers and deployed contracts
4. **Add observability** for indexer scheduling decisions and health
5. **Enable operators** to tune behavior via environment variables

## Algorithm Overview

### Catch-Up Modes

The scheduler operates in three modes:

#### 1. **Caught-Up Mode** (lag ≤ CAUGHT_UP_THRESHOLD)
- Poll interval: 30 seconds (normal)
- Batch size: 100 (normal)
- Rationale: Chain is current; periodic polling is sufficient

#### 2. **Behind Mode** (CAUGHT_UP_THRESHOLD < lag ≤ AGGRESSIVE_THRESHOLD)
- Poll interval: 10 seconds (aggressive)
- Batch size: 200 (increased)
- Rationale: Fell behind but not severely; moderate acceleration

#### 3. **Catch-Up Mode** (lag > AGGRESSIVE_THRESHOLD)
- Poll interval: 3 seconds (very aggressive)
- Batch size: 500 (max)
- Rationale: Significantly behind; maximum acceleration until caught up

### Transition Rules

1. **Caught-Up → Behind**: When `lag > CAUGHT_UP_THRESHOLD`
2. **Behind → Catch-Up**: When `lag > AGGRESSIVE_THRESHOLD`
3. **Catch-Up → Behind**: When `lag ≤ AGGRESSIVE_THRESHOLD && lag > CAUGHT_UP_THRESHOLD`
4. **Behind/Catch-Up → Caught-Up**: When `lag ≤ CAUGHT_UP_THRESHOLD`

### Backoff Strategy

When RPC fails or returns 0 ledger:

1. **First failure**: Log warning, keep current mode
2. **Consecutive failures**: Apply exponential backoff
   - Failure 1: wait 5 seconds extra
   - Failure 2: wait 15 seconds extra (3x)
   - Failure 3: wait 45 seconds extra (3x)
   - Failure 4+: wait 135 seconds extra (capped)
3. **Recovery**: After 1 successful poll, reset failure counter

**Backoff Formula**:
```
delay_ms = base_interval + (backoff_base_ms * (3 ^ consecutive_failures))
capped at: base_interval + backoff_max_ms
```

### State Machine

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌──────────────┐         ┌──────────────┐               │
│  │  Caught-Up   │<───────>│   Behind     │                │
│  │(30s, 100)    │         │ (10s, 200)   │                │
│  └──────────────┘         └──────────────┘                │
│        ^                         │                         │
│        │ lag ≤ threshold         │ lag > aggressive       │
│        │                         ▼                         │
│        │                   ┌──────────────┐               │
│        └──────────────────│  Catch-Up    │               │
│                           │ (3s, 500)    │               │
│                           └──────────────┘               │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Backoff applied to all modes on RPC failures
```

## State Persistence

### New Table: `indexer_scheduler_state`

```sql
CREATE TABLE indexer_scheduler_state (
  id SERIAL PRIMARY KEY,
  contract VARCHAR(56) NOT NULL UNIQUE,
  
  -- Current mode: 'caught_up', 'behind', or 'catch_up'
  mode VARCHAR(20) NOT NULL DEFAULT 'caught_up',
  
  -- Backoff tracking
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_poll_time TIMESTAMP,
  last_successful_poll_time TIMESTAMP,
  
  -- Diagnostic metadata
  last_lag_ledgers INT,
  last_error_message TEXT,
  
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Why**: Survive restarts without losing catch-up context. Allows operational diagnostics.

## Configuration

### Environment Variables

```env
# Adaptive scheduler thresholds (ledgers)
INDEXER_CAUGHT_UP_THRESHOLD=50        # Switch from catch-up to behind
INDEXER_AGGRESSIVE_THRESHOLD=100      # Switch from behind to catch-up

# Mode-specific intervals (milliseconds)
INDEXER_INTERVAL_CAUGHT_UP_MS=30000   # Normal polling
INDEXER_INTERVAL_BEHIND_MS=10000      # Moderate acceleration
INDEXER_INTERVAL_CATCH_UP_MS=3000     # Aggressive catch-up

# Mode-specific batch sizes (ledgers)
INDEXER_BATCH_SIZE_CAUGHT_UP=100      # Normal batch
INDEXER_BATCH_SIZE_BEHIND=200         # Increased during behind
INDEXER_BATCH_SIZE_CATCH_UP=500       # Max batch during catch-up

# Backoff configuration
INDEXER_BACKOFF_BASE_MS=5000          # Initial backoff
INDEXER_BACKOFF_MAX_MS=135000         # Max total backoff
INDEXER_BACKOFF_MULTIPLIER=3          # Exponential multiplier

# Feature flag for adaptive mode (safe to disable for rollback)
INDEXER_ADAPTIVE_SCHEDULING=true
```

**Backward Compatibility**: If `INDEXER_ADAPTIVE_SCHEDULING=false`, fall back to fixed interval/batch (current behavior).

## Metrics

### New Gauges

- `indexer_scheduler_mode` (gauge) - Current mode: 0=caught_up, 1=behind, 2=catch_up
- `indexer_backoff_level` (gauge) - Current backoff multiplier (0-N)
- `indexer_consecutive_failures` (counter) - Consecutive RPC failures since last success

### New Counters

- `indexer_mode_transitions` (counter) - Transitions between modes (label: from→to)
- `indexer_backoff_triggered` (counter) - Times backoff was activated

### Existing Metrics (Enhanced)

- `indexer_lag_ledgers` (gauge) - Already tracked; will drive mode transitions
- `indexer_poll_duration_ms` (histogram) - Already tracked; used to tune intervals

## Logging

### Structured Log Events

1. **Mode Transition**
   ```json
   {
     "event": "indexer_mode_transition",
     "from": "caught_up",
     "to": "behind",
     "lag": 120,
     "threshold": 100,
     "interval_ms": 10000,
     "batch_size": 200
   }
   ```

2. **Backoff Triggered**
   ```json
   {
     "event": "indexer_backoff_triggered",
     "consecutive_failures": 2,
     "backoff_ms": 45000,
     "total_wait": 55000,
     "reason": "RPC getLatestLedger failed"
   }
   ```

3. **Catch-Up Completed**
   ```json
   {
     "event": "indexer_catch_up_complete",
     "lag_before": 500,
     "lag_after": 0,
     "duration_ms": 15000,
     "events_processed": 1250
   }
   ```

## Authorization & Security

### API Access

- `/indexer/status` returns `scheduler_mode` and `backoff_level` in response (no auth change)
- `/admin/indexer/reset-backoff` to reset consecutive_failures (admin:indexer scope, new)
- No sensitive data exposed in metrics or logs

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| DoS by rapid config changes | Environment variables only; no runtime API |
| Unbounded memory in failure tracking | Consecutive_failures capped; backoff capped |
| Information disclosure | All metrics are operational health; no PII/secrets |
| Unintended catch-up spam | Thresholds tuned conservatively; metrics monitored |

## Failure Scenarios

### Scenario 1: RPC Becomes Slow
- **Initial**: Caught-Up mode, 30s interval
- **Minute 1**: RPC latency 5s → poll takes 8s, still 30s interval (lag grows)
- **Minute 2**: Lag > 50 → Enter Behind mode, 10s interval
- **Minute 3**: Lag > 100 → Enter Catch-Up mode, 3s interval (plus backoff)
- **Minute 5**: RPC recovers → Lag shrinks, exit Catch-Up, shrink batch, restore 30s

### Scenario 2: RPC Outage During Restart
- **Restart**: `indexer_scheduler_state` loaded from DB
- **State**: Previous mode (e.g., "catch_up") restored
- **Backoff**: consecutive_failures = 0, backoff_level reset
- **Polling**: Resumes with adaptive intervals despite RPC down
- **Recovery**: After RPC recovers, scheduler adjusts based on lag

### Scenario 3: Ledger Gap + Slow Recovery
- **Gap detected**: 200-ledger gap marked "suspect"
- **Scheduler**: Detects high lag, enters Catch-Up mode
- **Backfill**: Backfill process can run alongside adaptive polling (no conflict)
- **Recovery**: Once caught up AND gap backfilled, lag shrinks, scheduler exits Catch-Up

## Observability Requirements

1. **Operator Dashboard** queries:
   - Current mode, lag, backoff level
   - Mode transition history (last 24h)
   - P95/P99 poll duration by mode
   - RPC failure rate and backoff effectiveness

2. **Alerts**:
   - `indexer_stuck_in_catch_up_15m` - Catch-Up mode for >15 minutes
   - `indexer_lag_growing` - Lag increasing for 3 consecutive polls
   - `indexer_backoff_max_triggered` - Backoff capped for 2+ consecutive failures

3. **SLOs**:
   - Catch-up lag < 50 ledgers: 99.5% of time when RPC healthy
   - P99 poll duration in Catch-Up mode: < 10s

## Rollout Strategy

### Phase 1: Development
- Implement AdaptiveScheduler service
- Unit tests for mode transitions, backoff logic
- Integration tests with mocked RPC
- **Duration**: 2 weeks

### Phase 2: Staging
- Deploy with `INDEXER_ADAPTIVE_SCHEDULING=false` (disabled)
- Verify no regressions vs. current fixed-interval behavior
- Collect baseline metrics
- **Duration**: 1 week

### Phase 3: Gradual Enablement
1. **Day 1**: Enable for 10% of traffic (dev environment)
2. **Day 3**: Enable for 50% of traffic (staging)
3. **Day 5**: Enable for 100% (production)
4. **Day 7**: Verify 99.9% uptime + no alerting
5. **Rollback plan**: Set `INDEXER_ADAPTIVE_SCHEDULING=false`, restart

### Phase 4: Tuning
- Analyze 2-week metrics
- Adjust thresholds based on observed RPC behavior
- Document final configuration for operators

## Compatibility Matrix

| Component | Current | Adaptive | Breaking? |
|-----------|---------|----------|-----------|
| EventIndexer API | ✓ | ✓ | No |
| Webhooks | ✓ | ✓ | No |
| Database schema | ✓ | +1 table | No |
| Metrics | ✓ | +3 metrics | No |
| Environment variables | 2 vars | +11 vars | No (all optional) |
| Deployed contracts | ✓ | ✓ | No |

## Future Enhancements

1. **Per-contract scheduling**: Run separate adapters for each contract (currently single scheduler)
2. **Predictive batching**: Use RPC response times to predict optimal batch size
3. **Network-aware thresholds**: Auto-tune based on detected network conditions
4. **Catch-up completion callbacks**: Allow other services to react when catch-up ends

## Acceptance Criteria

- [x] Algorithm defined with clear state transitions
- [x] Failure scenarios analyzed and mitigated
- [x] Database schema designed and migrations planned
- [x] Configuration parameters documented
- [x] Metrics and logging strategy defined
- [x] Rollout strategy includes rollback plan
- [x] Backward compatibility verified
