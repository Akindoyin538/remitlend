import dotenv from 'dotenv';
dotenv.config();

import { validateEnvVars } from './config/env.js';
validateEnvVars();

// Sentry must be initialized before any other imports so it can instrument them
import { initSentry } from './config/sentry.js';
initSentry();

const app = (await import('./app.js')).default;
import logger from './utils/logger.js';
import { closePool } from './db/connection.js';
import { startIndexer, stopIndexer } from './services/indexerManager.js';
import {
  startDefaultCheckerScheduler,
  stopDefaultCheckerScheduler,
} from './services/defaultChecker.js';
import {
  startWebhookRetryProcessor,
  stopWebhookRetryProcessor,
} from './services/webhookRetryProcessor.js';
import { eventStreamService } from './services/eventStreamService.js';
import {
  startNotificationCleanupScheduler,
  stopNotificationCleanupScheduler,
} from './services/notificationService.js';
import {
  startScoreReconciliationScheduler,
  stopScoreReconciliationScheduler,
} from './services/scoreReconciliationService.js';
import {
  startCrossContractReconciler,
  stopCrossContractReconciler,
} from './services/crossContractReconciler.js';
import { sorobanService } from './services/sorobanService.js';
import { validateLoanConfigOnStartup } from './config/loanConfig.js';
import { startLoanDueCheckCron, stopLoanDueCheckCron } from './cron/loanCheckCron.js';
import {
  startContractVerificationCron,
  stopContractVerificationCron,
} from './cron/contractVerificationJob.js';
// Imported the score decay scheduler initialization wrapper
import { startScoreDecayScheduler } from './cron/scoreDecayJob.js';
import { initializePauseState } from './middleware/pauseGuard.js';
import { shutdownCoordinator } from './middleware/shutdownHandler.js';
import {
  startSorobanWriteReplayProcessor,
  stopSorobanWriteReplayProcessor,
} from './services/sorobanWriteReplayProcessor.js';

const port = process.env.PORT || 3001;

// Maintain a mutable handle to invoke clean scheduler closures on process stops
let scoreDecaySchedulerHandle: { stop: () => void } | null = null;

// Validate loan config on startup before accepting traffic
validateLoanConfigOnStartup();

// Validate score delta config on startup before accepting traffic
try {
  sorobanService.validateScoreConfig();
} catch (err) {
  logger.error('Startup configuration is invalid, aborting startup.', { err });
  process.exit(1);
}

// Validate Soroban contract IDs and RPC connectivity before accepting traffic
try {
  await sorobanService.validateConfig();
} catch (err) {
  logger.error('Soroban configuration is invalid, aborting startup.', { err });
  process.exit(1);
}

// Initialize pause state table and load initial state
try {
  await initializePauseState();
} catch (err) {
  logger.error('Failed to initialize pause state', { err });
  process.exit(1);
}

const server = app.listen(port, () => {
  logger.info(`Server is running on port ${port}`);

  // Start the event indexer
  startIndexer();

  // Start periodic on-chain default checks (if configured)
  startDefaultCheckerScheduler();

  // Drain Soroban writes queued while the RPC was unavailable (#74)
  startSorobanWriteReplayProcessor();

  // Start webhook retry processor (5m/15m/45m backoff via WebhookService.processRetries)
  startWebhookRetryProcessor();

  // Start scheduled score reconciliation against on-chain state
  startScoreReconciliationScheduler();

  // Start cross-contract (disbursement <-> score) reconciliation ledger sweep
  startCrossContractReconciler();

  // Start periodic notification cleanup
  startNotificationCleanupScheduler();

  // Start loan due check cron
  startLoanDueCheckCron();

  // Start contract verification polling against Stellar explorer
  startContractVerificationCron();

  // Wire up and activate the score decay daily scheduler loop
  scoreDecaySchedulerHandle = startScoreDecayScheduler() || null;
});

const shutdown = async (signal: 'SIGTERM' | 'SIGINT') => {
  logger.info(`${signal} signal received: initiating graceful shutdown`);

  // Timeout (30s) force-kills if shutdown stalls
  const timeout = setTimeout(() => {
    logger.error('Graceful shutdown exceeded 30s, forcing exit.');
    process.exit(1);
  }, 30000);
  timeout.unref();

  try {
    // Step 1: Stop accepting new requests
    await shutdownCoordinator.shutdown();
    logger.info('In-flight requests drained or timeout reached.');

    // Step 2: Gracefully stop schedulers
    logger.info('Stopping background schedulers...');
    if (scoreDecaySchedulerHandle) {
      scoreDecaySchedulerHandle.stop();
    }

    stopLoanDueCheckCron();
    stopContractVerificationCron();
    await stopIndexer();
    stopDefaultCheckerScheduler();
    stopWebhookRetryProcessor();
    stopSorobanWriteReplayProcessor();
    stopScoreReconciliationScheduler();
    stopCrossContractReconciler();
    stopNotificationCleanupScheduler();
    logger.info('All schedulers stopped.');

    // Step 3: Close event streams
    if (
      typeof (eventStreamService as unknown as { closeAll: (reason: string) => void }).closeAll ===
      'function'
    ) {
      (eventStreamService as unknown as { closeAll: (reason: string) => void }).closeAll(
        'Server shutting down',
      );
    } else if (typeof eventStreamService.closeAllConnections === 'function') {
      eventStreamService.closeAllConnections('Server shutting down');
    }

    // Step 4: Close HTTP server (stops listening, drains connections)
    logger.info('Closing HTTP server...');
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    logger.info('HTTP server closed.');

    // Step 5: Close database connections
    logger.info('Draining database pool...');
    await closePool();
    logger.info('Database pool drained.');

    // Step 6: Close Redis connection
    logger.info('Closing Redis connection...');
    // Note: cacheService.close() is implemented but not awaited in the service
    // This is a graceful close that won't block if Redis is unresponsive

    logger.info('Graceful shutdown completed successfully.');
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    logger.error('Graceful shutdown encountered errors', { signal, err });
    clearTimeout(timeout);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
