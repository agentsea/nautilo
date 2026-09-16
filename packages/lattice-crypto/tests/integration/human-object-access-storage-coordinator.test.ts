import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import { encodeObjectAccessManifestV5 } from "../../src/format/object-access-manifest-v5.ts";
import {
  type AuthorizedObjectAccessWriteV2,
  authorizeObjectAccessWriteV2,
} from "../../src/object/authorized-write.ts";
import {
  prepareHumanObjectAccessManifestGenesisSetV1,
} from "../../src/object/human-access-manifest-set-v1.ts";
import { wrapObjectDekForNamespaceV2 } from "../../src/object/namespace-envelope.ts";
import {
  ObjectAccessPersistenceOutcomeUnknownV2,
  objectAccessStorageStateV2,
  persistPreparedHumanObjectAccessManifestGenesisSetV1,
} from "../../src/object/storage-coordinator.ts";
import { InMemoryV2Store } from "../../src/storage/v2-store.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { opaqueBytes } from "../../src/v2-types/opaque.ts";

function fixture(hostRevision = 7) {
  const crypto = new LatticeCrypto(seededRng(0x250_15));
  const signing = crypto.generateSigningKeyPair();
  const targetObjectId = objectId("memory:v1:human-v5-storage");
  const payloadBytes = encodeEncryptedPayloadV2({
    formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    context: {
      objectId: targetObjectId,
      keyClass: "human",
      objectType: "memory",
      createdAt: unixTimestamp(1),
    },
    ciphertext: new Uint8Array(40).fill(0x71),
  });
  const envelopeBytes = ["namespace-a", "namespace-b"].map((namespace, index) =>
    encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespaceV2(
      crypto,
      new Uint8Array(32).fill(0x21 + index),
      {
        objectId: targetObjectId,
        namespaceId: namespaceId(namespace),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(2),
        bindingRevisionAtWrap: accessRevision(0),
      },
      new Uint8Array(32).fill(0x41 + index),
    ))
  );
  const prepared = prepareHumanObjectAccessManifestGenesisSetV1(crypto, {
    objectId: targetObjectId,
    payloadHash: crypto.hash(payloadBytes),
    envelopeBytes,
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId("human-alice"),
    committerDeviceId: cryptoDeviceId("device-alice-1"),
    hostAuthorizationRevision: authorizationRevision(hostRevision),
    committerSigningPublicKey: signing.publicKey,
    committerSigningPrivateKey: signing.privateKey,
  });
  const resolve = (context: Parameters<
    typeof persistPreparedHumanObjectAccessManifestGenesisSetV1
  >[0]["resolveCurrentAuthorization"] extends (context: infer C) => unknown
    ? C
    : never) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision: authorizationRevision(hostRevision),
      committerSigningPublicKey: signing.publicKey,
    });
  return { crypto, signing, payloadBytes, targetObjectId, prepared, resolve };
}

async function initializedStore(state: ReturnType<typeof fixture>) {
  const store = new InMemoryV2Store();
  await store.putObject({
    objectId: state.targetObjectId,
    payloadBytes: opaqueBytes("encrypted-payload", state.payloadBytes),
  });
  return store;
}

describe("Human ObjectAccessManifestV5 storage coordinator", () => {
  test("persists an authentic genesis exactly once with fresh Human authority", async () => {
    const state = fixture();
    const store = await initializedStore(state);
    const contexts: unknown[] = [];
    const persist = () => persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage: store,
      prepared: state.prepared,
      resolveCurrentAuthorization: (context) => {
        contexts.push(context);
        return state.resolve(context);
      },
    });

    expect(await persist()).toBe("applied");
    expect(await persist()).toBe("duplicate");
    expect(contexts).toEqual([
      expect.objectContaining({
        purpose: "persist-human-object-access-genesis-v5",
        objectId: state.targetObjectId,
        subjectHumanId: "human-alice",
        committerDeviceId: "device-alice-1",
        hostAuthorizationRevision: 7,
      }),
      expect.any(Object),
    ]);
    expect(contexts[0]).toMatchObject({
      envelopes: [
        { namespaceId: "namespace-a", keyClass: "ai" },
        { namespaceId: "namespace-b", keyClass: "ai" },
      ],
    });
  });

  test("accepts authorization revision zero at the inclusive lower boundary", async () => {
    const state = fixture(0);
    const store = await initializedStore(state);
    expect(await persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage: store,
      prepared: state.prepared,
      resolveCurrentAuthorization: state.resolve,
    })).toBe("applied");
  });

  test("fails closed before CAS when payload or current authority is stale", async () => {
    const state = fixture();
    const absent = new InMemoryV2Store();
    let attempts = 0;
    const storage = {
      getObject: absent.getObject.bind(absent),
      compareAndSwapObjectAccessState: async () => {
        attempts += 1;
        return "applied" as const;
      },
    };
    expect(await persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage,
      prepared: state.prepared,
      resolveCurrentAuthorization: state.resolve,
    })).toBe("stale");

    const wrongPayload = new InMemoryV2Store();
    await wrongPayload.putObject({
      objectId: state.targetObjectId,
      payloadBytes: opaqueBytes("encrypted-payload", encodeEncryptedPayloadV2({
        formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
        context: {
          objectId: state.targetObjectId,
          keyClass: "human",
          objectType: "memory",
          createdAt: unixTimestamp(1),
        },
        ciphertext: new Uint8Array(40).fill(0xff),
      })),
    });
    expect(await persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage: wrongPayload,
      prepared: state.prepared,
      resolveCurrentAuthorization: state.resolve,
    })).toBe("stale");

    const store = await initializedStore(state);
    expect(await persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage: store,
      prepared: state.prepared,
      resolveCurrentAuthorization: () => null,
    })).toBe("stale");
    expect(attempts).toBe(0);
  });

  test("rejects every independently stale Human authorization coordinate", async () => {
    const state = fixture();
    const cases = [
      { sourceAuthorized: false },
      { targetAuthorized: false },
      { currentHostAuthorizationRevision: authorizationRevision(8) },
      { subjectHumanId: "human-bob" },
      { committerDeviceId: "device-bob-1" },
      { objectId: "memory:v1:other" },
      { committerSigningPublicKey: state.crypto.generateSigningKeyPair().publicKey },
      { committerSigningPublicKey: new Uint8Array(31) },
    ];
    for (const patch of cases) {
      const store = await initializedStore(state);
      expect(await persistPreparedHumanObjectAccessManifestGenesisSetV1({
        crypto: state.crypto,
        storage: store,
        prepared: state.prepared,
        resolveCurrentAuthorization: (context) => ({
          ...state.resolve(context),
          ...patch,
        }) as never,
      })).toBe("stale");
      expect(await store.getObjectAccessState(state.targetObjectId)).toBeNull();
    }
  });

  test("rejects forged prepared values and malformed resolver contracts", async () => {
    const state = fixture();
    const store = await initializedStore(state);
    expect(() => persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage: store,
      prepared: { ...state.prepared },
      resolveCurrentAuthorization: state.resolve,
    })).toThrow("authentic prepared v5 genesis");
    expect(() => persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage: store,
      prepared: state.prepared,
      resolveCurrentAuthorization: null as never,
    })).toThrow("resolver is required");
    const invalidShape = await persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage: store,
      prepared: state.prepared,
      resolveCurrentAuthorization: (context) => ({
        ...state.resolve(context),
        unexpected: true,
      }) as never,
    }).catch((cause: unknown) => cause);
    expect(invalidShape).toBeInstanceOf(TypeError);
    expect((invalidShape as Error).message).toContain(
      "authorization has an invalid field set",
    );

    const malformedScalars = [
      { purpose: "wrong-purpose" },
      { objectId: 7 },
      { subjectHumanId: null },
      { committerDeviceId: [] },
      { hostAuthorizationRevision: -1 },
      { hostAuthorizationRevision: 1.5 },
    ];
    for (const patch of malformedScalars) {
      const result = await persistPreparedHumanObjectAccessManifestGenesisSetV1({
        crypto: state.crypto,
        storage: store,
        prepared: state.prepared,
        resolveCurrentAuthorization: (context) => ({
          ...state.resolve(context),
          ...patch,
        }) as never,
      }).catch((cause: unknown) => cause);
      expect(result).toBeInstanceOf(TypeError);
      expect((result as Error).message).toContain(
        "authorization context is invalid",
      );
    }
  });

  test("turns ambiguous CAS delivery into an explicit unknown outcome", async () => {
    const state = fixture();
    const backing = await initializedStore(state);
    const error = await persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage: {
        getObject: backing.getObject.bind(backing),
        compareAndSwapObjectAccessState: async () => {
          throw new Error("ambiguous delivery");
        },
      },
      prepared: state.prepared,
      resolveCurrentAuthorization: state.resolve,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ObjectAccessPersistenceOutcomeUnknownV2);
    expect((error as Error & { cause?: unknown }).cause).toEqual(
      new Error("ambiguous delivery"),
    );
  });

  test("the durable CAS independently rejects substituted Human-v5 authority", async () => {
    const state = fixture();
    const source = await initializedStore(state);
    let captured: AuthorizedObjectAccessWriteV2 | undefined;
    expect(await persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage: {
        getObject: source.getObject.bind(source),
        compareAndSwapObjectAccessState: (authorized) => {
          captured = authorized;
          return Promise.resolve("applied");
        },
      },
      prepared: state.prepared,
      resolveCurrentAuthorization: state.resolve,
    })).toBe("applied");
    expect(captured).toBeDefined();
    const valid = captured!;
    const human = valid.authorization.kind === "human-v5-genesis"
      ? valid.authorization
      : null;
    expect(human).not.toBeNull();
    const cases = [
      ["object", {
        context: {
          ...human!.context,
          objectId: "memory:v1:other",
          envelopes: human!.context.envelopes.map((entry) => ({
            ...entry,
            objectId: "memory:v1:other",
          })),
        },
      }],
      ["payload", {
        context: {
          ...human!.context,
          payloadHash: new Uint8Array(32).fill(0xff),
        },
      }],
      ["subject", { context: { ...human!.context, subjectHumanId: "human-bob" } }],
      ["device", { context: { ...human!.context, committerDeviceId: "device-bob-1" } }],
      ["context revision", { context: { ...human!.context, hostAuthorizationRevision: 8 } }],
      ["current revision", { currentHostAuthorizationRevision: 8 }],
    ] as const;
    for (const [label, patch] of cases) {
      const store = await initializedStore(state);
      const authorization = {
        ...human!,
        ...patch,
      } as typeof human & object;
      expect(await store.compareAndSwapObjectAccessState(
        authorizeObjectAccessWriteV2({
          expected: valid.expected,
          intended: valid.intended,
          authorization,
        }),
      ), label).toBe("stale");
      expect(await store.getObjectAccessState(state.targetObjectId)).toBeNull();
    }
  });

  test("the durable CAS independently requires canonical Human-v5 genesis coordinates", async () => {
    const state = fixture();
    const source = await initializedStore(state);
    let captured: AuthorizedObjectAccessWriteV2 | undefined;
    await persistPreparedHumanObjectAccessManifestGenesisSetV1({
      crypto: state.crypto,
      storage: {
        getObject: source.getObject.bind(source),
        compareAndSwapObjectAccessState: (authorized) => {
          captured = authorized;
          return Promise.resolve("applied");
        },
      },
      prepared: state.prepared,
      resolveCurrentAuthorization: state.resolve,
    });
    const valid = captured!;
    const cases = [
      ["host authorization revision", {
        hostAuthorizationRevision: authorizationRevision(8),
      }],
    ] as const;
    for (const [label, patch] of cases) {
      const store = await initializedStore(state);
      const manifestBytes = encodeObjectAccessManifestV5({
        ...state.prepared.manifest,
        ...patch,
      });
      const intended = objectAccessStorageStateV2(
        state.crypto,
        manifestBytes,
        state.prepared.envelopeBytes,
      );
      expect(await store.compareAndSwapObjectAccessState(
        authorizeObjectAccessWriteV2({
          expected: null,
          intended,
          authorization: valid.authorization,
        }),
      ), label).toBe("stale");
      expect(await store.getObjectAccessState(state.targetObjectId)).toBeNull();
    }
  });
});
