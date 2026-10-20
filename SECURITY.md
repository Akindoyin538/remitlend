# Security Policy

For the authentication and authorization model (roles, scopes, JWT flow,
API-key namespaces, cookie attributes, and route guards) see
[docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

For what our security posture explicitly relies on — and what it deliberately
does not cover (assumptions, accepted risks, compensating controls, review
cadence) — see [docs/SECURITY-ASSUMPTIONS.md](docs/SECURITY-ASSUMPTIONS.md).

For the outbound egress allowlist — approved destination classes per service
(API, worker, webhook, telemetry, build), the production network policy that
denies unlisted destinations, the CI check that flags new outbound clients, and
the policy-drift steps for incident response — see
[docs/EGRESS-POLICY.md](docs/EGRESS-POLICY.md).


## Supported Versions

Only the current `main` branch and the last tagged release are supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| Main    | :white_check_mark: |
| Last Tag| :white_check_mark: |
| Older   | :x:                |

## Reporting a Vulnerability

We take the security of our smart contracts, backend, and frontend seriously.

**Please do not report security vulnerabilities through public GitHub issues.**

If you believe you have found a security vulnerability, please reach out to us via the [Contributor Telegram](https://t.me/+DOylgFv1jyJlNzM0) and request a private, encrypted contact channel for full disclosure. 

### What to include

*   A description of the vulnerability and its impact.
*   Steps to reproduce the vulnerability.
*   Any relevant logs or output.

### Scope

*   **In-Scope:** Smart contracts, backend, and frontend code contained in this repository.
*   **Out-of-Scope:** Third-party services, dependencies, and infrastructure not managed directly by this repository.

### Response and Disclosure

*   We aim to respond to all vulnerability reports within **5 business days**.
*   We request a **90-day disclosure window** to give us time to investigate and patch the vulnerability before it is publicly disclosed.
*   At this time, we do not offer a paid bounty program, but we appreciate and may acknowledge responsible disclosures.

## Donation and Unsolicited-Transfer Reconciliation

Contracts may receive value that was not initiated through a tracked
application flow (direct transfers, donations, or airdropped tokens). These
inflows are treated as **untrusted** until explicitly classified and
reconciled by an authorized operator.

### Authorization

*   Only accounts holding the reconciliation role (see
    [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)) may classify or
    reconcile an unsolicited transfer.
*   Unauthorized callers must fail closed with an explicit authorization
    error; no state is mutated and no funds are moved.
*   Classification and reconciliation are separate, auditable actions.

### Validation and resource bounds

*   Transfer references, amounts, and classification values are validated
    before any state change; malformed or out-of-range inputs are rejected.
*   Reconciliation is processed in bounded batches with an explicit maximum
    iteration count to prevent unbounded gas/resource consumption.
*   Amounts are derived from authoritative on-chain state, never from
    caller-supplied totals.

### Compatibility

*   Reconciliation controls are additive: no existing function signatures or
    storage layouts are changed, preserving compatibility with deployed
    contracts and persisted data.

### Observability

*   Classification and reconciliation emit structured events (actor,
    transfer reference, amount, classification, outcome) for audit and
    operational diagnostics.
*   Failure paths (authorization, validation, dependency failure) emit
    distinct structured errors to support retries and alerting.

### Threat model notes

*   An attacker may attempt to spoof a donation to influence accounting or
    inflate reported balances. Mitigation: unsolicited inflows are quarantined
    as unclassified and excluded from authoritative balances until reconciled.
*   An attacker may attempt to grief reconciliation by flooding unsolicited
    transfers. Mitigation: bounded batch sizes and iteration limits cap the
    work per reconciliation call.
*   An unauthorized caller may attempt to reclassify transfers. Mitigation:
    role-gated authorization with fail-closed behavior and audit events.
