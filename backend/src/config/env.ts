import logger from '../utils/logger.js';
import { validateEnvSchema } from './envSchema.js';

/**
 * Known placeholder / weak secret values that must never reach production.
 * Compared case-insensitively against trimmed values.
 */
const PLACEHOLDER_SECRETS = new Set([
  'changeme',
  'change-me',
  'change_me',
  'your-secret-here',
  'your_secret_here',
  'yoursecrethere',
  'secret',
  'password',
  'test',
  'dev',
  'development',
  'default',
  'example',
  'placeholder',
  'todo',
  'xxx',
]);

/** Minimum length for production secrets (JWT signing, internal API auth). */
const MIN_SECRET_LENGTH = 32;

/**
 * Variables that carry secrets and must be strong in production.
 * These are validated for presence, placeholder rejection, and length.
 */
const REQUIRED_SECRET_VARS = ['JWT_SECRET', 'INTERNAL_API_KEY'] as const;

/**
 * Required production contract/network identifiers. These must be present and
 * non-empty before the service accepts traffic in production.
 */
const REQUIRED_PRODUCTION_VARS = [
  'CONTRACT_ID',
  'NETWORK_PASSPHRASE',
  'SOROBAN_RPC_URL',
] as const;

/**
 * Debug flags that must be disabled in production.
 */
const UNSAFE_DEBUG_VARS = ['DEBUG', 'DEBUG_ERRORS', 'EXPOSE_STACK_TRACES'] as const;

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (PLACEHOLDER_SECRETS.has(normalized)) {
    return true;
  }
  // Reject values that merely embed a known placeholder token.
  for (const token of PLACEHOLDER_SECRETS) {
    if (normalized.includes(token)) {
      return true;
    }
  }
  return false;
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Validate production environment safety. Throws an Error naming the offending
 * variable and remediation guidance WITHOUT echoing secret values.
 *
 * This is a no-op outside production so local development defaults keep working.
 */
export function validateProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProduction(env)) {
    return;
  }

  const errors: string[] = [];

  for (const name of REQUIRED_SECRET_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      errors.push(
        `${name} is required in production. Set a strong, randomly generated value (>= ${MIN_SECRET_LENGTH} chars).`,
      );
      continue;
    }
    if (isPlaceholder(raw)) {
      errors.push(
        `${name} appears to be a placeholder value. Replace it with a strong, randomly generated secret (>= ${MIN_SECRET_LENGTH} chars).`,
      );
      continue;
    }
    if (raw.trim().length < MIN_SECRET_LENGTH) {
      errors.push(
        `${name} is too short for production. Use a randomly generated secret of at least ${MIN_SECRET_LENGTH} characters.`,
      );
    }
  }

  for (const name of REQUIRED_PRODUCTION_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      errors.push(
        `${name} is required in production. Provide the production contract/network identifier before rollout.`,
      );
    }
  }

  for (const name of UNSAFE_DEBUG_VARS) {
    if (isTruthy(env[name])) {
      errors.push(
        `${name} must be disabled in production. Unset it or set it to "false" to avoid leaking debug details.`,
      );
    }
  }

  const rpcUrl = env.SOROBAN_RPC_URL;
  if (rpcUrl !== undefined && rpcUrl.trim() !== '' && !/^https:\/\//i.test(rpcUrl.trim())) {
    errors.push(
      'SOROBAN_RPC_URL must use HTTPS in production. Update it to an https:// endpoint.',
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Production environment validation failed:\n- ${errors.join('\n- ')}`,
    );
  }
}

/**
 * @deprecated Use `validateEnvSchema()` from `./envSchema.ts` instead.
 *
 * This function is kept for backward compatibility. It now delegates to the
 * Zod-powered schema validator introduced in issue #413, which provides richer
 * type coercion, range checking, and structured error reporting.
 *
 * Calling `validateEnvVars()` is equivalent to calling `validateEnvSchema()`;
 * both terminate the process on any validation failure. In production it also
 * enforces the safety checks from issue #561 before accepting traffic.
 */
export function validateEnvVars(): void {
  validateEnvSchema();
  validateProductionEnv();
  logger.info('Environment variables validated successfully.');
}

export { validateEnvSchema } from './envSchema.js';
export { getEnv } from './envSchema.js';
