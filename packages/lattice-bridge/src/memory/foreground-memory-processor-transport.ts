import {
  memoryEmbeddingDisclosureV2Schema,
  memoryProcessorRecipientV1Schema,
  memoryProcessorRecipientV2Schema,
  memoryProcessorSealedRequestV1Schema,
  type MemoryEmbeddingDisclosureV2,
  type MemoryProcessorRecipientV1,
  type MemoryProcessorRecipientV2,
  type MemoryProcessorRequestPurposeV1,
  type MemoryProcessorSealedRequestV1,
} from "@nautilo/api-client/browser";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  assertMemoryEmbeddingDisclosureV2,
  decodeMemoryEmbeddingDisclosureV2,
  encodeMemoryEmbeddingDisclosureV2,
} from "@nautilo/lattice-crypto/wire";
import {
  MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS,
  MEMORY_QUERY_EMBEDDING_MAX_BYTES,
} from
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

export type MemoryProcessorSearchQueryV2 = Readonly<{
  formatVersion: 2;
  purpose: "memory.query_embedding";
  query: string;
  embeddingDisclosure: MemoryEmbeddingDisclosureV2;
}>;

export function encodeMemoryProcessorSearchQueryV2(
  value: MemoryProcessorSearchQueryV2,
): string {
  if (value.formatVersion !== 2 || value.purpose !== "memory.query_embedding"
    || typeof value.query !== "string" || value.query.trim().length === 0
    || new TextEncoder().encode(value.query).length > MEMORY_QUERY_EMBEDDING_MAX_BYTES) {
    throw new TypeError("Memory processor search query V2 is invalid");
  }
  assertMemoryEmbeddingDisclosureV2(value.embeddingDisclosure);
  return JSON.stringify({
    formatVersion: 2,
    purpose: "memory.query_embedding",
    query: value.query,
    embeddingDisclosure: value.embeddingDisclosure,
  });
}

export function decodeMemoryProcessorSearchQueryV2(
  encoded: string,
): MemoryProcessorSearchQueryV2 {
  if (typeof encoded !== "string") {
    throw new TypeError("Memory processor search query V2 is invalid");
  }
  const value: unknown = JSON.parse(encoded);
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(",")
      !== "embeddingDisclosure,formatVersion,purpose,query") {
    throw new TypeError("Memory processor search query V2 is invalid");
  }
  const body = value as Record<string, unknown>;
  if (body["formatVersion"] !== 2 || body["purpose"] !== "memory.query_embedding"
    || typeof body["query"] !== "string" || body["query"].trim().length === 0
    || new TextEncoder().encode(body["query"]).length > MEMORY_QUERY_EMBEDDING_MAX_BYTES) {
    throw new TypeError("Memory processor search query V2 is invalid");
  }
  assertMemoryEmbeddingDisclosureV2(body["embeddingDisclosure"]);
  const disclosureBytes = encodeMemoryEmbeddingDisclosureV2(
    memoryEmbeddingDisclosureV2Schema.parse(body["embeddingDisclosure"]),
  );
  try {
    const normalized = Object.freeze({
      formatVersion: 2 as const,
      purpose: "memory.query_embedding" as const,
      query: body["query"],
      embeddingDisclosure: decodeMemoryEmbeddingDisclosureV2(disclosureBytes),
    });
    if (encodeMemoryProcessorSearchQueryV2(normalized) !== encoded) {
      throw new TypeError("Memory processor search query V2 is noncanonical");
    }
    return normalized;
  } finally { disclosureBytes.fill(0); }
}

async function sealRequest(input: RequestBinding & Readonly<{
  crypto: LatticeCrypto;
  recipient: MemoryProcessorRecipientV1 | MemoryProcessorRecipientV2;
  payload: string;
  now?: () => number;
}>): Promise<MemoryProcessorSealedRequestV1> {
  const publicKey = decode(input.recipient.publicKeyBase64url);
  if (encode(input.crypto.hash(publicKey)) !== input.recipient.recipientId) {
    throw new TypeError("Memory processor recipient fingerprint mismatch");
  }
  const issuedAt = (input.now ?? Date.now)();
  const plaintext = new TextEncoder().encode(JSON.stringify({
    formatVersion: 1,
    recipientId: input.recipient.recipientId,
    purpose: input.purpose,
    subjectId: input.subjectId,
    issuedAt,
    deadlineAt: issuedAt + MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS,
    payload: input.payload,
  }));
  try {
    return Object.freeze({
      formatVersion: 1,
      recipientId: input.recipient.recipientId,
      ciphertextBase64url: encode(await input.crypto.sealTo(publicKey, plaintext)),
    });
  } finally {
    plaintext.fill(0);
  }
}

/** Seal at send time: a prepared mutation journal never owns a server key. */
export async function sealForegroundMemoryProcessorRequest(input: RequestBinding & Readonly<{
  crypto: LatticeCrypto;
  recipient: MemoryProcessorRecipientV1;
  payload: string;
  now?: () => number;
}>): Promise<MemoryProcessorSealedRequestV1> {
  const recipient = memoryProcessorRecipientV1Schema.parse(input.recipient);
  return sealRequest({ ...input, recipient });
}

export async function sealForegroundMemoryProcessorRequestV2(
  input: RequestBinding & Readonly<{
    crypto: LatticeCrypto;
    recipient: MemoryProcessorRecipientV2;
    payload: string;
    now?: () => number;
  }>,
): Promise<MemoryProcessorSealedRequestV1> {
  const recipient = memoryProcessorRecipientV2Schema.parse(input.recipient);
  return sealRequest({ ...input, recipient });
}

export async function sealForegroundMemoryProcessorSearchQueryV2(
  input: Omit<Parameters<typeof sealForegroundMemoryProcessorRequestV2>[0],
    "purpose" | "payload"> & Readonly<{
      query: string;
      embeddingDisclosure: MemoryEmbeddingDisclosureV2;
    }>,
): Promise<MemoryProcessorSealedRequestV1> {
  return sealForegroundMemoryProcessorRequestV2({
    ...input,
    purpose: "memory.query_embedding",
    payload: encodeMemoryProcessorSearchQueryV2({
      formatVersion: 2,
      purpose: "memory.query_embedding",
      query: input.query,
      embeddingDisclosure: input.embeddingDisclosure,
    }),
  });
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
