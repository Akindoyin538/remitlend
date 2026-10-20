/**
 * Signer boundary for privileged backend Soroban transactions.
 *
 * Production private key material must never be loaded into the API process.
 * Privileged signing is delegated to an external KMS/HSM or policy-controlled
 * signer adapter. Local/test signers remain available but their selection is
 * explicit and rejected under production configuration.
 */

export type SignerNetwork = "testnet" | "mainnet" | "futurenet";

export type SignerOperation =
  | "invoke_contract"
  | "create_contract"
  | "upload_wasm"
  | "extend_footprint_ttl"
  | "bump_sequence";

export interface SignRequest {
  /** Stellar network the transaction targets. */
  network: SignerNetwork;
  /** Contract (C...) or account (G...) the operation is scoped to. */
  contractId: string;
  /** Soroban operation being authorized. */
  operation: SignerOperation;
  /** Canonical, validated payload (base64 XDR envelope or equivalent). */
  payload: string;
  /** Monotonic nonce used to reject replays. */
  nonce: string;
  /** ISO-8601 timestamp the request was created. */
  issuedAt: string;
  /** Optional correlation id for audit logging (never key material). */
  requestId?: string;
}

export type SignDenialReason =
  | "policy_denied"
  | "key_unavailable"
  | "signer_timeout"
  | "replay_detected"
  | "invalid_payload"
  | "unauthorized";

export interface SignDenial {
  ok: false;
  reason: SignDenialReason;
  message: string;
}

export interface SignSuccess {
  ok: true;
  /** Transaction signature (base64). Never contains private key material. */
  signature: string;
  /** Identifier of the signer that produced the signature. */
  signerId: string;
}

export type SignResult = SignSuccess | SignDenial;

/**
 * External signer boundary. Implementations must not expose private key
 * material to the caller and must not log it.
 */
export interface PrivilegedSigner {
  readonly id: string;
  /** True when the signer holds keys outside the API process. */
  readonly external: boolean;
  sign(request: SignRequest): Promise<SignResult>;
}

/**
 * Policy restricting which sign requests may be authorized. Requests that do
 * not match the policy are denied before reaching the signer.
 */
export interface SignerPolicy {
  allowedNetworks: SignerNetwork[];
  allowedContracts: string[];
  allowedOperations: SignerOperation[];
  /** Maximum age of a request in milliseconds before it is rejected. */
  maxRequestAgeMs: number;
  /** Maximum payload size in bytes. */
  maxPayloadBytes: number;
}

export const DEFAULT_SIGNER_POLICY: SignerPolicy = {
  allowedNetworks: ["testnet"],
  allowedContracts: [],
  allowedOperations: [],
  maxRequestAgeMs: 60_000,
  maxPayloadBytes: 100_000,
};

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

function denial(reason: SignDenialReason, message: string): SignDenial {
  return { ok: false, reason, message };
}

/**
 * Validate a sign request against the configured policy. Returns a typed
 * denial when the request is not permitted, otherwise null.
 */
export function validateSignRequest(
  request: SignRequest,
  policy: SignerPolicy,
  now: number = Date.now(),
): SignDenial | null {
  if (!policy.allowedNetworks.includes(request.network)) {
    return denial("policy_denied", `network ${request.network} is not allowed`);
  }

  if (!policy.allowedOperations.includes(request.operation)) {
    return denial("policy_denied", `operation ${request.operation} is not allowed`);
  }

  if (!CONTRACT_RE.test(request.contractId) && !ACCOUNT_RE.test(request.contractId)) {
    return denial("invalid_payload", "contractId is not a valid Stellar contract or account id");
  }

  if (!policy.allowedContracts.includes(request.contractId)) {
    return denial("policy_denied", `contract ${request.contractId} is not allowed`);
  }

  if (!request.payload || !BASE64_RE.test(request.payload)) {
    return denial("invalid_payload", "payload must be non-empty base64");
  }

  if (Buffer.byteLength(request.payload, "utf8") > policy.maxPayloadBytes) {
    return denial("invalid_payload", "payload exceeds maximum allowed size");
  }

  if (!request.nonce) {
    return denial("invalid_payload", "nonce is required");
  }

  const issuedAt = Date.parse(request.issuedAt);
  if (Number.isNaN(issuedAt)) {
    return denial("invalid_payload", "issuedAt is not a valid timestamp");
  }

  if (now - issuedAt > policy.maxRequestAgeMs) {
    return denial("policy_denied", "sign request has expired");
  }

  if (issuedAt - now > policy.maxRequestAgeMs) {
    return denial("policy_denied", "sign request is not yet valid");
  }

  return null;
}

/**
 * Tracks consumed nonces to reject replays. Bounded to avoid unbounded growth.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number = 5 * 60_000) {}

  /** Returns true when the nonce was already used (replay). */
  check(nonce: string, now: number = Date.now()): boolean {
    this.evict(now);
    return this.seen.has(nonce);
  }

  /** Records a nonce as consumed. */
  consume(nonce: string, now: number = Date.now()): void {
    this.evict(now);
    this.seen.set(nonce, now);
  }

  private evict(now: number): void {
    for (const [nonce, at] of this.seen) {
      if (now - at > this.ttlMs) {
        this.seen.delete(nonce);
      }
    }
  }
}

/**
 * Wraps a signer with policy enforcement and replay protection. The wrapper
 * cannot bypass wallet/user authorization: it only forwards requests that
 * already carry a validated payload and pass policy.
 */
export class PolicyEnforcedSigner implements PrivilegedSigner {
  readonly id: string;
  readonly external: boolean;

  constructor(
    private readonly inner: PrivilegedSigner,
    private readonly policy: SignerPolicy,
    private readonly replayGuard: ReplayGuard = new ReplayGuard(),
    private readonly timeoutMs: number = 10_000,
  ) {
    this.id = inner.id;
    this.external = inner.external;
  }

  async sign(request: SignRequest): Promise<SignResult> {
    const policyDenial = validateSignRequest(request, this.policy);
    if (policyDenial) {
      return policyDenial;
    }

    if (this.replayGuard.check(request.nonce)) {
      return denial("replay_detected", "nonce has already been used");
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.inner.sign(request),
        new Promise<SignResult>((resolve) => {
          timer = setTimeout(
            () => resolve(denial("signer_timeout", "signer did not respond in time")),
            this.timeoutMs,
          );
        }),
      ]);

      if (result.ok) {
        this.replayGuard.consume(request.nonce);
      }
      return result;
    } catch {
      return denial("key_unavailable", "signer is unavailable");
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

/**
 * Local signer for tests and development only. It never holds production key
 * material and must not be selected under production configuration.
 */
export class LocalTestSigner implements PrivilegedSigner {
  readonly id = "local-test-signer";
  readonly external = false;

  constructor(private readonly signFn: (request: SignRequest) => Promise<string>) {}

  async sign(request: SignRequest): Promise<SignResult> {
    try {
      const signature = await this.signFn(request);
      return { ok: true, signature, signerId: this.id };
    } catch {
      return denial("key_unavailable", "local test signer failed");
    }
  }
}

/**
 * External signer adapter backed by a KMS/HSM or policy-controlled signing
 * service. Private key material stays outside the API process; only the
 * signature is returned.
 */
export interface ExternalSignerTransport {
  /** Sends the request to the external signer and returns a base64 signature. */
  sign(request: SignRequest): Promise<string>;
}

export class ExternalKmsSigner implements PrivilegedSigner {
  readonly external = true;

  constructor(
    readonly id: string,
    private readonly transport: ExternalSignerTransport,
  ) {}

  async sign(request: SignRequest): Promise<SignResult> {
    try {
      const signature = await this.transport.sign(request);
      if (!signature) {
        return denial("key_unavailable", "external signer returned no signature");
      }
      return { ok: true, signature, signerId: this.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : "external signer error";
      return denial("key_unavailable", message);
    }
  }
}

/**
 * Selects a signer based on configuration. Local/test signers are rejected
 * when NODE_ENV is production, making their selection explicit and impossible
 * in production configuration.
 */
export interface SignerSelectionConfig {
  nodeEnv: string | undefined;
  /** Explicit opt-in required to use a local signer outside production. */
  allowLocalSigner: boolean;
  externalSigner?: PrivilegedSigner;
  localSigner?: PrivilegedSigner;
}

export function selectSigner(config: SignerSelectionConfig): PrivilegedSigner {
  const isProduction = config.nodeEnv === "production";

  if (isProduction) {
    if (!config.externalSigner) {
      throw new Error("production requires an external signer; local signers are not permitted");
    }
    return config.externalSigner;
  }

  if (config.allowLocalSigner && config.localSigner) {
    return config.localSigner;
  }

  if (config.externalSigner) {
    return config.externalSigner;
  }

  throw new Error("no signer configured; set an external signer or explicitly allow a local signer");
}
