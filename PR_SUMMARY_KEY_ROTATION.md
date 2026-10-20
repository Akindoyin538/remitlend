# PII Encryption Key Rotation Implementation - PR Summary & Rollout Guide

## Overview

This PR implements production-ready PII encryption key rotation for RemitLend, enabling secure re-encryption of all PII fields (email, phone, name) from one Key Encryption Key (KEK) version to another. The implementation includes:

- **KeyRotationService** with exponential backoff retry logic and resumable checkpoints
- **Database tracking** for rotation batches and fine-grained record progress
- **Comprehensive error handling** for all KMS failure paths
- **Audit logging and metrics** for observability
- **Admin API endpoints** for operator control and monitoring
- **Integration tests** covering complete workflows
- **Production runbook** with operator procedures

## What's New

### Files Added

1. **`backend/src/services/keyRotationService.ts`** (890 lines)
   - Core key rotation logic with retry mechanisms
   - KMS integration (unwrap/wrap DEK)
   - Batch tracking and resumable state
   - Verification and rollback capabilities

2. **`backend/src/controllers/keyRotationController.ts`** (310 lines)
   - Admin API endpoints for rotation lifecycle
   - Audit logging for all operations

3. **`backend/migrations/1805000000000_key-rotation-tables.js`** (300 lines)
   - `key_rotation_batch` table (tracks batches)
   - `key_rotation_record` table (checkpoint for resumability)
   - `pii_encrypted_fields` table (central registry for scans)

4. **`backend/src/services/__tests__/keyRotationService.test.ts`** (508 lines)
   - 40+ focused unit tests
   - Error classes, retry logic, wrapping/unwrapping, verification, rollback, concurrency

5. **`backend/src/__tests__/integration/keyRotation.integration.test.ts`** (426 lines)
   - End-to-end workflow test
   - Partial rotation, checkpoint recovery, read-through, rollback scenarios

6. **`docs/THREAT_MODEL_PII_KEY_ROTATION.md`** (471 lines)
   - Detailed threat model with 10+ threats and controls
   - Failure modes and recovery strategies
   - Deployment checklist and verification plan

7. **Updated Documentation**
   - `docs/ENVIRONMENT.md`: Added PII_KEK_ID, PII_KEK_KEY, PII_KMS_ENDPOINT, PII_KMS_REGION
   - `docs/runbooks/pii-handling-runbook.md`: Operator procedures, prerequisites, troubleshooting

### Key Features

#### Error Handling
- **KMSUnwrapError**, **KMSWrapError**, **DecryptionError** with retryable flags
- **RotationAlreadyInProgressError** prevents concurrent rotations
- Exponential backoff: 500ms → 1s → 2s (capped at 30s)
- Max 3 retries per record

#### Observability
- **Prometheus metrics**:
  - `key_rotation_batch_started_total` (counter)
  - `key_rotation_records_rotated` (gauge)
  - `key_rotation_kms_operation_duration_seconds` (histogram)
  - `key_rotation_verification_passed_total` (counter)
  - `key_rotation_rollback_triggered_total` (counter)

- **Audit logs**:
  - `key_rotation_started`
  - `key_rotation_verified`
  - `key_rotation_completed`
  - `key_rotation_rolled_back`
  - `key_rotation_resumed`

#### Resumable State
- Checkpoint saved after each batch (100 records)
- `key_rotation_batch.last_rotated_record_id` tracks progress
- Rotation can resume from last checkpoint on failure
- `key_rotation_record` table tracks per-record success/failure

#### Authorization
- Admin-only (`admin:all` scope)
- All mutations audit-logged
- Scope enforced in middleware

## Threat Model Highlights

### Threats Addressed
1. **KEK compromise**: Immediate rotation invalidates old key
2. **Partial rotation failure**: Checkpoint recovery enables resumption
3. **Decryption failure**: Circuit breaker + retry logic + manual rollback
4. **Early old KEK revocation**: 24-hour buffer enforced by operator runbook
5. **Concurrent rotations**: Database lock prevents simultaneous batches
6. **DoS via rotation spam**: Single active rotation per tenant + rate limiting

### Limitations (Accepted Risks)
- Rotation not atomic per-record: Partial batch failure requires operator decision
- No cryptographic proof of rotation: Audit log + manual verification sufficient
- Operator can revoke old KEK too early: Documented waiting period in runbook

## Deployment & Rollout

### Prerequisites
1. New KEK provisioned in KMS
2. Operator has `admin:all` scope
3. Rotation window scheduled (low-traffic period)
4. On-call team notified

### Rollout Steps

#### Phase 1: Deploy Code (No Rotation)
```bash
# Deploy new backend with KeyRotationService
# Existing PII encryption/decryption unchanged
# New tables created in migration
```

#### Phase 2: Test in Staging
```bash
# 1. Run migration
npm run migrate:up

# 2. Start test rotation
curl -X POST http://staging-api/admin/key-rotation/start \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"new_kek_id":"arn:aws:kms:...:key/new"}'

# 3. Monitor progress
curl http://staging-api/admin/key-rotation/batch/<batch-id> \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 4. Verify
curl -X POST http://staging-api/admin/key-rotation/batch/<batch-id>/verify

# 5. Confirm all records rotated before proceeding
```

#### Phase 3: Production Rotation (Non-Breaking)
```bash
# Old KEK and new KEK coexist
# New encryptions use new KEK ID automatically (if env updated)
# Old records decrypt transparently via stored KEK ID

# 1. Start rotation
curl -X POST https://api.remitlend.com/admin/key-rotation/start \
  -H "Authorization: Bearer $PROD_ADMIN_TOKEN" \
  -d '{"new_kek_id":"arn:aws:kms:us-east-1:123456789:key/..."}'

# 2. Monitor via logs and metrics
# Expected: ~100 records/batch, ~5-10s per batch
# Total time: (total_records / 100) * 10 seconds

# 3. After completion, verify (spot-checks 50 records)
curl -X POST https://api.remitlend.com/admin/key-rotation/batch/<batch-id>/verify

# 4. Complete batch
curl -X POST https://api.remitlend.com/admin/key-rotation/batch/<batch-id>/complete

# 5. Update environment (optional: new encryptions use new KEK)
kubectl set env deployment/backend PII_KEK_ID=arn:aws:kms:...:key/new

# 6. After 24 hours: Revoke old KEK in KMS
aws kms schedule-key-deletion --key-id <old-kek-id> --pending-window-in-days 7
```

### If Rotation Fails

1. **Identify issue** in batch logs
2. **Fix** (e.g., restore KMS access)
3. **Resume** from checkpoint
   ```bash
   curl -X POST https://api.remitlend.com/admin/key-rotation/batch/<batch-id>/resume
   ```
4. **If unrecoverable**, rollback
   ```bash
   curl -X POST https://api.remitlend.com/admin/key-rotation/batch/<batch-id>/rollback \
     -d '{"reason":"KMS unreachable; investigating with KMS team"}'
   ```

## Verification Before & After

### Pre-Deployment
- ✅ All unit tests pass: `npm test -- keyRotationService.test.ts`
- ✅ Integration tests pass: `npm test -- keyRotation.integration.test.ts`
- ✅ Type checking passes: `npm run typecheck`
- ✅ Linting passes: `npm run lint`
- ✅ No PII in logs: `npm run lint` (redaction checks)

### Post-Deployment
1. **Smoke test**: Start/cancel a rotation in staging
2. **Full rotation**: Complete rotation in staging, verify all records decrypted
3. **Metrics**: Confirm Prometheus metrics populated
4. **Audit logs**: Confirm events logged to `audit_logs` table
5. **Production dry-run** (optional): Shadow rotation without committing

## Backward Compatibility

✅ **Fully backward compatible**

- Existing PII records continue to decrypt with their stored KEK ID
- No breaking API changes
- Old and new KEK versions coexist during rotation
- Operator controls when old KEK is revoked (24-hour buffer)

## Documentation

- **Architecture**: `docs/THREAT_MODEL_PII_KEY_ROTATION.md`
- **Operator Guide**: `docs/runbooks/pii-handling-runbook.md` (section "Key rotation")
- **Environment Vars**: `docs/ENVIRONMENT.md` (PII_KEK_ID, PII_KEK_KEY, PII_KMS_ENDPOINT, PII_KMS_REGION)

## Testing Evidence

### Unit Tests (40+ cases)
```
✓ Error classes (KeyRotationError, KMSUnwrapError, etc.)
✓ Key rotation start (batch creation, KEK validation)
✓ Retry logic (transient errors, exponential backoff, max retries)
✓ Key wrapping/unwrapping (local and KMS)
✓ Verification (spot-check validation)
✓ Rollback (record restoration)
✓ Resumable rotation (checkpoint recovery)
✓ Concurrency (serialization, batch locking)
✓ Boundary values (empty KEK, large DEKs, missing KMS endpoint)
```

### Integration Tests (6 scenarios)
```
✓ Complete key rotation workflow
✓ Partial rotation with checkpoint recovery
✓ Read-through decryption (both old and new keys)
✓ Rollback of partially rotated records
✓ Concurrent batch prevention
✓ Migration/checkpoint validation
```

## Security Checklist

- ✅ DEK is random (CSPRNG) for each record
- ✅ KEK never leaves KMS as plaintext
- ✅ Rotation is idempotent (re-encrypting safe)
- ✅ Rollback is complete (all records reverted)
- ✅ Authorization enforced (`admin:all` only)
- ✅ Audit trail immutable (append-only)
- ✅ Metrics do not leak PII
- ✅ Error messages do not leak key material
- ✅ Concurrent rotations serialized (DB lock)
- ✅ All KMS failure modes handled (with backoff)

## Performance Estimates

- **Batch size**: 100 records/batch
- **KMS latency**: ~200-500ms per unwrap/wrap
- **Per-batch time**: ~5-10 seconds
- **Scalability**: 600-1200 records/minute

Example: 100,000 PII records → 100 batches → ~10-15 minutes total

## Related PRs & Discussions

- Blocks: Any KMS integration work requiring different encryption strategy
- Relates to: PII inventory (docs/SECURITY-MODEL.md), audit logging, observability
- Complements: Data subject access requests (DSAR), data retention policies

## Sign-Off

**Author**: Kiro AI  
**Type**: Backend / PII Security  
**Risk Level**: Medium (production-ready but new feature path)  
**Rollout**: Operator-triggered, non-blocking to existing functionality
