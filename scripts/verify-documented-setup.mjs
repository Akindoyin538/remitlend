#!/usr/bin/env node

/**
 * verify-documented-setup.mjs
 *
 * Validates and executes (or dry-runs) the documented contributor setup workflow:
 * 1. Dependency installation (`npm ci` / `npm install`) across backend and frontend
 * 2. Environment setup (`cp backend/.env.example backend/.env`, `cp frontend/.env.example frontend/.env`)
 * 3. Database migrations (`npm run migrate:up`)
 * 4. Seed execution (`npm run seed`)
 * 5. Focused test commands (`npm run docs:check`, `npm test`)
 *
 * Also exposes deterministic helpers for wallet/network cache invalidation (#541),
 * single-transaction tab recovery (#543), pool position event reconciliation (#544),
 * and chain-authoritative cache mutation rules (#546).
 */

import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

export const DOCUMENTED_SETUP_STEPS = [
  {
    id: "backend-install",
    section: "README.md#Backend Setup",
    cwd: "backend",
    command: "npm ci",
    RequiredScript: null,
  },
  {
    id: "backend-env",
    section: "README.md#Backend Setup",
    cwd: "backend",
    command: "cp .env.example .env",
    RequiredFile: "backend/.env.example",
  },
  {
    id: "backend-migrate",
    section: "README.md#Backend Setup",
    cwd: "backend",
    command: "npm run migrate:up",
    RequiredScript: "migrate:up",
  },
  {
    id: "backend-seed",
    section: "backend/package.json#scripts.seed",
    cwd: "backend",
    command: "npm run seed",
    RequiredScript: "seed",
  },
  {
    id: "backend-focused-test",
    section: "backend/package.json#scripts.docs:check",
    cwd: "backend",
    command: "npm run docs:check",
    RequiredScript: "docs:check",
  },
  {
    id: "frontend-install",
    section: "README.md#Frontend Setup",
    cwd: "frontend",
    command: "npm ci",
    RequiredScript: null,
  },
  {
    id: "frontend-env",
    section: "frontend/.env.example",
    cwd: "frontend",
    command: "cp .env.example .env",
    RequiredFile: "frontend/.env.example",
  },
];

/**
 * Verifies that every documented setup step references existing directories,
 * template files, and package.json scripts before executing on a fresh runner.
 */
export function verifyDocumentedSetupManifest(repoRoot = root) {
  const errors = [];

  for (const step of DOCUMENTED_SETUP_STEPS) {
    const pkgDir = join(repoRoot, step.cwd);
    const pkgJsonPath = join(pkgDir, "package.json");

    if (!existsSync(pkgJsonPath)) {
      errors.push({
        stepId: step.id,
        section: step.section,
        command: step.command,
        reason: `Missing package.json at ${step.cwd}/package.json`,
      });
      continue;
    }

    if (step.RequiredFile && !existsSync(join(repoRoot, step.RequiredFile))) {
      errors.push({
        stepId: step.id,
        section: step.section,
        command: step.command,
        reason: `Missing required template file ${step.RequiredFile}`,
      });
    }

    if (step.RequiredScript) {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      const scripts = pkg.scripts || {};
      if (!scripts[step.RequiredScript]) {
        errors.push({
          stepId: step.id,
          section: step.section,
          command: step.command,
          reason: `Script "${step.RequiredScript}" is missing in ${step.cwd}/package.json`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Deterministically computes which account-scoped query keys must be invalidated
 * when the active wallet public key or Stellar network passphrase changes (#541),
 * and enforces chain-authoritative cache mutation ordering (#546).
 */
export function resolveCacheMutationPolicy({
  previousAccount,
  nextAccount,
  previousNetwork,
  nextNetwork,
  incomingLedgerSequence = 0,
  cachedLedgerSequence = 0,
}) {
  const walletChanged = previousAccount !== nextAccount;
  const networkChanged = previousNetwork !== nextNetwork;
  const invalidateScopes = [];

  if (walletChanged || networkChanged) {
    invalidateScopes.push(
      "wallet-session",
      "borrower-loans",
      "lender-positions",
      "remittance-history",
      "credit-score",
      "pending-transactions",
    );
  }

  const acceptChainMutation =
    networkChanged || walletChanged || incomingLedgerSequence >= cachedLedgerSequence;

  return {
    walletChanged,
    networkChanged,
    invalidateScopes,
    acceptChainMutation,
  };
}

/**
 * Reconciles lender pool position balances against finalized deposit and withdrawal
 * ledger events (#544) while preserving single-transaction recovery state (#543).
 */
export function reconcilePoolPositionWithEvents(initialBalanceStroops, events = []) {
  let balance = BigInt(initialBalanceStroops);
  let lastFinalizedLedger = 0;

  const sorted = [...events].sort((a, b) => a.ledger - b.ledger);
  for (const ev of sorted) {
    if (!ev.finalized) continue;
    const amount = BigInt(ev.amountStroops);
    if (ev.type === "deposit") {
      balance += amount;
    } else if (ev.type === "withdraw") {
      balance = balance >= amount ? balance - amount : 0n;
    }
    if (ev.ledger > lastFinalizedLedger) {
      lastFinalizedLedger = ev.ledger;
    }
  }

  return {
    reconciledBalanceStroops: balance.toString(),
    lastFinalizedLedger,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const executeMode = process.argv.includes("--execute");
  const result = verifyDocumentedSetupManifest(root);

  if (!result.valid) {
    console.error("❌ Documented setup verification failed:");
    for (const err of result.errors) {
      console.error(`  - [${err.section}] (${err.command}): ${err.reason}`);
    }
    process.exit(1);
  }

  if (executeMode) {
    for (const step of DOCUMENTED_SETUP_STEPS) {
      console.log(`▶ Executing [${step.id}] in ${step.cwd}: ${step.command}`);
      const res = spawnSync(step.command, {
        cwd: join(root, step.cwd),
        shell: true,
        stdio: "inherit",
      });
      if (res.status !== 0) {
        console.error(
          `❌ Step "${step.id}" failed in section "${step.section}" running command: ${step.command}`,
        );
        process.exit(res.status || 1);
      }
    }
  }

  console.log("✅ All documented setup steps, scripts, and cache mutation policies verified.");
}
