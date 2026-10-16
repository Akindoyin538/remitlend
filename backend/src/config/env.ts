import logger from '../utils/logger.js';
import { validateEnvSchema } from './envSchema.js';

/**
 * @deprecated Use `validateEnvSchema()` from `./envSchema.ts` instead.
 *
 * This function is kept for backward compatibility. It now delegates to the
 * Zod-powered schema validator introduced in issue #413, which provides richer
 * type coercion, range checking, and structured error reporting.
 *
 * Calling `validateEnvVars()` is equivalent to calling `validateEnvSchema()`;
 * both terminate the process on any validation failure.
 */
export function validateEnvVars(): void {
  validateEnvSchema();
  logger.info('Environment variables validated successfully.');
}

/**
 * Signer backend selection for privileged Soroban transactions (issue #560).
 *
 * `local` signers hold private key material in-process and are therefore only
 * permitted outside production. `external` signers delegate signing to a
 * KMS/HSM or policy-controlled service so that no private key material is ever
 * loaded into the API process.
 */
export type SignerBackend = 'local' | 'external';

/**
 * Resolve the configured signer backend, enforcing that local/test signers can
 * never be selected under a production configuration.
 *
 * Selection is explicit: `SIGNER_BACKEND` must be set to `local` or `external`.
 * When unset, it defaults to `local` for non-production environments and
 * `external` for production. Any attempt to run a `local` signer in production
 * throws before the process can start signing.
 */
export function resolveSignerBackend(
  env: NodeJS.ProcessEnv = process.env,
): SignerBackend {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const configured = env.SIGNER_BACKEND?.trim().toLowerCase();

  if (configured && configured !== 'local' && configured !== 'external') {
    throw new Error(
      `Invalid SIGNER_BACKEND "${configured}": expected "local" or "external".`,
    );
  }

  const backend: SignerBackend =
    (configured as SignerBackend | undefined) ??
    (isProduction ? 'external' : 'local');

  if (isProduction && backend === 'local') {
    throw new Error(
      'SIGNER_BACKEND=local is not permitted in production: privileged ' +
        'signing must use an external KMS/HSM or policy-controlled signer.',
    );
  }

  return backend;
}

export { validateEnvSchema } from './envSchema.js';
export { getEnv } from './envSchema.js';
