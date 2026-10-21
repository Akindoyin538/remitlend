import { createHash } from 'node:crypto';
import { query, withTransaction } from '../db/connection.js';
import logger from '../utils/logger.js';

export interface RebuildInput {
  network: string;
  contractIds: string[];
  startLedger: number;
  endLedger: number;
  decoderVersion: string;
}

interface Row {
  event_id: string;
  event_type: string;
  loan_id: number | null;
  address: string | null;
  amount: string | null;
  ledger: string | number;
  tx_hash: string | null;
  contract_id: string | null;
}

const BATCH_LEDGERS = 1000;

/** Deterministic digest over normalized rows in (ledger, event_id) order. */
export function digestRows(rows: Row[]): string {
  const h = createHash('sha256');
  for (const r of rows) {
    h.update(
      JSON.stringify([
        r.event_id,
        r.event_type,
        r.loan_id,
        r.address,
        r.amount === null ? null : String(r.amount),
        Number(r.ledger),
        r.tx_hash,
        r.contract_id,
      ]) + '\n',
    );
  }
  return h.digest('hex');
}

export async function createRebuild(input: RebuildInput): Promise<number> {
  if (input.endLedger < input.startLedger) throw new Error('endLedger must be >= startLedger');
  if (!input.contractIds.length) throw new Error('contractIds must not be empty');
  const contractIds = [...new Set(input.contractIds)].sort();
  const res = await query(
    `INSERT INTO indexer_rebuilds (network, contract_ids, start_ledger, end_ledger, decoder_version)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.network, contractIds, input.startLedger, input.endLedger, input.decoderVersion],
  );
  return (res.rows[0] as { id: number }).id;
}

/**
 * Verifies the requested range is covered by verified ledger_checkpoints and
 * contains no suspect ranges. Throws on mismatch; nothing is replayed.
 */
export async function assertCheckpointsMatch(input: RebuildInput): Promise<void> {
  const contractIds = [...new Set(input.contractIds)];
  const suspect = await query(
    `SELECT 1 FROM ledger_checkpoints
      WHERE contract = ANY($1) AND status = 'suspect'
        AND range_end >= $2 AND range_start <= $3 LIMIT 1`,
    [contractIds, input.startLedger, input.endLedger],
  );
  if (suspect.rows.length) throw new Error('Checkpoint mismatch: suspect ledger range overlaps rebuild range');
  const cov = await query(
    `SELECT contract, MAX(range_end) AS max_end FROM ledger_checkpoints
      WHERE contract = ANY($1) AND status = 'verified' GROUP BY contract`,
    [contractIds],
  );
  const byContract = new Map(
    (cov.rows as Array<{ contract: string; max_end: string }>).map((r) => [r.contract, Number(r.max_end)]),
  );
  for (const c of contractIds) {
    const end = byContract.get(c);
    if (end === undefined || end < input.endLedger) {
      throw new Error(`Checkpoint mismatch: contract ${c} verified only through ${end ?? 'none'}`);
    }
  }
}

async function loadRebuild(id: number) {
  const res = await query('SELECT * FROM indexer_rebuilds WHERE id = $1', [id]);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) throw new Error(`Rebuild ${id} not found`);
  return {
    id,
    status: r.status as string,
    network: r.network as string,
    input: {
      network: r.network as string,
      contractIds: r.contract_ids as string[],
      startLedger: Number(r.start_ledger),
      endLedger: Number(r.end_ledger),
      decoderVersion: r.decoder_version as string,
    } satisfies RebuildInput,
    lastReplayed: r.last_replayed_ledger === null ? null : Number(r.last_replayed_ledger),
  };
}

/**
 * Replays finalized events into the shadow table in ledger batches. Each
 * batch and its progress marker commit together, so an interrupted replay
 * resumes from last_replayed_ledger. Duplicates are ignored via the
 * (rebuild_id, event_id) unique key. Live tables and checkpoints are only read.
 */
export async function replayRebuild(id: number): Promise<void> {
  const rb = await loadRebuild(id);
  if (rb.status === 'promoted') return;
  await assertCheckpointsMatch(rb.input);
  await query(`UPDATE indexer_rebuilds SET status='replaying', failure_reason=NULL WHERE id=$1`, [id]);

  let from = rb.lastReplayed === null ? rb.input.startLedger : rb.lastReplayed + 1;
  while (from <= rb.input.endLedger) {
    const to = Math.min(from + BATCH_LEDGERS - 1, rb.input.endLedger);
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO indexer_rebuild_events
           (rebuild_id, event_id, event_type, loan_id, address, amount, ledger, tx_hash, contract_id)
         SELECT $1, event_id, event_type, loan_id, address, amount::text, ledger, tx_hash, contract_id
           FROM contract_events
          WHERE ledger BETWEEN $2 AND $3 AND contract_id = ANY($4)
          ORDER BY ledger, event_id
         ON CONFLICT (rebuild_id, event_id) DO NOTHING`,
        [id, from, to, rb.input.contractIds],
      );
      await client.query('UPDATE indexer_rebuilds SET last_replayed_ledger=$2 WHERE id=$1', [id, to]);
    });
    from = to + 1;
  }
}

async function readOrdered(sql: string, params: unknown[]): Promise<Row[]> {
  return (await query(sql, params)).rows as Row[];
}

/**
 * Compares the shadow projection with live contract_events for the same
 * range. Marks the rebuild 'validated' on equal digest/count, else 'failed'.
 */
export async function validateRebuild(id: number): Promise<{ ok: boolean; reason?: string }> {
  const rb = await loadRebuild(id);
  if (rb.lastReplayed === null || rb.lastReplayed < rb.input.endLedger) {
    const reason = 'Incomplete replay';
    await query(`UPDATE indexer_rebuilds SET status='failed', failure_reason=$2 WHERE id=$1`, [id, reason]);
    return { ok: false, reason };
  }
  const shadow = await readOrdered(
    `SELECT event_id,event_type,loan_id,address,amount,ledger,tx_hash,contract_id
       FROM indexer_rebuild_events WHERE rebuild_id=$1 ORDER BY ledger, event_id`,
    [id],
  );
  const live = await readOrdered(
    `SELECT event_id,event_type,loan_id,address,amount::text AS amount,ledger,tx_hash,contract_id
       FROM contract_events WHERE ledger BETWEEN $1 AND $2 AND contract_id = ANY($3)
      ORDER BY ledger, event_id`,
    [rb.input.startLedger, rb.input.endLedger, rb.input.contractIds],
  );
  const digest = digestRows(shadow);
  if (shadow.length !== live.length || digest !== digestRows(live)) {
    const reason = `Comparison failed: shadow=${shadow.length} live=${live.length}`;
    await query(`UPDATE indexer_rebuilds SET status='failed', failure_reason=$2 WHERE id=$1`, [id, reason]);
    return { ok: false, reason };
  }
  await query(
    `UPDATE indexer_rebuilds SET status='validated', digest=$2, event_count=$3, validated_at=NOW() WHERE id=$1`,
    [id, digest, shadow.length],
  );
  return { ok: true };
}

/**
 * Explicit operator promotion. Single transaction: row-locks the rebuild and
 * flips the active pointer. Repeating it on a promoted rebuild is a no-op.
 */
export async function promoteRebuild(id: number): Promise<{ promoted: boolean; alreadyPromoted: boolean }> {
  return withTransaction(async (client) => {
    const res = await client.query('SELECT status, network FROM indexer_rebuilds WHERE id=$1 FOR UPDATE', [id]);
    const r = res.rows[0] as { status: string; network: string } | undefined;
    if (!r) throw new Error(`Rebuild ${id} not found`);
    if (r.status === 'promoted') return { promoted: true, alreadyPromoted: true };
    if (r.status !== 'validated') throw new Error(`Rebuild ${id} is '${r.status}', not validated`);
    await client.query(
      `INSERT INTO indexer_active_projection (network, rebuild_id) VALUES ($1,$2)
       ON CONFLICT (network) DO UPDATE SET rebuild_id=EXCLUDED.rebuild_id, promoted_at=NOW()`,
      [r.network, id],
    );
    await client.query(`UPDATE indexer_rebuilds SET status='promoted', promoted_at=NOW() WHERE id=$1`, [id]);
    logger.info('Promoted shadow projection', { rebuildId: id, network: r.network });
    return { promoted: true, alreadyPromoted: false };
  });
}
