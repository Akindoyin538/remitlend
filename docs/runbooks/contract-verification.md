# Contract Verification Runbook

## Overview

All deployed Stellar contracts must be verified on Stellar explorer to allow users to review the source code. This runbook covers the automated verification process, monitoring, and troubleshooting.

## Automated Verification Process

### Deployment Flow

When a contract is deployed:

1. **Capture source code hash** — compute SHA256 of source files
2. **Record WASM hash** — compute SHA256 of compiled binary
3. **Create verification record** — insert into `contract_verification` table
4. **Schedule verification task** — background job checks and verifies
5. **Poll Stellar explorer** — confirm verification status
6. **Update admin UI** — show verification progress

> **Known gap:** steps 1–3 are not automated yet. `scripts/deploy.ts` does not insert into `contract_verification`, so new contracts must be registered with the manual SQL in "Manual Verification Flow" (Step 3). Until that is automated, the job and admin endpoint only cover contracts that have a record.

### Verification Record

After deployment, the database contains:

```sql
SELECT * FROM contract_verification WHERE contract_id = 'CA3D5UW6VGFLVHSYQ6AYRQJUEJGV2Z5UPZNHJUDHJ2XJOKV6TZRCD64';

id                  | 1
contract_id         | CA3D5UW6VGFLVHSYQ6AYRQJUEJGV2Z5UPZNHJUDHJ2XJOKV6TZRCD64
contract_name       | LoanManager
source_code_hash    | sha256:abc123...
wasm_hash           | sha256:def456...
verified            | false
verified_at         | NULL
created_at          | 2024-01-15 10:30:00 UTC
updated_at          | 2024-01-15 10:30:00 UTC
```

## Admin UI Integration

The admin dashboard reads verification status from a JWT-protected admin endpoint (`requireRoles('admin')`):

```json
GET /api/v1/admin/contracts/verification-status

{
  "total": 4,
  "verified": 3,
  "pending": 1,
  "verificationRate": 75,
  "contracts": [
    {
      "contractId": "CA3D...",
      "contractName": "LoanManager",
      "verified": true,
      "verifiedAt": "2024-01-15T10:35:00Z",
      "explorerUrl": "https://stellar.expert/explorer/testnet/contract/CA3D..."
    },
    {
      "contractId": "CBXYZ...",
      "contractName": "LendingPool",
      "verified": false,
      "verifiedAt": null,
      "explorerUrl": "https://stellar.expert/explorer/testnet/contract/CBXYZ..."
    }
  ]
}
```

> **Status:** the endpoint is implemented (`backend/src/controllers/adminContractVerificationController.ts`). The frontend admin page that renders it is not yet built.

## Stellar Explorer Integration

### Explorer URLs

**Testnet:**
```
https://stellar.expert/explorer/testnet/contract/{contractId}
```

**Mainnet (Public):**
```
https://stellar.expert/explorer/public/contract/{contractId}
```

### Verification via Stellar API

The verification process:

1. Submit source code to Stellar explorer API
2. Include source code hash and WASM hash
3. Stellar expert verifies hashes match
4. Contract marked as "Verified Source"

### Manual Verification (Fallback)

If automatic verification fails:

```bash
# Get the contract ID from environment
export CONTRACT_ID=CA3D5UW6VGFLVHSYQ6AYRQJUEJGV2Z5UPZNHJUDHJ2XJOKV6TZRCD64

# Visit the explorer
curl https://stellar.expert/api/v2/contract/$CONTRACT_ID

# Check verification status in response
{
  "id": "CA3D...",
  "verified": true,
  "sourceFile": "contracts/LoanManager.rs"
}
```

## Verification Attempts

All verification attempts are logged for auditing:

```sql
SELECT * FROM contract_verification_attempts
WHERE contract_id = 'CA3D...'
ORDER BY attempted_at DESC
LIMIT 10;

id  | contract_id | success | message | attempted_at
----|-------------|---------|---------|------------------
25  | CA3D...     | true    | Verification successful | 2024-01-15 10:35:00
24  | CA3D...     | false   | Source hash mismatch    | 2024-01-15 10:31:00
23  | CA3D...     | false   | API timeout             | 2024-01-15 10:30:15
```

## Monitoring

### Health Check

```bash
# Check verification stats (same endpoint as the admin UI)
curl http://localhost:3001/api/v1/admin/contracts/verification-status \
  -H "Authorization: Bearer $ADMIN_TOKEN"

{
  "total": 4,
  "verified": 3,
  "pending": 1,
  "verificationRate": 75,
  "contracts": [...]
}
```

### Alerts

Configure monitoring for unverified contracts:

```yaml
alerts:
  - name: UnverifiedContractsAlert
    expr: contract_verification_pending > 0
    for: 1h
    annotations:
      summary: "{{ $value }} contract(s) pending verification"
      action: "Check verification logs and retry"

  - name: VerificationFailureRate
    expr: rate(contract_verification_failed[5m]) > 0
    annotations:
      summary: "Contract verification failures detected"
      action: "Check Stellar API connectivity"
```

### Metrics to Track

- `contract_verification_total` — total contracts deployed
- `contract_verification_success` — successfully verified
- `contract_verification_failed` — verification failed
- `contract_verification_pending` — awaiting verification
- `contract_verification_duration_seconds` — time to verify

## Troubleshooting

### Contract Not Appearing as Verified

**Symptom:** Contract deployed, but explorer shows "Not Verified"

**Check:**
```bash
# 1. Verify record exists
SELECT * FROM contract_verification WHERE contract_id = '...';

# 2. Check verification status
SELECT verified, verified_at FROM contract_verification WHERE contract_id = '...';

# 3. Review attempts
SELECT * FROM contract_verification_attempts 
WHERE contract_id = '...' ORDER BY attempted_at DESC LIMIT 5;
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Source code hash mismatch | Recompile and recompare hashes |
| WASM binary mismatch | Ensure binary wasn't altered after compilation |
| API timeout | Retry verification manually or wait for background job |
| Network connectivity to Stellar | Check firewall, DNS, outbound connectivity |
| Contract not yet indexed | Wait 5-10 minutes for Stellar indexer |

### Verification API Timeout

**Symptom:**
```
contract_verification_attempts: message = "API timeout"
```

**Debug:**
```bash
# Check if Stellar API is reachable
curl https://stellar.expert/api/v2/contract/CA3D... -v

# Check network connectivity
ping stellar.expert

# Check DNS
nslookup stellar.expert
```

**Fix:**
- Increase API timeout in code (currently 30s)
- Check Stellar expert API status
- Retry verification after network recovers

### Duplicate Verification Records

**Symptom:**
```sql
SELECT COUNT(*), contract_id FROM contract_verification 
GROUP BY contract_id HAVING COUNT(*) > 1;
```

**Fix:**
```sql
-- Keep the first record, delete duplicates
DELETE FROM contract_verification
WHERE id NOT IN (
  SELECT MIN(id) FROM contract_verification
  GROUP BY contract_id
);
```

## Manual Verification Flow

### Step 1: Prepare Source Code

```bash
# Gather all source files for the contract
cd contracts/soroban
ls -la *.rs  # or *.ts, etc.

# Create checksum
sha256sum LoanManager.rs > LoanManager.sha256
```

### Step 2: Compute Hashes

```bash
# Source code hash (all files combined)
cat contracts/soroban/*.rs | sha256sum

# WASM hash
sha256sum target/wasm32-unknown-unknown/release/loan_manager.wasm
```

### Step 3: Record in Database

```sql
INSERT INTO contract_verification (
  contract_id,
  contract_name,
  source_code_hash,
  wasm_hash,
  verified,
  created_at
) VALUES (
  'CA3D5UW6...',
  'LoanManager',
  'sha256:abc123...',
  'sha256:def456...',
  false,
  NOW()
);
```

### Step 4: Upload to Stellar Explorer

Visit: `https://stellar.expert/explorer/testnet/contract/CA3D...`

Click "Verify Source" and upload:
- Source code files
- Source code hash
- WASM binary hash

### Step 5: Verify and Test

```bash
# Poll until verified
while true; do
  STATUS=$(curl -s https://stellar.expert/api/v2/contract/CA3D... | jq .verified)
  if [ "$STATUS" = "true" ]; then
    echo "Verified!"
    break
  fi
  echo "Still verifying... (status: $STATUS)"
  sleep 5
done

# Update database
UPDATE contract_verification
SET verified = true, verified_at = NOW()
WHERE contract_id = 'CA3D...';
```

## Automated Verification Job

Implemented in `backend/src/cron/contractVerificationJob.ts`, started from `backend/src/index.ts`. It runs at minute 30 of every hour and:

1. Loads up to 10 unverified rows from `contract_verification` (oldest first).
2. Calls `GET https://stellar.expert/api/v2/contract/{contractId}` and reads the `verified` flag.
3. On `verified: true`, calls `markVerified` (which only matches the stored `source_code_hash`).
4. Writes one row to `contract_verification_attempts` per check: success, "not yet verified", or the error message (HTTP status, timeout, network).

The job skips a run if the previous one is still in flight. Its runs are reported through the job metrics service under `contractVerificationCron`.

> **Known gap:** the `api/v2/contract` response shape is taken from the manual flow above and has not been checked against the live API. Confirm it on testnet before relying on the job's `verified: true` result.

## Deployment Checklist

- [ ] Contract deployed to Stellar (mainnet or testnet)
- [ ] Verification record created in database
- [ ] Source code hash computed and stored
- [ ] WASM binary hash computed and stored
- [ ] Background verification job runs hourly
- [ ] Admin UI displays verification status
- [ ] Alerts configured for unverified contracts
- [ ] Stellar explorer shows contract as verified
- [ ] Documentation updated with contract details

## Rollback Procedure

If verification fails and you need to redeploy:

```bash
# 1. Delete old verification record
DELETE FROM contract_verification WHERE contract_id = 'CA3D...';

# 2. Delete verification attempts
DELETE FROM contract_verification_attempts WHERE contract_id = 'CA3D...';

# 3. Redeploy contract to new contract ID
# (Usually not done; instead, update existing contract if possible)

# 4. Verify the new contract following the manual flow above
```

## Security Considerations

- Source code hash is immutable (SHA256)
- WASM hash prevents tampering with binary
- Verification attempts are audited in database
- Stella expert performs independent verification
- Admin UI only shows contracts verified by owner

## Further Reading

- [Stellar Expert API Docs](https://stellar.expert/api/v2/)
- [Soroban Contract Development](https://developers.stellar.org/docs/smart-contracts)
- [Contract Security Best Practices](https://developers.stellar.org/docs/smart-contracts/security)
