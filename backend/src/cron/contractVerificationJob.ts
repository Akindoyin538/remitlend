import cron from 'node-cron';
import { contractVerificationService } from '../services/contractVerificationService.js';
import { jobMetricsService } from '../services/jobMetricsService.js';
import logger from '../utils/logger.js';

const BATCH_SIZE = 10;

let scheduledTask: cron.ScheduledTask | null = null;
let inFlight = false;

/**
 * Polls Stellar explorer for unverified contracts and records each attempt.
 * Runs every hour at minute 30 to avoid colliding with the loan due check.
 */
export function startContractVerificationCron() {
  if (scheduledTask) return;

  scheduledTask = cron.schedule('30 * * * *', async () => {
    if (inFlight) {
      logger
        .withContext()
        .warn('Contract verification cron skipped because a previous run is still in flight');
      return;
    }

    const startTime = Date.now();
    const jobName = 'contractVerificationCron';
    inFlight = true;

    try {
      const pending = await contractVerificationService.getUnverifiedContracts(BATCH_SIZE);
      let verifiedCount = 0;

      for (const contract of pending) {
        try {
          const verified = await contractVerificationService.checkStellarExplorerVerification(
            contract.contractId,
          );

          if (verified) {
            await contractVerificationService.markVerified(
              contract.contractId,
              contract.sourceCodeHash,
            );
            verifiedCount++;
          }

          await contractVerificationService.recordVerificationAttempt(
            contract.contractId,
            verified,
            verified ? 'Verified on Stellar explorer' : 'Not yet verified on Stellar explorer',
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await contractVerificationService.recordVerificationAttempt(
            contract.contractId,
            false,
            message,
          );
        }
      }

      const durationMs = Date.now() - startTime;
      jobMetricsService.recordSuccess(jobName, durationMs);
      logger
        .withContext()
        .info(
          `Contract verification check completed. Checked ${pending.length}, newly verified ${verifiedCount}.`,
        );
    } catch (error) {
      const durationMs = Date.now() - startTime;
      jobMetricsService.recordFailure(jobName, error as Error | string, durationMs);
      logger.withContext().error('Error in contract verification cron', { error });
    } finally {
      inFlight = false;
    }
  });
}

export function stopContractVerificationCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.withContext().info('Contract verification cron stopped');
  }
}
