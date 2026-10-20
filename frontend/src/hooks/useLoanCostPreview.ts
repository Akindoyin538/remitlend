import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type LoanCostPreviewRequest = {
  asset: string;
  unit: string;
  rateBps: number;
  termPeriods: number;
  principalMinor: number;
  feesMinor: number;
  policyVersion: string;
};

export type AuthoritativeSchedule = {
  scheduleVersion: string;
  policyVersion: string;
  asset: string;
  unit: string;
  rateBps: number;
  termPeriods: number;
  principalMinor: number;
  feesMinor: number;
  totalDueMinor: number;
  generatedAt: string;
};

export type LoanCostPreviewStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'stale'
  | 'incomplete'
  | 'inconsistent'
  | 'error';

export type LoanCostPreview = {
  status: LoanCostPreviewStatus;
  scheduleVersion: string | null;
  asset: string | null;
  unit: string | null;
  rateBps: number | null;
  termPeriods: number | null;
  principalMinor: number | null;
  feesMinor: number | null;
  totalDueMinor: number | null;
  estimateTotalDueMinor: number | null;
  canSign: boolean;
  reason: string | null;
  retry: () => void;
};

export type FetchAuthoritativeSchedule = (
  request: LoanCostPreviewRequest,
) => Promise<AuthoritativeSchedule>;

const REQUIRED_FIELDS: Array<keyof AuthoritativeSchedule> = [
  'scheduleVersion',
  'policyVersion',
  'asset',
  'unit',
  'rateBps',
  'termPeriods',
  'principalMinor',
  'feesMinor',
  'totalDueMinor',
];

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function estimateTotalDueMinor(request: LoanCostPreviewRequest): number {
  const interest = Math.round(
    (request.principalMinor * request.rateBps * request.termPeriods) / 10000,
  );
  return request.principalMinor + request.feesMinor + interest;
}

function reconcile(
  request: LoanCostPreviewRequest,
  schedule: AuthoritativeSchedule,
): { status: LoanCostPreviewStatus; reason: string | null } {
  for (const field of REQUIRED_FIELDS) {
    if (isMissing(schedule[field])) {
      return { status: 'incomplete', reason: `missing ${field}` };
    }
  }

  if (schedule.policyVersion !== request.policyVersion) {
    return {
      status: 'stale',
      reason: `policy version ${schedule.policyVersion} does not match ${request.policyVersion}`,
    };
  }

  if (
    schedule.asset !== request.asset ||
    schedule.unit !== request.unit ||
    schedule.rateBps !== request.rateBps ||
    schedule.termPeriods !== request.termPeriods ||
    schedule.principalMinor !== request.principalMinor ||
    schedule.feesMinor !== request.feesMinor
  ) {
    return {
      status: 'inconsistent',
      reason: 'schedule terms do not match the requested terms',
    };
  }

  if (
    !isNonNegativeInteger(schedule.principalMinor) ||
    !isNonNegativeInteger(schedule.feesMinor) ||
    !isNonNegativeInteger(schedule.totalDueMinor)
  ) {
    return { status: 'incomplete', reason: 'amounts must be integer minor units' };
  }

  if (schedule.totalDueMinor < schedule.principalMinor + schedule.feesMinor) {
    return {
      status: 'inconsistent',
      reason: 'total due is less than principal plus fees',
    };
  }

  return { status: 'ready', reason: null };
}

export function useLoanCostPreview(
  request: LoanCostPreviewRequest | null,
  fetchSchedule: FetchAuthoritativeSchedule,
): LoanCostPreview {
  const [status, setStatus] = useState<LoanCostPreviewStatus>('idle');
  const [schedule, setSchedule] = useState<AuthoritativeSchedule | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestKey = request ? JSON.stringify(request) : null;
  const latestKey = useRef<string | null>(null);

  useEffect(() => {
    if (!request || requestKey === null) {
      setStatus('idle');
      setSchedule(null);
      setReason(null);
      return;
    }

    let cancelled = false;
    latestKey.current = requestKey;
    setStatus('loading');
    setReason(null);

    fetchSchedule(request)
      .then((result) => {
        if (cancelled || latestKey.current !== requestKey) {
          return;
        }
        const outcome = reconcile(request, result);
        setSchedule(result);
        setStatus(outcome.status);
        setReason(outcome.reason);
      })
      .catch((error: unknown) => {
        if (cancelled || latestKey.current !== requestKey) {
          return;
        }
        setSchedule(null);
        setStatus('error');
        setReason(error instanceof Error ? error.message : 'failed to load schedule');
      });

    return () => {
      cancelled = true;
    };
  }, [requestKey, attempt, fetchSchedule]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  const estimate = useMemo(
    () => (request ? estimateTotalDueMinor(request) : null),
    [requestKey],
  );

  return {
    status,
    scheduleVersion: schedule?.scheduleVersion ?? null,
    asset: schedule?.asset ?? null,
    unit: schedule?.unit ?? null,
    rateBps: schedule?.rateBps ?? null,
    termPeriods: schedule?.termPeriods ?? null,
    principalMinor: schedule?.principalMinor ?? null,
    feesMinor: schedule?.feesMinor ?? null,
    totalDueMinor: schedule?.totalDueMinor ?? null,
    estimateTotalDueMinor: estimate,
    canSign: status === 'ready',
    reason,
    retry,
  };
}
