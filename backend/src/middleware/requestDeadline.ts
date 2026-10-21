import type { NextFunction, Request, Response } from 'express';
import client from 'prom-client';
import { metricsRegistry } from './metrics.js';
import logger from '../utils/logger.js';
import {
  RequestAbortedError,
  resolveDeadlineMs,
  runWithDeadline,
  type CancellationReason,
} from '../utils/requestDeadline.js';

// Low-cardinality: `reason` has 2 values; no route/user labels.
export const requestCancelledCounter = new client.Counter({
  name: 'http_requests_cancelled_total',
  help: 'Requests cancelled before completion (client_disconnect, deadline_exceeded).',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

export const requestDeadlineMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const deadlineMs = resolveDeadlineMs(req.header('x-request-timeout-ms'));
  const controller = new AbortController();
  const deadlineAt = Date.now() + deadlineMs;

  const cancel = (reason: CancellationReason) => {
    if (controller.signal.aborted) return;
    controller.abort(new RequestAbortedError(reason));
    requestCancelledCounter.inc({ reason });
    logger.warn('Request cancelled', {
      event: 'request_cancelled',
      reason,
      requestId: req.requestId,
    });
    if (reason === 'deadline_exceeded' && !res.headersSent) {
      res.status(504).json({ success: false, error: { message: 'Request deadline exceeded' } });
    }
  };

  const timer = setTimeout(() => cancel('deadline_exceeded'), deadlineMs);
  timer.unref?.();

  res.on('close', () => {
    clearTimeout(timer);
    if (!res.writableFinished) cancel('client_disconnect');
  });

  runWithDeadline(controller.signal, deadlineAt, () => next());
};
