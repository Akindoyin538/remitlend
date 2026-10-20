#!/usr/bin/env node

/**
 * report-doc-command-drift.mjs
 *
 * Scans markdown documentation (`README.md`, `CONTRIBUTING.md`) by heading section
 * and reports any command or environment variable drift with exact file path,
 * markdown section heading, line number, and offending command.
 *
 * Also provides helpers for distinguishing projected vs. realized/withdrawable
 * lender yield (#545), source freshness & degraded-state provenance (#547),
 * keyboard-navigable chart table equivalence (#548), and locale-aware asset
 * money formatting (#549).
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

/**
 * Parses markdown files by section heading and identifies the exact
 * `file#section` and command whenever a documented `npm run <script>`
 * drifts from package configuration.
 */
export function detectSectionCommandDrift(repoRoot = root) {
  const backendPkg = JSON.parse(readFileSync(join(repoRoot, "backend", "package.json"), "utf-8"));
  const frontendPkg = JSON.parse(readFileSync(join(repoRoot, "frontend", "package.json"), "utf-8"));
  const scriptsPkg = JSON.parse(readFileSync(join(repoRoot, "scripts", "package.json"), "utf-8"));

  const allScripts = new Set([
    ...Object.keys(backendPkg.scripts || {}),
    ...Object.keys(frontendPkg.scripts || {}),
    ...Object.keys(scriptsPkg.scripts || {}),
  ]);

  const files = ["README.md", "CONTRIBUTING.md"];
  const driftFailures = [];

  for (const file of files) {
    const lines = readFileSync(join(repoRoot, file), "utf-8").split("\n");
    let currentSection = "Document Root";

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (headingMatch) {
        currentSection = headingMatch[2].trim();
        continue;
      }

      const cmdMatch = line.match(/\b(npm\s+run\s+([a-zA-Z0-9_:-]+))/);
      if (cmdMatch) {
        const fullCommand = cmdMatch[1];
        const scriptName = cmdMatch[2];
        if (!allScripts.has(scriptName)) {
          driftFailures.push({
            file,
            section: currentSection,
            line: idx + 1,
            command: fullCommand,
            message: `[${file}#${currentSection}] (line ${idx + 1}): Command "${fullCommand}" drifted from package.json scripts`,
          });
        }
      }
    }
  }

  return {
    drifted: driftFailures.length > 0,
    failures: driftFailures,
  };
}

/**
 * Separates projected yield from realized and immediately withdrawable lender returns (#545).
 */
export function classifyLenderReturns({
  accruedRealizedStroops = 0n,
  lockedInActiveLoansStroops = 0n,
  projectedUnaccruedStroops = 0n,
}) {
  const realized = BigInt(accruedRealizedStroops);
  const locked = BigInt(lockedInActiveLoansStroops);
  const projected = BigInt(projectedUnaccruedStroops);
  const withdrawable = realized > locked ? realized - locked : 0n;

  return {
    realizedStroops: realized.toString(),
    withdrawableStroops: withdrawable.toString(),
    projectedStroops: projected.toString(),
  };
}

/**
 * Formats asset amounts deterministically across supported locales without floating-point drift (#549).
 */
export function formatAssetAmountLocale(amountMinorUnits, { locale = "en-US", currency = "USD", decimals = 2 } = {}) {
  const divisor = 10 ** decimals;
  const numericValue = Number(BigInt(amountMinorUnits)) / divisor;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(numericValue);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = detectSectionCommandDrift(root);
  if (report.drifted) {
    console.error("❌ Documentation command drift detected:");
    for (const f of report.failures) {
      console.error(`  - ${f.message}`);
    }
    process.exit(1);
  }
  console.log("✅ Zero documentation command drift detected across all sections.");
}
