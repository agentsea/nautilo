import { describe, expect, test } from "bun:test";

import {
  AGENT_RUNTIME_SIGNER_PUBLICATION_DOMAIN_V1,
  MAX_AGENT_RUNTIME_SIGNER_PUBLICATION_WIRE_BYTES_V1,
  agentRuntimeInitializationPublicStateCommitmentV1,
  agentRuntimeInitializationSignerPublicationMatchesStateV1,
  agentRuntimeRotationSignerPublicationMatchesManifestV1,
  agentRuntimeSignerPublicationMatchesRuntimeV1,
  agentRuntimeSignerPublicationSigningBytesV1,
  createAgentRuntimeInitializationSignerPublicationV1,
  createAgentRuntimeRotationSignerPublicationV1,
  decodeAgentRuntimeSignerPublicationV1,
  encodeAgentRuntimeSignerPublicationV1,
  verifyHistoricalAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationV1,
  type CurrentAgentRuntimeSignerPublicationManagerContextV1,
} from "../../src/agent-runtime/signer-publication-v1.ts";
import type {
  AgentRuntimeGenerationV2,
} from "../../src/agent-runtime/types.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { frameText } from "../../src/format/v2-primitives.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDomainId,
  cryptoDeviceId,
  domainEpoch,
  humanId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function bytes(fill: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function hex(value: Uint8Array): string {
  return Array.from(
    value,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function runtime(
  generation = 0,
  marker = 0x41,
): AgentRuntimeGenerationV2 {
  return Object.freeze({
    agentId: agentId("agent-genie"),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(generation),
    key: bytes(marker),
  });
}

function fixture(
  transitionKind: "initialization" | "rotation" = "initialization",
  generation = transitionKind === "initialization" ? 0 : 1,
) {
  const crypto = new LatticeCrypto(seededRng(23_701 + generation));
  const managerSigning = crypto.generateSigningKeyPair();
  const sourceRuntime = runtime(generation, 0x41 + generation);
  const manager = Object.freeze({
    managerHumanId: humanId("human-manager"),
    managerAuthorizationRevision: authorizationRevision(8 + generation),
    managerDeviceId: cryptoDeviceId("device-manager"),
  });
  const operationId = transitionKind === "initialization"
    ? "operation-runtime-init"
    : "operation-runtime-rotate";
  const authorization = authorizationRevision(12 + generation);
  const transitionCommitment = bytes(0x20 + generation);
  let observedContext: unknown;
  const common = {
    crypto,
    operationId,
    runtime: sourceRuntime,
    manager,
    managerSigningPrivateKey: managerSigning.privateKey,
    resolveCurrentManagerAuthority: (
      context: CurrentAgentRuntimeSignerPublicationManagerContextV1,
    ) => {
      observedContext = {
        ...context,
        signerPublicKey: context.signerPublicKey.slice(),
        transitionCommitment: context.transitionCommitment.slice(),
      };
      return managerSigning.publicKey;
    },
  };
  const publication = transitionKind === "initialization"
    ? createAgentRuntimeInitializationSignerPublicationV1({
      ...common,
      publicState: {
        agentId: sourceRuntime.agentId,
        authorizationRevision: authorization,
        runtimeGeneration: sourceRuntime.generation,
        configInventory: {
          objectCount: 1,
          digest: transitionCommitment,
        },
        domainEnvelopes: [],
      },
    })
    : createAgentRuntimeRotationSignerPublicationV1({
      ...common,
      authorizationRevision: authorization,
      validatedRotationManifestHash: transitionCommitment,
    });
  return {
    crypto,
    managerSigning,
    sourceRuntime,
    manager,
    operationId,
    authorization,
    transitionCommitment: publication.transitionCommitment.slice(),
    publication,
    observedContext,
  };
}

function clonePublication(
  publication: AgentRuntimeSignerPublicationV1,
): AgentRuntimeSignerPublicationV1 {
  return {
    ...publication,
    signerPublicKey: publication.signerPublicKey.slice(),
    transitionCommitment: publication.transitionCommitment.slice(),
    managerSigningPublicKeyHash:
      publication.managerSigningPublicKeyHash.slice(),
    signature: publication.signature.slice(),
  };
}

function recordZeroFills(): {
  readonly snapshots: Uint8Array[];
  readonly restore: () => void;
} {
  const snapshots: Uint8Array[] = [];
  const originalFill = Uint8Array.prototype.fill;
  Uint8Array.prototype.fill = function (
    ...args: Parameters<Uint8Array["fill"]>
  ): Uint8Array {
    if (args[0] === 0) snapshots.push(Uint8Array.from(this));
    return originalFill.apply(this, args);
  };
  return {
    snapshots,
    restore: () => {
      Uint8Array.prototype.fill = originalFill;
    },
  };
}

function includesSnapshot(
  snapshots: readonly Uint8Array[],
  expected: Uint8Array,
): boolean {
  return snapshots.some((snapshot) =>
    snapshot.length === expected.length
    && snapshot.every((byte, index) => byte === expected[index])
  );
}

describe("Agent Runtime signer publication v1", () => {
  test("strictly validates initialization public state and Domain inventory", () => {
    const crypto = new LatticeCrypto(seededRng(23_700));
    const domain = (
      domainIdValue: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      agentId: agentId("agent-genie"),
      domainId: cryptoDomainId(domainIdValue),
      domainEpoch: domainEpoch(2),
      agentAuthorizationRevision: authorizationRevision(12),
      runtimeGeneration: agentRuntimeGeneration(0),
      committerDeviceId: cryptoDeviceId("device-manager"),
      envelopeHash: bytes(0x31),
      ...overrides,
    });
    const state = (overrides: Record<string, unknown> = {}) => ({
      agentId: agentId("agent-genie"),
      authorizationRevision: authorizationRevision(12),
      runtimeGeneration: agentRuntimeGeneration(0),
      configInventory: {
        objectCount: 1,
        digest: bytes(0x20),
      },
      domainEnvelopes: [],
      ...overrides,
    });
    const commit = (value: unknown) =>
      agentRuntimeInitializationPublicStateCommitmentV1(
        crypto,
        value as never,
      );

    expect(commit(state())).toHaveLength(32);
    for (const value of [null, "state", [], 7]) {
      expect(() => commit(value)).toThrow(
        "Agent Runtime initialization public state must be an object",
      );
    }
    for (
      const value of [
        { ...state(), extra: true },
        (() => {
          const { domainEnvelopes: _, ...missing } = state();
          return missing;
        })(),
      ]
    ) {
      expect(() => commit(value)).toThrow(
        "Agent Runtime initialization public state has an invalid field set",
      );
    }
    expect(() => commit(state({
      runtimeGeneration: agentRuntimeGeneration(1),
    }))).toThrow(
      "Agent Runtime initialization public state must use generation zero",
    );

    for (const configInventory of [null, [], "inventory"]) {
      expect(() => commit(state({ configInventory }))).toThrow(
        "Agent Runtime initialization config inventory must be an object",
      );
    }
    for (
      const configInventory of [
        { objectCount: 1, digest: bytes(0x20), extra: true },
        { objectCount: 1 },
      ]
    ) {
      expect(() => commit(state({ configInventory }))).toThrow(
        "Agent Runtime initialization config inventory has an invalid field set",
      );
    }
    for (const objectCount of [Number.NaN, 0, 1.5, V2_LIMITS.batchItems + 1]) {
      expect(() => commit(state({
        configInventory: { objectCount, digest: bytes(0x20) },
      }))).toThrow(
        "Agent Runtime initialization config inventory count is invalid",
      );
    }
    expect(() => commit(state({
      configInventory: {
        objectCount: V2_LIMITS.batchItems,
        digest: bytes(0x20),
      },
    }))).not.toThrow();
    expect(() => commit(state({
      configInventory: { objectCount: 1, digest: bytes(0x20, 31) },
    }))).toThrow(
      "Agent Runtime initialization config inventory digest must be exactly 32 bytes",
    );

    for (const domainEnvelopes of [null, {}, "domains"]) {
      expect(() => commit(state({ domainEnvelopes }))).toThrow(
        "Agent Runtime initialization Domain envelope inventory must be an array",
      );
    }
    expect(() => commit(state({
      domainEnvelopes: new Array(
        V2_LIMITS.agentGrantDomains + 1,
      ).fill(null),
    }))).toThrow(
      "Agent Runtime initialization Domain envelope inventory is too large",
    );
    expect(() => commit(state({
      domainEnvelopes: new Array(
        V2_LIMITS.agentGrantDomains,
      ).fill(null),
    }))).toThrow(
      "Agent Runtime initialization Domain envelope must be an object",
    );

    expect(() => commit(state({
      domainEnvelopes: [domain("domain-a", { extra: true })],
    }))).toThrow(
      "Agent Runtime initialization Domain envelope has an invalid field set",
    );
    expect(() => commit(state({
      domainEnvelopes: [domain("domain-a", {
        agentId: agentId("agent-other"),
      })],
    }))).toThrow("Domain envelope coordinates are inconsistent");
    expect(() => commit(state({
      domainEnvelopes: [domain("domain-a", {
        runtimeGeneration: agentRuntimeGeneration(1),
      })],
    }))).toThrow("Domain envelope coordinates are inconsistent");
    expect(() => commit(state({
      domainEnvelopes: [domain("domain-b"), domain("domain-a")],
    }))).toThrow("Domain envelopes must be canonically ordered and unique");
    expect(() => commit(state({
      domainEnvelopes: [domain("domain-a"), domain("domain-a")],
    }))).toThrow("Domain envelopes must be canonically ordered and unique");
    expect(() => commit(state({
      domainEnvelopes: [domain("b"), domain("aa")],
    }))).toThrow("Domain envelopes must be canonically ordered and unique");
    expect(() => commit(state({
      domainEnvelopes: [domain("domain-a", {
        envelopeHash: bytes(0x31, 31),
      })],
    }))).toThrow(
      "Agent Runtime initialization Domain envelope hash must be exactly 32 bytes",
    );
    expect(commit(state({
      domainEnvelopes: [domain("domain-a"), domain("domain-b")],
    }))).toHaveLength(32);
  });

  test("creates a deterministic manager-authenticated initialization publication without requiring a Domain", () => {
    const state = fixture();
    const encoded = encodeAgentRuntimeSignerPublicationV1(
      state.publication,
    );
    const decoded = decodeAgentRuntimeSignerPublicationV1(encoded);

    expect(AGENT_RUNTIME_SIGNER_PUBLICATION_DOMAIN_V1).toBe(
      "nautilo/lattice-crypto/agent-runtime-signer-publication/v1",
    );
    expect(decoded).toEqual(state.publication);
    expect(encodeAgentRuntimeSignerPublicationV1(decoded)).toEqual(encoded);
    expect(state.observedContext).toEqual({
      purpose: "agent-runtime-signer-publication",
      transitionKind: "initialization",
      operationId: "operation-runtime-init",
      agentId: agentId("agent-genie"),
      authorizationRevision: authorizationRevision(12),
      runtimeGeneration: agentRuntimeGeneration(0),
      signerKeyId: state.publication.signerKeyId,
      signerPublicKey: state.publication.signerPublicKey,
      transitionCommitment: state.publication.transitionCommitment,
      managerHumanId: humanId("human-manager"),
      managerAuthorizationRevision: authorizationRevision(8),
      managerDeviceId: cryptoDeviceId("device-manager"),
    });
    expect(verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto: state.crypto,
      publication: decoded,
      resolveHistoricalManagerAuthority: (context) => {
        expect(context).toEqual({
          purpose: "verify-historical-agent-runtime-signer-publication",
          formatVersion: state.publication.formatVersion,
          transitionKind: state.publication.transitionKind,
          operationId: state.publication.operationId,
          agentId: state.publication.agentId,
          authorizationRevision: state.publication.authorizationRevision,
          runtimeGeneration: state.publication.runtimeGeneration,
          signerKeyId: state.publication.signerKeyId,
          signerPublicKey: state.publication.signerPublicKey,
          transitionCommitment: state.publication.transitionCommitment,
          managerHumanId: state.publication.managerHumanId,
          managerAuthorizationRevision:
            state.publication.managerAuthorizationRevision,
          managerDeviceId: state.publication.managerDeviceId,
          managerSigningPublicKeyHash:
            state.publication.managerSigningPublicKeyHash,
        });
        return state.managerSigning.publicKey;
      },
    })).toBe(true);
    expect(agentRuntimeSignerPublicationMatchesRuntimeV1(
      state.crypto,
      state.sourceRuntime,
      decoded,
    )).toBe(true);

    expect(hex(encoded)).toBe(
      "0000003a6e617574696c6f2f6c6174746963652d63727970746f2f6167656e742d72756e74696d652d7369676e65722d7075626c69636174696f6e2f76310000000100000000000000166f7065726174696f6e2d72756e74696d652d696e69740000000b6167656e742d67656e6965000000000000000c0000000000000000000000556167656e745f72756e74696d655f7369676e65725f61313064633033363565373939666165326531633833363233633037353962373132356537346234653639646163353066313664613938643366343034373739000000208a54666a25c92f20f590da5984f0165a26e6cff2c86af5e7482bfcecb8741bb500000020c3fdb7032e0e9aed0e1a3dd5bbc7a29656d2ef41ea9da46832b1fb62ab2627ad0000000d68756d616e2d6d616e6167657200000000000000080000000e6465766963652d6d616e6167657200000020fc1876b4d5ae1d5f10fae1967348a1527bc166034ed3558afa637b8fb8abf16600000040cad8b4951aaa87cc3a556fa8c2b21955c3c98fd52a24df4687cbc1f6501640d0be0e5a5c5e2c279edd03f04ee34d801ea5a2a12a6c93acabcbae6f42e282e409",
    );
  });

  test("binds every signer, transition, and manager-authority coordinate", () => {
    const state = fixture();
    const substitutions: AgentRuntimeSignerPublicationV1[] = [
      { ...clonePublication(state.publication), operationId: "operation-other" },
      {
        ...clonePublication(state.publication),
        agentId: agentId("agent-other"),
      },
      {
        ...clonePublication(state.publication),
        authorizationRevision: authorizationRevision(13),
      },
      {
        ...clonePublication(state.publication),
        signerKeyId: `agent_runtime_signer_${"0".repeat(64)}`,
      },
      {
        ...clonePublication(state.publication),
        signerPublicKey: bytes(0x71),
      },
      {
        ...clonePublication(state.publication),
        transitionCommitment: bytes(0x72),
      },
      {
        ...clonePublication(state.publication),
        managerHumanId: humanId("human-other"),
      },
      {
        ...clonePublication(state.publication),
        managerAuthorizationRevision: authorizationRevision(9),
      },
      {
        ...clonePublication(state.publication),
        managerDeviceId: cryptoDeviceId("device-other"),
      },
      {
        ...clonePublication(state.publication),
        managerSigningPublicKeyHash: bytes(0x73),
      },
      {
        ...clonePublication(state.publication),
        signature: bytes(0x74, 64),
      },
    ];

    for (const publication of substitutions) {
      expect(verifyHistoricalAgentRuntimeSignerPublicationV1({
        crypto: state.crypto,
        publication,
        resolveHistoricalManagerAuthority: () =>
          state.managerSigning.publicKey,
      })).toBe(false);
    }
  });

  test("strictly validates historical verification and rejects mismatched authority before signature work", () => {
    const state = fixture();
    const verify = (input: unknown) =>
      verifyHistoricalAgentRuntimeSignerPublicationV1(input as never);

    expect(() => verify(null)).toThrow(
      "Historical Agent Runtime signer verification input must be an object",
    );
    expect(() => verify({
      crypto: state.crypto,
      publication: state.publication,
      resolveHistoricalManagerAuthority: () => state.managerSigning.publicKey,
      extra: true,
    })).toThrow(
      "Historical Agent Runtime signer verification input has an invalid field set",
    );
    expect(() => verify({
      crypto: state.crypto,
      publication: state.publication,
      resolveHistoricalManagerAuthority: null,
    })).toThrow(
      "Historical Agent Runtime signer manager resolver is required",
    );

    let resolverCalls = 0;
    expect(verify({
      crypto: state.crypto,
      publication: {
        ...clonePublication(state.publication),
        signerKeyId: `agent_runtime_signer_${"0".repeat(64)}`,
      },
      resolveHistoricalManagerAuthority: () => {
        resolverCalls += 1;
        return state.managerSigning.publicKey;
      },
    })).toBe(false);
    expect(resolverCalls).toBe(0);

    expect(() => verify({
      crypto: state.crypto,
      publication: state.publication,
      resolveHistoricalManagerAuthority: () => bytes(0x61, 31),
    })).toThrow(
      "Historical Agent Runtime signer publication manager public key must be exactly 32 bytes",
    );

    const originalHash = state.crypto.hash.bind(state.crypto);
    let hashCalls = 0;
    state.crypto.hash = (value) => {
      hashCalls += 1;
      return hashCalls === 1 ? originalHash(value) : bytes(0x62, 31);
    };
    try {
      expect(() => verify({
        crypto: state.crypto,
        publication: state.publication,
        resolveHistoricalManagerAuthority: () => state.managerSigning.publicKey,
      })).toThrow(
        "Historical Agent Runtime signer publication manager public key hash must be exactly 32 bytes",
      );
    } finally {
      state.crypto.hash = originalHash;
    }

    const originalVerify = state.crypto.verify.bind(state.crypto);
    state.crypto.verify = () => {
      throw new Error("signature verification must not run");
    };
    try {
      expect(verify({
        crypto: state.crypto,
        publication: state.publication,
        resolveHistoricalManagerAuthority: () => bytes(0x63),
      })).toBe(false);
    } finally {
      state.crypto.verify = originalVerify;
    }
  });

  test("retains historical generation authority across Runtime rotation", () => {
    const initial = fixture("initialization", 0);
    const rotated = fixture("rotation", 1);

    expect(verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto: initial.crypto,
      publication: initial.publication,
      resolveHistoricalManagerAuthority: () =>
        initial.managerSigning.publicKey,
    })).toBe(true);
    expect(verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto: rotated.crypto,
      publication: rotated.publication,
      resolveHistoricalManagerAuthority: () =>
        rotated.managerSigning.publicKey,
    })).toBe(true);
    expect(agentRuntimeSignerPublicationMatchesRuntimeV1(
      initial.crypto,
      initial.sourceRuntime,
      rotated.publication,
    )).toBe(false);
    expect(agentRuntimeSignerPublicationMatchesRuntimeV1(
      rotated.crypto,
      rotated.sourceRuntime,
      rotated.publication,
    )).toBe(true);
    expect(verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto: initial.crypto,
      publication: initial.publication,
      resolveHistoricalManagerAuthority: () =>
        rotated.managerSigning.publicKey,
    })).toBe(false);
    expect(verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto: initial.crypto,
      publication: initial.publication,
      resolveHistoricalManagerAuthority: () => null,
    })).toBe(false);
  });

  test("matches initialization publications only to the exact committed public state and wipes working copies", () => {
    const state = fixture();
    const publicState = {
      agentId: state.sourceRuntime.agentId,
      authorizationRevision: state.authorization,
      runtimeGeneration: state.sourceRuntime.generation,
      configInventory: {
        objectCount: 1,
        digest: bytes(0x20),
      },
      domainEnvelopes: [],
    };
    const matches = (
      publication: AgentRuntimeSignerPublicationV1,
      candidate = publicState,
    ) => agentRuntimeInitializationSignerPublicationMatchesStateV1(
      state.crypto,
      publication,
      candidate,
    );

    expect(matches(state.publication)).toBe(true);

    const otherAgentState = {
      ...publicState,
      agentId: agentId("agent-other"),
    };
    const otherAgentCommitment =
      agentRuntimeInitializationPublicStateCommitmentV1(
        state.crypto,
        otherAgentState,
      );
    expect(matches({
      ...clonePublication(state.publication),
      transitionCommitment: otherAgentCommitment,
    }, otherAgentState)).toBe(false);

    const otherRevisionState = {
      ...publicState,
      authorizationRevision: authorizationRevision(13),
    };
    const otherRevisionCommitment =
      agentRuntimeInitializationPublicStateCommitmentV1(
        state.crypto,
        otherRevisionState,
      );
    expect(matches({
      ...clonePublication(state.publication),
      transitionCommitment: otherRevisionCommitment,
    }, otherRevisionState)).toBe(false);
    expect(matches({
      ...clonePublication(state.publication),
      transitionCommitment: bytes(0x7a),
    })).toBe(false);

    const fills = recordZeroFills();
    try {
      expect(matches(state.publication)).toBe(true);
    } finally {
      fills.restore();
    }
    for (const ownedBytes of [
      state.publication.signerPublicKey,
      state.publication.transitionCommitment,
      state.publication.managerSigningPublicKeyHash,
      state.publication.signature,
    ]) {
      expect(includesSnapshot(fills.snapshots, ownedBytes)).toBe(true);
    }
  });

  test("matches rotation publications only to every manifest coordinate and wipes working copies", () => {
    const state = fixture("rotation", 1);
    const input = {
      operationId: state.operationId,
      agentId: state.sourceRuntime.agentId,
      authorizationRevision: state.authorization,
      runtimeGeneration: state.sourceRuntime.generation,
      validatedRotationManifestHash: state.transitionCommitment,
    };
    const matches = (
      publication: AgentRuntimeSignerPublicationV1,
      candidate: Readonly<{
        operationId: string;
        agentId: ReturnType<typeof agentId>;
        authorizationRevision: ReturnType<typeof authorizationRevision>;
        runtimeGeneration: ReturnType<typeof agentRuntimeGeneration>;
        validatedRotationManifestHash: Uint8Array;
      }> = input,
    ) => agentRuntimeRotationSignerPublicationMatchesManifestV1(
      publication,
      candidate,
    );

    expect(matches(state.publication)).toBe(true);
    expect(matches(state.publication, {
      ...input,
      operationId: "operation-other",
    })).toBe(false);
    expect(matches(state.publication, {
      ...input,
      agentId: agentId("agent-other"),
    })).toBe(false);
    expect(matches(state.publication, {
      ...input,
      authorizationRevision: authorizationRevision(14),
    })).toBe(false);
    expect(matches(state.publication, {
      ...input,
      runtimeGeneration: agentRuntimeGeneration(2),
    })).toBe(false);
    expect(matches(state.publication, {
      ...input,
      validatedRotationManifestHash: bytes(0x7b),
    })).toBe(false);

    const initial = fixture();
    expect(agentRuntimeRotationSignerPublicationMatchesManifestV1(
      initial.publication,
      {
        operationId: initial.operationId,
        agentId: initial.sourceRuntime.agentId,
        authorizationRevision: initial.authorization,
        runtimeGeneration: initial.sourceRuntime.generation,
        validatedRotationManifestHash: initial.transitionCommitment,
      },
    )).toBe(false);
    expect(() => matches(state.publication, {
      ...input,
      validatedRotationManifestHash: bytes(0x7c, 31),
    })).toThrow(
      "Agent Runtime rotation manifest hash must be exactly 32 bytes",
    );

    const fills = recordZeroFills();
    try {
      expect(matches(state.publication)).toBe(true);
    } finally {
      fills.restore();
    }
    for (const ownedBytes of [
      state.publication.signerPublicKey,
      state.publication.transitionCommitment,
      state.publication.managerSigningPublicKeyHash,
      state.publication.signature,
    ]) {
      expect(includesSnapshot(fills.snapshots, ownedBytes)).toBe(true);
    }
  });

  test("matches Runtime signer identity on every coordinate, wipes copies, and preserves derivation failures", () => {
    const state = fixture("rotation", 1);
    const matches = (
      runtimeValue: AgentRuntimeGenerationV2,
      publication = state.publication,
    ) => agentRuntimeSignerPublicationMatchesRuntimeV1(
      state.crypto,
      runtimeValue,
      publication,
    );

    expect(matches(state.sourceRuntime)).toBe(true);
    expect(matches(state.sourceRuntime, {
      ...clonePublication(state.publication),
      agentId: agentId("agent-other"),
    })).toBe(false);
    expect(matches(state.sourceRuntime, {
      ...clonePublication(state.publication),
      runtimeGeneration: agentRuntimeGeneration(2),
    })).toBe(false);
    expect(matches(state.sourceRuntime, {
      ...clonePublication(state.publication),
      signerKeyId: `agent_runtime_signer_${"0".repeat(64)}`,
    })).toBe(false);
    expect(matches(state.sourceRuntime, {
      ...clonePublication(state.publication),
      signerPublicKey: bytes(0x64),
    })).toBe(false);

    const fills = recordZeroFills();
    try {
      expect(matches(state.sourceRuntime)).toBe(true);
    } finally {
      fills.restore();
    }
    for (const ownedBytes of [
      state.publication.signerPublicKey,
      state.publication.transitionCommitment,
      state.publication.managerSigningPublicKeyHash,
      state.publication.signature,
    ]) {
      expect(includesSnapshot(fills.snapshots, ownedBytes)).toBe(true);
    }

    const originalHash = state.crypto.hash.bind(state.crypto);
    state.crypto.hash = () => {
      throw new Error("runtime signer derivation unavailable");
    };
    try {
      expect(() => matches(state.sourceRuntime)).toThrow(
        "runtime signer derivation unavailable",
      );
    } finally {
      state.crypto.hash = originalHash;
    }
  });

  test("wipes resolver-owned public contexts without mutating caller records", () => {
    const state = fixture();
    const caller = clonePublication(state.publication);
    const callerSnapshot = clonePublication(caller);
    let observedSignerPublicKey: Uint8Array | undefined;
    let observedCommitment: Uint8Array | undefined;
    let observedManagerHash: Uint8Array | undefined;

    expect(verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto: state.crypto,
      publication: caller,
      resolveHistoricalManagerAuthority: (context) => {
        observedSignerPublicKey = context.signerPublicKey;
        observedCommitment = context.transitionCommitment;
        observedManagerHash = context.managerSigningPublicKeyHash;
        return state.managerSigning.publicKey;
      },
    })).toBe(true);
    expect(caller).toEqual(callerSnapshot);
    expect(observedSignerPublicKey).toEqual(new Uint8Array(32));
    expect(observedCommitment).toEqual(new Uint8Array(32));
    expect(observedManagerHash).toEqual(new Uint8Array(32));

    expect(() =>
      verifyHistoricalAgentRuntimeSignerPublicationV1({
        crypto: state.crypto,
        publication: caller,
        resolveHistoricalManagerAuthority: () => {
          throw new Error("historical authority storage unavailable");
        },
      })
    ).toThrow("historical authority storage unavailable");
    expect(caller).toEqual(callerSnapshot);
  });

  test("rejects malformed and noncanonical publications before use", () => {
    const state = fixture();
    const encoded = encodeAgentRuntimeSignerPublicationV1(
      state.publication,
    );
    const encodedSnapshot = encoded.slice();
    const { signature: _signature, ...unsignedPublication } = state.publication;

    expect(agentRuntimeSignerPublicationSigningBytesV1(unsignedPublication))
      .toEqual(encoded.subarray(0, encoded.length - 68));

    expect(() =>
      encodeAgentRuntimeSignerPublicationV1({
        ...clonePublication(state.publication),
        extra: true,
      } as never)
    ).toThrow("invalid field set");
    const { operationId: _, ...publicationWithoutOperation } =
      clonePublication(state.publication);
    expect(() => encodeAgentRuntimeSignerPublicationV1({
      ...publicationWithoutOperation,
      unknownOperation: state.publication.operationId,
    } as never))
      .toThrow("invalid field set");
    expect(() =>
      encodeAgentRuntimeSignerPublicationV1({
        ...clonePublication(state.publication),
        signerPublicKey: bytes(0x11, 31),
      })
    ).toThrow("signer public key must be exactly 32 bytes");
    expect(() =>
      encodeAgentRuntimeSignerPublicationV1({
        ...clonePublication(state.publication),
        transitionKind: "rotation",
      })
    ).toThrow("transition does not match its Runtime generation");
    const rotated = fixture("rotation", 1);
    expect(() =>
      encodeAgentRuntimeSignerPublicationV1({
        ...clonePublication(rotated.publication),
        transitionKind: "initialization",
      })
    ).toThrow("transition does not match its Runtime generation");
    expect(() =>
      decodeAgentRuntimeSignerPublicationV1(
        new Uint8Array([...encoded, 0]),
      )
    ).toThrow("trailing bytes");
    expect(() =>
      decodeAgentRuntimeSignerPublicationV1(encoded.subarray(0, encoded.length - 1))
    ).toThrow();
    const invalidTransitionCode = encoded.slice();
    const transitionOffset = frameText(
      AGENT_RUNTIME_SIGNER_PUBLICATION_DOMAIN_V1,
    ).length + 4;
    invalidTransitionCode.set([0, 0, 0, 2], transitionOffset);
    expect(() => decodeAgentRuntimeSignerPublicationV1(invalidTransitionCode))
      .toThrow("transition kind is unsupported");
    expect(() => decodeAgentRuntimeSignerPublicationV1("encoded" as never))
      .toThrow(
        "Agent Runtime signer publication bytes must be Uint8Array",
      );
    expect(() =>
      decodeAgentRuntimeSignerPublicationV1(
        new Uint8Array(MAX_AGENT_RUNTIME_SIGNER_PUBLICATION_WIRE_BYTES_V1),
      )
    ).toThrow("domain mismatch");
    expect(() =>
      decodeAgentRuntimeSignerPublicationV1(
        new Uint8Array(
          MAX_AGENT_RUNTIME_SIGNER_PUBLICATION_WIRE_BYTES_V1 + 1,
        ),
      )
    ).toThrow("exceeds its wire limit");
    const wrongDomain = encoded.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(() =>
      decodeAgentRuntimeSignerPublicationV1(wrongDomain)
    ).toThrow("domain mismatch");

    const fills = recordZeroFills();
    try {
      expect(decodeAgentRuntimeSignerPublicationV1(encoded))
        .toEqual(state.publication);
    } finally {
      fills.restore();
    }
    expect(includesSnapshot(fills.snapshots, encoded)).toBe(true);
    for (const extractedFrame of [
      state.publication.signerPublicKey,
      state.publication.transitionCommitment,
      state.publication.managerSigningPublicKeyHash,
      state.publication.signature,
    ]) {
      expect(includesSnapshot(fills.snapshots, extractedFrame)).toBe(true);
    }
    expect(encoded).toEqual(encodedSnapshot);
  });

  test("requires the exact current manager key and wipes owned secret copies on success and failure", () => {
    const crypto = new LatticeCrypto(seededRng(23_799));
    const managerSigning = crypto.generateSigningKeyPair();
    const otherSigning = crypto.generateSigningKeyPair();
    const managerPrivateSnapshot = managerSigning.privateKey.slice();
    const transitionCommitment = bytes(0x20);
    const transitionCommitmentSnapshot = transitionCommitment.slice();
    const originalSign = crypto.sign.bind(crypto);
    let observedPrivate: Uint8Array | undefined;
    let observedContextSigner: Uint8Array | undefined;
    let observedContextCommitment: Uint8Array | undefined;
    crypto.sign = (privateKey, message) => {
      observedPrivate = privateKey;
      return originalSign(privateKey, message);
    };
    const base = {
      crypto,
      operationId: "operation-runtime-init",
      runtime: runtime(),
      publicState: {
        agentId: agentId("agent-genie"),
        authorizationRevision: authorizationRevision(12),
        runtimeGeneration: agentRuntimeGeneration(0),
        configInventory: {
          objectCount: 1,
          digest: transitionCommitment,
        },
        domainEnvelopes: [],
      },
      manager: {
        managerHumanId: humanId("human-manager"),
        managerAuthorizationRevision: authorizationRevision(8),
        managerDeviceId: cryptoDeviceId("device-manager"),
      },
      managerSigningPrivateKey: managerSigning.privateKey,
    };

    createAgentRuntimeInitializationSignerPublicationV1({
      ...base,
      resolveCurrentManagerAuthority: (context) => {
        observedContextSigner = context.signerPublicKey;
        observedContextCommitment = context.transitionCommitment;
        return managerSigning.publicKey;
      },
    });
    expect(managerSigning.privateKey).toEqual(managerPrivateSnapshot);
    expect(transitionCommitment).toEqual(transitionCommitmentSnapshot);
    expect(observedPrivate).toBeDefined();
    expect(observedPrivate).toEqual(new Uint8Array(32));
    expect(observedContextSigner).toEqual(new Uint8Array(32));
    expect(observedContextCommitment).toEqual(new Uint8Array(32));

    expect(() =>
      createAgentRuntimeInitializationSignerPublicationV1({
        ...base,
        resolveCurrentManagerAuthority: () => null,
      })
    ).toThrow("manager is not currently authorized");
    expect(() =>
      createAgentRuntimeInitializationSignerPublicationV1({
        ...base,
        resolveCurrentManagerAuthority: () => otherSigning.publicKey,
      })
    ).toThrow("private key does not match current authority");

    let failedPrivate: Uint8Array | undefined;
    crypto.sign = (privateKey) => {
      failedPrivate = privateKey;
      throw new Error("provider failure");
    };
    expect(() =>
      createAgentRuntimeInitializationSignerPublicationV1({
        ...base,
        resolveCurrentManagerAuthority: () => managerSigning.publicKey,
      })
    ).toThrow("provider failure");
    expect(failedPrivate).toEqual(new Uint8Array(32));
    expect(managerSigning.privateKey).toEqual(managerPrivateSnapshot);

    const originalHash = crypto.hash.bind(crypto);
    let hashCalls = 0;
    crypto.hash = (value) => {
      hashCalls += 1;
      if (hashCalls === 1) return originalHash(value);
      throw new Error("signer hashing unavailable");
    };
    try {
      expect(() =>
        createAgentRuntimeInitializationSignerPublicationV1({
          ...base,
          resolveCurrentManagerAuthority: () => managerSigning.publicKey,
        })
      ).toThrow("signer hashing unavailable");
    } finally {
      crypto.hash = originalHash;
    }
  });
});
