import type { Request, Response, NextFunction } from 'express';
import { deprecatedApiUsageCounter, routeLabel } from './metrics.js';

/** Fixed removal date for the legacy /api/* surface (RFC 8594 Sunset). Override via env. */
const DEFAULT_SUNSET = 'Fri, 31 Jul 2027 00:00:00 GMT';
const MAX_CLIENT_VERSIONS = 20;
const seenVersions = new Set<string>();

/**
 * Reduce the client-supplied X-Client-Version to a bounded, non-identifying cohort.
 * Only strict semver-like major.minor values are kept; everything else collapses
 * to "unknown" / "other" so label cardinality stays bounded.
 */
export function sanitizeClientVersion(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  const m = /^v?(\d{1,3})\.(\d{1,3})(?:\.\d{1,5})?(?:[-+][\w.-]{0,32})?$/.exec(raw.trim());
  if (!m) return 'other';
  const cohort = `${m[1]}.${m[2]}`;
  if (!seenVersions.has(cohort)) {
    if (seenVersions.size >= MAX_CLIENT_VERSIONS) return 'other';
    seenVersions.add(cohort);
  }
  return cohort;
}

/**
 * Adds Deprecation/Sunset/successor Link headers to legacy /api/* routes and
 * records bounded-cardinality usage metrics (route template + client version cohort).
 */
export const deprecationHeadersMiddleware = (req: Request, res: Response, next: NextFunction) => {
  res.set('Deprecation', 'true');
  res.set('Sunset', process.env.API_LEGACY_SUNSET ?? DEFAULT_SUNSET);
  res.set('Link', '</api/v1>; rel="successor-version"; title="API v1"');

  const clientVersion = sanitizeClientVersion(req.get('x-client-version'));
  res.on('finish', () => {
    const route = req.route ? routeLabel(req) : 'unmatched';
    deprecatedApiUsageCounter.inc({ route, client_version: clientVersion });
  });

  next();
};
