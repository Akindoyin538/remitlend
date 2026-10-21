import crypto from 'node:crypto';
import { query } from '../db/connection.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors/AppError.js';
import logger from '../utils/logger.js';

/**
 * Discrepancy ledger (#518). Records evidence of differences between contract
 * state, indexed records and DB projections. It NEVER corrects financial data;
 * resolution only records an operator's decision.
 */

export type DiscrepancySeverity = 'info' | 'warning' | 'critical';

export interface ComparisonRule {
  version: string;
  severity: DiscrepancySeverity;
  /** Whether an operator may mark this class resolved through the API. */
  resolvable: boolean;
}

/** Comparison rules by discrepancy class. Bump `version` when comparison logic changes. */
export const COMPARISON_RULES: Record<string, ComparisonRule> = {
  loan_principal: { version: 'v1', severity: 'critical', resolvable: true },
  pool_balance: { version: 'v1', severity: 'critical', resolvable: true },
  score_snapshot: { version: 'v1', severity: 'warning', resolvable: true },
};

export interface DiscrepancyObservation {
  discrepancyClass: string;
  subjectRef: string;
  asset: string;
  unit: string;
  /** Integer amounts as base-10 strings (e.g. stroops). */
  contractValue: string;
  indexedValue: string;
  dbValue: string;
  ledger?: number;
  txHash?: string;
  snapshots?: Record<string, unknown>;
}

function toBigInt(value: string, field: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw AppError.badRequest(`${field} must be an integer string`);
  }
  return BigInt(value);
}

/** Exact integer comparison across the three sources. Never uses floating point. */
export function valuesDiffer(contract: string, indexed: string, db: string): boolean {
  const c = toBigInt(contract, 'contractValue');
  return c !== toBigInt(indexed, 'indexedValue') || c !== toBigInt(db, 'dbValue');
}

export function computeDedupeKey(o: DiscrepancyObservation, ruleVersion: string): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        o.discrepancyClass,
        ruleVersion,
        o.subjectRef,
        o.asset,
        o.unit,
        BigInt(o.contractValue).toString(),
        BigInt(o.indexedValue).toString(),
        BigInt(o.dbValue).toString(),
      ]),
    )
    .digest('hex');
}

/**
 * Records a discrepancy if the sources disagree. Idempotent: a repeat scan only
 * bumps observation metadata on the existing row. Returns null when sources agree.
 */
export async function recordDiscrepancy(
  o: DiscrepancyObservation,
): Promise<{ id: number; created: boolean } | null> {
  const rule = COMPARISON_RULES[o.discrepancyClass];
  if (!rule) throw AppError.badRequest(`Unknown discrepancy class: ${o.discrepancyClass}`);
  if (!valuesDiffer(o.contractValue, o.indexedValue, o.dbValue)) return null;

  const dedupeKey = computeDedupeKey(o, rule.version);
  const result = await query(
    `INSERT INTO reconciliation_discrepancies (
       dedupe_key, discrepancy_class, rule_version, severity, subject_ref, asset, unit,
       contract_value, indexed_value, db_value, ledger, tx_hash, source_snapshots
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET last_observed_at = NOW(),
           observation_count = reconciliation_discrepancies.observation_count + 1
     RETURNING id, (xmax = 0) AS created`,
    [
      dedupeKey,
      o.discrepancyClass,
      rule.version,
      rule.severity,
      o.subjectRef,
      o.asset,
      o.unit,
      o.contractValue,
      o.indexedValue,
      o.dbValue,
      o.ledger ?? null,
      o.txHash ?? null,
      JSON.stringify(o.snapshots ?? {}),
    ],
  );

  const row = result.rows[0] as { id: number; created: boolean };
  if (row.created && rule.severity === 'critical') {
    // Operator alert: picked up by log-based alerting on this marker.
    logger.error('CRITICAL reconciliation discrepancy detected', {
      alert: 'reconciliation_discrepancy_critical',
      discrepancyId: row.id,
      discrepancyClass: o.discrepancyClass,
      subjectRef: o.subjectRef,
    });
  }
  return { id: Number(row.id), created: Boolean(row.created) };
}

export async function listDiscrepancies(
  filters: { status?: string; severity?: string; limit?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.severity) {
    values.push(filters.severity);
    conditions.push(`severity = $${values.length}`);
  }
  values.push(Math.min(filters.limit ?? 50, 200));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query(
    `SELECT * FROM reconciliation_discrepancies ${where} ORDER BY detected_at DESC LIMIT $${values.length}`,
    values,
  );
  return result.rows as Array<Record<string, unknown>>;
}

export interface ResolveInput {
  discrepancyId: number;
  actor: string;
  reason: string;
  evidence: Record<string, unknown>;
}

/**
 * Marks a discrepancy resolved, appending a resolution record and an audit log
 * entry in one transaction. Does not touch any financial data.
 */
export async function resolveDiscrepancy(input: ResolveInput): Promise<void> {
  const { discrepancyId, actor, reason, evidence } = input;
  if (!actor) throw AppError.badRequest('actor is required');
  if (!reason || reason.trim().length < 10) {
    throw AppError.badRequest('reason of at least 10 characters is required');
  }
  if (!evidence || typeof evidence !== 'object' || Object.keys(evidence).length === 0) {
    throw AppError.badRequest('evidence is required');
  }

  await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT id, discrepancy_class, status FROM reconciliation_discrepancies
       WHERE id = $1 FOR UPDATE`,
      [discrepancyId],
    );
    const row = found.rows[0] as
      | { id: number; discrepancy_class: string; status: string }
      | undefined;
    if (!row) throw AppError.notFound('Discrepancy not found');
    if (!COMPARISON_RULES[row.discrepancy_class]?.resolvable) {
      throw AppError.badRequest('This discrepancy class does not support resolution');
    }
    if (row.status !== 'open') throw AppError.conflict('Discrepancy is already resolved');

    await client.query(
      `INSERT INTO reconciliation_discrepancy_resolutions (discrepancy_id, actor, reason, evidence)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [discrepancyId, actor, reason, JSON.stringify(evidence)],
    );
    await client.query(
      `UPDATE reconciliation_discrepancies SET status = 'resolved', resolved_at = NOW()
       WHERE id = $1`,
      [discrepancyId],
    );
    await client.query(
      `INSERT INTO audit_logs (actor, action, target, payload, status)
       VALUES ($1, 'RESOLVE_DISCREPANCY', $2, $3::jsonb, 200)`,
      [actor, `Discrepancy:${discrepancyId}`, JSON.stringify({ reason, evidence })],
    );
  });
}
