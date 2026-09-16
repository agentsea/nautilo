import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  manualClock,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN,
  agentRuntimeManagerHandoffRuntimeCommitmentV1,
  assertPreparedAgentRuntimeManagerHandoffTarget,
  prepareAgentRuntimeManagerHandoffChallenge,
  prepareAgentRuntimeManagerHandoffResponse,
  prepareAgentRuntimeManagerHandoffTarget,
  type AgentRuntimeManagerHandoffPlanV1,
  verifyPreparedAgentRuntimeManagerHandoffTarget,
} from "../../src/agent-runtime/runtime-handoff-v2.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
} from "../../src/format/v2-primitives.ts";
import {
  aggregateAgentRuntimeRotationV2,
  AGENT_RUNTIME_ROTATION_MANAGER_SOURCE_PROOF_V2,
  agentRuntimeConfigInventoryCommitmentV2,
  agentRuntimeConfigDekAadV2,
  assertAgentRuntimeRotationSourceLocalV2,
  destroyAgentRuntimeRotationSourceLocalV2,
  prepareAgentRuntimeRotationSourceV2,
  type AgentRuntimeAuthorizationPlanV2,
  type AgentRuntimeConfigObjectV2,
  type ResolveCurrentAgentRuntimeManagerAuthorityV2,
} from "../../src/agent-runtime/runtime-rotation-v2.ts";
import {
  openAgentRuntimeFromDomain,
} from "../../src/agent-runtime/domain-envelope.ts";
import {
  parseAgentRuntimeDomainEnvelope,
  serializeAgentRuntimeDomainEnvelope,
} from "../../src/format/agent-runtime-v2.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  objectId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function bytes(fill: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

class CaptureCrypto extends LatticeCrypto {
  randomCalls = 0;
  randomOutputs: Uint8Array[] = [];
  bufferNextRandom = false;
  hashCalls = 0;
  hashInputs: Uint8Array[] = [];
  hashOutputs: Uint8Array[] = [];
  reuseHashOutput = false;
  private readonly sharedHashOutput = new Uint8Array(32);
  signOutputs: Uint8Array[] = [];
  verifyCalls = 0;
  openedPlaintexts: Uint8Array[] = [];
  openedKeys: Uint8Array[] = [];
  hpkePlaintexts: Uint8Array[] = [];
  hpkeOpenedPlaintexts: Uint8Array[] = [];
  hpkeOpeningKeys: Uint8Array[] = [];
  sealingKeys: Uint8Array[] = [];
  sealedOutputs: Uint8Array[] = [];
  signingKeys: Uint8Array[] = [];
  signingMessages: Uint8Array[] = [];
  failNextSealTo = false;
  failNextAeadSeal = false;
  shortNextRandom = false;
  shortNextOpen = false;
  hpkeSealResultLength: number | null = null;
  hpkePlaintextTransform:
    ((plaintext: Uint8Array) => Uint8Array) | null = null;

  override randomBytes(length: number): Uint8Array {
    this.randomCalls += 1;
    const output = super.randomBytes(length);
    if (this.shortNextRandom) {
      this.shortNextRandom = false;
      return output.subarray(0, length - 1);
    }
    const published = this.bufferNextRandom
      ? Buffer.from(output)
      : output;
    this.bufferNextRandom = false;
    this.randomOutputs.push(published);
    return published;
  }

  override hash(bytes: Uint8Array): Uint8Array {
    this.hashCalls += 1;
    this.hashInputs.push(bytes);
    const digest = super.hash(bytes);
    const output = this.reuseHashOutput
      ? (this.sharedHashOutput.set(digest), this.sharedHashOutput)
      : digest;
    this.hashOutputs.push(output);
    return output;
  }

  override verify(
    signingPublicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): boolean {
    this.verifyCalls += 1;
    return super.verify(signingPublicKey, message, signature);
  }

  override aeadOpen(
    key: Uint8Array,
    blob: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array | null {
    this.openedKeys.push(key);
    const opened = super.aeadOpen(key, blob, aad);
    if (opened !== null) this.openedPlaintexts.push(opened);
    if (opened !== null && this.shortNextOpen) {
      this.shortNextOpen = false;
      return opened.subarray(0, opened.length - 1);
    }
    return opened;
  }

  override aeadSeal(
    key: Uint8Array,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array {
    this.sealingKeys.push(key);
    if (this.failNextAeadSeal) {
      this.failNextAeadSeal = false;
      throw new Error("injected aead seal failure");
    }
    const output = super.aeadSeal(key, plaintext, aad);
    this.sealedOutputs.push(output);
    return output;
  }

  override sign(
    signingPrivateKey: Uint8Array,
    message: Uint8Array,
  ): Uint8Array {
    this.signingKeys.push(signingPrivateKey);
    this.signingMessages.push(message.slice());
    const output = super.sign(signingPrivateKey, message);
    this.signOutputs.push(output);
    return output;
  }

  override async sealTo(
    publicKey: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    this.hpkePlaintexts.push(plaintext);
    if (this.failNextSealTo) {
      this.failNextSealTo = false;
      throw new Error("injected HPKE seal failure");
    }
    if (this.hpkeSealResultLength !== null) {
      return bytes(0x71, this.hpkeSealResultLength);
    }
    return super.sealTo(publicKey, plaintext);
  }

  override async openSealed(
    privateKey: Uint8Array,
    blob: Uint8Array,
  ): Promise<Uint8Array | null> {
    this.hpkeOpeningKeys.push(privateKey);
    const raw = await super.openSealed(privateKey, blob);
    const opened = raw === null || this.hpkePlaintextTransform === null
      ? raw
      : this.hpkePlaintextTransform(raw);
    if (opened !== null) this.hpkeOpenedPlaintexts.push(opened);
    return opened;
  }
}

class ShortHashCrypto extends LatticeCrypto {
  hashCalls = 0;

  override hash(value: Uint8Array): Uint8Array {
    this.hashCalls += 1;
    const digest = super.hash(value);
    return this.hashCalls === 3 ? digest.subarray(0, 31) : digest;
  }
}

class ReusingHashCrypto extends LatticeCrypto {
  private readonly shared = new Uint8Array(32);

  override hash(value: Uint8Array): Uint8Array {
    this.shared.set(super.hash(value));
    return this.shared;
  }
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to throw");
}

async function rejectedMessage(
  run: () => Promise<unknown>,
): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject");
}

const managerTextEncoder = new TextEncoder();

function managerFrameSize(text: string): number {
  return 4 + managerTextEncoder.encode(text).length;
}

function managerDomainContextWireSize(
  context: AgentRuntimeManagerHandoffPlanV1["target"],
): number {
  return managerFrameSize(context.domainId) + 8 + 8
    + managerFrameSize(context.committerDeviceId);
}

function managerPlanWireSize(
  plan: AgentRuntimeManagerHandoffPlanV1,
): number {
  return managerFrameSize(plan.operationId)
    + managerFrameSize(plan.agentId)
    + 8 + 4 + 32 + 4 + 32
    + managerFrameSize(plan.source.managerHumanId)
    + 8
    + managerFrameSize(plan.source.managerDeviceId)
    + managerDomainContextWireSize(plan.target);
}

function managerMessagePrefixSize(kind: string): number {
  return managerFrameSize(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN)
    + managerFrameSize(kind) + 4;
}

function shortenManagerFrameAt(
  bytes: Uint8Array,
  offset: number,
): Uint8Array {
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, false);
  return concatV2(
    bytes.slice(0, offset),
    encodeU32(length - 1),
    bytes.slice(offset + 4, offset + 4 + length - 1),
    bytes.slice(offset + 4 + length),
  );
}

function corruptManagerTextAt(
  bytes: Uint8Array,
  frameOffset: number,
): Uint8Array {
  const copy = bytes.slice();
  copy[frameOffset + 4] = copy[frameOffset + 4]! ^ 1;
  return copy;
}

function corruptLastManagerBytes(
  value: Uint8Array,
  needle: Uint8Array,
  byteIndex = 0,
  replacement?: number,
): Uint8Array {
  const copy = value.slice();
  for (
    let offset = copy.length - needle.length;
    offset >= 0;
    offset -= 1
  ) {
    if (needle.every((byte, index) => copy[offset + index] === byte)) {
      copy[offset + byteIndex] = replacement
        ?? (copy[offset + byteIndex]! ^ 1);
      return copy;
    }
  }
  throw new Error("Manager handoff test needle was not found");
}

function setup() {
  const clock = manualClock(10_000);
  const crypto = new CaptureCrypto(seededRng(0x2258), clock);
  const managerSigning = crypto.generateSigningKeyPair();
  const targetSigningA = crypto.generateSigningKeyPair();
  const targetSigningZ = crypto.generateSigningKeyPair();
  const currentRuntime = Object.freeze({
    agentId: agentId("agent-genie"),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(7),
    key: bytes(0x44),
  });
  const planBase = {
    operationId: "operation-runtime-rotate-1",
    agentId: currentRuntime.agentId,
    oldAuthorizationRevision: authorizationRevision(20),
    newAuthorizationRevision: authorizationRevision(21),
    currentRuntimeGeneration: currentRuntime.generation,
    runtimeRotationRequired: true,
    currentManager: {
      managerHumanId: humanId("human-manager"),
      managerAuthorizationRevision: authorizationRevision(9),
      managerDeviceId: cryptoDeviceId("device-manager"),
    },
    remainingDomains: [
      {
        domainId: cryptoDomainId("domain-a"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(12),
        committerDeviceId: cryptoDeviceId("device-a"),
      },
      {
        domainId: cryptoDomainId("domain-z"),
        domainEpoch: domainEpoch(6),
        agentAuthorizationRevision: authorizationRevision(14),
        committerDeviceId: cryptoDeviceId("device-z"),
      },
    ],
  };
  const makeObject = (
    id: string,
    revision: number,
    dekFill: number,
  ): AgentRuntimeConfigObjectV2 => {
    const metadata = {
      agentId: currentRuntime.agentId,
      objectId: objectId(id),
      configRevision: authorizationRevision(revision),
      runtimeGeneration: currentRuntime.generation,
    };
    return {
      ...metadata,
      wrappedDek: crypto.aeadSeal(
        currentRuntime.key,
        bytes(dekFill),
        agentRuntimeConfigDekAadV2(metadata),
      ),
    };
  };
  const activeConfigObjects = [
    makeObject("config-a", 2, 0xa1),
    makeObject("config-z", 5, 0xa2),
  ] as const;
  const plan: AgentRuntimeAuthorizationPlanV2 = {
    ...planBase,
    activeConfigInventory: agentRuntimeConfigInventoryCommitmentV2({
      crypto,
      agentId: currentRuntime.agentId,
      runtimeGeneration: currentRuntime.generation,
      activeConfigObjects,
    }),
  };
  const currentState = {
    agentId: plan.agentId,
    authorizationRevision: plan.oldAuthorizationRevision,
    runtimeGeneration: plan.currentRuntimeGeneration,
  };
  const managerAuthority = () => managerSigning.publicKey;
  const targetAuthority = ({ target }: { readonly target: {
    readonly committerDeviceId: string;
  } }) => target.committerDeviceId === "device-a"
    ? targetSigningA.publicKey
    : targetSigningZ.publicKey;
  return {
    clock,
    crypto,
    plan,
    currentState,
    currentRuntime,
    activeConfigObjects,
    managerSigning,
    targetSigningA,
    targetSigningZ,
    managerAuthority,
    targetAuthority,
  };
}

async function completeTarget(
  state: ReturnType<typeof setup>,
  source: Extract<
    ReturnType<typeof prepareAgentRuntimeRotationSourceV2>,
    { readonly kind: "rotated" }
  >,
  index: number,
) {
  const intent = source.publicCandidate.targetIntents[index]!;
  const signing = index === 0
    ? state.targetSigningA
    : state.targetSigningZ;
  const root = bytes(index === 0 ? 0x31 : 0x32);
  const ephemeral = await state.crypto.generateEncryptionKeyPair();
  const challenge = prepareAgentRuntimeManagerHandoffChallenge({
    crypto: state.crypto,
    plan: intent,
    targetEphemeralPublicKey: ephemeral.publicKey,
    targetCommitterSigningPrivateKey: signing.privateKey,
    resolveCurrentTargetCommitter: state.targetAuthority,
    ttlMs: 60_000,
  });
  const response = await prepareAgentRuntimeManagerHandoffResponse({
    crypto: state.crypto,
    challengeBytes: challenge.challengeBytes,
    expectedPlan: intent,
    freshRuntime: source.sourceLocal.runtime,
    managerSigningPrivateKey: state.managerSigning.privateKey,
    resolveCurrentManagerAuthority: state.managerAuthority,
    resolveCurrentTargetCommitter: state.targetAuthority,
  });
  const completion = await prepareAgentRuntimeManagerHandoffTarget({
    crypto: state.crypto,
    challengeBytes: challenge.challengeBytes,
    responseBytes: response,
    expectedPlan: intent,
    trustedChallengeState: {
      challengeHash: challenge.challengeHash,
      consumed: false,
    },
    targetEphemeralPrivateKey: ephemeral.privateKey,
    targetDomainRoot: root,
    targetCommitterSigningPrivateKey: signing.privateKey,
    resolveCurrentManagerAuthority: state.managerAuthority,
    resolveCurrentTargetCommitter: state.targetAuthority,
  });
  return { completion, root, signing };
}

async function managerHandoffFixture() {
  const state = setup();
  const source = prepareAgentRuntimeRotationSourceV2({
    crypto: state.crypto,
    currentState: state.currentState,
    currentRuntime: state.currentRuntime,
    plan: state.plan,
    activeConfigObjects: state.activeConfigObjects,
    resolveCurrentManagerAuthority: state.managerAuthority,
    managerSigningPrivateKey: state.managerSigning.privateKey,
  });
  if (source.kind !== "rotated") throw new Error("expected rotation");
  const plan = source.publicCandidate.targetIntents[0]!;
  const ephemeral = await state.crypto.generateEncryptionKeyPair();
  const challenge = prepareAgentRuntimeManagerHandoffChallenge({
    crypto: state.crypto,
    plan,
    targetEphemeralPublicKey: ephemeral.publicKey,
    targetCommitterSigningPrivateKey: state.targetSigningA.privateKey,
    resolveCurrentTargetCommitter: state.targetAuthority,
    ttlMs: 60_000,
  });
  const response = await prepareAgentRuntimeManagerHandoffResponse({
    crypto: state.crypto,
    challengeBytes: challenge.challengeBytes,
    expectedPlan: plan,
    freshRuntime: source.sourceLocal.runtime,
    managerSigningPrivateKey: state.managerSigning.privateKey,
    resolveCurrentManagerAuthority: state.managerAuthority,
    resolveCurrentTargetCommitter: state.targetAuthority,
  });
  const finalize = (overrides?: {
    readonly challengeBytes?: Uint8Array;
    readonly responseBytes?: Uint8Array;
  }) =>
    prepareAgentRuntimeManagerHandoffTarget({
      crypto: state.crypto,
      challengeBytes: overrides?.challengeBytes
        ?? challenge.challengeBytes,
      responseBytes: overrides?.responseBytes ?? response,
      expectedPlan: plan,
      trustedChallengeState: {
        challengeHash: challenge.challengeHash,
        consumed: false,
      },
      targetEphemeralPrivateKey: ephemeral.privateKey,
      targetDomainRoot: bytes(0x31),
      targetCommitterSigningPrivateKey:
        state.targetSigningA.privateKey,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    });
  return { state, source, plan, ephemeral, challenge, response, finalize };
}

describe("global Agent Runtime rotation source", () => {
  test("locks the manager-source proof domain separator", () => {
    expect(AGENT_RUNTIME_ROTATION_MANAGER_SOURCE_PROOF_V2).toBe(
      "nautilo/lattice-crypto/agent-runtime-rotation-manager-source/v1",
    );
  });

  test("creates one local generation and atomically rewraps every active config DEK", () => {
    const state = setup();
    const calls = state.crypto.randomCalls;
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    expect(source.kind).toBe("rotated");
    if (source.kind !== "rotated") throw new Error("expected rotation");
    expect(source.sourceLocal.runtime.generation).toBe(
      agentRuntimeGeneration(8),
    );
    expect(source.sourceLocal.runtime.key).not.toEqual(
      state.currentRuntime.key,
    );
    expect(source.publicCandidate.configRewraps).toHaveLength(2);
    expect(source.publicCandidate.targetIntents).toHaveLength(2);
    expect(state.crypto.randomCalls - calls).toBe(3);

    for (let index = 0; index < state.activeConfigObjects.length; index++) {
      const current = state.activeConfigObjects[index]!;
      const rewrap = source.publicCandidate.configRewraps[index]!;
      expect(rewrap.expected).toEqual({
        agentId: current.agentId,
        objectId: current.objectId,
        configRevision: current.configRevision,
        runtimeGeneration: current.runtimeGeneration,
        wrappedDekHash: state.crypto.hash(current.wrappedDek),
      });
      const opened = state.crypto.aeadOpen(
        source.sourceLocal.runtime.key,
        rewrap.nextWrappedDek.ciphertext,
        agentRuntimeConfigDekAadV2({
          agentId: current.agentId,
          objectId: current.objectId,
          configRevision: current.configRevision,
          runtimeGeneration: source.sourceLocal.runtime.generation,
        }),
      );
      expect(opened).toEqual(bytes(0xa1 + index));
      opened?.fill(0);
    }
    expect(state.crypto.openedPlaintexts.every((value) =>
      value.every((byte) => byte === 0)
    )).toBe(true);
  });

  test("validates public plan and every object before randomness", () => {
    const state = setup();
    const calls = state.crypto.randomCalls;
    const variants = [
      {
        ...state.plan,
        newAuthorizationRevision: state.plan.oldAuthorizationRevision,
      },
      {
        ...state.plan,
        currentRuntimeGeneration: agentRuntimeGeneration(6),
      },
      {
        ...state.plan,
        remainingDomains: [...state.plan.remainingDomains].reverse(),
      },
    ];
    for (const plan of variants) {
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: state.currentState,
          currentRuntime: state.currentRuntime,
          plan,
          activeConfigObjects: state.activeConfigObjects,
          resolveCurrentManagerAuthority: state.managerAuthority,
          managerSigningPrivateKey: state.managerSigning.privateKey,
        })
      ).toThrow();
    }
    expect(() =>
      prepareAgentRuntimeRotationSourceV2({
        crypto: state.crypto,
        currentState: state.currentState,
        currentRuntime: state.currentRuntime,
        plan: state.plan,
        activeConfigObjects: [
          state.activeConfigObjects[1],
          state.activeConfigObjects[0],
        ],
        resolveCurrentManagerAuthority: state.managerAuthority,
        managerSigningPrivateKey: state.managerSigning.privateKey,
      })
    ).toThrow("sorted");
    expect(state.crypto.randomCalls).toBe(calls);
  });

  test("validates the complete plan shape, inventory, manager, and Domain order exactly", () => {
    const expectPlanError = (
      state: ReturnType<typeof setup>,
      plan: AgentRuntimeAuthorizationPlanV2,
      message: string,
    ) => {
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: state.currentState,
          plan,
        })
      ).toThrow(message);
    };

    {
      const state = setup();
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: null as never,
          plan: state.plan,
        })
      ).toThrow("Current Agent Runtime state must be an object");
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: 42 as never,
          plan: state.plan,
        })
      ).toThrow("Current Agent Runtime state must be an object");
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: {
            ...state.currentState,
            unexpected: true,
          } as never,
          plan: state.plan,
        })
      ).toThrow("Current Agent Runtime state has an invalid field set");
      const missingStateField = {
        authorizationRevision: state.currentState.authorizationRevision,
        runtimeGeneration: state.currentState.runtimeGeneration,
      };
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: missingStateField as never,
          plan: state.plan,
        })
      ).toThrow("Current Agent Runtime state has an invalid field set");
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: {
            ...missingStateField,
            unexpected: true,
          } as never,
          plan: state.plan,
        })
      ).toThrow("Current Agent Runtime state has an invalid field set");
    }

    {
      const state = setup();
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: state.currentState,
          plan: null as never,
        })
      ).toThrow("Agent Runtime authorization plan must be an object");
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: state.currentState,
          plan: {
            ...state.plan,
            unexpected: true,
          } as never,
        })
      ).toThrow("Agent Runtime authorization plan has an invalid field set");
      expectPlanError(
        state,
        { ...state.plan, operationId: "" },
        "Agent Runtime rotation operation id",
      );
    }

    {
      const state = setup();
      expectPlanError(
        state,
        { ...state.plan, currentManager: 42 as never },
        "Current Agent Runtime manager result must be an object",
      );
      expectPlanError(
        state,
        {
          ...state.plan,
          currentManager: {
            ...state.plan.currentManager!,
            unexpected: true,
          } as never,
        },
        "Current Agent Runtime manager result has an invalid field set",
      );
    }

    {
      const state = setup();
      expectPlanError(
        state,
        { ...state.plan, activeConfigInventory: null as never },
        "Active Runtime config inventory commitment must be an object",
      );
      expectPlanError(
        state,
        {
          ...state.plan,
          activeConfigInventory: {
            ...state.plan.activeConfigInventory,
            unexpected: true,
          } as never,
        },
        "Active Runtime config inventory commitment has an invalid field set",
      );
      expectPlanError(
        state,
        {
          ...state.plan,
          activeConfigInventory: {
            objectCount: V2_LIMITS.batchItems + 1,
            digest: state.plan.activeConfigInventory.digest,
          },
        },
        "Active Runtime config inventory object count exceeds the 256 limit",
      );
      expectPlanError(
        state,
        {
          ...state.plan,
          activeConfigInventory: {
            objectCount: 2,
            digest: bytes(1, 31),
          },
        },
        "Active Runtime config inventory digest must contain exactly 32 bytes",
      );
      expectPlanError(
        state,
        {
          ...state.plan,
          activeConfigInventory: {
            objectCount: 2,
            digest: null as never,
          },
        },
        "Active Runtime config inventory digest must contain exactly 32 bytes",
      );
    }

    {
      const state = setup();
      expectPlanError(
        state,
        { ...state.plan, remainingDomains: null as never },
        "Remaining Agent Runtime Domains must be an array",
      );
      expectPlanError(
        state,
        {
          ...state.plan,
          remainingDomains: Array.from(
            { length: V2_LIMITS.agentGrantDomains + 1 },
            (_, index) => ({
              ...state.plan.remainingDomains[0]!,
              domainId: cryptoDomainId(
                `domain-${String(index).padStart(5, "0")}`,
              ),
            }),
          ),
        },
        `Remaining Agent Runtime Domain count exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
      );
      expectPlanError(
        state,
        { ...state.plan, remainingDomains: [null as never] },
        "Remaining Agent Runtime Domain must be an object",
      );
      expectPlanError(
        state,
        {
          ...state.plan,
          remainingDomains: [{
            ...state.plan.remainingDomains[0]!,
            unexpected: true,
          } as never],
        },
        "Remaining Agent Runtime Domain has an invalid field set",
      );
      expectPlanError(
        state,
        {
          ...state.plan,
          remainingDomains: [
            state.plan.remainingDomains[0]!,
            state.plan.remainingDomains[0]!,
          ],
        },
        "Remaining Agent Runtime Domains contain a duplicate",
      );
      expectPlanError(
        state,
        {
          ...state.plan,
          remainingDomains: [...state.plan.remainingDomains].reverse(),
        },
        "Remaining Agent Runtime Domains must be unsigned-byte sorted",
      );
      expectPlanError(
        state,
        {
          ...state.plan,
          remainingDomains: [
            {
              ...state.plan.remainingDomains[0]!,
              domainId: cryptoDomainId("domain-aa"),
            },
            {
              ...state.plan.remainingDomains[1]!,
              domainId: cryptoDomainId("domain-a"),
            },
          ],
        },
        "Remaining Agent Runtime Domains must be unsigned-byte sorted",
      );
    }

    {
      const state = setup();
      expectPlanError(
        state,
        {
          ...state.plan,
          runtimeRotationRequired: "yes" as never,
        },
        "Runtime rotation requirement must be boolean",
      );
      for (const plan of [
        { ...state.plan, agentId: agentId("agent-other") },
        {
          ...state.plan,
          oldAuthorizationRevision: authorizationRevision(19),
        },
        {
          ...state.plan,
          currentRuntimeGeneration: agentRuntimeGeneration(6),
        },
      ]) {
        expectPlanError(
          state,
          plan,
          "Agent Runtime rotation plan is stale or mismatched",
        );
      }
      expectPlanError(
        state,
        {
          ...state.plan,
          newAuthorizationRevision: authorizationRevision(22),
        },
        "Agent Runtime rotation plan must advance exactly one authorization revision",
      );
      expectPlanError(
        state,
        { ...state.plan, currentManager: null },
        "Agent Runtime rotation requires a current manager source",
      );
    }
  });

  test("detaches validated no-rotation state, manager, inventory, and Domain metadata", () => {
    const state = setup();
    const digest = state.plan.activeConfigInventory.digest.slice();
    const mutableState = { ...state.currentState };
    const mutableManager = { ...state.plan.currentManager! };
    const mutableInventory = {
      ...state.plan.activeConfigInventory,
      digest: digest.slice(),
    };
    const mutableDomains = state.plan.remainingDomains.map((domain) => ({
      ...domain,
    }));
    const result = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: mutableState,
      plan: {
        ...state.plan,
        runtimeRotationRequired: false,
        currentManager: mutableManager,
        activeConfigInventory: mutableInventory,
        remainingDomains: mutableDomains,
      },
    });
    if (result.kind !== "unchanged") throw new Error("expected unchanged");

    mutableState.runtimeGeneration = agentRuntimeGeneration(99);
    mutableManager.managerDeviceId = cryptoDeviceId("device-other");
    mutableInventory.digest.fill(0xff);
    mutableDomains[0]!.domainEpoch = domainEpoch(99);
    expect(result.expectedState).toEqual(state.currentState);
    expect(result.plan.currentManager).toEqual(state.plan.currentManager);
    expect(result.plan.activeConfigInventory.digest).toEqual(digest);
    expect(result.plan.remainingDomains).toEqual(state.plan.remainingDomains);
  });

  test("rejects a short cryptographic inventory digest instead of accepting its matching prefix", () => {
    const state = setup();
    const shortHashCrypto = new ShortHashCrypto(seededRng(0x2259));
    expect(() =>
      prepareAgentRuntimeRotationSourceV2({
        crypto: shortHashCrypto,
        currentState: state.currentState,
        currentRuntime: state.currentRuntime,
        plan: state.plan,
        activeConfigObjects: state.activeConfigObjects,
        resolveCurrentManagerAuthority: state.managerAuthority,
        managerSigningPrivateKey: state.managerSigning.privateKey,
      })
    ).toThrow(
      "Active Runtime config inventory does not match its commitment",
    );
  });

  test("validates every active config object boundary and exact diagnostic", () => {
    const state = setup();
    const inventory = (activeConfigObjects: AgentRuntimeConfigObjectV2[]) =>
      agentRuntimeConfigInventoryCommitmentV2({
        crypto: state.crypto,
        agentId: state.plan.agentId,
        runtimeGeneration: state.plan.currentRuntimeGeneration,
        activeConfigObjects,
      });

    expect(() => agentRuntimeConfigDekAadV2(null as never)).toThrow(
      "Agent Runtime config DEK context must be an object",
    );
    expect(() =>
      agentRuntimeConfigDekAadV2({
        ...state.activeConfigObjects[0],
        unexpected: true,
      } as never)
    ).toThrow("Agent Runtime config DEK context has an invalid field set");
    expect(() => inventory(null as never)).toThrow(
      "Active Runtime config objects must be an array",
    );
    expect(() =>
      inventory(Array.from(
        { length: V2_LIMITS.batchItems + 1 },
        (_, index) => ({
          ...state.activeConfigObjects[0],
          objectId: objectId(`config-${String(index).padStart(3, "0")}`),
        }),
      ))
    ).toThrow("Active Runtime config object count exceeds the 256 limit");
    expect(() => inventory([null as never])).toThrow(
      "Active Runtime config object must be an object",
    );
    expect(() =>
      inventory([{
        ...state.activeConfigObjects[0],
        unexpected: true,
      } as never])
    ).toThrow("Active Runtime config object has an invalid field set");
    const first = state.activeConfigObjects[0];
    const missingObjectId = {
      agentId: first.agentId,
      configRevision: first.configRevision,
      runtimeGeneration: first.runtimeGeneration,
      wrappedDek: first.wrappedDek,
    };
    expect(() => inventory([missingObjectId as never])).toThrow(
      "Active Runtime config object has an invalid field set",
    );
    expect(() =>
      inventory([{
        ...first,
        agentId: agentId("agent-other"),
      }])
    ).toThrow(
      "Active Runtime config object has stale Agent or generation metadata",
    );
    expect(() =>
      inventory([{
        ...first,
        runtimeGeneration: agentRuntimeGeneration(6),
      }])
    ).toThrow(
      "Active Runtime config object has stale Agent or generation metadata",
    );
    expect(() => inventory([first, first])).toThrow(
      "Active Runtime config objects contain a duplicate",
    );
    expect(() =>
      inventory([
        state.activeConfigObjects[1],
        state.activeConfigObjects[0],
      ])
    ).toThrow("Active Runtime config objects must be unsigned-byte sorted");
    expect(() =>
      inventory([
        { ...first, objectId: objectId("config-aa") },
        { ...first, objectId: objectId("config-a") },
      ])
    ).toThrow("Active Runtime config objects must be unsigned-byte sorted");
    for (const wrappedDek of [
      null as never,
      new Uint8Array(39),
      new Uint8Array(V2_LIMITS.wrappedDekBytes + 1),
    ]) {
      expect(() => inventory([{ ...first, wrappedDek }])).toThrow(
        "Wrapped Runtime config DEK is malformed",
      );
    }
    expect(
      inventory([{ ...first, wrappedDek: new Uint8Array(40) }]).objectCount,
    ).toBe(1);
    expect(
      inventory([{
        ...first,
        wrappedDek: new Uint8Array(V2_LIMITS.wrappedDekBytes),
      }]).objectCount,
    ).toBe(1);
  });

  test("owns validated object ciphertext and every inventory hash result", () => {
    const state = setup();
    let resolverCalls = 0;
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: () => {
        resolverCalls += 1;
        state.activeConfigObjects[0].wrappedDek.fill(0xff);
        return state.managerSigning.publicKey;
      },
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    expect(source.kind).toBe("rotated");
    expect(resolverCalls).toBe(1);

    const normal = setup();
    const reusable = new ReusingHashCrypto(seededRng(0x2260));
    const expected = agentRuntimeConfigInventoryCommitmentV2({
      crypto: normal.crypto,
      agentId: normal.plan.agentId,
      runtimeGeneration: normal.plan.currentRuntimeGeneration,
      activeConfigObjects: normal.activeConfigObjects,
    });
    const actual = agentRuntimeConfigInventoryCommitmentV2({
      crypto: reusable,
      agentId: normal.plan.agentId,
      runtimeGeneration: normal.plan.currentRuntimeGeneration,
      activeConfigObjects: normal.activeConfigObjects,
    });
    expect(actual).toEqual(expected);
    reusable.hash(bytes(0xee));
    expect(actual).toEqual(expected);
  });

  test("binds exact manager authority context, key, and proof bytes", () => {
    const state = setup();
    let observed: unknown;
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: (context) => {
        observed = context;
        return state.managerSigning.publicKey;
      },
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    expect(source.kind).toBe("rotated");
    expect(Object.isFrozen(observed)).toBe(true);
    expect(observed).toEqual({
      purpose: "agent-runtime-rotation-source",
      operationId: state.plan.operationId,
      agentId: state.plan.agentId,
      oldAuthorizationRevision: state.plan.oldAuthorizationRevision,
      newAuthorizationRevision: state.plan.newAuthorizationRevision,
      currentRuntimeGeneration: state.plan.currentRuntimeGeneration,
      nextRuntimeGeneration: agentRuntimeGeneration(8),
      ...state.plan.currentManager!,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    expect(hex(source.publicCandidate.manifestHash)).toBe(
      "50306a88c468727cb1e00f0595a9b97700aa950c5467120f9f4fb6f8338c3a42",
    );
    expect(hex(source.publicCandidate.managerSignature)).toBe(
      "29f88d62544d9f349329b348a3795e5e90a04f199604acec4ee659566232b488f9460ecfcc7d0a7c0a47c0ee73ba62206943182b9f53877751fa789ddd5cd30c",
    );

    for (const [resolve, privateKey, message] of [
      [
        () => null,
        state.managerSigning.privateKey,
        "Agent Runtime rotation manager is not currently authorized",
      ],
      [
        () => bytes(1, 31),
        state.managerSigning.privateKey,
        "Current manager signing public key must contain exactly 32 bytes",
      ],
      [
        () => state.targetSigningA.publicKey,
        state.managerSigning.privateKey,
        "Agent Runtime rotation manager private key does not match current authority",
      ],
    ] as const) {
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: state.currentState,
          currentRuntime: state.currentRuntime,
          plan: state.plan,
          activeConfigObjects: state.activeConfigObjects,
          resolveCurrentManagerAuthority: resolve,
          managerSigningPrivateKey: privateKey,
        })
      ).toThrow(message);
    }
  });

  test("keeps every target intent commitment independently owned", () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const first = source.publicCandidate.targetIntents[0]!;
    const second = source.publicCandidate.targetIntents[1]!;
    const manifest = source.publicCandidate.manifestHash.slice();
    const commitment = source.publicCandidate.runtimeCommitment.slice();
    expect(first.rotationManifestHash).not.toBe(second.rotationManifestHash);
    expect(first.runtimeCommitment).not.toBe(second.runtimeCommitment);
    first.rotationManifestHash.fill(0xff);
    first.runtimeCommitment.fill(0xff);
    expect(second.rotationManifestHash).toEqual(manifest);
    expect(second.runtimeCommitment).toEqual(commitment);
    expect(source.publicCandidate.manifestHash).toEqual(manifest);
    expect(source.publicCandidate.runtimeCommitment).toEqual(commitment);
  });

  test("authorization-only transition preserves the generation without minting a signer publication", () => {
    const state = setup();
    const calls = state.crypto.randomCalls;
    const result = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      plan: {
        ...state.plan,
        runtimeRotationRequired: false,
        currentManager: null,
      },
    });
    if (result.kind !== "unchanged") {
      throw new Error("expected unchanged Runtime");
    }
    expect(result).toEqual({
      kind: "unchanged",
      plan: result.plan,
      expectedState: state.currentState,
      nextAuthorizationRevision: state.plan.newAuthorizationRevision,
    });
    expect(state.crypto.randomCalls).toBe(calls);
  });

  test("rejects each secret-bearing input on the no-rotation path", () => {
    const state = setup();
    const plan = {
      ...state.plan,
      runtimeRotationRequired: false,
      currentManager: null,
    };
    for (const secret of [
      { activeConfigObjects: state.activeConfigObjects },
      { resolveCurrentManagerAuthority: state.managerAuthority },
      { managerSigningPrivateKey: state.managerSigning.privateKey },
      { currentRuntime: state.currentRuntime },
    ]) {
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: state.currentState,
          plan,
          ...secret,
        })
      ).toThrow(
        "A no-rotation plan must not include Runtime, config, or manager secrets",
      );
    }
  });

  test("validates every rotation-only dependency and Runtime coordinate exactly", () => {
    const state = setup();
    const base = {
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    };
    const expectSourceError = (
      overrides: Record<string, unknown>,
      message: string,
    ) => {
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          ...base,
          ...overrides,
        } as never)
      ).toThrow(message);
    };

    expectSourceError(
      { currentRuntime: undefined },
      "Current Agent Runtime is required for rotation",
    );
    expectSourceError(
      { currentRuntime: null },
      "Current Agent Runtime must be an object",
    );
    expectSourceError(
      { currentRuntime: { ...state.currentRuntime, unexpected: true } },
      "Current Agent Runtime has an invalid field set",
    );
    const { key: _missingKey, ...runtimeWithoutKey } = state.currentRuntime;
    expectSourceError(
      { currentRuntime: runtimeWithoutKey },
      "Current Agent Runtime has an invalid field set",
    );
    for (const currentRuntime of [
      { ...state.currentRuntime, agentId: agentId("agent-other") },
      { ...state.currentRuntime, keyClass: "other" },
      {
        ...state.currentRuntime,
        generation: agentRuntimeGeneration(6),
      },
    ]) {
      expectSourceError(
        { currentRuntime },
        "Current Agent Runtime does not match the rotation plan",
      );
    }
    for (const key of [null, bytes(1, 31)]) {
      expectSourceError(
        { currentRuntime: { ...state.currentRuntime, key } },
        "Current Agent Runtime key must contain exactly 32 bytes",
      );
    }
    for (const managerSigningPrivateKey of [undefined, bytes(1, 31)]) {
      expectSourceError(
        { managerSigningPrivateKey },
        "Manager signing private key must contain exactly 32 bytes",
      );
    }
    expectSourceError(
      { resolveCurrentManagerAuthority: undefined },
      "Current manager authority resolver is required",
    );
    expectSourceError(
      { activeConfigObjects: undefined },
      "Active Runtime config inventory is required for rotation",
    );
    expectSourceError(
      {
        plan: {
          ...state.plan,
          activeConfigInventory: {
            ...state.plan.activeConfigInventory,
            objectCount: 1,
          },
        },
      },
      "Active Runtime config inventory does not match its commitment",
    );

    state.crypto.shortNextRandom = true;
    expectSourceError(
      {},
      "Fresh Agent Runtime key must contain 32 bytes",
    );
    state.crypto.shortNextOpen = true;
    expectSourceError(
      {},
      "Active Runtime config DEK failed to decrypt",
    );
    const bufferedManagerKey = Buffer.from(
      state.managerSigning.privateKey,
    );
    const bufferedSource = prepareAgentRuntimeRotationSourceV2({
      ...base,
      managerSigningPrivateKey: bufferedManagerKey,
    });
    expect(bufferedSource.kind).toBe("rotated");
    expect(
      Buffer.isBuffer(state.crypto.signingKeys.at(-1)),
    ).toBeFalse();
    expect(
      state.crypto.signingKeys.at(-1)?.every((byte) => byte === 0),
    ).toBeTrue();
  });

  test("tracks and destroys only authentic source-local Runtime keys", () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");

    expect(() =>
      assertAgentRuntimeRotationSourceLocalV2(source.sourceLocal)
    ).not.toThrow();
    const forged = Object.freeze({
      runtime: {
        ...source.sourceLocal.runtime,
        key: source.sourceLocal.runtime.key.slice(),
      },
    });
    expect(() =>
      assertAgentRuntimeRotationSourceLocalV2(forged)
    ).toThrow(
      "Agent Runtime rotation source-local key is absent or destroyed",
    );
    expect(() =>
      destroyAgentRuntimeRotationSourceLocalV2(forged)
    ).toThrow("Agent Runtime rotation source-local value is untrusted");

    destroyAgentRuntimeRotationSourceLocalV2(source.sourceLocal);
    expect(source.sourceLocal.runtime.key).toEqual(bytes(0));
    expect(() =>
      assertAgentRuntimeRotationSourceLocalV2(source.sourceLocal)
    ).toThrow(
      "Agent Runtime rotation source-local key is absent or destroyed",
    );
  });

  test("detaches provider-owned source candidate cryptographic outputs", () => {
    const state = setup();
    state.crypto.bufferNextRandom = true;
    const firstNewRandom = state.crypto.randomOutputs.length;
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const providerRuntimeKey =
      state.crypto.randomOutputs[firstNewRandom];
    if (providerRuntimeKey === undefined) {
      throw new Error("missing provider Runtime key");
    }
    const expectedRuntimeKey = Uint8Array.from(
      source.sourceLocal.runtime.key,
    );
    expect(providerRuntimeKey.every((byte) => byte === 0)).toBe(true);
    providerRuntimeKey.fill(0xff);
    expect(Buffer.isBuffer(source.sourceLocal.runtime.key)).toBeFalse();
    expect(source.sourceLocal.runtime.key).toEqual(expectedRuntimeKey);

    for (const rewrap of source.publicCandidate.configRewraps) {
      expect(
        state.crypto.hashOutputs.includes(rewrap.expected.wrappedDekHash),
      ).toBe(false);
      expect(
        state.crypto.sealedOutputs.includes(
          rewrap.nextWrappedDek.ciphertext,
        ),
      ).toBe(false);
    }
    expect(
      state.crypto.hashOutputs.includes(
        source.publicCandidate.runtimeCommitment,
      ),
    ).toBe(false);
    expect(
      state.crypto.hashOutputs.includes(source.publicCandidate.manifestHash),
    ).toBe(false);
    expect(
      state.crypto.signOutputs.includes(
        source.publicCandidate.managerSignature,
      ),
    ).toBe(false);
  });

  test("stale wrapped-DEK metadata fails all-or-nothing and zeroizes transient keys", () => {
    const state = setup();
    const calls = state.crypto.randomCalls;
    const staleObjects = [
      state.activeConfigObjects[0],
      {
        ...state.activeConfigObjects[1],
        configRevision: authorizationRevision(6),
      },
    ];
    expect(() =>
      prepareAgentRuntimeRotationSourceV2({
        crypto: state.crypto,
        currentState: state.currentState,
        currentRuntime: state.currentRuntime,
        plan: {
          ...state.plan,
          activeConfigInventory: agentRuntimeConfigInventoryCommitmentV2({
            crypto: state.crypto,
            agentId: state.plan.agentId,
            runtimeGeneration: state.plan.currentRuntimeGeneration,
            activeConfigObjects: staleObjects,
          }),
        },
        activeConfigObjects: staleObjects,
        resolveCurrentManagerAuthority: state.managerAuthority,
        managerSigningPrivateKey: state.managerSigning.privateKey,
      })
    ).toThrow("decrypt");
    expect(state.crypto.randomCalls).toBeGreaterThan(calls);
    expect(state.crypto.openedKeys.slice(-2).every((key) =>
      key.every((byte) => byte === 0)
    )).toBe(true);
    expect(state.crypto.openedPlaintexts.every((plaintext) =>
      plaintext.every((byte) => byte === 0)
    )).toBe(true);
  });
});

describe("manager-source handoff and atomic aggregation", () => {
  test("domain-separates manager authority and target receipt proofs", async () => {
    const fixture = await managerHandoffFixture();
    await fixture.finalize();

    for (const label of ["manager-authority", "manager-target-receipt"]) {
      const encoded = new TextEncoder().encode(label);
      expect(
        fixture.state.crypto.signingMessages.some((message) =>
          message.some((_, offset) =>
            offset + encoded.length <= message.length
            && encoded.every((byte, index) =>
              message[offset + index] === byte
            )
          )
        ),
      ).toBe(true);
    }
  });

  test("preserves acquisition errors while cleaning partially owned secrets", async () => {
    const fixture = await managerHandoffFixture();
    const { state, source, plan, ephemeral, challenge, response } = fixture;
    const responseInput = {
      crypto: state.crypto,
      challengeBytes: challenge.challengeBytes,
      expectedPlan: plan,
      freshRuntime: source.sourceLocal.runtime,
      managerSigningPrivateKey: state.managerSigning.privateKey,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    };

    let runtimeKeyReads = 0;
    const throwingRuntime = {
      ...source.sourceLocal.runtime,
      get key(): Uint8Array {
        runtimeKeyReads += 1;
        if (runtimeKeyReads === 1) return source.sourceLocal.runtime.key;
        throw new Error("runtime key acquisition failed");
      },
    };
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse({
        ...responseInput,
        freshRuntime: throwingRuntime,
      })
    )).toBe("runtime key acquisition failed");

    let managerKeyReads = 0;
    const throwingManagerInput = {
      ...responseInput,
      get managerSigningPrivateKey(): Uint8Array {
        managerKeyReads += 1;
        if (managerKeyReads === 1) return state.managerSigning.privateKey;
        throw new Error("manager key acquisition failed");
      },
    };
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse(throwingManagerInput)
    )).toBe("manager key acquisition failed");

    let ephemeralKeyReads = 0;
    const throwingTargetInput = {
      crypto: state.crypto,
      challengeBytes: challenge.challengeBytes,
      responseBytes: response,
      expectedPlan: plan,
      trustedChallengeState: {
        challengeHash: challenge.challengeHash,
        consumed: false,
      },
      get targetEphemeralPrivateKey(): Uint8Array {
        ephemeralKeyReads += 1;
        if (ephemeralKeyReads === 1) return ephemeral.privateKey;
        throw new Error("target key acquisition failed");
      },
      targetDomainRoot: bytes(0x31),
      targetCommitterSigningPrivateKey: state.targetSigningA.privateKey,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    };
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget(throwingTargetInput)
    )).toBe("target key acquisition failed");
  });

  test("reconstructs an atomic rotation from its detached signed proof bundle", async () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const first = await completeTarget(state, source, 0);
    const second = await completeTarget(state, source, 1);
    const candidate = aggregateAgentRuntimeRotationV2({
      crypto: state.crypto,
      publicCandidate: source.publicCandidate,
      completedTargets: [first.completion, second.completion],
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    });
    const rehydrated = structuredClone(candidate);
    expect(aggregateAgentRuntimeRotationV2({
      crypto: state.crypto,
      publicCandidate: rehydrated.publicCandidate,
      completedTargets: rehydrated.completedTargets,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    })).toEqual(candidate);

    const badManagerProof = structuredClone(candidate);
    badManagerProof.publicCandidate.managerSignature[0] =
      badManagerProof.publicCandidate.managerSignature[0]! ^ 1;
    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: badManagerProof.publicCandidate,
        completedTargets: badManagerProof.completedTargets,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow("manager manifest signature is invalid");

    const badTargetProof = structuredClone(candidate);
    badTargetProof.completedTargets[0]!.targetReceiptSignature[0] =
      badTargetProof.completedTargets[0]!.targetReceiptSignature[0]! ^ 1;
    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: badTargetProof.publicCandidate,
        completedTargets: badTargetProof.completedTargets,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow("target receipt signature is invalid");
  });

  test("mutation contract: manager handoff validates plan, commitment, and authority exactly", async () => {
    const fixture = await managerHandoffFixture();
    const { state, source, plan, ephemeral } = fixture;
    const challengeInput = {
      crypto: state.crypto,
      plan,
      targetEphemeralPublicKey: ephemeral.publicKey,
      targetCommitterSigningPrivateKey:
        state.targetSigningA.privateKey,
      resolveCurrentTargetCommitter: state.targetAuthority,
      ttlMs: 60_000,
    };

    for (const invalidPlan of [null, 42]) {
      expect(thrownMessage(() =>
        prepareAgentRuntimeManagerHandoffChallenge({
          ...challengeInput,
          plan: invalidPlan as never,
        })
      )).toBe("Agent Runtime manager handoff plan is required");
    }
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        plan: { ...plan, unexpected: true } as never,
      })
    )).toBe("Agent Runtime manager handoff plan has an invalid field set");
    const {
      operationId: _operationId,
      ...planWithoutOperation
    } = plan;
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        plan: planWithoutOperation as never,
      })
    )).toBe("Agent Runtime manager handoff plan has an invalid field set");
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        plan: {
          ...planWithoutOperation,
          unexpected: true,
        } as never,
      })
    )).toBe("Agent Runtime manager handoff plan has an invalid field set");
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        plan: { ...plan, operationId: "not portable!" },
      })
    )).toBe(
      "Agent Runtime manager handoff operation id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    for (const invalidSource of [null, 42]) {
      expect(thrownMessage(() =>
        prepareAgentRuntimeManagerHandoffChallenge({
          ...challengeInput,
          plan: { ...plan, source: invalidSource as never },
        })
      )).toBe("Agent Runtime manager handoff source is required");
    }
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        plan: {
          ...plan,
          source: { ...plan.source, unexpected: true } as never,
        },
      })
    )).toBe(
      "Agent Runtime manager handoff source has an invalid field set",
    );
    const {
      managerHumanId: _managerHumanId,
      ...sourceWithoutHuman
    } = plan.source;
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        plan: {
          ...plan,
          source: sourceWithoutHuman as never,
        },
      })
    )).toBe(
      "Agent Runtime manager handoff source has an invalid field set",
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        plan: {
          ...plan,
          source: {
            ...sourceWithoutHuman,
            unexpected: true,
          } as never,
        },
      })
    )).toBe(
      "Agent Runtime manager handoff source has an invalid field set",
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        plan: { ...plan, rotationManifestHash: bytes(1, 31) },
      })
    )).toBe(
      "Agent Runtime rotation manifest hash must contain exactly 32 bytes",
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        plan: { ...plan, runtimeCommitment: bytes(1, 31) },
      })
    )).toBe(
      "Agent Runtime key commitment must contain exactly 32 bytes",
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        plan: {
          ...plan,
          source: {
            ...plan.source,
            managerDeviceId: plan.target.committerDeviceId,
          },
        },
      })
    )).toBe(
      "Agent Runtime manager handoff requires separate source and target devices",
    );

    expect(thrownMessage(() =>
      agentRuntimeManagerHandoffRuntimeCommitmentV1({
        crypto: state.crypto,
        operationId: "not portable!",
        agentId: plan.agentId,
        runtimeGeneration: plan.runtimeGeneration,
        runtimeKey: source.sourceLocal.runtime.key,
      })
    )).toBe(
      "Agent Runtime manager handoff operation id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    expect(thrownMessage(() =>
      agentRuntimeManagerHandoffRuntimeCommitmentV1({
        crypto: state.crypto,
        operationId: plan.operationId,
        agentId: plan.agentId,
        runtimeGeneration: plan.runtimeGeneration,
        runtimeKey: bytes(1, 31),
      })
    )).toBe(
      "Agent Runtime key commitment input must contain exactly 32 bytes",
    );
    const reusable = new ReusingHashCrypto(seededRng(0x2259));
    const bufferedKey = Buffer.from(source.sourceLocal.runtime.key);
    const bufferedKeySnapshot = Buffer.from(bufferedKey);
    const commitment = agentRuntimeManagerHandoffRuntimeCommitmentV1({
      crypto: reusable,
      operationId: plan.operationId,
      agentId: plan.agentId,
      runtimeGeneration: plan.runtimeGeneration,
      runtimeKey: bufferedKey,
    });
    const expectedCommitment = commitment.slice();
    reusable.hash(bytes(0xee));
    expect(commitment).toEqual(expectedCommitment);
    expect(bufferedKey).toEqual(bufferedKeySnapshot);
    const hashInputCount = state.crypto.hashInputs.length;
    agentRuntimeManagerHandoffRuntimeCommitmentV1({
      crypto: state.crypto,
      operationId: plan.operationId,
      agentId: plan.agentId,
      runtimeGeneration: plan.runtimeGeneration,
      runtimeKey: source.sourceLocal.runtime.key,
    });
    expect(
      state.crypto.hashInputs[hashInputCount]!.every(
        (byte) => byte === 0,
      ),
    ).toBe(true);

    const authorityContexts: unknown[] = [];
    prepareAgentRuntimeManagerHandoffChallenge({
      ...challengeInput,
      resolveCurrentTargetCommitter: (context) => {
        authorityContexts.push(context);
        return state.targetSigningA.publicKey;
      },
    });
    expect(authorityContexts).toEqual([{
      purpose: "agent-runtime-manager-handoff",
      operationId: plan.operationId,
      agentId: plan.agentId,
      runtimeGeneration: plan.runtimeGeneration,
      source: plan.source,
      target: plan.target,
    }]);
    expect(Object.isFrozen(authorityContexts[0])).toBe(true);
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        resolveCurrentTargetCommitter: () => null,
      })
    )).toBe(
      "Agent Runtime manager handoff target is not currently authorized",
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...challengeInput,
        resolveCurrentTargetCommitter: () => bytes(1, 31),
      })
    )).toBe(
      "Agent Runtime manager handoff target public key must contain exactly 32 bytes",
    );
  });

  test("mutation contract: manager challenge validates every direct input, clock edge, and owned output", async () => {
    const fixture = await managerHandoffFixture();
    const { state, plan, ephemeral } = fixture;
    const input = {
      crypto: state.crypto,
      plan,
      targetEphemeralPublicKey: ephemeral.publicKey,
      targetCommitterSigningPrivateKey:
        state.targetSigningA.privateKey,
      resolveCurrentTargetCommitter: state.targetAuthority,
      ttlMs: 60_000,
    };

    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...input,
        targetEphemeralPublicKey: bytes(1, 64),
      })
    )).toBe(
      "Manager handoff target ephemeral public key must contain exactly 65 bytes",
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...input,
        targetCommitterSigningPrivateKey: bytes(1, 31),
      })
    )).toBe(
      "Manager handoff target signing private key must contain exactly 32 bytes",
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...input,
        resolveCurrentTargetCommitter: null as never,
      })
    )).toBe("Current manager handoff target resolver is required");
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...input,
        ttlMs: 0,
      })
    )).toBe(
      `Agent Runtime manager handoff TTL must be between 1 and ${V2_LIMITS.grantTtlMs}`,
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...input,
        targetCommitterSigningPrivateKey:
          state.targetSigningZ.privateKey,
      })
    )).toBe(
      "Agent Runtime handoff target signing key does not match the current committer",
    );

    state.clock.set(-1);
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge(input)
    )).toBe("Manager handoff clock is outside safe range");
    state.clock.set(
      Number.MAX_SAFE_INTEGER - input.ttlMs + 1,
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge(input)
    )).toBe("Manager handoff clock is outside safe range");
    state.clock.set(0);
    expect(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        ...input,
        ttlMs: V2_LIMITS.grantTtlMs,
      })
    ).not.toThrow();

    state.crypto.shortNextRandom = true;
    expect(thrownMessage(() =>
      prepareAgentRuntimeManagerHandoffChallenge(input)
    )).toBe(
      "Manager handoff challenge nonce must contain exactly 32 bytes",
    );

    state.crypto.reuseHashOutput = true;
    const challenge =
      prepareAgentRuntimeManagerHandoffChallenge(input);
    const expectedHash = challenge.challengeHash.slice();
    state.crypto.hash(bytes(0xee));
    expect(challenge.challengeHash).toEqual(expectedHash);
    expect(
      state.crypto.signingKeys.at(-1)?.every((byte) => byte === 0),
    ).toBe(true);
  });

  test("mutation contract: manager response validates Runtime authority and the complete wire ceiling", async () => {
    const fixture = await managerHandoffFixture();
    const { state, source, plan, challenge } = fixture;
    const input = {
      crypto: state.crypto,
      challengeBytes: challenge.challengeBytes,
      expectedPlan: plan,
      freshRuntime: source.sourceLocal.runtime,
      managerSigningPrivateKey: state.managerSigning.privateKey,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    };

    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse({
        ...input,
        managerSigningPrivateKey: bytes(1, 31),
      })
    )).toBe(
      "Manager handoff manager signing private key must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse({
        ...input,
        resolveCurrentManagerAuthority: null as never,
      })
    )).toBe("Current manager handoff manager resolver is required");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse({
        ...input,
        resolveCurrentTargetCommitter: null as never,
      })
    )).toBe("Current manager handoff target resolver is required");
    for (const freshRuntime of [
      {
        ...input.freshRuntime,
        agentId: agentId("agent-other"),
      },
      {
        ...input.freshRuntime,
        generation: agentRuntimeGeneration(
          input.freshRuntime.generation + 1,
        ),
      },
    ]) {
      expect(await rejectedMessage(() =>
        prepareAgentRuntimeManagerHandoffResponse({
          ...input,
          freshRuntime,
        })
      )).toBe("Fresh Runtime does not match manager handoff plan");
    }
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse({
        ...input,
        resolveCurrentManagerAuthority: () => null,
      })
    )).toBe(
      "Agent Runtime manager handoff manager is not currently authorized",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse({
        ...input,
        resolveCurrentManagerAuthority: () => bytes(1, 31),
      })
    )).toBe(
      "Agent Runtime manager handoff manager public key must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse({
        ...input,
        managerSigningPrivateKey:
          state.targetSigningA.privateKey,
      })
    )).toBe(
      "Agent Runtime handoff source signing key does not match the current committer",
    );

    state.crypto.hpkeSealResultLength = 0;
    const emptyResponse =
      await prepareAgentRuntimeManagerHandoffResponse(input);
    const responseOverhead = emptyResponse.length;
    state.crypto.hpkeSealResultLength =
      V2_LIMITS.ciphertextBytes - responseOverhead;
    const exactResponse =
      await prepareAgentRuntimeManagerHandoffResponse(input);
    expect(exactResponse).toHaveLength(V2_LIMITS.ciphertextBytes);
    state.crypto.hpkeSealResultLength =
      V2_LIMITS.ciphertextBytes - responseOverhead + 1;
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse(input)
    )).toBe("Manager handoff response exceeds byte limit");

    state.crypto.hpkeSealResultLength = null;
    const bufferedRuntimeKey = Buffer.from(
      source.sourceLocal.runtime.key,
    );
    const bufferedResponse =
      await prepareAgentRuntimeManagerHandoffResponse({
        ...input,
        freshRuntime: {
          ...source.sourceLocal.runtime,
          key: bufferedRuntimeKey,
        },
      });
    expect(bufferedResponse.length).toBeGreaterThan(0);
    expect(
      state.crypto.hpkePlaintexts.at(-1)?.every((byte) => byte === 0),
    ).toBeTrue();
  });

  test("mutation contract: manager target rejects every direct state, authority, signature, and decryption fault", async () => {
    const fixture = await managerHandoffFixture();
    const {
      state,
      plan,
      ephemeral,
      challenge,
      response,
    } = fixture;
    const input = {
      crypto: state.crypto,
      challengeBytes: challenge.challengeBytes,
      responseBytes: response,
      expectedPlan: plan,
      trustedChallengeState: {
        challengeHash: challenge.challengeHash,
        consumed: false,
      },
      targetEphemeralPrivateKey: ephemeral.privateKey,
      targetDomainRoot: bytes(0x31),
      targetCommitterSigningPrivateKey:
        state.targetSigningA.privateKey,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    };

    for (const trustedChallengeState of [null, 42]) {
      expect(await rejectedMessage(() =>
        prepareAgentRuntimeManagerHandoffTarget({
          ...input,
          trustedChallengeState: trustedChallengeState as never,
        })
      )).toBe("Trusted manager handoff challenge state is required");
    }
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        trustedChallengeState: {
          ...input.trustedChallengeState,
          unexpected: true,
        } as never,
      })
    )).toBe(
      "Trusted manager handoff challenge state has an invalid field set",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        trustedChallengeState: {
          challengeHash: bytes(1, 31),
          consumed: false,
        },
      })
    )).toBe(
      "Trusted manager handoff challenge hash must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        trustedChallengeState: {
          challengeHash: challenge.challengeHash,
          consumed: "false" as never,
        },
      })
    )).toBe(
      "Trusted manager handoff challenge consumed state must be boolean",
    );
    for (const [field, value, message] of [
      [
        "targetEphemeralPrivateKey",
        bytes(1, 31),
        "Manager handoff target ephemeral private key must contain exactly 32 bytes",
      ],
      [
        "targetDomainRoot",
        bytes(1, 31),
        "Manager handoff target Domain root must contain exactly 32 bytes",
      ],
      [
        "targetCommitterSigningPrivateKey",
        bytes(1, 31),
        "Manager handoff target signing private key must contain exactly 32 bytes",
      ],
    ] as const) {
      expect(await rejectedMessage(() =>
        prepareAgentRuntimeManagerHandoffTarget({
          ...input,
          [field]: value,
        })
      )).toBe(message);
    }
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        resolveCurrentManagerAuthority: null as never,
      })
    )).toBe("Current manager handoff manager resolver is required");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        resolveCurrentTargetCommitter: null as never,
      })
    )).toBe("Current manager handoff target resolver is required");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        responseBytes: "response" as never,
      })
    )).toBe("Manager handoff response exceeds byte limit");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        responseBytes:
          new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
      })
    )).toBe("Manager handoff response exceeds byte limit");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        responseBytes:
          new Uint8Array(V2_LIMITS.ciphertextBytes),
      })
    )).toBe("invalid Agent Runtime manager handoff domain");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        trustedChallengeState: {
          challengeHash: challenge.challengeHash,
          consumed: true,
        },
      })
    )).toBe("Manager handoff challenge state is stale or consumed");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        trustedChallengeState: {
          challengeHash: bytes(0xf1),
          consumed: false,
        },
      })
    )).toBe("Manager handoff challenge state is stale or consumed");

    const otherChallengeResponse = response.slice();
    const responseHashOffset =
      managerMessagePrefixSize("manager-response") + 4;
    otherChallengeResponse[responseHashOffset] =
      otherChallengeResponse[responseHashOffset]! ^ 1;
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        responseBytes: otherChallengeResponse,
      })
    )).toBe(
      "Manager handoff response belongs to another challenge",
    );
    const badSignature = response.slice();
    badSignature[badSignature.length - 1] =
      badSignature[badSignature.length - 1]! ^ 1;
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        responseBytes: badSignature,
      })
    )).toBe("Manager handoff response signature is invalid");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        resolveCurrentManagerAuthority: () => null,
      })
    )).toBe(
      "Agent Runtime manager handoff manager is not currently authorized",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        resolveCurrentManagerAuthority: () => bytes(1, 31),
      })
    )).toBe(
      "Agent Runtime manager handoff manager public key must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        targetCommitterSigningPrivateKey:
          state.targetSigningZ.privateKey,
      })
    )).toBe(
      "Agent Runtime handoff target signing key does not match the current committer",
    );
    let targetAuthorityCalls = 0;
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        resolveCurrentTargetCommitter: () => {
          targetAuthorityCalls += 1;
          return targetAuthorityCalls === 1
            ? state.targetSigningA.publicKey
            : null;
        },
      })
    )).toBe(
      "Agent Runtime manager handoff target is not currently authorized",
    );
    const wrongEphemeral =
      await state.crypto.generateEncryptionKeyPair();
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffTarget({
        ...input,
        targetEphemeralPrivateKey: wrongEphemeral.privateKey,
      })
    )).toBe("Manager handoff response failed to decrypt");
  });

  test("mutation contract: manager target binds every decrypted secret coordinate and the Runtime commitment", async () => {
    const fixture = await managerHandoffFixture();
    const secretHashOffset = managerMessagePrefixSize("manager-secret")
      + managerPlanWireSize(fixture.plan);
    const secretPlanOffset =
      managerMessagePrefixSize("manager-secret");
    const transformations: readonly [
      (plaintext: Uint8Array) => Uint8Array,
      string,
    ][] = [
      [
        (plaintext) =>
          corruptManagerTextAt(plaintext, secretPlanOffset),
        "Manager handoff secret does not match challenge",
      ],
      [
        (plaintext) => {
          const copy = plaintext.slice();
          copy[secretHashOffset + 4] =
            copy[secretHashOffset + 4]! ^ 1;
          return copy;
        },
        "Manager handoff secret does not match challenge",
      ],
      [
        (plaintext) =>
          corruptLastManagerBytes(
            plaintext,
            managerTextEncoder.encode(fixture.plan.agentId),
            0,
            0x62,
          ),
        "Manager handoff secret does not match challenge",
      ],
      [
        (plaintext) =>
          corruptLastManagerBytes(
            plaintext,
            encodeU64(fixture.plan.runtimeGeneration),
            7,
          ),
        "Manager handoff secret does not match challenge",
      ],
    ];
    for (const [transform, message] of transformations) {
      const fresh = await managerHandoffFixture();
      fresh.state.crypto.hpkePlaintextTransform = transform;
      expect(await rejectedMessage(() => fresh.finalize())).toBe(message);
    }

    const alteredRuntime = {
      ...fixture.source.sourceLocal.runtime,
      key: bytes(0xa5),
    };
    const alteredResponse =
      await prepareAgentRuntimeManagerHandoffResponse({
        crypto: fixture.state.crypto,
        challengeBytes: fixture.challenge.challengeBytes,
        expectedPlan: fixture.plan,
        freshRuntime: alteredRuntime,
        managerSigningPrivateKey:
          fixture.state.managerSigning.privateKey,
        resolveCurrentManagerAuthority:
          fixture.state.managerAuthority,
        resolveCurrentTargetCommitter:
          fixture.state.targetAuthority,
      });
    expect(await rejectedMessage(() =>
      fixture.finalize({ responseBytes: alteredResponse })
    )).toBe(
      "Manager handoff Runtime does not match the rotation commitment",
    );
  });

  test("mutation contract: manager handoff rejects malformed challenge, response, and secret wire fields", async () => {
    const fixture = await managerHandoffFixture();
    const { state, source, plan, challenge, response } = fixture;
    const challengePrefix = managerMessagePrefixSize(
      "manager-challenge",
    );
    const nonceOffset = challengePrefix + managerPlanWireSize(plan);
    const ephemeralOffset = nonceOffset + 4 + 32 + 8 + 8;
    const signatureOffset = ephemeralOffset + 4
      + V2_LIMITS.hpkePublicKeyBytes;
    const challengeCases: readonly [Uint8Array, string][] = [
      [corruptManagerTextAt(challenge.challengeBytes, 0),
        "invalid Agent Runtime manager handoff domain"],
      [corruptManagerTextAt(
        challenge.challengeBytes,
        managerFrameSize(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN),
      ), "invalid Agent Runtime manager challenge kind"],
      [shortenManagerFrameAt(challenge.challengeBytes, nonceOffset),
        "Manager handoff challenge nonce must contain exactly 32 bytes"],
      [shortenManagerFrameAt(challenge.challengeBytes, ephemeralOffset),
        "Manager handoff target ephemeral public key must contain exactly 65 bytes"],
      [shortenManagerFrameAt(challenge.challengeBytes, signatureOffset),
        "Manager handoff target signature must contain exactly 64 bytes"],
    ];
    for (const [challengeBytes, message] of challengeCases) {
      expect(await rejectedMessage(() =>
        prepareAgentRuntimeManagerHandoffResponse({
          crypto: state.crypto,
          challengeBytes,
          expectedPlan: plan,
          freshRuntime: source.sourceLocal.runtime,
          managerSigningPrivateKey: state.managerSigning.privateKey,
          resolveCurrentManagerAuthority: state.managerAuthority,
          resolveCurrentTargetCommitter: state.targetAuthority,
        })
      )).toBe(message);
    }
    const tamperedSignature = challenge.challengeBytes.slice();
    const signatureIndex = tamperedSignature.length - 1;
    tamperedSignature[signatureIndex] =
      tamperedSignature[signatureIndex]! ^ 1;
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse({
        crypto: state.crypto,
        challengeBytes: tamperedSignature,
        expectedPlan: plan,
        freshRuntime: source.sourceLocal.runtime,
        managerSigningPrivateKey: state.managerSigning.privateKey,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    )).toBe("Agent Runtime manager challenge signature is invalid");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeManagerHandoffResponse({
        crypto: state.crypto,
        challengeBytes: challenge.challengeBytes,
        expectedPlan: plan,
        freshRuntime: source.sourceLocal.runtime,
        managerSigningPrivateKey: state.managerSigning.privateKey,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: () => null,
      })
    )).toBe(
      "Agent Runtime manager handoff target is not currently authorized",
    );

    state.crypto.reuseHashOutput = true;
    const detachedHashResponse =
      await prepareAgentRuntimeManagerHandoffResponse({
        crypto: state.crypto,
        challengeBytes: challenge.challengeBytes,
        expectedPlan: plan,
        freshRuntime: source.sourceLocal.runtime,
        managerSigningPrivateKey: state.managerSigning.privateKey,
        resolveCurrentManagerAuthority: () => {
          state.crypto.hash(bytes(0xee));
          return state.managerSigning.publicKey;
        },
        resolveCurrentTargetCommitter: state.targetAuthority,
      });
    const detachedHashCompletion = await fixture.finalize({
      responseBytes: detachedHashResponse,
    });
    expect(detachedHashCompletion).toBeDefined();
    state.crypto.reuseHashOutput = false;

    const exactLimit = new Uint8Array(V2_LIMITS.ciphertextBytes);
    for (const [challengeBytes, message] of [
      [exactLimit, "invalid Agent Runtime manager handoff domain"],
      [new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
        "Agent Runtime manager challenge exceeds byte limit"],
    ] as const) {
      expect(await rejectedMessage(() =>
        prepareAgentRuntimeManagerHandoffResponse({
          crypto: state.crypto,
          challengeBytes,
          expectedPlan: plan,
          freshRuntime: source.sourceLocal.runtime,
          managerSigningPrivateKey: state.managerSigning.privateKey,
          resolveCurrentManagerAuthority: state.managerAuthority,
          resolveCurrentTargetCommitter: state.targetAuthority,
        })
      )).toBe(message);
    }

    const responseHashOffset = managerMessagePrefixSize(
      "manager-response",
    );
    const responseSignatureOffset = response.length
      - V2_LIMITS.signatureBytes - 4;
    const responseCases: readonly [Uint8Array, string][] = [
      [corruptManagerTextAt(response, 0),
        "invalid Agent Runtime manager handoff domain"],
      [corruptManagerTextAt(
        response,
        managerFrameSize(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN),
      ), "invalid Agent Runtime manager response kind"],
      [shortenManagerFrameAt(response, responseHashOffset),
        "Manager handoff challenge hash must contain exactly 32 bytes"],
      [shortenManagerFrameAt(response, responseSignatureOffset),
        "Manager handoff response signature must contain exactly 64 bytes"],
    ];
    for (const [responseBytes, message] of responseCases) {
      expect(await rejectedMessage(() =>
        fixture.finalize({ responseBytes })
      )).toBe(message);
    }

    const secretHashOffset = managerMessagePrefixSize("manager-secret")
      + managerPlanWireSize(plan);
    const secretCases: readonly [
      (plaintext: Uint8Array) => Uint8Array,
      string,
    ][] = [
      [(plaintext) => corruptManagerTextAt(plaintext, 0),
        "invalid Agent Runtime manager secret domain"],
      [(plaintext) => corruptManagerTextAt(
        plaintext,
        managerFrameSize(AGENT_RUNTIME_MANAGER_HANDOFF_DOMAIN),
      ), "invalid Agent Runtime manager secret kind"],
      [(plaintext) =>
        shortenManagerFrameAt(plaintext, secretHashOffset),
        "Manager handoff challenge hash must contain exactly 32 bytes"],
    ];
    for (const [transform, message] of secretCases) {
      const fresh = await managerHandoffFixture();
      fresh.state.crypto.hpkePlaintextTransform = transform;
      expect(await rejectedMessage(() => fresh.finalize())).toBe(message);
    }
  });

  test("mutation contract: manager target completion validator rejects every malformed coordinate and CAS field", async () => {
    const fixture = await managerHandoffFixture();
    const completion = await fixture.finalize();
    const malformedCompletion =
      "Agent Runtime manager handoff target completion is malformed";
    for (const value of [null, 42]) {
      expect(thrownMessage(() =>
        assertPreparedAgentRuntimeManagerHandoffTarget(value as never)
      )).toBe(malformedCompletion);
    }
    expect(thrownMessage(() =>
      assertPreparedAgentRuntimeManagerHandoffTarget({
        ...completion,
        unexpected: true,
      } as never)
    )).toBe(
      "Agent Runtime manager handoff target completion has an invalid field set",
    );
    const {
      targetReceiptSignature: _receipt,
      ...completionWithoutReceipt
    } = completion;
    expect(thrownMessage(() =>
      assertPreparedAgentRuntimeManagerHandoffTarget(
        completionWithoutReceipt as never,
      )
    )).toBe(
      "Agent Runtime manager handoff target completion has an invalid field set",
    );

    for (const envelopeBytes of [null, 42]) {
      expect(thrownMessage(() =>
        assertPreparedAgentRuntimeManagerHandoffTarget({
          ...completion,
          envelopeBytes: envelopeBytes as never,
        })
      )).toBe(
        "Agent Runtime manager handoff target envelope is malformed",
      );
    }
    expect(thrownMessage(() =>
      assertPreparedAgentRuntimeManagerHandoffTarget({
        ...completion,
        envelopeBytes: {
          ...completion.envelopeBytes,
          unexpected: true,
        } as never,
      })
    )).toBe(
      "Agent Runtime manager handoff target envelope has an invalid field set",
    );
    const malformedEnvelopes = [
      {
        ...completion.envelopeBytes,
        classification: "plaintext",
      },
      {
        ...completion.envelopeBytes,
        kind: "other-envelope",
      },
      {
        ...completion.envelopeBytes,
        ciphertext: null,
      },
      {
        ...completion.envelopeBytes,
        ciphertext:
          new Uint8Array(V2_LIMITS.wrappedDekBytes + 1),
      },
    ];
    for (const envelopeBytes of malformedEnvelopes) {
      expect(thrownMessage(() =>
        assertPreparedAgentRuntimeManagerHandoffTarget({
          ...completion,
          envelopeBytes,
        } as never)
      )).toBe(
        "Agent Runtime manager handoff target envelope is malformed",
      );
    }
    expect(thrownMessage(() =>
      assertPreparedAgentRuntimeManagerHandoffTarget({
        ...completion,
        envelopeBytes: {
          ...completion.envelopeBytes,
          ciphertext: new Uint8Array(V2_LIMITS.wrappedDekBytes),
        },
      })
    )).not.toBe(
      "Agent Runtime manager handoff target envelope is malformed",
    );

    const envelope = parseAgentRuntimeDomainEnvelope(
      completion.envelopeBytes.ciphertext,
    );
    const coordinateVariants = [
      { ...envelope, agentId: agentId("agent-other") },
      {
        ...envelope,
        runtimeGeneration: agentRuntimeGeneration(
          envelope.runtimeGeneration + 1,
        ),
      },
      { ...envelope, domainId: cryptoDomainId("domain-other") },
      {
        ...envelope,
        domainEpoch: domainEpoch(envelope.domainEpoch + 1),
      },
      {
        ...envelope,
        agentAuthorizationRevision: authorizationRevision(
          envelope.agentAuthorizationRevision + 1,
        ),
      },
      {
        ...envelope,
        committerDeviceId: cryptoDeviceId("device-other"),
      },
    ];
    for (const variant of coordinateVariants) {
      expect(thrownMessage(() =>
        assertPreparedAgentRuntimeManagerHandoffTarget({
          ...completion,
          envelopeBytes: {
            ...completion.envelopeBytes,
            ciphertext: serializeAgentRuntimeDomainEnvelope(variant),
          },
        })
      )).toBe(
        "Agent Runtime manager handoff target envelope coordinates are invalid",
      );
    }

    for (const challengeConsumption of [null, 42]) {
      expect(thrownMessage(() =>
        assertPreparedAgentRuntimeManagerHandoffTarget({
          ...completion,
          challengeConsumption: challengeConsumption as never,
        })
      )).toBe(
        "Agent Runtime manager handoff challenge consumption intent is malformed",
      );
    }
    expect(thrownMessage(() =>
      assertPreparedAgentRuntimeManagerHandoffTarget({
        ...completion,
        challengeConsumption: {
          ...completion.challengeConsumption,
          unexpected: true,
        } as never,
      })
    )).toBe(
      "Agent Runtime manager handoff challenge consumption intent has an invalid field set",
    );
    expect(thrownMessage(() =>
      assertPreparedAgentRuntimeManagerHandoffTarget({
        ...completion,
        challengeConsumption: {
          ...completion.challengeConsumption,
          challengeHash: bytes(1, 31),
        },
      })
    )).toBe(
      "Agent Runtime manager handoff challenge consumption hash must contain exactly 32 bytes",
    );
    for (const challengeConsumption of [
      {
        ...completion.challengeConsumption,
        expectedConsumed: true,
      },
      {
        ...completion.challengeConsumption,
        intendedConsumed: false,
      },
    ]) {
      expect(thrownMessage(() =>
        assertPreparedAgentRuntimeManagerHandoffTarget({
          ...completion,
          challengeConsumption,
        } as never)
      )).toBe(
        "Agent Runtime manager handoff challenge consumption intent is invalid",
      );
    }
    expect(thrownMessage(() =>
      assertPreparedAgentRuntimeManagerHandoffTarget({
        ...completion,
        targetReceiptSignature: bytes(1, 63),
      })
    )).toBe(
      "Agent Runtime manager handoff target receipt signature must contain exactly 64 bytes",
    );
  });

  test("mutation contract: manager target verification authenticates and detaches both signatures", async () => {
    const fixture = await managerHandoffFixture();
    const completion = await fixture.finalize();
    const receiptOutput = fixture.state.crypto.signOutputs.at(-1)!;
    const receiptSnapshot = completion.targetReceiptSignature.slice();
    receiptOutput.fill(0);
    expect(completion.targetReceiptSignature).toEqual(receiptSnapshot);

    expect(thrownMessage(() =>
      verifyPreparedAgentRuntimeManagerHandoffTarget({
        crypto: fixture.state.crypto,
        value: completion,
        resolveCurrentTargetCommitter: () => null,
      })
    )).toBe(
      "Agent Runtime manager handoff target is not currently authorized",
    );

    const envelope = parseAgentRuntimeDomainEnvelope(
      completion.envelopeBytes.ciphertext,
    );
    const invalidEnvelopeSignature = envelope.signature.slice();
    invalidEnvelopeSignature[0] = invalidEnvelopeSignature[0]! ^ 1;
    expect(thrownMessage(() =>
      verifyPreparedAgentRuntimeManagerHandoffTarget({
        crypto: fixture.state.crypto,
        value: {
          ...completion,
          envelopeBytes: {
            ...completion.envelopeBytes,
            ciphertext: serializeAgentRuntimeDomainEnvelope({
              ...envelope,
              signature: invalidEnvelopeSignature,
            }),
          },
        },
        resolveCurrentTargetCommitter: fixture.state.targetAuthority,
      })
    )).toBe(
      "Agent Runtime manager handoff target envelope signature is invalid",
    );
    const invalidReceipt = completion.targetReceiptSignature.slice();
    invalidReceipt[0] = invalidReceipt[0]! ^ 1;
    expect(thrownMessage(() =>
      verifyPreparedAgentRuntimeManagerHandoffTarget({
        crypto: fixture.state.crypto,
        value: {
          ...completion,
          targetReceiptSignature: invalidReceipt,
        },
        resolveCurrentTargetCommitter: fixture.state.targetAuthority,
      })
    )).toBe(
      "Agent Runtime manager handoff target receipt signature is invalid",
    );

    const verified = verifyPreparedAgentRuntimeManagerHandoffTarget({
      crypto: fixture.state.crypto,
      value: completion,
      resolveCurrentTargetCommitter: fixture.state.targetAuthority,
    });
    const envelopeSnapshot = verified.envelopeBytes.ciphertext.slice();
    const hashSnapshot =
      verified.challengeConsumption.challengeHash.slice();
    const verifiedReceipt = verified.targetReceiptSignature.slice();
    completion.envelopeBytes.ciphertext.fill(0);
    completion.challengeConsumption.challengeHash.fill(0);
    completion.targetReceiptSignature.fill(0);
    expect(verified.envelopeBytes.ciphertext).toEqual(envelopeSnapshot);
    expect(verified.challengeConsumption.challengeHash).toEqual(
      hashSnapshot,
    );
    expect(verified.targetReceiptSignature).toEqual(verifiedReceipt);
    expect(verified.envelopeBytes.kind).toBe(
      "agent-runtime-domain-envelope",
    );

    const bufferedTarget = await managerHandoffFixture();
    const bufferedEphemeral = Buffer.from(
      bufferedTarget.ephemeral.privateKey,
    );
    const bufferedRoot = Buffer.from(bytes(0x31));
    const bufferedSigning = Buffer.from(
      bufferedTarget.state.targetSigningA.privateKey,
    );
    const pendingBufferedTarget =
      prepareAgentRuntimeManagerHandoffTarget({
        crypto: bufferedTarget.state.crypto,
        challengeBytes: bufferedTarget.challenge.challengeBytes,
        responseBytes: bufferedTarget.response,
        expectedPlan: bufferedTarget.plan,
        trustedChallengeState: {
          challengeHash: bufferedTarget.challenge.challengeHash,
          consumed: false,
        },
        targetEphemeralPrivateKey: bufferedEphemeral,
        targetDomainRoot: bufferedRoot,
        targetCommitterSigningPrivateKey: bufferedSigning,
        resolveCurrentManagerAuthority:
          bufferedTarget.state.managerAuthority,
        resolveCurrentTargetCommitter:
          bufferedTarget.state.targetAuthority,
      });
    bufferedEphemeral.fill(0);
    bufferedRoot.fill(0);
    bufferedSigning.fill(0);
    expect(
      (await pendingBufferedTarget).challengeConsumption.intendedConsumed,
    ).toBeTrue();
  });

  test("validates every public config rewrap boundary before target completion", () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const aggregate = (overrides: Record<string, unknown>) =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: {
          ...source.publicCandidate,
          ...overrides,
        } as never,
        completedTargets: [],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      });
    const expectCandidateError = (
      overrides: Record<string, unknown>,
      message: string,
    ) => expect(() => aggregate(overrides)).toThrow(message);
    const first = source.publicCandidate.configRewraps[0]!;
    const second = source.publicCandidate.configRewraps[1]!;

    expectCandidateError(
      { configRewraps: null },
      "Agent Runtime rotation public inventories must be arrays",
    );
    expectCandidateError(
      { targetIntents: null },
      "Agent Runtime rotation public inventories must be arrays",
    );
    expectCandidateError(
      {
        configRewraps: Array.from(
          { length: V2_LIMITS.batchItems + 1 },
          () => first,
        ),
      },
      "Agent Runtime config rewrap count exceeds the 256 limit",
    );
    expectCandidateError(
      { configRewraps: [null, second] },
      "Agent Runtime config rewrap must be an object",
    );
    expectCandidateError(
      {
        configRewraps: [{ ...first, unexpected: true }, second],
      },
      "Agent Runtime config rewrap has an invalid field set",
    );
    expectCandidateError(
      {
        configRewraps: [{
          expected: first.expected,
        }, second],
      },
      "Agent Runtime config rewrap has an invalid field set",
    );
    expectCandidateError(
      {
        configRewraps: [{
          ...first,
          expected: null,
        }, second],
      },
      "Agent Runtime config rewrap expectation must be an object",
    );
    expectCandidateError(
      {
        configRewraps: [{
          ...first,
          expected: { ...first.expected, unexpected: true },
        }, second],
      },
      "Agent Runtime config rewrap expectation has an invalid field set",
    );
    const { objectId: _missingObjectId, ...missingExpected } = first.expected;
    expectCandidateError(
      {
        configRewraps: [{
          ...first,
          expected: missingExpected,
        }, second],
      },
      "Agent Runtime config rewrap expectation has an invalid field set",
    );
    expectCandidateError(
      {
        configRewraps: [{
          ...first,
          nextWrappedDek: null,
        }, second],
      },
      "Agent Runtime config rewrap opaque ciphertext must be an object",
    );
    expectCandidateError(
      {
        configRewraps: [{
          ...first,
          nextWrappedDek: {
            ...first.nextWrappedDek,
            unexpected: true,
          },
        }, second],
      },
      "Agent Runtime config rewrap opaque ciphertext has an invalid field set",
    );
    const { kind: _missingKind, ...missingOpaque } = first.nextWrappedDek;
    expectCandidateError(
      {
        configRewraps: [{
          ...first,
          nextWrappedDek: missingOpaque,
        }, second],
      },
      "Agent Runtime config rewrap opaque ciphertext has an invalid field set",
    );

    for (const expected of [
      { ...first.expected, agentId: agentId("agent-other") },
      {
        ...first.expected,
        runtimeGeneration: agentRuntimeGeneration(6),
      },
      { ...first.expected, wrappedDekHash: null },
      { ...first.expected, wrappedDekHash: bytes(1, 31) },
    ]) {
      expectCandidateError(
        { configRewraps: [{ ...first, expected }, second] },
        "Agent Runtime config rewrap inventory is invalid",
      );
    }
    for (const nextWrappedDek of [
      { ...first.nextWrappedDek, classification: "plaintext" },
      { ...first.nextWrappedDek, kind: "other" },
      { ...first.nextWrappedDek, ciphertext: null },
      { ...first.nextWrappedDek, ciphertext: bytes(1, 39) },
      {
        ...first.nextWrappedDek,
        ciphertext: bytes(1, V2_LIMITS.wrappedDekBytes + 1),
      },
    ]) {
      expectCandidateError(
        { configRewraps: [{ ...first, nextWrappedDek }, second] },
        "Agent Runtime config rewrap inventory is invalid",
      );
    }
    for (const length of [40, V2_LIMITS.wrappedDekBytes]) {
      try {
        aggregate({
          configRewraps: [{
            ...first,
            nextWrappedDek: {
              ...first.nextWrappedDek,
              ciphertext: bytes(1, length),
            },
          }, second],
        });
        throw new Error("expected later candidate validation failure");
      } catch (error) {
        expect((error as Error).message).not.toBe(
          "Agent Runtime config rewrap inventory is invalid",
        );
      }
    }
    expectCandidateError(
      { configRewraps: [first, first] },
      "Agent Runtime config rewrap inventory is duplicate or unordered",
    );
    expectCandidateError(
      { configRewraps: [second, first] },
      "Agent Runtime config rewrap inventory is duplicate or unordered",
    );
    expectCandidateError(
      {
        configRewraps: [
          {
            ...first,
            expected: {
              ...first.expected,
              objectId: objectId("config-aa"),
            },
          },
          {
            ...second,
            expected: {
              ...second.expected,
              objectId: objectId("config-a"),
            },
          },
        ],
      },
      "Agent Runtime config rewrap inventory is duplicate or unordered",
    );
  });

  test("validates every public target intent coordinate and exact shape", () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const aggregate = (publicCandidate: unknown) =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: publicCandidate as never,
        completedTargets: [],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      });
    const withIntents = (targetIntents: readonly unknown[]) => ({
      ...source.publicCandidate,
      targetIntents,
    });
    const expectIntentError = (
      targetIntents: readonly unknown[],
      message: string,
    ) => expect(() => aggregate(withIntents(targetIntents))).toThrow(message);
    const first = source.publicCandidate.targetIntents[0]!;
    const second = source.publicCandidate.targetIntents[1]!;

    expect(() => aggregate(null)).toThrow(
      "Agent Runtime rotation public candidate must be an object",
    );
    expect(() =>
      aggregate({
        ...source.publicCandidate,
        unexpected: true,
      })
    ).toThrow(
      "Agent Runtime rotation public candidate has an invalid field set",
    );
    const {
      managerSignature: _missingSignature,
      ...missingCandidateField
    } = source.publicCandidate;
    expect(() => aggregate(missingCandidateField)).toThrow(
      "Agent Runtime rotation public candidate has an invalid field set",
    );
    expectIntentError(
      [first],
      "Agent Runtime target intent coverage is incomplete",
    );
    expectIntentError(
      [first, second, second],
      "Agent Runtime target intent coverage is incomplete",
    );
    expectIntentError(
      [null, second],
      "Agent Runtime target intent must be an object",
    );
    expectIntentError(
      [{ ...first, unexpected: true }, second],
      "Agent Runtime target intent has an invalid field set",
    );
    const { target: _missingTarget, ...missingIntentField } = first;
    expectIntentError(
      [missingIntentField, second],
      "Agent Runtime target intent has an invalid field set",
    );
    expectIntentError(
      [{ ...first, source: null }, second],
      "Agent Runtime target intent source must be an object",
    );
    expectIntentError(
      [{
        ...first,
        source: { ...first.source, unexpected: true },
      }, second],
      "Agent Runtime target intent source has an invalid field set",
    );
    const {
      managerDeviceId: _missingManagerDevice,
      ...missingSourceField
    } = first.source;
    expectIntentError(
      [{ ...first, source: missingSourceField }, second],
      "Agent Runtime target intent source has an invalid field set",
    );
    expectIntentError(
      [{ ...first, target: null }, second],
      "Agent Runtime target intent Domain must be an object",
    );
    expectIntentError(
      [{
        ...first,
        target: { ...first.target, unexpected: true },
      }, second],
      "Agent Runtime target intent Domain has an invalid field set",
    );
    const {
      committerDeviceId: _missingCommitter,
      ...missingTargetField
    } = first.target;
    expectIntentError(
      [{ ...first, target: missingTargetField }, second],
      "Agent Runtime target intent Domain has an invalid field set",
    );

    const invalidIntents = [
      { ...first, rotationManifestHash: null },
      { ...first, rotationManifestHash: bytes(1, 31) },
      { ...first, runtimeCommitment: null },
      { ...first, runtimeCommitment: bytes(1, 31) },
      { ...first, operationId: "operation-other" },
      { ...first, agentId: agentId("agent-other") },
      { ...first, runtimeGeneration: agentRuntimeGeneration(9) },
      { ...first, rotationManifestHash: bytes(0xff) },
      { ...first, runtimeCommitment: bytes(0xff) },
      {
        ...first,
        source: {
          ...first.source,
          managerHumanId: humanId("human-other"),
        },
      },
      {
        ...first,
        source: {
          ...first.source,
          managerAuthorizationRevision: authorizationRevision(10),
        },
      },
      {
        ...first,
        source: {
          ...first.source,
          managerDeviceId: cryptoDeviceId("device-other"),
        },
      },
      {
        ...first,
        target: {
          ...first.target,
          domainId: cryptoDomainId("domain-other"),
        },
      },
      {
        ...first,
        target: {
          ...first.target,
          domainEpoch: domainEpoch(5),
        },
      },
      {
        ...first,
        target: {
          ...first.target,
          agentAuthorizationRevision: authorizationRevision(13),
        },
      },
      {
        ...first,
        target: {
          ...first.target,
          committerDeviceId: cryptoDeviceId("device-other"),
        },
      },
    ];
    for (const intent of invalidIntents) {
      expectIntentError(
        [intent, second],
        "Agent Runtime target intent coordinates are invalid",
      );
    }
  });

  test("snapshots target intents before invoking authorization callbacks", async () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const first = await completeTarget(state, source, 0);
    const second = await completeTarget(state, source, 1);
    const mutableIntents = source.publicCandidate.targetIntents.map((intent) => ({
      ...intent,
      rotationManifestHash: intent.rotationManifestHash.slice(),
      runtimeCommitment: intent.runtimeCommitment.slice(),
      source: { ...intent.source },
      target: { ...intent.target },
    }));
    const candidate = aggregateAgentRuntimeRotationV2({
      crypto: state.crypto,
      publicCandidate: {
        ...source.publicCandidate,
        targetIntents: mutableIntents,
      },
      completedTargets: [first.completion, second.completion],
      resolveCurrentManagerAuthority: () => {
        mutableIntents[0]!.rotationManifestHash.fill(0xff);
        mutableIntents[0]!.runtimeCommitment.fill(0xff);
        mutableIntents[0]!.target.domainId = cryptoDomainId("domain-other");
        return state.managerSigning.publicKey;
      },
      resolveCurrentTargetCommitter: state.targetAuthority,
    });
    expect(candidate.domainEnvelopes).toHaveLength(2);
  });

  test("validates aggregate state, commitments, manager proof, and target list exactly", () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const aggregate = (
      publicCandidate: unknown,
      resolveCurrentManagerAuthority:
        ResolveCurrentAgentRuntimeManagerAuthorityV2 =
          state.managerAuthority,
      completedTargets: unknown = [],
    ) =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: publicCandidate as never,
        completedTargets: completedTargets as never,
        resolveCurrentManagerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      });
    const expectCandidateError = (
      publicCandidate: unknown,
      message: string,
      resolveCurrentManagerAuthority:
        ResolveCurrentAgentRuntimeManagerAuthorityV2 =
          state.managerAuthority,
      completedTargets: unknown = [],
    ) =>
      expect(() =>
        aggregate(
          publicCandidate,
          resolveCurrentManagerAuthority,
          completedTargets,
        )
      ).toThrow(message);

    expectCandidateError(
      {
        ...source.publicCandidate,
        plan: {
          ...source.publicCandidate.plan,
          runtimeRotationRequired: false,
          currentManager: null,
        },
      },
      "Agent Runtime rotation public candidate is inconsistent",
    );
    for (const nextState of [
      {
        ...source.publicCandidate.nextState,
        agentId: agentId("agent-other"),
      },
      {
        ...source.publicCandidate.nextState,
        authorizationRevision: authorizationRevision(22),
      },
      {
        ...source.publicCandidate.nextState,
        runtimeGeneration: agentRuntimeGeneration(9),
      },
    ]) {
      expectCandidateError(
        { ...source.publicCandidate, nextState },
        "Agent Runtime rotation public candidate is inconsistent",
      );
    }
    for (const [field, value, message] of [
      [
        "runtimeCommitment",
        null,
        "Agent Runtime rotation Runtime commitment must contain exactly 32 bytes",
      ],
      [
        "runtimeCommitment",
        bytes(1, 31),
        "Agent Runtime rotation Runtime commitment must contain exactly 32 bytes",
      ],
      [
        "manifestHash",
        null,
        "Agent Runtime rotation manifest hash must contain exactly 32 bytes",
      ],
      [
        "manifestHash",
        bytes(1, 31),
        "Agent Runtime rotation manifest hash must contain exactly 32 bytes",
      ],
      [
        "managerSignature",
        null,
        "Agent Runtime rotation manager signature must contain exactly 64 bytes",
      ],
      [
        "managerSignature",
        bytes(1, 63),
        "Agent Runtime rotation manager signature must contain exactly 64 bytes",
      ],
    ] as const) {
      expectCandidateError(
        { ...source.publicCandidate, [field]: value },
        message,
      );
    }
    expectCandidateError(
      {
        ...source.publicCandidate,
        plan: {
          ...source.publicCandidate.plan,
          activeConfigInventory: {
            ...source.publicCandidate.plan.activeConfigInventory,
            objectCount: 1,
          },
        },
      },
      "Agent Runtime config rewrap coverage does not match the committed inventory",
    );
    expectCandidateError(
      {
        ...source.publicCandidate,
        configRewraps: source.publicCandidate.configRewraps.map((
          rewrap,
          index,
        ) => index === 0
          ? {
            ...rewrap,
            expected: {
              ...rewrap.expected,
              wrappedDekHash: bytes(0xff),
            },
          }
          : rewrap),
      },
      "Agent Runtime config rewrap coverage does not match the committed inventory",
    );

    const invalidManifestHash = bytes(0xff);
    expectCandidateError(
      {
        ...source.publicCandidate,
        manifestHash: invalidManifestHash,
        targetIntents: source.publicCandidate.targetIntents.map((intent) => ({
          ...intent,
          rotationManifestHash: invalidManifestHash,
        })),
      },
      "Agent Runtime rotation manifest hash is invalid",
    );
    const partiallyMatchingManifestHash = bytes(0xff);
    partiallyMatchingManifestHash[0] = source.publicCandidate.manifestHash[0]!;
    expectCandidateError(
      {
        ...source.publicCandidate,
        manifestHash: partiallyMatchingManifestHash,
        targetIntents: source.publicCandidate.targetIntents.map((intent) => ({
          ...intent,
          rotationManifestHash: partiallyMatchingManifestHash,
        })),
      },
      "Agent Runtime rotation manifest hash is invalid",
    );
    expectCandidateError(
      {
        ...source.publicCandidate,
        managerSignature: bytes(0xff, 64),
      },
      "Agent Runtime rotation manager manifest signature is invalid",
    );
    expectCandidateError(
      source.publicCandidate,
      "Agent Runtime rotation manager is not currently authorized",
      () => null,
    );
    expectCandidateError(
      source.publicCandidate,
      "Current manager signing public key must contain exactly 32 bytes",
      () => bytes(1, 31),
    );
    expectCandidateError(
      source.publicCandidate,
      "Agent Runtime rotation manager manifest signature is invalid",
      () => state.targetSigningA.publicKey,
    );
    expectCandidateError(
      source.publicCandidate,
      "Completed Runtime targets must be an array",
      state.managerAuthority,
      null,
    );
  });

  test("uses separate manager-source and target devices without collocating roots", async () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const first = await completeTarget(state, source, 0);
    const second = await completeTarget(state, source, 1);
    const candidate = aggregateAgentRuntimeRotationV2({
      crypto: state.crypto,
      publicCandidate: source.publicCandidate,
      completedTargets: [first.completion, second.completion],
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    });
    expect(candidate.domainEnvelopes).toHaveLength(2);
    expect("runtime" in candidate).toBe(false);
    expect("domainRoot" in candidate).toBe(false);
    expect("privateKey" in candidate).toBe(false);

    const envelope = parseAgentRuntimeDomainEnvelope(
      candidate.domainEnvelopes[0]!.envelopeBytes.ciphertext,
    );
    const opened = openAgentRuntimeFromDomain({
      crypto: state.crypto,
      domainRoot: first.root,
      envelope,
      expected: envelope,
      resolveHistoricalCommitter: () => first.signing.publicKey,
    });
    expect(opened).toEqual(source.sourceLocal.runtime);
    opened.key.fill(0);
    destroyAgentRuntimeRotationSourceLocalV2(source.sourceLocal);
    expect(source.sourceLocal.runtime.key).toEqual(bytes(0));
  });

  test("aggregation rejects missing, duplicate, and reordered target completions", async () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const first = await completeTarget(state, source, 0);
    const second = await completeTarget(state, source, 1);
    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: source.publicCandidate,
        completedTargets: [first.completion],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow("Completed Runtime target coverage is incomplete");
    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: source.publicCandidate,
        completedTargets: [first.completion, first.completion],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow("Completed Runtime targets contain a duplicate");
    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: source.publicCandidate,
        completedTargets: [second.completion, first.completion],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow("Completed Runtime target order or coordinates are invalid");
  });

  test("manager handoff binds the exact manager revision, device, and fresh generation", async () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const intent = source.publicCandidate.targetIntents[0]!;
    const ephemeral = await state.crypto.generateEncryptionKeyPair();
    const challenge = prepareAgentRuntimeManagerHandoffChallenge({
      crypto: state.crypto,
      plan: intent,
      targetEphemeralPublicKey: ephemeral.publicKey,
      targetCommitterSigningPrivateKey: state.targetSigningA.privateKey,
      resolveCurrentTargetCommitter: state.targetAuthority,
      ttlMs: 60_000,
    });
    for (const expectedPlan of [
      {
        ...intent,
        source: {
          ...intent.source,
          managerAuthorizationRevision: authorizationRevision(10),
        },
      },
      {
        ...intent,
        source: {
          ...intent.source,
          managerDeviceId: cryptoDeviceId("device-other-manager"),
        },
      },
      {
        ...intent,
        runtimeGeneration: agentRuntimeGeneration(9),
      },
    ]) {
      expect(
        prepareAgentRuntimeManagerHandoffResponse({
          crypto: state.crypto,
          challengeBytes: challenge.challengeBytes,
          expectedPlan,
          freshRuntime: source.sourceLocal.runtime,
          managerSigningPrivateKey: state.managerSigning.privateKey,
          resolveCurrentManagerAuthority: state.managerAuthority,
          resolveCurrentTargetCommitter: state.targetAuthority,
        }),
      ).rejects.toThrow(/expected context|Fresh Runtime/);
    }
    expect(
      prepareAgentRuntimeManagerHandoffResponse({
        crypto: state.crypto,
        challengeBytes: challenge.challengeBytes,
        expectedPlan: intent,
        freshRuntime: source.sourceLocal.runtime,
        managerSigningPrivateKey: state.managerSigning.privateKey,
        resolveCurrentManagerAuthority: () => null,
        resolveCurrentTargetCommitter: state.targetAuthority,
      }),
    ).rejects.toThrow("manager");
  });

  test("zeroizes manager-source and target copies when HPKE or Domain sealing fails", async () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const intent = source.publicCandidate.targetIntents[0]!;
    const ephemeral = await state.crypto.generateEncryptionKeyPair();
    const challenge = prepareAgentRuntimeManagerHandoffChallenge({
      crypto: state.crypto,
      plan: intent,
      targetEphemeralPublicKey: ephemeral.publicKey,
      targetCommitterSigningPrivateKey: state.targetSigningA.privateKey,
      resolveCurrentTargetCommitter: state.targetAuthority,
      ttlMs: 60_000,
    });

    state.crypto.failNextSealTo = true;
    expect(
      prepareAgentRuntimeManagerHandoffResponse({
        crypto: state.crypto,
        challengeBytes: challenge.challengeBytes,
        expectedPlan: intent,
        freshRuntime: source.sourceLocal.runtime,
        managerSigningPrivateKey: state.managerSigning.privateKey,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      }),
    ).rejects.toThrow("injected HPKE");
    expect(state.crypto.hpkePlaintexts.at(-1)?.every((byte) => byte === 0))
      .toBe(true);
    expect(state.crypto.signingKeys.at(-1)?.every((byte) => byte === 0))
      .toBe(true);

    const response = await prepareAgentRuntimeManagerHandoffResponse({
      crypto: state.crypto,
      challengeBytes: challenge.challengeBytes,
      expectedPlan: intent,
      freshRuntime: source.sourceLocal.runtime,
      managerSigningPrivateKey: state.managerSigning.privateKey,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    });
    state.crypto.failNextAeadSeal = true;
    expect(
      prepareAgentRuntimeManagerHandoffTarget({
        crypto: state.crypto,
        challengeBytes: challenge.challengeBytes,
        responseBytes: response,
        expectedPlan: intent,
        trustedChallengeState: {
          challengeHash: challenge.challengeHash,
          consumed: false,
        },
        targetEphemeralPrivateKey: ephemeral.privateKey,
        targetDomainRoot: bytes(0x31),
        targetCommitterSigningPrivateKey:
          state.targetSigningA.privateKey,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      }),
    ).rejects.toThrow("injected aead");
    expect(
      state.crypto.hpkeOpenedPlaintexts.at(-1)?.every(
        (byte) => byte === 0,
      ),
    ).toBe(true);
    expect(state.crypto.sealingKeys.at(-1)?.every((byte) => byte === 0))
      .toBe(true);
    expect(state.crypto.signingKeys.at(-1)?.every((byte) => byte === 0))
      .toBe(true);
    expect(source.sourceLocal.runtime.key.some((byte) => byte !== 0))
      .toBe(true);
  });

  test("bounds active objects before randomness", () => {
    const state = setup();
    const calls = state.crypto.randomCalls;
    const first = state.activeConfigObjects[0];
    const tooMany = Array.from(
      { length: V2_LIMITS.batchItems + 1 },
      (_, index) => ({
        ...first,
        objectId: objectId(`config-${String(index).padStart(3, "0")}`),
      }),
    );
    expect(() =>
      prepareAgentRuntimeRotationSourceV2({
        crypto: state.crypto,
        currentState: state.currentState,
        currentRuntime: state.currentRuntime,
        plan: state.plan,
        activeConfigObjects: tooMany,
        resolveCurrentManagerAuthority: state.managerAuthority,
        managerSigningPrivateKey: state.managerSigning.privateKey,
      })
    ).toThrow("256");
    expect(state.crypto.randomCalls).toBe(calls);
  });

  test("requires exact committed coverage of the active config inventory", () => {
    const state = setup();
    const calls = state.crypto.randomCalls;
    for (const activeConfigObjects of [
      undefined,
      [state.activeConfigObjects[0]],
      [],
    ]) {
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: state.currentState,
          currentRuntime: state.currentRuntime,
          plan: state.plan,
          ...(activeConfigObjects === undefined
            ? {}
            : { activeConfigObjects }),
          resolveCurrentManagerAuthority: state.managerAuthority,
          managerSigningPrivateKey: state.managerSigning.privateKey,
        })
      ).toThrow(/inventory|required|coverage|commitment/);
    }
    expect(state.crypto.randomCalls).toBe(calls);
  });

  test("cryptographically rejects forged, replay-substituted, and mixed candidates", async () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const first = await completeTarget(state, source, 0);
    const second = await completeTarget(state, source, 1);
    const forkSource = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (forkSource.kind !== "rotated") throw new Error("expected fork rotation");
    const forkFirst = await completeTarget(state, forkSource, 0);
    const forkSecond = await completeTarget(state, forkSource, 1);

    const badReceipt = {
      ...first.completion,
      targetReceiptSignature: bytes(0, 64),
    };
    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: source.publicCandidate,
        completedTargets: [badReceipt, second.completion],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow(/receipt|signature/);

    const substitutedPublication = {
      ...source.publicCandidate.signerPublication,
      transitionCommitment:
        forkSource.publicCandidate.signerPublication
          .transitionCommitment.slice(),
    };
    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: {
          ...source.publicCandidate,
          signerPublication: substitutedPublication,
        },
        completedTargets: [first.completion, second.completion],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow(/signer publication|validated manifest/);

    const badChallenge = {
      ...first.completion,
      challengeConsumption: {
        ...first.completion.challengeConsumption,
        challengeHash: bytes(0xab),
      },
    };
    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: source.publicCandidate,
        completedTargets: [badChallenge, second.completion],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow(/receipt|signature/);

    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: source.publicCandidate,
        completedTargets: [forkFirst.completion, second.completion],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow(/intent|coordinates|manifest/);
    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: source.publicCandidate,
        completedTargets: [first.completion, forkSecond.completion],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow(
      "Completed Runtime target order or coordinates are invalid",
    );

    const mixedCandidate = {
      ...source.publicCandidate,
      configRewraps: source.publicCandidate.configRewraps.map((
        value,
        index,
      ) => index === 0
        ? {
          ...value,
          nextWrappedDek: {
            ...value.nextWrappedDek,
            ciphertext:
              forkSource.publicCandidate.configRewraps[0]!.nextWrappedDek
                .ciphertext,
          },
        }
        : value),
    };
    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: mixedCandidate,
        completedTargets: [first.completion, second.completion],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow(/manifest|signature/);
  });

  test("reconstructs an exact deeply detached atomic candidate", async () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const first = await completeTarget(state, source, 0);
    const second = await completeTarget(state, source, 1);
    const mutableExpectedState = { ...source.publicCandidate.expectedState };
    const mutableNextState = { ...source.publicCandidate.nextState };
    const mutableSignerPublication = {
      ...source.publicCandidate.signerPublication,
      signerPublicKey:
        source.publicCandidate.signerPublication.signerPublicKey.slice(),
      transitionCommitment:
        source.publicCandidate.signerPublication.transitionCommitment.slice(),
      managerSigningPublicKeyHash:
        source.publicCandidate.signerPublication
          .managerSigningPublicKeyHash.slice(),
      signature:
        source.publicCandidate.signerPublication.signature.slice(),
    };
    const mutablePlan = {
      ...source.publicCandidate.plan,
      currentManager: {
        ...source.publicCandidate.plan.currentManager!,
      },
      activeConfigInventory: {
        objectCount:
          source.publicCandidate.plan.activeConfigInventory.objectCount,
        digest:
          source.publicCandidate.plan.activeConfigInventory.digest.slice(),
      },
      remainingDomains: source.publicCandidate.plan.remainingDomains.map((
        value,
      ) => ({ ...value })),
    };
    const badPublicationSignature = {
      ...source.publicCandidate.signerPublication,
      signature: source.publicCandidate.signerPublication.signature.slice(),
    };
    badPublicationSignature.signature[0] =
      badPublicationSignature.signature[0]! ^ 1;
    expect(() => aggregateAgentRuntimeRotationV2({
      crypto: state.crypto,
      publicCandidate: {
        ...source.publicCandidate,
        signerPublication: badPublicationSignature,
      },
      completedTargets: [first.completion, second.completion],
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    })).toThrow("signer publication is invalid");
    const candidate = aggregateAgentRuntimeRotationV2({
      crypto: state.crypto,
      publicCandidate: {
        ...source.publicCandidate,
        plan: mutablePlan,
        expectedState: mutableExpectedState,
        nextState: mutableNextState,
        signerPublication: mutableSignerPublication,
      },
      completedTargets: [first.completion, second.completion],
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    });
    mutableExpectedState.runtimeGeneration = agentRuntimeGeneration(99);
    mutableNextState.authorizationRevision = authorizationRevision(99);
    mutablePlan.activeConfigInventory.digest.fill(0xff);
    mutableSignerPublication.signerPublicKey.fill(0xff);
    mutableSignerPublication.transitionCommitment.fill(0xff);
    mutableSignerPublication.managerSigningPublicKeyHash.fill(0xff);
    mutableSignerPublication.signature.fill(0xff);
    const expectedDomain = {
      ...candidate.domainEnvelopes[0]!.expectedDomain,
    };
    expect(candidate.domainEnvelopes[0]!.expectedDomain).toEqual(
      state.plan.remainingDomains[0]!,
    );
    mutablePlan.remainingDomains[0]!.domainEpoch = domainEpoch(99);
    expect(candidate.expectedState.runtimeGeneration).toBe(
      state.currentState.runtimeGeneration,
    );
    expect(candidate.nextState.authorizationRevision).toBe(
      state.plan.newAuthorizationRevision,
    );
    expect(Object.isFrozen(candidate.expectedState)).toBe(true);
    expect(Object.isFrozen(candidate.nextState)).toBe(true);
    expect(candidate.expectedConfigInventory.digest).toEqual(
      state.plan.activeConfigInventory.digest,
    );
    expect(candidate.publicCandidate.signerPublication).toEqual(
      source.publicCandidate.signerPublication,
    );
    expect(candidate.publicCandidate.signerPublication).not.toBe(
      mutableSignerPublication,
    );
    expect(candidate.domainEnvelopes[0]!.expectedDomain).toEqual(
      expectedDomain,
    );
    expect(candidate.domainEnvelopes.map((entry) =>
      entry.challengeConsumption
    )).toEqual([
      {
        challengeHash: first.completion.challengeConsumption.challengeHash,
        expectedConsumed: false,
        intendedConsumed: true,
      },
      {
        challengeHash: second.completion.challengeConsumption.challengeHash,
        expectedConsumed: false,
        intendedConsumed: true,
      },
    ]);
    const leakedKey = bytes(0x5a);
    const invalidExpected = {
      ...source.publicCandidate.configRewraps[0]!.expected,
      leakedKey,
    };
    const invalidCandidates = [
      {
        ...source.publicCandidate,
        leakedKey,
      },
      {
        ...source.publicCandidate,
        nextState: {
          ...source.publicCandidate.nextState,
          leakedKey,
        },
      },
      {
        ...source.publicCandidate,
        plan: {
          ...source.publicCandidate.plan,
          leakedKey,
        },
      },
      {
        ...source.publicCandidate,
        configRewraps: [
          {
            ...source.publicCandidate.configRewraps[0]!,
            expected: invalidExpected,
          },
          source.publicCandidate.configRewraps[1]!,
        ],
      },
    ];
    for (const publicCandidate of invalidCandidates) {
      expect(() =>
        aggregateAgentRuntimeRotationV2({
          crypto: state.crypto,
          publicCandidate,
          completedTargets: [first.completion, second.completion],
          resolveCurrentManagerAuthority: state.managerAuthority,
          resolveCurrentTargetCommitter: state.targetAuthority,
        })
      ).toThrow("field set");
    }

    expect(() =>
      aggregateAgentRuntimeRotationV2({
        crypto: state.crypto,
        publicCandidate: source.publicCandidate,
        completedTargets: [
          {
            ...first.completion,
            leakedKey,
          } as unknown as typeof first.completion,
          second.completion,
        ],
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      })
    ).toThrow("field set");

    const candidateHash =
      candidate.configRewraps[0]!.expected.wrappedDekHash.slice();
    source.publicCandidate.configRewraps[0]!.expected.wrappedDekHash.fill(0xff);
    expect(candidate.configRewraps[0]!.expected.wrappedDekHash).toEqual(
      candidateHash,
    );
  });

  test("validates every rotation source secret before inventory hashing or randomness", () => {
    const state = setup();
    const hashCalls = state.crypto.hashCalls;
    const randomCalls = state.crypto.randomCalls;
    for (const overrides of [
      {
        currentRuntime: {
          ...state.currentRuntime,
          unexpected: true,
        },
      },
      {
        currentRuntime: {
          ...state.currentRuntime,
          key: bytes(1, 31),
        },
      },
      {
        managerSigningPrivateKey: bytes(2, 31),
      },
    ]) {
      expect(() =>
        prepareAgentRuntimeRotationSourceV2({
          crypto: state.crypto,
          currentState: state.currentState,
          currentRuntime: state.currentRuntime,
          plan: state.plan,
          activeConfigObjects: state.activeConfigObjects,
          resolveCurrentManagerAuthority: state.managerAuthority,
          managerSigningPrivateKey: state.managerSigning.privateKey,
          ...overrides,
        })
      ).toThrow(/field set|32 bytes/);
      expect(state.crypto.hashCalls).toBe(hashCalls);
      expect(state.crypto.randomCalls).toBe(randomCalls);
    }
  });

  test("owns Buffer-backed handoff secrets before challenge crypto and zeroizes the copies", async () => {
    const state = setup();
    const source = prepareAgentRuntimeRotationSourceV2({
      crypto: state.crypto,
      currentState: state.currentState,
      currentRuntime: state.currentRuntime,
      plan: state.plan,
      activeConfigObjects: state.activeConfigObjects,
      resolveCurrentManagerAuthority: state.managerAuthority,
      managerSigningPrivateKey: state.managerSigning.privateKey,
    });
    if (source.kind !== "rotated") throw new Error("expected rotation");
    const intent = source.publicCandidate.targetIntents[0]!;
    const ephemeral = await state.crypto.generateEncryptionKeyPair();

    const signingCalls = state.crypto.signingKeys.length;
    expect(() =>
      prepareAgentRuntimeManagerHandoffChallenge({
        crypto: state.crypto,
        plan: intent,
        targetEphemeralPublicKey: ephemeral.publicKey,
        targetCommitterSigningPrivateKey: bytes(1, 31),
        resolveCurrentTargetCommitter: state.targetAuthority,
        ttlMs: 60_000,
      })
    ).toThrow("32 bytes");
    expect(state.crypto.signingKeys).toHaveLength(signingCalls);

    const challenge = prepareAgentRuntimeManagerHandoffChallenge({
      crypto: state.crypto,
      plan: intent,
      targetEphemeralPublicKey: ephemeral.publicKey,
      targetCommitterSigningPrivateKey: state.targetSigningA.privateKey,
      resolveCurrentTargetCommitter: state.targetAuthority,
      ttlMs: 60_000,
    });
    for (const overrides of [
      {
        freshRuntime: {
          ...source.sourceLocal.runtime,
          key: bytes(1, 31),
        },
      },
      {
        managerSigningPrivateKey: bytes(1, 31),
      },
    ]) {
      const verifyCalls = state.crypto.verifyCalls;
      expect(
        prepareAgentRuntimeManagerHandoffResponse({
          crypto: state.crypto,
          challengeBytes: challenge.challengeBytes,
          expectedPlan: intent,
          freshRuntime: source.sourceLocal.runtime,
          managerSigningPrivateKey: state.managerSigning.privateKey,
          resolveCurrentManagerAuthority: state.managerAuthority,
          resolveCurrentTargetCommitter: state.targetAuthority,
          ...overrides,
        }),
      ).rejects.toThrow("32 bytes");
      expect(state.crypto.verifyCalls).toBe(verifyCalls);
    }

    const response = await prepareAgentRuntimeManagerHandoffResponse({
      crypto: state.crypto,
      challengeBytes: challenge.challengeBytes,
      expectedPlan: intent,
      freshRuntime: source.sourceLocal.runtime,
      managerSigningPrivateKey: state.managerSigning.privateKey,
      resolveCurrentManagerAuthority: state.managerAuthority,
      resolveCurrentTargetCommitter: state.targetAuthority,
    });
    for (const overrides of [
      { targetEphemeralPrivateKey: bytes(1, 31) },
      { targetDomainRoot: bytes(1, 31) },
      { targetCommitterSigningPrivateKey: bytes(1, 31) },
    ]) {
      const verifyCalls = state.crypto.verifyCalls;
      expect(
        prepareAgentRuntimeManagerHandoffTarget({
          crypto: state.crypto,
          challengeBytes: challenge.challengeBytes,
          responseBytes: response,
          expectedPlan: intent,
          trustedChallengeState: {
            challengeHash: challenge.challengeHash,
            consumed: false,
          },
          targetEphemeralPrivateKey: ephemeral.privateKey,
          targetDomainRoot: bytes(0x31),
          targetCommitterSigningPrivateKey:
            state.targetSigningA.privateKey,
          resolveCurrentManagerAuthority: state.managerAuthority,
          resolveCurrentTargetCommitter: state.targetAuthority,
          ...overrides,
        }),
      ).rejects.toThrow("32 bytes");
      expect(state.crypto.verifyCalls).toBe(verifyCalls);
    }

    const bufferedRuntimeKey = Buffer.from(source.sourceLocal.runtime.key);
    const bufferedManagerKey = Buffer.from(state.managerSigning.privateKey);
    const pendingResponse =
      prepareAgentRuntimeManagerHandoffResponse({
        crypto: state.crypto,
        challengeBytes: challenge.challengeBytes,
        expectedPlan: intent,
        freshRuntime: {
          ...source.sourceLocal.runtime,
          key: bufferedRuntimeKey,
        },
        managerSigningPrivateKey: bufferedManagerKey,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      });
    bufferedRuntimeKey.fill(0);
    bufferedManagerKey.fill(0);
    expect((await pendingResponse).length).toBeGreaterThan(0);
    expect(Buffer.isBuffer(state.crypto.signingKeys.at(-1))).toBeFalse();
    expect(
      state.crypto.signingKeys.at(-1)?.every((byte) => byte === 0),
    ).toBeTrue();

    const bufferedEphemeral = Buffer.from(ephemeral.privateKey);
    const bufferedRoot = Buffer.from(bytes(0x31));
    const bufferedTargetSigning = Buffer.from(
      state.targetSigningA.privateKey,
    );
    const pendingTarget =
      prepareAgentRuntimeManagerHandoffTarget({
        crypto: state.crypto,
        challengeBytes: challenge.challengeBytes,
        responseBytes: response,
        expectedPlan: intent,
        trustedChallengeState: {
          challengeHash: challenge.challengeHash,
          consumed: false,
        },
        targetEphemeralPrivateKey: bufferedEphemeral,
        targetDomainRoot: bufferedRoot,
        targetCommitterSigningPrivateKey: bufferedTargetSigning,
        resolveCurrentManagerAuthority: state.managerAuthority,
        resolveCurrentTargetCommitter: state.targetAuthority,
      });
    bufferedEphemeral.fill(0);
    bufferedRoot.fill(0);
    bufferedTargetSigning.fill(0);
    expect(
      (await pendingTarget).challengeConsumption.intendedConsumed,
    ).toBeTrue();
    expect(Buffer.isBuffer(state.crypto.hpkeOpeningKeys.at(-1))).toBeFalse();
    expect(
      state.crypto.hpkeOpeningKeys.at(-1)?.every((byte) => byte === 0),
    ).toBeTrue();
  });
});
