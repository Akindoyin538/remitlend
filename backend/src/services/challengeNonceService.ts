import crypto from 'crypto';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { challengeNonceCounter } from '../middleware/metrics.js';
import { query } from '../db/connection.js';
import logger from '../utils/logger.js';
import { generateChallenge, type ChallengeMessage } from './authService.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const EXPIRED_ROW_CLEANUP_BATCH_SIZE = 500;
const CHALLENGE_MESSAGE_PATTERN =
  /^Sign this message to authenticate with RemitLend\.\n\nNonce: ([a-f0-9]{64})\nTimestamp: (\d{13})\n\nThis request will expire in 5 minutes\.$/;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function recordOutcome(outcome: string): void {
  challengeNonceCounter.inc({ outcome });
}

function recordDependencyFailure(operation: 'issue' | 'consume', error: unknown): void {
  recordOutcome('dependency_error');
  logger.error('Authentication challenge persistence failed', {
    event: 'auth.challenge_nonce.dependency_failure',
    operation,
    error: error instanceof Error ? error.message : 'Unknown database error',
  });
}

export async function issueChallenge(publicKey: string): Promise<ChallengeMessage> {
  const challenge = generateChallenge(publicKey);
  const nonceHash = sha256(challenge.nonce);
  const messageHash = sha256(challenge.message);
  const expiresAt = new Date(challenge.timestamp + CHALLENGE_TTL_MS);

  try {
    await query(
      `DELETE FROM auth_challenge_nonces
       WHERE ctid IN (
         SELECT ctid
         FROM auth_challenge_nonces
         WHERE expires_at <= NOW()
         ORDER BY expires_at
         LIMIT $1
       )`,
      [EXPIRED_ROW_CLEANUP_BATCH_SIZE],
    );
    const inserted = await query(
      `INSERT INTO auth_challenge_nonces
         (nonce_hash, message_hash, public_key, issued_at_ms, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [nonceHash, messageHash, publicKey, challenge.timestamp, expiresAt],
    );

    if (inserted.rowCount !== 1) {
      throw new Error('Challenge nonce was not persisted');
    }

    recordOutcome('issued');
    logger.info('Authentication challenge issued', {
      event: 'auth.challenge_nonce.issued',
    });
    return challenge;
  } catch (error) {
    recordDependencyFailure('issue', error);
    throw AppError.serviceUnavailable(
      'Authentication challenge service is temporarily unavailable',
      ErrorCode.SERVICE_UNAVAILABLE,
    );
  }
}

export async function consumeChallenge(publicKey: string, message: string): Promise<boolean> {
  const match = CHALLENGE_MESSAGE_PATTERN.exec(message);
  if (!match) {
    recordOutcome('rejected');
    return false;
  }

  const [, nonce, issuedAtMs] = match;

  try {
    const consumed = await query(
      `UPDATE auth_challenge_nonces
       SET consumed_at = NOW()
       WHERE nonce_hash = $1
         AND message_hash = $2
         AND public_key = $3
         AND issued_at_ms = $4
         AND expires_at > NOW()
         AND consumed_at IS NULL
       RETURNING nonce_hash`,
      [sha256(nonce!), sha256(message), publicKey, Number(issuedAtMs)],
    );

    if (consumed.rowCount === 1) {
      recordOutcome('consumed');
      logger.info('Authentication challenge consumed', {
        event: 'auth.challenge_nonce.consumed',
      });
      return true;
    }

    recordOutcome('rejected');
    logger.warn('Authentication challenge rejected', {
      event: 'auth.challenge_nonce.rejected',
      reason: 'replay_or_unissued_challenge',
    });
    return false;
  } catch (error) {
    recordDependencyFailure('consume', error);
    throw AppError.serviceUnavailable(
      'Authentication challenge service is temporarily unavailable',
      ErrorCode.SERVICE_UNAVAILABLE,
    );
  }
}
