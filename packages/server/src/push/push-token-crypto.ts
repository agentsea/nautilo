import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { PUSH_TOKEN_ENCRYPTION_KEY } from "@nautilo/operator-secrets";

export const PUSH_TOKEN_ENCRYPTION_KEY_ENV = PUSH_TOKEN_ENCRYPTION_KEY;
export const PUSH_TOKEN_ENCRYPTION_KEY_VERSION = 1 as const;

const AES_256_GCM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Stable row facts authenticated with a token. Binding the envelope to these
 * facts prevents ciphertext from being swapped between users, installations,
 * bindings, or generations without detection.
 */
export interface PushTokenEncryptionContext {
  readonly userId: string;
  readonly installationId: string;
  readonly bindingId: string;
  readonly tokenGeneration: number;
}

/** Versioned storage shape for a protected Expo token. */
export interface EncryptedPushTokenV1 {
  readonly keyVersion: typeof PUSH_TOKEN_ENCRYPTION_KEY_VERSION;
  readonly nonceBase64: string;
  readonly ciphertextBase64: string;
  readonly authTagBase64: string;
}

export class PushTokenCryptoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushTokenCryptoConfigurationError";
  }
}

export class PushTokenCryptoEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushTokenCryptoEnvelopeError";
  }
}

/**
 * Returns the exact 256-bit deployment key. Absence and malformed values are
 * configuration errors; a process-random replacement would make persisted
 * bindings unreadable after restart and is intentionally refused.
 */
export function requirePushTokenEncryptionKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const value = env[PUSH_TOKEN_ENCRYPTION_KEY_ENV]?.trim();
  if (!value) {
    throw new PushTokenCryptoConfigurationError(
      `${PUSH_TOKEN_ENCRYPTION_KEY_ENV} must be configured before push-token storage is enabled`,
    );
  }
  if (!isCanonicalHex(value, KEY_BYTES)) {
    throw new PushTokenCryptoConfigurationError(
      `${PUSH_TOKEN_ENCRYPTION_KEY_ENV} must be exactly ${KEY_BYTES} bytes encoded as hexadecimal`,
    );
  }
  return Buffer.from(value, "hex");
}

export function encryptPushToken(
  key: Uint8Array,
  token: string,
  context: PushTokenEncryptionContext,
): EncryptedPushTokenV1 {
  assertKey(key);
  if (token.length === 0) {
    throw new PushTokenCryptoEnvelopeError("Push token plaintext must not be empty.");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(AES_256_GCM, key, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(associatedData(context));
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    keyVersion: PUSH_TOKEN_ENCRYPTION_KEY_VERSION,
    nonceBase64: nonce.toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    authTagBase64: authTag.toString("base64"),
  };
}

export function decryptPushToken(
  key: Uint8Array,
  envelope: EncryptedPushTokenV1,
  context: PushTokenEncryptionContext,
): string {
  assertKey(key);
  assertEnvelope(envelope);
  const nonce = Buffer.from(envelope.nonceBase64, "base64");
  const ciphertext = Buffer.from(envelope.ciphertextBase64, "base64");
  const authTag = Buffer.from(envelope.authTagBase64, "base64");
  const decipher = createDecipheriv(AES_256_GCM, key, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAAD(associatedData(context));
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new PushTokenCryptoEnvelopeError(
      "Push token ciphertext authentication failed.",
    );
  }
}

function associatedData(context: PushTokenEncryptionContext): Buffer {
  assertContext(context);
  return Buffer.from([
    "nautilo.push-token.v1",
    context.userId,
    context.installationId,
    context.bindingId,
    String(context.tokenGeneration),
  ].join("\0"), "utf8");
}

function assertContext(context: PushTokenEncryptionContext): void {
  if (
    context.userId.length === 0 ||
    context.installationId.length === 0 ||
    context.bindingId.length === 0 ||
    !Number.isSafeInteger(context.tokenGeneration) ||
    context.tokenGeneration < 1 ||
    [context.userId, context.installationId, context.bindingId].some((value) =>
      value.includes("\0"),
    )
  ) {
    throw new PushTokenCryptoEnvelopeError("Push token encryption context is invalid.");
  }
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new PushTokenCryptoConfigurationError(
      "Push-token encryption key must be exactly 32 bytes.",
    );
  }
}

function assertEnvelope(envelope: EncryptedPushTokenV1): void {
  if (
    envelope.keyVersion !== PUSH_TOKEN_ENCRYPTION_KEY_VERSION ||
    !isCanonicalBase64(envelope.nonceBase64, NONCE_BYTES) ||
    !isCanonicalBase64(envelope.authTagBase64, AUTH_TAG_BYTES) ||
    !isCanonicalBase64(envelope.ciphertextBase64) ||
    Buffer.from(envelope.ciphertextBase64, "base64").length === 0
  ) {
    throw new PushTokenCryptoEnvelopeError("Push token ciphertext envelope is invalid.");
  }
}

function isCanonicalBase64(value: string, exactBytes?: number): boolean {
  if (value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return (
    (exactBytes === undefined || decoded.length === exactBytes) &&
    decoded.toString("base64") === value
  );
}

function isCanonicalHex(value: string, exactBytes: number): boolean {
  return /^[a-f0-9]+$/i.test(value) && value.length === exactBytes * 2;
}
