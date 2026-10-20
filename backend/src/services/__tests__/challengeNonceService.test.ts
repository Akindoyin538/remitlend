import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Keypair } from '@stellar/stellar-sdk';

type ChallengeRow = {
  messageHash: string;
  publicKey: string;
  issuedAtMs: number;
  expiresAt: number;
  consumed: boolean;
};

const challenges = new Map<string, ChallengeRow>();
const handleQuery = async (sql: string, params: unknown[] = []) => {
  if (sql.includes('INSERT INTO auth_challenge_nonces')) {
    const [nonceHash, messageHash, publicKey, issuedAtMs, expiresAt] = params as [
      string,
      string,
      string,
      number,
      Date,
    ];
    challenges.set(nonceHash, {
      messageHash,
      publicKey,
      issuedAtMs,
      expiresAt: expiresAt.getTime(),
      consumed: false,
    });
    return { rows: [], rowCount: 1 };
  }

  if (sql.includes('UPDATE auth_challenge_nonces')) {
    const [nonceHash, messageHash, publicKey, issuedAtMs] = params as [
      string,
      string,
      string,
      number,
    ];
    const challenge = challenges.get(nonceHash);
    if (
      challenge &&
      challenge.messageHash === messageHash &&
      challenge.publicKey === publicKey &&
      challenge.issuedAtMs === issuedAtMs &&
      challenge.expiresAt > Date.now() &&
      !challenge.consumed
    ) {
      challenge.consumed = true;
      return { rows: [{ nonce_hash: nonceHash }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { rows: [], rowCount: 0 };
};
const queryMock = jest.fn(handleQuery);

jest.unstable_mockModule('../../db/connection.js', () => ({ query: queryMock }));
jest.unstable_mockModule('../../middleware/metrics.js', () => ({
  challengeNonceCounter: { inc: jest.fn() },
}));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { consumeChallenge, issueChallenge } = await import('../challengeNonceService.js');

describe('challengeNonceService', () => {
  beforeEach(() => {
    challenges.clear();
    queryMock.mockClear();
    queryMock.mockImplementation(handleQuery);
  });

  it('persists a fresh challenge and consumes it only once for the issuing wallet', async () => {
    const keypair = Keypair.random();
    const challenge = await issueChallenge(keypair.publicKey());

    expect(queryMock.mock.calls[0]?.[0]).toContain('LIMIT $1');
    expect(queryMock.mock.calls[0]?.[1]).toEqual([500]);
    expect(queryMock.mock.calls[1]?.[1]).not.toContain(challenge.nonce);
    expect(challenge.message).toContain(challenge.nonce);
    expect(await consumeChallenge(keypair.publicKey(), challenge.message)).toBe(true);
    expect(await consumeChallenge(keypair.publicKey(), challenge.message)).toBe(false);
  });

  it('rejects a challenge for a different wallet or altered message', async () => {
    const keypair = Keypair.random();
    const challenge = await issueChallenge(keypair.publicKey());

    expect(await consumeChallenge(Keypair.random().publicKey(), challenge.message)).toBe(false);
    expect(await consumeChallenge(keypair.publicKey(), `${challenge.message}!`)).toBe(false);
  });

  it('rejects an expired persisted challenge', async () => {
    const keypair = Keypair.random();
    const challenge = await issueChallenge(keypair.publicKey());
    const issuedAt = challenge.timestamp;

    jest.useFakeTimers();
    jest.setSystemTime(issuedAt + challenge.expiresIn + 1);
    try {
      expect(await consumeChallenge(keypair.publicKey(), challenge.message)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts the final millisecond before expiry and rejects at expiry', async () => {
    const keypair = Keypair.random();
    const freshChallenge = await issueChallenge(keypair.publicKey());

    jest.useFakeTimers();
    jest.setSystemTime(freshChallenge.timestamp + freshChallenge.expiresIn - 1);
    try {
      expect(await consumeChallenge(keypair.publicKey(), freshChallenge.message)).toBe(true);

      const boundaryChallenge = await issueChallenge(keypair.publicKey());
      jest.setSystemTime(boundaryChallenge.timestamp + boundaryChallenge.expiresIn);
      expect(await consumeChallenge(keypair.publicKey(), boundaryChallenge.message)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('allows only one of two concurrent consumers to redeem the challenge', async () => {
    const keypair = Keypair.random();
    const challenge = await issueChallenge(keypair.publicKey());

    const results = await Promise.all([
      consumeChallenge(keypair.publicKey(), challenge.message),
      consumeChallenge(keypair.publicKey(), challenge.message),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('fails closed with a service-unavailable error when persistence is unavailable', async () => {
    queryMock.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(issueChallenge(Keypair.random().publicKey())).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'SERVICE_UNAVAILABLE',
    });
  });

  it('fails closed when challenge consumption cannot reach the database', async () => {
    const keypair = Keypair.random();
    const challenge = await issueChallenge(keypair.publicKey());
    queryMock.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(consumeChallenge(keypair.publicKey(), challenge.message)).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'SERVICE_UNAVAILABLE',
    });
  });
});
