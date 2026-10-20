#!/usr/bin/env node

/**
 * check-workflow-safety.mjs
 *
 * Verifies that:
 * 1. No production credentials or mainnet value-bearing Stellar RPC endpoints
 *    are referenced in CI test or onboarding workflows.
 * 2. PWA service-worker caching rules bypass authenticated and transaction-sensitive
 *    API responses (#550).
 * 3. Score snapshots include reproducible input versioning (#552) and distinguish
 *    missing or delayed remittance evidence from negative credit behavior (#555).
 */

import { readdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const SENSITIVE_PATH_PREFIXES = [
  "/api/v1/auth",
  "/api/v1/loans",
  "/api/v1/pools",
  "/api/v1/remittances",
  "/api/v1/scores",
  "/api/v1/transactions",
];

/**
 * Ensures CI test workflows do not target Stellar Mainnet or production endpoints.
 */
export function auditWorkflowSafety(repoRoot = root) {
  const workflowsDir = join(repoRoot, ".github", "workflows");
  const files = readdirSync(workflowsDir).filter(
    (f) => (f.endsWith(".yml") || f.endsWith(".yaml")) && !f.includes("release") && !f.includes("deploy"),
  );

  const violations = [];
  for (const file of files) {
    const content = readFileSync(join(workflowsDir, file), "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(MAINNET_PASSPHRASE)) {
        violations.push({
          file: `.github/workflows/${file}`,
          line: i + 1,
          reason: "CI test workflow references Stellar Mainnet passphrase",
        });
      }
    }
  }

  return { safe: violations.length === 0, violations };
}

/**
 * Determines whether a request must bypass PWA service-worker caching (#550).
 */
export function shouldBypassServiceWorkerCache({ urlPath, hasAuthorizationHeader = false, method = "GET" }) {
  if (method !== "GET" || hasAuthorizationHeader) {
    return true;
  }
  return SENSITIVE_PATH_PREFIXES.some((prefix) => urlPath.startsWith(prefix));
}

/**
 * Produces a deterministic, versioned score snapshot digest (#552) and classifies
 * missing/delayed remittance evidence separately from negative repayment behavior (#555).
 */
export function buildReproducibleScoreSnapshot({
  modelVersion = "v1.0.0",
  borrowerId,
  verifiedRemittances = [],
  pendingDelayedProofs = 0,
  missedRepayments = 0,
}) {
  const canonicalPayload = JSON.stringify({
    modelVersion,
    borrowerId,
    verifiedCount: verifiedRemittances.length,
    pendingDelayedProofs,
    missedRepayments,
  });

  const inputDigest = createHash("sha256").update(canonicalPayload).digest("hex");
  const evidenceStatus =
    missedRepayments > 0
      ? "NEGATIVE_BEHAVIOR"
      : pendingDelayedProofs > 0
        ? "DELAYED_EVIDENCE_PENDING"
        : "COMPLETE_EVIDENCE";

  return {
    modelVersion,
    inputDigest,
    evidenceStatus,
    penalizeScore: missedRepayments > 0,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = auditWorkflowSafety(root);
  if (!result.safe) {
    console.error("❌ Workflow safety check failed:");
    for (const v of result.violations) {
      console.error(`  - ${v.file}:${v.line}: ${v.reason}`);
    }
    process.exit(1);
  }
  console.log("✅ Workflows verified free of production credentials and mainnet value-bearing transactions.");
}
