import { sha256 } from "@noble/hashes/sha2.js";

import type {
  AgentMemoryEmbedding,
} from "../../memory/active-memory-composition.ts";
import type {
  ProtectedMemoryAuthority,
} from "../../memory/active-memory-repository.ts";

const encoder = new TextEncoder();

function digest(value: unknown): Uint8Array {
  return sha256(encoder.encode(JSON.stringify(value)));
}

export function backgroundMemoryOutputRequestDigest(input: Readonly<{
  publicationIdempotencyId: string;
  action: "create" | "replace";
  descriptorHash: Uint8Array;
  authority: ProtectedMemoryAuthority;
  memoryId: string;
  expectedContentRevision: number;
  expectedCryptoAccessRevision: number;
  nextContentRevision: number;
  cryptoObjectId: string;
  requiredNamespaceIds: readonly string[];
  createdAt: number;
  embedding: AgentMemoryEmbedding;
  importance: number;
}>): Uint8Array {
  return digest({
    kind: "background-output",
    publicationIdempotencyId: input.publicationIdempotencyId,
    action: input.action,
    descriptorHash: Array.from(input.descriptorHash),
    authority: input.authority,
    memoryId: input.memoryId,
    expectedContentRevision: input.expectedContentRevision,
    expectedCryptoAccessRevision: input.expectedCryptoAccessRevision,
    nextContentRevision: input.nextContentRevision,
    cryptoObjectId: input.cryptoObjectId,
    requiredNamespaceIds: input.requiredNamespaceIds,
    createdAt: input.createdAt,
    embedding: {
      vector: input.embedding.vector,
      provider: input.embedding.provider,
      canonicalModel: input.embedding.canonicalModel,
      dimensions: input.embedding.dimensions,
      contractVersion: input.embedding.contractVersion,
    },
    importance: input.importance,
  });
}

export function backgroundMemoryTierRequestDigest(input: Readonly<{
  operationIdempotencyId: string;
  descriptorHash: Uint8Array;
  authority: ProtectedMemoryAuthority;
  memoryId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  cryptoObjectId: string;
  action: "promote" | "demote";
  expectedTier: 1 | 2;
  nextTier: 1 | 2 | 3;
  requiredNamespaceIds: readonly string[];
}>): Uint8Array {
  return digest({
    kind: "background-tier",
    operationIdempotencyId: input.operationIdempotencyId,
    descriptorHash: Array.from(input.descriptorHash),
    authority: input.authority,
    memoryId: input.memoryId,
    contentRevision: input.contentRevision,
    cryptoAccessRevision: input.cryptoAccessRevision,
    cryptoObjectId: input.cryptoObjectId,
    action: input.action,
    expectedTier: input.expectedTier,
    nextTier: input.nextTier,
    requiredNamespaceIds: input.requiredNamespaceIds,
  });
}
