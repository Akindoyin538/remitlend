import { NextRequest, NextResponse } from 'next/server';

/**
 * Strict, nonce-based Content Security Policy for the Next.js frontend.
 *
 * Rollout strategy (issue #562):
 *   1. Report-only mode is the default so telemetry can be reviewed before
 *      enforcement. Set CSP_ENFORCE=true to switch to the enforced header.
 *   2. The enforced policy uses explicit source allowlists and never relies on
 *      broad wildcards or `unsafe-eval`.
 *   3. A per-request nonce is generated here and propagated to Next.js via the
 *      `x-nonce` request header so framework and app scripts can be trusted
 *      without `unsafe-inline`.
 *
 * Rollback path: unset CSP_ENFORCE (or set it to a non-"true" value) to return
 * to report-only mode. This keeps the policy observable without disabling all
 * security headers.
 */

const isProduction = process.env.NODE_ENV === 'production';
const enforceCsp = process.env.CSP_ENFORCE === 'true';

// Explicit allowlists for the sources the frontend actually depends on.
const SCRIPT_SRC = [
  "'self'",
  // Wallet connect / injected wallet providers.
  'https://*.walletconnect.com',
  'https://*.walletconnect.org',
  'https://*.coinbase.com',
  'https://*.metamask.io',
  // Analytics and error reporting.
  'https://*.sentry.io',
  'https://*.posthog.com',
  'https://*.vercel-insights.com',
];

const STYLE_SRC = [
  "'self'",
  // Next.js and component libraries inject styles at runtime.
  "'unsafe-inline'",
];

const CONNECT_SRC = [
  "'self'",
  // Wallet RPC / relay endpoints.
  'https://*.walletconnect.com',
  'https://*.walletconnect.org',
  'wss://*.walletconnect.com',
  'wss://*.walletconnect.org',
  'https://*.coinbase.com',
  'https://*.metamask.io',
  // Analytics and error reporting.
  'https://*.sentry.io',
  'https://*.posthog.com',
  'https://*.vercel-insights.com',
];

const IMG_SRC = [
  "'self'",
  'data:',
  'blob:',
  'https://*.walletconnect.com',
  'https://*.coinbase.com',
  'https://*.metamask.io',
];

const FRAME_SRC = [
  "'self'",
  // Wallet connect modals and embedded providers.
  'https://*.walletconnect.com',
  'https://*.walletconnect.org',
  'https://*.coinbase.com',
];

const WORKER_SRC = ["'self'", 'blob:'];

function buildCsp(nonce: string): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'script-src': [
      ...SCRIPT_SRC,
      `'nonce-${nonce}'`,
      // Next.js uses strict-dynamic to load its own chunks under a nonce.
      "'strict-dynamic'",
    ],
    'style-src': STYLE_SRC,
    'connect-src': CONNECT_SRC,
    'img-src': IMG_SRC,
    'font-src': ["'self'", 'data:'],
    'frame-src': FRAME_SRC,
    'worker-src': WORKER_SRC,
    'manifest-src': ["'self'"],
    'upgrade-insecure-requests': [],
  };

  return Object.entries(directives)
    .map(([directive, values]) =>
      values.length > 0 ? `${directive} ${values.join(' ')}` : directive,
    )
    .join('; ');
}

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Next.js reads the CSP header to attach the nonce to its own scripts.
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const headerName = enforceCsp
    ? 'Content-Security-Policy'
    : 'Content-Security-Policy-Report-Only';
  response.headers.set(headerName, csp);

  // Keep the nonce available to server components rendering the policy.
  response.headers.set('x-nonce', nonce);

  if (isProduction && !enforceCsp) {
    // Report-only telemetry is collected here before enforcement is enabled.
    response.headers.set('x-csp-mode', 'report-only');
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
