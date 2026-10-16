# Security Policy

For the authentication and authorization model (roles, scopes, JWT flow,
API-key namespaces, cookie attributes, and route guards) see
[docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

For what our security posture explicitly relies on — and what it deliberately
does not cover (assumptions, accepted risks, compensating controls, review
cadence) — see [docs/SECURITY-ASSUMPTIONS.md](docs/SECURITY-ASSUMPTIONS.md).


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

## Dependency Vulnerability Exceptions

Automated dependency scans may surface advisories we choose to accept rather
than fix immediately. An accepted risk without an owner, rationale, and expiry
becomes a permanent blind spot, so every exception is tracked in a
machine-readable register and expires by default.

### Exception register

The register lives at [`security/dependency-exceptions.json`](security/dependency-exceptions.json)
and is the single source of truth consumed by the dependency and supply-chain
workflows. Each entry is keyed by package and advisory and must include:

| Field                 | Required | Description |
| --------------------- | -------- | ----------- |
| `package`             | yes      | Affected package name (including transitive packages). |
| `advisory`            | yes      | Advisory identifier (e.g. `GHSA-xxxx-xxxx-xxxx` or `CVE-YYYY-NNNNN`). |
| `affectedVersion`     | yes      | Version range or resolved version the exception applies to. |
| `compensatingControl` | yes      | Control that reduces the risk while the exception is open. |
| `owner`               | yes      | Accountable individual or team. Unowned entries fail the gate. |
| `rationale`           | yes      | Risk rationale for accepting rather than fixing. |
| `remediationTarget`   | yes      | Target date or release by which the dependency is fixed or removed. |
| `expires`             | yes      | Expiration date. Must not exceed the maximum expiry window. |
| `reviewHistory`       | no       | Append-only renewal/review records. |

### Lifecycle rules

*   **New exceptions** must supply an owner, risk rationale, remediation
target, and an expiration. Entries missing any required field are rejected.
*   **Maximum expiry** is **90 days** from the date the exception is created.
An exception may not be created with an expiration beyond that window.
*   **Expired or unowned exceptions fail the security gate.** CI treats an
expired `expires` date or a missing/blank `owner` as a blocking failure.
*   **Renewals are auditable.** Renewing an exception appends a record to
`reviewHistory` with the reviewer, date, and justification; existing history
is never overwritten.

### CI behavior

Dependency and supply-chain checks read the register and the lockfile to
differentiate dependency paths:

*   **fixed** — the advisory is resolved by the locked version; no exception needed.
*   **affected** — the locked version is in range; a valid, unexpired exception is required.
*   **not-applicable** — the advisory does not apply to the resolved path.

Reports include the transitive package path for each finding and never
suppress unrelated advisories; an exception only covers the specific
package/advisory pair it names.

### Escalation and emergency exceptions

*   **Escalation:** an exception approaching expiry without a fix is escalated
to the owner and the security lead before the expiration date. Unresolved
exceptions are not silently renewed.
*   **Emergency exceptions:** when a fix is not possible before expiry, an
emergency exception may be granted with a shorter window (maximum **30 days**),
a named owner, and a documented compensating control. Emergency exceptions
follow the same register format and are reviewed at the next security review.
