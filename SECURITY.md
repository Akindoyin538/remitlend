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

## Contracts: Per-Borrower Exposure Limits

Borrower exposure is bounded by an explicit, per-borrower limit enforced at the
contracts boundary. The limit is a hard cap on the total outstanding principal a
single borrower may hold across all supported assets; it is checked on every
borrow and re-checked on any operation that increases exposure.

### Authorization

*   Only the configured risk authority (owner/admin role) may set or raise a
    borrower's limit. Lowering a limit is permitted for the same authority and
    takes effect immediately for new borrows.
*   Borrowers cannot raise their own limit; attempts revert with a structured
    `ExposureLimitUnauthorized` error.

### Failure and boundary behavior

*   A borrow that would push total exposure above the borrower's limit reverts
    with `ExposureLimitExceeded(borrower, current, requested, limit)`.
*   A borrow that lands exactly on the limit succeeds; one unit above reverts.
*   Limits are stored per borrower and default to zero, so an unconfigured
    borrower cannot borrow until a limit is explicitly granted.

### Retry, migration, and rollback

*   Limit checks are pure and idempotent: a reverted borrow leaves no state
    change, so callers may safely retry after a limit adjustment.
*   Existing borrowers are migrated with a limit derived from their current
    outstanding exposure, preserving compatibility with deployed state.
*   Rollback is a limit update; no funds move and no persisted balances are
    rewritten.

### Observability

*   Every limit change emits `ExposureLimitUpdated(borrower, previous, next)`.
*   Every rejected borrow emits `ExposureLimitRejected(borrower, current, requested, limit)`
    for off-chain monitoring and alerting.

### Verification

*   Focused contract tests cover success, authorization failure, exact-boundary,
    over-boundary, retry-after-adjustment, and stale-limit paths.
*   Integration coverage exercises the full borrow workflow against the enforced
    limit.
