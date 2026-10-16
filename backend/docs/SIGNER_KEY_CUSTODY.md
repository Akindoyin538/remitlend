# Signer Key Custody, Rotation, Revocation, and Recovery

This document describes how privileged Soroban signing keys are custodied and
operated for the backend. It accompanies the signer boundary introduced for
issue #560: privileged backend transactions are signed through an external
signer interface, and production private key material is never loaded into the
API process.

## Goals

- Production private key material is never loaded into the API process and is
  never logged.
- Sign requests are restricted by contract, network, operation, and validated
  payload policy.
- The signer returns a transaction signature or a typed denial. It cannot
  bypass wallet/user authorization requirements.
- Local and test signers remain available, but their selection is explicit and
  impossible under production configuration.

## Signer boundary

All privileged backend Soroban transactions are submitted through a signer
interface. The interface accepts a sign request describing the network,
contract, operation, and payload, and returns either:

- a transaction signature, or
- a typed denial (for example: policy denial, key unavailable, timeout,
  replay detected).

The signer is a policy enforcement point, not an authorization bypass. Wallet
and user authorization requirements are enforced before a sign request reaches
the signer and are not relaxed by it.

## Signer selection

- **Production:** an external KMS/HSM or policy-controlled signer adapter. The
  adapter holds or references key material outside the API process. The API
  process only sends sign requests and receives signatures or typed denials.
- **Local/test:** local signers are available for development and automated
  tests. Their selection must be explicit and must be impossible when the
  application is configured for production. Production configuration must fail
  closed if a local/test signer is selected.

## Sign request policy

Every sign request is validated against policy before signing:

- **Contract:** only allow-listed contract IDs may be signed for.
- **Network:** the request network must match the configured network.
- **Operation:** only allow-listed operations may be signed.
- **Payload:** the payload is validated against the expected shape and bounds
  for the operation before signing.

Requests that fail policy validation are denied with a typed denial and are not
signed.

## Key custody

- Production key material lives in a KMS/HSM or an equivalent policy-controlled
  external signer. It is never exported to, loaded into, or logged by the API
  process.
- Access to the external signer is limited to the backend signing identity and
  is auditable.
- Sign requests and typed denials are logged without key material or other
  secrets.

## Rotation

1. Provision the new key in the external signer and grant the backend signing
   identity access.
2. Update the signer configuration to reference the new key.
3. Roll out the configuration change and verify signing succeeds with the new
   key.
4. Retain the previous key only as long as needed to complete in-flight work,
   then revoke it.

Rotation must not require loading private key material into the API process.

## Emergency revocation

1. Revoke or disable the compromised key in the external signer immediately.
2. Confirm that sign requests using the revoked key fail closed with a typed
   denial.
3. Provision and configure a replacement key following the rotation procedure.
4. Review sign request logs and audit trails to determine the scope of the
   compromise.

## Recovery

- If the external signer is unavailable, sign requests fail closed with a typed
  denial. The API must not fall back to a local or test signer in production.
- If a key is lost, follow the rotation procedure to provision a replacement.
- Recovery procedures must preserve the guarantee that production private key
  material is never loaded into the API process.

## Testing expectations

Tests cover key unavailability, policy denial, replay, signer timeout, and
local/test isolation. Local/test signers must be impossible to select under
production configuration.
