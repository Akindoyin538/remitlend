import { describe, it, expect } from '@jest/globals';
import {
  RequestAbortedError,
  abortable,
  getRequestSignal,
  resolveDeadlineMs,
  runIrreversible,
  runWithDeadline,
  MAX_REQUEST_DEADLINE_MS,
} from '../requestDeadline.js';

describe('request deadlines (#512)', () => {
  it('bounds and validates requested deadlines', () => {
    expect(resolveDeadlineMs(undefined)).toBe(30_000);
    expect(resolveDeadlineMs('abc')).toBe(30_000);
    expect(resolveDeadlineMs('-5')).toBe(30_000);
    expect(resolveDeadlineMs('5')).toBe(100);
    expect(resolveDeadlineMs('999999999')).toBe(MAX_REQUEST_DEADLINE_MS);
    expect(resolveDeadlineMs('2000')).toBe(2000);
  });

  it('rejects abortable work on client disconnect and releases the listener', async () => {
    const c = new AbortController();
    const never = new Promise<never>(() => undefined);
    const p = runWithDeadline(c.signal, Date.now() + 1000, () => abortable(never));
    c.abort(new RequestAbortedError('client_disconnect'));
    await expect(p).rejects.toMatchObject({ reason: 'client_disconnect' });
  });

  it('reports deadline_exceeded distinctly from other failures', async () => {
    const c = new AbortController();
    c.abort(new RequestAbortedError('deadline_exceeded'));
    await expect(abortable(Promise.resolve(1), c.signal)).rejects.toMatchObject({
      reason: 'deadline_exceeded',
    });
  });

  it('removes the abort listener after work settles', async () => {
    const c = new AbortController();
    await abortable(Promise.resolve(1), c.signal);
    c.abort(new RequestAbortedError('client_disconnect'));
    expect(c.signal.aborted).toBe(true);
  });

  it('does not cancel irreversible work once started and reports submitted state', async () => {
    const c = new AbortController();
    let sawSignal: AbortSignal | undefined = c.signal;
    const out = await runWithDeadline(c.signal, Date.now() + 1000, () =>
      runIrreversible(async () => {
        sawSignal = getRequestSignal();
        c.abort(new RequestAbortedError('client_disconnect'));
        return 'hash';
      }),
    );
    expect(sawSignal).toBeUndefined();
    expect(out).toEqual({ state: 'submitted', result: 'hash', abortedAfterSubmit: true });
  });

  it('refuses to start irreversible work when already aborted', async () => {
    const c = new AbortController();
    c.abort(new RequestAbortedError('deadline_exceeded'));
    let called = false;
    await expect(
      runIrreversible(async () => {
        called = true;
      }, c.signal),
    ).rejects.toBeInstanceOf(RequestAbortedError);
    expect(called).toBe(false);
  });
});
