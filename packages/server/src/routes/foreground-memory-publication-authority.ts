import {
  MemoryMutationAuthorityError,
  protectedMemoryAuthorityFromEnvelope,
  revalidateMemoryMutationAuthority,
} from "@nautilo/agent";
import { acquireEncryptionPublicationFence } from "@nautilo/db";
import { selectLiveEncryptionRepresentationPolicy } from "@nautilo/lattice-bridge";
import type { AgentMemoryPublicationBoundary } from "@nautilo/lattice-bridge/server";
import { isScopeMemoryEnvelope, type MemoryAccessEnvelope } from "@nautilo/trust";

/** Selected foreground policy + trust envelope, rechecked in the product tx. */
export function createForegroundMemoryPublicationAuthority(input: Readonly<{
  envelope: MemoryAccessEnvelope;
  policy: Readonly<{
    mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
    shadowBehavior: "fallback" | "strict";
    revision: number;
  }>;
}>): Readonly<{
  representation: "ordinary_and_protected" | "protected_only";
  allowOrdinaryFallback: boolean;
  beforeLocks: AgentMemoryPublicationBoundary["beforeLocks"];
}> {
  if (isScopeMemoryEnvelope(input.envelope)) {
    throw new MemoryMutationAuthorityError("memory_unavailable");
  }
  const envelope = Object.freeze({ ...input.envelope,
    readableNamespaces: [...input.envelope.readableNamespaces],
    mutableNamespaces: [...input.envelope.mutableNamespaces],
    writableNamespaces: [...input.envelope.writableNamespaces],
  });
  Object.freeze(envelope.readableNamespaces);
  Object.freeze(envelope.mutableNamespaces);
  Object.freeze(envelope.writableNamespaces);
  const bound = protectedMemoryAuthorityFromEnvelope(envelope);
  if (bound === null || bound.mode !== "namespace") {
    throw new MemoryMutationAuthorityError("memory_unavailable");
  }
  const { write: representation, allowOrdinaryFallback } =
    selectLiveEncryptionRepresentationPolicy(input.policy);
  if (representation === "ordinary_only") {
    throw new TypeError("Plaintext Memory must use its ordinary publication path");
  }
  const revision = input.policy.revision;
  const sameIds = (left: readonly string[], right: readonly string[]) => {
    const expected = [...right].sort();
    return left.length === expected.length
      && [...left].sort().every((id, index) => id === expected[index]);
  };
  return Object.freeze({
    representation,
    allowOrdinaryFallback,
    beforeLocks: async ({ transaction, authority, mutation }) => {
      if (authority.mode !== "namespace" || authority.subjectUserId !== bound.subjectUserId
        || authority.agentId !== bound.agentId
        || authority.writableNamespaceId !== bound.writableNamespaceId
        || !sameIds(authority.readableNamespaceIds, bound.readableNamespaceIds)
        || !sameIds(authority.mutableNamespaceIds, bound.mutableNamespaceIds)) {
        throw new MemoryMutationAuthorityError("memory_unavailable");
      }
      // Global policy fence always precedes Room, membership and entity locks.
      await acquireEncryptionPublicationFence(transaction, {
        expectedRevision: revision, representation,
      });
      await revalidateMemoryMutationAuthority(transaction, {
        envelope, speakerUserId: bound.subjectUserId, mutation,
      });
    },
  });
}
