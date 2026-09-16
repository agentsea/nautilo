import {
  and, asc, eq, cryptoObjects, objectCryptoAccessHeads,
  objectCryptoAccessManifests, objectCryptoNamespaceEnvelopes,
} from "@nautilo/db";
import {
  accessRevision, objectId, verifyCommonObjectAccessManifestChain,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import type { ForegroundAgentMemoryNativeExactAccessPublication } from
  "../../memory/agent-memory-exact-access.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2,
} from "@nautilo/lattice-crypto/wire";

import {
  lockCurrentMemoryNativeAccessEntries,
  memoryNativeAccessEntriesAuthentic,
} from
  "./native-memory-access-authority.ts";
import {
  assertVerifiedCryptoPostgresHandle, cryptoTypedDb,
  executeTypedCryptoQuery, withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresExecutor, type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { ResolveHistoricalAgentRuntimeSignerManagerAuthority } from
  "../storage/agent-runtime-signer-history.ts";
import type { ResolveLiveShadowAgentObjectSigner } from
  "../storage/postgres-object-access-manifest-v5.ts";
import {
  destroyVerifiedStoredObjectAccessManifestChainV5,
  verifyStoredObjectAccessManifestChainV5,
} from "../storage/postgres-object-access-manifest-v5.ts";

type Head = Readonly<{
  payloadHash: Uint8Array;
  accessRevision: number;
  manifestHash: Uint8Array;
  manifestBytes: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
}>;

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function readHead(
  executor: CryptoPostgresExecutor,
  id: string,
): Promise<Head | null> {
  const rows = await executeTypedCryptoQuery(executor,
    cryptoTypedDb.select({
      payload_hash: cryptoObjects.payloadHash,
      access_revision: objectCryptoAccessHeads.accessRevision,
      manifest_hash: objectCryptoAccessHeads.manifestHash,
      manifest_bytes: objectCryptoAccessManifests.manifestBytes,
    }).from(objectCryptoAccessHeads).innerJoin(objectCryptoAccessManifests, and(
      eq(objectCryptoAccessManifests.objectId, objectCryptoAccessHeads.objectId),
      eq(objectCryptoAccessManifests.accessRevision,
        objectCryptoAccessHeads.accessRevision),
      eq(objectCryptoAccessManifests.manifestHash,
        objectCryptoAccessHeads.manifestHash),
    )).innerJoin(cryptoObjects,
      eq(cryptoObjects.objectId, objectCryptoAccessHeads.objectId))
      .where(eq(objectCryptoAccessHeads.objectId, id)).limit(2)
      .for("update", { of: objectCryptoAccessHeads }));
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("Agent Memory crypto head is not unique");
  const row = rows[0]!;
  const revision = Number(row.access_revision);
  const envelopes = await executeTypedCryptoQuery(executor,
    cryptoTypedDb.select({
      ordinal: objectCryptoNamespaceEnvelopes.ordinal,
      envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    }).from(objectCryptoNamespaceEnvelopes).where(and(
      eq(objectCryptoNamespaceEnvelopes.objectId, id),
      eq(objectCryptoNamespaceEnvelopes.accessRevision, revision),
    )).orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal))
      .limit(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2 + 1));
  if (envelopes.length > HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2
    || envelopes.some((value, index) =>
    Number(value.ordinal) !== index)) throw new Error(
      "Agent Memory crypto envelope inventory is invalid",
    );
  return Object.freeze({
    payloadHash: Uint8Array.from(row.payload_hash),
    accessRevision: revision,
    manifestHash: Uint8Array.from(row.manifest_hash),
    manifestBytes: Uint8Array.from(row.manifest_bytes),
    envelopeBytes: Object.freeze(envelopes.map((value) =>
      Uint8Array.from(value.envelope_bytes))),
  });
}

function targetMatches(head: Head, publication: ForegroundAgentMemoryNativeExactAccessPublication) {
  return head.accessRevision === publication.nextAccessRevision
    && same(head.payloadHash, publication.payloadHash)
    && same(head.manifestHash, publication.nextManifestHash)
    && same(head.manifestBytes, publication.nextManifestBytes)
    && head.envelopeBytes.length === publication.targetEnvelopeBytes.length
    && head.envelopeBytes.every((value, index) =>
      same(value, publication.targetEnvelopeBytes[index]!));
}

function envelopeSetMatchesEntries(input: Readonly<{
  crypto: LatticeCrypto;
  objectId: string;
  bytes: readonly Uint8Array[];
  entries: ForegroundAgentMemoryNativeExactAccessPublication["currentEntries"];
}>): boolean {
  const byNamespace = new Map(input.entries.map((entry) => [entry.namespaceId as string, entry]));
  const seen = new Set<string>();
  return input.bytes.length === input.entries.length
    && byNamespace.size === input.entries.length
    && input.bytes.every((bytes) => {
      const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
      const expected = byNamespace.get(envelope.context.namespaceId);
      if (expected === undefined || seen.has(envelope.context.namespaceId)) return false;
      seen.add(envelope.context.namespaceId);
      return envelope.context.objectId === input.objectId
        && envelope.context.keyClass === "ai"
        && envelope.context.namespaceId === expected.namespaceId
        && envelope.context.keyGeneration === expected.keyGeneration
        && envelope.context.bindingRevisionAtWrap
          === expected.namespaceAccessRevision
        && same(input.crypto.hash(bytes), expected.envelopeHash);
    });
}

/** Restricted native-V2 persistence for one foreground Agent Memory N+1 head. */
export async function persistForegroundAgentMemoryNativeExactAccess(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  publication: ForegroundAgentMemoryNativeExactAccessPublication;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  resolveLiveShadowAgentSigner: ResolveLiveShadowAgentObjectSigner;
  resolveCurrentAgentSigner(principal: Readonly<{
    agentId: string;
    runtimeGeneration: number;
    signerKeyId: string;
  }>): Uint8Array | null;
}>): Promise<"created" | "duplicate" | "stale"> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  return withVerifiedCryptoPostgresTransaction(input.handle, async (executor) => {
    const current = await readHead(executor, input.publication.objectId);
    if (current === null) return "stale";
    if (targetMatches(current, input.publication)) return "duplicate";
    if (
      current.accessRevision !== input.publication.expectedAccessRevision
      || input.publication.nextAccessRevision !== current.accessRevision + 1
      || !same(current.payloadHash, input.publication.payloadHash)
      || !same(current.manifestHash, input.publication.currentManifestHash)
      || !envelopeSetMatchesEntries({ crypto: input.crypto,
        objectId: input.publication.objectId, bytes: current.envelopeBytes,
        entries: input.publication.currentEntries })
      || input.publication.targetEnvelopeBytes.length
        !== input.publication.targetEntries.length
    ) return "stale";
    const targetEntries = new Map(input.publication.targetEntries.map((entry) =>
      [entry.namespaceId as string, entry]));
    const seenTargets = new Set<string>();
    const targetEnvelopes = input.publication.targetEnvelopeBytes.map(
      (bytes) => {
        const decoded = decodeNamespaceObjectEnvelopeV2(bytes);
        const expected = targetEntries.get(decoded.context.namespaceId);
        if (expected === undefined
          || targetEntries.size !== input.publication.targetEntries.length
          || seenTargets.has(decoded.context.namespaceId)
          || decoded.context.objectId !== input.publication.objectId
          || decoded.context.keyClass !== "ai"
          || decoded.context.namespaceId !== expected.namespaceId
          || decoded.context.keyGeneration !== expected.keyGeneration
          || decoded.context.bindingRevisionAtWrap
            !== expected.namespaceAccessRevision
          || !same(input.crypto.hash(bytes), expected.envelopeHash)) {
          throw new TypeError("Agent Memory exact-access target envelope is invalid");
        }
        seenTargets.add(decoded.context.namespaceId);
        return Object.freeze({ bytes, expected });
      },
    );
    const verifiedCurrent = await verifyStoredObjectAccessManifestChainV5({
      executor, crypto: input.crypto, objectId: input.publication.objectId,
      headAccessRevision: current.accessRevision,
      expectedPayloadHash: current.payloadHash,
      expectedHeadManifestHash: current.manifestHash,
      resolveHistoricalAgentManagerAuthority:
        input.resolveHistoricalAgentSignerAuthority,
      resolveLiveShadowAgentSigner: input.resolveLiveShadowAgentSigner,
    });
    destroyVerifiedStoredObjectAccessManifestChainV5(verifiedCurrent);
    if (
      !await memoryNativeAccessEntriesAuthentic({
        executor, entries: input.publication.currentEntries,
      })
      || !await lockCurrentMemoryNativeAccessEntries({
        executor, entries: input.publication.targetEntries,
      })
    ) return "stale";
    const verifiedNext = verifyCommonObjectAccessManifestChain(input.crypto, {
      manifestBytes: input.publication.nextManifestBytes,
      proof: [],
      trustedMinimumHead: {
        objectId: objectId(input.publication.objectId),
        payloadHash: input.publication.payloadHash,
        accessRevision: accessRevision(input.publication.expectedAccessRevision),
        manifestHash: input.publication.currentManifestHash,
      },
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveAgentRuntimeSignerPublicKey: input.resolveCurrentAgentSigner,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    });
    if (
      verifiedNext.manifest.accessRevision !== input.publication.nextAccessRevision
      || verifiedNext.manifest.previousManifestHash === null
      || !same(verifiedNext.manifest.previousManifestHash,
        input.publication.currentManifestHash)
      || !same(verifiedNext.manifestHash, input.publication.nextManifestHash)
      || verifiedNext.manifest.envelopeHashes.length !== targetEnvelopes.length
      || verifiedNext.manifest.envelopeHashes.some((hash, ordinal) =>
        !same(hash, targetEnvelopes[ordinal]!.expected.envelopeHash))
    ) return "stale";
    await executeTypedCryptoQuery(executor,
      cryptoTypedDb.insert(objectCryptoAccessManifests).values({
        objectId: input.publication.objectId,
        accessRevision: input.publication.nextAccessRevision,
        manifestHash: input.publication.nextManifestHash,
        previousManifestHash: input.publication.currentManifestHash,
        payloadHash: input.publication.payloadHash,
        manifestBytes: input.publication.nextManifestBytes,
      }));
    for (const [ordinal, target] of targetEnvelopes.entries()) {
      await executeTypedCryptoQuery(executor,
        cryptoTypedDb.insert(objectCryptoNamespaceEnvelopes).values({
          objectId: input.publication.objectId,
          accessRevision: input.publication.nextAccessRevision,
          namespaceId: target.expected.namespaceId, ordinal,
          envelopeHash: target.expected.envelopeHash,
          envelopeBytes: target.bytes,
        }));
    }
    const advanced = await executeTypedCryptoQuery(executor,
      cryptoTypedDb.update(objectCryptoAccessHeads).set({
        accessRevision: input.publication.nextAccessRevision,
        manifestHash: input.publication.nextManifestHash,
      }).where(and(
        eq(objectCryptoAccessHeads.objectId, input.publication.objectId),
        eq(objectCryptoAccessHeads.accessRevision,
          input.publication.expectedAccessRevision),
        eq(objectCryptoAccessHeads.manifestHash,
          input.publication.currentManifestHash),
      )).returning({ object_id: objectCryptoAccessHeads.objectId }));
    if (advanced.length !== 1) {
      throw new Error("Agent Memory exact-access head CAS failed");
    }
    const reopened = await readHead(executor, input.publication.objectId);
    if (reopened === null || !targetMatches(reopened, input.publication)) {
      throw new Error("Agent Memory exact-access durable parity failed");
    }
    return "created";
  });
}
