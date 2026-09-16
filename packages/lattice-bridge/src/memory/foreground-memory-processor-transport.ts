import {
  memoryProcessorRecipientV1Schema,
  memoryProcessorSealedRequestV1Schema,
  type MemoryProcessorRecipientV1,
  type MemoryProcessorRequestPurposeV1,
  type MemoryProcessorSealedRequestV1,
} from "@nautilo/api-client/browser";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS } from
  "./foreground-embedding-processor.ts";

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new TypeError("Noncanonical processor bytes");
  return bytes;
}

type RequestBinding = Readonly<{
  purpose: MemoryProcessorRequestPurposeV1;
  subjectId: string;
}>;

/** Seal at send time: a prepared mutation journal never owns a server key. */
export async function sealForegroundMemoryProcessorRequest(input: RequestBinding & Readonly<{
  crypto: LatticeCrypto;
  recipient: MemoryProcessorRecipientV1;
  payload: string;
  now?: () => number;
}>): Promise<MemoryProcessorSealedRequestV1> {
  const recipient = memoryProcessorRecipientV1Schema.parse(input.recipient);
  const publicKey = decode(recipient.publicKeyBase64url);
  if (encode(input.crypto.hash(publicKey)) !== recipient.recipientId) {
    throw new TypeError("Memory processor recipient fingerprint mismatch");
  }
  const issuedAt = (input.now ?? Date.now)();
  const plaintext = new TextEncoder().encode(JSON.stringify({
    formatVersion: 1,
    recipientId: recipient.recipientId,
    purpose: input.purpose,
    subjectId: input.subjectId,
    issuedAt,
    deadlineAt: issuedAt + MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS,
    payload: input.payload,
  }));
  try {
    return Object.freeze({
      formatVersion: 1,
      recipientId: recipient.recipientId,
      ciphertextBase64url: encode(await input.crypto.sealTo(publicKey, plaintext)),
    });
  } finally {
    plaintext.fill(0);
  }
}

/**
 * An ephemeral processor transport key, not a data-decryption grant. No device,
 * Domain, or Memory key is received or retained. Restart invalidates old
 * carriers; clients can re-seal their existing preparation to the new key.
 */
export async function createForegroundMemoryProcessorRecipient(input: Readonly<{
  crypto?: LatticeCrypto;
  now?: () => number;
}> = {}) {
  const crypto = input.crypto ?? new LatticeCrypto();
  const now = input.now ?? Date.now;
  const pair = await crypto.generateEncryptionKeyPair();
  const descriptor: MemoryProcessorRecipientV1 = Object.freeze({
    formatVersion: 1,
    purpose: "memory.foreground_embedding",
    recipientId: encode(crypto.hash(pair.publicKey)),
    publicKeyBase64url: encode(pair.publicKey),
  });
  let disposed = false;
  return Object.freeze({
    descriptor,
    dispose() {
      disposed = true;
      pair.privateKey.fill(0);
    },
    async open(request: unknown, binding: RequestBinding): Promise<string | null> {
      const parsed = memoryProcessorSealedRequestV1Schema.safeParse(request);
      if (disposed || !parsed.success
        || parsed.data.recipientId !== descriptor.recipientId) return null;
      let plaintext: Uint8Array | null = null;
      try {
        plaintext = await crypto.openSealed(pair.privateKey,
          decode(parsed.data.ciphertextBase64url));
        if (plaintext === null || disposed) return null;
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true })
          .decode(plaintext));
        if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
        const body = value as Record<string, unknown>;
        const time = now();
        if (Object.keys(body).sort().join(",")
            !== "deadlineAt,formatVersion,issuedAt,payload,purpose,recipientId,subjectId"
          || body["formatVersion"] !== 1
          || body["recipientId"] !== descriptor.recipientId
          || body["purpose"] !== binding.purpose
          || body["subjectId"] !== binding.subjectId
          || typeof body["payload"] !== "string"
          || typeof body["issuedAt"] !== "number" || !Number.isSafeInteger(body["issuedAt"])
          || typeof body["deadlineAt"] !== "number" || !Number.isSafeInteger(body["deadlineAt"])
          || body["issuedAt"] < 0 || body["issuedAt"] > time || body["deadlineAt"] <= time
          || body["deadlineAt"] - body["issuedAt"] <= 0
          || body["deadlineAt"] - body["issuedAt"] > MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS
        ) return null;
        return body["payload"];
      } catch {
        // Do not log malformed input, disclosed text, or decrypted request data.
        return null;
      } finally {
        plaintext?.fill(0);
      }
    },
  });
}
