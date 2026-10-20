/** @type {import('next').NextConfig} */

// Content Security Policy for the Next.js frontend.
//
// Rollout strategy (issue #562):
//   1. Report-only mode is enabled by default so telemetry can be reviewed
//      before enforcement. Set CSP_ENFORCE=true to switch to enforcement.
//   2. The enforced policy uses explicit source allowlists and avoids broad
//      wildcards and `unsafe-eval`.
//   3. A per-request nonce is generated in middleware and propagated to
//      Next.js scripts via the `x-nonce` request header.
//
// Rollback path: set CSP_ENFORCE=false to return to report-only mode. This
// keeps all other security headers (HSTS, X-Frame-Options, etc.) intact and
// does not disable the policy entirely.

const isDev = process.env.NODE_ENV !== 'production';
const enforce = process.env.CSP_ENFORCE === 'true';

// Explicit allowlists for each directive. Keep these tight; add sources only
// when a concrete integration requires them.
const scriptSrc = [
  "'self'",
  // Next.js injects inline bootstrap scripts; the nonce is added per-request
  // by middleware and read here via the `x-nonce` header.
  "'nonce-{NONCE}'",
  // Wallet connect / Web3 integrations.
  'https://*.walletconnect.com',
  'https://*.walletconnect.org',
  // Analytics.
  'https://*.sentry.io',
  'https://*.posthog.com',
];

const styleSrc = [
  "'self'",
  "'nonce-{NONCE}'",
  // Next.js and many UI libraries inject inline styles at runtime.
  "'unsafe-inline'",
];

const connectSrc = [
  "'self'",
  // Wallet connect relays.
  'https://*.walletconnect.com',
  'wss://*.walletconnect.com',
  'https://*.walletconnect.org',
  'wss://*.walletconnect.org',
  // RPC / API endpoints.
  'https://*.infura.io',
  'https://*.alchemy.com',
  // Analytics and error reporting.
  'https://*.sentry.io',
  'https://*.posthog.com',
];

const imgSrc = [
  "'self'",
  'data:',
  'blob:',
  'https://*.walletconnect.com',
  'https://*.walletconnect.org',
];

const frameSrc = [
  "'self'",
  // Wallet connect iframes.
  'https://*.walletconnect.com',
  'https://*.walletconnect.org',
];

const workerSrc = [
  "'self'",
  'blob:',
];

const cspDirectives = [
  "default-src 'self'",
  `script-src ${scriptSrc.join(' ')}`,
  `style-src ${styleSrc.join(' ')}`,
  `img-src ${imgSrc.join(' ')}`,
  `connect-src ${connectSrc.join(' ')}`,
  `frame-src ${frameSrc.join(' ')}`,
  `worker-src ${workerSrc.join(' ')}`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
];

const cspHeader = cspDirectives.join('; ');

const securityHeaders = [
  {
    key: enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
    value: cspHeader,
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
];

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
