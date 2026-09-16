import { describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { encodeNamespaceObjectEnvelopeV2 } from "../../src/format/object-v2.ts";
import { createHumanObjectAccessManifestV5 } from "../../src/format/object-access-manifest-v5.ts";
import {
  assertAuthenticPreparedHumanObjectAccessManifestGenesisSetV1,
  assertAuthenticPreparedHumanObjectAccessManifestUpdateSetV1,
  prepareHumanObjectAccessManifestGenesisSetV1,
  prepareHumanObjectAccessManifestUpdateSetV1,
  type HumanObjectAccessNamespaceBindingV1,
  type PrepareHumanObjectAccessManifestUpdateSetInputV1,
} from "../../src/object/human-access-manifest-set-v1.ts";
import { wrapObjectDekForNamespaceV2 } from "../../src/object/namespace-envelope.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
} from "../../src/v2-types/ids.ts";

function envelope(
  crypto: LatticeCrypto,
  namespace: string,
  marker: number,
  bindingRevision = 0,
  targetObjectId = "memory:v1:exact-set",
  keyClass: "ai" | "human" = "ai",
): Uint8Array {
  return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespaceV2(
    crypto,
    new Uint8Array(32).fill(marker),
    {
      objectId: objectId(targetObjectId),
      namespaceId: namespaceId(namespace),
      keyClass,
      keyGeneration: namespaceGeneration(2),
      bindingRevisionAtWrap: accessRevision(bindingRevision),
    },
    new Uint8Array(32).fill(0x77),
  ));
}

function binding(
  namespace: string,
  domain: string,
  marker: number,
  revision = 0,
): HumanObjectAccessNamespaceBindingV1 {
  return {
    namespaceId: namespace,
    domainId: domain,
    expectedAccessRevision: revision,
    expectedPolicyRevision: 3,
    bindingHash: new Uint8Array(32).fill(marker),
  };
}

function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x250_14));
  const signer = crypto.generateSigningKeyPair();
  const currentEnvelopeBytes = [
    envelope(crypto, "namespace-a", 0x11),
    envelope(crypto, "namespace-b", 0x21),
  ];
  const currentNamespaceBindings = [
    binding("namespace-a", "domain-ab", 0x31),
    binding("namespace-b", "domain-ab", 0x41),
  ];
  const envelopeHashes = currentEnvelopeBytes.map((bytes) => crypto.hash(bytes));
  const genesis = createHumanObjectAccessManifestV5(crypto, {
    objectId: objectId("memory:v1:exact-set"),
    payloadHash: new Uint8Array(32).fill(0x51),
    accessRevision: accessRevision(0),
    previousManifestHash: null,
    envelopeHashes,
    signer: {
      kind: "human_device",
      subjectHumanId: humanId("human-alice"),
      committerDeviceId: cryptoDeviceId("device-alice-1"),
    },
    signerAuthorizationHash: null,
    hostAuthorizationRevision: authorizationRevision(7),
  }, signer.privateKey);
  const input: PrepareHumanObjectAccessManifestUpdateSetInputV1 = {
    operationId: "operation-m250-1",
    expectedContentRevision: 12,
    currentManifestBytes: genesis.bytes,
    currentEnvelopeBytes,
    targetEnvelopeBytes: [
      currentEnvelopeBytes[1]!,
      envelope(crypto, "namespace-c", 0x32),
    ],
    trustedMinimumHead: {
      objectId: genesis.manifest.objectId,
      payloadHash: genesis.manifest.payloadHash,
      accessRevision: genesis.manifest.accessRevision,
      manifestHash: genesis.hash,
    },
    proof: [],
    resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
      context.committerDeviceId === "device-alice-1" ? signer.publicKey : null,
    resolveAgentRuntimeSignerPublicKey: () => null,
    resolveProcessorSignerAuthorizationBytes: () => null,
    resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    currentNamespaceBindings,
    targetNamespaceBindings: [
      binding("namespace-b", "domain-ab", 0x41),
      binding("namespace-c", "domain-c", 0x61),
    ],
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId("human-alice"),
    committerDeviceId: cryptoDeviceId("device-alice-1"),
    hostAuthorizationRevision: authorizationRevision(8),
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  };
  return { crypto, signer, genesis, input };
}

describe("Human ObjectAccessManifestV5 exact-set updates", () => {
  test("prepares an authentic Human-signed genesis exact set", () => {
    const state = fixture();
    const prepared = prepareHumanObjectAccessManifestGenesisSetV1(
      state.crypto,
      {
        objectId: state.genesis.manifest.objectId,
        payloadHash: state.genesis.manifest.payloadHash,
        envelopeBytes: state.input.currentEnvelopeBytes,
        sourceAuthorized: true,
        targetAuthorized: true,
        subjectHumanId: "human-alice",
        committerDeviceId: "device-alice-1",
        hostAuthorizationRevision: 7,
        committerSigningPublicKey: state.signer.publicKey,
        committerSigningPrivateKey: state.signer.privateKey,
      },
    );

    expect(prepared.manifest).toMatchObject({
      objectId: "memory:v1:exact-set",
      accessRevision: 0,
      previousManifestHash: null,
      signer: {
        kind: "human_device",
        subjectHumanId: "human-alice",
        committerDeviceId: "device-alice-1",
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: 7,
    });
    expect(prepared.manifest.envelopeHashes.map(bytesToHex).sort()).toEqual(
      prepared.envelopeBytes.map((bytes) => bytesToHex(state.crypto.hash(bytes)))
        .sort(),
    );
    expect(() =>
      assertAuthenticPreparedHumanObjectAccessManifestGenesisSetV1(prepared)
    ).not.toThrow();
    expect(() =>
      assertAuthenticPreparedHumanObjectAccessManifestGenesisSetV1({
        ...prepared,
      })
    ).toThrow("authentic prepared v5 genesis");
  });

  test("rejects unauthorized, malformed, duplicate, and mismatched Human genesis inputs", () => {
    const state = fixture();
    const base = {
      objectId: state.genesis.manifest.objectId,
      payloadHash: state.genesis.manifest.payloadHash,
      envelopeBytes: state.input.currentEnvelopeBytes,
      sourceAuthorized: true,
      targetAuthorized: true,
      subjectHumanId: "human-alice",
      committerDeviceId: "device-alice-1",
      hostAuthorizationRevision: 7,
      committerSigningPublicKey: state.signer.publicKey,
      committerSigningPrivateKey: state.signer.privateKey,
    };
    expect(() => prepareHumanObjectAccessManifestGenesisSetV1(
      state.crypto,
      { ...base, sourceAuthorized: false },
    )).toThrow("explicit source and target authority");
    expect(() => prepareHumanObjectAccessManifestGenesisSetV1(
      state.crypto,
      { ...base, targetAuthorized: false },
    )).toThrow("explicit source and target authority");
    expect(() => prepareHumanObjectAccessManifestGenesisSetV1(
      state.crypto,
      { ...base, envelopeBytes: null } as never,
    )).toThrow("envelopes must be an array");
    expect(() => prepareHumanObjectAccessManifestGenesisSetV1(
      state.crypto,
      { ...base, envelopeBytes: [base.envelopeBytes[0]!, null] } as never,
    )).toThrow("envelope must be bytes");
    expect(() => prepareHumanObjectAccessManifestGenesisSetV1(
      state.crypto,
      { ...base, envelopeBytes: [base.envelopeBytes[0]!, base.envelopeBytes[0]!] },
    )).toThrow("one canonical AI envelope per Namespace");
    expect(() => prepareHumanObjectAccessManifestGenesisSetV1(
      state.crypto,
      {
        ...base,
        envelopeBytes: [
          envelope(state.crypto, "namespace-a", 0x11, 0, "memory:v1:other"),
        ],
      },
    )).toThrow("one canonical AI envelope per Namespace");
    expect(() => prepareHumanObjectAccessManifestGenesisSetV1(
      state.crypto,
      {
        ...base,
        envelopeBytes: [
          envelope(
            state.crypto,
            "namespace-a",
            0x11,
            0,
            "memory:v1:exact-set",
            "human",
          ),
        ],
      },
    )).toThrow("one canonical AI envelope per Namespace");
    expect(() => prepareHumanObjectAccessManifestGenesisSetV1(
      state.crypto,
      {
        ...base,
        committerSigningPrivateKey: state.crypto.generateSigningKeyPair()
          .privateKey,
      },
    )).toThrow("signing keys do not match");
  });

  test("genesis authenticity detects one changed envelope among an exact set", () => {
    const state = fixture();
    const prepared = prepareHumanObjectAccessManifestGenesisSetV1(
      state.crypto,
      {
        objectId: state.genesis.manifest.objectId,
        payloadHash: state.genesis.manifest.payloadHash,
        envelopeBytes: state.input.currentEnvelopeBytes,
        sourceAuthorized: true,
        targetAuthorized: true,
        subjectHumanId: "human-alice",
        committerDeviceId: "device-alice-1",
        hostAuthorizationRevision: 7,
        committerSigningPublicKey: state.signer.publicKey,
        committerSigningPrivateKey: state.signer.privateKey,
      },
    );

    prepared.envelopeBytes[1]![0] = prepared.envelopeBytes[1]![0]! ^ 1;
    expect(() =>
      assertAuthenticPreparedHumanObjectAccessManifestGenesisSetV1(prepared)
    ).toThrow("authentic prepared v5 genesis");
  });

  test("replaces the complete same/cross-Domain Namespace set at N+1", () => {
    const state = fixture();
    const prepared = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      state.input,
    );

    expect(prepared.manifest.accessRevision).toBe(accessRevision(1));
    expect(prepared.manifest.previousManifestHash).toEqual(
      state.genesis.hash,
    );
    expect(prepared.envelopeBytes).toEqual(state.input.targetEnvelopeBytes);
    expect(prepared.authority).toMatchObject({
      purpose: "persist-human-object-access-update-set",
      operationId: "operation-m250-1",
      objectId: "memory:v1:exact-set",
      expectedContentRevision: 12,
      currentAccessRevision: 0,
      nextAccessRevision: 1,
      committerDeviceId: "device-alice-1",
      hostAuthorizationRevision: 8,
    });
    expect(prepared.authority.currentNamespaceBindings.map((entry) =>
      entry.namespaceId
    )).toEqual(["namespace-a", "namespace-b"]);
    expect(prepared.authority.targetNamespaceBindings.map((entry) =>
      entry.namespaceId
    )).toEqual(["namespace-b", "namespace-c"]);
    expect(prepared.authority.removedNamespaceIds).toEqual(["namespace-a"]);
    expect(prepared.authority.addedNamespaceIds).toEqual(["namespace-c"]);
    expect(prepared.authority.currentEnvelopes.map((entry) => entry.namespaceId))
      .toEqual(["namespace-a", "namespace-b"]);
    expect(prepared.authority.targetEnvelopes.map((entry) => entry.namespaceId))
      .toEqual(["namespace-b", "namespace-c"]);
    expect(() =>
      assertAuthenticPreparedHumanObjectAccessManifestUpdateSetV1(prepared)
    ).not.toThrow();
  });

  test("retains the legacy Human-device resolver fallback", () => {
    const state = fixture();
    const {
      resolveHistoricalHumanDeviceSigningPublicKey: _historicalResolver,
      ...legacyInput
    } = state.input;
    const prepared = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      {
        ...legacyInput,
        resolveSigningPublicKey: (deviceId) =>
          deviceId === "device-alice-1" ? state.signer.publicKey : null,
      },
    );

    expect(prepared.manifest.accessRevision).toBe(accessRevision(1));
  });

  test("authenticates an arbitrary current revision from a bounded minimum proof", () => {
    const state = fixture();
    const revisionOne = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      state.input,
    );
    const revisionTwo = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      {
        ...state.input,
        operationId: "operation-m250-2",
        currentManifestBytes: revisionOne.manifestBytes,
        currentEnvelopeBytes: revisionOne.envelopeBytes,
        currentNamespaceBindings: state.input.targetNamespaceBindings,
        targetEnvelopeBytes: [revisionOne.envelopeBytes[1]!],
        targetNamespaceBindings: [binding("namespace-c", "domain-c", 0x61)],
        proof: [],
        hostAuthorizationRevision: authorizationRevision(9),
      },
    );
    expect(revisionTwo.manifest.accessRevision).toBe(accessRevision(2));
    expect(revisionTwo.manifest.previousManifestHash).toEqual(
      revisionOne.manifestHash,
    );

    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      operationId: "operation-m250-broken-proof",
      currentManifestBytes: revisionTwo.manifestBytes,
      currentEnvelopeBytes: revisionTwo.envelopeBytes,
      currentNamespaceBindings: revisionTwo.authority.targetNamespaceBindings,
      proof: [],
    })).toThrow("fork or broken hash chain");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      operationId: "operation-m250-stale",
      trustedMinimumHead: {
        ...state.input.trustedMinimumHead,
        accessRevision: accessRevision(1),
        manifestHash: revisionOne.manifestHash,
      },
    })).toThrow("rollback");
  });

  test("allows the ordinary empty exact target without a tombstone", () => {
    const state = fixture();
    const prepared = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      {
        ...state.input,
        targetEnvelopeBytes: [],
        targetNamespaceBindings: [],
        targetAuthorized: false,
      },
    );
    expect(prepared.envelopeBytes).toEqual([]);
    expect(prepared.manifest.envelopeHashes).toEqual([]);
    expect("preauthorizedTombstone" in prepared).toBe(false);
    expect(() =>
      assertAuthenticPreparedHumanObjectAccessManifestUpdateSetV1(prepared)
    ).not.toThrow();
  });

  test("requires authority only for removed and added Namespace sets", () => {
    const state = fixture();
    for (const patch of [
      { sourceAuthorized: false },
      { targetAuthorized: false },
    ]) {
      expect(() => prepareHumanObjectAccessManifestUpdateSetV1(
        state.crypto,
        { ...state.input, ...patch },
      )).toThrow("lacks authority");
    }
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      targetEnvelopeBytes: [],
      targetNamespaceBindings: [],
      targetAuthorized: false,
    })).not.toThrow();
  });

  test("preserves inaccessible retained envelopes without their Namespace keys", () => {
    const state = fixture();
    const aliceOnly = state.input.currentEnvelopeBytes[0]!;
    const bobVisible = state.input.currentEnvelopeBytes[1]!;
    const shared = envelope(state.crypto, "namespace-c", 0x71);
    const genesis = createHumanObjectAccessManifestV5(state.crypto, {
      objectId: objectId("memory:v1:exact-set"),
      payloadHash: state.genesis.manifest.payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [aliceOnly, bobVisible, shared].map((bytes) =>
        state.crypto.hash(bytes)
      ),
      signer: {
        kind: "human_device",
        subjectHumanId: humanId("human-alice"),
        committerDeviceId: cryptoDeviceId("device-alice-1"),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(9),
    }, state.signer.privateKey);
    const prepared = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      {
        ...state.input,
        operationId: "operation-bob-authorized-view-delete",
        currentManifestBytes: genesis.bytes,
        currentEnvelopeBytes: [aliceOnly, bobVisible, shared],
        currentNamespaceBindings: [
          state.input.currentNamespaceBindings[0]!,
          state.input.currentNamespaceBindings[1]!,
          binding("namespace-c", "domain-c", 0x71),
        ],
        targetEnvelopeBytes: [aliceOnly, shared],
        targetNamespaceBindings: [
          state.input.currentNamespaceBindings[0]!,
          binding("namespace-c", "domain-c", 0x71),
        ],
        trustedMinimumHead: {
          objectId: genesis.manifest.objectId,
          payloadHash: genesis.manifest.payloadHash,
          accessRevision: genesis.manifest.accessRevision,
          manifestHash: genesis.hash,
        },
        sourceAuthorized: true,
        targetAuthorized: false,
      },
    );
    expect(prepared.authority.removedNamespaceIds).toEqual(["namespace-b"]);
    expect(prepared.authority.addedNamespaceIds).toEqual([]);
    expect(prepared.envelopeBytes).toEqual([aliceOnly, shared]);
  });

  test("retains historical wraps after binding rotation but rejects stale added wraps", () => {
    const state = fixture();
    const historicalA = envelope(state.crypto, "namespace-a", 0x11, 0);
    const historicalB = envelope(state.crypto, "namespace-b", 0x21, 0);
    const freshC = envelope(state.crypto, "namespace-c", 0x31, 2);
    const genesis = createHumanObjectAccessManifestV5(state.crypto, {
      objectId: objectId("memory:v1:exact-set"),
      payloadHash: state.genesis.manifest.payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [historicalA, historicalB].map((bytes) =>
        state.crypto.hash(bytes)
      ),
      signer: {
        kind: "human_device",
        subjectHumanId: humanId("human-alice"),
        committerDeviceId: cryptoDeviceId("device-alice-1"),
      },
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(9),
    }, state.signer.privateKey);
    const rotatedA = binding("namespace-a", "domain-ab", 0x81, 2);
    const rotatedB = binding("namespace-b", "domain-ab", 0x82, 2);
    const rotatedC = binding("namespace-c", "domain-c", 0x83, 2);
    const rotatedInput: PrepareHumanObjectAccessManifestUpdateSetInputV1 = {
      ...state.input,
      currentManifestBytes: genesis.bytes,
      currentEnvelopeBytes: [historicalA, historicalB],
      currentNamespaceBindings: [rotatedA, rotatedB],
      targetEnvelopeBytes: [historicalB, freshC],
      targetNamespaceBindings: [rotatedB, rotatedC],
      trustedMinimumHead: {
        objectId: genesis.manifest.objectId,
        payloadHash: genesis.manifest.payloadHash,
        accessRevision: genesis.manifest.accessRevision,
        manifestHash: genesis.hash,
      },
    };
    const prepared = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      rotatedInput,
    );
    expect(prepared.authority.currentEnvelopes.map((entry) =>
      entry.bindingRevisionAtWrap
    )).toEqual([0, 0]);
    expect(prepared.authority.targetEnvelopes.map((entry) =>
      entry.bindingRevisionAtWrap
    )).toEqual([0, 2]);
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...rotatedInput,
      targetEnvelopeBytes: [historicalB, envelope(
        state.crypto,
        "namespace-c",
        0x31,
        0,
      )],
    })).toThrow("stale binding revision");
  });

  test("rejects partial, reordered, duplicated, and substituted current sets", () => {
    const state = fixture();
    const [a, b] = state.input.currentEnvelopeBytes;
    const [bindingA, bindingB] = state.input.currentNamespaceBindings;
    const invalid: Partial<PrepareHumanObjectAccessManifestUpdateSetInputV1>[] = [
      { currentEnvelopeBytes: [a!] },
      { currentEnvelopeBytes: [b!, a!] },
      { currentEnvelopeBytes: [a!, a!] },
      {
        currentEnvelopeBytes: [a!, envelope(state.crypto, "namespace-c", 0x43)],
      },
      { currentNamespaceBindings: [bindingA!] },
      { currentNamespaceBindings: [bindingB!, bindingA!] },
      { currentNamespaceBindings: [bindingA!, bindingA!] },
      {
        currentNamespaceBindings: [
          bindingA!,
          binding("namespace-b", "domain-substituted", 0x41),
        ],
      },
    ];
    for (const patch of invalid) {
      expect(() => prepareHumanObjectAccessManifestUpdateSetV1(
        state.crypto,
        { ...state.input, ...patch },
      )).toThrow();
    }
  });

  test("rejects partial, reordered, duplicated, and substituted target sets", () => {
    const state = fixture();
    const [b, c] = state.input.targetEnvelopeBytes;
    const [bindingB, bindingC] = state.input.targetNamespaceBindings;
    const invalid: Partial<PrepareHumanObjectAccessManifestUpdateSetInputV1>[] = [
      { targetNamespaceBindings: [bindingB!] },
      { targetEnvelopeBytes: [c!, b!] },
      { targetEnvelopeBytes: [b!, b!] },
      { targetNamespaceBindings: [bindingC!, bindingB!] },
      { targetNamespaceBindings: [bindingB!, bindingB!] },
      {
        targetEnvelopeBytes: [
          b!,
          envelope(state.crypto, "namespace-d", 0x44),
        ],
      },
    ];
    for (const patch of invalid) {
      expect(() => prepareHumanObjectAccessManifestUpdateSetV1(
        state.crypto,
        { ...state.input, ...patch },
      )).toThrow();
    }
  });

  test("rejects inexact authority coordinates, binding revisions, and key class", () => {
    const state = fixture();
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentNamespaceBindings: [
        binding("namespace-a", "domain-ab", 0x31, 1),
        state.input.currentNamespaceBindings[1]!,
      ],
    })).not.toThrow();
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      expectedContentRevision: -1,
    })).toThrow("content revision");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      operationId: "",
    })).toThrow("operation ID");
    const humanEnvelope = encodeNamespaceObjectEnvelopeV2({
      ...wrapObjectDekForNamespaceV2(
        state.crypto,
        new Uint8Array(32).fill(1),
        {
          objectId: objectId("memory:v1:exact-set"),
          namespaceId: namespaceId("namespace-c"),
          keyClass: "human",
          keyGeneration: namespaceGeneration(2),
          bindingRevisionAtWrap: accessRevision(0),
        },
        new Uint8Array(32).fill(2),
      ),
    });
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      targetEnvelopeBytes: [state.input.targetEnvelopeBytes[0]!, humanEnvelope],
    })).toThrow("AI");
  });

  test("WeakMap-authenticates every prepared field and byte inventory", () => {
    const state = fixture();
    const prepared = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      state.input,
    );
    expect(() =>
      assertAuthenticPreparedHumanObjectAccessManifestUpdateSetV1({
        ...prepared,
      })
    ).toThrow("authentic prepared exact-set update");

    prepared.envelopeBytes[0]![0] = prepared.envelopeBytes[0]![0]! ^ 1;
    expect(() =>
      assertAuthenticPreparedHumanObjectAccessManifestUpdateSetV1(prepared)
    ).toThrow("authentic prepared exact-set update");

    const fresh = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      state.input,
    );
    fresh.authority.currentNamespaceBindings[0]!.bindingHash[0] =
      fresh.authority.currentNamespaceBindings[0]!.bindingHash[0]! ^ 1;
    expect(() =>
      assertAuthenticPreparedHumanObjectAccessManifestUpdateSetV1(fresh)
    ).toThrow("authentic prepared exact-set update");

    const manifestMutation = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      state.input,
    );
    manifestMutation.manifest.envelopeHashes[0]![0] =
      manifestMutation.manifest.envelopeHashes[0]![0]! ^ 1;
    expect(() =>
      assertAuthenticPreparedHumanObjectAccessManifestUpdateSetV1(
        manifestMutation,
      )
    ).toThrow("authentic prepared exact-set update");
  });

  test("copies caller buffers and wipes owned signing/verification bytes", () => {
    const state = fixture();
    const signCalls: Uint8Array[][] = [];
    const verifyCalls: Uint8Array[][] = [];
    const originalSign = state.crypto.sign.bind(state.crypto);
    const originalVerify = state.crypto.verify.bind(state.crypto);
    state.crypto.sign = (key, message) => {
      signCalls.push([key, message]);
      return originalSign(key, message);
    };
    state.crypto.verify = (key, message, signature) => {
      verifyCalls.push([key, message, signature]);
      return originalVerify(key, message, signature);
    };
    const prepared = prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      state.input,
    );
    const expected = prepared.envelopeBytes.map((bytes) => bytes.slice());
    state.input.targetEnvelopeBytes[0]![0] =
      state.input.targetEnvelopeBytes[0]![0]! ^ 1;
    state.input.targetNamespaceBindings[0]!.bindingHash[0] =
      state.input.targetNamespaceBindings[0]!.bindingHash[0]! ^ 1;
    expect(prepared.envelopeBytes).toEqual(expected);
    expect(signCalls.at(-1)![0]!.every((byte) => byte === 0)).toBe(true);
    expect(verifyCalls.at(-1)!.every((buffer) =>
      buffer.every((byte) => byte === 0)
    )).toBe(true);
  });

  test("validates exact authority and Namespace-binding shapes", () => {
    const state = fixture();
    for (const patch of [
      { sourceAuthorized: "yes" },
      { targetAuthorized: 1 },
    ]) {
      expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
        ...state.input,
        ...patch,
      } as never)).toThrow(
        "Human object access update source and target authority must be explicit",
      );
    }
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentNamespaceBindings: null,
    } as never)).toThrow("Human object current Namespace bindings must be an array");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentNamespaceBindings: [null, state.input.currentNamespaceBindings[1]!],
    } as never)).toThrow("Human object current Namespace bindings entry must be an object");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentNamespaceBindings: [1, state.input.currentNamespaceBindings[1]!],
    } as never)).toThrow("Human object current Namespace bindings entry must be an object");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentNamespaceBindings: [{
        ...state.input.currentNamespaceBindings[0]!,
        extra: true,
      }, state.input.currentNamespaceBindings[1]!],
    } as never)).toThrow("Human object current Namespace bindings entry fields must be exact");
    const missingTailField = {
      ...state.input.currentNamespaceBindings[0]!,
    } as Record<string, unknown>;
    delete missingTailField["namespaceId"];
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentNamespaceBindings: [
        missingTailField as never,
        state.input.currentNamespaceBindings[1]!,
      ],
    })).toThrow("Human object current Namespace bindings entry fields must be exact");
    const substitutedTailField = {
      ...state.input.currentNamespaceBindings[0]!,
    } as Record<string, unknown>;
    delete substitutedTailField["namespaceId"];
    substitutedTailField["namespaceIx"] = "namespace-a";
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentNamespaceBindings: [
        substitutedTailField as never,
        state.input.currentNamespaceBindings[1]!,
      ],
    })).toThrow("Human object current Namespace bindings entry fields must be exact");
    for (const [patch, message] of [
      [{ expectedAccessRevision: -1 }, "Human object current Namespace bindings expected access revision must be a non-negative safe integer"],
      [{ expectedPolicyRevision: -1 }, "Human object current Namespace bindings expected policy revision must be a non-negative safe integer"],
      [{ bindingHash: new Uint8Array(31) }, "Human object current Namespace bindings binding hash must be exactly 32 bytes"],
    ] as const) {
      expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
        ...state.input,
        currentNamespaceBindings: [{
          ...state.input.currentNamespaceBindings[0]!,
          ...patch,
        }, state.input.currentNamespaceBindings[1]!],
      })).toThrow(message);
    }
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      targetNamespaceBindings: [
        { ...state.input.targetNamespaceBindings[0]!, domainId: "domain-other" },
        state.input.targetNamespaceBindings[1]!,
      ],
    })).toThrow("Human object retained Namespace Domain expectation was substituted");
  });

  test("validates complete canonical envelope inventories and exact deltas", () => {
    const state = fixture();
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: null,
    } as never)).toThrow("Human object current Namespace envelopes must be an array");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: [state.input.currentEnvelopeBytes[0]!],
    })).toThrow("Human object current Namespace envelopes must exactly match its binding set");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: [null, state.input.currentEnvelopeBytes[1]!],
    } as never)).toThrow("Human object current Namespace envelopes entry must be bytes");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: [
        envelope(state.crypto, "namespace-a", 0x11, 1),
        state.input.currentEnvelopeBytes[1]!,
      ],
    })).toThrow("Human object current Namespace envelopes binding revision is ahead of authority");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      targetEnvelopeBytes: state.input.currentEnvelopeBytes,
      targetNamespaceBindings: state.input.currentNamespaceBindings,
    })).toThrow("Human object exact target is unchanged");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      targetNamespaceBindings: [
        { ...state.input.targetNamespaceBindings[0]!, bindingHash: new Uint8Array(32).fill(0xee) },
        state.input.targetNamespaceBindings[1]!,
      ],
    })).toThrow("Human object retained Namespace authority or envelope was substituted");

    const reorderedPreparedInput = {
      ...state.input,
      targetEnvelopeBytes: [
        state.input.targetEnvelopeBytes[1]!,
        state.input.targetEnvelopeBytes[0]!,
      ],
      targetNamespaceBindings: [
        state.input.targetNamespaceBindings[1]!,
        state.input.targetNamespaceBindings[0]!,
      ],
    };
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(
      state.crypto,
      reorderedPreparedInput,
    )).toThrow("Human object target Namespace bindings must use canonical unique Namespace ordering");

    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: [
        envelope(state.crypto, "namespace-a", 0x99),
        state.input.currentEnvelopeBytes[1]!,
      ],
    })).toThrow("Human object current envelope inventory is inexact");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: [state.input.currentEnvelopeBytes[0]!],
      currentNamespaceBindings: [state.input.currentNamespaceBindings[0]!],
    })).toThrow("Human object current envelope inventory is inexact");
    const expectedFirstHash = state.genesis.manifest.envelopeHashes[0]!;
    const matchingIndex = state.input.currentEnvelopeBytes.findIndex((bytes) =>
      state.crypto.hash(bytes).every((byte, index) =>
        byte === expectedFirstHash[index]
      )
    );
    expect(matchingIndex).toBeGreaterThanOrEqual(0);
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: [state.input.currentEnvelopeBytes[matchingIndex]!],
      currentNamespaceBindings: [
        state.input.currentNamespaceBindings[matchingIndex]!,
      ],
    })).toThrow("Human object current envelope inventory is inexact");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      targetEnvelopeBytes: [
        state.input.targetEnvelopeBytes[0]!,
        envelope(state.crypto, "namespace-c", 0x61),
      ],
      targetNamespaceBindings: [
        state.input.targetNamespaceBindings[0]!,
        state.input.targetNamespaceBindings[0]!,
      ],
    })).toThrow("Human object target Namespace bindings must use canonical unique Namespace ordering");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      targetEnvelopeBytes: [
        state.input.targetEnvelopeBytes[0]!,
        envelope(state.crypto, "namespace-c", 0x61),
      ],
      targetNamespaceBindings: [
        state.input.targetNamespaceBindings[0]!,
        state.input.targetNamespaceBindings[1]!,
      ],
    })).not.toThrow();
    const otherObjectEnvelope = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespaceV2(
        state.crypto,
        new Uint8Array(32).fill(0x44),
        {
          objectId: objectId("memory:v1:other-object"),
          namespaceId: namespaceId("namespace-c"),
          keyClass: "human",
          keyGeneration: namespaceGeneration(2),
          bindingRevisionAtWrap: accessRevision(0),
        },
        new Uint8Array(32).fill(0x77),
      ),
    );
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      targetEnvelopeBytes: [
        state.input.targetEnvelopeBytes[0]!,
        otherObjectEnvelope,
      ],
    })).toThrow("Human object target Namespace envelopes must be an exact AI Namespace envelope set");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      targetEnvelopeBytes: [state.input.targetEnvelopeBytes[0]!, null] as never,
    })).toThrow("Human object target Namespace envelopes entry must be bytes");
  });

  test("permits exact add-only authority without removal authority", () => {
    const state = fixture();
    const addedEnvelope = envelope(state.crypto, "namespace-c", 0x61);
    const prepared = prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      currentEnvelopeBytes: state.input.currentEnvelopeBytes,
      currentNamespaceBindings: state.input.currentNamespaceBindings,
      targetEnvelopeBytes: [...state.input.currentEnvelopeBytes, addedEnvelope],
      targetNamespaceBindings: [
        ...state.input.currentNamespaceBindings,
        binding("namespace-c", "domain-c", 0x61),
      ],
      sourceAuthorized: false,
    });
    expect(prepared.authority.removedNamespaceIds).toEqual([]);
    expect(prepared.authority.addedNamespaceIds).toEqual(["namespace-c"]);
  });

  test("validates signing key boundaries and authenticates every authority inventory", () => {
    const state = fixture();
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      committerSigningPublicKey: new Uint8Array(31),
    })).toThrow("Human object access signing public key must be exactly 32 bytes");
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      committerSigningPrivateKey: new Uint8Array(31),
    })).toThrow("Human object access signing private key must be exactly 32 bytes");
    const other = state.crypto.generateSigningKeyPair();
    expect(() => prepareHumanObjectAccessManifestUpdateSetV1(state.crypto, {
      ...state.input,
      committerSigningPublicKey: other.publicKey,
    })).toThrow("Human object access signing keys do not match");

    const mutations: Array<(prepared: ReturnType<
      typeof prepareHumanObjectAccessManifestUpdateSetV1
    >) => void> = [
      (prepared) => prepared.authority.payloadHash.fill(0),
      (prepared) => prepared.authority.currentManifestHash.fill(0),
      (prepared) => prepared.authority.nextManifestHash.fill(0),
      (prepared) => prepared.authority.currentEnvelopes[0]!.envelopeHash.fill(0),
      (prepared) => prepared.authority.targetEnvelopes[0]!.envelopeHash.fill(0),
      (prepared) => prepared.authority.targetNamespaceBindings[0]!.bindingHash.fill(0),
    ];
    for (const mutate of mutations) {
      const prepared = prepareHumanObjectAccessManifestUpdateSetV1(
        state.crypto,
        state.input,
      );
      mutate(prepared);
      expect(() => assertAuthenticPreparedHumanObjectAccessManifestUpdateSetV1(
        prepared,
      )).toThrow(
        "Human object access persistence requires an authentic prepared exact-set update",
      );
    }
  });
});
