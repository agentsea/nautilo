import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createObjectAccessManifestV2,
  decodeObjectAccessManifestV2,
} from "../../src/format/object-access-manifest-v2.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  assertAuthenticPreparedObjectAccessManifestGenesisV2,
  assertAuthenticPreparedObjectAccessManifestUpdateV2,
  prepareObjectAccessManifestGenesisV2,
  prepareObjectAccessManifestUpdateV2,
  type PreparedObjectAccessManifestGenesisV2,
  type PreparedObjectAccessManifestUpdateV2,
} from "../../src/object/access-manifest.ts";
import {
  ObjectAccessPersistenceOutcomeUnknownV2,
  type ObjectAccessGenesisPersistenceAuthorizationContextV2,
  type ObjectAccessGenesisPersistenceAuthorizationV2,
  type ObjectAccessStateCasStorageV2,
  type ObjectAccessUpdatePersistenceAuthorizationContextV2,
  type ObjectAccessUpdateStateCasStorageV2,
  objectAccessStorageStateV2,
  persistPreparedObjectAccessManifestGenesisV2,
  persistPreparedObjectAccessManifestUpdateV2,
} from "../../src/object/storage-coordinator.ts";
import {
  wrapObjectDekForNamespaceV2,
} from "../../src/object/namespace-envelope.ts";
import {
  authorizeObjectAccessWriteV2,
  consumeAuthorizedObjectAccessWriteV2,
  type AuthorizedObjectAccessWriteV2,
  type ObjectAccessAuthorizationExpectationV2,
} from "../../src/object/authorized-write.ts";
import {
  InMemoryV2Store,
  type ObjectAccessManifestStorageHeadV2,
  type ObjectAccessStateCasStatusV2,
  type ObjectAccessStorageStateV2,
} from "../../src/storage/v2-store.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import { opaqueBytes } from "../../src/v2-types/opaque.ts";
import { assertObjectAccessState } from "../../src/storage/v2-record-policy.ts";

function expectExactThrow(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected exact error: ${message}`);
}

async function expectExactRejection(
  action: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected exact rejection: ${message}`);
}

function envelopeWire(
  crypto: LatticeCrypto,
  namespace: string,
  marker: number,
  boundObjectId = "object_storage",
): Uint8Array {
  return encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespaceV2(
      crypto,
      new Uint8Array(32).fill(marker),
      {
        objectId: objectId(boundObjectId),
        namespaceId: namespaceId(namespace),
        keyClass: "human",
        keyGeneration: namespaceGeneration(0),
        bindingRevisionAtWrap: accessRevision(0),
      },
      new Uint8Array(32).fill(marker + 1),
    ),
  );
}

function authorizedObjectWrite(
  expected: ObjectAccessManifestStorageHeadV2 | null,
  intended: ObjectAccessStorageStateV2,
  authorization?: (
    | Omit<
      Extract<ObjectAccessAuthorizationExpectationV2, { kind: "genesis" }>,
      "context"
    >
    | Omit<
      Extract<ObjectAccessAuthorizationExpectationV2, { kind: "update" }>,
      "context"
    >
  ),
): AuthorizedObjectAccessWriteV2 {
  const authorizeMalformedState = (): AuthorizedObjectAccessWriteV2 =>
    authorizeObjectAccessWriteV2({
      expected,
      intended,
      authorization: {
        kind: "genesis",
        context: {
          purpose: "persist-object-access-genesis",
          objectId: "invalid_test_object",
          payloadHash: new Uint8Array(32),
          envelopes: [],
          committerDeviceId: "invalid_test_device",
          hostAuthorizationRevision: 0,
        },
        currentHostAuthorizationRevision: 0,
        committerSigningPublicKeyHash: new Uint8Array(32),
      },
    });
  if (
    typeof intended !== "object"
    || intended === null
    || typeof intended.head !== "object"
    || intended.head === null
    || !(intended.head.manifestBytes instanceof Uint8Array)
    || !Array.isArray(intended.namespaceEnvelopes as unknown)
  ) {
    return authorizeMalformedState();
  }
  try {
    const intendedManifest = decodeObjectAccessManifestV2(
      intended.head.manifestBytes,
    );
    const envelopeContexts = intended.namespaceEnvelopes.map((stored) => {
    const bytes = stored.envelopeBytes.ciphertext;
    const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
    return {
      ...envelope.context,
      envelopeHash: stored.envelopeHash,
    };
  });
  const context = expected === null
    ? {
      purpose: "persist-object-access-genesis" as const,
      objectId: intendedManifest.objectId,
      payloadHash: intendedManifest.payloadHash,
      envelopes: envelopeContexts,
      committerDeviceId: intendedManifest.committerDeviceId,
      hostAuthorizationRevision:
        intendedManifest.hostAuthorizationRevision,
    }
    : (() => {
      const currentManifest = decodeObjectAccessManifestV2(
        expected.manifestBytes,
      );
      const currentHashes = new Set(
        currentManifest.envelopeHashes.map((hash) =>
          Array.from(hash).join(",")
        ),
      );
      const currentEnvelopes = envelopeContexts.filter((envelope) =>
        currentHashes.has(Array.from(envelope.envelopeHash).join(","))
      );
      const attached = envelopeContexts.find((envelope) =>
        !currentHashes.has(Array.from(envelope.envelopeHash).join(","))
      );
      return {
        purpose: "persist-object-access-update" as const,
        operation: attached === undefined ? "detach" as const : "attach" as const,
        objectId: intendedManifest.objectId,
        payloadHash: intendedManifest.payloadHash,
        currentHead: expected,
        nextHead: intended.head,
        currentEnvelopes,
        nextEnvelopes: envelopeContexts,
        affectedEnvelope: attached ?? envelopeContexts[0]!,
        currentCommitterDeviceId: currentManifest.committerDeviceId,
        committerDeviceId: intendedManifest.committerDeviceId,
        currentManifestHostAuthorizationRevision:
          currentManifest.hostAuthorizationRevision,
        hostAuthorizationRevision:
          intendedManifest.hostAuthorizationRevision,
      };
    })();
  const exact: ObjectAccessAuthorizationExpectationV2 = expected === null
    ? {
      kind: "genesis",
      context: context as ObjectAccessGenesisPersistenceAuthorizationContextV2,
      currentHostAuthorizationRevision:
        authorization?.currentHostAuthorizationRevision
          ?? intendedManifest.hostAuthorizationRevision,
      committerSigningPublicKeyHash:
        authorization?.kind === "genesis"
          ? authorization.committerSigningPublicKeyHash
          : new Uint8Array(32).fill(0xa1),
    }
    : {
      kind: "update",
      context: context as ObjectAccessUpdatePersistenceAuthorizationContextV2,
      currentManifestHostAuthorizationRevision:
        authorization?.kind === "update"
          ? authorization.currentManifestHostAuthorizationRevision
          : decodeObjectAccessManifestV2(expected.manifestBytes)
            .hostAuthorizationRevision,
      currentHostAuthorizationRevision:
        authorization?.currentHostAuthorizationRevision
          ?? intendedManifest.hostAuthorizationRevision,
      currentCommitterSigningPublicKeyHash:
        authorization?.kind === "update"
          ? authorization.currentCommitterSigningPublicKeyHash
          : new Uint8Array(32).fill(0xa2),
      nextCommitterSigningPublicKeyHash:
        authorization?.kind === "update"
          ? authorization.nextCommitterSigningPublicKeyHash
          : new Uint8Array(32).fill(0xa3),
    };
    return authorizeObjectAccessWriteV2({
      expected,
      intended,
      authorization: exact,
    });
  } catch {
    return authorizeMalformedState();
  }
}

function fixture(seed = 9_001) {
  const crypto = new LatticeCrypto(seededRng(seed));
  const signing = crypto.generateSigningKeyPair();
  const deviceId = cryptoDeviceId("device_alice");
  const envelopeA = envelopeWire(crypto, "namespace_a", 0x11);
  const envelopeB = envelopeWire(crypto, "namespace_b", 0x22);
  const envelopeC = envelopeWire(crypto, "namespace_c", 0x33);
  const payloadBytes = encodeEncryptedPayloadV2({
    formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    context: {
      objectId: objectId("object_storage"),
      keyClass: "human",
      objectType: "test-record",
      createdAt: unixTimestamp(1),
    },
    ciphertext: new Uint8Array(40).fill(0x44),
  });
  const genesis = createObjectAccessManifestV2(
    crypto,
    {
      objectId: objectId("object_storage"),
      payloadHash: crypto.hash(payloadBytes),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [crypto.hash(envelopeA)],
      committerDeviceId: deviceId,
      hostAuthorizationRevision: authorizationRevision(1),
    },
    signing.privateKey,
  );
  const initial = objectAccessStorageStateV2(
    crypto,
    genesis.bytes,
    [envelopeA],
  );
  const preparedGenesis = prepareObjectAccessManifestGenesisV2(
    crypto,
    {
      objectId: objectId("object_storage"),
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes: [envelopeA],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: deviceId,
      hostAuthorizationRevision: authorizationRevision(1),
      signingPrivateKey: signing.privateKey,
    },
  );
  const resolveSigningPublicKey = (id: string) =>
    id === deviceId ? signing.publicKey : null;
  const authorization = {
    resolveCurrentAuthorization: (
      context: ObjectAccessUpdatePersistenceAuthorizationContextV2,
    ) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision: 2,
      currentHeadCommitterSigningPublicKey: signing.publicKey,
      nextHeadCommitterSigningPublicKey: signing.publicKey,
    }),
  } as const;
  const prepareAttach = (
    envelopeBytes: Uint8Array,
  ): PreparedObjectAccessManifestUpdateV2 =>
    prepareObjectAccessManifestUpdateV2(crypto, {
      currentManifestBytes: genesis.bytes,
      currentEnvelopeBytes: [envelopeA],
      trustedMinimumHead: {
        objectId: objectId("object_storage"),
        payloadHash: genesis.manifest.payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: genesis.hash,
      },
      proof: [],
      resolveSigningPublicKey,
      operation: { type: "attach", envelopeBytes },
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: deviceId,
      hostAuthorizationRevision: authorizationRevision(2),
      signingPrivateKey: signing.privateKey,
    });
  const prepareDetach = (): PreparedObjectAccessManifestUpdateV2 =>
    prepareObjectAccessManifestUpdateV2(crypto, {
      currentManifestBytes: genesis.bytes,
      currentEnvelopeBytes: [envelopeA],
      trustedMinimumHead: {
        objectId: objectId("object_storage"),
        payloadHash: genesis.manifest.payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: genesis.hash,
      },
      proof: [],
      resolveSigningPublicKey,
      operation: { type: "detach", envelopeBytes: envelopeA },
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: deviceId,
      hostAuthorizationRevision: authorizationRevision(2),
      signingPrivateKey: signing.privateKey,
    });
  return {
    crypto,
    signing,
    deviceId,
    envelopeA,
    envelopeB,
    envelopeC,
    payloadBytes,
    genesis,
    initial,
    preparedGenesis,
    resolveSigningPublicKey,
    authorization,
    prepareAttach,
    prepareDetach,
  };
}

async function initializedObjectStore(
  scenario: ReturnType<typeof fixture>,
): Promise<InMemoryV2Store> {
  const store = new InMemoryV2Store();
  await store.putObject({
    objectId: "object_storage",
    payloadBytes: opaqueBytes(
      "encrypted-payload",
      scenario.payloadBytes,
    ),
  });
  return store;
}

class CountingCasStorage implements ObjectAccessUpdateStateCasStorageV2 {
  attempts = 0;

  constructor(
    private readonly backing: InMemoryV2Store,
    private readonly ambiguous = false,
  ) {}

  getObject(objectIdValue: string) {
    return this.backing.getObject(objectIdValue);
  }

  getObjectAccessState(objectIdValue: string) {
    return this.backing.getObjectAccessState(objectIdValue);
  }

  async compareAndSwapObjectAccessState(
    authorized: AuthorizedObjectAccessWriteV2,
  ): Promise<ObjectAccessStateCasStatusV2> {
    this.attempts += 1;
    const status = await this.backing.compareAndSwapObjectAccessState(
      authorized,
    );
    if (this.ambiguous) {
      throw new Error("ambiguous object access CAS delivery");
    }
    return status;
  }
}

describe("v2 object access storage coordinator", () => {
  test("authorized object writes detach exact authorization expectations and are one-shot", () => {
    const scenario = fixture(9_047);
    const committerSigningPublicKeyHash = scenario.crypto.hash(
      scenario.signing.publicKey,
    );
    const capability = authorizeObjectAccessWriteV2({
      expected: null,
      intended: scenario.initial,
      authorization: {
        kind: "genesis",
        context: {
          purpose: "persist-object-access-genesis",
          objectId: "object_storage",
          payloadHash: scenario.genesis.manifest.payloadHash,
          envelopes: [{
            objectId: "object_storage",
            namespaceId: "namespace_a",
            keyClass: "human",
            keyGeneration: 0,
            bindingRevisionAtWrap: 0,
            envelopeHash: scenario.crypto.hash(scenario.envelopeA),
          }],
          committerDeviceId: scenario.deviceId,
          hostAuthorizationRevision: 1,
        },
        currentHostAuthorizationRevision: authorizationRevision(1),
        committerSigningPublicKeyHash,
      },
    });

    scenario.initial.head.manifestHash.fill(0xee);
    committerSigningPublicKeyHash.fill(0xdd);
    expect(consumeAuthorizedObjectAccessWriteV2(capability)).toEqual({
      expected: null,
      intended: {
        ...scenario.initial,
        head: {
          ...scenario.initial.head,
          manifestHash: scenario.genesis.hash,
        },
      },
      authorization: {
        kind: "genesis",
        context: {
          purpose: "persist-object-access-genesis",
          objectId: "object_storage",
          payloadHash: scenario.genesis.manifest.payloadHash,
          envelopes: [{
            objectId: "object_storage",
            namespaceId: "namespace_a",
            keyClass: "human",
            keyGeneration: 0,
            bindingRevisionAtWrap: 0,
            envelopeHash: scenario.crypto.hash(scenario.envelopeA),
          }],
          committerDeviceId: scenario.deviceId,
          hostAuthorizationRevision: 1,
        },
        currentHostAuthorizationRevision: 1,
        committerSigningPublicKeyHash: scenario.crypto.hash(
          scenario.signing.publicKey,
        ),
      },
    });
    expect(() =>
      consumeAuthorizedObjectAccessWriteV2(capability)
    ).toThrow("authorized object access write capability");
    expect(() =>
      consumeAuthorizedObjectAccessWriteV2({
        expected: null,
        intended: scenario.initial,
        authorization: {
          kind: "genesis",
          currentHostAuthorizationRevision: 1,
          committerSigningPublicKeyHash: scenario.crypto.hash(
            scenario.signing.publicKey,
          ),
        },
      } as never)
    ).toThrow("authorized object access write capability");
    expect(() =>
      consumeAuthorizedObjectAccessWriteV2(undefined as never)
    ).toThrow("authorized object access write capability");

    const mutated = authorizeObjectAccessWriteV2({
      expected: null,
      intended: scenario.initial,
      authorization: {
        kind: "genesis",
        context: {
          purpose: "persist-object-access-genesis",
          objectId: "object_storage",
          payloadHash: scenario.genesis.manifest.payloadHash,
          envelopes: [{
            objectId: "object_storage",
            namespaceId: "namespace_a",
            keyClass: "human",
            keyGeneration: 0,
            bindingRevisionAtWrap: 0,
            envelopeHash: scenario.crypto.hash(scenario.envelopeA),
          }],
          committerDeviceId: scenario.deviceId,
          hostAuthorizationRevision: 1,
        },
        currentHostAuthorizationRevision: 1,
        committerSigningPublicKeyHash: scenario.crypto.hash(
          scenario.signing.publicKey,
        ),
      },
    });
    if (mutated.authorization.kind !== "genesis") {
      throw new Error("expected genesis authorization");
    }
    mutated.authorization.committerSigningPublicKeyHash[0] =
      mutated.authorization.committerSigningPublicKeyHash[0]! ^ 1;
    expect(() =>
      consumeAuthorizedObjectAccessWriteV2(mutated)
    ).toThrow("authorized object access write capability");
  });

  test("authorized object writes freeze their shape and detect every mutable byte leaf", () => {
    const scenario = fixture(9_047_1);
    const mint = (): AuthorizedObjectAccessWriteV2 =>
      authorizedObjectWrite(null, scenario.initial);
    const byteLeaves = (
      value: unknown,
      result: Uint8Array[] = [],
    ): Uint8Array[] => {
      if (value instanceof Uint8Array) {
        result.push(value);
      } else if (typeof value === "object" && value !== null) {
        expect(Object.isFrozen(value)).toBeTrue();
        for (const child of Object.values(value)) {
          byteLeaves(child, result);
        }
      }
      return result;
    };

    const shape = mint();
    const shapeBytes = byteLeaves(shape);
    expect(shapeBytes.length).toBeGreaterThan(0);
    for (const bytes of shapeBytes) {
      expect(Object.isExtensible(bytes)).toBeFalse();
    }
    const hostilePrototype: object = {
      every: () => true,
    };
    Object.setPrototypeOf(hostilePrototype, Uint8Array.prototype);
    expect(() => {
      Object.setPrototypeOf(
        shapeBytes[0]!,
        hostilePrototype,
      );
    }).toThrow();

    const detached = mint();
    const detachedBytes = byteLeaves(detached)[0]!;
    if (!(detachedBytes.buffer instanceof ArrayBuffer)) {
      throw new Error("expected an owned ArrayBuffer-backed byte leaf");
    }
    structuredClone(detachedBytes, {
      transfer: [detachedBytes.buffer],
    });
    expect(() =>
      consumeAuthorizedObjectAccessWriteV2(detached)
    ).toThrow("authorized object access write capability");

    for (let index = 0; index < shapeBytes.length; index += 1) {
      const capability = mint();
      const bytes = byteLeaves(capability)[index]!;
      bytes[0] = bytes[0]! ^ 1;
      expect(() =>
        consumeAuthorizedObjectAccessWriteV2(capability)
      ).toThrow("authorized object access write capability");
    }
  });

  test("authorized object writes detach Buffer-backed byte inputs", () => {
    const scenario = fixture(9_047_2);
    const source = Buffer.from(scenario.initial.head.manifestHash);
    const pristine = Uint8Array.from(source);
    const capability = authorizedObjectWrite(null, {
      ...scenario.initial,
      head: {
        ...scenario.initial.head,
        manifestHash: source,
      },
    });

    source.fill(0);
    const consumed = consumeAuthorizedObjectAccessWriteV2(capability);
    expect(consumed.intended.head.manifestHash).toEqual(pristine);
    expect(Buffer.isBuffer(
      consumed.intended.head.manifestHash,
    )).toBeFalse();
  });

  test("object write authorization rejects structurally forged opaque ciphertext", () => {
    const scenario = fixture(9_048);
    const envelope = scenario.initial.namespaceEnvelopes[0]!;
    for (const classification of ["opaque-ciphertext", "not-opaque"]) {
      const forgedState: ObjectAccessStorageStateV2 = {
        ...scenario.initial,
        namespaceEnvelopes: [{
          ...envelope,
          envelopeBytes: {
            classification,
            kind: "namespace-object-envelope",
            ciphertext: envelope.envelopeBytes.ciphertext.slice(),
          } as never,
        }],
      };

      expect(() => authorizedObjectWrite(null, forgedState)).toThrow(
        "Namespace object envelope must be opaque namespace-object-envelope ciphertext",
      );
    }

    expect(() => authorizedObjectWrite(null, {
      ...scenario.initial,
      namespaceEnvelopes: [{
        ...envelope,
        envelopeBytes: undefined,
      }] as never,
    })).toThrow(
      "Namespace object envelope must be opaque namespace-object-envelope ciphertext",
    );

    expect(() => authorizeObjectAccessWriteV2({
      expected: null,
      intended: scenario.initial,
      authorization: {
        classification: "opaque-ciphertext",
        kind: null,
        ciphertext: new Uint8Array([1, 2, 3]),
      } as never,
    })).toThrow("opaque bytes must be opaque");
  });

  test("opaque cloning does not misclassify ordinary byte-bearing records", () => {
    const scenario = fixture(9_048_1);
    const snapshot = consumeAuthorizedObjectAccessWriteV2(
      authorizedObjectWrite(null, scenario.initial),
    );
    const capability = authorizeObjectAccessWriteV2({
      ...snapshot,
      authorization: {
        ...snapshot.authorization,
        ordinaryRecord: {
          kind: "not-opaque",
          ciphertext: new Uint8Array([1, 2, 3]),
        },
      } as never,
    });

    expect(() =>
      consumeAuthorizedObjectAccessWriteV2(capability)
    ).not.toThrow();
  });

  test("object CAS atomically enforces genesis and update authorization expectations", async () => {
    const scenario = fixture(9_046);
    const store = await initializedObjectStore(scenario);
    const genesisHash = scenario.crypto.hash(scenario.signing.publicKey);

    const structural = {
      expected: null,
      intended: scenario.initial,
      authorization: {
        kind: "genesis",
        currentHostAuthorizationRevision: 1,
        committerSigningPublicKeyHash: genesisHash,
      },
    };
    expect(
      store.compareAndSwapObjectAccessState(structural as never),
    ).rejects.toThrow("authorized object access write capability");
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, scenario.initial, {
          kind: "genesis",
          currentHostAuthorizationRevision: 2,
          committerSigningPublicKeyHash: genesisHash,
        }),
      ),
    ).toBe("stale");
    expect(await store.getObjectAccessState("object_storage")).toBeNull();
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, scenario.initial),
      ),
    ).toBe("applied");
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, scenario.initial, {
          kind: "genesis",
          currentHostAuthorizationRevision: 2,
          committerSigningPublicKeyHash: genesisHash,
        }),
      ),
    ).toBe("stale");

    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const intended = objectAccessStorageStateV2(
      scenario.crypto,
      prepared.manifestBytes,
      prepared.envelopeBytes,
    );
    const updateHash = scenario.crypto.hash(scenario.signing.publicKey);
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(scenario.initial.head, intended, {
          kind: "update",
          currentManifestHostAuthorizationRevision: 2,
          currentHostAuthorizationRevision: 2,
          currentCommitterSigningPublicKeyHash: updateHash,
          nextCommitterSigningPublicKeyHash: updateHash,
        }),
      ),
    ).toBe("stale");
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(scenario.initial.head, intended, {
          kind: "update",
          currentManifestHostAuthorizationRevision: 1,
          currentHostAuthorizationRevision: 3,
          currentCommitterSigningPublicKeyHash: updateHash,
          nextCommitterSigningPublicKeyHash: updateHash,
        }),
      ),
    ).toBe("stale");
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(scenario.initial.head, intended),
      ),
    ).toBe("applied");
  });

  test("direct-store CAS independently rechecks every authenticated host-authorization coordinate", async () => {
    const scenario = fixture(9_046_1);
    const store = await initializedObjectStore(scenario);
    const genesisSnapshot = consumeAuthorizedObjectAccessWriteV2(
      authorizedObjectWrite(null, scenario.initial),
    );
    if (genesisSnapshot.authorization.kind !== "genesis") {
      throw new Error("expected genesis authorization");
    }
    for (const [message, authorization] of [
      [
        "Object access genesis authorization expectation has an invalid field set",
        { ...genesisSnapshot.authorization, extra: true },
      ],
      [
        "Authorization revision must be a non-negative safe integer",
        {
          ...genesisSnapshot.authorization,
          currentHostAuthorizationRevision: -1,
        },
      ],
      [
        "Object access genesis committer signing public key hash must be exactly 32 bytes",
        {
          ...genesisSnapshot.authorization,
          committerSigningPublicKeyHash: new Uint8Array(31),
        },
      ],
    ] as const) {
      await expectExactRejection(
        store.compareAndSwapObjectAccessState(
          authorizeObjectAccessWriteV2({
            expected: null,
            intended: scenario.initial,
            authorization: authorization as never,
          }),
        ),
        message,
      );
    }
    for (const [label, authorization] of [
      [
        "genesis context object",
        {
          ...genesisSnapshot.authorization,
          context: {
            ...genesisSnapshot.authorization.context,
            objectId: objectId("object_other"),
          },
        },
      ],
      [
        "genesis context payload",
        {
          ...genesisSnapshot.authorization,
          context: {
            ...genesisSnapshot.authorization.context,
            payloadHash: new Uint8Array(32).fill(0xee),
          },
        },
      ],
      [
        "genesis context revision",
        {
          ...genesisSnapshot.authorization,
          context: {
            ...genesisSnapshot.authorization.context,
            hostAuthorizationRevision: authorizationRevision(2),
          },
        },
      ],
      [
        "genesis fresh revision",
        {
          ...genesisSnapshot.authorization,
          currentHostAuthorizationRevision: authorizationRevision(2),
        },
      ],
      [
        "genesis manifest revision",
        {
          ...genesisSnapshot.authorization,
          context: {
            ...genesisSnapshot.authorization.context,
            hostAuthorizationRevision: authorizationRevision(2),
          },
          currentHostAuthorizationRevision: authorizationRevision(2),
        },
      ],
    ] as const) {
      expect(
        await store.compareAndSwapObjectAccessState(
          authorizeObjectAccessWriteV2({
            expected: null,
            intended: scenario.initial,
            authorization,
          }),
        ),
        label,
      ).toBe("stale");
    }

    expect(
      await new InMemoryV2Store().compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, scenario.initial),
      ),
    ).toBe("stale");
    const wrongPayloadStore = new InMemoryV2Store();
    await wrongPayloadStore.putObject({
      objectId: "object_storage",
      payloadBytes: opaqueBytes(
        "encrypted-payload",
        encodeEncryptedPayloadV2({
          formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
          context: {
            objectId: objectId("object_storage"),
            keyClass: "human",
            objectType: "test-record",
            createdAt: unixTimestamp(1),
          },
          ciphertext: new Uint8Array(40).fill(0x99),
        }),
      ),
    });
    expect(
      await wrongPayloadStore.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, scenario.initial),
      ),
    ).toBe("stale");

    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const intended = objectAccessStorageStateV2(
      scenario.crypto,
      prepared.manifestBytes,
      prepared.envelopeBytes,
    );
    const updateSnapshot = consumeAuthorizedObjectAccessWriteV2(
      authorizedObjectWrite(scenario.initial.head, intended),
    );
    if (updateSnapshot.authorization.kind !== "update") {
      throw new Error("expected update authorization");
    }
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, intended),
      ),
    ).toBe("stale");
    for (const [message, authorization] of [
      [
        "Object access update authorization expectation has an invalid field set",
        { ...updateSnapshot.authorization, extra: true },
      ],
      [
        "Object access authorization expectation kind is invalid",
        { ...updateSnapshot.authorization, kind: "other" },
      ],
      [
        "Authorization revision must be a non-negative safe integer",
        {
          ...updateSnapshot.authorization,
          currentManifestHostAuthorizationRevision: -1,
        },
      ],
      [
        "Authorization revision must be a non-negative safe integer",
        {
          ...updateSnapshot.authorization,
          currentHostAuthorizationRevision: -1,
        },
      ],
      [
        "Object access current committer signing public key hash must be exactly 32 bytes",
        {
          ...updateSnapshot.authorization,
          currentCommitterSigningPublicKeyHash: new Uint8Array(31),
        },
      ],
      [
        "Object access next committer signing public key hash must be exactly 32 bytes",
        {
          ...updateSnapshot.authorization,
          nextCommitterSigningPublicKeyHash: new Uint8Array(31),
        },
      ],
    ] as const) {
      await expectExactRejection(
        store.compareAndSwapObjectAccessState(
          authorizeObjectAccessWriteV2({
            expected: scenario.initial.head,
            intended,
            authorization: authorization as never,
          }),
        ),
        message,
      );
    }

    expect(
      await store.compareAndSwapObjectAccessState(
        authorizeObjectAccessWriteV2({
          expected: null,
          intended: scenario.initial,
          authorization: {
            ...updateSnapshot.authorization,
            context: {
              ...updateSnapshot.authorization.context,
              objectId: scenario.initial.head.objectId,
              payloadHash: scenario.genesis.manifest.payloadHash,
              hostAuthorizationRevision: authorizationRevision(1),
            },
            currentHostAuthorizationRevision: authorizationRevision(1),
          },
        }),
      ),
    ).toBe("stale");
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizeObjectAccessWriteV2(genesisSnapshot),
      ),
    ).toBe("applied");
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizeObjectAccessWriteV2({
          expected: scenario.initial.head,
          intended,
          authorization: genesisSnapshot.authorization,
        }),
      ),
    ).toBe("stale");

    for (const [label, authorization] of [
      [
        "update context object",
        {
          ...updateSnapshot.authorization,
          context: {
            ...updateSnapshot.authorization.context,
            objectId: objectId("object_other"),
          },
        },
      ],
      [
        "update context current head",
        {
          ...updateSnapshot.authorization,
          context: {
            ...updateSnapshot.authorization.context,
            currentHead: intended.head,
          },
        },
      ],
      [
        "update context next head",
        {
          ...updateSnapshot.authorization,
          context: {
            ...updateSnapshot.authorization.context,
            nextHead: scenario.initial.head,
          },
        },
      ],
      [
        "update context payload",
        {
          ...updateSnapshot.authorization,
          context: {
            ...updateSnapshot.authorization.context,
            payloadHash: new Uint8Array(32).fill(0xee),
          },
        },
      ],
      [
        "update context current revision",
        {
          ...updateSnapshot.authorization,
          context: {
            ...updateSnapshot.authorization.context,
            currentManifestHostAuthorizationRevision:
              authorizationRevision(2),
          },
        },
      ],
      [
        "update context next revision",
        {
          ...updateSnapshot.authorization,
          context: {
            ...updateSnapshot.authorization.context,
            hostAuthorizationRevision: authorizationRevision(3),
          },
        },
      ],
      [
        "update fresh current revision",
        {
          ...updateSnapshot.authorization,
          currentManifestHostAuthorizationRevision:
            authorizationRevision(2),
        },
      ],
      [
        "update fresh next revision",
        {
          ...updateSnapshot.authorization,
          currentHostAuthorizationRevision: authorizationRevision(3),
        },
      ],
      [
        "update manifest current revision",
        {
          ...updateSnapshot.authorization,
          context: {
            ...updateSnapshot.authorization.context,
            currentManifestHostAuthorizationRevision:
              authorizationRevision(2),
          },
          currentManifestHostAuthorizationRevision:
            authorizationRevision(2),
        },
      ],
      [
        "update manifest next revision",
        {
          ...updateSnapshot.authorization,
          context: {
            ...updateSnapshot.authorization.context,
            hostAuthorizationRevision: authorizationRevision(3),
          },
          currentHostAuthorizationRevision: authorizationRevision(3),
        },
      ],
    ] as const) {
      expect(
        await store.compareAndSwapObjectAccessState(
          authorizeObjectAccessWriteV2({
            expected: scenario.initial.head,
            intended,
            authorization,
          }),
        ),
        label,
      ).toBe("stale");
    }
  });

  test("prepares genesis only with both authorizations and object-bound envelopes", () => {
    const scenario = fixture(9_048);
    const input = {
      objectId: objectId("object_storage"),
      payloadHash: scenario.crypto.hash(scenario.payloadBytes),
      envelopeBytes: [scenario.envelopeA],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: scenario.deviceId,
      hostAuthorizationRevision: authorizationRevision(1),
      signingPrivateKey: scenario.signing.privateKey,
    };
    expectExactThrow(
      () =>
        prepareObjectAccessManifestGenesisV2(scenario.crypto, {
          ...input,
          sourceAuthorized: false,
        }),
      "object access genesis requires explicit source and target authorization",
    );
    expectExactThrow(
      () =>
        prepareObjectAccessManifestGenesisV2(scenario.crypto, {
          ...input,
          targetAuthorized: false,
        }),
      "object access genesis requires explicit source and target authorization",
    );
    expectExactThrow(
      () =>
        prepareObjectAccessManifestGenesisV2(scenario.crypto, {
          ...input,
          envelopeBytes: [
            envelopeWire(
              scenario.crypto,
              "namespace_a",
              0x41,
              "object_other",
            ),
          ],
        }),
      "Namespace envelope object mismatch",
    );
  });

  test("authentically prepares and persists genesis with fresh authorization", async () => {
    const scenario = fixture(9_049);
    const store = await initializedObjectStore(scenario);
    const contexts: unknown[] = [];
    const persist = (
      prepared: PreparedObjectAccessManifestGenesisV2 =
        scenario.preparedGenesis,
    ) =>
      persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage: store,
        prepared,
        resolveCurrentAuthorization: (context) => {
          contexts.push(context);
          return {
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision: 1,
            committerSigningPublicKey: scenario.signing.publicKey,
          };
        },
      });

    expect(await persist()).toBe("applied");
    expect(await persist()).toBe("duplicate");
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toEqual({
      purpose: "persist-object-access-genesis",
      objectId: "object_storage",
      payloadHash: scenario.genesis.manifest.payloadHash,
      envelopes: [{
        objectId: "object_storage",
        namespaceId: "namespace_a",
        keyClass: "human",
        keyGeneration: 0,
        bindingRevisionAtWrap: 0,
        envelopeHash: scenario.crypto.hash(scenario.envelopeA),
      }],
      committerDeviceId: scenario.deviceId,
      hostAuthorizationRevision: 1,
    });

    const competingGenesis = prepareObjectAccessManifestGenesisV2(
      scenario.crypto,
      {
        objectId: objectId("object_storage"),
        payloadHash: scenario.crypto.hash(scenario.payloadBytes),
        envelopeBytes: [scenario.envelopeA],
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: scenario.deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: scenario.signing.privateKey,
      },
    );
    expect(
      await persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage: store,
        prepared: competingGenesis,
        resolveCurrentAuthorization: (context) => ({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: 2,
          committerSigningPublicKey: scenario.signing.publicKey,
        }),
      }),
    ).toBe("stale");

    await expectExactRejection(
      persist({ ...scenario.preparedGenesis }),
      "object access genesis persistence requires an authentic prepared genesis",
    );
  });

  test("genesis resolves after object read immediately before CAS and observes revocation", async () => {
    const scenario = fixture(9_054);
    const backing = await initializedObjectStore(scenario);
    const events: string[] = [];
    expect(
      await persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage: {
          getObject: async (id) => {
            events.push("read-object");
            return backing.getObject(id);
          },
          compareAndSwapObjectAccessState: async (authorized) => {
            events.push("cas");
            expect(authorized.authorization).toMatchObject({
              kind: "genesis",
              currentHostAuthorizationRevision: 1,
              committerSigningPublicKeyHash: scenario.crypto.hash(
                scenario.signing.publicKey,
              ),
            });
            return backing.compareAndSwapObjectAccessState(
              authorized,
            );
          },
        },
        prepared: scenario.preparedGenesis,
        resolveCurrentAuthorization: async (context) => {
          events.push("resolve-start");
          await Promise.resolve();
          events.push("resolve-complete");
          return {
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision: 1,
            committerSigningPublicKey: scenario.signing.publicKey,
          };
        },
      }),
    ).toBe("applied");
    expect(events).toEqual([
      "read-object",
      "resolve-start",
      "resolve-complete",
      "cas",
    ]);

    const revokedBacking = await initializedObjectStore(scenario);
    let revokedAfterObjectRead = false;
    let revokedCasAttempts = 0;
    expect(
      await persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage: {
          getObject: async (id) => {
            const object = await revokedBacking.getObject(id);
            revokedAfterObjectRead = true;
            return object;
          },
          compareAndSwapObjectAccessState: () => {
            revokedCasAttempts += 1;
            return Promise.resolve("applied");
          },
        },
        prepared: scenario.preparedGenesis,
        resolveCurrentAuthorization: () => {
          expect(revokedAfterObjectRead).toBe(true);
          return null;
        },
      }),
    ).toBe("stale");
    expect(revokedCasAttempts).toBe(0);
  });

  test("genesis fails closed on restart forgery and fresh revocation", async () => {
    const scenario = fixture(9_050);
    const backing = await initializedObjectStore(scenario);
    let casAttempts = 0;
    const storage: ObjectAccessStateCasStorageV2 = {
      getObject: backing.getObject.bind(backing),
      compareAndSwapObjectAccessState(authorized) {
        casAttempts += 1;
        return backing.compareAndSwapObjectAccessState(authorized);
      },
    };
    const persist = (
      resolveCurrentAuthorization:
        Parameters<
          typeof persistPreparedObjectAccessManifestGenesisV2
        >[0]["resolveCurrentAuthorization"],
    ) =>
      persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage,
        prepared: scenario.preparedGenesis,
        resolveCurrentAuthorization,
      });

    expect(await persist(() => null)).toBe("stale");
    expect(await persist((context) => ({
      ...context,
      sourceAuthorized: false,
      targetAuthorized: true,
      currentHostAuthorizationRevision: 1,
      committerSigningPublicKey: scenario.signing.publicKey,
    }))).toBe("stale");
    expect(await persist((context) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: false,
      currentHostAuthorizationRevision: 1,
      committerSigningPublicKey: scenario.signing.publicKey,
    }))).toBe("stale");
    expect(await persist((context) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision: 2,
      committerSigningPublicKey: scenario.signing.publicKey,
    }))).toBe("stale");
    expect(await persist((context) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision: 1,
      committerSigningPublicKey: new Uint8Array(
        V2_LIMITS.signingPublicKeyBytes - 1,
      ),
    }))).toBe("stale");
    expect(await persist((context) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision: 1,
      committerSigningPublicKey:
        scenario.crypto.generateSigningKeyPair().publicKey,
    }))).toBe("stale");
    expect(await persist((context) => ({
      ...context,
      envelopes: [],
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision: 1,
      committerSigningPublicKey: scenario.signing.publicKey,
    }))).toBe("stale");
    expect(await persist((context) => ({
      ...context,
      envelopes: context.envelopes.map((envelope) => ({
        ...envelope,
        namespaceId: "namespace_substituted",
      })),
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision: 1,
      committerSigningPublicKey: scenario.signing.publicKey,
    }))).toBe("stale");
    expect(casAttempts).toBe(0);

    const forged = {
      ...scenario.preparedGenesis,
      manifestBytes: scenario.preparedGenesis.manifestBytes.slice(),
    } as PreparedObjectAccessManifestGenesisV2;
    await expectExactRejection(
      persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage,
        prepared: forged,
        resolveCurrentAuthorization: (context) => ({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: 1,
          committerSigningPublicKey: scenario.signing.publicKey,
        }),
      }),
      "object access genesis persistence requires an authentic prepared genesis",
    );
    expect(casAttempts).toBe(0);
  });

  test("genesis fails stale before authorization when the persisted payload is absent or has another hash", async () => {
    const scenario = fixture(9_066);
    const mismatchedPayload = encodeEncryptedPayloadV2({
      formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
      context: {
        objectId: objectId("object_storage"),
        keyClass: "human",
        objectType: "test-record",
        createdAt: unixTimestamp(1),
      },
      ciphertext: new Uint8Array(40).fill(0x55),
    });
    for (const persistedObject of [
      null,
      {
        objectId: "object_storage",
        payloadBytes: mismatchedPayload,
      },
    ]) {
      let resolverCalls = 0;
      let casAttempts = 0;
      const storage: ObjectAccessStateCasStorageV2 = {
        getObject: () => Promise.resolve(persistedObject as never),
        compareAndSwapObjectAccessState: () => {
          casAttempts += 1;
          return Promise.resolve("applied");
        },
      };
      expect(
        await persistPreparedObjectAccessManifestGenesisV2({
          crypto: scenario.crypto,
          storage,
          prepared: scenario.preparedGenesis,
          resolveCurrentAuthorization: () => {
            resolverCalls += 1;
            throw new Error("authorization must not run");
          },
        }),
      ).toBe("stale");
      expect(resolverCalls).toBe(0);
      expect(casAttempts).toBe(0);
    }
  });

  test("update fails stale before authorization when the persisted payload is absent or has another hash", async () => {
    const scenario = fixture(9_072);
    const backing = await initializedObjectStore(scenario);
    await backing.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const mismatchedPayload = encodeEncryptedPayloadV2({
      formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
      context: {
        objectId: objectId("object_storage"),
        keyClass: "human",
        objectType: "test-record",
        createdAt: unixTimestamp(1),
      },
      ciphertext: new Uint8Array(40).fill(0x56),
    });
    for (const persistedObject of [
      null,
      {
        objectId: "object_storage",
        payloadBytes: mismatchedPayload,
      },
    ]) {
      let resolverCalls = 0;
      let casAttempts = 0;
      const storage: ObjectAccessUpdateStateCasStorageV2 = {
        getObject: () => Promise.resolve(persistedObject as never),
        getObjectAccessState:
          backing.getObjectAccessState.bind(backing),
        compareAndSwapObjectAccessState: () => {
          casAttempts += 1;
          return Promise.resolve("applied");
        },
      };
      expect(
        await persistPreparedObjectAccessManifestUpdateV2(
          scenario.crypto,
          storage,
          scenario.initial.head,
          prepared,
          {
            resolveCurrentAuthorization: () => {
              resolverCalls += 1;
              throw new Error("authorization must not run");
            },
          },
        ),
      ).toBe("stale");
      expect(resolverCalls).toBe(0);
      expect(casAttempts).toBe(0);
    }
  });

  test("rejects every independently malformed or substituted genesis authorization coordinate", async () => {
    const scenario = fixture(9_062);
    const backing = await initializedObjectStore(scenario);
    let casAttempts = 0;
    const storage: ObjectAccessStateCasStorageV2 = {
      getObject: backing.getObject.bind(backing),
      compareAndSwapObjectAccessState: () => {
        casAttempts += 1;
        return Promise.resolve("applied");
      },
    };
    type Context = ObjectAccessGenesisPersistenceAuthorizationContextV2;
    type Decision = ObjectAccessGenesisPersistenceAuthorizationV2;
    const base = (context: Context): Decision => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision: 1,
      committerSigningPublicKey: scenario.signing.publicKey,
    });
    const persist = (
      resolveCurrentAuthorization:
        Parameters<
          typeof persistPreparedObjectAccessManifestGenesisV2
        >[0]["resolveCurrentAuthorization"],
    ) =>
      persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage,
        prepared: scenario.preparedGenesis,
        resolveCurrentAuthorization,
      });

    const malformed: readonly [
      (context: Context) => Decision,
      string,
    ][] = [
      [
        (context: Context) => ({ ...base(context), unexpected: true }),
        "object access genesis persistence authorization has an invalid field set",
      ],
      [
        (context: Context) => ({
          ...base(context),
          envelopes: "envelopes" as never,
        }),
        "object access genesis authorized envelopes must be an array",
      ],
      [
        (context: Context) => ({ ...base(context), purpose: "wrong" as never }),
        "object access genesis authorization context is invalid",
      ],
      [
        (context: Context) => ({ ...base(context), objectId: 1 as never }),
        "object access genesis authorization context is invalid",
      ],
      [
        (context: Context) => ({
          ...base(context),
          committerDeviceId: 1 as never,
        }),
        "object access genesis authorization context is invalid",
      ],
      [
        (context: Context) => ({
          ...base(context),
          hostAuthorizationRevision: Number.NaN,
        }),
        "object access genesis authorization context is invalid",
      ],
      [
        (context: Context) => ({
          ...base(context),
          hostAuthorizationRevision: -1,
        }),
        "object access genesis authorization context is invalid",
      ],
      [
        (context: Context) => ({
          ...base(context),
          payloadHash: new Uint8Array(31),
        }),
        "object access genesis authorization payload hash must be exactly 32 bytes",
      ],
      [
        (context: Context) => ({
          ...base(context),
          payloadHash: "hash" as never,
        }),
        "object access genesis authorization payload hash must be exactly 32 bytes",
      ],
      [
        (context: Context) => ({
          ...base(context),
          envelopes: context.envelopes.map((envelope) => ({
            ...envelope,
            unexpected: true,
          })),
        }) as Decision,
        "object access genesis authorized envelope has an invalid field set",
      ],
      ...([
        ["objectId", 1],
        ["namespaceId", 1],
        ["keyClass", "wrong"],
        ["keyGeneration", Number.NaN],
        ["keyGeneration", -1],
        ["bindingRevisionAtWrap", Number.NaN],
        ["bindingRevisionAtWrap", -1],
        ["envelopeHash", new Uint8Array(31)],
      ] as const).map(([field, value]) => [
        (context: Context) => ({
          ...base(context),
          envelopes: context.envelopes.map((envelope) => ({
            ...envelope,
            [field]: value,
          })),
        }),
        field === "envelopeHash"
          ? "object access genesis authorized envelope hash must be exactly 32 bytes"
          : "object access genesis authorized envelope coordinates are invalid",
      ] as [(context: Context) => Decision, string]),
    ];
    for (const [resolve, message] of malformed) {
      await expectExactRejection(persist(resolve), message);
    }

    const substitutions = [
      (context: Context) => ({ ...base(context), objectId: "object_other" }),
      (context: Context) => ({
        ...base(context),
        payloadHash: new Uint8Array(32).fill(0xee),
      }),
      (context: Context) => ({
        ...base(context),
        committerDeviceId: "device_other",
      }),
      (context: Context) => ({
        ...base(context),
        hostAuthorizationRevision: 2,
      }),
      (context: Context) => ({ ...base(context), envelopes: [] }),
      ...([
        ["objectId", "object_other"],
        ["namespaceId", "namespace_other"],
        ["keyClass", "ai"],
        ["keyGeneration", 1],
        ["bindingRevisionAtWrap", 1],
        ["envelopeHash", new Uint8Array(32).fill(0xee)],
      ] as const).map(([field, value]) =>
        (context: Context) => ({
          ...base(context),
          envelopes: context.envelopes.map((envelope) => ({
            ...envelope,
            [field]: value,
          })),
        })
      ),
    ];
    for (const resolveCurrentAuthorization of substitutions) {
      expect(await persist(resolveCurrentAuthorization as never)).toBe(
        "stale",
      );
    }
    expect(casAttempts).toBe(0);
  });

  test("accepts revision zero and exposes multi-envelope authorization contexts in canonical Namespace order", async () => {
    const scenario = fixture(9_065);
    const preparedGenesis = prepareObjectAccessManifestGenesisV2(
      scenario.crypto,
      {
        objectId: objectId("object_storage"),
        payloadHash: scenario.crypto.hash(scenario.payloadBytes),
        envelopeBytes: [scenario.envelopeB, scenario.envelopeA],
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: scenario.deviceId,
        hostAuthorizationRevision: authorizationRevision(0),
        signingPrivateKey: scenario.signing.privateKey,
      },
    );
    const store = await initializedObjectStore(scenario);
    expect(
      await persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage: store,
        prepared: preparedGenesis,
        resolveCurrentAuthorization: (context) => {
          expect(context.hostAuthorizationRevision).toBe(0);
          expect(context.envelopes.map((entry) => entry.namespaceId)).toEqual([
            "namespace_a",
            "namespace_b",
          ]);
          return {
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision: 0,
            committerSigningPublicKey: scenario.signing.publicKey,
          };
        },
      }),
    ).toBe("applied");
    expect(
      await persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage: store,
        prepared: preparedGenesis,
        resolveCurrentAuthorization: (context) => ({
          ...context,
          envelopes: context.envelopes.map((envelope, index) =>
            index === 0
              ? { ...envelope, namespaceId: "namespace_substituted" }
              : envelope
          ),
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: 0,
          committerSigningPublicKey: scenario.signing.publicKey,
        }),
      }),
    ).toBe("stale");

    const preparedUpdate = prepareObjectAccessManifestUpdateV2(
      scenario.crypto,
      {
        currentManifestBytes: preparedGenesis.manifestBytes,
        currentEnvelopeBytes: preparedGenesis.envelopeBytes,
        trustedMinimumHead: {
          objectId: objectId("object_storage"),
          payloadHash: preparedGenesis.manifest.payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: preparedGenesis.manifestHash,
        },
        proof: [],
        resolveSigningPublicKey: () => scenario.signing.publicKey,
        operation: {
          type: "attach",
          envelopeBytes: scenario.envelopeC,
        },
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: scenario.deviceId,
        hostAuthorizationRevision: authorizationRevision(0),
        signingPrivateKey: scenario.signing.privateKey,
      },
    );
    const rawCurrent = (await store.getObjectAccessState("object_storage"))!;
    const firstPersistedEnvelope = rawCurrent.namespaceEnvelopes[0]!;
    await expectExactRejection(
      persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        {
          getObject: store.getObject.bind(store),
          getObjectAccessState: () =>
            Promise.resolve({
              ...rawCurrent,
              namespaceEnvelopes: [
                {
                  ...firstPersistedEnvelope,
                  namespaceId: "namespace_substituted",
                },
                ...rawCurrent.namespaceEnvelopes.slice(1),
              ],
            }),
          compareAndSwapObjectAccessState: () => Promise.resolve("applied"),
        },
        {
          objectId: preparedGenesis.manifest.objectId,
          accessRevision: preparedGenesis.manifest.accessRevision,
          manifestHash: preparedGenesis.manifestHash,
          manifestBytes: preparedGenesis.manifestBytes,
        },
        preparedUpdate,
        {
          resolveCurrentAuthorization: (context) => ({
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision: 0,
            currentHeadCommitterSigningPublicKey:
              scenario.signing.publicKey,
            nextHeadCommitterSigningPublicKey: scenario.signing.publicKey,
          }),
        },
      ),
      "persisted object access state does not match canonical wire bytes",
    );
    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        store,
        {
          objectId: preparedGenesis.manifest.objectId,
          accessRevision: preparedGenesis.manifest.accessRevision,
          manifestHash: preparedGenesis.manifestHash,
          manifestBytes: preparedGenesis.manifestBytes,
        },
        preparedUpdate,
        {
          resolveCurrentAuthorization: (context) => {
            expect(context.currentManifestHostAuthorizationRevision).toBe(0);
            expect(context.hostAuthorizationRevision).toBe(0);
            expect(
              context.currentEnvelopes.map((entry) => entry.namespaceId),
            ).toEqual(["namespace_a", "namespace_b"]);
            expect(
              context.nextEnvelopes.map((entry) => entry.namespaceId),
            ).toEqual(["namespace_a", "namespace_b", "namespace_c"]);
            return {
              ...context,
              sourceAuthorized: true,
              targetAuthorized: true,
              currentHostAuthorizationRevision: 0,
              currentHeadCommitterSigningPublicKey:
                scenario.signing.publicKey,
              nextHeadCommitterSigningPublicKey: scenario.signing.publicKey,
            };
          },
        },
      ),
    ).toBe("applied");
  });

  test("authorization context ordering is independent of signed envelope-hash order", async () => {
    class ReverseEnvelopeHashCrypto extends LatticeCrypto {
      envelopeA?: Uint8Array;
      envelopeB?: Uint8Array;

      override hash(data: Uint8Array): Uint8Array {
        if (
          this.envelopeA
          && data.length === this.envelopeA.length
          && data.every((byte, index) => byte === this.envelopeA![index])
        ) return new Uint8Array(32).fill(0xff);
        if (
          this.envelopeB
          && data.length === this.envelopeB.length
          && data.every((byte, index) => byte === this.envelopeB![index])
        ) return new Uint8Array(32);
        return super.hash(data);
      }
    }
    const crypto = new ReverseEnvelopeHashCrypto(seededRng(9_069));
    const envelopeA = envelopeWire(crypto, "namespace_a", 0x11);
    const envelopeB = envelopeWire(crypto, "namespace_b", 0x22);
    crypto.envelopeA = envelopeA;
    crypto.envelopeB = envelopeB;
    const signing = crypto.generateSigningKeyPair();
    const payloadBytes = encodeEncryptedPayloadV2({
      formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
      context: {
        objectId: objectId("object_storage"),
        keyClass: "human",
        objectType: "test-record",
        createdAt: unixTimestamp(1),
      },
      ciphertext: new Uint8Array(40).fill(0x44),
    });
    const prepared = prepareObjectAccessManifestGenesisV2(
      crypto,
      {
        objectId: objectId("object_storage"),
        payloadHash: crypto.hash(payloadBytes),
        envelopeBytes: [envelopeA, envelopeB],
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: cryptoDeviceId("device_alice"),
        hostAuthorizationRevision: authorizationRevision(0),
        signingPrivateKey: signing.privateKey,
      },
    );
    expect(prepared.envelopeBytes).toEqual([envelopeB, envelopeA]);
    const storage: ObjectAccessStateCasStorageV2 = {
      getObject: () =>
        Promise.resolve({
          objectId: "object_storage",
          payloadBytes: payloadBytes.slice(),
        }),
      compareAndSwapObjectAccessState: () => Promise.resolve("applied"),
    };
    expect(
      await persistPreparedObjectAccessManifestGenesisV2({
        crypto,
        storage,
        prepared,
        resolveCurrentAuthorization: (context) => {
          expect(context.envelopes.map((entry) => entry.namespaceId)).toEqual([
            "namespace_a",
            "namespace_b",
          ]);
          return {
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision: 0,
            committerSigningPublicKey: signing.publicKey,
          };
        },
      }),
    ).toBe("applied");
  });

  test("wraps one ambiguous genesis CAS and explicit retry resolves duplicate", async () => {
    const scenario = fixture(9_051);
    const backing = await initializedObjectStore(scenario);
    const cause = new Error("lost object genesis response");
    let attempts = 0;
    const authorization = (
      context: ObjectAccessGenesisPersistenceAuthorizationContextV2,
    ) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision: 1,
      committerSigningPublicKey: scenario.signing.publicKey,
    });
    const ambiguous: ObjectAccessStateCasStorageV2 = {
      getObject: backing.getObject.bind(backing),
      async compareAndSwapObjectAccessState(authorized) {
        attempts += 1;
        await backing.compareAndSwapObjectAccessState(authorized);
        throw cause;
      },
    };

    const error = await persistPreparedObjectAccessManifestGenesisV2({
      crypto: scenario.crypto,
      storage: ambiguous,
      prepared: scenario.preparedGenesis,
      resolveCurrentAuthorization: authorization,
    }).catch((observed: unknown) => observed);
    expect(error).toBeInstanceOf(ObjectAccessPersistenceOutcomeUnknownV2);
    expect((error as Error).name).toBe(
      "ObjectAccessPersistenceOutcomeUnknownV2",
    );
    expect((error as Error).message).toBe(
      "Object access storage outcome is ambiguous; retry must be explicit",
    );
    expect((error as Error).cause).toBe(cause);
    expect(attempts).toBe(1);
    expect(
      await persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage: backing,
        prepared: scenario.preparedGenesis,
        resolveCurrentAuthorization: authorization,
      }),
    ).toBe("duplicate");
  });

  test("constructs canonical object-access write state", () => {
    const scenario = fixture(9_045);

    const hydrated = objectAccessStorageStateV2(
      scenario.crypto,
      scenario.initial.head.manifestBytes,
      scenario.initial.namespaceEnvelopes.map(
        (entry) => entry.envelopeBytes.ciphertext,
      ),
    );

    expect(hydrated).toEqual(scenario.initial);
    expect(hydrated.head.manifestBytes).not.toBe(
      scenario.initial.head.manifestBytes,
    );
    expect(hydrated.namespaceEnvelopes[0]?.envelopeBytes.ciphertext).not.toBe(
      scenario.initial.namespaceEnvelopes[0]?.envelopeBytes.ciphertext,
    );
  });

  test("atomically persists a prepared manifest and its complete envelope inventory", async () => {
    const scenario = fixture();
    const store = await initializedObjectStore(scenario);

    expect(
      await store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, scenario.initial),
      ),
    ).toBe("applied");

    const prepared = scenario.prepareAttach(scenario.envelopeB);

    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        store,
        scenario.initial.head,
        prepared,
        scenario.authorization,
      ),
    ).toBe("applied");

    const stored = await store.getObjectAccessState("object_storage");
    expect(stored?.head.accessRevision).toBe(1);
    expect(stored?.head.manifestBytes).toEqual(prepared.manifestBytes);
    expect(stored?.namespaceEnvelopes.map((entry) => entry.envelopeBytes))
      .toEqual([...prepared.envelopeBytes]);
  });

  test("binds attach and detach contexts and resolves after reads immediately before CAS", async () => {
    const scenario = fixture(9_053);
    for (const [operation, prepared, affectedNamespace, nextCount] of [
      ["attach", scenario.prepareAttach(scenario.envelopeB), "namespace_b", 2],
      ["detach", scenario.prepareDetach(), "namespace_a", 0],
    ] as const) {
      const backing = await initializedObjectStore(scenario);
      await backing.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, scenario.initial),
      );
      const events: string[] = [];
      let observed:
        ObjectAccessUpdatePersistenceAuthorizationContextV2 | null = null;
      const storage: ObjectAccessUpdateStateCasStorageV2 = {
        getObjectAccessState: async (id) => {
          events.push("read-current");
          return backing.getObjectAccessState(id);
        },
        getObject: async (id) => {
          events.push("read-object");
          return backing.getObject(id);
        },
        compareAndSwapObjectAccessState: async (authorized) => {
          events.push("cas");
          return backing.compareAndSwapObjectAccessState(authorized);
        },
      };

      expect(
        await persistPreparedObjectAccessManifestUpdateV2(
          scenario.crypto,
          storage,
          scenario.initial.head,
          prepared,
          {
            resolveCurrentAuthorization: async (context) => {
              events.push("resolve-start");
              await Promise.resolve();
              events.push("resolve-complete");
              observed = context;
              return {
                ...context,
                sourceAuthorized: true,
                targetAuthorized: true,
                currentHostAuthorizationRevision: 2,
                currentHeadCommitterSigningPublicKey:
                  scenario.signing.publicKey,
                nextHeadCommitterSigningPublicKey:
                  scenario.signing.publicKey,
              };
            },
          },
        ),
      ).toBe("applied");
      expect(events).toEqual([
        "read-current",
        "read-object",
        "resolve-start",
        "resolve-complete",
        "cas",
      ]);
      const context = observed as unknown as
        ObjectAccessUpdatePersistenceAuthorizationContextV2;
      expect(context.operation).toBe(operation);
      expect(context.objectId).toBe("object_storage");
      expect(context.payloadHash).toEqual(
        scenario.genesis.manifest.payloadHash,
      );
      expect(context.currentHead).toEqual(scenario.initial.head);
      expect(context.nextHead.manifestHash).toEqual(prepared.manifestHash);
      expect(context.currentEnvelopes).toHaveLength(1);
      expect(context.nextEnvelopes).toHaveLength(nextCount);
      expect(context.affectedEnvelope).toEqual({
        objectId: "object_storage",
        namespaceId: affectedNamespace,
        keyClass: "human",
        keyGeneration: 0,
        bindingRevisionAtWrap: 0,
        envelopeHash: scenario.crypto.hash(
          prepared.operation.envelopeBytes,
        ),
      });
      expect(context.currentCommitterDeviceId).toBe(scenario.deviceId);
      expect(context.committerDeviceId).toBe(scenario.deviceId);
      expect(context.currentManifestHostAuthorizationRevision).toBe(1);
      expect(context.hostAuthorizationRevision).toBe(2);
    }

    let staleResolverCalls = 0;
    const empty = await initializedObjectStore(scenario);
    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        empty,
        scenario.initial.head,
        scenario.prepareAttach(scenario.envelopeB),
        {
          resolveCurrentAuthorization: (context) => {
            staleResolverCalls += 1;
            return scenario.authorization.resolveCurrentAuthorization(
              context,
            );
          },
        },
      ),
    ).toBe("stale");
    expect(staleResolverCalls).toBe(0);

    const revokedBacking = await initializedObjectStore(scenario);
    await revokedBacking.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    let revokedAfterObjectRead = false;
    let revokedCasAttempts = 0;
    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        {
          getObjectAccessState:
            revokedBacking.getObjectAccessState.bind(revokedBacking),
          getObject: async (id) => {
            const object = await revokedBacking.getObject(id);
            revokedAfterObjectRead = true;
            return object;
          },
          compareAndSwapObjectAccessState: () => {
            revokedCasAttempts += 1;
            return Promise.resolve("applied");
          },
        },
        scenario.initial.head,
        scenario.prepareAttach(scenario.envelopeB),
        {
          resolveCurrentAuthorization: () => {
            expect(revokedAfterObjectRead).toBe(true);
            return null;
          },
        },
      ),
    ).toBe("stale");
    expect(revokedCasAttempts).toBe(0);
  });

  test("rejects tampered, missing, extra, and duplicate envelopes before storage", async () => {
    const scenario = fixture(9_002);
    const tampered = scenario.envelopeA.slice();
    tampered[tampered.length - 1] =
      tampered[tampered.length - 1]! ^ 0x01;

    expect(() =>
      objectAccessStorageStateV2(
        scenario.crypto,
        scenario.genesis.bytes,
        [],
      )
    ).toThrow("inventory");
    expect(() =>
      objectAccessStorageStateV2(
        scenario.crypto,
        scenario.genesis.bytes,
        [scenario.envelopeA, scenario.envelopeB],
      )
    ).toThrow("inventory");
    expect(() =>
      objectAccessStorageStateV2(
        scenario.crypto,
        scenario.genesis.bytes,
        [scenario.envelopeA, scenario.envelopeA],
      )
    ).toThrow("duplicate Namespace");
    expect(() =>
      objectAccessStorageStateV2(
        scenario.crypto,
        scenario.genesis.bytes,
        [tampered],
      )
    ).toThrow("inventory");

    const store = new InMemoryV2Store();
    const counting = new CountingCasStorage(store);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const forged = {
      ...prepared,
      envelopeBytes: [],
    } as unknown as PreparedObjectAccessManifestUpdateV2;
    expect(
      persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        counting,
        scenario.initial.head,
        forged,
        scenario.authorization,
      ),
    ).rejects.toThrow("authentic prepared");
    expect(counting.attempts).toBe(0);
    expect(await store.getObjectAccessState("object_storage")).toBeNull();
  });

  test("enforces maximum inventory bounds before hashing or storage", () => {
    class HashCountingCrypto extends LatticeCrypto {
      hashes = 0;

      override hash(data: Uint8Array): Uint8Array {
        this.hashes += 1;
        return super.hash(data);
      }
    }
    const scenario = fixture(9_003);
    const crypto = new HashCountingCrypto(seededRng(9_004));
    expect(() =>
      objectAccessStorageStateV2(
        crypto,
        scenario.genesis.bytes,
        Array.from(
          { length: V2_LIMITS.namespaceEnvelopesPerManifest + 1 },
          () => new Uint8Array(),
        ),
      )
    ).toThrow("256");
    expect(crypto.hashes).toBe(0);
  });

  test("rejects every hostile wire-inventory shape with its exact boundary error", () => {
    const scenario = fixture(9_031);
    const noHashCrypto = new class extends LatticeCrypto {
      override hash(_data: Uint8Array): Uint8Array {
        throw new Error("hash must not run");
      }
    }(seededRng(9_032));

    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          noHashCrypto,
          "manifest" as unknown as Uint8Array,
          [],
        ),
      "object access manifest must be Uint8Array",
    );
    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          noHashCrypto,
          new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
          [],
        ),
      `object access manifest bytes exceeds the ${V2_LIMITS.ciphertextBytes} limit`,
    );
    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          noHashCrypto,
          scenario.genesis.bytes,
          null as unknown as readonly Uint8Array[],
        ),
      "Namespace envelope inventory must be an array",
    );
    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          noHashCrypto,
          scenario.genesis.bytes,
          Array.from(
            { length: V2_LIMITS.namespaceEnvelopesPerManifest + 1 },
            () => new Uint8Array(),
          ),
        ),
      `Namespace envelope count exceeds the ${V2_LIMITS.namespaceEnvelopesPerManifest} limit`,
    );
    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          noHashCrypto,
          scenario.genesis.bytes,
          ["envelope"] as unknown as readonly Uint8Array[],
        ),
      "Namespace envelope must be Uint8Array",
    );
    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          noHashCrypto,
          scenario.genesis.bytes,
          [new Uint8Array(V2_LIMITS.manifestEnvelopeBytes + 1)],
        ),
      `manifest envelope bytes exceeds the ${V2_LIMITS.manifestEnvelopeBytes} limit`,
    );
  });

  test("rejects every malformed or non-canonical persisted access-state wire coordinate", async () => {
    const scenario = fixture(9_063);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const backing = await initializedObjectStore(scenario);
    await backing.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const wire = (await backing.getObjectAccessState("object_storage"))!;
    const persist = (rawCurrent: unknown) => {
      let attempts = 0;
      const storage: ObjectAccessUpdateStateCasStorageV2 = {
        getObject: backing.getObject.bind(backing),
        getObjectAccessState: () => Promise.resolve(rawCurrent as never),
        compareAndSwapObjectAccessState: () => {
          attempts += 1;
          return Promise.resolve("applied");
        },
      };
      return {
        attempts: () => attempts,
        result: persistPreparedObjectAccessManifestUpdateV2(
          scenario.crypto,
          storage,
          scenario.initial.head,
          prepared,
          scenario.authorization,
        ),
      };
    };
    const firstEnvelope = wire.namespaceEnvelopes[0]!;
    const malformed: readonly [unknown, string][] = [
      [
        "state",
        "persisted object access state must be an object",
      ],
      [
        { ...wire, unexpected: true },
        "persisted object access state has an invalid field set",
      ],
      [
        { ...wire, namespaceEnvelopes: "envelopes" },
        "persisted object access Namespace envelopes must be an array",
      ],
      [
        { ...wire, namespaceEnvelopes: [null] },
        "persisted object access Namespace envelope must be an object",
      ],
      [
        {
          ...wire,
          namespaceEnvelopes: [{ ...firstEnvelope, unexpected: true }],
        },
        "persisted object access Namespace envelope has an invalid field set",
      ],
      [
        {
          ...wire,
          namespaceEnvelopes: [{
            ...firstEnvelope,
            envelopeHash: "hash",
          }],
        },
        "persisted object access Namespace envelope hash must be exactly 32 bytes",
      ],
      [
        {
          ...wire,
          namespaceEnvelopes: [{
            ...firstEnvelope,
            envelopeHash: new Uint8Array(31),
          }],
        },
        "persisted object access Namespace envelope hash must be exactly 32 bytes",
      ],
      [
        {
          ...wire,
          namespaceEnvelopes: [{
            ...firstEnvelope,
            envelopeBytes: "envelope",
          }],
        },
        "persisted object access Namespace envelope must be Uint8Array",
      ],
      [
        {
          ...wire,
          namespaceEnvelopes: [{
            ...firstEnvelope,
            namespaceId: namespaceId("namespace_other"),
          }],
        },
        "persisted object access state does not match canonical wire bytes",
      ],
      [
        {
          ...wire,
          namespaceEnvelopes: [{
            ...firstEnvelope,
            envelopeHash: new Uint8Array(32).fill(0xee),
          }],
        },
        "persisted object access state does not match canonical wire bytes",
      ],
    ];
    for (const [rawCurrent, message] of malformed) {
      const attempt = persist(rawCurrent);
      await expectExactRejection(attempt.result, message);
      expect(attempt.attempts()).toBe(0);
    }
  });

  test("rejects a canonical stored-state fork before authorization even under an injected envelope-hash collision", async () => {
    const scenario = fixture(9_068);
    const genesis = prepareObjectAccessManifestGenesisV2(
      scenario.crypto,
      {
        objectId: objectId("object_storage"),
        payloadHash: scenario.crypto.hash(scenario.payloadBytes),
        envelopeBytes: [scenario.envelopeA, scenario.envelopeB],
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: scenario.deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
        signingPrivateKey: scenario.signing.privateKey,
      },
    );
    const initial = objectAccessStorageStateV2(
      scenario.crypto,
      genesis.manifestBytes,
      genesis.envelopeBytes,
    );
    const prepared = prepareObjectAccessManifestUpdateV2(
      scenario.crypto,
      {
        currentManifestBytes: genesis.manifestBytes,
        currentEnvelopeBytes: genesis.envelopeBytes,
        trustedMinimumHead: {
          objectId: genesis.manifest.objectId,
          payloadHash: genesis.manifest.payloadHash,
          accessRevision: genesis.manifest.accessRevision,
          manifestHash: genesis.manifestHash,
        },
        proof: [],
        resolveSigningPublicKey: scenario.resolveSigningPublicKey,
        operation: { type: "attach", envelopeBytes: scenario.envelopeC },
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: scenario.deviceId,
        hostAuthorizationRevision: authorizationRevision(2),
        signingPrivateKey: scenario.signing.privateKey,
      },
    );
    const backing = await initializedObjectStore(scenario);
    const expectedEnvelopeHash = scenario.crypto.hash(scenario.envelopeA);
    const unchangedWire = initial.namespaceEnvelopes
      .filter((record) => record.namespaceId !== "namespace_a")
      .map((record) => ({
        namespaceId: record.namespaceId,
        envelopeHash: record.envelopeHash.slice(),
        envelopeBytes: record.envelopeBytes.ciphertext.slice(),
      }));
    for (const [namespace, collidingEnvelope] of [
      [
        "namespace_a",
        envelopeWire(scenario.crypto, "namespace_a", 0x77),
      ],
      [
        "namespace_other",
        envelopeWire(scenario.crypto, "namespace_other", 0x78),
      ],
    ] as const) {
      const crypto = new class extends LatticeCrypto {
        override hash(data: Uint8Array): Uint8Array {
          if (
            data.length === collidingEnvelope.length
            && data.every((byte, index) => byte === collidingEnvelope[index])
          ) {
            return expectedEnvelopeHash.slice();
          }
          return super.hash(data);
        }
      }(seededRng(9_068));
      let resolverCalls = 0;
      let casAttempts = 0;
      const storage: ObjectAccessUpdateStateCasStorageV2 = {
        getObject: backing.getObject.bind(backing),
        getObjectAccessState: () =>
          Promise.resolve({
            head: {
              objectId: initial.head.objectId,
              accessRevision: initial.head.accessRevision,
              manifestHash: initial.head.manifestHash.slice(),
              manifestBytes: initial.head.manifestBytes.slice(),
            },
            namespaceEnvelopes: [
              {
                namespaceId: namespace,
                envelopeHash: expectedEnvelopeHash.slice(),
                envelopeBytes: collidingEnvelope.slice(),
              },
              ...unchangedWire,
            ].sort((left, right) => {
              const leftIndex = initial.namespaceEnvelopes.findIndex((record) =>
                record.envelopeHash.every((byte, index) =>
                  byte === left.envelopeHash[index]
                )
              );
              const rightIndex = initial.namespaceEnvelopes.findIndex((record) =>
                record.envelopeHash.every((byte, index) =>
                  byte === right.envelopeHash[index]
                )
              );
              return leftIndex - rightIndex;
            }),
          }),
        compareAndSwapObjectAccessState: () => {
          casAttempts += 1;
          return Promise.resolve("applied");
        },
      };
      expect(
        await persistPreparedObjectAccessManifestUpdateV2(
          crypto,
          storage,
          initial.head,
          prepared,
          {
            resolveCurrentAuthorization: () => {
              resolverCalls += 1;
              throw new Error("authorization must not run for a state fork");
            },
          },
        ),
      ).toBe("stale");
      expect(resolverCalls).toBe(0);
      expect(casAttempts).toBe(0);
    }
  });

  test("stored-state equality rejects a different decoded Namespace even when hostile hashing substitutes identical envelope bytes", async () => {
    const scenario = fixture(9_074);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const backing = await initializedObjectStore(scenario);
    const hostileEnvelope = envelopeWire(
      scenario.crypto,
      "namespace_z",
      0x79,
    );
    expect(hostileEnvelope.length).toBe(scenario.envelopeA.length);
    const expectedEnvelopeHash = scenario.crypto.hash(scenario.envelopeA);
    let substitutions = 0;
    const crypto = new class extends LatticeCrypto {
      override hash(data: Uint8Array): Uint8Array {
        if (data === hostileEnvelope) {
          substitutions += 1;
          data.set(scenario.envelopeA);
          return expectedEnvelopeHash.slice();
        }
        return super.hash(data);
      }
    }(seededRng(9_074));
    let resolverCalls = 0;
    let casAttempts = 0;
    const storage: ObjectAccessUpdateStateCasStorageV2 = {
      getObject: backing.getObject.bind(backing),
      getObjectAccessState: () =>
        Promise.resolve({
          head: {
            objectId: scenario.initial.head.objectId,
            accessRevision: scenario.initial.head.accessRevision,
            manifestHash: scenario.initial.head.manifestHash.slice(),
            manifestBytes: scenario.initial.head.manifestBytes.slice(),
          },
          namespaceEnvelopes: [{
            namespaceId: "namespace_z",
            envelopeHash: expectedEnvelopeHash.slice(),
            envelopeBytes: hostileEnvelope,
          }],
        }),
      compareAndSwapObjectAccessState: () => {
        casAttempts += 1;
        return Promise.resolve("applied");
      },
    };
    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        crypto,
        storage,
        scenario.initial.head,
        prepared,
        {
          resolveCurrentAuthorization: (context) => {
            resolverCalls += 1;
            return scenario.authorization.resolveCurrentAuthorization(context);
          },
        },
      ),
    ).toBe("stale");
    expect(substitutions).toBe(1);
    expect(resolverCalls).toBe(0);
    expect(casAttempts).toBe(0);
  });

  test("validates exact expected-head fields, identity, revision, hash shape, and hash binding", async () => {
    const scenario = fixture(9_033);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const storage = new CountingCasStorage(new InMemoryV2Store());
    const persist = (expected: ObjectAccessManifestStorageHeadV2) =>
      persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        storage,
        expected,
        prepared,
        scenario.authorization,
      );

    await expectExactRejection(
      persist(null as unknown as ObjectAccessManifestStorageHeadV2),
      "object access storage head must be an object",
    );
    await expectExactRejection(
      persist("head" as unknown as ObjectAccessManifestStorageHeadV2),
      "object access storage head must be an object",
    );
    await expectExactRejection(
      persist({
        ...scenario.initial.head,
        unexpected: true,
      } as unknown as ObjectAccessManifestStorageHeadV2),
      "object access storage head has an invalid field set",
    );
    const { manifestHash: _omittedHash, ...missingHash } = scenario.initial.head;
    await expectExactRejection(
      persist(missingHash as ObjectAccessManifestStorageHeadV2),
      "object access storage head has an invalid field set",
    );
    await expectExactRejection(
      persist({
        ...missingHash,
        unexpected: true,
      } as unknown as ObjectAccessManifestStorageHeadV2),
      "object access storage head has an invalid field set",
    );
    await expectExactRejection(
      persist({
        ...scenario.initial.head,
        manifestHash: "hash",
      } as unknown as ObjectAccessManifestStorageHeadV2),
      "object access manifest hash must be exactly 32 bytes",
    );
    await expectExactRejection(
      persist({
        ...scenario.initial.head,
        manifestHash: new Uint8Array(31),
      }),
      "object access manifest hash must be exactly 32 bytes",
    );
    for (const head of [
      {
        ...scenario.initial.head,
        objectId: objectId("object_other"),
      },
      {
        ...scenario.initial.head,
        accessRevision: accessRevision(1),
      },
      {
        ...scenario.initial.head,
        manifestHash: new Uint8Array(32).fill(0xee),
      },
    ]) {
      await expectExactRejection(
        persist(head),
        "expected object access head does not match its canonical manifest",
      );
    }
    expect(storage.attempts).toBe(0);
  });

  test("canonicalizes envelope order, rejects object/namespace/hash collisions, and owns all output bytes", () => {
    const scenario = fixture(9_034);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const providerHashes: Uint8Array[] = [];
    const capturingCrypto = new class extends LatticeCrypto {
      override hash(data: Uint8Array): Uint8Array {
        const result = super.hash(data);
        providerHashes.push(result);
        return result;
      }
    }(seededRng(9_034));
    const callerManifest = prepared.manifestBytes.slice();
    const callerEnvelopes = [...prepared.envelopeBytes]
      .reverse()
      .map((bytes) => bytes.slice());
    const state = objectAccessStorageStateV2(
      capturingCrypto,
      callerManifest,
      callerEnvelopes,
    );
    expect(state.namespaceEnvelopes.map((entry) => entry.envelopeHash))
      .toEqual([...prepared.manifest.envelopeHashes]);
    expect(state.head.manifestBytes).not.toBe(callerManifest);
    expect(state.head.manifestHash).not.toBe(providerHashes[0]);
    expect(state.namespaceEnvelopes[0]?.envelopeHash).not.toBe(
      providerHashes[1],
    );
    expect(Object.isFrozen(state.namespaceEnvelopes)).toBe(true);

    const stableManifest = state.head.manifestBytes.slice();
    const stableManifestHash = state.head.manifestHash.slice();
    const stableEnvelopeHashes = state.namespaceEnvelopes.map((entry) =>
      entry.envelopeHash.slice()
    );
    callerManifest.fill(0);
    for (const bytes of callerEnvelopes) bytes.fill(0);
    for (const hash of providerHashes) hash.fill(0);
    expect(state.head.manifestBytes).toEqual(stableManifest);
    expect(state.head.manifestHash).toEqual(stableManifestHash);
    expect(state.namespaceEnvelopes.map((entry) => entry.envelopeHash))
      .toEqual(stableEnvelopeHashes);

    const wrongObjectEnvelope = envelopeWire(
      scenario.crypto,
      "namespace_wrong_object",
      0x44,
      "object_other",
    );
    const wrongObjectManifest = createObjectAccessManifestV2(
      scenario.crypto,
      {
        objectId: objectId("object_storage"),
        payloadHash: scenario.genesis.manifest.payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [scenario.crypto.hash(wrongObjectEnvelope)],
        committerDeviceId: scenario.deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
      },
      scenario.signing.privateKey,
    );
    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          scenario.crypto,
          wrongObjectManifest.bytes,
          [wrongObjectEnvelope],
        ),
      "Namespace envelope object does not match manifest",
    );
    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          scenario.crypto,
          prepared.manifestBytes,
          [scenario.envelopeA, scenario.envelopeA],
        ),
      "duplicate Namespace envelope in object inventory",
    );

    const collisionCrypto = new class extends LatticeCrypto {
      override hash(_data: Uint8Array): Uint8Array {
        return new Uint8Array(32).fill(0x5a);
      }
    }(seededRng(9_035));
    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          collisionCrypto,
          prepared.manifestBytes,
          prepared.envelopeBytes,
        ),
      "duplicate Namespace envelope hash in object inventory",
    );
    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          scenario.crypto,
          scenario.genesis.bytes,
          [],
        ),
      "Namespace envelope inventory does not match manifest",
    );
    expectExactThrow(
      () =>
        objectAccessStorageStateV2(
          scenario.crypto,
          scenario.genesis.bytes,
          [scenario.envelopeB],
        ),
      "Namespace envelope inventory does not match manifest",
    );
  });

  test("direct store calls reject unbound manifest and envelope hashes", async () => {
    const scenario = fixture(9_005);
    const store = await initializedObjectStore(scenario);
    const wrongManifestHash = {
      ...scenario.initial,
      head: {
        ...scenario.initial.head,
        manifestHash: new Uint8Array(32).fill(0xee),
      },
    };
    expect(
      store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, wrongManifestHash),
      ),
    ).rejects.toThrow("metadata");

    const tamperedEnvelope = scenario.initial.namespaceEnvelopes[0]!
      .envelopeBytes.ciphertext.slice();
    tamperedEnvelope[tamperedEnvelope.length - 1] =
      tamperedEnvelope[tamperedEnvelope.length - 1]! ^ 0x01;
    const wrongEnvelopeHash = {
      ...scenario.initial,
      namespaceEnvelopes: [{
        ...scenario.initial.namespaceEnvelopes[0]!,
        envelopeBytes: opaqueBytes(
          "namespace-object-envelope",
          tamperedEnvelope,
        ),
      }],
    };
    expect(
      store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, wrongEnvelopeHash),
      ),
    ).rejects.toThrow("canonical manifest inventory");
    expect(await store.getObjectAccessState("object_storage")).toBeNull();
  });

  test("returns duplicate for exact replay and stale for forks and rollback", async () => {
    const scenario = fixture(9_006);
    const store = await initializedObjectStore(scenario);
    await store.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const attached = scenario.prepareAttach(scenario.envelopeB);
    const fork = scenario.prepareAttach(scenario.envelopeC);

    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        store,
        scenario.initial.head,
        attached,
        scenario.authorization,
      ),
    ).toBe("applied");
    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        store,
        scenario.initial.head,
        attached,
        scenario.authorization,
      ),
    ).toBe("duplicate");
    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        store,
        scenario.initial.head,
        fork,
        scenario.authorization,
      ),
    ).toBe("stale");

    const current = await store.getObjectAccessState("object_storage");
    expect(current).not.toBeNull();
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(current!.head, scenario.initial),
      ),
    ).toBe("stale");
    expect(
      await store.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, scenario.initial),
      ),
    ).toBe("stale");
    expect((await store.getObjectAccessState("object_storage"))?.head.manifestBytes)
      .toEqual(attached.manifestBytes);
  });

  test("direct-store object CAS rejects every stale identity, revision, and chain axis", async () => {
    const scenario = fixture(9_043);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const intended = objectAccessStorageStateV2(
      scenario.crypto,
      prepared.manifestBytes,
      prepared.envelopeBytes,
    );

    expect(
      await new InMemoryV2Store().compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, intended),
      ),
    ).toBe("stale");
    await expectExactRejection(
      new InMemoryV2Store().compareAndSwapObjectAccessState(
        authorizedObjectWrite(
          {
            ...scenario.initial.head,
            manifestHash: new Uint8Array(31),
          },
          intended,
        ),
      ),
      "Expected object access head hash must be exactly 32 bytes",
    );
    const otherManifest = createObjectAccessManifestV2(
      scenario.crypto,
      {
        objectId: objectId("object_other"),
        payloadHash: scenario.genesis.manifest.payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [],
        committerDeviceId: scenario.deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
      },
      scenario.signing.privateKey,
    );
    const otherHead = objectAccessStorageStateV2(
      scenario.crypto,
      otherManifest.bytes,
      [],
    ).head;
    expect(
      new InMemoryV2Store().compareAndSwapObjectAccessState(
        authorizedObjectWrite(otherHead, intended),
      ),
    ).rejects.toThrow("object ids differ");

    const storeWithoutCurrent = await initializedObjectStore(scenario);
    expect(
      await storeWithoutCurrent.compareAndSwapObjectAccessState(
        authorizedObjectWrite(scenario.initial.head, intended),
      ),
    ).toBe("stale");

    const createState = (
      revision: number,
      previousManifestHash: Uint8Array | null,
    ) => {
      const manifest = createObjectAccessManifestV2(
        scenario.crypto,
        {
          objectId: objectId("object_storage"),
          payloadHash: scenario.genesis.manifest.payloadHash,
          accessRevision: accessRevision(revision),
          previousManifestHash,
          envelopeHashes: [],
          committerDeviceId: scenario.deviceId,
          hostAuthorizationRevision: authorizationRevision(2),
        },
        scenario.signing.privateKey,
      );
      return objectAccessStorageStateV2(scenario.crypto, manifest.bytes, []);
    };
    for (const invalid of [
      createState(2, scenario.initial.head.manifestHash),
      createState(1, new Uint8Array(32).fill(0xff)),
    ]) {
      const store = await initializedObjectStore(scenario);
      expect(
        await store.compareAndSwapObjectAccessState(
          authorizedObjectWrite(null, scenario.initial),
        ),
      ).toBe("applied");
      expect(
        await store.compareAndSwapObjectAccessState(
          authorizedObjectWrite(scenario.initial.head, invalid),
        ),
      ).toBe("stale");
      expect((await store.getObjectAccessState("object_storage"))?.head)
        .toEqual(scenario.initial.head);
    }
  });

  test("direct-store object CAS validates every state, head, and envelope boundary exactly", async () => {
    const scenario = fixture(9_044);
    const reject = (
      intended: ObjectAccessStorageStateV2,
      message: string,
    ) => expectExactRejection(
      new InMemoryV2Store().compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, intended),
      ),
      message,
    );

    await reject(
      "object-state" as never,
      "Object access state must be an object",
    );
    await reject(
      {
        head: scenario.initial.head,
        substitutedNamespaceEnvelopes:
          scenario.initial.namespaceEnvelopes,
      } as never,
      "Object access state has an invalid field set",
    );
    await reject(
      {
        ...scenario.initial,
        head: {
          ...scenario.initial.head,
          manifestBytes: "manifest" as never,
        },
      },
      "Object access head bytes must be Uint8Array",
    );
    await reject(
      {
        ...scenario.initial,
        head: {
          ...scenario.initial.head,
          manifestHash: new Uint8Array(32),
          manifestBytes:
            new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
        },
      },
      `Object access head bytes exceeds the ${V2_LIMITS.ciphertextBytes} limit`,
    );
    await reject(
      {
        ...scenario.initial,
        head: {
          ...scenario.initial.head,
          objectId: objectId("object_other"),
        },
      },
      "Object access head metadata does not match its manifest",
    );
    await reject(
      {
        ...scenario.initial,
        head: {
          ...scenario.initial.head,
          accessRevision: accessRevision(1),
        },
      },
      "Object access head metadata does not match its manifest",
    );
    await reject(
      {
        ...scenario.initial,
        namespaceEnvelopes: "envelopes" as never,
      },
      "Object access Namespace envelopes must be an array",
    );
    await reject(
      {
        ...scenario.initial,
        namespaceEnvelopes: Array.from(
          {
            length:
              V2_LIMITS.namespaceEnvelopesPerManifest + 1,
          },
          () => scenario.initial.namespaceEnvelopes[0]!,
        ),
      },
      `Object access Namespace envelope count exceeds the ${V2_LIMITS.namespaceEnvelopesPerManifest} limit`,
    );
    await reject(
      {
        ...scenario.initial,
        namespaceEnvelopes: [],
      },
      "Object access Namespace envelope inventory does not match manifest",
    );
    await reject(
      {
        ...scenario.initial,
        namespaceEnvelopes: [{
          ...scenario.initial.namespaceEnvelopes[0]!,
          unexpected: true,
        }] as never,
      },
      "Namespace object envelope record has an invalid field set",
    );
    await reject(
      {
        ...scenario.initial,
        namespaceEnvelopes: [{
          ...scenario.initial.namespaceEnvelopes[0]!,
          envelopeHash: new Uint8Array(31),
        }],
      },
      "Namespace object envelope hash must be exactly 32 bytes",
    );
    expectExactThrow(() =>
      authorizedObjectWrite(null, {
        ...scenario.initial,
        namespaceEnvelopes: [{
          ...scenario.initial.namespaceEnvelopes[0]!,
          envelopeBytes: opaqueBytes(
            "grant",
            scenario.envelopeA,
          ) as never,
        }],
      }),
      "Namespace object envelope must be opaque namespace-object-envelope ciphertext",
    );
    expectExactThrow(
      () =>
        assertObjectAccessState({
          ...scenario.initial,
          namespaceEnvelopes: [{
            ...scenario.initial.namespaceEnvelopes[0]!,
            envelopeBytes: opaqueBytes(
              "grant",
              scenario.envelopeA,
            ) as never,
          }],
        }),
      "Namespace object envelope must be opaque namespace-object-envelope ciphertext",
    );
    expectExactThrow(
      () =>
        assertObjectAccessState({
          ...scenario.initial,
          namespaceEnvelopes: [{
            ...scenario.initial.namespaceEnvelopes[0]!,
            envelopeBytes: opaqueBytes(
              "namespace-object-envelope",
              new Uint8Array(V2_LIMITS.manifestEnvelopeBytes + 1),
            ),
          }],
        }),
      `Object access Namespace envelope bytes exceeds the ${V2_LIMITS.manifestEnvelopeBytes} limit`,
    );

    const stateForEnvelope = (
      wire: Uint8Array,
      recordedNamespace: string,
    ): ObjectAccessStorageStateV2 => {
      const manifest = createObjectAccessManifestV2(
        scenario.crypto,
        {
          objectId: objectId("object_storage"),
          payloadHash: scenario.genesis.manifest.payloadHash,
          accessRevision: accessRevision(0),
          previousManifestHash: null,
          envelopeHashes: [scenario.crypto.hash(wire)],
          committerDeviceId: scenario.deviceId,
          hostAuthorizationRevision: authorizationRevision(1),
        },
        scenario.signing.privateKey,
      );
      return {
        head: {
          objectId: manifest.manifest.objectId,
          accessRevision: manifest.manifest.accessRevision,
          manifestHash: manifest.hash,
          manifestBytes: manifest.bytes,
        },
        namespaceEnvelopes: [{
          namespaceId: namespaceId(recordedNamespace),
          envelopeHash: scenario.crypto.hash(wire),
          envelopeBytes: opaqueBytes("namespace-object-envelope", wire),
        }],
      };
    };
    await reject(
      stateForEnvelope(
        envelopeWire(
          scenario.crypto,
          "namespace_a",
          0x51,
          "object_other",
        ),
        "namespace_a",
      ),
      "Namespace object envelope record does not match canonical manifest inventory",
    );
    await reject(
      stateForEnvelope(
        envelopeWire(scenario.crypto, "namespace_a", 0x52),
        "namespace_other",
      ),
      "Namespace object envelope record does not match canonical manifest inventory",
    );
  });

  test("surfaces an ambiguous outcome after one delivery and never retries internally", async () => {
    const scenario = fixture(9_007);
    const store = await initializedObjectStore(scenario);
    await store.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const ambiguous = new CountingCasStorage(store, true);

    const error = await persistPreparedObjectAccessManifestUpdateV2(
      scenario.crypto,
      ambiguous,
      scenario.initial.head,
      prepared,
      scenario.authorization,
    ).catch((observed: unknown) => observed);
    expect(error).toBeInstanceOf(ObjectAccessPersistenceOutcomeUnknownV2);
    expect((error as Error).name).toBe(
      "ObjectAccessPersistenceOutcomeUnknownV2",
    );
    expect((error as Error).message).toBe(
      "Object access storage outcome is ambiguous; retry must be explicit",
    );
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe(
      "ambiguous object access CAS delivery",
    );
    expect(ambiguous.attempts).toBe(1);
    expect((await store.getObjectAccessState("object_storage"))?.head.accessRevision)
      .toBe(1);

    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        store,
        scenario.initial.head,
        prepared,
        scenario.authorization,
      ),
    ).toBe("duplicate");
  });

  test("fails closed when an update adapter returns an invalid CAS status", async () => {
    const scenario = fixture(9_052);
    const backing = await initializedObjectStore(scenario);
    await backing.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    let attempts = 0;
    const invalid: ObjectAccessUpdateStateCasStorageV2 = {
      getObject: backing.getObject.bind(backing),
      getObjectAccessState: backing.getObjectAccessState.bind(backing),
      compareAndSwapObjectAccessState: async () => {
        attempts += 1;
        return "invalid-status" as never;
      },
    };

    await expectExactRejection(
      persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        invalid,
        scenario.initial.head,
        prepared,
        scenario.authorization,
      ),
      "object access storage returned an invalid status",
    );
    expect(attempts).toBe(1);
  });

  test("requires callable update and genesis authorization resolvers", async () => {
    const scenario = fixture(9_070);
    await expectExactRejection(
      persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        new CountingCasStorage(new InMemoryV2Store()),
        scenario.initial.head,
        scenario.prepareAttach(scenario.envelopeB),
        { resolveCurrentAuthorization: null as never },
      ),
      "Current object access update authorization resolver is required",
    );
    await expectExactRejection(
      persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage: new InMemoryV2Store(),
        prepared: scenario.preparedGenesis,
        resolveCurrentAuthorization: null as never,
      }),
      "Current object access genesis authorization resolver is required",
    );
  });

  test("requires authentic preparation and fresh authorized committer keys", async () => {
    const scenario = fixture(9_008);
    const store = await initializedObjectStore(scenario);
    await store.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const counting = new CountingCasStorage(store);

    expect(
      persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        counting,
        scenario.initial.head,
        { ...prepared } as PreparedObjectAccessManifestUpdateV2,
        scenario.authorization,
      ),
    ).rejects.toThrow("authentic prepared");
    for (const field of [
      "manifestBytes",
      "manifestHash",
      "envelopeBytes",
    ] as const) {
      const tampered = scenario.prepareAttach(scenario.envelopeB);
      const target = field === "envelopeBytes"
        ? tampered.envelopeBytes[0]!
        : tampered[field];
      target[0] = target[0]! ^ 0xff;
      expect(
        persistPreparedObjectAccessManifestUpdateV2(
          scenario.crypto,
          counting,
          scenario.initial.head,
          tampered,
          scenario.authorization,
        ),
      ).rejects.toThrow("authentic prepared");
    }
    const tamperedOperation = scenario.prepareAttach(scenario.envelopeB);
    tamperedOperation.operation.envelopeBytes[0] =
      tamperedOperation.operation.envelopeBytes[0]! ^ 0xff;
    expect(
      persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        counting,
        scenario.initial.head,
        tamperedOperation,
        scenario.authorization,
      ),
    ).rejects.toThrow("authentic prepared");

    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        counting,
        scenario.initial.head,
        prepared,
        {
          resolveCurrentAuthorization: (context) => ({
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision: 2,
            currentHeadCommitterSigningPublicKey:
              scenario.crypto.generateSigningKeyPair().publicKey,
            nextHeadCommitterSigningPublicKey:
              scenario.signing.publicKey,
          }),
        },
      ),
    ).toBe("stale");
    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        counting,
        scenario.initial.head,
        prepared,
        {
          resolveCurrentAuthorization: (context) => ({
            ...scenario.authorization.resolveCurrentAuthorization(context),
            targetAuthorized: false,
          }),
        },
      ),
    ).toBe("stale");
    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        counting,
        scenario.initial.head,
        prepared,
        {
          resolveCurrentAuthorization: (context) => ({
            ...scenario.authorization.resolveCurrentAuthorization(context),
            currentHostAuthorizationRevision: 3,
          }),
        },
      ),
    ).toBe("stale");
    expect(counting.attempts).toBe(0);
    expect((await store.getObjectAccessState("object_storage"))?.head.accessRevision)
      .toBe(0);
  });

  test("authentic prepared capabilities bind every mutable byte leaf independently", async () => {
    const scenario = fixture(9_060);
    const backing = await initializedObjectStore(scenario);
    const updateStorage = new CountingCasStorage(backing);

    for (const mutate of [
      (prepared: PreparedObjectAccessManifestUpdateV2) => {
        prepared.manifestBytes[0] = prepared.manifestBytes[0]! ^ 1;
      },
      (prepared: PreparedObjectAccessManifestUpdateV2) => {
        prepared.manifestHash[0] = prepared.manifestHash[0]! ^ 1;
      },
      (prepared: PreparedObjectAccessManifestUpdateV2) => {
        prepared.envelopeBytes[0]![0] = prepared.envelopeBytes[0]![0]! ^ 1;
      },
      (prepared: PreparedObjectAccessManifestUpdateV2) => {
        prepared.envelopeBytes[1]![0] = prepared.envelopeBytes[1]![0]! ^ 1;
      },
      (prepared: PreparedObjectAccessManifestUpdateV2) => {
        prepared.operation.envelopeBytes[0] =
          prepared.operation.envelopeBytes[0]! ^ 1;
      },
    ]) {
      const prepared = scenario.prepareAttach(scenario.envelopeB);
      mutate(prepared);
      await expectExactRejection(
        persistPreparedObjectAccessManifestUpdateV2(
          scenario.crypto,
          updateStorage,
          scenario.initial.head,
          prepared,
          scenario.authorization,
        ),
        "object access persistence requires an authentic prepared update",
      );
    }

    for (const mutate of [
      (prepared: PreparedObjectAccessManifestGenesisV2) => {
        prepared.manifestBytes[0] = prepared.manifestBytes[0]! ^ 1;
      },
      (prepared: PreparedObjectAccessManifestGenesisV2) => {
        prepared.manifestHash[0] = prepared.manifestHash[0]! ^ 1;
      },
      (prepared: PreparedObjectAccessManifestGenesisV2) => {
        prepared.envelopeBytes[1]![0] = prepared.envelopeBytes[1]![0]! ^ 1;
      },
    ]) {
      const prepared = prepareObjectAccessManifestGenesisV2(
        scenario.crypto,
        {
          objectId: objectId("object_storage"),
          payloadHash: scenario.crypto.hash(scenario.payloadBytes),
          envelopeBytes: [scenario.envelopeB, scenario.envelopeA],
          sourceAuthorized: true,
          targetAuthorized: true,
          committerDeviceId: scenario.deviceId,
          hostAuthorizationRevision: authorizationRevision(1),
          signingPrivateKey: scenario.signing.privateKey,
        },
      );
      mutate(prepared);
      await expectExactRejection(
        persistPreparedObjectAccessManifestGenesisV2({
          crypto: scenario.crypto,
          storage: backing,
          prepared,
          resolveCurrentAuthorization: () => null,
        }),
        "object access genesis persistence requires an authentic prepared genesis",
      );
    }
    expect(updateStorage.attempts).toBe(0);
  });

  test("prepared capabilities detach every caller-owned envelope byte array", () => {
    const scenario = fixture(9_064);
    const genesisInputs = [
      Buffer.from(scenario.envelopeB),
      Buffer.from(scenario.envelopeA),
    ];
    const preparedGenesis = prepareObjectAccessManifestGenesisV2(
      scenario.crypto,
      {
        objectId: objectId("object_storage"),
        payloadHash: scenario.crypto.hash(scenario.payloadBytes),
        envelopeBytes: genesisInputs,
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: scenario.deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
        signingPrivateKey: scenario.signing.privateKey,
      },
    );
    const genesisBytes = preparedGenesis.envelopeBytes.map((bytes) =>
      Uint8Array.from(bytes)
    );
    expect(
      preparedGenesis.envelopeBytes.some((bytes) => Buffer.isBuffer(bytes)),
    ).toBeFalse();
    genesisInputs[0]![0] = genesisInputs[0]![0]! ^ 1;
    genesisInputs[1]![0] = genesisInputs[1]![0]! ^ 1;
    expect(preparedGenesis.envelopeBytes).toEqual(genesisBytes);
    expect(() =>
      assertAuthenticPreparedObjectAccessManifestGenesisV2(preparedGenesis)
    ).not.toThrow();

    const operationInput = Buffer.from(scenario.envelopeB);
    const preparedUpdate = scenario.prepareAttach(operationInput);
    const operationBytes = Uint8Array.from(
      preparedUpdate.operation.envelopeBytes,
    );
    expect(Buffer.isBuffer(preparedUpdate.operation.envelopeBytes)).toBeFalse();
    operationInput[0] = operationInput[0]! ^ 1;
    expect(preparedUpdate.operation.envelopeBytes).toEqual(operationBytes);
    expect(() =>
      assertAuthenticPreparedObjectAccessManifestUpdateV2(preparedUpdate)
    ).not.toThrow();
  });

  test("genesis persistence binds the exposed manifest object to its authentic canonical bytes", async () => {
    const scenario = fixture(9_071);
    scenario.preparedGenesis.manifest.signature[0] =
      scenario.preparedGenesis.manifest.signature[0]! ^ 1;
    await expectExactRejection(
      persistPreparedObjectAccessManifestGenesisV2({
        crypto: scenario.crypto,
        storage: new InMemoryV2Store(),
        prepared: scenario.preparedGenesis,
        resolveCurrentAuthorization: () => null,
      }),
      "prepared object access genesis does not match its canonical manifest",
    );
  });

  test("requires an exact fresh decision bound to every update coordinate", async () => {
    const scenario = fixture(9_036);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const backing = await initializedObjectStore(scenario);
    await backing.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const storage = new CountingCasStorage(backing);
    const persist = (
      authorization: typeof scenario.authorization,
    ) =>
      persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        storage,
        scenario.initial.head,
        prepared,
        authorization,
      );

    await expectExactRejection(
      persist(null as unknown as typeof scenario.authorization),
      "object access persistence authorization must be an object",
    );
    await expectExactRejection(
      persist({
        ...scenario.authorization,
        unexpected: true,
      } as unknown as typeof scenario.authorization),
      "object access persistence authorization has an invalid field set",
    );
    const {
      resolveCurrentAuthorization: _omittedResolver,
      ...missingResolver
    } =
      scenario.authorization;
    await expectExactRejection(
      persist(missingResolver as unknown as typeof scenario.authorization),
      "object access persistence authorization has an invalid field set",
    );
    const resolvers: readonly (
      (
        context: ObjectAccessUpdatePersistenceAuthorizationContextV2,
      ) => ReturnType<
        typeof scenario.authorization.resolveCurrentAuthorization
      >
    )[] = [
      (context) => ({
        ...scenario.authorization.resolveCurrentAuthorization(context),
        sourceAuthorized: false,
      }),
      (context) => ({
        ...scenario.authorization.resolveCurrentAuthorization(context),
        targetAuthorized: false,
      }),
      (context) => ({
        ...scenario.authorization.resolveCurrentAuthorization(context),
        currentHostAuthorizationRevision: 3,
      }),
      (context) => ({
        ...scenario.authorization.resolveCurrentAuthorization(context),
        operation: "detach",
      }),
      (context) => ({
        ...scenario.authorization.resolveCurrentAuthorization(context),
        nextEnvelopes: [],
      }),
      (context) => ({
        ...scenario.authorization.resolveCurrentAuthorization(context),
        affectedEnvelope: {
          ...context.affectedEnvelope,
          namespaceId: "namespace_substituted",
        },
      }),
      (context) => ({
        ...scenario.authorization.resolveCurrentAuthorization(context),
        currentHead: {
          ...context.currentHead,
          accessRevision: context.currentHead.accessRevision + 1,
        },
      }),
    ];
    for (const resolveCurrentAuthorization of resolvers) {
      expect(
        await persist({ resolveCurrentAuthorization }),
      ).toBe("stale");
    }
    expect(storage.attempts).toBe(0);
  });

  test("rejects every independently malformed or substituted update authorization coordinate", async () => {
    const scenario = fixture(9_061);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const backing = await initializedObjectStore(scenario);
    await backing.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const storage = new CountingCasStorage(backing);
    type Context = ObjectAccessUpdatePersistenceAuthorizationContextV2;
    type Decision = ReturnType<
      (typeof scenario.authorization)["resolveCurrentAuthorization"]
    >;
    const base = (context: Context): Decision =>
      scenario.authorization.resolveCurrentAuthorization(context);
    const persist = (
      resolveCurrentAuthorization: (context: Context) => Decision,
    ) =>
      persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        storage,
        scenario.initial.head,
        prepared,
        { resolveCurrentAuthorization },
      );

    const malformed: readonly [
      (context: Context) => Decision,
      string,
    ][] = [
      [
        (context) => ({ ...base(context), unexpected: true }),
        "object access update persistence authorization decision has an invalid field set",
      ],
      [
        (context) => ({ ...base(context), purpose: "wrong" as never }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({ ...base(context), operation: "wrong" as never }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({ ...base(context), objectId: 1 as never }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({
          ...base(context),
          currentCommitterDeviceId: 1 as never,
        }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({ ...base(context), committerDeviceId: 1 as never }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({
          ...base(context),
          currentManifestHostAuthorizationRevision: Number.NaN,
        }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({
          ...base(context),
          currentManifestHostAuthorizationRevision: -1,
        }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({
          ...base(context),
          hostAuthorizationRevision: Number.NaN,
        }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({ ...base(context), hostAuthorizationRevision: -1 }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({
          ...base(context),
          currentEnvelopes: "envelopes" as never,
        }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({
          ...base(context),
          nextEnvelopes: "envelopes" as never,
        }),
        "object access update authorization context is invalid",
      ],
      [
        (context) => ({ ...base(context), payloadHash: new Uint8Array(31) }),
        "object access update authorization payload hash must be exactly 32 bytes",
      ],
      [
        (context) => ({ ...base(context), payloadHash: "hash" as never }),
        "object access update authorization payload hash must be exactly 32 bytes",
      ],
      [
        (context) => ({
          ...base(context),
          currentHead: {
            ...context.currentHead,
            unexpected: true,
          },
        }) as Decision,
        "object access authorization head has an invalid field set",
      ],
      [
        (context) => ({
          ...base(context),
          currentHead: {
            ...context.currentHead,
            objectId: 1 as never,
          },
        }),
        "object access authorization head is invalid",
      ],
      [
        (context) => ({
          ...base(context),
          currentHead: {
            ...context.currentHead,
            accessRevision: Number.NaN,
          },
        }),
        "object access authorization head is invalid",
      ],
      [
        (context) => ({
          ...base(context),
          currentHead: {
            ...context.currentHead,
            accessRevision: -1,
          },
        }),
        "object access authorization head is invalid",
      ],
      [
        (context) => ({
          ...base(context),
          currentHead: {
            ...context.currentHead,
            manifestBytes: "manifest" as never,
          },
        }),
        "object access authorization head is invalid",
      ],
      [
        (context) => ({
          ...base(context),
          currentHead: {
            ...context.currentHead,
            manifestHash: new Uint8Array(31),
          },
        }),
        "object access authorization head hash must be exactly 32 bytes",
      ],
      [
        (context) => ({
          ...base(context),
          currentHead: {
            ...context.currentHead,
            manifestHash: "hash" as never,
          },
        }),
        "object access authorization head hash must be exactly 32 bytes",
      ],
      [
        (context) => ({
          ...base(context),
          affectedEnvelope: {
            ...context.affectedEnvelope,
            unexpected: true,
          },
        }) as Decision,
        "object access genesis authorized envelope has an invalid field set",
      ],
      ...([
        ["objectId", 1],
        ["namespaceId", 1],
        ["keyClass", "wrong"],
        ["keyGeneration", Number.NaN],
        ["keyGeneration", -1],
        ["bindingRevisionAtWrap", Number.NaN],
        ["bindingRevisionAtWrap", -1],
        ["envelopeHash", "hash"],
        ["envelopeHash", new Uint8Array(31)],
      ] as const).map(([field, value]) => [
        (context: Context) => ({
          ...base(context),
          affectedEnvelope: {
            ...context.affectedEnvelope,
            [field]: value,
          },
        }) as Decision,
        field === "envelopeHash" && typeof value === "string"
          ? "object access genesis authorized envelope hash must be exactly 32 bytes"
          : field === "envelopeHash"
          ? "object access genesis authorized envelope hash must be exactly 32 bytes"
          : "object access genesis authorized envelope coordinates are invalid",
      ] as [(context: Context) => Decision, string]),
    ];
    for (const [resolve, message] of malformed) {
      await expectExactRejection(persist(resolve), message);
    }

    const substituted: readonly ((context: Context) => Decision)[] = [
      (context) => ({ ...base(context), operation: "detach" }),
      (context) => ({ ...base(context), objectId: "object_other" }),
      (context) => ({
        ...base(context),
        payloadHash: new Uint8Array(32).fill(0xee),
      }),
      (context) => ({
        ...base(context),
        currentHead: { ...context.currentHead, objectId: "object_other" },
      }),
      (context) => ({
        ...base(context),
        currentHead: {
          ...context.currentHead,
          accessRevision: context.currentHead.accessRevision + 1,
        },
      }),
      (context) => ({
        ...base(context),
        currentHead: {
          ...context.currentHead,
          manifestHash: new Uint8Array(32).fill(0xee),
        },
      }),
      (context) => ({
        ...base(context),
        currentHead: {
          ...context.currentHead,
          manifestBytes: context.nextHead.manifestBytes,
        },
      }),
      (context) => ({
        ...base(context),
        nextHead: { ...context.nextHead, objectId: "object_other" },
      }),
      (context) => ({
        ...base(context),
        nextHead: {
          ...context.nextHead,
          accessRevision: context.nextHead.accessRevision + 1,
        },
      }),
      (context) => ({
        ...base(context),
        nextHead: {
          ...context.nextHead,
          manifestHash: new Uint8Array(32).fill(0xee),
        },
      }),
      (context) => ({
        ...base(context),
        nextHead: {
          ...context.nextHead,
          manifestBytes: context.currentHead.manifestBytes,
        },
      }),
      (context) => ({ ...base(context), currentEnvelopes: [] }),
      (context) => ({ ...base(context), nextEnvelopes: [] }),
      (context) => ({
        ...base(context),
        currentCommitterDeviceId: "device_other",
      }),
      (context) => ({ ...base(context), committerDeviceId: "device_other" }),
      (context) => ({
        ...base(context),
        currentManifestHostAuthorizationRevision:
          context.currentManifestHostAuthorizationRevision + 1,
      }),
      (context) => ({
        ...base(context),
        hostAuthorizationRevision: context.hostAuthorizationRevision + 1,
      }),
      ...([
        ["objectId", "object_other"],
        ["namespaceId", "namespace_other"],
        ["keyClass", "ai"],
        ["keyGeneration", 1],
        ["bindingRevisionAtWrap", 1],
        ["envelopeHash", new Uint8Array(32).fill(0xee)],
      ] as const).flatMap(([field, value]) => [
        (context: Context) => ({
          ...base(context),
          currentEnvelopes: context.currentEnvelopes.map((envelope) => ({
            ...envelope,
            [field]: value,
          })),
        }) as Decision,
        (context: Context) => ({
          ...base(context),
          nextEnvelopes: context.nextEnvelopes.map((envelope, index) =>
            index === 0 ? { ...envelope, [field]: value } : envelope
          ),
        }) as Decision,
        (context: Context) => ({
          ...base(context),
          affectedEnvelope: {
            ...context.affectedEnvelope,
            [field]: value,
          },
        }) as Decision,
      ]),
    ];
    for (const resolveCurrentAuthorization of substituted) {
      expect(await persist(resolveCurrentAuthorization)).toBe("stale");
    }
    expect(storage.attempts).toBe(0);
  });

  test("fails stale on missing keys and failed current or next signatures", async () => {
    const scenario = fixture(9_037);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const backing = await initializedObjectStore(scenario);
    await backing.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const storage = new CountingCasStorage(backing);
    const persist = (
      crypto: LatticeCrypto,
      currentKey: Uint8Array,
      nextKey: Uint8Array,
    ) =>
      persistPreparedObjectAccessManifestUpdateV2(
        crypto,
        storage,
        scenario.initial.head,
        prepared,
        {
          resolveCurrentAuthorization: (context) => ({
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision: 2,
            currentHeadCommitterSigningPublicKey: currentKey,
            nextHeadCommitterSigningPublicKey: nextKey,
          }),
        },
      );

    expect(
      await persist(
        scenario.crypto,
        null as never,
        scenario.signing.publicKey,
      ),
    ).toBe("stale");
    expect(
      await persist(
        scenario.crypto,
        scenario.signing.publicKey,
        null as never,
      ),
    ).toBe("stale");
    expect(
      await persist(
        scenario.crypto,
        new Uint8Array(V2_LIMITS.signingPrivateKeyBytes - 1),
        scenario.signing.publicKey,
      ),
    ).toBe("stale");
    expect(
      await persist(
        scenario.crypto,
        scenario.signing.publicKey,
        new Uint8Array(V2_LIMITS.signingPrivateKeyBytes - 1),
      ),
    ).toBe("stale");

    class SelectiveVerifyCrypto extends LatticeCrypto {
      verifications = 0;

      constructor(private readonly failure: number) {
        super(seededRng(9_038 + failure));
      }

      override verify(
        publicKey: Uint8Array,
        message: Uint8Array,
        signature: Uint8Array,
      ): boolean {
        this.verifications += 1;
        return this.verifications === this.failure
          ? false
          : super.verify(publicKey, message, signature);
      }
    }
    expect(
      await persist(
        new SelectiveVerifyCrypto(1),
        scenario.signing.publicKey,
        scenario.signing.publicKey,
      ),
    ).toBe("stale");
    expect(
      await persist(
        new SelectiveVerifyCrypto(2),
        scenario.signing.publicKey,
        scenario.signing.publicKey,
      ),
    ).toBe("stale");
    expect(storage.attempts).toBe(0);
  });

  test("signing-key type and exact length fail closed before even a permissive verifier", async () => {
    const scenario = fixture(9_073);
    const crypto = new class extends LatticeCrypto {
      override verify(): boolean {
        return true;
      }
    }(seededRng(9_073));
    const invalidKeys = [
      new Uint8Array(V2_LIMITS.signingPublicKeyBytes - 1),
      new Uint8Array(V2_LIMITS.signingPublicKeyBytes + 1),
      { length: V2_LIMITS.signingPublicKeyBytes },
    ] as const;
    for (const invalidKey of invalidKeys) {
      const backing = await initializedObjectStore(scenario);
      const storage = new CountingCasStorage(backing);
      expect(
        await persistPreparedObjectAccessManifestGenesisV2({
          crypto,
          storage,
          prepared: scenario.preparedGenesis,
          resolveCurrentAuthorization: (context) => ({
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision: 1,
            committerSigningPublicKey: invalidKey as never,
          }),
        }),
      ).toBe("stale");
      expect(storage.attempts).toBe(0);
    }

    for (const position of ["current", "next"] as const) {
      for (const invalidKey of invalidKeys) {
        const backing = await initializedObjectStore(scenario);
        await backing.compareAndSwapObjectAccessState(
          authorizedObjectWrite(null, scenario.initial),
        );
        const storage = new CountingCasStorage(backing);
        expect(
          await persistPreparedObjectAccessManifestUpdateV2(
            crypto,
            storage,
            scenario.initial.head,
            scenario.prepareAttach(scenario.envelopeB),
            {
              resolveCurrentAuthorization: (context) => ({
                ...context,
                sourceAuthorized: true,
                targetAuthorized: true,
                currentHostAuthorizationRevision: 2,
                currentHeadCommitterSigningPublicKey:
                  position === "current"
                    ? invalidKey as never
                    : scenario.signing.publicKey,
                nextHeadCommitterSigningPublicKey:
                  position === "next"
                    ? invalidKey as never
                    : scenario.signing.publicKey,
              }),
            },
          ),
        ).toBe("stale");
        expect(storage.attempts).toBe(0);
      }
    }
  });

  test("binds authentic prepared manifest bytes and hashes to the intended state", async () => {
    const signatureScenario = fixture(9_040);
    const signaturePrepared = signatureScenario.prepareAttach(
      signatureScenario.envelopeB,
    );
    signaturePrepared.manifest.signature[0] =
      signaturePrepared.manifest.signature[0]! ^ 0xff;
    await expectExactRejection(
      persistPreparedObjectAccessManifestUpdateV2(
        signatureScenario.crypto,
        new CountingCasStorage(new InMemoryV2Store()),
        signatureScenario.initial.head,
        signaturePrepared,
        signatureScenario.authorization,
      ),
      "prepared object access update does not match intended manifest",
    );

    const hashScenario = fixture(9_041);
    const hashPrepared = hashScenario.prepareAttach(hashScenario.envelopeB);
    const wrongPreparedHash = hashPrepared.manifestHash.slice();
    wrongPreparedHash[0] = wrongPreparedHash[0]! ^ 0xff;
    const hashCrypto = new class extends LatticeCrypto {
      override hash(data: Uint8Array): Uint8Array {
        if (
          data.length === hashPrepared.manifestBytes.length
          && data.every((value, index) =>
            value === hashPrepared.manifestBytes[index]
          )
        ) {
          return wrongPreparedHash.slice();
        }
        return super.hash(data);
      }
    }(seededRng(9_041));
    await expectExactRejection(
      persistPreparedObjectAccessManifestUpdateV2(
        hashCrypto,
        new CountingCasStorage(new InMemoryV2Store()),
        hashScenario.initial.head,
        hashPrepared,
        hashScenario.authorization,
      ),
      "prepared object access update does not match intended manifest",
    );
  });

  test("enforces object, revision, and previous-hash chain links independently", async () => {
    const scenario = fixture(9_042);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const createExpected = (
      expectedObjectId: string,
      expectedRevision: number,
      payloadHash: Uint8Array,
      previousManifestHash: Uint8Array | null,
    ) => {
      const created = createObjectAccessManifestV2(
        scenario.crypto,
        {
          objectId: objectId(expectedObjectId),
          payloadHash,
          accessRevision: accessRevision(expectedRevision),
          previousManifestHash,
          envelopeHashes: [],
          committerDeviceId: scenario.deviceId,
          hostAuthorizationRevision: authorizationRevision(1),
        },
        scenario.signing.privateKey,
      );
      return {
        objectId: created.manifest.objectId,
        accessRevision: created.manifest.accessRevision,
        manifestHash: created.hash,
        manifestBytes: created.bytes,
      };
    };
    const collisionHash = scenario.genesis.hash.slice();
    const collisionCrypto = (
      collidingBytes: Uint8Array,
    ) =>
      new class extends LatticeCrypto {
        override hash(data: Uint8Array): Uint8Array {
          if (
            data.length === collidingBytes.length
            && data.every((value, index) => value === collidingBytes[index])
          ) {
            return collisionHash.slice();
          }
          return super.hash(data);
        }
      }(seededRng(9_042));
    const persist = (
      crypto: LatticeCrypto,
      expected: ObjectAccessManifestStorageHeadV2,
    ) =>
      persistPreparedObjectAccessManifestUpdateV2(
        crypto,
        new CountingCasStorage(new InMemoryV2Store()),
        expected,
        prepared,
        scenario.authorization,
      );

    const otherObject = createExpected(
      "object_other",
      0,
      prepared.manifest.payloadHash,
      null,
    );
    await expectExactRejection(
      persist(
        collisionCrypto(otherObject.manifestBytes),
        {
          ...otherObject,
          manifestHash: collisionHash,
        },
      ),
      "prepared object access update is not one exact hash-chained revision",
    );

    const wrongRevision = createExpected(
      "object_storage",
      1,
      prepared.manifest.payloadHash,
      new Uint8Array(32).fill(0x53),
    );
    await expectExactRejection(
      persist(
        collisionCrypto(wrongRevision.manifestBytes),
        {
          ...wrongRevision,
          manifestHash: collisionHash,
        },
      ),
      "prepared object access update is not one exact hash-chained revision",
    );

    const wrongPrevious = createExpected(
      "object_storage",
      0,
      prepared.manifest.payloadHash,
      null,
    );
    await expectExactRejection(
      persist(scenario.crypto, wrongPrevious),
      "prepared object access update is not one exact hash-chained revision",
    );

    const wrongPayload = createExpected(
      "object_storage",
      0,
      new Uint8Array(32).fill(0x54),
      null,
    );
    await expectExactRejection(
      persist(
        collisionCrypto(wrongPayload.manifestBytes),
        { ...wrongPayload, manifestHash: collisionHash },
      ),
      "prepared object access update is not one exact hash-chained revision",
    );
  });

  test("rejects every malformed persisted encrypted-object wire record before CAS", async () => {
    const scenario = fixture(9_047);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const currentStore = await initializedObjectStore(scenario);
    await currentStore.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const persistRaw = (record: unknown) => {
      let attempts = 0;
      const storage: ObjectAccessUpdateStateCasStorageV2 = {
        getObject: () => Promise.resolve(record as never),
        getObjectAccessState:
          currentStore.getObjectAccessState.bind(currentStore),
        compareAndSwapObjectAccessState: () => {
          attempts += 1;
          return Promise.resolve("applied");
        },
      };
      return {
        attempts: () => attempts,
        result: persistPreparedObjectAccessManifestUpdateV2(
          scenario.crypto,
          storage,
          scenario.initial.head,
          prepared,
          scenario.authorization,
        ),
      };
    };

    for (const [record, message] of [
      [
        "object",
        "persisted encrypted object must be an object",
      ],
      [
        {
          objectId: "object_storage",
          payloadBytes: scenario.payloadBytes,
          unexpected: true,
        },
        "persisted encrypted object has an invalid field set",
      ],
      [
        { objectId: "object_storage" },
        "persisted encrypted object has an invalid field set",
      ],
      [
        {
          objectId: "object_storage",
          payloadBytes: "payload",
        },
        "persisted encrypted payload must be Uint8Array",
      ],
      [
        {
          objectId: "object_storage",
          payloadBytes:
            new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
        },
        `persisted encrypted payload bytes exceeds the ${V2_LIMITS.ciphertextBytes} limit`,
      ],
      [
        {
          objectId: "object_other",
          payloadBytes: scenario.payloadBytes,
        },
        "persisted encrypted object does not match canonical payload bytes",
      ],
    ] as const) {
      const attempt = persistRaw(record);
      await expectExactRejection(attempt.result, message);
      expect(attempt.attempts()).toBe(0);
    }
  });

  test("owns raw persisted payload bytes before validating their hash", async () => {
    const scenario = fixture(9_048);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const rawPayload = Buffer.from(scenario.payloadBytes);
    const crypto = new class extends LatticeCrypto {
      override hash(data: Uint8Array): Uint8Array {
        if (data === rawPayload || Buffer.isBuffer(data)) {
          throw new Error("borrowed persisted payload reached hashing");
        }
        return super.hash(data);
      }
    }(seededRng(9_048));
    const currentStore = await initializedObjectStore(scenario);
    await currentStore.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    let attempts = 0;
    const storage: ObjectAccessUpdateStateCasStorageV2 = {
      getObject: () =>
        Promise.resolve({
          objectId: "object_storage",
          payloadBytes: rawPayload,
        }),
      getObjectAccessState:
        currentStore.getObjectAccessState.bind(currentStore),
      compareAndSwapObjectAccessState: () => {
        attempts += 1;
        return Promise.resolve("applied");
      },
    };

    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        crypto,
        storage,
        scenario.initial.head,
        prepared,
        scenario.authorization,
      ),
    ).toBe("applied");
    expect(attempts).toBe(1);
    expect(
      rawPayload.every((byte, index) => byte === scenario.payloadBytes[index]),
    ).toBe(true);
  });

  test("binds persistence to an existing immutable payload on all three axes", async () => {
    const scenario = fixture(9_046);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const persist = (
      crypto: LatticeCrypto,
      storage: ObjectAccessUpdateStateCasStorageV2,
      expected = scenario.initial.head,
    ) =>
      persistPreparedObjectAccessManifestUpdateV2(
        crypto,
        storage,
        expected,
        prepared,
        scenario.authorization,
      );
    expect(
      await persist(
        scenario.crypto,
        new CountingCasStorage(new InMemoryV2Store()),
      ),
    ).toBe("stale");

    const wrongPayloadStore = new InMemoryV2Store();
    const wrongPayload = scenario.payloadBytes.slice();
    wrongPayload[wrongPayload.length - 1] =
      wrongPayload[wrongPayload.length - 1]! ^ 0xff;
    await wrongPayloadStore.putObject({
      objectId: "object_storage",
      payloadBytes: opaqueBytes("encrypted-payload", wrongPayload),
    });
    await wrongPayloadStore.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    expect(
      await persist(
        scenario.crypto,
        new CountingCasStorage(wrongPayloadStore),
      ),
    ).toBe("stale");

    const wrongExpected = createObjectAccessManifestV2(
      scenario.crypto,
      {
        objectId: objectId("object_storage"),
        payloadHash: new Uint8Array(32).fill(0x99),
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [scenario.crypto.hash(scenario.envelopeA)],
        committerDeviceId: scenario.deviceId,
        hostAuthorizationRevision: authorizationRevision(1),
      },
      scenario.signing.privateKey,
    );
    const collisionCrypto = new class extends LatticeCrypto {
      override hash(data: Uint8Array): Uint8Array {
        if (
          data.length === wrongExpected.bytes.length
          && data.every((value, index) =>
            value === wrongExpected.bytes[index]
          )
        ) {
          return scenario.genesis.hash.slice();
        }
        return super.hash(data);
      }
    }(seededRng(9_046));
    const validPayloadStore = await initializedObjectStore(scenario);
    await validPayloadStore.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    await expectExactRejection(
      persist(
        collisionCrypto,
        new CountingCasStorage(validPayloadStore),
        {
          objectId: wrongExpected.manifest.objectId,
          accessRevision: wrongExpected.manifest.accessRevision,
          manifestHash: scenario.genesis.hash,
          manifestBytes: wrongExpected.bytes,
        },
      ),
      "prepared object access update is not one exact hash-chained revision",
    );
  });

  test("passes detached expected and intended byte ownership to storage exactly once", async () => {
    const scenario = fixture(9_043);
    const prepared = scenario.prepareAttach(scenario.envelopeB);
    const pristineExpectedHash =
      scenario.initial.head.manifestHash.slice();
    const pristineExpectedBytes =
      scenario.initial.head.manifestBytes.slice();
    const currentStore = await initializedObjectStore(scenario);
    await currentStore.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );
    const received: {
      expected: ObjectAccessManifestStorageHeadV2 | null;
      intended: ObjectAccessStorageStateV2 | null;
      authorization: ObjectAccessAuthorizationExpectationV2 | null;
    } = { expected: null, intended: null, authorization: null };
    let attempts = 0;
    const storage: ObjectAccessUpdateStateCasStorageV2 = {
      getObject: async () => ({
        objectId: "object_storage",
        payloadBytes: scenario.payloadBytes.slice(),
      }),
      getObjectAccessState: async (objectIdValue) => {
        scenario.initial.head.manifestHash.fill(0xee);
        scenario.initial.head.manifestBytes.fill(0xdd);
        return currentStore.getObjectAccessState(objectIdValue);
      },
      compareAndSwapObjectAccessState(authorized) {
        attempts += 1;
        received.expected = authorized.expected;
        received.intended = authorized.intended;
        received.authorization = authorized.authorization;
        return Promise.resolve("applied");
      },
    };

    expect(
      await persistPreparedObjectAccessManifestUpdateV2(
        scenario.crypto,
        storage,
        scenario.initial.head,
        prepared,
        scenario.authorization,
      ),
    ).toBe("applied");
    expect(attempts).toBe(1);
    expect(received.expected).not.toBe(scenario.initial.head);
    expect(received.expected?.manifestHash).not.toBe(
      scenario.initial.head.manifestHash,
    );
    expect(received.expected?.manifestBytes).not.toBe(
      scenario.initial.head.manifestBytes,
    );
    expect(received.expected?.manifestHash).toEqual(
      pristineExpectedHash,
    );
    expect(received.expected?.manifestBytes).toEqual(
      pristineExpectedBytes,
    );
    expect(received.intended?.head.manifestBytes).not.toBe(
      prepared.manifestBytes,
    );
    expect(received.intended?.head.manifestBytes).toEqual(
      prepared.manifestBytes,
    );
    expect(received.authorization).toMatchObject({
      kind: "update",
      currentManifestHostAuthorizationRevision: 1,
      currentHostAuthorizationRevision: 2,
      currentCommitterSigningPublicKeyHash:
        scenario.crypto.hash(scenario.signing.publicKey),
      nextCommitterSigningPublicKeyHash:
        scenario.crypto.hash(scenario.signing.publicKey),
    });
  });

  test("resolver-side byte mutation cannot alter the internally bound authorization context", async () => {
    const scenario = fixture(9_067);
    type GenesisContext = ObjectAccessGenesisPersistenceAuthorizationContextV2;
    for (const mutate of [
      (context: GenesisContext) => {
        context.payloadHash[0] = context.payloadHash[0]! ^ 1;
      },
      (context: GenesisContext) => {
        context.envelopes[0]!.envelopeHash[0] =
          context.envelopes[0]!.envelopeHash[0]! ^ 1;
      },
    ]) {
      const store = await initializedObjectStore(scenario);
      expect(
        await persistPreparedObjectAccessManifestGenesisV2({
          crypto: scenario.crypto,
          storage: store,
          prepared: scenario.preparedGenesis,
          resolveCurrentAuthorization: (context) => {
            const pristine = {
              ...context,
              payloadHash: context.payloadHash.slice(),
              envelopes: context.envelopes.map((envelope) => ({
                ...envelope,
                envelopeHash: envelope.envelopeHash.slice(),
              })),
            };
            mutate(context);
            return {
              ...pristine,
              sourceAuthorized: true,
              targetAuthorized: true,
              currentHostAuthorizationRevision: 1,
              committerSigningPublicKey: scenario.signing.publicKey,
            };
          },
        }),
      ).toBe("applied");
    }

    type UpdateContext = ObjectAccessUpdatePersistenceAuthorizationContextV2;
    type UpdateDecision = ReturnType<
      (typeof scenario.authorization)["resolveCurrentAuthorization"]
    >;
    for (const mutate of [
      (context: UpdateContext) => {
        context.payloadHash[0] = context.payloadHash[0]! ^ 1;
      },
      (context: UpdateContext) => {
        context.currentHead.manifestHash[0] =
          context.currentHead.manifestHash[0]! ^ 1;
      },
      (context: UpdateContext) => {
        context.currentHead.manifestBytes[0] =
          context.currentHead.manifestBytes[0]! ^ 1;
      },
      (context: UpdateContext) => {
        context.affectedEnvelope.envelopeHash[0] =
          context.affectedEnvelope.envelopeHash[0]! ^ 1;
      },
    ]) {
      const backing = await initializedObjectStore(scenario);
      await backing.compareAndSwapObjectAccessState(
        authorizedObjectWrite(null, scenario.initial),
      );
      const prepared = scenario.prepareAttach(scenario.envelopeB);
      expect(
        await persistPreparedObjectAccessManifestUpdateV2(
          scenario.crypto,
          backing,
          scenario.initial.head,
          prepared,
          {
            resolveCurrentAuthorization: (context) => {
              const pristine: UpdateDecision = {
                ...context,
                payloadHash: context.payloadHash.slice(),
                currentHead: {
                  ...context.currentHead,
                  manifestHash: context.currentHead.manifestHash.slice(),
                  manifestBytes: context.currentHead.manifestBytes.slice(),
                },
                nextHead: {
                  ...context.nextHead,
                  manifestHash: context.nextHead.manifestHash.slice(),
                  manifestBytes: context.nextHead.manifestBytes.slice(),
                },
                currentEnvelopes: context.currentEnvelopes.map((envelope) => ({
                  ...envelope,
                  envelopeHash: envelope.envelopeHash.slice(),
                })),
                nextEnvelopes: context.nextEnvelopes.map((envelope) => ({
                  ...envelope,
                  envelopeHash: envelope.envelopeHash.slice(),
                })),
                affectedEnvelope: {
                  ...context.affectedEnvelope,
                  envelopeHash:
                    context.affectedEnvelope.envelopeHash.slice(),
                },
                sourceAuthorized: true,
                targetAuthorized: true,
                currentHostAuthorizationRevision: 2,
                currentHeadCommitterSigningPublicKey:
                  scenario.signing.publicKey,
                nextHeadCommitterSigningPublicKey:
                  scenario.signing.publicKey,
              };
              mutate(context);
              return pristine;
            },
          },
        ),
      ).toBe("applied");
    }
  });

  test("detaches all caller and reader bytes and exposes no secret-shaped storage bag", async () => {
    const scenario = fixture(9_009);
    const store = await initializedObjectStore(scenario);
    const originalManifest = scenario.initial.head.manifestBytes.slice();
    const originalEnvelope = scenario.initial.namespaceEnvelopes[0]!
      .envelopeBytes.ciphertext.slice();
    await store.compareAndSwapObjectAccessState(
      authorizedObjectWrite(null, scenario.initial),
    );

    scenario.initial.head.manifestBytes[0] =
      scenario.initial.head.manifestBytes[0]! ^ 0xff;
    const callerEnvelope =
      scenario.initial.namespaceEnvelopes[0]!.envelopeBytes.ciphertext;
    callerEnvelope[0] = callerEnvelope[0]! ^ 0xff;
    const firstRead = await store.getObjectAccessState("object_storage");
    expect(firstRead?.head.manifestBytes).toEqual(originalManifest);
    expect(firstRead?.namespaceEnvelopes[0]?.envelopeBytes)
      .toEqual(originalEnvelope);
    firstRead!.head.manifestBytes[0] =
      firstRead!.head.manifestBytes[0]! ^ 0xff;
    const readerEnvelope =
      firstRead!.namespaceEnvelopes[0]!.envelopeBytes;
    readerEnvelope[0] = readerEnvelope[0]! ^ 0xff;
    const secondRead = await store.getObjectAccessState("object_storage");
    expect(secondRead?.head.manifestBytes).toEqual(originalManifest);
    expect(secondRead?.namespaceEnvelopes[0]?.envelopeBytes)
      .toEqual(originalEnvelope);

    const snapshot = store.snapshot();
    const serialized = JSON.stringify(snapshot.objectAccessStates);
    expect(serialized).not.toContain("plaintextKey");
    expect(serialized).not.toContain("domainRoot");
    expect(serialized).not.toContain("namespaceKey");
    expect(serialized).not.toContain("dek");
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("exporter");
    expect(snapshot.objectAccessStates[0]?.namespaceEnvelopes[0]?.envelopeBytes)
      .toMatchObject({
        classification: "opaque-ciphertext",
        kind: "namespace-object-envelope",
      });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    expect(methods).not.toContain("compareAndSwapObjectManifest");
    expect(methods).not.toContain("putSecret");
    expect(methods).not.toContain("putKey");
  });
});
