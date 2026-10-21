import { AsyncLocalStorage } from 'node:async_hooks';

export type CancellationReason = 'client_disconnect' | 'deadline_exceeded';

interface DeadlineContext {
  signal: AbortSignal;
  deadlineAt: number;
}

const storage = new AsyncLocalStorage<DeadlineContext | undefined>();

export class RequestAbortedError extends Error {
  readonly reason: CancellationReason;
  constructor(reason: CancellationReason) {
    super(`Request aborted: ${reason}`);
    this.name = 'RequestAbortedError';
    this.reason = reason;
  }
}

export const DEFAULT_REQUEST_DEADLINE_MS = 30_000;
export const MAX_REQUEST_DEADLINE_MS = 60_000;
export const MIN_REQUEST_DEADLINE_MS = 100;

/**
 * Resolve the effective deadline. A client may only tune it via the
 * `x-request-timeout-ms` header; invalid values fall back to the default and
 * values are clamped to [MIN, MAX]. The server maximum always wins.
 */
export const resolveDeadlineMs = (
  header: string | undefined,
  defaultMs = DEFAULT_REQUEST_DEADLINE_MS,
  maxMs = MAX_REQUEST_DEADLINE_MS,
): number => {
  const cap = Math.min(maxMs, MAX_REQUEST_DEADLINE_MS);
  const base = Math.min(Math.max(defaultMs, MIN_REQUEST_DEADLINE_MS), cap);
  if (header === undefined || !/^\d{1,9}$/.test(header.trim())) return base;
  const requested = Number(header.trim());
  return Math.min(Math.max(requested, MIN_REQUEST_DEADLINE_MS), cap);
};

export const runWithDeadline = <T>(signal: AbortSignal, deadlineAt: number, fn: () => T): T =>
  storage.run({ signal, deadlineAt }, fn);

export const getRequestSignal = (): AbortSignal | undefined => storage.getStore()?.signal;

export const getRemainingMs = (): number | undefined => {
  const ctx = storage.getStore();
  return ctx ? Math.max(0, ctx.deadlineAt - Date.now()) : undefined;
};

const abortError = (signal: AbortSignal): RequestAbortedError =>
  signal.reason instanceof RequestAbortedError
    ? signal.reason
    : new RequestAbortedError('client_disconnect');

export const throwIfAborted = (signal: AbortSignal | undefined = getRequestSignal()): void => {
  if (signal?.aborted) throw abortError(signal);
};

/**
 * Reject as soon as the request is aborted. The underlying work may still run
 * to completion if the driver cannot cancel it (see docs/REQUEST_DEADLINES.md).
 */
export const abortable = <T>(work: Promise<T>, signal = getRequestSignal()): Promise<T> => {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
};

export type SubmissionState = 'submitted';

/**
 * Irreversible boundary: once a signed transaction is handed to the network,
 * cancellation is ignored. Aborts before the call throw (nothing submitted);
 * after the call starts, the work runs outside the request signal and the
 * result reports the actual submission state instead of implying cancellation.
 */
export const runIrreversible = async <T>(
  submit: () => Promise<T>,
  signal = getRequestSignal(),
): Promise<{ state: SubmissionState; result: T; abortedAfterSubmit: boolean }> => {
  throwIfAborted(signal);
  const result = await storage.exit(submit);
  return { state: 'submitted', result, abortedAfterSubmit: Boolean(signal?.aborted) };
};
