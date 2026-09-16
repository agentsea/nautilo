import { describe, expect, test } from "bun:test";

import {
  PUSH_TOKEN_ENCRYPTION_KEY_ENV,
  PUSH_TOKEN_ENCRYPTION_KEY_VERSION,
  PushTokenCryptoConfigurationError,
  PushTokenCryptoEnvelopeError,
  decryptPushToken,
  encryptPushToken,
  requirePushTokenEncryptionKey,
  type PushTokenEncryptionContext,
} from "../../src/push/push-token-crypto.ts";

const key = Buffer.alloc(32, 7);
const keyEnv = key.toString("hex");
const context: PushTokenEncryptionContext = {
  userId: "human-1",
  installationId: "installation-1",
  bindingId: "binding-1",
  tokenGeneration: 1,
};
const token = "ExponentPushToken[capability-material]";

describe("D468 push-token crypto", () => {
  test("encrypts a versioned envelope and decrypts only under the same row context", () => {
    const envelope = encryptPushToken(key, token, context);
    expect(envelope.keyVersion).toBe(PUSH_TOKEN_ENCRYPTION_KEY_VERSION);
    expect(envelope.ciphertextBase64).not.toContain(token);
    expect(decryptPushToken(key, envelope, context)).toBe(token);
  });

  test("fails closed for missing or malformed deployment keys without echoing the value", () => {
    expect(() => requirePushTokenEncryptionKey({})).toThrow(
      PushTokenCryptoConfigurationError,
    );
    const malformed = "not-the-right-key";
    let message = "";
    try {
      requirePushTokenEncryptionKey({ [PUSH_TOKEN_ENCRYPTION_KEY_ENV]: malformed });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(PUSH_TOKEN_ENCRYPTION_KEY_ENV);
    expect(message).not.toContain(malformed);
    expect(() => requirePushTokenEncryptionKey({
      [PUSH_TOKEN_ENCRYPTION_KEY_ENV]: keyEnv,
    })).not.toThrow();
  });

  test("rejects tampered ciphertext and all row/context swapping", () => {
    const envelope = encryptPushToken(key, token, context);
    const tampered = {
      ...envelope,
      ciphertextBase64: Buffer.from("tampered-token", "utf8").toString("base64"),
    };
    expect(() => decryptPushToken(key, tampered, context)).toThrow(
      PushTokenCryptoEnvelopeError,
    );
    expect(() => decryptPushToken(key, envelope, {
      ...context,
      bindingId: "binding-2",
    })).toThrow(PushTokenCryptoEnvelopeError);
    expect(() => decryptPushToken(key, envelope, {
      ...context,
      tokenGeneration: 2,
    })).toThrow(PushTokenCryptoEnvelopeError);
  });

  test("rejects malformed or unknown-version ciphertext envelopes", () => {
    const envelope = encryptPushToken(key, token, context);
    expect(() => decryptPushToken(key, {
      ...envelope,
      keyVersion: 2,
    } as never, context)).toThrow(PushTokenCryptoEnvelopeError);
    expect(() => decryptPushToken(key, {
      ...envelope,
      nonceBase64: "not-base64",
    }, context)).toThrow(PushTokenCryptoEnvelopeError);
  });
});
