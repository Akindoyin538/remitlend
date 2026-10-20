# Section-Aware Drift Diagnostics & Lender Financial Provenance

## 1. File, Section, and Command Drift Reporting
`scripts/report-doc-command-drift.mjs` tracks markdown headings while scanning `README.md` and `CONTRIBUTING.md`. When any command drifts from `package.json` configuration, the failure output identifies:
- **File**: e.g., `README.md` or `CONTRIBUTING.md`
- **Section**: The enclosing Markdown heading (`#section`)
- **Line & Command**: Exact line number and the command string that drifted.

## 2. Lender Yield Separation, Freshness Provenance & Accessible Analytics (`#545`, `#547`, `#548`, `#549`)
- **Yield Classification (`#545`)**: Lender views separate `realizedStroops`, `withdrawableStroops` (liquid pool reserves), and `projectedStroops` (unaccrued future interest).
- **Source Freshness & Degraded Provenance (`#547`)**: Financial surfaces display ledger/timestamp freshness and explicitly badge cached fallback states during RPC degradation.
- **Keyboard-Navigable Analytics (`#548`)**: Lender charts expose arrow-key datum traversal and a synchronized accessible data table.
- **Locale-Aware Asset Formatting (`#549`)**: Integer minor-unit formatting preserves precision across all supported locales (`en`, `es`, `tl`).
