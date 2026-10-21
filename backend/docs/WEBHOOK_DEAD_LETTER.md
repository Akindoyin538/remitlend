# Webhook dead-letter and re-drive runbook

## States

A delivery whose retries are exhausted (`attempt_count` reaches the retry ceiling without a 2xx)
is marked dead-lettered: `dead_lettered_at` and a redacted `dead_letter_reason` are set. The
signed payload, `event_id` and history stay in `webhook_deliveries`; nothing is deleted.
Dead-lettered rows are skipped by the retry processor.

## Operator API (JWT, `admin` role)

- `GET /admin/webhooks/dead-letters?limit=50` lists dead-lettered deliveries (no payload, no URL).
- `POST /admin/webhooks/deliveries/:deliveryId/redrive` re-queues one delivery. It accepts no body:
  the callback URL comes from the stored subscription and the payload is never modified.
  Returns `202` with the new `generation`, or `409` if the delivery is not dead-lettered
  (duplicate or concurrent re-drive: only one request wins the conditional update).
  Each call is written to `audit_logs`, and `last_redriven_by` / `last_redriven_at` are stored.

## Runbook

1. List dead letters; read `dead_letter_reason` and `last_status_code`.
2. Fix the consumer (or rotate the subscription secret; re-drive signs with the current secret).
3. Re-drive the delivery. The retry processor sends it on its next poll (<= 10s).
4. If it fails again it returns to the dead-letter state with a higher generation.

## Consumer idempotency requirements

Every request carries `x-remitlend-event-id` (stable for the life of the event, identical across
retries and re-drives) and `x-remitlend-delivery-generation` (starts at 1, +1 per re-drive).
Consumers MUST deduplicate financial side effects on `x-remitlend-event-id` and treat a repeated
event ID as a no-op that still returns 2xx. The body and HMAC signature semantics
(`x-remitlend-signature: sha256=<hmac of body>`) are unchanged.
