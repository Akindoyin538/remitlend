import { describe, it, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { randomUUID } from 'node:crypto';

let testIpSequence = 20;
const nextTestIp = (): string => `192.0.2.${testIpSequence++}`;

const issuedChallenges = new Map<
  string,
  { messageHash: string; publicKey: string; issuedAtMs: number; expiresAt: number; consumed: boolean }
>();
const cacheStore = new Map<string, unknown>();
const databaseQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (sql.includes('INSERT INTO auth_challenge_nonces')) {
    const [nonceHash, messageHash, publicKey, issuedAtMs, expiresAt] = params as [
      string,
      string,
      string,
      number,
      Date,
    ];
    issuedChallenges.set(nonceHash, {
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
    const challenge = issuedChallenges.get(nonceHash);
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
});

jest.unstable_mockModule('../db/connection.js', () => ({
  default: {
    query: databaseQuery,
    on: jest.fn(),
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    end: jest.fn(),
  },
  pool: {
    query: databaseQuery,
    on: jest.fn(),
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    end: jest.fn(),
  },
  query: databaseQuery,
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.unstable_mockModule('../services/cacheService.js', () => ({
  cacheService: {
    get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
    }),
    delete: jest.fn(async (key: string) => {
      cacheStore.delete(key);
    }),
  },
}));

const { default: app } = await import('../app.js');

describe('Auth API', () => {
  beforeEach(() => {
    cacheStore.clear();
  });

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-key-for-jest';
    app.set('trust proxy', 1);
  });

  describe('POST /api/auth/challenge', () => {
    it('should generate a challenge for a valid public key', async () => {
      const keypair = Keypair.random();
      const idempotencyKey = randomUUID();

      const response = await request(app)
        .post('/api/auth/challenge')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', idempotencyKey)
        .send({ publicKey: keypair.publicKey() })
        .expect(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.message).toContain('Sign this message');
      expect(response.body.data.nonce).toBeDefined();
      expect(response.body.data.timestamp).toBeDefined();
      expect(response.body.data.expiresIn).toBe(5 * 60 * 1000);

      const nextChallenge = await request(app)
        .post('/api/auth/challenge')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', idempotencyKey)
        .send({ publicKey: keypair.publicKey() })
        .expect(200);

      expect(nextChallenge.body.data.nonce).not.toBe(response.body.data.nonce);
    });

    it('should reject invalid public key', async () => {
      const response = await request(app)
        .post('/api/auth/challenge')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', randomUUID())
        .send({ publicKey: 'invalid-key' })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should reject missing public key', async () => {
      const response = await request(app)
        .post('/api/auth/challenge')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login with valid signature', async () => {
      const keypair = Keypair.random();

      const challengeResponse = await request(app)
        .post('/api/auth/challenge')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', randomUUID())
        .send({ publicKey: keypair.publicKey() })
        .expect(200);

      const message = challengeResponse.body.data.message;
      const signature = keypair.sign(Buffer.from(message, 'utf-8')).toString('base64');
      const loginIdempotencyKey = randomUUID();

      const loginResponse = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', loginIdempotencyKey)
        .send({
          publicKey: keypair.publicKey(),
          message,
          signature,
        })
        .expect(200);

      expect(loginResponse.body.success).toBe(true);
      expect(loginResponse.body.data.token).toBeDefined();
      expect(loginResponse.body.data.publicKey).toBe(keypair.publicKey());

      const replayResponse = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', loginIdempotencyKey)
        .send({ publicKey: keypair.publicKey(), message, signature })
        .expect(401);

      expect(replayResponse.body.error.code).toBe('CHALLENGE_REPLAYED');
      expect(replayResponse.headers['x-failed-attempts']).toBeDefined();
    });

    it('should reject invalid signature', async () => {
      const keypair = Keypair.random();
      const differentKeypair = Keypair.random();

      const challengeResponse = await request(app)
        .post('/api/auth/challenge')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', randomUUID())
        .send({ publicKey: keypair.publicKey() })
        .expect(200);

      const message = challengeResponse.body.data.message;
      const wrongSignature = differentKeypair
        .sign(Buffer.from(message, 'utf-8'))
        .toString('base64');

      const loginResponse = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', randomUUID())
        .send({
          publicKey: keypair.publicKey(),
          message,
          signature: wrongSignature,
        })
        .expect(401);

      expect(loginResponse.body.success).toBe(false);

      const validSignature = keypair.sign(Buffer.from(message, 'utf-8')).toString('base64');
      const retryResponse = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', randomUUID())
        .send({ publicKey: keypair.publicKey(), message, signature: validSignature })
        .expect(200);

      expect(retryResponse.body.success).toBe(true);
    });

    it('should reject missing fields', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/auth/verify', () => {
    it('should verify valid token', async () => {
      const keypair = Keypair.random();

      const challengeResponse = await request(app)
        .post('/api/auth/challenge')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', randomUUID())
        .send({ publicKey: keypair.publicKey() })
        .expect(200);

      const message = challengeResponse.body.data.message;
      const signature = keypair.sign(Buffer.from(message, 'utf-8')).toString('base64');

      const loginResponse = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', nextTestIp())
        .set('Idempotency-Key', randomUUID())
        .send({
          publicKey: keypair.publicKey(),
          message,
          signature,
        })
        .expect(200);

      const token = loginResponse.body.data.token;

      const verifyResponse = await request(app)
        .get('/api/auth/verify')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(verifyResponse.body.success).toBe(true);
      expect(verifyResponse.body.data.valid).toBe(true);
      expect(verifyResponse.body.data.publicKey).toBe(keypair.publicKey());
      expect(verifyResponse.body.data.role).toBe('borrower');
      expect(Array.isArray(verifyResponse.body.data.scopes)).toBe(true);
      expect(verifyResponse.body.data.scopes).toContain('read:loans');
    });

    it('should reject missing token', async () => {
      const response = await request(app).get('/api/auth/verify').expect(401);

      expect(response.body.success).toBe(false);
    });

    it('should reject invalid token', async () => {
      const response = await request(app)
        .get('/api/auth/verify')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body.success).toBe(false);
    });
  });

  describe('Rate limiting', () => {
    it('should return 429 after 10 challenge requests from same IP', async () => {
      const keypair = Keypair.random();
      let lastResponse: {
        status: number;
        body: { success: boolean };
        headers: Record<string, string>;
      } = undefined as unknown as {
        status: number;
        body: { success: boolean };
        headers: Record<string, string>;
      };
      for (let i = 0; i < 11; i++) {
        lastResponse = await request(app)
          .post('/api/auth/challenge')
          .set('Idempotency-Key', randomUUID())
          .set('X-Forwarded-For', '1.2.3.4')
          .send({ publicKey: keypair.publicKey() });
      }
      expect(lastResponse.status).toBe(429);
      expect(lastResponse.body.success).toBe(false);
    });

    it('should return 429 and Retry-After after 5 login attempts from same IP', async () => {
      const keypair = Keypair.random();
      let lastResponse: {
        status: number;
        body: { success: boolean };
        headers: Record<string, string>;
      } = undefined as unknown as {
        status: number;
        body: { success: boolean };
        headers: Record<string, string>;
      };
      for (let i = 0; i < 6; i++) {
        lastResponse = await request(app)
          .post('/api/auth/login')
          .set('Idempotency-Key', randomUUID())
          .set('X-Forwarded-For', '5.6.7.8')
          .send({
            publicKey: keypair.publicKey(),
            message: 'fake-message',
            signature: 'fake-signature',
          });
      }
      expect(lastResponse.status).toBe(429);
      expect(lastResponse.headers['retry-after']).toBeDefined();
    });

    it('should return 429 after 5 login attempts with same public key', async () => {
      const keypair = Keypair.random();
      let lastResponse: {
        status: number;
        body: { success: boolean };
        headers: Record<string, string>;
      } = undefined as unknown as {
        status: number;
        body: { success: boolean };
        headers: Record<string, string>;
      };
      for (let i = 0; i < 6; i++) {
        lastResponse = await request(app)
          .post('/api/auth/login')
          .set('Idempotency-Key', randomUUID())
          .set('X-Forwarded-For', `9.9.9.${i}`)
          .send({
            publicKey: keypair.publicKey(),
            message: 'fake-message',
            signature: 'fake-signature',
          });
      }
      expect(lastResponse.status).toBe(429);
      expect(lastResponse.body.success).toBe(false);
    });
  });
});

describe('authService unit tests', () => {
  let authService: typeof import('../services/authService.js');

  beforeAll(async () => {
    authService = await import('../services/authService.js');
  });

  describe('verifySignature', () => {
    it('should return true for valid signature', () => {
      const keypair = Keypair.random();
      const message = 'test message';
      const signature = keypair.sign(Buffer.from(message, 'utf-8')).toString('base64');

      const result = authService.verifySignature(keypair.publicKey(), message, signature);
      expect(result).toBe(true);
    });

    it('should return false for wrong signer', () => {
      const keypair1 = Keypair.random();
      const keypair2 = Keypair.random();
      const message = 'test message';
      const signature = keypair1.sign(Buffer.from(message, 'utf-8')).toString('base64');

      const result = authService.verifySignature(keypair2.publicKey(), message, signature);
      expect(result).toBe(false);
    });

    it('should return false for non-64-byte signature', () => {
      const keypair = Keypair.random();
      const message = 'test message';
      const invalidSignature = Buffer.from('short').toString('base64');

      const result = authService.verifySignature(keypair.publicKey(), message, invalidSignature);
      expect(result).toBe(false);
    });

    it('should return false for non-base64 input', () => {
      const keypair = Keypair.random();
      const message = 'test message';
      const invalidSignature = '!!!not-base64!!!';

      const result = authService.verifySignature(keypair.publicKey(), message, invalidSignature);
      expect(result).toBe(false);
    });

    it('should return false for invalid public key', () => {
      const message = 'test message';
      const signature = Buffer.from('a'.repeat(64)).toString('base64');

      const result = authService.verifySignature('INVALID_KEY', message, signature);
      expect(result).toBe(false);
    });
  });

  describe('verifyChallengeTimestamp', () => {
    it('should accept timestamp at the window edge', () => {
      const maxAge = 5 * 60 * 1000; // 5 minutes
      const timestamp = Date.now() - maxAge;

      const result = authService.verifyChallengeTimestamp(timestamp, maxAge);
      expect(result).toBe(true);
    });

    it('should accept timestamp under the window', () => {
      const maxAge = 5 * 60 * 1000;
      const timestamp = Date.now() - 1000; // 1 second ago

      const result = authService.verifyChallengeTimestamp(timestamp, maxAge);
      expect(result).toBe(true);
    });

    it('should reject timestamp over the window', () => {
      const maxAge = 5 * 60 * 1000;
      const timestamp = Date.now() - maxAge - 1000; // 1 second too old

      const result = authService.verifyChallengeTimestamp(timestamp, maxAge);
      expect(result).toBe(false);
    });

    it('should accept future timestamp within tolerance', () => {
      const maxAge = 5 * 60 * 1000;
      const timestamp = Date.now() + 1000; // 1 second in future

      const result = authService.verifyChallengeTimestamp(timestamp, maxAge);
      expect(result).toBe(true);
    });
  });

  describe('extractBearerToken', () => {
    it('should extract token from valid Bearer header', () => {
      const token = 'my-jwt-token';
      const header = `Bearer ${token}`;

      const result = authService.extractBearerToken(header);
      expect(result).toBe(token);
    });

    it('should return null for undefined header', () => {
      const result = authService.extractBearerToken(undefined);
      expect(result).toBeNull();
    });

    it('should return null for wrong scheme', () => {
      const result = authService.extractBearerToken('Basic dGVzdA==');
      expect(result).toBeNull();
    });

    it('should return null for malformed Bearer with no token', () => {
      const result = authService.extractBearerToken('Bearer');
      expect(result).toBeNull();
    });

    it('should return null for lowercase bearer', () => {
      const result = authService.extractBearerToken('bearer my-token');
      expect(result).toBeNull();
    });

    it('should return null for wrong part count', () => {
      const result = authService.extractBearerToken('Bearer token extra');
      expect(result).toBeNull();
    });
  });
});
