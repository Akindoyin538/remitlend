# Documentation Script Verification & Scoring Policy Gates

## 1. Documentation Examples & Package Configuration Check
`scripts/check-doc-scripts-and-env.mjs` scans markdown documentation (`README.md`, `CONTRIBUTING.md`) for `npm run <script>` invocations and verifies each against `backend/package.json`, `frontend/package.json`, and `scripts/package.json`, ensuring no nonexistent scripts or undocumented variables are referenced.

## 2. Stable Eligibility Reason Codes & Fairness Gates (`#553`, `#554`, `#556`, `#557`)
- **Reason Codes (`#553`)**: Every borrower eligibility decision emits stable machine-readable reason codes (`ELIGIBLE_STANDARD`, `INSUFFICIENT_REMITTANCE_TENURE`, `IRREGULAR_TRANSFER_CADENCE`, `PRIOR_DEFAULT_UNRESOLVED`, `DISPUTE_UNDER_REVIEW`).
- **Pre-Release Fairness Gates (`#554`)**: Policy updates require demographic-neutral approval parity across remittance corridors before rollout.
- **Audited Borrower Disputes (`#556`)**: Source corrections record an immutable audit trail linking original evidence, corrected remittance records, and recomputed score snapshots.
- **Time-Split Backtesting (`#557`)**: Scoring policy adjustments are evaluated against out-of-time historical windows without look-ahead leakage.
