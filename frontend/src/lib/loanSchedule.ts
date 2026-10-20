// Authoritative loan repayment schedule binding for the borrower cost preview.
//
// The preview must never rely on a locally derived estimate alone: it binds to a
// versioned schedule response from the backend/contract and reconciles every
// displayed total against integer minor units. Signing is blocked whenever the
// schedule is stale, incomplete, or inconsistent with the current request.

export type MinorUnits = bigint;

export interface LoanTerms {
  asset: string;
  unit: string;
  /** Annualized rate in basis points (1 bp = 0.01%). */
  rateBps: number;
  /** Term length in whole periods (e.g. months). */
  termPeriods: number;
  principal: MinorUnits;
  fees: MinorUnits;
}

export interface ScheduleComponent {
  label: string;
  amount: MinorUnits;
}

export interface AuthoritativeSchedule {
  /** Monotonic schedule version issued by the backend. */
  scheduleVersion: number;
  /** Policy version the schedule was computed under. */
  policyVersion: number;
  asset: string;
  unit: string;
  rateBps: number;
  termPeriods: number;
  principal: MinorUnits;
  fees: MinorUnits;
  /** Component breakdown that must sum exactly to totalDue. */
  components: ScheduleComponent[];
  totalDue: MinorUnits;
  /** Timestamp (ms) after which the schedule is considered stale. */
  expiresAt: number;
}

export interface PreviewRequest {
  terms: LoanTerms;
  /** Policy version the client expects to be settled under. */
  expectedPolicyVersion: number;
  /** Schedule version the client last saw, if any. */
  knownScheduleVersion?: number;
}

export type PreviewStatus = 'confirmed' | 'blocked';

export type BlockReason =
  | 'schedule-unavailable'
  | 'schedule-stale'
  | 'policy-version-mismatch'
  | 'schedule-version-regression'
  | 'terms-mismatch'
  | 'incomplete-components'
  | 'total-mismatch';

export interface ReconciledPreview {
  status: PreviewStatus;
  /** Whether the borrower may sign the transaction. */
  canSign: boolean;
  /** Locally derived estimate, shown alongside confirmed values. */
  estimate: {
    totalDue: MinorUnits;
    fees: MinorUnits;
  };
  /** Confirmed values from the authoritative schedule, when available. */
  confirmed: {
    scheduleVersion: number;
    policyVersion: number;
    asset: string;
    unit: string;
    rateBps: number;
    termPeriods: number;
    principal: MinorUnits;
    fees: MinorUnits;
    components: ScheduleComponent[];
    totalDue: MinorUnits;
  } | null;
  /** Reasons signing is blocked; empty when confirmed. */
  blockReasons: BlockReason[];
  /** Whether a retry (re-fetch) is offered to the borrower. */
  canRetry: boolean;
}

/**
 * Derive a local estimate in integer minor units. This is only ever shown as an
 * estimate; it is never used to authorize signing.
 */
export function estimateTotalDue(terms: LoanTerms): MinorUnits {
  const principal = terms.principal;
  const fees = terms.fees;
  // Simple interest over the term, rounded down to whole minor units.
  const interestNumerator = principal * BigInt(terms.rateBps) * BigInt(terms.termPeriods);
  const interest = interestNumerator / 10_000n;
  return principal + fees + interest;
}

function sumComponents(components: ScheduleComponent[]): MinorUnits {
  return components.reduce((acc, c) => acc + c.amount, 0n);
}

function termsMatchSchedule(terms: LoanTerms, schedule: AuthoritativeSchedule): boolean {
  return (
    terms.asset === schedule.asset &&
    terms.unit === schedule.unit &&
    terms.rateBps === schedule.rateBps &&
    terms.termPeriods === schedule.termPeriods &&
    terms.principal === schedule.principal &&
    terms.fees === schedule.fees
  );
}

/**
 * Reconcile a locally derived estimate against the authoritative schedule.
 *
 * Returns a preview that explicitly separates estimate from confirmed values
 * and blocks signing whenever the schedule is stale, incomplete, or
 * inconsistent with the request.
 */
export function reconcilePreview(
  request: PreviewRequest,
  schedule: AuthoritativeSchedule | null | undefined,
  now: number = Date.now(),
): ReconciledPreview {
  const estimateTotal = estimateTotalDue(request.terms);
  const estimate = { totalDue: estimateTotal, fees: request.terms.fees };

  if (!schedule) {
    return {
      status: 'blocked',
      canSign: false,
      estimate,
      confirmed: null,
      blockReasons: ['schedule-unavailable'],
      canRetry: true,
    };
  }

  const blockReasons: BlockReason[] = [];

  if (schedule.expiresAt <= now) {
    blockReasons.push('schedule-stale');
  }

  if (schedule.policyVersion !== request.expectedPolicyVersion) {
    blockReasons.push('policy-version-mismatch');
  }

  if (
    request.knownScheduleVersion !== undefined &&
    schedule.scheduleVersion < request.knownScheduleVersion
  ) {
    blockReasons.push('schedule-version-regression');
  }

  if (!termsMatchSchedule(request.terms, schedule)) {
    blockReasons.push('terms-mismatch');
  }

  if (schedule.components.length === 0) {
    blockReasons.push('incomplete-components');
  } else if (sumComponents(schedule.components) !== schedule.totalDue) {
    blockReasons.push('total-mismatch');
  }

  const confirmed = {
    scheduleVersion: schedule.scheduleVersion,
    policyVersion: schedule.policyVersion,
    asset: schedule.asset,
    unit: schedule.unit,
    rateBps: schedule.rateBps,
    termPeriods: schedule.termPeriods,
    principal: schedule.principal,
    fees: schedule.fees,
    components: schedule.components,
    totalDue: schedule.totalDue,
  };

  const canSign = blockReasons.length === 0;

  return {
    status: canSign ? 'confirmed' : 'blocked',
    canSign,
    estimate,
    confirmed,
    blockReasons,
    canRetry: !canSign,
  };
}
