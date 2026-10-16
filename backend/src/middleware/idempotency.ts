import type { Request, Response, NextFunction } from 'express';
import { cacheService } from '../services/cacheService.js';
import logger from '../utils/logger.js';
import { AppError } from '../errors/AppError.js';

const IDEMPOTENCY_TTL = 24 * 60 * 60; // 24 hours in seconds

// Methods that require idempotency keys
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface CachedResponse {
  status: number;
  body: unknown;
}

/**
 * Middleware to handle Idempotency-Key headers.
 * - For write operations (POST/PUT/PATCH/DELETE), an Idempotency-Key is REQUIRED
 * - If the key exists in cache, returns the cached response
 * - Otherwise, captures and caches the response
 * - Enforces that duplicate keys within 24h return the same response
 */
export const idempotencyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const key = req.header('Idempotency-Key');
  const isWriteOperation = WRITE_METHODS.has(req.method);

  // Enforce idempotency key on all write operations
  if (isWriteOperation && !key) {
    return next(
      AppError.badRequest('Idempotency-Key header is required for write operations'),
    );
  }

  // Auth challenges are short-lived and login challenges are one-time. Caching
  // either response could return stale challenges or replay an issued JWT.
  if (
    req.method === 'POST' &&
    (req.path === '/api/auth/challenge' || req.path === '/api/auth/login')
  ) {
    return next();
  }

  if (!key) {
    return next();
  }

  try {
    const cacheKey = `idemp:${key}`;
    const cached = await cacheService.get<CachedResponse>(cacheKey);

    if (cached) {
      logger.info(`Idempotency hit for key: ${key}`, {
        url: req.originalUrl,
        method: req.method,
      });

      // X-Idempotent-Replayed: true signals to the client that this response
      // is a cached replay of a prior request, not a fresh execution.
      // Clients can use this to de-duplicate toasts and avoid double-counting.
      res
        .status(cached.status)
        .set('X-Idempotency-Cache', 'HIT')
        .set('X-Idempotent-Replayed', 'true')
        .json(cached.body);
      return;
    }

    // Capture the original methods to intercept the response body
    const originalJson = res.json;
    const originalSend = res.send;

    let responseBody: unknown;

    // Override res.json
    res.json = function (body: unknown) {
      responseBody = body;
      return originalJson.call(this, body);
    };

    // Override res.send (as res.json eventually calls res.send)
    res.send = function (body: unknown) {
      if (!responseBody) {
        if (typeof body === 'string') {
          try {
            responseBody = JSON.parse(body);
          } catch {
            responseBody = body;
          }
        } else {
          responseBody = body;
        }
      }
      return originalSend.call(this, body);
    };

    // X-Idempotent-Replayed: false on the first (fresh) execution so the
    // client always receives the header and can branch on its value.
    res.set('X-Idempotent-Replayed', 'false');

    // Store the response in cache once the request is finished
    res.on('finish', async () => {
      // Cache 2xx and 4xx status codes (errors are cacheable too).
      // 5xx errors should NOT be cached—let client retry.
      if (res.statusCode >= 200 && res.statusCode < 500 && responseBody) {
        try {
          await cacheService.set(
            cacheKey,
            {
              status: res.statusCode,
              body: responseBody,
            },
            IDEMPOTENCY_TTL,
          );
          logger.debug(`Idempotency key cached: ${key}`, {
            method: req.method,
            path: req.path,
            status: res.statusCode,
          });
        } catch (error) {
          logger.error(`Error caching idempotency key ${key}`, { error });
        }
      }
    });

    next();
  } catch (error) {
    logger.error('Error in idempotency middleware', { error, key });
    next();
  }
};

/**
 * Rotate an old idempotency key to a new one within the same 24h window.
 * Useful when clients need to retry with a fresh key (e.g., after timeout).
 * The old key remains cached; the new key becomes the primary for future requests.
 */
export const rotateIdempotencyKey = async (
  oldKey: string,
  newKey: string,
): Promise<boolean> => {
  try {
    const cacheKey = `idemp:${oldKey}`;
    const cached = await cacheService.get<CachedResponse>(cacheKey);
    if (cached) {
      const newCacheKey = `idemp:${newKey}`;
      await cacheService.set(newCacheKey, cached, IDEMPOTENCY_TTL);
      logger.info(`Idempotency key rotated: ${oldKey} -> ${newKey}`);
      return true;
    }
    return false;
  } catch (error) {
    logger.error('Error rotating idempotency key', { oldKey, newKey, error });
    return false;
  }
};
