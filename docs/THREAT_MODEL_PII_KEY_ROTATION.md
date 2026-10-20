# Threat Model & Architecture: PII Encryption Key Rotation

**Scope:** Backend PII data encryption key rotation as production-ready work.

**Objective:** Enable secure, auditable rotation of PII Data Encryption Keys (DEKs) wrapped by Key Encryption Keys (KEKs) in KMS, with comprehensive error handling, observability, and rollback capability.

---

## 1. Architecture Overview

### 1.1 Key Hierarchy

```
KMS-Managed KEK (v1)
  └── DEK (randomly generated per field)
        └── Plaintext PII (email, phone, name)
        └── AES-256-GCM ciphertext + IV + auth tag

When rotating:
KMS-Managed KEK (v1)  -->  KMS-Managed KEK (v2)
  ↓                              ↓
  Old DEK wrappers          New DEK wrappers (re-encrypted)
```

### 1.2 Current State

- **Encryption service:** `backend/src/services/piiCrypto.ts` (AES-256-GCM)
- **Key wrapping:** Local `aes-256-gcm` or KMS endpoint (`PII_KMS_ENDPOINT`)
- **Tracked fields:** `user_profiles.{name_encrypted, email_encrypted, phone_encrypted}`, `remittances.{recipient_name, recipient_email, recipient_phone}`
- **Audit trail:** `pii_access_log` table for reads; `audit_logs` for privileged operations

### 1.3 Rotation Workflow

```
1. Operator initiates rotation request
   ↓
2. Validate new KEK exists in KMS
   ↓
3. Start rotation job (idempotent, restartable)
   ├─ Create key_rotation_batch record (status: pending)
   ├─ Scan encrypted records in batches
   └─ For each record:
      ├─ Decrypt with old KEK (observed in database)
      ├─ Re-encrypt with new KEK
      ├─ Update record with new wrapped DEK + new KEK ID
      └─ Mark as rotated in key_rotation_batch
   ↓
4. Verify rotation (sample checks, audit comparison)
   ↓
5. Transition to new KEK
   ├─ Update PII_KEK_ID in environment
   ├─ New encryptions use new KEK automatically
   └─ Old records have old KEK IDs (read-through decryption)
   ↓
6. Operator confirms successful rotation
   ├─ Mark batch as complete
   └─ Revoke old KEK in KMS (if policy allows)
```

---

## 2. Threat Model

### 2.1 Threats and Controls

| Threat | Impact | Mitigation | Verification |
|--------|--------|-----------|---|
| **KEK compromise in KMS** | Attacker can decrypt all PII | 1. KEK lives in KMS, never in app memory as plaintext 2. Rotation immediately invalidates old key 3. Each DEK is random (no patterns) | `KeyRotationService.validateKekAccess()` before rotation; audit log every rotation |
| **Partial rotation failure** | Some records re-encrypted, others not (inconsistent state) | 1. Batch tracking in `key_rotation_batch` table 2. Idempotent re-encryption (same plaintext → same ciphertext never, due to random IV/DEK, but decryption is idempotent) 3. Resumable on retry | `KeyRotationService.resumeRotation()` reads last checkpoint and continues; tests verify recovery |
| **Decryption failure mid-rotation** | Stale data, decrypt error, or KEK unavailable | 1. Circuit breaker for KMS failures 2. Retry with exponential backoff 3. Graceful degradation: mark as `failed` in batch, operator reviews logs | `KeyRotationService.rotateRecordWithRetry()` with max retries; logs detailed failure reason |
| **Old KEK revoked too early** | In-flight records can't decrypt; rollback impossible | 1. Verify rotation is 100% complete before operator revokes old key 2. Audit log includes "old_kek_revoke" event 3. Waiting period enforced | Documentation warns operator; script checks batch.completed_at |
| **Read anomalies during rotation** | Request sees DEK wrapped with old KEK, another sees new KEK | 1. Decryption is transparent: `decryptField()` tries to unwrap with observed KEK ID 2. No inconsistency risk (plaintext is consistent) 3. All reads are logged | `pii_access_log.dek_kek_id` column tracks which key version was used |
| **Rollback after partial rotation** | Some records encrypted with new key, rotation fails, need to abort | 1. `rollbackRotation()` reverses all new-key records back to old-key format 2. Only available while old KEK is accessible 3. Audit logged | Tests verify rollback correctness by re-decrypting all records |
| **DoS via rotation spam** | Attacker or buggy operator triggers thousands of rotation jobs | 1. Authorization: only `admin:all` scope can start rotation 2. Rate limit: one active rotation at a time per tenant 3. Manual operator confirmation required | Scope guards + audit logs; tests verify scope enforcement |
| **DEK collision / weak randomness** | Multiple records encrypted with same DEK (statistical break) | 1. Each field uses a fresh random DEK (`crypto.randomBytes(32)`) 2. DEK is unique per plaintext instance 3. PRNG is Node.js `crypto` (CSPRNG) | Unit tests verify DEKs are unique across multiple encryptions |
| **Metadata leakage (DEK IDs, KEK IDs)** | Attacker infers rotation status or KEK version from observing changes | 1. KEK ID is stored openly (it's a KMS ID, not a secret) 2. Rotation progress is logged (not a secret) 3. Plaintext PII is never leaked | Not a threat; metadata is acceptable to expose |
| **Concurrent rotation attempts** | Two processes try to rotate simultaneously | 1. Database-level lock via `key_rotation_batch.status = 'in_progress'` 2. Operator initiates single rotation; all instances see the same batch | Tests verify only one batch per time window; concurrent calls fail safely |

### 2.2 Assumptions

From `SECURITY-ASSUMPTIONS.md`, the following apply to key rotation:

| ID | Assumption | Mitigation |
|----|------------|-----------|
| A-3 | `PII_KEK_ID` injected as secret, rotated on compromise | Operator must update env before triggering rotation; audit log captures change |
| A-7 | KMS endpoint is trusted and only reachable from app | Network isolation assumed; endpoint URL in `PII_KMS_ENDPOINT` is HTTPS-only |

### 2.3 Limitations (Accepted Risks)

| ID | Limitation | Compensating Control |
|----|-----------|---------------------|
| L-9 (new) | Rotation is not atomic at the record level: one record succeeds, next fails mid-batch | Resume mechanism + batch checkpointing; operator reviews logs and decides whether to resume or rollback |
| L-10 (new) | No cryptographic proof of rotation completion (signed manifest) | Audit log + manual verification; operator spot-checks decryptions post-rotation |
| L-11 (new) | Operator can revoke old KEK before rotation is 100% complete (human error) | Documented; waiting period enforced in runbook; script warns operator |

---

## 3. Implementation Details

### 3.1 New Components

#### `KeyRotationService` (`backend/src/services/keyRotationService.ts`)

```typescript
class KeyRotationService {
  // Initiate a new key rotation batch
  async startRotation(
    newKekId: string,
    actor: string,
    requestId: string
  ): Promise<KeyRotationBatch>
  
  // Resume a stalled rotation from checkpoint
  async resumeRotation(batchId: string): Promise<KeyRotationBatch>
  
  // Rotate a single record with retry logic
  private async rotateRecordWithRetry(
    record: EncryptedRecord,
    oldKekId: string,
    newKekId: string,
    retries: number = 3
  ): Promise<RotatedRecord>
  
  // Rollback: re-encrypt all new-key records back to old key
  async rollbackRotation(batchId: string): Promise<void>
  
  // Verify rotation succeeded by spot-checking records
  async verifyRotation(batchId: string): Promise<RotationVerificationResult>
  
  // Metrics and observability
  private emitMetrics(event: RotationEvent): void
}
```

#### `KeyRotationBatch` Table Schema

```sql
CREATE TABLE key_rotation_batch (
  id UUID PRIMARY KEY,
  old_kek_id TEXT NOT NULL,
  new_kek_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, in_progress, completed, failed, rolled_back
  
  -- Checkpointing for resumable rotation
  last_rotated_record_id UUID,
  total_records_scanned BIGINT DEFAULT 0,
  total_records_rotated BIGINT DEFAULT 0,
  total_records_failed BIGINT DEFAULT 0,
  
  -- Audit trail
  initiated_by TEXT NOT NULL,
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  
  -- Error tracking
  failure_reason TEXT,
  last_error_code TEXT,
  
  -- Verification
  verification_passed BOOLEAN,
  verification_sample_size INT,
  verification_checked_at TIMESTAMPTZ,
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,
  request_id TEXT NOT NULL,
  
  CONSTRAINT status_check CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'rolled_back'))
);

CREATE INDEX idx_key_rotation_batch_status_initiated 
  ON key_rotation_batch(status, initiated_at DESC);
```

#### `KeyRotationRecord` Table Schema (Checkpoint)

```sql
CREATE TABLE key_rotation_record (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES key_rotation_batch(id),
  
  table_name TEXT NOT NULL,  -- user_profiles, remittances, etc.
  record_id UUID NOT NULL,
  field_name TEXT NOT NULL,
  
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, rotated, failed, rolled_back
  
  old_dek_wrapped BYTEA,
  new_dek_wrapped BYTEA,
  
  failure_reason TEXT,
  attempted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  
  CONSTRAINT status_check CHECK (status IN ('pending', 'rotated', 'failed', 'rolled_back'))
);

CREATE INDEX idx_key_rotation_record_batch_status 
  ON key_rotation_record(batch_id, status);
```

### 3.2 Error Handling Strategy

```
KMS Errors (from unwrapDek / wrapDek):
├─ Network timeout
│  └─ Retry with exponential backoff (base: 500ms, max: 30s)
├─ Authentication failure (expired token)
│  └─ Fail fast, report to operator
├─ KEK not found or revoked
│  └─ Fail fast, mark batch as failed
└─ Service unavailable (5xx)
   └─ Circuit breaker after 3 failures, exponential backoff

Decryption Errors (bad ciphertext, wrong DEK):
├─ Auth tag mismatch
│  └─ Likely data corruption; log and skip record, mark as failed
├─ Unexpected plaintext format
│  └─ Log; manual operator intervention required
└─ DEK unwrap failure
   └─ Likely KEK unavailability; retry with backoff

Database Errors:
├─ Deadlock
│  └─ Retry transaction
├─ Constraint violation (duplicate record)
│  └─ Already rotated; skip
└─ Connection pool exhausted
   └─ Backoff; do not retry indefinitely
```

### 3.3 Observability

**Metrics (OpenTelemetry):**
```
key_rotation.batch_started (counter) → [kek_id, actor]
key_rotation.records_rotated (gauge) → [batch_id, status]
key_rotation.batch_duration_ms (histogram) → [batch_id, success]
key_rotation.kms_unwrap_duration_ms (histogram) → [kek_id, success]
key_rotation.verification_passed (counter) → [batch_id, sample_size]
key_rotation.rollback_triggered (counter) → [batch_id, reason]
```

**Structured Logs (JSON):**
```json
{
  "timestamp": "2026-10-16T10:00:00Z",
  "level": "info",
  "message": "key_rotation_batch_started",
  "batch_id": "abc123",
  "old_kek_id": "arn:aws:kms:us-east-1:123456789:key/old",
  "new_kek_id": "arn:aws:kms:us-east-1:123456789:key/new",
  "actor": "operator:alice@example.com",
  "request_id": "req-456"
}
```

**Audit Logs:**
```
action: "key_rotation_started"
resource_type: "pii_encryption_key"
resource_id: "<old_kek_id>"
metadata: { batch_id, new_kek_id, actor, total_records }

action: "key_rotation_completed"
resource_id: "<batch_id>"
metadata: { records_rotated, duration_ms, verified }

action: "key_rotation_failed"
resource_id: "<batch_id>"
metadata: { failure_reason, records_rotated_before_failure }

action: "key_rotation_rolled_back"
resource_id: "<batch_id>"
metadata: { reason, records_restored }
```

---

## 4. Failure Modes and Recovery

### 4.1 Scenario: Network Timeout During Decryption

**Detection:** `rotateRecordWithRetry()` throws `KMSTimeoutError`.

**Recovery:**
1. Immediate retry (up to 3 times, exponential backoff)
2. If all retries fail, record marked as `failed` in `key_rotation_record`
3. Batch continues to next record
4. Batch marked as `failed_partial` (completed with errors)
5. Operator reviews logs, fixes connectivity, calls `resumeRotation(batch_id)`

### 4.2 Scenario: Old KEK Revoked Mid-Rotation

**Detection:** `unwrapDek()` throws `KMS_KEY_NOT_FOUND`; cannot decrypt remaining records.

**Recovery:**
1. Batch halts immediately (status: `failed`)
2. Operator must contact KMS admin to restore old KEK (or from backup)
3. Rotation can be resumed once old KEK is accessible
4. If old KEK is permanently unrecoverable, operator must manually restore from backup

**Prevention:** Operator must not revoke old KEK until `batch.status = 'completed'` AND `verification_passed = true`.

### 4.3 Scenario: Rollback Requested After Partial Rotation

**Detection:** Operator reviews logs, finds unacceptable error rate, calls `rollbackRotation(batch_id)`.

**Recovery:**
1. `rollbackRotation()` reads all records in `key_rotation_record` with `status = 'rotated'`
2. For each, fetch original plaintext (still cached in memory or re-decrypt from backup)
3. Re-encrypt with old KEK
4. Update database records with old DEK wrappers
5. Mark all records as `rolled_back`
6. Batch status: `rolled_back`
7. Audit log the decision and reason

---

## 5. Deployment and Rollout Strategy

### 5.1 Pre-Rotation Checklist

- [ ] New KEK provisioned in KMS and tested for access
- [ ] Operator has verified new KEK ID: `PII_KEK_ID=<new-id>`
- [ ] Backend containers updated with new `PII_KEK_ID` (or rotation happens before env change)
- [ ] Rotation window scheduled outside peak traffic
- [ ] On-call team notified; rollback contact identified
- [ ] Backup of `key_rotation_batch` and `key_rotation_record` tables taken

### 5.2 Rotation Steps

1. **Start rotation:**
   ```bash
   curl -X POST http://localhost:3001/admin/key-rotation/start \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"new_kek_id":"arn:aws:kms:...:key/new"}'
   ```

2. **Monitor progress:**
   ```bash
   curl http://localhost:3001/admin/key-rotation/batch/<batch-id> \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

3. **Verify rotation:**
   ```bash
   curl -X POST http://localhost:3001/admin/key-rotation/batch/<batch-id>/verify \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

4. **Update environment (if needed):**
   ```bash
   # Update deployment to use new PII_KEK_ID for new encryptions
   kubectl set env deployment/backend PII_KEK_ID=<new-id>
   ```

5. **Confirm rotation:**
   ```bash
   curl -X POST http://localhost:3001/admin/key-rotation/batch/<batch-id>/complete \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

6. **Operator confirms old KEK revocation:**
   - Wait 24 hours (buffer for async processes)
   - Manually revoke old KEK in KMS admin console
   - Log completion in incident tracker

### 5.3 Rollback Plan

If unacceptable error rate detected:

```bash
# Halt rotation (optional; resume will not start new batch)
curl -X POST http://localhost:3001/admin/key-rotation/batch/<batch-id>/rollback \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"reason":"unacceptable_error_rate: 15% decryption failures"}'
```

Operator manually:
1. Reviews logs to identify root cause
2. Fixes issue (e.g., restore KMS access, upgrade backend)
3. Calls `resumeRotation()` or re-initiates new batch

---

## 6. Verification

### 6.1 Unit Tests (Task 5)

- `KeyRotationService.startRotation()` creates batch with correct metadata
- `KeyRotationService.rotateRecordWithRetry()` retries on transient KMS errors
- `KeyRotationService.rotateRecordWithRetry()` fails fast on permanent errors
- `KeyRotationService.rollbackRotation()` restores all records to old key state
- `KeyRotationService.verifyRotation()` spot-checks records and reports pass/fail
- Decryption works for records with both old and new KEK IDs (read-through)
- Concurrent rotation attempts are serialized (only one batch in-progress)

### 6.2 Integration Test (Task 7)

End-to-end workflow:
1. Create encrypted records with old KEK
2. Start rotation to new KEK
3. Verify rotation completes (all records rotated)
4. Verify decryption still works (read-through for both keys)
5. Simulate error mid-batch, resume
6. Verify rollback restores old key state
7. Audit log captures all events

---

## 7. Backwards Compatibility

### 7.1 Deployment Sequence

1. **Week 1:** Deploy new `KeyRotationService` code (rotation not yet active)
   - New tables created in migration
   - Existing encryption/decryption unchanged
   
2. **Week 2:** Operator performs test rotation in staging
   - Verifies batch progress, resume, rollback logic
   
3. **Week 3:** Operator performs first production rotation in low-traffic window
   - Old and new KEKs coexist in environment
   - New encryptions use new KEK (if `PII_KEK_ID` updated)
   - Old KEK still accessible for reads
   
4. **Week 4+:** Operator can revoke old KEK if desired (after 24-hour buffer)

### 7.2 Read-Through Decryption

All `decryptField()` calls continue to work seamlessly:

```typescript
// Before rotation: old DEK wrapped by old KEK
async function decryptField(..., dekKekId: 'old-key-id', ...) {
  const dek = await unwrapDek(dekWrapped, dekKekId);  // ← uses stored KEK ID
  // ...
}

// After rotation: new DEK wrapped by new KEK
// Same function, different stored KEK ID — transparent
```

---

## 8. Security Review Checklist

- [ ] All DEKs are cryptographically random (CSPRNG)
- [ ] KEK never leaves KMS as plaintext
- [ ] Rotation is idempotent (re-encrypting same record is safe)
- [ ] Rollback is complete (all records reverted to old key)
- [ ] Authorization enforced (`admin:all` only)
- [ ] Audit trail is immutable (append-only log)
- [ ] Metrics do not leak plaintext PII
- [ ] Error messages do not leak key material
- [ ] Concurrent rotations serialized (database lock)
- [ ] All KMS failure modes handled
- [ ] Network timeouts have backoff strategy
- [ ] Operator has clear decision points (verify, complete, rollback)

---

## Related Documents

- [PII Handling Runbook](runbooks/pii-handling-runbook.md)
- [Security Assumptions Register](SECURITY-ASSUMPTIONS.md)
- [Backend PII Crypto Service](backend/src/services/piiCrypto.ts)
- [Environment Variables](ENVIRONMENT.md)
