import {
  type ForegroundAgentEntityCryptoInvocation,
  type ForegroundAgentMemoryNativeExactAccessPublication,
  type ForegroundAgentMemoryNativeExactAccessPlan,
  decodeMemoryPayloadV1,
  type MemoryPayloadV1,
  type ProtectedMemoryAuthority,
  type ProtectedAgentMemoryAccessPort,
  type ProtectedMemoryResult,
  type VerifiedForegroundAgentObject,
} from "@nautilo/lattice-bridge";
import {
  accessRevision,
  authorizationRevision,
  createCommonAgentObjectAccessManifest,
  decryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  openObjectDekForNamespace,
  wrapObjectDekForNamespace,
  type AgentRuntimeKeyGeneration,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  type MemoryNativeNamespaceAccessEntryV1,
  decodeNamespaceObjectEnvelopeV2,
  decodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type ForegroundDomainMemoryAccessHead = VerifiedForegroundAgentObject &
  Readonly<{
    payloadHash: Uint8Array;
    accessManifestBytes: Uint8Array;
    accessManifestHash: Uint8Array;
    nativeEntries: readonly MemoryNativeNamespaceAccessEntryV1[];
  }>;

declare const preparedBrand: unique symbol;
export type PreparedForegroundDomainMemoryExactAccess = Readonly<{
  [preparedBrand]: true;
}>;

export type ForegroundDomainMemoryExactAccessPublication =
  ForegroundAgentMemoryNativeExactAccessPublication;

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let delta = 0;
  for (let index = 0; index < left.length; index += 1) {
    delta |= left[index]! ^ right[index]!;
  }
  return delta === 0;
}

function sameEntryAuthority(
  authority: Parameters<Parameters<
    ForegroundAgentEntityCryptoInvocation["useCurrentSet"]
  >[0]["execute"]>[0][number]["authority"],
  expected: MemoryNativeNamespaceAccessEntryV1,
): boolean {
  return authority.namespaceId === expected.namespaceId
    && authority.namespaceKeyGeneration === expected.keyGeneration
    && authority.namespaceAccessRevision === expected.namespaceAccessRevision
    && sameBytes(authority.namespaceHeadDigest, expected.headDigest)
    && sameBytes(authority.namespacePublicationDigest, expected.publicationDigest)
    && sameBytes(
      authority.namespacePublicationSetDigest,
      expected.publicationSetDigest,
    )
    && sameBytes(
      authority.namespaceAudienceFingerprint,
      expected.audienceFingerprint,
    );
}

function wipeHead(value: ForegroundDomainMemoryAccessHead): void {
  value.payloadBytes.fill(0);
  value.payloadHash.fill(0);
  value.accessManifestBytes.fill(0);
  value.accessManifestHash.fill(0);
  value.namespaceEnvelopes.forEach((entry) => entry.envelopeBytes.fill(0));
  value.nativeEntries.forEach((entry) => {
    entry.headDigest.fill(0);
    entry.publicationDigest.fill(0);
    entry.publicationSetDigest.fill(0);
    entry.audienceFingerprint.fill(0);
    entry.envelopeHash.fill(0);
  });
}

function canonicalIds(value: readonly string[]): readonly string[] | null {
  if (
    value.length < 1
    || value.some((id, index) => index > 0 && value[index - 1]! >= id)
  ) return null;
  return Object.freeze([...value]);
}

function entry(
  authority: Parameters<Parameters<
    ForegroundAgentEntityCryptoInvocation["use"]
  >[0]["execute"]>[0]["authority"],
  envelopeHash: Uint8Array,
): MemoryNativeNamespaceAccessEntryV1 {
  return Object.freeze({
    namespaceId: namespaceId(authority.namespaceId),
    keyGeneration: authority.namespaceKeyGeneration,
    namespaceAccessRevision: authority.namespaceAccessRevision,
    headDigest: authority.namespaceHeadDigest.slice(),
    publicationDigest: authority.namespacePublicationDigest.slice(),
    publicationSetDigest: authority.namespacePublicationSetDigest.slice(),
    audienceFingerprint: authority.namespaceAudienceFingerprint.slice(),
    envelopeHash: envelopeHash.slice(),
  });
}

/**
 * Prepares one native Domain-V2 Memory access-head replacement while the
 * current foreground invocation holds every target Namespace authority. The
 * returned bytes are public ciphertext/authentication data; no Namespace key
 * or object DEK escapes the callback.
 */
export function createForegroundDomainMemoryExactAccess(input: Readonly<{
  crypto: LatticeCrypto;
  entities: Pick<ForegroundAgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet">;
  runtime: AgentRuntimeKeyGeneration;
  signerKeyId: string;
  agentAuthorizationRevision: number;
  read(request: Readonly<{
    objectId: string;
    expectedAccessRevision: number;
    expectedNamespaceIds: readonly string[];
  }>): Promise<ForegroundDomainMemoryAccessHead | null>;
}>): Readonly<{
  prepare(request: Readonly<{
    objectId: string;
    expectedAccessRevision: number;
    currentNamespaceIds: readonly string[];
    targetNamespaceIds: readonly string[];
  }>): Promise<PreparedForegroundDomainMemoryExactAccess | null>;
  authorizeCommit<Value>(request: Readonly<{
    prepared: PreparedForegroundDomainMemoryExactAccess;
    commit(publication: ForegroundDomainMemoryExactAccessPublication):
      Promise<Value> | Value;
  }>): Promise<Value>;
  readPreparedPayload(
    prepared: PreparedForegroundDomainMemoryExactAccess,
  ): MemoryPayloadV1;
  authorizeCurrentHead<Value>(request: Readonly<{
    prepared: PreparedForegroundDomainMemoryExactAccess;
    commit(head: Readonly<{ objectId: string; accessRevision: number;
      namespaceIds: readonly string[]; manifestHash: Uint8Array }>): Promise<Value>;
  }>): Promise<Value>;
}> {
  const snapshots = new WeakMap<object, ForegroundDomainMemoryExactAccessPublication>();
  const payloads = new WeakMap<object, MemoryPayloadV1>();
  const unchangedHeads = new WeakMap<object, Readonly<{
    objectId: string; accessRevision: number; manifestHash: Uint8Array;
    entries: readonly MemoryNativeNamespaceAccessEntryV1[];
  }>>();
  return Object.freeze({
    async prepare(request) {
      const currentIds = canonicalIds(request.currentNamespaceIds);
      const targetIds = canonicalIds(request.targetNamespaceIds);
      if (input.entities.signal.aborted || currentIds === null || targetIds === null) {
        return null;
      }
      const durable = await input.read({
        objectId: request.objectId,
        expectedAccessRevision: request.expectedAccessRevision,
        expectedNamespaceIds: currentIds,
      });
      if (
        durable === null
        || durable.objectId !== request.objectId
        || durable.accessRevision !== request.expectedAccessRevision
        || !sameIds(
          durable.namespaceEnvelopes.map((value) => value.namespaceId).sort(),
          currentIds,
        )
      ) return null;
      let dek: Uint8Array | null = null;
      try {
        if (!sameIds(durable.nativeEntries.map((value) => value.namespaceId).sort(), currentIds)) {
          return null;
        }
        const currentEntries = durable.nativeEntries.map((value) => Object.freeze({
          ...value,
          headDigest: value.headDigest.slice(),
          publicationDigest: value.publicationDigest.slice(),
          publicationSetDigest: value.publicationSetDigest.slice(),
          audienceFingerprint: value.audienceFingerprint.slice(),
          envelopeHash: value.envelopeHash.slice(),
        })).sort((left, right) => left.namespaceId.localeCompare(right.namespaceId));
        for (const envelope of durable.namespaceEnvelopes) {
          const opened = await input.entities.use({
            operations: ["decrypt"],
            entity: {
              namespaceId: envelope.namespaceId,
              keyGeneration: envelope.keyGeneration,
              accessRevision: envelope.bindingRevisionAtWrap,
            },
            execute: ({ namespaceKey }) => {
              const decoded = decodeNamespaceObjectEnvelopeV2(envelope.envelopeBytes);
              try {
                return openObjectDekForNamespace(input.crypto, namespaceKey, decoded);
              } finally {
                decoded.wrappedDek.fill(0);
              }
            },
          });
          if (opened.status === "executed" && opened.value !== null) {
            dek = opened.value;
            break;
          }
        }
        if (dek === null || input.entities.signal.aborted) return null;
        const encryptedPayload = decodeEncryptedPayloadV2(durable.payloadBytes);
        const plaintext = decryptObjectPayload(input.crypto, dek, encryptedPayload);
        encryptedPayload.ciphertext.fill(0);
        if (plaintext === null) return null;
        const payload = decodeMemoryPayloadV1(plaintext);
        plaintext.fill(0);
        if (sameIds(currentIds, targetIds)) {
          // An already-shared approval still authenticates the payload, but it
          // does not mint an unused N+1 manifest or rewrap the unchanged set.
          const handle = Object.freeze({}) as PreparedForegroundDomainMemoryExactAccess;
          payloads.set(handle, payload);
          unchangedHeads.set(handle, Object.freeze({
            objectId: durable.objectId, accessRevision: durable.accessRevision,
            manifestHash: durable.accessManifestHash.slice(), entries: currentEntries,
          }));
          return handle;
        }
        const prepared = await input.entities.useCurrentSet({
          operations: ["encrypt"],
          namespaceIds: targetIds,
          execute: (items) => {
            const ordered = [...items].sort((a, b) =>
              a.authority.namespaceId.localeCompare(b.authority.namespaceId)
            );
            if (!sameIds(ordered.map((item) => item.authority.namespaceId), targetIds)) {
              return null;
            }
            const targetEnvelopeBytes = ordered.map(({ namespaceKey, authority }) =>
              encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
                input.crypto,
                namespaceKey,
                {
                  objectId: objectId(request.objectId),
                  namespaceId: namespaceId(authority.namespaceId),
                  keyClass: "ai",
                  keyGeneration: namespaceGeneration(authority.namespaceKeyGeneration),
                  bindingRevisionAtWrap: accessRevision(authority.namespaceAccessRevision),
                },
                dek!,
              ))
            );
            const targetEntries = ordered.map(({ authority }, index) =>
              entry(authority, input.crypto.hash(targetEnvelopeBytes[index]!))
            );
            const next = createCommonAgentObjectAccessManifest(input.crypto, {
              objectId: objectId(request.objectId),
              payloadHash: durable.payloadHash,
              accessRevision: accessRevision(request.expectedAccessRevision + 1),
              previousManifestHash: durable.accessManifestHash,
              envelopeHashes: targetEntries.map((value) => value.envelopeHash),
              signer: {
                kind: "agent_runtime",
                agentId: input.runtime.agentId,
                runtimeGeneration: input.runtime.generation,
                signerKeyId: input.signerKeyId,
              },
              signerAuthorizationHash: null,
              hostAuthorizationRevision: authorizationRevision(
                input.agentAuthorizationRevision,
              ),
            }, input.runtime);
            // V5 signs envelopes in hash order, independently of the canonical
            // Namespace ordering used for authority and product-set comparison.
            const envelopesByHash = new Map(targetEnvelopeBytes.map((bytes) =>
              [bytesToHex(input.crypto.hash(bytes)), bytes] as const));
            const publication = Object.freeze({
              objectId: request.objectId,
              expectedAccessRevision: request.expectedAccessRevision,
              nextAccessRevision: request.expectedAccessRevision + 1,
              currentEntries: Object.freeze(currentEntries),
              targetEntries: Object.freeze(targetEntries),
              payloadHash: durable.payloadHash.slice(),
              currentManifestHash: durable.accessManifestHash.slice(),
              nextManifestHash: next.hash.slice(),
              nextManifestBytes: next.bytes.slice(),
              targetEnvelopeBytes: Object.freeze(next.manifest.envelopeHashes.map((hash) =>
                envelopesByHash.get(bytesToHex(hash))!.slice())),
            });
            return publication;
          },
        });
        if (prepared.status !== "executed" || prepared.value === null) return null;
        const handle = Object.freeze({}) as PreparedForegroundDomainMemoryExactAccess;
        snapshots.set(handle, prepared.value);
        payloads.set(handle, payload);
        return handle;
      } finally {
        dek?.fill(0);
        wipeHead(durable);
      }
    },
    async authorizeCurrentHead(request) {
      const head = unchangedHeads.get(request.prepared as object);
      if (head === undefined || input.entities.signal.aborted) {
        throw new TypeError("Foreground Memory current head belongs to another invocation");
      }
      const namespaceIds = head.entries.map((entry) => entry.namespaceId);
      const leased = await input.entities.useCurrentSet({
        operations: ["encrypt"], namespaceIds,
        execute: async (items) => {
          const ordered = [...items].sort((a, b) =>
            a.authority.namespaceId.localeCompare(b.authority.namespaceId));
          if (ordered.length !== head.entries.length
            || ordered.some((item, index) => !sameEntryAuthority(item.authority, head.entries[index]!))
            || input.entities.signal.aborted) {
            throw new TypeError("Foreground Memory current-head authority changed");
          }
          return request.commit({ objectId: head.objectId, accessRevision: head.accessRevision,
            namespaceIds, manifestHash: head.manifestHash.slice() });
        },
      });
      if (leased.status !== "executed") {
        throw new TypeError("Foreground Memory current-head authority unavailable");
      }
      return leased.value;
    },
    async authorizeCommit(request) {
      const snapshot = snapshots.get(request.prepared as object);
      if (snapshot === undefined || input.entities.signal.aborted) {
        throw new TypeError(
          "Foreground Memory exact access belongs to another invocation",
        );
      }
      // Hold both the authenticated source inventory and the target inventory.
      // A future detach excludes the removed Namespace from targetEntries, but
      // its source authority must remain fresh until the product/crypto CAS.
      const leasedIds = canonicalIds([...new Set([
        ...snapshot.currentEntries.map((value) => value.namespaceId),
        ...snapshot.targetEntries.map((value) => value.namespaceId),
      ])].sort());
      if (leasedIds === null) {
        throw new TypeError("Foreground Memory exact-access inventory is invalid");
      }
      const leased = await input.entities.useCurrentSet({
        operations: ["encrypt"],
        namespaceIds: leasedIds,
        execute: async (items) => {
          const ordered = [...items].sort((a, b) =>
            a.authority.namespaceId.localeCompare(b.authority.namespaceId)
          );
          const authorityByNamespaceId = new Map(ordered.map((item) =>
            [item.authority.namespaceId, item.authority] as const));
          if (
            ordered.length !== leasedIds.length
            || snapshot.targetEntries.some((target) => {
              const authority = authorityByNamespaceId.get(target.namespaceId);
              return authority === undefined
                || !sameEntryAuthority(authority, target);
            })
            || input.entities.signal.aborted
          ) throw new TypeError("Foreground Memory exact-access authority changed");
          // The canonical product transaction and its crypto-head fence run
          // inside this callback, before the invocation authority is released.
          return request.commit(snapshot);
        },
      });
      if (leased.status !== "executed") {
        throw new TypeError("Foreground Memory exact-access authority unavailable");
      }
      return leased.value;
    },
    readPreparedPayload(prepared) {
      const payload = payloads.get(prepared as object);
      if (payload === undefined) {
        throw new TypeError(
          "Foreground Memory exact access belongs to another invocation",
        );
      }
      return Object.freeze({ ...payload });
    },
  });
}

function exactPlan(
  left: ForegroundAgentMemoryNativeExactAccessPlan,
  right: ForegroundAgentMemoryNativeExactAccessPlan,
): boolean {
  return left.memoryId === right.memoryId
    && left.cryptoObjectId === right.cryptoObjectId
    && left.expectedContentRevision === right.expectedContentRevision
    && left.expectedCryptoAccessRevision === right.expectedCryptoAccessRevision
    && sameIds(left.currentNamespaceIds, right.currentNamespaceIds)
    && sameIds(left.targetNamespaceIds, right.targetNamespaceIds);
}

/** Complete approval-bound Agent Memory sharing port over current Domain V2. */
export function createForegroundDomainProtectedAgentMemoryAccessPort(input: Readonly<{
  subjectUserId: string;
  agentId: string;
  crypto: ReturnType<typeof createForegroundDomainMemoryExactAccess>;
  product: Readonly<{
    planNativeChange(request: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0]):
      Promise<ProtectedMemoryResult<
        | Readonly<{ status: "unchanged"; memoryId: string;
            sourceNamespaceId: string;
            plan: ForegroundAgentMemoryNativeExactAccessPlan }>
        | Readonly<{ status: "prepared"; sourceNamespaceId: string;
            plan: ForegroundAgentMemoryNativeExactAccessPlan }>
      >>;
    commitNativePrepared(request: Readonly<{
      authority: ProtectedMemoryAuthority;
      plan: ForegroundAgentMemoryNativeExactAccessPlan;
      publication: ForegroundAgentMemoryNativeExactAccessPublication;
      persist(): Promise<"created" | "duplicate" | "stale">;
    }>): ReturnType<ProtectedAgentMemoryAccessPort["change"]>;
    reconcileNativeCommitted(request: Readonly<{
      authority: ProtectedMemoryAuthority;
      plan: ForegroundAgentMemoryNativeExactAccessPlan;
      head: Readonly<{ objectId: string; accessRevision: number;
        namespaceIds: readonly string[]; manifestHash: Uint8Array }>;
    }>): Promise<boolean>;
  }>;
  persist(publication: ForegroundAgentMemoryNativeExactAccessPublication):
    Promise<"created" | "duplicate" | "stale">;
}>): ProtectedAgentMemoryAccessPort {
  // Invocation-local: preparing another tool in an approval batch must not
  // replace the authority retained for an earlier tool.
  const approved = new Map<string, Readonly<{
    referenceId: string;
    toolCallId: string;
    actionHandle: string;
    plan: ForegroundAgentMemoryNativeExactAccessPlan;
    prepared: PreparedForegroundDomainMemoryExactAccess;
    unchanged: boolean;
  }>>();
  return Object.freeze({
    async prepareApproval(request: Parameters<NonNullable<
      ProtectedAgentMemoryAccessPort["prepareApproval"]
    >>[0]) {
      approved.delete(request.toolCallId);
      if (request.authority.subjectUserId !== input.subjectUserId
        || request.authority.agentId !== input.agentId) {
        return Object.freeze({ status: "unavailable" as const,
          reason: "authorization_required" as const });
      }
      let planned = await input.product.planNativeChange({
        operationId: request.operationId, authority: request.authority,
        memoryId: request.memoryId, action: request.action,
      });
      if (planned.status === "unavailable") return planned;
      let prepared = await input.crypto.prepare({
        objectId: planned.value.plan.cryptoObjectId,
        expectedAccessRevision:
          planned.value.plan.expectedCryptoAccessRevision,
        currentNamespaceIds: planned.value.plan.currentNamespaceIds,
        targetNamespaceIds: planned.value.plan.targetNamespaceIds,
      });
      if (prepared === null && planned.value.status === "prepared") {
        // Crypto and product have separate durable commits. A fresh invocation
        // may finish the exact old receipt if crypto already reached N+1, but
        // must never replay the write or abandon an in-flight reservation at N.
        const originalPlan = planned.value.plan;
        const committedHead = await input.crypto.prepare({
          objectId: originalPlan.cryptoObjectId,
          expectedAccessRevision: originalPlan.nextCryptoAccessRevision,
          currentNamespaceIds: originalPlan.targetNamespaceIds,
          targetNamespaceIds: originalPlan.targetNamespaceIds,
        });
        if (committedHead !== null && await input.crypto.authorizeCurrentHead({
          prepared: committedHead,
          commit: (head) => input.product.reconcileNativeCommitted({
            authority: request.authority, plan: originalPlan, head,
          }),
        })) {
          planned = await input.product.planNativeChange({
            operationId: request.operationId, authority: request.authority,
            memoryId: request.memoryId, action: request.action,
          });
          if (planned.status === "unavailable") return planned;
          prepared = await input.crypto.prepare({
            objectId: planned.value.plan.cryptoObjectId,
            expectedAccessRevision: planned.value.plan.expectedCryptoAccessRevision,
            currentNamespaceIds: planned.value.plan.currentNamespaceIds,
            targetNamespaceIds: planned.value.plan.targetNamespaceIds,
          });
        }
      }
      if (prepared === null) return Object.freeze({
        status: "unavailable" as const,
        reason: "target_encryption_not_ready" as const,
      });
      const referenceId = Array.from(sha256(new TextEncoder().encode(JSON.stringify({
        operationId: request.operationId, toolCallId: request.toolCallId,
        requesterUserId: input.subjectUserId, agentId: input.agentId,
        memoryId: request.memoryId, action: request.action,
        objectId: planned.value.plan.cryptoObjectId,
        contentRevision: planned.value.plan.expectedContentRevision,
        accessRevision: planned.value.plan.expectedCryptoAccessRevision,
        currentNamespaceIds: planned.value.plan.currentNamespaceIds,
        targetNamespaceIds: planned.value.plan.targetNamespaceIds,
        currentRequiredNamespaceFingerprint:
          Array.from(planned.value.plan.currentRequiredNamespaceFingerprint),
        targetRequiredNamespaceFingerprint:
          Array.from(planned.value.plan.targetRequiredNamespaceFingerprint),
      }))), (byte) => byte.toString(16).padStart(2, "0")).join("");
      approved.set(request.toolCallId, Object.freeze({ referenceId, toolCallId: request.toolCallId,
        actionHandle: request.action.userHandle, unchanged: planned.value.status === "unchanged",
        plan: planned.value.plan, prepared }));
      const payload = input.crypto.readPreparedPayload(prepared);
      return Object.freeze({ status: "success" as const, value: Object.freeze({
        reference: Object.freeze({ referenceVersion: 1 as const, referenceId,
          toolCallId: request.toolCallId,
          requesterUserId: input.subjectUserId, agentId: input.agentId }),
        preview: Object.freeze({ type: payload.type, content: payload.content }),
      }) });
    },
    async change(request: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0]) {
      const retained = request.approvalReference === undefined
        ? undefined
        : approved.get(request.approvalReference.toolCallId);
      if (retained === undefined
        || request.authority.subjectUserId !== input.subjectUserId
        || request.authority.agentId !== input.agentId
        || request.action.userHandle !== retained.actionHandle
        || request.approvalReference === undefined
        || request.approvalReference.referenceVersion !== 1
        || request.approvalReference.referenceId !== retained.referenceId
        || request.approvalReference.toolCallId !== retained.toolCallId
        || request.approvalReference.requesterUserId !== input.subjectUserId
        || request.approvalReference.agentId !== input.agentId) {
        return Object.freeze({ status: "unavailable" as const,
          reason: "authorization_required" as const });
      }
      const replanned = await input.product.planNativeChange(request);
      if (replanned.status === "unavailable") return replanned;
      if (retained.unchanged && replanned.value.status === "unchanged"
        && exactPlan(retained.plan, replanned.value.plan)) return Object.freeze({
        status: "success" as const, value: Object.freeze({
          status: "unchanged" as const, memoryId: request.memoryId,
        }),
      });
      if (replanned.value.status === "unchanged") return Object.freeze({
        status: "unavailable" as const, reason: "stale_revision" as const,
      });
      if (!exactPlan(retained.plan, replanned.value.plan)) return Object.freeze({
        status: "unavailable" as const, reason: "stale_revision" as const,
      });
      const finalPlan = replanned.value.plan;
      return input.crypto.authorizeCommit({ prepared: retained.prepared,
        commit: (publication) => input.product.commitNativePrepared({
          authority: request.authority, plan: finalPlan, publication,
          persist: () => input.persist(publication),
        }) });
    },
  });
}
