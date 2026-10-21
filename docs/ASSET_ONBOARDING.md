# Safe Asset Onboarding and Rollback

This document describes how a new asset is onboarded into a pool and how to roll
back safely. It complements the on-chain validation performed at pool
initialization (`Pool.sol`) and the shared asset registry used by both the
contracts and the backend configuration validation.

## Canonical asset registry

The canonical asset registry is the single source of truth for accepted assets.
Each entry binds the following fields to the pool configuration:

- **asset identifier** — the token contract address (or symbol key) used by the pool.
- **issuer** — the account/issuer that controls the token contract.
- **network** — the network (e.g. `testnet` / `mainnet`) the asset is valid on.
- **precision (decimals)** — the supported decimal configuration for the asset.

Both the on-chain initialization and the backend configuration validation read
from this same registry. If the two disagree, deployment must fail before any
funds move.

## Onboarding sequence

1. **Register the asset** in the canonical registry with its identifier, issuer,
   network, and precision. Do not reuse an identifier that is already registered
   (duplicate registration is rejected).
2. **Validate the token contract metadata** — confirm the token contract reports
   the expected identifier, issuer, and decimals. Initialization fails closed if
   metadata is missing or does not match the registry entry.
3. **Bind to the pool configuration** — the pool stores the asset identifier,
   issuer, network, and precision. Any mismatch (wrong issuer, unsupported
   precision, wrong network) causes initialization to revert.
4. **Run backend configuration validation** — the backend validates its asset
   configuration against the same canonical registry and reports mismatches
   before deployment.
5. **Deploy / initialize the pool** only after steps 1–4 pass. Unknown assets are
   rejected; the accepted asset set is explicit.

## Rollback sequence

1. **Halt onboarding** — stop any pending deployment or initialization that
   references the asset.
2. **Remove the registry entry** (or mark it inactive) so new pools fail closed on
   the asset.
3. **Revert pool configuration** to the last known-good asset set; do not leave a
   partially bound asset in place.
4. **Re-run backend configuration validation** against the restored registry to
   confirm no mismatches remain.
5. **Record the rollback** with the reason (mismatched issuer, unsupported
   precision, wrong network, or duplicate registration) for audit.

## Failure modes (fail closed)

- Mismatched issuer → initialization reverts.
- Unsupported precision → initialization reverts.
- Wrong network → initialization reverts.
- Duplicate asset registration → registration rejected.
- Unknown asset (no registry entry) → initialization reverts.
