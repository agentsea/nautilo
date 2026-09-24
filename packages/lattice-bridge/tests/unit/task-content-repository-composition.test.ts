import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto, accessRevision, encryptedObjectWriteRecord,
  encryptObjectPayload, namespaceGeneration, namespaceId, objectId,
  prepareHumanObjectAccessManifestGenesisSet, unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import type { TaskContentAuthorityV1 } from "../../src/task/task-content-authority-v1.ts";
import type {
  PreparedTaskContentCryptoRevisionV1,
  TaskContentPayloadV1,
  TaskContentRepository,
} from "../../src/task/task-content-repository.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  taskContentObjectTypeV1,
} from "../../src/task/task-content-repository.ts";
import {
  bindEncryptionDataOperationOwner,
  type DataOperationPolicySnapshot,
} from "../../src/transition/encryption-data-operation-owner.ts";
import {
  bindDurableTaskContentRepositoryV1,
} from "../../src/server/task/task-content-repository-composition.ts";
import { createPreparedHumanTaskContentCryptoRevisionV1 } from "../../src/task/task-content-prepared-revision.ts";
import { encodeTaskPayloadV1 } from "../../src/task/task-payload-v1.ts";

const TASK_ID = "30000000-0000-4000-8000-000000000001";
const RUN_ID = "30000000-0000-4000-8000-000000000002";
const HUMAN_ID = "30000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000004";

const authority = Object.freeze({
  authorityVersion: 1,
  kind: "requester_private_namespace",
  keyClass: "ai",
  requesterHumanId: HUMAN_ID,
  namespaceId: NAMESPACE_ID,
  domainId: "30000000-0000-4000-8000-000000000005",
  expectedAccessRevision: 0,
  expectedPolicyRevision: 1,
} satisfies TaskContentAuthorityV1);

const definition = (revision: number): TaskContentPayloadV1 => Object.freeze({
  coordinate: Object.freeze({
    kind: "definition" as const,
    taskId: TASK_ID,
    contentRevision: revision,
  }),
  payload: Object.freeze({
    formatVersion: 1 as const,
    prompt: `definition-${revision}`,
    expectedOutput: null,
    protectedMetadata: Object.freeze({}),
  }),
});

const result = (revision: number): TaskContentPayloadV1 => Object.freeze({
  coordinate: Object.freeze({
    kind: "run_result" as const,
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    contentRevision: revision,
  }),
  payload: Object.freeze({
    formatVersion: 1 as const,
    resultText: `result-${revision}`,
    lastError: null,
  }),
});

function owner(policy: DataOperationPolicySnapshot["policy"]) {
  return bindEncryptionDataOperationOwner({
    policy: {
      resolve: async () => ({ policy, revalidationToken: 7 }),
      revalidate: async () => undefined,
    },
  });
}

function prepared(content: TaskContentPayloadV1): PreparedTaskContentCryptoRevisionV1 {
  return Object.freeze({
    coordinate: content.coordinate,
    objectId: deriveTaskContentCryptoObjectIdV1(content.coordinate),
    objectType: taskContentObjectTypeV1(content.coordinate),
    payloadVersion: 1,
    namespaceId: NAMESPACE_ID,
    authorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
  });
}

function authenticPreparedDefinition(): PreparedTaskContentCryptoRevisionV1 {
  const coordinate = definition(1).coordinate;
  let seed = 1;
  const crypto = new LatticeCrypto({
    bytes: (length) => Uint8Array.from({ length }, () => (seed++ * 73) & 0xff),
  }, { now: () => 1_820_000_000_000 });
  const signer = crypto.generateSigningKeyPair();
  const identity = deriveTaskContentCryptoObjectIdV1(coordinate);
  const plaintext = encodeTaskPayloadV1({
    formatVersion: 1,
    prompt: "definition-1",
    expectedOutput: null,
    protectedMetadata: {},
  });
  const encrypted = encryptObjectPayload(crypto, {
    objectId: objectId(identity), keyClass: "ai",
    objectType: taskContentObjectTypeV1(coordinate),
    createdAt: unixTimestamp(1_820_000_000_000),
  }, plaintext);
  plaintext.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
    crypto, new Uint8Array(32).fill(2), {
      objectId: objectId(identity), namespaceId: namespaceId(NAMESPACE_ID),
      keyClass: "ai", keyGeneration: namespaceGeneration(1),
      bindingRevisionAtWrap: accessRevision(authority.expectedAccessRevision),
    }, encrypted.dek,
  ));
  encrypted.dek.fill(0);
  const access = prepareHumanObjectAccessManifestGenesisSet(crypto, {
    objectId: identity, payloadHash: crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes], sourceAuthorized: true,
    targetAuthorized: true, subjectHumanId: HUMAN_ID,
    committerDeviceId: "task-composition-device",
    hostAuthorizationRevision: 1,
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  });
  const revision = createPreparedHumanTaskContentCryptoRevisionV1({
    signerKind: "human_device", coordinate, authority,
    object: encryptedObjectWriteRecord(payloadBytes), access,
  });
  signer.privateKey.fill(0);
  return revision;
}

class FakeProtectedRepository implements TaskContentRepository {
  readonly calls: string[] = [];
  reservation: "reserved" | "replayed" | "conflict" | "stale" = "reserved";
  failCompletion = false;

  async reserveRevision(input: Parameters<TaskContentRepository["reserveRevision"]>[0]) {
    this.calls.push(`reserve:${input.prepared.coordinate.kind}:${input.representation}`);
    if (this.reservation === "conflict" || this.reservation === "stale") {
      return { status: this.reservation } as const;
    }
    return {
      status: this.reservation,
      coordinate: input.prepared.coordinate,
      cryptoObjectId: input.prepared.objectId,
    } as const;
  }

  async lookupPreparedReplay() {
    return { status: "unavailable" as const };
  }

  async completeRevision(input: Parameters<TaskContentRepository["completeRevision"]>[0]) {
    this.calls.push(`complete:${input.coordinate.kind}`);
    if (this.failCompletion) throw new Error("lost crypto completion response");
    return {
      status: "mapped" as const,
      coordinate: input.coordinate,
      cryptoObjectId: input.prepared.objectId,
    };
  }

  async reconcilePending(input: Parameters<TaskContentRepository["reconcilePending"]>[0]) {
    this.calls.push(`reconcile:${input.limit}`);
    return { outcomes: [] };
  }
}

function setup() {
  const protectedRepository = new FakeProtectedRepository();
  const calls: string[] = protectedRepository.calls;
  let failPublication = false;
  const repository = bindDurableTaskContentRepositoryV1({
    protectedRepository,
    content: {
      async prepareProtected(input) {
        calls.push(`prepare:${input.content.coordinate.kind}`);
        return prepared(input.content);
      },
      async publishProduct(plan) {
        calls.push(`publish:${plan.content.coordinate.kind}:${plan.representation}`);
        if (failPublication) throw new Error("lost publication response");
        return plan.content.coordinate.contentRevision;
      },
      async readOrdinary(coordinate) {
        calls.push(`read:ordinary:${coordinate.kind}`);
        return coordinate.kind === "definition"
          ? definition(coordinate.contentRevision)
          : result(coordinate.contentRevision);
      },
      async readProtected(coordinate) {
        calls.push(`read:protected:${coordinate.kind}`);
        return coordinate.kind === "definition"
          ? definition(coordinate.contentRevision)
          : result(coordinate.contentRevision);
      },
    },
  });
  return {
    calls,
    protectedRepository,
    repository,
    setFailPublication(value: boolean) { failPublication = value; },
    setFailCompletion(value: boolean) { protectedRepository.failCompletion = value; },
  };
}

describe("durable Task content repository composition", () => {
  test("publishes authenticated prepared bytes only under protected policy", async () => {
    const state = setup();
    const revision = authenticPreparedDefinition();
    const input = {
      representation: "protected" as const,
      operationId: "task:prepared:create",
      requestDigest: new Uint8Array(32).fill(9),
      authority,
      operationalMetadata: null,
      prepared: revision,
      publishProduct: async () => {
        state.calls.push("publish:prepared");
        return 1;
      },
    } as const;
    for (const policy of [
      { mode: "plaintext_only", shadowBehavior: "fallback" },
      { mode: "shadow_encryption", shadowBehavior: "strict" },
    ] as const) {
      await state.repository.publishPrepared({
        ...input, owner: owner(policy),
      }).then(
        () => { throw new Error("Unsupported Task publication unexpectedly succeeded"); },
        (error: unknown) => { expect(error).toMatchObject({ failureClass: "unsupported" }); },
      );
    }
    expect(state.calls).toEqual([]);
    await state.repository.publishPrepared({
      ...input,
      prepared: prepared(definition(1)),
      owner: owner({ mode: "encrypted_only", shadowBehavior: "strict" }),
    }).then(
      () => { throw new Error("Foreign Task publication unexpectedly succeeded"); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("foreign or changed after preparation");
      },
    );
    expect(state.calls).toEqual([]);
    expect(await state.repository.publishPrepared({
      ...input,
      owner: owner({ mode: "encrypted_only", shadowBehavior: "strict" }),
    })).toMatchObject({ representation: "protected", product: 1,
      protectedRevision: { status: "mapped" } });
    expect(state.calls).toEqual([
      "reserve:definition:protected", "publish:prepared", "complete:definition",
    ]);
  });

  test("publishes ordinary create, dual update, and protected TaskRun result", async () => {
    const state = setup();
    const ordinary = await state.repository.mutate({
      owner: owner({ mode: "plaintext_only", shadowBehavior: "fallback" }),
      content: definition(1), operationId: "task:create:1",
      requestDigest: new Uint8Array(32), authority, operationalMetadata: null,
    });
    expect(ordinary).toMatchObject({ representation: "ordinary", product: 1 });

    const dual = await state.repository.mutate({
      owner: owner({ mode: "shadow_encryption", shadowBehavior: "strict" }),
      content: definition(2), operationId: "task:update:2",
      requestDigest: new Uint8Array(32).fill(2), authority, operationalMetadata: null,
    });
    expect(dual).toMatchObject({ representation: "dual", product: 2,
      protectedRevision: { status: "mapped" } });

    const protectedResult = await state.repository.mutate({
      owner: owner({ mode: "encrypted_only", shadowBehavior: "strict" }),
      content: result(1), operationId: "task:result:1",
      requestDigest: new Uint8Array(32).fill(3), authority, operationalMetadata: null,
    });
    expect(protectedResult).toMatchObject({ representation: "protected", product: 1,
      protectedRevision: { status: "mapped" } });
    expect(state.calls).toEqual([
      "publish:definition:ordinary",
      "prepare:definition", "reserve:definition:dual",
      "publish:definition:dual", "complete:definition",
      "prepare:run_result", "reserve:run_result:protected",
      "publish:run_result:protected", "complete:run_result",
    ]);
  });

  test("reserves, replays, and crash-recovers a prepared dual publication", async () => {
    const state = setup();
    const revision = authenticPreparedDefinition();
    const ordinaryContent = definition(1);
    const dualOwner = owner({ mode: "shadow_encryption", shadowBehavior: "strict" });
    const products = new Map<string, number>();
    let callbackCalls = 0;
    const request = {
      representation: "dual" as const,
      owner: dualOwner,
      operationId: "task:prepared:dual:create",
      requestDigest: new Uint8Array(32).fill(11),
      authority,
      operationalMetadata: null,
      prepared: revision,
      ordinaryContent,
      publishProduct: async (content: TaskContentPayloadV1) => {
        callbackCalls += 1;
        expect(content).toEqual(ordinaryContent);
        const prior = products.get(content.coordinate.taskId);
        if (prior !== undefined) return prior;
        products.set(content.coordinate.taskId, 1);
        return 1;
      },
    };

    state.setFailCompletion(true);
    const interrupted = await state.repository.publishPrepared(request).then(
      () => null,
      (error: unknown) => error,
    );
    expect(interrupted).toBeInstanceOf(Error);
    expect(products.size).toBe(1);

    state.setFailCompletion(false);
    state.protectedRepository.reservation = "replayed";
    expect(await state.repository.publishPrepared(request)).toMatchObject({
      representation: "dual", product: 1,
      protectedRevision: { status: "mapped" },
    });
    expect(callbackCalls).toBe(2);
    expect(state.calls).toEqual([
      "reserve:definition:dual", "complete:definition",
      "reserve:definition:dual", "complete:definition",
    ]);

    state.protectedRepository.reservation = "conflict";
    const conflict = await state.repository.publishPrepared({
      ...request,
      requestDigest: new Uint8Array(32).fill(12),
    }).then(() => null, (error: unknown) => error);
    expect(conflict).toMatchObject({ failureClass: "integrity" });
    expect(callbackCalls).toBe(2);
  });

  test("replays after publication response loss and exposes bounded reconciliation", async () => {
    const state = setup();
    const input = {
      owner: owner({ mode: "encrypted_only", shadowBehavior: "strict" }),
      content: result(1), operationId: "task:result:retry",
      requestDigest: new Uint8Array(32).fill(4), authority, operationalMetadata: null,
    } as const;
    state.setFailPublication(true);
    const lostResponse = await state.repository.mutate(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(lostResponse).toBeInstanceOf(Error);
    expect((lostResponse as Error).message).toContain("lost publication response");
    state.setFailPublication(false);
    state.protectedRepository.reservation = "replayed";
    expect(await state.repository.mutate(input)).toMatchObject({
      representation: "protected", protectedRevision: { status: "mapped" },
    });
    await state.repository.reconcilePending({
      leaseToken: "30000000-0000-4000-8000-000000000006",
      limit: 8,
    });
    expect(state.calls.filter((call) => call === "reserve:run_result:protected"))
      .toHaveLength(2);
    expect(state.calls).toContain("reconcile:8");
  });

  test("fails closed on reservation CAS conflict and policy-selects reads", async () => {
    const state = setup();
    state.protectedRepository.reservation = "conflict";
    const conflict = await state.repository.mutate({
      owner: owner({ mode: "encrypted_only", shadowBehavior: "strict" }),
      content: definition(1), operationId: "task:create:collision",
      requestDigest: new Uint8Array(32).fill(5), authority, operationalMetadata: null,
    }).then(() => null, (error: unknown) => error);
    expect(conflict).toMatchObject({ failureClass: "integrity" });
    expect(state.calls.some((call) => call.startsWith("publish:"))).toBe(false);

    const ordinaryRead = await state.repository.read({
      owner: owner({ mode: "plaintext_only", shadowBehavior: "fallback" }),
      coordinate: definition(1).coordinate,
    });
    const protectedRead = await state.repository.read({
      owner: owner({ mode: "encrypted_only", shadowBehavior: "strict" }),
      coordinate: result(1).coordinate,
    });
    expect(ordinaryRead.representation).toBe("ordinary");
    expect(protectedRead.representation).toBe("protected");
    expect(state.calls).toContain("read:ordinary:definition");
    expect(state.calls).toContain("read:protected:run_result");
  });
});
