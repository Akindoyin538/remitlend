# Indexer shadow projection rebuild (#516)

Rebuilds derived projections from finalized `contract_events` into shadow
tables, validates them, then promotes explicitly. Code: `backend/src/services/indexerRebuild.ts`.

1. `createRebuild({network, contractIds, startLedger, endLedger, decoderVersion})` records the input in `indexer_rebuilds`.
2. `replayRebuild(id)` first checks `ledger_checkpoints`: the range must be covered by verified checkpoints for every contract and overlap no `suspect` range, otherwise it throws (checkpoint mismatch). Events are copied in 1000-ledger batches into `indexer_rebuild_events`, ordered by `(ledger, event_id)`. Each batch commits with its progress marker (`last_replayed_ledger`), so an interrupted run resumes by calling `replayRebuild` again; duplicates are ignored by `UNIQUE (rebuild_id, event_id)`.
3. `validateRebuild(id)` compares count and a SHA-256 digest of normalized rows against live events in the range. Mismatch or incomplete replay sets `failed` with a reason; success sets `validated`.
4. `promoteRebuild(id)` is the only step that touches `indexer_active_projection`. It runs in one transaction with a row lock, requires `validated`, and is a no-op when already `promoted`.

Live tables, active reads and `ledger_checkpoints` are never modified before promotion. Replaying the same range yields identical rows and digest. Recovery: a failed or interrupted rebuild can be re-run or deleted (shadow rows cascade); promotion is atomic so no partial state exists.
