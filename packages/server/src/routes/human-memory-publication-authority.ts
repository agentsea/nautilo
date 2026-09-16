import { MemoryMutationAuthorityError, revalidateHumanMemoryMutationAuthority } from "@nautilo/agent";
import { acquireEncryptionPublicationFence } from "@nautilo/db";
import { selectLiveEncryptionRepresentationPolicy } from "@nautilo/lattice-bridge";
import type {
  HumanMemoryPublicationBoundary,
  PostgresHumanMemoryAuthorityResolver,
} from "@nautilo/lattice-bridge/server";
import { isScopeMemoryEnvelope, type MemoryAccessEnvelope } from "@nautilo/trust";

/** One authenticated library request's policy and publication authority.
 * The Agent in its surrounding envelope is not the acting principal. */
export function createHumanMemoryPublicationAuthority(input: Readonly<{
  envelope: MemoryAccessEnvelope;
  policy: Readonly<{
    mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
    shadowBehavior: "fallback" | "strict";
    revision: number;
  }>;
  cryptoAuthority: Pick<PostgresHumanMemoryAuthorityResolver,
    "withCurrentWriteAuthority" | "withCurrentOrdinaryWriteAuthority">;
}>): HumanMemoryPublicationBoundary {
  if (isScopeMemoryEnvelope(input.envelope)) {
    throw new MemoryMutationAuthorityError("memory_unavailable");
  }
  const envelope = { ...input.envelope,
    readableNamespaces: [...input.envelope.readableNamespaces],
    mutableNamespaces: [...input.envelope.mutableNamespaces],
    writableNamespaces: [...input.envelope.writableNamespaces] };
  const revision = input.policy.revision;
  const { write: representation, allowOrdinaryFallback } =
    selectLiveEncryptionRepresentationPolicy(input.policy);
  if (representation === "ordinary_only") {
    throw new TypeError("Plaintext Memory must use its ordinary publication path");
  }
  const sameIds = (left: readonly string[], right: readonly string[]) => {
    const expected = [...right].sort();
    return left.length === expected.length
      && [...left].sort().every((id, i) => id === expected[i]);
  };
  const assertAuthority = (authority: Parameters<HumanMemoryPublicationBoundary["fence"]>[0]["authority"]) => {
    if (authority.userId !== envelope.ownerId
      || !sameIds(authority.mutableNamespaceIds, envelope.mutableNamespaces)
      || !sameIds(authority.writableNamespaceIds, envelope.writableNamespaces)) {
      throw new MemoryMutationAuthorityError("memory_unavailable");
    }
  };
  return Object.freeze({
    representation,
    allowOrdinaryFallback,
    policyRevision: revision,
    async fence({ transaction, authority, mutation }) {
      assertAuthority(authority);
      await acquireEncryptionPublicationFence(transaction, {
        expectedRevision: revision, representation,
      });
      await revalidateHumanMemoryMutationAuthority(transaction, {
        envelope, speakerUserId: envelope.ownerId, mutation,
      });
    },
    async withLocks({ authority, preparedAuthority, certificate }, publish) {
      assertAuthority(authority);
      return input.cryptoAuthority.withCurrentWriteAuthority({
        subjectUserId: authority.userId,
        humanActorId: envelope.actorId,
        context: { ...preparedAuthority,
          purpose: certificate.expectedContentRevision === 0
            ? "authorize-current-human-memory-create-persistence"
            : "authorize-current-human-memory-update-persistence",
          productAllocation: certificate,
        },
      }, publish);
    },
    async withOrdinaryLocks({ authority, authenticatedAuthority }, publish) {
      assertAuthority(authority);
      if (!allowOrdinaryFallback || authenticatedAuthority.policyRevision !== revision) {
        throw new MemoryMutationAuthorityError("memory_unavailable");
      }
      return input.cryptoAuthority.withCurrentOrdinaryWriteAuthority({
        subjectUserId: authority.userId,
        humanActorId: envelope.actorId,
        context: authenticatedAuthority,
      }, publish);
    },
  });
}
