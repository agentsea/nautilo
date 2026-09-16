import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type { ConnectedWebOperationProviderReferences } from "@nautilo/db";

const AES_256_GCM = "aes-256-gcm" as const;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_VERSION = "cwo1" as const;
const MINIMUM_STABLE_SECRET_BYTES = 32;
const INTENT_ENVELOPE_MAX_BYTES = 16_384;
const PROVIDER_COORDINATE_ENVELOPE_MAX_BYTES = 2_048;
const INTENT_PLAINTEXT_MAX_BYTES = maximumPlaintextBytes(INTENT_ENVELOPE_MAX_BYTES);
const PROVIDER_COORDINATE_PLAINTEXT_MAX_BYTES = maximumPlaintextBytes(PROVIDER_COORDINATE_ENVELOPE_MAX_BYTES);

export type ConnectedWebOperationSecretField =
  | "intent"
  | "run"
  | "session"
  | "workspace"
  | "browser";

export interface ConnectedWebOperationSecretContext {
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly accountId: string | null;
}

/** Plain provider identifiers exist only briefly at this server-only boundary. */
export interface ConnectedWebOperationProviderCoordinates {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly browserId?: string;
}

export interface ConnectedWebOperationSecretsOptions {
  /**
   * Stable deployment material, injected by production composition. It is
   * purpose-derived below; this codec never creates a process-random key.
   */
  readonly stableServerSecret: string | Uint8Array;
  /** Test seam only; production uses cryptographic random bytes. */
  readonly nonce?: (length: number) => Uint8Array;
}

/** A non-enumerating error: provider identifiers and ciphertext never escape it. */
export class ConnectedWebOperationSecretError extends Error {
  constructor() {
    super("Connected website operation secret could not be opened.");
    this.name = "ConnectedWebOperationSecretError";
  }
}

/** A trusted server can mint this before sealing, so the ID is authenticated into every field. */
export function mintConnectedWebOperationId(): string {
  return randomUUID();
}

/**
 * Exact structural recognition for the only durable ciphertext format. This
 * deliberately proves shape, not authenticity; `unseal` verifies GCM AAD.
 */
export function isConnectedWebOperationSealedEnvelope(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) return false;
  const nonce = parts[1];
  const tag = parts[2];
  const ciphertext = parts[3];
  return isCanonicalBase64Url(nonce, NONCE_BYTES)
    && isCanonicalBase64Url(tag, AUTH_TAG_BYTES)
    && isCanonicalBase64Url(ciphertext)
    && ciphertext !== undefined
    && Buffer.from(ciphertext, "base64url").length > 0;
}

/**
 * Authenticated, field-bound persistence codec for one supervised operation.
 * It intentionally contains no provider client, logging, or public projection.
 */
export class ConnectedWebOperationSecrets {
  private readonly key: Buffer;
  private readonly nonce: (length: number) => Uint8Array;

  constructor(options: ConnectedWebOperationSecretsOptions) {
    const secret = secretBytes(options.stableServerSecret);
    if (secret.length < MINIMUM_STABLE_SECRET_BYTES) throw new ConnectedWebOperationSecretError();
    this.key = createHash("sha256")
      .update("nautilo.connected-web-operation-secrets.v1\0", "utf8")
      .update(secret)
      .digest();
    this.nonce = options.nonce ?? randomBytes;
  }

  sealIntent(input: {
    readonly context: ConnectedWebOperationSecretContext;
    readonly intent: string;
  }): string {
    return this.seal("intent", input.intent, input.context, INTENT_PLAINTEXT_MAX_BYTES, INTENT_ENVELOPE_MAX_BYTES);
  }

  unsealIntent(input: {
    readonly context: ConnectedWebOperationSecretContext;
    readonly sealedIntent: string;
  }): string {
    return this.unseal("intent", input.sealedIntent, input.context, INTENT_PLAINTEXT_MAX_BYTES, INTENT_ENVELOPE_MAX_BYTES);
  }

  sealProviderReferences(input: {
    readonly context: ConnectedWebOperationSecretContext;
    readonly coordinates: ConnectedWebOperationProviderCoordinates;
  }): ConnectedWebOperationProviderReferences {
    const { context, coordinates } = input;
    return {
      version: 1,
      ...(coordinates.runId === undefined ? {} : { runRef: this.seal("run", coordinates.runId, context, PROVIDER_COORDINATE_PLAINTEXT_MAX_BYTES, PROVIDER_COORDINATE_ENVELOPE_MAX_BYTES) }),
      ...(coordinates.sessionId === undefined ? {} : { sessionRef: this.seal("session", coordinates.sessionId, context, PROVIDER_COORDINATE_PLAINTEXT_MAX_BYTES, PROVIDER_COORDINATE_ENVELOPE_MAX_BYTES) }),
      ...(coordinates.workspaceId === undefined ? {} : { workspaceRef: this.seal("workspace", coordinates.workspaceId, context, PROVIDER_COORDINATE_PLAINTEXT_MAX_BYTES, PROVIDER_COORDINATE_ENVELOPE_MAX_BYTES) }),
      ...(coordinates.browserId === undefined ? {} : { browserRef: this.seal("browser", coordinates.browserId, context, PROVIDER_COORDINATE_PLAINTEXT_MAX_BYTES, PROVIDER_COORDINATE_ENVELOPE_MAX_BYTES) }),
    };
  }

  unsealProviderReferences(input: {
    readonly context: ConnectedWebOperationSecretContext;
    readonly references: ConnectedWebOperationProviderReferences;
  }): ConnectedWebOperationProviderCoordinates {
    const { context, references } = input;
    if (!isPlainRecord(references) || references.version !== 1 || !hasOnlyProviderReferenceKeys(references)) {
      throw new ConnectedWebOperationSecretError();
    }
    return {
      ...(references.runRef === undefined ? {} : { runId: this.unseal("run", references.runRef, context, PROVIDER_COORDINATE_PLAINTEXT_MAX_BYTES, PROVIDER_COORDINATE_ENVELOPE_MAX_BYTES) }),
      ...(references.sessionRef === undefined ? {} : { sessionId: this.unseal("session", references.sessionRef, context, PROVIDER_COORDINATE_PLAINTEXT_MAX_BYTES, PROVIDER_COORDINATE_ENVELOPE_MAX_BYTES) }),
      ...(references.workspaceRef === undefined ? {} : { workspaceId: this.unseal("workspace", references.workspaceRef, context, PROVIDER_COORDINATE_PLAINTEXT_MAX_BYTES, PROVIDER_COORDINATE_ENVELOPE_MAX_BYTES) }),
      ...(references.browserRef === undefined ? {} : { browserId: this.unseal("browser", references.browserRef, context, PROVIDER_COORDINATE_PLAINTEXT_MAX_BYTES, PROVIDER_COORDINATE_ENVELOPE_MAX_BYTES) }),
    };
  }

  private seal(
    field: ConnectedWebOperationSecretField,
    plaintext: string,
    context: ConnectedWebOperationSecretContext,
    plaintextMaximumBytes: number,
    envelopeMaximumBytes: number,
  ): string {
    assertPlaintext(plaintext, plaintextMaximumBytes);
    const nonce = Buffer.from(this.nonce(NONCE_BYTES));
    if (nonce.length !== NONCE_BYTES) throw new ConnectedWebOperationSecretError();
    const cipher = createCipheriv(AES_256_GCM, this.key, nonce, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(associatedData(field, context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope = [
      ENVELOPE_VERSION,
      nonce.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
    if (Buffer.byteLength(envelope, "utf8") > envelopeMaximumBytes) {
      throw new ConnectedWebOperationSecretError();
    }
    return envelope;
  }

  private unseal(
    field: ConnectedWebOperationSecretField,
    envelope: string,
    context: ConnectedWebOperationSecretContext,
    plaintextMaximumBytes: number,
    envelopeMaximumBytes: number,
  ): string {
    if (Buffer.byteLength(envelope, "utf8") > envelopeMaximumBytes || !isConnectedWebOperationSealedEnvelope(envelope)) throw new ConnectedWebOperationSecretError();
    const [, noncePart, tagPart, ciphertextPart] = envelope.split(".");
    if (noncePart === undefined || tagPart === undefined || ciphertextPart === undefined) {
      throw new ConnectedWebOperationSecretError();
    }
    try {
      const decipher = createDecipheriv(AES_256_GCM, this.key, Buffer.from(noncePart, "base64url"), { authTagLength: AUTH_TAG_BYTES });
      decipher.setAAD(associatedData(field, context));
      decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      assertPlaintext(plaintext, plaintextMaximumBytes);
      return plaintext;
    } catch {
      throw new ConnectedWebOperationSecretError();
    }
  }
}

function associatedData(
  field: ConnectedWebOperationSecretField,
  context: ConnectedWebOperationSecretContext,
): Buffer {
  if (!isContext(context)) throw new ConnectedWebOperationSecretError();
  return Buffer.from([
    "nautilo.connected-web-operation-secrets.v1",
    field,
    context.operationId,
    context.ownerUserId,
    context.accountId ?? "public",
  ].join("\0"), "utf8");
}

function assertPlaintext(value: string, maximumBytes: number): void {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new ConnectedWebOperationSecretError();
  }
}

function secretBytes(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function isContext(value: ConnectedWebOperationSecretContext): boolean {
  return isUuid(value.operationId) && isUuid(value.ownerUserId) && (value.accountId === null || isUuid(value.accountId));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isCanonicalBase64Url(value: string | undefined, exactBytes?: number): boolean {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return (exactBytes === undefined || decoded.length === exactBytes)
    && decoded.toString("base64url") === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyProviderReferenceKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => ["version", "runRef", "sessionRef", "workspaceRef", "browserRef"].includes(key));
}

function maximumPlaintextBytes(maxEnvelopeBytes: number): number {
  const overhead = Buffer.byteLength(`${ENVELOPE_VERSION}.${Buffer.alloc(NONCE_BYTES).toString("base64url")}.${Buffer.alloc(AUTH_TAG_BYTES).toString("base64url")}.`, "utf8");
  let plaintextBytes = maxEnvelopeBytes - overhead;
  while (base64UrlByteLength(plaintextBytes) + overhead > maxEnvelopeBytes) plaintextBytes -= 1;
  return plaintextBytes;
}

function base64UrlByteLength(bytes: number): number {
  const padded = Math.ceil(bytes / 3) * 4;
  return padded - (bytes % 3 === 0 ? 0 : 3 - (bytes % 3));
}
