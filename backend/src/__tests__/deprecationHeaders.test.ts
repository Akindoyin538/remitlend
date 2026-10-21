import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { deprecationHeadersMiddleware, sanitizeClientVersion } from '../middleware/deprecationHeaders.js';
import { metricsRegistry } from '../middleware/metrics.js';

describe('deprecation headers and usage metrics', () => {
  it('emits Deprecation, Sunset and successor Link headers', async () => {
    const app = express();
    app.use('/api', deprecationHeadersMiddleware);
    app.get('/api/loans/:id', (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/api/loans/GABC123').set('X-Client-Version', '2.4.1');
    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['sunset']).toBeTruthy();
    expect(res.headers['link']).toContain('rel="successor-version"');

    const text = await metricsRegistry.metrics();
    expect(text).toContain('deprecated_api_requests_total{route="/api/loans/:id",client_version="2.4"}');
    expect(text).not.toContain('GABC123');
  });

  it('bounds client version labels', () => {
    expect(sanitizeClientVersion(undefined)).toBe('unknown');
    expect(sanitizeClientVersion('GABCDEF-wallet-address')).toBe('other');
    expect(sanitizeClientVersion('Bearer abc.def')).toBe('other');
    expect(sanitizeClientVersion('1.2.3')).toBe('1.2');
  });
});
