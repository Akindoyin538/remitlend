import { useMemo } from "react";

export type ScheduleStatus = "confirmed" | "stale" | "incomplete" | "mismatch" | "unavailable";

export interface AuthoritativeSchedule {
  scheduleVersion: string;
  policyVersion: string;
  asset: string;
  unit: string;
  rateBps: number;
  termMonths: number;
  principalMinor: number;
  feesMinor: number;
  totalDueMinor: number;
  status: ScheduleStatus;
}

export interface PreviewRequest {
  asset: string;
  unit: string;
  rateBps: number;
  termMonths: number;
  principalMinor: number;
  feesMinor: number;
  policyVersion: string;
}

export interface TransactionPreviewProps {
  request: PreviewRequest;
  schedule?: AuthoritativeSchedule | null;
  onRetry?: () => void;
  onSign?: () => void;
}

function formatMinor(minor: number, unit: string): string {
  const whole = Math.trunc(minor / 100);
  const frac = Math.abs(minor % 100).toString().padStart(2, "0");
  return `${whole}.${frac} ${unit}`;
}

export function reconcileSchedule(
  request: PreviewRequest,
  schedule?: AuthoritativeSchedule | null,
): { ok: boolean; reason?: string } {
  if (!schedule) return { ok: false, reason: "Authoritative schedule unavailable" };
  if (schedule.status === "stale") return { ok: false, reason: "Schedule is stale" };
  if (schedule.status === "incomplete") return { ok: false, reason: "Schedule is incomplete" };
  if (schedule.status === "unavailable") return { ok: false, reason: "Schedule unavailable" };
  if (schedule.status === "mismatch") return { ok: false, reason: "Schedule inconsistent with request" };
  if (schedule.policyVersion !== request.policyVersion)
    return { ok: false, reason: "Policy version mismatch" };
  if (
    schedule.asset !== request.asset ||
    schedule.unit !== request.unit ||
    schedule.rateBps !== request.rateBps ||
    schedule.termMonths !== request.termMonths ||
    schedule.principalMinor !== request.principalMinor ||
    schedule.feesMinor !== request.feesMinor
  )
    return { ok: false, reason: "Terms changed since preview" };
  if (schedule.principalMinor + schedule.feesMinor !== schedule.totalDueMinor)
    return { ok: false, reason: "Totals do not reconcile" };
  return { ok: true };
}

export default function TransactionPreview({
  request,
  schedule,
  onRetry,
  onSign,
}: TransactionPreviewProps) {
  const check = useMemo(() => reconcileSchedule(request, schedule), [request, schedule]);
  const canSign = check.ok;

  return (
    <section className="transaction-preview">
      <h3>Loan cost preview</h3>
      <dl>
        <dt>Schedule version</dt>
        <dd>{schedule?.scheduleVersion ?? "—"}</dd>
        <dt>Policy version</dt>
        <dd>{schedule?.policyVersion ?? request.policyVersion}</dd>
        <dt>Asset / unit</dt>
        <dd>{request.asset} / {request.unit}</dd>
        <dt>Rate</dt>
        <dd>{(request.rateBps / 100).toFixed(2)}%</dd>
        <dt>Term</dt>
        <dd>{request.termMonths} months</dd>
        <dt>Principal (estimate)</dt>
        <dd>{formatMinor(request.principalMinor, request.unit)}</dd>
        <dt>Principal (confirmed)</dt>
        <dd>{schedule ? formatMinor(schedule.principalMinor, schedule.unit) : "—"}</dd>
        <dt>Fees (estimate)</dt>
        <dd>{formatMinor(request.feesMinor, request.unit)}</dd>
        <dt>Fees (confirmed)</dt>
        <dd>{schedule ? formatMinor(schedule.feesMinor, schedule.unit) : "—"}</dd>
        <dt>Total due (confirmed)</dt>
        <dd>{schedule ? formatMinor(schedule.totalDueMinor, schedule.unit) : "—"}</dd>
      </dl>
      {!canSign && (
        <p className="preview-error" role="alert">
          {check.reason}. Signing is blocked until the schedule is refreshed.
        </p>
      )}
      <div className="preview-actions">
        <button type="button" onClick={onRetry} disabled={!onRetry}>
          Retry schedule
        </button>
        <button type="button" onClick={onSign} disabled={!canSign || !onSign}>
          Sign transaction
        </button>
      </div>
    </section>
  );
}
