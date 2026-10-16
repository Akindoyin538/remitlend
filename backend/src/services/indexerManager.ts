import { EventIndexer } from './eventIndexer.js';
import { type AdaptiveSchedulerState } from './adaptiveScheduler.js';
import logger from '../utils/logger.js';
import { getStellarRpcUrl } from '../config/stellar.js';

let indexerInstance: EventIndexer | null = null;

/**
 * Initialize and start the event indexer
 */
export const startIndexer = (): void => {
  if (indexerInstance) {
    logger.withContext().warn('Indexer already running');
    return;
  }

  const contractEnvMap: Record<string, string | undefined> = {
    LOAN_MANAGER_CONTRACT_ID: process.env.LOAN_MANAGER_CONTRACT_ID,
    LENDING_POOL_CONTRACT_ID: process.env.LENDING_POOL_CONTRACT_ID,
    REMITTANCE_NFT_CONTRACT_ID: process.env.REMITTANCE_NFT_CONTRACT_ID,
    MULTISIG_GOVERNANCE_CONTRACT_ID: process.env.MULTISIG_GOVERNANCE_CONTRACT_ID,
  };

  for (const [envVar, value] of Object.entries(contractEnvMap)) {
    if (!value || value.trim().length === 0) {
      logger.warn(`${envVar} is not set — events for that contract will not be indexed`);
    }
  }

  const contractIds = Object.values(contractEnvMap).filter((id): id is string =>
    Boolean(id && id.trim().length > 0),
  );
  const pollIntervalMs = parseInt(process.env.INDEXER_POLL_INTERVAL_MS || '30000');
  const batchSize = parseInt(process.env.INDEXER_BATCH_SIZE || '100');

  // Read INDEXER_ADAPTIVE_SCHEDULING from environment. Accepts "true" / "1"
  // (case-insensitive). Defaults to false for backward compatibility.
  const rawAdaptive = (process.env.INDEXER_ADAPTIVE_SCHEDULING ?? '').trim().toLowerCase();
  const adaptiveSchedulingEnabled = rawAdaptive === 'true' || rawAdaptive === '1';

  if (contractIds.length === 0) {
    logger
      .withContext()
      .warn(
        'No contract IDs set for indexer. Set LOAN_MANAGER_CONTRACT_ID, LENDING_POOL_CONTRACT_ID, REMITTANCE_NFT_CONTRACT_ID, or MULTISIG_GOVERNANCE_CONTRACT_ID.',
      );
    return;
  }

  const rpcUrl = getStellarRpcUrl();

  indexerInstance = new EventIndexer({
    rpcUrl,
    contractConfigs: contractIds.map((contractId) => ({ contractId })),
    pollIntervalMs,
    batchSize,
    adaptiveSchedulingEnabled,
  });

  indexerInstance
    .start()
    .then(() => {
      // Initialize the adaptive scheduler (if enabled) after the indexer has
      // performed its first successful poll so that the scheduler can observe
      // real chain activity from the very first interval adjustment.
      indexerInstance?.getAdaptiveScheduler()?.initialize();
    })
    .catch((error) => {
      logger.withContext().error('Failed to start indexer', { error });
      indexerInstance = null;
    });

  logger.withContext().info('Event indexer initialized', {
    rpcUrl,
    contractIds,
    pollIntervalMs,
    batchSize,
    adaptiveSchedulingEnabled,
  });
};

/**
 * Stop the event indexer
 */
export const stopIndexer = async (): Promise<void> => {
  if (indexerInstance) {
    await indexerInstance.stop();
    indexerInstance = null;
    logger.withContext().info('Event indexer stopped');
  }
};

/**
 * Get indexer instance (for testing)
 */
export const getIndexer = (): EventIndexer | null => {
  return indexerInstance;
};

/**
 * Return adaptive scheduler diagnostics, or `null` when adaptive scheduling
 * is disabled or the indexer has not been started yet.
 */
export const getAdaptiveSchedulerState = async (): Promise<AdaptiveSchedulerState | null> => {
  const scheduler = indexerInstance?.getAdaptiveScheduler();
  if (!scheduler) return null;
  return scheduler.getState();
};
