import { describe, expect, test } from "bun:test";
import {
  encodeMemoryPayloadV1,
} from "@nautilo/lattice-bridge";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  deriveAgentRuntimeObjectSignerPublic,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  wrapObjectDekForNamespace,
  LatticeCrypto,
  type AgentRuntimeKeyGeneration,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";
import {
  createForegroundDomainMemoryExactAccess,
  createForegroundDomainProtectedAgentMemoryAccessPort,
  type ForegroundDomainMemoryAccessHead,
} from "../../src/memory/foreground-domain-memory-exact-access";

const AGENT = "10000000-0000-4000-8000-000000000001";
const A = "10000000-0000-4000-8000-000000000002";
const B = "10000000-0000-4000-8000-000000000003";
const OBJECT = `memory:v1:${"ab".repeat(32)}`;

function rng(length: number): Uint8Array {
  return new Uint8Array(length).fill(0x31);
}

function setup(source = A, target = B, random = rng) {
  const crypto = new LatticeCrypto({ bytes: random });
  const runtime = Object.freeze({
    agentId: agentId(AGENT), keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(1), key: new Uint8Array(32).fill(0x41),
  }) as AgentRuntimeKeyGeneration;
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const keys = new Map([[source, new Uint8Array(32).fill(0x51)], [target, new Uint8Array(32).fill(0x52)]]);
  const authorities = new Map([source, target].map((id, index) => [id, Object.freeze({
    namespaceId: id,
    namespaceAccessRevision: index + 2,
    namespaceKeyGeneration: index + 3,
    domainId: `domain-${index}`,
    domainKeyGeneration: 1,
    domainAuthorizationRevision: 1,
    domainHeadDigest: new Uint8Array(32).fill(0x60 + index),
    namespaceHeadDigest: new Uint8Array(32).fill(0x70 + index),
    namespacePublicationDigest: new Uint8Array(32).fill(0x80 + index),
    namespacePublicationSetDigest: new Uint8Array(32).fill(0x90 + index),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(0xa0 + index),
  })]));
  const encrypted = encryptObjectPayload(crypto, {
    objectId: objectId(OBJECT), keyClass: "ai", objectType: "memory",
    createdAt: unixTimestamp(1),
  }, encodeMemoryPayloadV1({ formatVersion: 1, type: "fact",
    content: "payload" }));
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
    crypto, keys.get(source)!, {
      objectId: objectId(OBJECT), namespaceId: namespaceId(source), keyClass: "ai",
      keyGeneration: namespaceGeneration(3), bindingRevisionAtWrap: accessRevision(2),
    }, encrypted.dek,
  ));
  encrypted.dek.fill(0);
  const durable: ForegroundDomainMemoryAccessHead = {
    objectId: OBJECT, accessRevision: 0, payloadBytes,
    payloadHash: crypto.hash(payloadBytes),
    accessManifestBytes: new Uint8Array([1]),
    accessManifestHash: new Uint8Array(32).fill(0x21),
    namespaceEnvelopes: [{ namespaceId: source, keyGeneration: 3,
      bindingRevisionAtWrap: 2, envelopeBytes }],
    nativeEntries: [{ namespaceId: namespaceId(source), keyGeneration: 3,
      namespaceAccessRevision: 2,
      headDigest: authorities.get(source)!.namespaceHeadDigest.slice(),
      publicationDigest: authorities.get(source)!.namespacePublicationDigest.slice(),
      publicationSetDigest: authorities.get(source)!.namespacePublicationSetDigest.slice(),
      audienceFingerprint: authorities.get(source)!.namespaceAudienceFingerprint.slice(),
      envelopeHash: crypto.hash(envelopeBytes) }],
  };
  const clone = (): ForegroundDomainMemoryAccessHead => structuredClone(durable);
  let commits = 0;
  const factory = createForegroundDomainMemoryExactAccess({
    crypto, runtime, signerKeyId: signer.principal.signerKeyId,
    agentAuthorizationRevision: 1,
    entities: {
      signal: new AbortController().signal,
      use: async (request) => ({ status: "executed" as const,
        value: await request.execute({ namespaceKey: keys.get(request.entity.namespaceId)!,
          authority: authorities.get(request.entity.namespaceId)! }) }),
      useCurrentSet: async (request) => ({ status: "executed" as const,
        value: await request.execute(request.namespaceIds.map((id) => ({
          namespaceKey: keys.get(id)!, authority: authorities.get(id)!,
        }))) }),
    },
    read: async (request) => durable.accessRevision === request.expectedAccessRevision
      ? clone() : null,
  });
  return { factory, get commits() { return commits; }, commit: () => ++commits,
    rotateSource: () => authorities.set(source, { ...authorities.get(source)!,
      namespaceHeadDigest: new Uint8Array(32).fill(0xee) }),
  };
}

describe("foreground Domain Memory exact access", () => {
  test("recovery evidence requires the same invocation and fresh exact Namespace authority", async () => {
    const fixture = setup();
    const prepared = await fixture.factory.prepare({ objectId: OBJECT,
      expectedAccessRevision: 0, currentNamespaceIds: [A], targetNamespaceIds: [A] });
    expect(prepared).not.toBeNull();
    const foreign = setup();
    expect(foreign.factory.authorizeCurrentHead({ prepared: prepared!,
      commit: async () => foreign.commit(),
    })).rejects.toThrow("another invocation");
    const head = await fixture.factory.authorizeCurrentHead({ prepared: prepared!,
      commit: async (value) => value,
    });
    expect(head).toMatchObject({ objectId: OBJECT, accessRevision: 0, namespaceIds: [A] });
    fixture.rotateSource();
    expect(fixture.factory.authorizeCurrentHead({ prepared: prepared!,
      commit: async () => fixture.commit(),
    })).rejects.toThrow("authority changed");
    expect(fixture.commits).toBe(0);
  });

  test.each([0x31, 0x32, 0x33, 0x34])("publishes envelope bytes in signed manifest hash order (seed %i)", async (seed) => {
    const fixture = setup(A, B, (length) => new Uint8Array(length).fill(seed));
    const prepared = await fixture.factory.prepare({ objectId: OBJECT,
      expectedAccessRevision: 0, currentNamespaceIds: [A], targetNamespaceIds: [A, B] });
    await fixture.factory.authorizeCommit({ prepared: prepared!, commit: async (publication) => {
      const manifest = decodeObjectAccessManifestV5(publication.nextManifestBytes);
      expect(publication.targetEntries.map((entry) => String(entry.namespaceId))).toEqual([A, B]);
      expect(publication.targetEnvelopeBytes.map((bytes) => new LatticeCrypto().hash(bytes)))
        .toEqual([...manifest.envelopeHashes]);
    } });
  });

  test("can attach a target whose Namespace sorts before the source", async () => {
    const fixture = setup(B, A);
    const prepared = await fixture.factory.prepare({ objectId: OBJECT,
      expectedAccessRevision: 0, currentNamespaceIds: [B], targetNamespaceIds: [A, B] });
    expect(prepared).not.toBeNull();
    await fixture.factory.authorizeCommit({ prepared: prepared!, commit: fixture.commit });
    expect(fixture.commits).toBe(1);
  });

  test("prepares and commits under the exact current target lease", async () => {
    const fixture = setup();
    const prepared = await fixture.factory.prepare({ objectId: OBJECT,
      expectedAccessRevision: 0, currentNamespaceIds: [A], targetNamespaceIds: [A, B] });
    expect(prepared).not.toBeNull();
    expect(fixture.factory.readPreparedPayload(prepared!)).toEqual({
      formatVersion: 1, type: "fact", content: "payload",
    });
    expect(await fixture.factory.authorizeCommit({ prepared: prepared!,
      commit: fixture.commit })).toBe(1);
    expect(fixture.commits).toBe(1);
  });

  test("rejects a foreign opaque preparation", async () => {
    const first = setup();
    const second = setup();
    const prepared = await first.factory.prepare({ objectId: OBJECT,
      expectedAccessRevision: 0, currentNamespaceIds: [A], targetNamespaceIds: [A, B] });
    let message = "";
    try {
      await second.factory.authorizeCommit({ prepared: prepared!,
        commit: second.commit });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("another invocation");
  });

  test("binds approval preview and commit to the same exact source head", async () => {
    const fixture = setup();
    const plan = {
      operationId: "share-op", memoryId: "10000000-0000-4000-8000-000000000004",
      cryptoObjectId: OBJECT, expectedContentRevision: 1,
      expectedCryptoAccessRevision: 0, nextCryptoAccessRevision: 1,
      anchorNamespaceId: A, currentNamespaceIds: [A], targetNamespaceIds: [A, B],
      addedNamespaceIds: [B], removedNamespaceIds: [],
      currentRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
      targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(2),
      productMutation: { kind: "grant_namespace" as const, namespaceId: B },
    };
    let persisted = 0;
    const port = createForegroundDomainProtectedAgentMemoryAccessPort({
      subjectUserId: "10000000-0000-4000-8000-000000000005",
      agentId: AGENT, crypto: fixture.factory,
      product: {
        reconcileNativeCommitted: async () => false,
        planNativeChange: async (request) => ({ status: "success" as const,
          value: { status: "prepared" as const, sourceNamespaceId: A,
            plan: { ...plan, operationId: request.operationId } } }),
        commitNativePrepared: async ({ persist, plan: committedPlan }) => {
          expect(committedPlan.operationId).toBe("share-execution-op");
          await persist();
          return { status: "success" as const,
            value: { status: "updated" as const, memoryId: plan.memoryId } };
        },
      },
      persist: async () => { persisted += 1; return "created"; },
    });
    const authority = { mode: "namespace" as const,
      subjectUserId: "10000000-0000-4000-8000-000000000005", agentId: AGENT,
      readableNamespaceIds: [A], mutableNamespaceIds: [A, B], writableNamespaceId: B };
    const approval = await port.prepareApproval!({ operationId: "share-op",
      toolCallId: "tool-1", authority, memoryId: plan.memoryId,
      action: { kind: "grant_user", userHandle: "bob" } });
    expect(approval).toMatchObject({ status: "success",
      value: { preview: { type: "fact", content: "payload" } } });
    if (approval.status !== "success") throw new Error("approval unavailable");
    expect(await port.change({ operationId: "share-execution-op", authority,
      memoryId: plan.memoryId, action: { kind: "grant_user", userHandle: "bob" } })).toMatchObject({
        status: "unavailable", reason: "authorization_required",
      });
    expect(await port.change({ operationId: "share-execution-op", authority,
      memoryId: plan.memoryId, action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: { ...approval.value.reference, requesterUserId:
        "10000000-0000-4000-8000-000000000099" } })).toMatchObject({
        status: "unavailable", reason: "authorization_required",
      });
    expect(await port.change({ operationId: "share-execution-op", authority,
      memoryId: plan.memoryId, action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: approval.value.reference })).toMatchObject({
        status: "success", value: { status: "updated" },
      });
    expect(persisted).toBe(1);
  });

  test("returns an authenticated preview and unchanged receipt for an exact regrant", async () => {
    const fixture = setup();
    const plan = {
      operationId: "approval-op", memoryId: "10000000-0000-4000-8000-000000000004",
      cryptoObjectId: OBJECT, expectedContentRevision: 1,
      expectedCryptoAccessRevision: 0, nextCryptoAccessRevision: 1,
      anchorNamespaceId: A, currentNamespaceIds: [A], targetNamespaceIds: [A],
      addedNamespaceIds: [], removedNamespaceIds: [],
      currentRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
      targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
      productMutation: { kind: "grant_namespace" as const, namespaceId: A },
    };
    let persisted = 0;
    const port = createForegroundDomainProtectedAgentMemoryAccessPort({
      subjectUserId: "10000000-0000-4000-8000-000000000005",
      agentId: AGENT, crypto: fixture.factory,
      product: {
        reconcileNativeCommitted: async () => false,
        planNativeChange: async (request) => ({ status: "success" as const,
          value: { status: "unchanged" as const, memoryId: plan.memoryId,
            sourceNamespaceId: A, plan: { ...plan, operationId: request.operationId } } }),
        commitNativePrepared: async () => {
          throw new Error("unchanged regrant must not commit");
        },
      },
      persist: async () => { persisted += 1; return "created"; },
    });
    const authority = { mode: "namespace" as const,
      subjectUserId: "10000000-0000-4000-8000-000000000005", agentId: AGENT,
      readableNamespaceIds: [A], mutableNamespaceIds: [A], writableNamespaceId: A };
    const approval = await port.prepareApproval!({ operationId: "approval-op",
      toolCallId: "tool-1", authority, memoryId: plan.memoryId,
      action: { kind: "grant_user", userHandle: "bob" } });
    expect(approval).toMatchObject({ status: "success",
      value: { preview: { type: "fact", content: "payload" } } });
    if (approval.status !== "success") throw new Error("approval unavailable");
    expect(await port.change({ operationId: "execution-op", authority,
      memoryId: plan.memoryId, action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: approval.value.reference })).toEqual({ status: "success",
        value: { status: "unchanged", memoryId: plan.memoryId } });
    expect(persisted).toBe(0);
  });

  test("keeps concurrent approvals independently executable by tool call", async () => {
    const fixture = setup();
    const memoryId = "10000000-0000-4000-8000-000000000004";
    const plan = {
      operationId: "approval-op", memoryId, cryptoObjectId: OBJECT,
      expectedContentRevision: 1, expectedCryptoAccessRevision: 0,
      nextCryptoAccessRevision: 1, anchorNamespaceId: A,
      currentNamespaceIds: [A], targetNamespaceIds: [A, B],
      addedNamespaceIds: [B], removedNamespaceIds: [],
      currentRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
      targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(2),
      productMutation: { kind: "grant_namespace" as const, namespaceId: B },
    };
    const committedOperations: string[] = [];
    const port = createForegroundDomainProtectedAgentMemoryAccessPort({
      subjectUserId: "10000000-0000-4000-8000-000000000005",
      agentId: AGENT, crypto: fixture.factory,
      product: {
        reconcileNativeCommitted: async () => false,
        planNativeChange: async (request) => ({ status: "success" as const,
          value: { status: "prepared" as const, sourceNamespaceId: A,
            plan: { ...plan, operationId: request.operationId } } }),
        commitNativePrepared: async ({ persist, plan: committedPlan }) => {
          committedOperations.push(committedPlan.operationId);
          await persist();
          return { status: "success" as const,
            value: { status: "updated" as const, memoryId } };
        },
      },
      persist: async () => "created",
    });
    const authority = { mode: "namespace" as const,
      subjectUserId: "10000000-0000-4000-8000-000000000005", agentId: AGENT,
      readableNamespaceIds: [A], mutableNamespaceIds: [A, B], writableNamespaceId: B };
    const [bobApproval, charlieApproval] = await Promise.all([
      port.prepareApproval!({ operationId: "approval-bob", toolCallId: "tool-bob",
        authority, memoryId, action: { kind: "grant_user", userHandle: "bob" } }),
      port.prepareApproval!({ operationId: "approval-charlie", toolCallId: "tool-charlie",
        authority, memoryId, action: { kind: "grant_user", userHandle: "charlie" } }),
    ]);
    if (bobApproval.status !== "success" || charlieApproval.status !== "success") {
      throw new Error("approvals unavailable");
    }

    expect(await port.change({ operationId: "execute-bob-with-charlie-reference",
      authority, memoryId, action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: charlieApproval.value.reference })).toEqual({
        status: "unavailable", reason: "authorization_required",
      });
    expect(await port.change({ operationId: "execute-charlie-with-bob-reference",
      authority, memoryId, action: { kind: "grant_user", userHandle: "charlie" },
      approvalReference: bobApproval.value.reference })).toEqual({
        status: "unavailable", reason: "authorization_required",
      });
    expect(await port.change({ operationId: "execute-mixed-reference",
      authority, memoryId, action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: { ...bobApproval.value.reference,
        toolCallId: charlieApproval.value.reference.toolCallId } })).toEqual({
        status: "unavailable", reason: "authorization_required",
      });
    expect(await port.change({ operationId: "execute-bob", authority, memoryId,
      action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: bobApproval.value.reference })).toMatchObject({
        status: "success", value: { status: "updated" },
      });
    expect(await port.change({ operationId: "execute-charlie", authority, memoryId,
      action: { kind: "grant_user", userHandle: "charlie" },
      approvalReference: charlieApproval.value.reference })).toMatchObject({
        status: "success", value: { status: "updated" },
      });
    expect(committedOperations).toEqual(["execute-bob", "execute-charlie"]);
  });

  test("invalidates an earlier approval before repreparing the same tool call", async () => {
    const fixture = setup();
    const memoryId = "10000000-0000-4000-8000-000000000004";
    const plan = {
      operationId: "approval-op", memoryId, cryptoObjectId: OBJECT,
      expectedContentRevision: 1, expectedCryptoAccessRevision: 0,
      nextCryptoAccessRevision: 1, anchorNamespaceId: A,
      currentNamespaceIds: [A], targetNamespaceIds: [A, B],
      addedNamespaceIds: [B], removedNamespaceIds: [],
      currentRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
      targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(2),
      productMutation: { kind: "grant_namespace" as const, namespaceId: B },
    };
    let stalePlan = false;
    const port = createForegroundDomainProtectedAgentMemoryAccessPort({
      subjectUserId: "10000000-0000-4000-8000-000000000005",
      agentId: AGENT, crypto: fixture.factory,
      product: {
        reconcileNativeCommitted: async () => false,
        planNativeChange: async (request) => ({ status: "success" as const,
          value: { status: "prepared" as const, sourceNamespaceId: A,
            plan: { ...plan, operationId: request.operationId,
              expectedCryptoAccessRevision: stalePlan ? 1 : 0 } } }),
        commitNativePrepared: async ({ persist }) => {
          await persist();
          return { status: "success" as const,
            value: { status: "updated" as const, memoryId } };
        },
      },
      persist: async () => "created",
    });
    const authority = { mode: "namespace" as const,
      subjectUserId: "10000000-0000-4000-8000-000000000005", agentId: AGENT,
      readableNamespaceIds: [A], mutableNamespaceIds: [A, B], writableNamespaceId: B };
    const first = await port.prepareApproval!({ operationId: "approval-current",
      toolCallId: "tool-reprepared", authority, memoryId,
      action: { kind: "grant_user", userHandle: "bob" } });
    if (first.status !== "success") throw new Error("approval unavailable");

    stalePlan = true;
    const narrowedAuthority = { ...authority, mutableNamespaceIds: [A] };
    expect(await port.prepareApproval!({ operationId: "approval-stale",
      toolCallId: "tool-reprepared", authority: narrowedAuthority, memoryId,
      action: { kind: "grant_user", userHandle: "bob" } })).toEqual({
        status: "unavailable", reason: "target_encryption_not_ready",
      });

    stalePlan = false;
    expect(await port.change({ operationId: "execute-obsolete", authority, memoryId,
      action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: first.value.reference })).toEqual({
        status: "unavailable", reason: "authorization_required",
      });
  });

  test("changes the approval digest when the reprepared target audience changes", async () => {
    const fixture = setup();
    const memoryId = "10000000-0000-4000-8000-000000000004";
    let targetAudience = 2;
    const plan = {
      operationId: "approval-op", memoryId, cryptoObjectId: OBJECT,
      expectedContentRevision: 1, expectedCryptoAccessRevision: 0,
      nextCryptoAccessRevision: 1, anchorNamespaceId: A,
      currentNamespaceIds: [A], targetNamespaceIds: [A, B],
      addedNamespaceIds: [B], removedNamespaceIds: [],
      currentRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
      productMutation: { kind: "grant_namespace" as const, namespaceId: B },
    };
    const port = createForegroundDomainProtectedAgentMemoryAccessPort({
      subjectUserId: "10000000-0000-4000-8000-000000000005",
      agentId: AGENT, crypto: fixture.factory,
      product: {
        reconcileNativeCommitted: async () => false,
        planNativeChange: async (request) => ({ status: "success" as const,
          value: { status: "prepared" as const, sourceNamespaceId: A,
            plan: { ...plan, operationId: request.operationId,
              targetRequiredNamespaceFingerprint:
                new Uint8Array(32).fill(targetAudience) } } }),
        commitNativePrepared: async ({ persist }) => {
          await persist();
          return { status: "success" as const,
            value: { status: "updated" as const, memoryId } };
        },
      },
      persist: async () => "created",
    });
    const authority = { mode: "namespace" as const,
      subjectUserId: "10000000-0000-4000-8000-000000000005", agentId: AGENT,
      readableNamespaceIds: [A], mutableNamespaceIds: [A, B], writableNamespaceId: B };
    const first = await port.prepareApproval!({ operationId: "approval-audience",
      toolCallId: "tool-audience", authority, memoryId,
      action: { kind: "grant_user", userHandle: "bob" } });
    if (first.status !== "success") throw new Error("approval unavailable");

    targetAudience = 3;
    const second = await port.prepareApproval!({ operationId: "approval-audience",
      toolCallId: "tool-audience", authority, memoryId,
      action: { kind: "grant_user", userHandle: "bob" } });
    if (second.status !== "success") throw new Error("approval unavailable");
    expect(second.value.reference.referenceId)
      .not.toBe(first.value.reference.referenceId);
    expect(await port.change({ operationId: "execute-obsolete-audience",
      authority, memoryId, action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: first.value.reference })).toEqual({
        status: "unavailable", reason: "authorization_required",
      });
    expect(await port.change({ operationId: "execute-current-audience",
      authority, memoryId, action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: second.value.reference })).toMatchObject({
        status: "success", value: { status: "updated" },
      });
  });
});
