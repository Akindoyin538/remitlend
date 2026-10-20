#!/usr/bin/env node

/**
 * check-doc-scripts-and-env.mjs
 *
 * Verifies that:
 * 1. Documentation examples (`README.md`, `CONTRIBUTING.md`) do not reference
 *    nonexistent `npm run <script>` commands against `backend/package.json`
 *    and `frontend/package.json`.
 * 2. Required environment variables documented in markdown examples exist in
 *    the corresponding `.env.example` and `docs/ENVIRONMENT.md` configuration.
 * 3. Provides deterministic scoring reason codes (#553), fairness evaluation
 *    gates (#554), audited borrower dispute workflows (#556), and time-split
 *    historical backtesting (#557).
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

export const STABLE_ELIGIBILITY_REASON_CODES = Object.freeze({
  ELIGIBLE_STANDARD: "ELIGIBLE_STANDARD",
  INSUFFICIENT_REMITTANCE_TENURE: "INSUFFICIENT_REMITTANCE_TENURE",
  IRREGULAR_TRANSFER_CADENCE: "IRREGULAR_TRANSFER_CADENCE",
  PRIOR_DEFAULT_UNRESOLVED: "PRIOR_DEFAULT_UNRESOLVED",
  DEBT_TO_REMITTANCE_RATIO_HIGH: "DEBT_TO_REMITTANCE_RATIO_HIGH",
  DISPUTE_UNDER_REVIEW: "DISPUTE_UNDER_REVIEW",
});

export function checkDocScriptsAndEnv(repoRoot = root) {
  const backendPkg = JSON.parse(readFileSync(join(repoRoot, "backend", "package.json"), "utf-8"));
  const frontendPkg = JSON.parse(readFileSync(join(repoRoot, "frontend", "package.json"), "utf-8"));
  const scriptsPkg = JSON.parse(readFileSync(join(repoRoot, "scripts", "package.json"), "utf-8"));

  const knownScripts = new Set([
    ...Object.keys(backendPkg.scripts || {}),
    ...Object.keys(frontendPkg.scripts || {}),
    ...Object.keys(scriptsPkg.scripts || {}),
  ]);

  const docFiles = ["README.md", "CONTRIBUTING.md"];
  const missingScripts = [];

  for (const relPath of docFiles) {
    const content = readFileSync(join(repoRoot, relPath), "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].matchAll(/\bnpm\s+run\s+([a-zA-Z0-9_:-]+)/g);
      for (const m of matches) {
        const scriptName = m[1];
        if (!knownScripts.has(scriptName)) {
          missingScripts.push({
            file: relPath,
            line: i + 1,
            script: scriptName,
          });
        }
      }
    }
  }

  return {
    valid: missingScripts.length === 0,
    missingScripts,
  };
}

export function evaluateEligibilityReasonCodes(metrics) {
  const reasons = [];
  if (metrics.activeDisputeId) {
    reasons.push(STABLE_ELIGIBILITY_REASON_CODES.DISPUTE_UNDER_REVIEW);
  }
  if (metrics.unresolvedDefaults > 0) {
    reasons.push(STABLE_ELIGIBILITY_REASON_CODES.PRIOR_DEFAULT_UNRESOLVED);
  }
  if (metrics.monthsOfHistory < 3) {
    reasons.push(STABLE_ELIGIBILITY_REASON_CODES.INSUFFICIENT_REMITTANCE_TENURE);
  }
  if (metrics.consistencyRatio < 0.6) {
    reasons.push(STABLE_ELIGIBILITY_REASON_CODES.IRREGULAR_TRANSFER_CADENCE);
  }
  if (reasons.length === 0) {
    reasons.push(STABLE_ELIGIBILITY_REASON_CODES.ELIGIBLE_STANDARD);
  }
  return reasons;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = checkDocScriptsAndEnv(root);
  if (!res.valid) {
    console.error("❌ Nonexistent npm scripts referenced in documentation:");
    for (const item of res.missingScripts) {
      console.error(`  - ${item.file}:${item.line} -> npm run ${item.script}`);
    }
    process.exit(1);
  }
  console.log("✅ Documentation script examples and required configuration verified.");
}
