import { registerTestUser } from '../controllers/authController.js';
import { Router } from 'express';
import { z } from 'zod';
import { requestChallenge, login, verify, logout, introspect, refreshAccessToken } from '../controllers/authController.js';
import {
  challengeRateLimiter,
  loginRateLimiter,
  ipLoginRateLimiter,
  verifyRateLimiter,
} from '../middleware/rateLimiter.js';
import { requireJwtAuth } from '../middleware/jwtAuth.js';
import { validateBody } from '../middleware/validation.js';
import { authSecurityMiddleware } from '../middleware/authSecurity.js';

const router = Router();

// TEST/DEV ONLY: Register a test user
if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
  router.post('/register', registerTestUser);
}

const challengeSchema = z.object({
  publicKey: z.string().min(1, 'Public key is required'),
});

const loginSchema = z.object({
  publicKey: z.string().min(1, 'Public key is required'),
  message: z.string().min(1, 'Message is required').max(1024),
  signature: z.string().min(1, 'Signature is required'),
});

/**
 * @swagger
 * /auth/challenge:
 *   post:
 *     summary: Request a sign-in message (public)
 *     description: Returns a database-persisted, five-minute one-time nonce and message for the wallet to sign. No authentication required.
 *     tags: [Auth]
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publicKey]
 *             properties:
 *               publicKey:
 *                 type: string
 *                 description: Stellar public key (G…)
 *     responses:
 *       200:
 *         description: Challenge payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthChallengeResponse'
 *       503:
 *         description: Challenge persistence is temporarily unavailable
 */
router.post('/challenge', challengeRateLimiter, validateBody(challengeSchema), authSecurityMiddleware, requestChallenge);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Exchange signed challenge for JWT (public)
 *     description: Verifies and atomically consumes the issued challenge before returning a Bearer token. Challenges can be used once.
 *     tags: [Auth]
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publicKey, message, signature]
 *             properties:
 *               publicKey:
 *                 type: string
 *               message:
 *                 type: string
 *               signature:
 *                 type: string
 *                 description: Base64-encoded signature
 *     responses:
 *       200:
 *         description: JWT issued
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthLoginResponse'
 *       401:
 *         description: Invalid signature, expired challenge, or challenge already used
 *       503:
 *         description: Challenge persistence is temporarily unavailable
 */
router.post('/login', ipLoginRateLimiter, loginRateLimiter, validateBody(loginSchema), authSecurityMiddleware, login);

/**
 * @swagger
 * /auth/verify:
 *   get:
 *     summary: Verify JWT and return wallet info
 *     tags: [Auth]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Token valid
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthVerifyResponse'
 *       401:
 *         description: Missing or invalid Bearer token
 */
router.get('/verify', requireJwtAuth, verifyRateLimiter, verify);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Revoke the current JWT
 *     description: >
 *       Blacklists the current token's jti so it is rejected by requireJwtAuth
 *       even though it has not yet expired, and clears the auth cookie.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logged out successfully
 *       401:
 *         description: Missing or invalid Bearer token
 */
router.post('/logout', requireJwtAuth, logout);

/**
 * @swagger
 * /auth/introspect:
 *   post:
 *     summary: Introspect token details
 *     description: Returns token metadata including expiration, scopes, and TTL without requiring authentication.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *                 description: JWT to introspect
 *     responses:
 *       200:
 *         description: Token introspection details
 */
router.post('/introspect', validateBody(z.object({ token: z.string().min(1) })), introspect);

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Refresh access token using refresh token
 *     description: Exchanges a valid refresh token for a new access token with rotated refresh token.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: Refresh token from previous login
 *     responses:
 *       200:
 *         description: New access token issued
 *       401:
 *         description: Invalid or expired refresh token
 */
router.post('/refresh', validateBody(z.object({ refreshToken: z.string().min(1) })), refreshAccessToken);

export default router;
