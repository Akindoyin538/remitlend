# Content Security Policy (CSP)

This document describes the nonce-based Content Security Policy (CSP) used by the
Next.js frontend, the source inventory it is built from, the report-only rollout
process, and the rollback path.

## Goals

- Protect against XSS by using a strict, nonce-based policy instead of a
  permanent wildcard or `unsafe-inline` exception.
- Keep Next.js framework scripts, wallet integrations, analytics, Sentry, and
  the service worker working under the policy.
- Roll out in report-only mode first, review telemetry, then enforce.

## Source inventory

| Directive | Sources | Notes |
| --- | --- | --- |
| `script-src` | `'self'`, `'nonce-<per-request>'`, `'strict-dynamic'` | Next.js framework and page scripts receive the per-request nonce. No `unsafe-inline`, no `unsafe-eval`. |
| `style-src` | `'self'`, `'nonce-<per-request>'` | Next.js injects styles with the same nonce. |
| `img-src` | `'self'`, `data:`, `blob:`, configured CDN origins | Wallet and token icons. |
| `font-src` | `'self'`, `data:` | Self-hosted fonts. |
| `connect-src` | `'self'`, configured API origin, wallet RPC/relay origins, Sentry ingest origin | Wallet connect, transaction submission, analytics, Sentry. |
| `frame-src` | `'self'`, wallet connect iframe origins | Wallet connect modal. |
| `worker-src` | `'self'`, `blob:` | Service worker and web workers. |
| `object-src` | `'none'` | No plugins. |
| `base-uri` | `'self'` | Prevent base tag injection. |
| `form-action` | `'self'` | Prevent form hijacking. |
| `frame-ancestors` | `'none'` | Clickjacking protection. |

All origins are explicit allowlists. Broad wildcards (`*`, `https:`) and
`unsafe-eval` are not used in the enforced policy.

## Nonce generation and propagation

1. Middleware generates a cryptographically random nonce per request.
2. The nonce is set on the request headers so Next.js can attach it to the
   framework and page scripts it renders.
3. The same nonce is used to build the `Content-Security-Policy` header for the
   response.

Because the nonce changes per request, responses that carry the CSP header must
not be cached by shared caches.

## Rollout: report-only first

1. Deploy with `Content-Security-Policy-Report-Only` and a `report-uri` /
   `report-to` endpoint.
2. Collect and review violation reports for at least one full release cycle,
   covering wallet connect, transaction submission, analytics, Sentry, and the
   service worker.
3. Add any missing legitimate origins to the explicit allowlists.
4. Only after the report-only telemetry is clean, switch to the enforced
   `Content-Security-Policy` header.

Report-only telemetry review must be documented (date, reviewer, summary of
violations and resolutions) before enforcement is enabled.

## Rollback path

If enforcement causes breakage in production:

1. Switch the response header back to `Content-Security-Policy-Report-Only`.
   This keeps all other security headers (HSTS, `X-Content-Type-Options`,
   `Referrer-Policy`, `frame-ancestors`, etc.) active.
2. Do **not** disable all security headers as a rollback.
3. Fix the offending source allowlist, re-review report-only telemetry, and
   re-enable enforcement.

## Testing

Playwright tests assert the presence and shape of the CSP headers and exercise
critical wallet and transaction routes to confirm they function under the
policy.
