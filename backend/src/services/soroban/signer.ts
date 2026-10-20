import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signer boundary for privileged backend Soroban transactions.
 *
 * Production private key material MUST NOT be loaded into the API process.
 * Privileged signing is delegated to an external KMS/HSM or policy-controlled
 * signer adapter. Local/test signers remain available but their selection is
 * explicit and rejected under production configuration.
 */

export type SorobanNetwork = 'testnet' | 'mainnet' | 'futurenet';

export type SorobanOperation =
  | 'invoke_contract'
  | 'deploy_contract'
  | 'upload_wasm'
  | 'extend_ttl';

export interface SignRequest {
  /** Target contract id (C... strkey) the operation is scoped to. */
  contractId: string;
  network: SorobanNetwork;
  operation: SorobanOperation;
  /** Opaque, already-validated payload (base64 XDR or canonical JSON). */
  payload: string;
  /** Monotonic nonce to make replay detectable. */
  nonce: string;
  /** Unix ms deadline; signer must deny if exceeded. */
  deadline: number;
}

export type DenialReason =
  | 'key_unavailable'
  | 'policy_denied'
  | 'replay_detected'
  | 'signer_timeout'
  | 'invalid_payload'
  | 'production_local_signer_forbidden';

export interface SignSuccess {
  ok: true;
  /** Transaction signature (base64). Never contains private key material. */
  signature: string;
  /** Identifier of the key/signer that produced the signature. */
  signerId: string;
}

export interface SignDenial {
  ok: false;
  reason: DenialReason;
  message: string;
}

export type SignResult = SignSuccess | SignDenial;

export interface Signer {
  readonly id: string;
  sign(request: SignRequest): Promise<SignResult>;
}

/**
 * Policy restricting what a signer is allowed to sign. Enforced before any
 * key material is touched, so a compromised caller cannot widen its own scope.
 */
export interface SignPolicy {
  allowedContracts: ReadonlySet<string>;
  allowedNetworks: ReadonlySet<SorobanNetwork>;
  allowedOperations: ReadonlySet<SorobanOperation>;
  /** Max accepted payload length in bytes. */
  maxPayloadBytes: number;
  /** Max accepted clock skew / request lifetime in ms. */
  maxRequestLifetimeMs: number;
}

export function validateSignRequest(
  request: SignRequest,
  policy: SignPolicy,
  now: number = Date.now(),
): SignDenial | null {
  if (!policy.allowedContracts.has(request.contractId)) {
    return { ok: false, reason: 'policy_denied', message: 'contract not allowed by signer policy' };
  }
  if (!policy.allowedNetworks.has(request.network)) {
    return { ok: false, reason: 'policy_denied', message: 'network not allowed by signer policy' };
  }
  if (!policy.allowedOperations.has(request.operation)) {
    return { ok: false, reason: 'policy_denied', message: 'operation not allowed by signer policy' };
  }
  if (typeof request.payload !== 'string' || request.payload.length === 0) {
    return { ok: false, reason: 'invalid_payload', message: 'payload must be a non-empty string' };
  }
  if (Buffer.byteLength(request.payload, 'utf8') > policy.maxPayloadBytes) {
    return { ok: false, reason: 'invalid_payload', message: 'payload exceeds policy size limit' };
  }
  if (typeof request.nonce !== 'string' || request.nonce.length < 8) {
    return { ok: false, reason: 'invalid_payload', message: 'nonce must be at least 8 characters' };
  }
  if (!Number.isFinite(request.deadline) || request.deadline <= now) {
    return { ok: false, reason: 'signer_timeout', message: 'request deadline has passed' };
  }
  if (request.deadline - now > policy.maxRequestLifetimeMs) {
    return { ok: false, reason: 'invalid_payload', message: 'request lifetime exceeds policy limit' };
  }
  return null;
}

/**
 * Replay guard: a nonce may be consumed at most once. Kept in-process for the
 * local signer; external signers are expected to enforce this server-side too.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number = 5 * 60 * 1000) {}

  /** Returns true if the nonce was already used (replay). */
  check(nonce: string, now: number = Date.now()): boolean {
    this.evict(now);
    if (this.seen.has(nonce)) {
      return true;
    }
    this.seen.set(nonce, now + this.ttlMs);
    return false;
  }

  private evict(now: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(nonce);
      }
    }
  }
}

/**
 * External signer adapter. Talks to a KMS/HSM or policy-controlled signing
 * service over HTTP. Private key material never enters this process; only the
 * resulting signature is returned.
 */
export interface ExternalSignerConfig {
  endpoint: string;
  /** Bearer token or mTLS identity reference resolved at call time. */
  authToken: string;
  signerId: string;
  policy: SignPolicy;
  timeoutMs?: number;
  replayGuard?: ReplayGuard;
  fetchImpl?: typeof fetch;
}

export class ExternalKmsSigner implements Signer {
  readonly id: string;
  private readonly policy: SignPolicy;
  private readonly replayGuard: ReplayGuard;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ExternalSignerConfig) {
    this.id = config.signerId;
    this.policy = config.policy;
    this.replayGuard = config.replayGuard ?? new ReplayGuard();
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async sign(request: SignRequest): Promise<SignResult> {
    const denial = validateSignRequest(request, this.policy);
    if (denial) {
      return denial;
    }
    if (this.replayGuard.check(request.nonce)) {
      return { ok: false, reason: 'replay_detected', message: 'nonce already used' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({
          contractId: request.contractId,
          network: request.network,
          operation: request.operation,
          payload: request.payload,
          nonce: request.nonce,
          deadline: request.deadline,
        }),
        signal: controller.signal,
      });

      if (response.status === 403) {
        return { ok: false, reason: 'policy_denied', message: 'external signer denied request' };
      }
      if (response.status === 409) {
        return { ok: false, reason: 'replay_detected', message: 'external signer detected replay' };
      }
      if (response.status === 503) {
        return { ok: false, reason: 'key_unavailable', message: 'external signer key unavailable' };
      }
      if (!response.ok) {
        return { ok: false, reason: 'key_unavailable', message: `external signer error ${response.status}` };
      }

      const body = (await response.json()) as { signature?: unknown; signerId?: unknown };
      if (typeof body.signature !== 'string' || body.signature.length === 0) {
        return { ok: false, reason: 'invalid_payload', message: 'external signer returned no signature' };
      }
      return {
        ok: true,
        signature: body.signature,
        signerId: typeof body.signerId === 'string' ? body.signerId : this.id,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, reason: 'signer_timeout', message: 'external signer timed out' };
      }
      return { ok: false, reason: 'key_unavailable', message: 'external signer unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Local/test signer. Uses an in-process secret and is explicitly forbidden in
 * production configuration. Selection must be opt-in via `allowLocalSigner`.
 */
export interface LocalSignerConfig {
  secret: string;
  signerId?: string;
  policy: SignPolicy;
  /** Must be true to construct; production config must never set this. */
  allowLocalSigner: boolean;
  replayGuard?: ReplayGuard;
}

export class LocalSigner implements Signer {
  readonly id: string;
  private readonly secret: string;
  private readonly policy: SignPolicy;
  private readonly replayGuard: ReplayGuard;

  constructor(config: LocalSignerConfig) {
    if (!config.allowLocalSigner) {
      throw new Error('LocalSigner requires explicit allowLocalSigner opt-in');
    }
    if (!config.secret || config.secret.length < 16) {
      throw new Error('LocalSigner secret must be at least 16 characters');
    }
    this.id = config.signerId ?? 'local';
    this.secret = config.secret;
    this.policy = config.policy;
    this.replayGuard = config.replayGuard ?? new ReplayGuard();
  }

  async sign(request: SignRequest): Promise<SignResult> {
    const denial = validateSignRequest(request, this.policy);
    if (denial) {
      return denial;
    }
    if (this.replayGuard.check(request.nonce)) {
      return { ok: false, reason: 'replay_detected', message: 'nonce already used' };
    }
    const mac = createHmac('sha256', this.secret)
      .update(`${request.network}:${request.contractId}:${request.operation}:${request.nonce}:${request.payload}`)
      .digest('base64');
    return { ok: true, signature: mac, signerId: this.id };
  }
}

/**
 * Selects a signer based on configuration. Local signers are impossible when
 * NODE_ENV is production, regardless of other flags.
 */
export interface SignerSelectionConfig {
  nodeEnv: string;
  external?: ExternalSignerConfig;
  local?: Omit<LocalSignerConfig, 'allowLocalSigner'> & { allowLocalSigner?: boolean };
}

export function createSigner(config: SignerSelectionConfig): Signer {
  const isProduction = config.nodeEnv === 'production';

  if (isProduction) {
    if (!config.external) {
      throw new Error('Production requires an external KMS/HSM signer; local signers are forbidden');
    }
    return new ExternalKmsSigner(config.external);
  }

  if (config.external) {
    return new ExternalKmsSigner(config.external);
  }
  if (config.local) {
    return new LocalSigner({ ...config.local, allowLocalSigner: config.local.allowLocalSigner === true });
  }
  throw new Error('No signer configured');
}

/** Constant-time comparison helper for verifying returned signatures. */
export function signaturesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
