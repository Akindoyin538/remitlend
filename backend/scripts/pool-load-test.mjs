#!/usr/bin/env node
// Repeatable pool-saturation load test. Needs a running backend and a DB-backed endpoint.
// Usage: BASE_URL=http://localhost:3001 TARGET_PATH=/api/v1/pool \
//   node scripts/pool-load-test.mjs [--levels 5,20,100] [--duration 15]
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const base = process.env.BASE_URL ?? 'http://localhost:3001';
const path = process.env.TARGET_PATH ?? '/api/v1/pool';
const levels = opt('levels', '5,20,100').split(',').map(Number);
const durationMs = Number(opt('duration', '15')) * 1000;

const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

async function run(concurrency) {
  const lat = [];
  const codes = {};
  let missingRetryAfter = 0;
  const end = Date.now() + durationMs;
  const worker = async () => {
    while (Date.now() < end) {
      const t = Date.now();
      try {
        const r = await fetch(base + path, { signal: AbortSignal.timeout(30000) });
        await r.arrayBuffer();
        codes[r.status] = (codes[r.status] ?? 0) + 1;
        if (r.status === 503 && !r.headers.get('retry-after')) missingRetryAfter++;
      } catch {
        codes.error = (codes.error ?? 0) + 1;
      }
      lat.push(Date.now() - t);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  lat.sort((a, b) => a - b);
  return {
    concurrency,
    requests: lat.length,
    rps: +(lat.length / (durationMs / 1000)).toFixed(1),
    p50: pct(lat, 0.5),
    p95: pct(lat, 0.95),
    p99: pct(lat, 0.99),
    max: lat.at(-1) ?? 0,
    codes,
    missingRetryAfter,
  };
}

console.log(`target=${base}${path} duration=${durationMs / 1000}s levels=${levels}`);
const rows = [];
for (const c of levels) {
  const r = await run(c);
  rows.push(r);
  console.log(JSON.stringify(r));
}
// Overload must degrade to 200/503 only, with Retry-After on every 503.
const bad = rows.some(
  (r) => r.missingRetryAfter || Object.keys(r.codes).some((k) => !['200', '503'].includes(k)),
);
if (bad) {
  console.error('FAIL: unexpected status codes or 503 without Retry-After');
  process.exit(1);
}
console.log('PASS');
