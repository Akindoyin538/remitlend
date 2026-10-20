/**
 * OpenTelemetry trace export configuration.
 *
 * Sentry (`./sentry.ts`) already owns the OpenTelemetry tracer provider and
 * auto-instruments Express, HTTP, pg, Redis and fetch. This module only adds an
 * OTLP/HTTP exporter to that provider so the same spans reach Jaeger (or Tempo,
 * or the OTel Collector) via `openTelemetrySpanProcessors`.
 *
 * Export is enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so local
 * runs and tests without a collector stay silent. Sampling is controlled by
 * `OTEL_TRACES_SAMPLE_RATE` (0..1); unset falls back to 0.2 in production and
 * 1.0 elsewhere, matching the Sentry `tracesSampleRate` defaults.
 */

import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const PRODUCTION_SAMPLE_RATE = 0.2;
const DEVELOPMENT_SAMPLE_RATE = 1.0;

/**
 * Resolves the trace sampling rate. Values outside [0, 1] fall back to the
 * environment default so a typo can never silently disable all tracing.
 */
export const getTracesSampleRate = (): number => {
  const fallback =
    process.env.NODE_ENV === 'production' ? PRODUCTION_SAMPLE_RATE : DEVELOPMENT_SAMPLE_RATE;

  const raw = process.env.OTEL_TRACES_SAMPLE_RATE;
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;

  return parsed;
};

/**
 * Returns the extra span processors to hand to Sentry. Empty when no OTLP
 * endpoint is configured, which leaves Sentry's default behaviour unchanged.
 */
export const getTracingSpanProcessors = (): SpanProcessor[] => {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return [];
  if (process.env.NODE_ENV === 'test') return [];

  // The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT itself and appends /v1/traces.
  return [new BatchSpanProcessor(new OTLPTraceExporter())];
};
