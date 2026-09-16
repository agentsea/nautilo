import { describe, expect, test } from "bun:test";
import { LatticeCrypto, manualClock, seededRng } from "../../src/crypto/index.ts";
import {
  openAgentRuntimeFromDomain,
  sealAgentRuntimeToDomain,
} from "../../src/agent-runtime/domain-envelope.ts";
import {
  AGENT_RUNTIME_HANDOFF_DOMAIN,
  prepareAgentRuntimeHandoffChallenge,
  prepareAgentRuntimeHandoffResponse,
  prepareAgentRuntimeHandoffTarget,
  type AgentRuntimeHandoffPlanV1,
  type CurrentAgentRuntimeHandoffCommitterResolverV1,
} from "../../src/agent-runtime/runtime-handoff-v2.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
} from "../../src/format/v2-primitives.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

class CaptureCrypto extends LatticeCrypto {
  sealedHandoffPlaintext: Uint8Array | null = null;
  openedHandoffPlaintext: Uint8Array | null = null;
  failSealToAfterEncrypt = false;
  failAeadSeal = false;
  randomBytesLength: number | null = null;
  reuseHashOutput = false;
  private readonly sharedHashOutput = new Uint8Array(32);
  sealToResultLength: number | null = null;
  openedPlaintextTransform:
    ((plaintext: Uint8Array) => Uint8Array) | null = null;
  afterSealTo: (() => void) | null = null;
  afterOpenSealed: (() => void) | null = null;
  captureSigningKey = false;
  capturedSigningKey: Uint8Array | null = null;
  capturedOpenPrivateKey: Uint8Array | null = null;
  readonly signedMessages: Uint8Array[] = [];

  override randomBytes(length: number): Uint8Array {
    return super.randomBytes(this.randomBytesLength ?? length);
  }

  override hash(value: Uint8Array): Uint8Array {
    const digest = super.hash(value);
    if (!this.reuseHashOutput) return digest;
    this.sharedHashOutput.set(digest);
    return this.sharedHashOutput;
  }

  override aeadSeal(
    key: Uint8Array,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array {
    if (this.failAeadSeal) throw new Error("forced target seal failure");
    return super.aeadSeal(key, plaintext, aad);
  }

  override sign(
    privateKey: Uint8Array,
    message: Uint8Array,
  ): Uint8Array {
    this.signedMessages.push(message.slice());
    if (this.captureSigningKey) {
      this.capturedSigningKey = privateKey;
    }
    return super.sign(privateKey, message);
  }

  override async sealTo(
    recipientPublicKey: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    this.sealedHandoffPlaintext = plaintext;
    if (this.sealToResultLength !== null) {
      return new Uint8Array(this.sealToResultLength);
    }
    const sealed = await super.sealTo(recipientPublicKey, plaintext);
    this.afterSealTo?.();
    if (this.failSealToAfterEncrypt) {
      throw new Error("forced HPKE seal failure");
    }
    return sealed;
  }

  override async openSealed(
    recipientPrivateKey: Uint8Array,
    sealed: Uint8Array,
  ): Promise<Uint8Array | null> {
    this.capturedOpenPrivateKey = recipientPrivateKey;
    const opened = await super.openSealed(recipientPrivateKey, sealed);
    this.afterOpenSealed?.();
    const plaintext = opened === null || this.openedPlaintextTransform === null
      ? opened
      : this.openedPlaintextTransform(opened);
    this.openedHandoffPlaintext = plaintext;
    return plaintext;
  }
}

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return haystack.some((_, offset) =>
    offset + needle.length <= haystack.length
    && needle.every((byte, index) => haystack[offset + index] === byte)
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

const textEncoder = new TextEncoder();

function frameSize(text: string): number {
  return 4 + textEncoder.encode(text).length;
}

function contextWireSize(
  context: AgentRuntimeHandoffPlanV1["source"],
): number {
  return frameSize(context.domainId) + 8 + 8
    + frameSize(context.committerDeviceId);
}

function planWireSize(plan: AgentRuntimeHandoffPlanV1): number {
  return frameSize(plan.operationId) + frameSize(plan.agentId) + 8
    + contextWireSize(plan.source) + contextWireSize(plan.target);
}

function messagePrefixSize(kind: string): number {
  return frameSize(AGENT_RUNTIME_HANDOFF_DOMAIN) + frameSize(kind) + 4;
}

function shortenFrameAt(bytes: Uint8Array, offset: number): Uint8Array {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const length = view.getUint32(offset, false);
  if (length < 1) throw new Error("Cannot shorten an empty frame");
  return concatV2(
    bytes.slice(0, offset),
    encodeU32(length - 1),
    bytes.slice(offset + 4, offset + 4 + length - 1),
    bytes.slice(offset + 4 + length),
  );
}

function replaceU64At(
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array {
  return concatV2(
    bytes.slice(0, offset),
    encodeU64(value),
    bytes.slice(offset + 8),
  );
}

function corruptTextAt(bytes: Uint8Array, frameOffset: number): Uint8Array {
  const copy = bytes.slice();
  copy[frameOffset + 4] = copy[frameOffset + 4]! ^ 1;
  return copy;
}

function lastIndexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
): number {
  for (
    let offset = haystack.length - needle.length;
    offset >= 0;
    offset -= 1
  ) {
    if (needle.every((byte, index) =>
      haystack[offset + index] === byte
    )) return offset;
  }
  return -1;
}

async function setup() {
  const clock = manualClock(1_000_000);
  const crypto = new CaptureCrypto(seededRng(0x2258), clock);
  const sourceSigning = crypto.generateSigningKeyPair();
  const targetSigning = crypto.generateSigningKeyPair();
  const targetEphemeral = await crypto.generateEncryptionKeyPair();
  const plan: AgentRuntimeHandoffPlanV1 = {
    operationId: "operation_runtime_handoff_1",
    agentId: agentId("agent_genie"),
    runtimeGeneration: agentRuntimeGeneration(7),
    source: {
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(3),
      agentAuthorizationRevision: authorizationRevision(11),
      committerDeviceId: cryptoDeviceId("device_alice"),
    },
    target: {
      domainId: cryptoDomainId("domain_bc"),
      domainEpoch: domainEpoch(5),
      agentAuthorizationRevision: authorizationRevision(13),
      committerDeviceId: cryptoDeviceId("device_bob"),
    },
  };
  const runtime = {
    agentId: plan.agentId,
    keyClass: "runtime" as const,
    generation: plan.runtimeGeneration,
    key: bytes(0x47),
  };
  const sourceDomainRoot = bytes(0x31);
  const targetDomainRoot = bytes(0x52);
  const currentCommitter:
    CurrentAgentRuntimeHandoffCommitterResolverV1 = ({ role }) =>
      role === "source" ? sourceSigning.publicKey : targetSigning.publicKey;

  const challenge = prepareAgentRuntimeHandoffChallenge({
    crypto,
    plan,
    targetEphemeralPublicKey: targetEphemeral.publicKey,
    targetCommitterSigningPrivateKey: targetSigning.privateKey,
    resolveCurrentCommitter: currentCommitter,
    ttlMs: 60_000,
  });
  const sourceEnvelope = sealAgentRuntimeToDomain({
    crypto,
    domainRoot: sourceDomainRoot,
    runtime,
    context: plan.source,
    committerSigningPrivateKey: sourceSigning.privateKey,
    currentCommitterAuthorized: () => true,
  });
  const response = await prepareAgentRuntimeHandoffResponse({
    crypto,
    challengeBytes: challenge.challengeBytes,
    expectedPlan: plan,
    sourceDomainRoot,
    sourceEnvelope,
    resolveHistoricalSourceCommitter: () => sourceSigning.publicKey,
    sourceCommitterSigningPrivateKey: sourceSigning.privateKey,
    resolveCurrentCommitter: currentCommitter,
  });

  return {
    crypto,
    clock,
    plan,
    runtime,
    sourceSigning,
    targetSigning,
    targetEphemeral,
    sourceDomainRoot,
    targetDomainRoot,
    sourceEnvelope,
    challenge,
    response,
    currentCommitter,
  };
}

async function finalize(state: Awaited<ReturnType<typeof setup>>, overrides?: {
  readonly challengeBytes?: Uint8Array;
  readonly responseBytes?: Uint8Array;
  readonly expectedPlan?: AgentRuntimeHandoffPlanV1;
  readonly consumed?: boolean;
  readonly challengeHash?: Uint8Array;
  readonly targetEphemeralPrivateKey?: Uint8Array;
  readonly resolveCurrentCommitter?:
    CurrentAgentRuntimeHandoffCommitterResolverV1;
}) {
  return prepareAgentRuntimeHandoffTarget({
    crypto: state.crypto,
    challengeBytes:
      overrides?.challengeBytes ?? state.challenge.challengeBytes,
    responseBytes: overrides?.responseBytes ?? state.response,
    expectedPlan: overrides?.expectedPlan ?? state.plan,
    trustedChallengeState: {
      challengeHash:
        overrides?.challengeHash ?? state.challenge.challengeHash,
      consumed: overrides?.consumed ?? false,
    },
    targetEphemeralPrivateKey:
      overrides?.targetEphemeralPrivateKey
      ?? state.targetEphemeral.privateKey,
    targetDomainRoot: state.targetDomainRoot,
    targetCommitterSigningPrivateKey: state.targetSigning.privateKey,
    resolveCurrentCommitter:
      overrides?.resolveCurrentCommitter ?? state.currentCommitter,
  });
}

describe("operation-bound cross-Domain Agent Runtime HPKE handoff", () => {
  test("transfers one exact Runtime generation between separate current committers", async () => {
    const state = await setup();
    const prepared = await finalize(state);

    const opened = openAgentRuntimeFromDomain({
      crypto: state.crypto,
      domainRoot: state.targetDomainRoot,
      envelope: prepared.targetEnvelope,
      expected: {
        agentId: state.plan.agentId,
        domainId: state.plan.target.domainId,
        domainEpoch: state.plan.target.domainEpoch,
        agentAuthorizationRevision:
          state.plan.target.agentAuthorizationRevision,
        runtimeGeneration: state.plan.runtimeGeneration,
        committerDeviceId: state.plan.target.committerDeviceId,
      },
      resolveHistoricalCommitter: () => state.targetSigning.publicKey,
    });

    expect(opened).toEqual(state.runtime);
    expect(prepared.challengeConsumption).toEqual({
      challengeHash: state.challenge.challengeHash,
      expectedConsumed: false,
      intendedConsumed: true,
    });
    expect(includesBytes(state.challenge.challengeBytes, state.runtime.key))
      .toBe(false);
    expect(includesBytes(state.response, state.runtime.key)).toBe(false);
    expect(state.plan.source.committerDeviceId).not.toBe(
      state.plan.target.committerDeviceId,
    );
  });

  test("uses the locked v1 handoff domain and exposes only opaque relay bytes", async () => {
    const state = await setup();

    expect(AGENT_RUNTIME_HANDOFF_DOMAIN).toBe(
      "nautilo/lattice-crypto/agent-runtime-handoff/v1",
    );
    expect(state.challenge.challengeBytes).toBeInstanceOf(Uint8Array);
    expect(state.response).toBeInstanceOf(Uint8Array);
    for (const secret of [
      state.runtime.key,
      state.sourceDomainRoot,
      state.targetDomainRoot,
      state.sourceSigning.privateKey,
      state.targetSigning.privateKey,
      state.targetEphemeral.privateKey,
    ]) {
      expect(includesBytes(state.challenge.challengeBytes, secret)).toBe(false);
      expect(includesBytes(state.response, secret)).toBe(false);
    }
  });

  test("domain-separates current-committer authority proofs", async () => {
    const state = await setup();

    for (const label of ["authority-proof", "committer"]) {
      const encoded = new TextEncoder().encode(label);
      expect(
        state.crypto.signedMessages.some((message) =>
          includesBytes(message, encoded)
        ),
      ).toBe(true);
    }
  });

  test("requires both exact current committer authorities at every receiving boundary", async () => {
    const state = await setup();
    expect(
      prepareAgentRuntimeHandoffResponse({
        crypto: state.crypto,
        challengeBytes: state.challenge.challengeBytes,
        expectedPlan: state.plan,
        sourceDomainRoot: state.sourceDomainRoot,
        sourceEnvelope: state.sourceEnvelope,
        resolveHistoricalSourceCommitter: () =>
          state.sourceSigning.publicKey,
        sourceCommitterSigningPrivateKey: state.sourceSigning.privateKey,
        resolveCurrentCommitter: ({ role }) =>
          role === "source" ? null : state.targetSigning.publicKey,
      }),
    ).rejects.toThrow("source committer");

    expect(
      finalize(state, {
        resolveCurrentCommitter: ({ role }) =>
          role === "target" ? state.targetSigning.publicKey : null,
      }),
    ).rejects.toThrow("source committer");
    expect(
      finalize(state, {
        resolveCurrentCommitter: ({ role }) =>
          role === "source" ? state.sourceSigning.publicKey : null,
      }),
    ).rejects.toThrow("target committer");
  });

  test("rejects stale challenges and caller-trusted consumed challenge state", async () => {
    const state = await setup();
    expect(finalize(state, { consumed: true })).rejects.toThrow(
      "already consumed",
    );
    expect(
      prepareAgentRuntimeHandoffTarget({
        crypto: state.crypto,
        challengeBytes: state.challenge.challengeBytes,
        responseBytes: state.response,
        expectedPlan: state.plan,
        trustedChallengeState: {
          challengeHash: state.challenge.challengeHash,
          consumed: undefined as never,
        },
        targetEphemeralPrivateKey: state.targetEphemeral.privateKey,
        targetDomainRoot: state.targetDomainRoot,
        targetCommitterSigningPrivateKey: state.targetSigning.privateKey,
        resolveCurrentCommitter: state.currentCommitter,
      }),
    ).rejects.toThrow("must be boolean");

    state.clock.advance(60_000);
    expect(finalize(state)).rejects.toThrow("stale");
  });

  test("requires a cross-Domain operation and physically separate committers", async () => {
    const state = await setup();
    expect(() =>
      prepareAgentRuntimeHandoffChallenge({
        crypto: state.crypto,
        plan: {
          ...state.plan,
          target: {
            ...state.plan.target,
            domainId: state.plan.source.domainId,
          },
        },
        targetEphemeralPublicKey: state.targetEphemeral.publicKey,
        targetCommitterSigningPrivateKey: state.targetSigning.privateKey,
        resolveCurrentCommitter: state.currentCommitter,
        ttlMs: 60_000,
      })
    ).toThrow("distinct");
    expect(() =>
      prepareAgentRuntimeHandoffChallenge({
        crypto: state.crypto,
        plan: {
          ...state.plan,
          target: {
            ...state.plan.target,
            committerDeviceId: state.plan.source.committerDeviceId,
          },
        },
        targetEphemeralPublicKey: state.targetEphemeral.publicKey,
        targetCommitterSigningPrivateKey: state.targetSigning.privateKey,
        resolveCurrentCommitter: state.currentCommitter,
        ttlMs: 60_000,
      })
    ).toThrow("separate");
  });

  test("binds operation, Agent, generation, both Domains, epochs, revisions, and devices", async () => {
    const state = await setup();
    const variants: AgentRuntimeHandoffPlanV1[] = [
      { ...state.plan, operationId: "operation_other" },
      { ...state.plan, agentId: agentId("agent_other") },
      {
        ...state.plan,
        runtimeGeneration: agentRuntimeGeneration(8),
      },
      {
        ...state.plan,
        source: {
          ...state.plan.source,
          domainId: cryptoDomainId("domain_ac"),
        },
      },
      {
        ...state.plan,
        source: {
          ...state.plan.source,
          domainEpoch: domainEpoch(4),
        },
      },
      {
        ...state.plan,
        source: {
          ...state.plan.source,
          agentAuthorizationRevision: authorizationRevision(12),
        },
      },
      {
        ...state.plan,
        source: {
          ...state.plan.source,
          committerDeviceId: cryptoDeviceId("device_anna"),
        },
      },
      {
        ...state.plan,
        target: {
          ...state.plan.target,
          domainId: cryptoDomainId("domain_cd"),
        },
      },
      {
        ...state.plan,
        target: {
          ...state.plan.target,
          domainEpoch: domainEpoch(6),
        },
      },
      {
        ...state.plan,
        target: {
          ...state.plan.target,
          agentAuthorizationRevision: authorizationRevision(14),
        },
      },
      {
        ...state.plan,
        target: {
          ...state.plan.target,
          committerDeviceId: cryptoDeviceId("device_bill"),
        },
      },
    ];

    for (const expectedPlan of variants) {
      expect(
        prepareAgentRuntimeHandoffResponse({
          crypto: state.crypto,
          challengeBytes: state.challenge.challengeBytes,
          expectedPlan,
          sourceDomainRoot: state.sourceDomainRoot,
          sourceEnvelope: state.sourceEnvelope,
          resolveHistoricalSourceCommitter: () =>
            state.sourceSigning.publicKey,
          sourceCommitterSigningPrivateKey: state.sourceSigning.privateKey,
          resolveCurrentCommitter: state.currentCommitter,
        }),
      ).rejects.toThrow("expected operation context");
    }
  });

  test("rejects source Runtime envelope and historical-authority substitution", async () => {
    const state = await setup();
    expect(
      prepareAgentRuntimeHandoffResponse({
        crypto: state.crypto,
        challengeBytes: state.challenge.challengeBytes,
        expectedPlan: state.plan,
        sourceDomainRoot: state.sourceDomainRoot,
        sourceEnvelope: {
          ...state.sourceEnvelope,
          domainEpoch: domainEpoch(state.sourceEnvelope.domainEpoch + 1),
        },
        resolveHistoricalSourceCommitter: () =>
          state.sourceSigning.publicKey,
        sourceCommitterSigningPrivateKey: state.sourceSigning.privateKey,
        resolveCurrentCommitter: state.currentCommitter,
      }),
    ).rejects.toThrow("current context");
    expect(
      prepareAgentRuntimeHandoffResponse({
        crypto: state.crypto,
        challengeBytes: state.challenge.challengeBytes,
        expectedPlan: state.plan,
        sourceDomainRoot: state.sourceDomainRoot,
        sourceEnvelope: state.sourceEnvelope,
        resolveHistoricalSourceCommitter: () => null,
        sourceCommitterSigningPrivateKey: state.sourceSigning.privateKey,
        resolveCurrentCommitter: state.currentCommitter,
      }),
    ).rejects.toThrow("absent");
  });

  test("rejects challenge, response, HPKE key, and trusted-state substitution", async () => {
    const first = await setup();
    const second = await setup();
    const tamperedChallenge = first.challenge.challengeBytes.slice();
    const signatureByte = tamperedChallenge.length - 1;
    tamperedChallenge[signatureByte] = tamperedChallenge[signatureByte]! ^ 1;
    expect(
      finalize(first, { challengeBytes: tamperedChallenge }),
    ).rejects.toThrow("signature");
    expect(
      finalize(first, { responseBytes: second.response }),
    ).rejects.toThrow("another challenge");
    expect(
      finalize(first, {
        challengeHash: second.challenge.challengeHash,
      }),
    ).rejects.toThrow("trusted");
    expect(
      finalize(first, {
        targetEphemeralPrivateKey: second.targetEphemeral.privateKey,
      }),
    ).rejects.toThrow("failed to decrypt");
  });

  test("rejects malformed and oversized relay inputs before HPKE", async () => {
    const state = await setup();
    expect(
      finalize(state, {
        challengeBytes: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
      }),
    ).rejects.toThrow("byte limit");
    expect(
      finalize(state, {
        responseBytes: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
      }),
    ).rejects.toThrow("byte limit");
    expect(
      finalize(state, {
        responseBytes: new Uint8Array([...state.response, 0]),
      }),
    ).rejects.toThrow("trailing bytes");
  });

  test("mutation contract: handoff foundation validates plans, keys, and authority context exactly", async () => {
    const state = await setup();
    const challengeInput = {
      crypto: state.crypto,
      plan: state.plan,
      targetEphemeralPublicKey: state.targetEphemeral.publicKey,
      targetCommitterSigningPrivateKey: state.targetSigning.privateKey,
      resolveCurrentCommitter: state.currentCommitter,
      ttlMs: 60_000,
    };

    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        plan: null as never,
      })
    )).toBe("Agent Runtime handoff plan must be an object");
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        plan: 42 as never,
      })
    )).toBe("Agent Runtime handoff plan must be an object");
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        plan: {
          ...state.plan,
          operationId: "not portable!",
        },
      })
    )).toBe(
      "Agent Runtime handoff operation id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        plan: {
          ...state.plan,
          source: null as never,
        },
      })
    )).toBe("Agent Runtime handoff Domain context must be an object");
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        plan: {
          ...state.plan,
          source: 42 as never,
        },
      })
    )).toBe("Agent Runtime handoff Domain context must be an object");
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        plan: {
          ...state.plan,
          source: {
            ...state.plan.source,
            unexpected: true,
          } as never,
        },
      })
    )).toBe(
      "Agent Runtime handoff Domain context has an invalid field set",
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        targetEphemeralPublicKey: bytes(1, 64),
      })
    )).toBe("Target ephemeral public key must contain exactly 65 bytes");
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        resolveCurrentCommitter: () => null,
      })
    )).toBe(
      "Agent Runtime handoff target committer is not currently authorized",
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        resolveCurrentCommitter: () =>
          bytes(1, V2_LIMITS.signingPublicKeyBytes - 1),
      })
    )).toBe(
      `Agent Runtime handoff target committer public key must contain exactly ${V2_LIMITS.signingPublicKeyBytes} bytes`,
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        resolveCurrentCommitter: () =>
          bytes(1, V2_LIMITS.signingPublicKeyBytes + 1),
      })
    )).toBe(
      `Agent Runtime handoff target committer public key must contain exactly ${V2_LIMITS.signingPublicKeyBytes} bytes`,
    );
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        targetCommitterSigningPrivateKey: bytes(1, 31),
      })
    )).toBe(
      "Agent Runtime handoff target signing private key must contain exactly 32 bytes",
    );
    const unrelated = state.crypto.generateSigningKeyPair();
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        targetCommitterSigningPrivateKey: unrelated.privateKey,
      })
    )).toBe(
      "Agent Runtime handoff target signing key does not match the current committer",
    );

    state.crypto.randomBytesLength = 31;
    expect(thrownMessage(() =>
      prepareAgentRuntimeHandoffChallenge(challengeInput)
    )).toBe(
      "Agent Runtime handoff random challenge must contain exactly 32 bytes",
    );
    state.crypto.randomBytesLength = null;

    const contexts: unknown[] = [];
    const challenge = prepareAgentRuntimeHandoffChallenge({
      ...challengeInput,
      resolveCurrentCommitter: (context) => {
        contexts.push(context);
        return state.targetSigning.publicKey;
      },
    });
    await prepareAgentRuntimeHandoffResponse({
      crypto: state.crypto,
      challengeBytes: challenge.challengeBytes,
      expectedPlan: state.plan,
      sourceDomainRoot: state.sourceDomainRoot,
      sourceEnvelope: state.sourceEnvelope,
      resolveHistoricalSourceCommitter: () =>
        state.sourceSigning.publicKey,
      sourceCommitterSigningPrivateKey: state.sourceSigning.privateKey,
      resolveCurrentCommitter: (context) => {
        contexts.push(context);
        return context.role === "source"
          ? state.sourceSigning.publicKey
          : state.targetSigning.publicKey;
      },
    });
    expect(contexts).toEqual([
      {
        purpose: "agent-runtime-handoff",
        role: "target",
        operationId: state.plan.operationId,
        agentId: state.plan.agentId,
        runtimeGeneration: state.plan.runtimeGeneration,
        ...state.plan.target,
        counterpartyDomainId: state.plan.source.domainId,
        counterpartyDeviceId: state.plan.source.committerDeviceId,
      },
      {
        purpose: "agent-runtime-handoff",
        role: "target",
        operationId: state.plan.operationId,
        agentId: state.plan.agentId,
        runtimeGeneration: state.plan.runtimeGeneration,
        ...state.plan.target,
        counterpartyDomainId: state.plan.source.domainId,
        counterpartyDeviceId: state.plan.source.committerDeviceId,
      },
      {
        purpose: "agent-runtime-handoff",
        role: "source",
        operationId: state.plan.operationId,
        agentId: state.plan.agentId,
        runtimeGeneration: state.plan.runtimeGeneration,
        ...state.plan.source,
        counterpartyDomainId: state.plan.target.domainId,
        counterpartyDeviceId: state.plan.target.committerDeviceId,
      },
    ]);

    state.crypto.reuseHashOutput = true;
    const detachedHashResponse =
      await prepareAgentRuntimeHandoffResponse({
        crypto: state.crypto,
        challengeBytes: state.challenge.challengeBytes,
        expectedPlan: state.plan,
        sourceDomainRoot: state.sourceDomainRoot,
        sourceEnvelope: state.sourceEnvelope,
        resolveHistoricalSourceCommitter: () =>
          state.sourceSigning.publicKey,
        sourceCommitterSigningPrivateKey:
          state.sourceSigning.privateKey,
        resolveCurrentCommitter: (context) => {
          if (context.role === "source") {
            state.crypto.hash(bytes(0xee));
            return state.sourceSigning.publicKey;
          }
          return state.targetSigning.publicKey;
        },
      });
    const detachedHashCompletion = await finalize(state, {
      responseBytes: detachedHashResponse,
    });
    expect(detachedHashCompletion).toBeDefined();
  });

  test("mutation contract: handoff foundation rejects malformed challenge, response, and secret fields", async () => {
    const state = await setup();
    const challengePrefix = messagePrefixSize("challenge");
    const nonceOffset = challengePrefix + planWireSize(state.plan);
    const ephemeralOffset = nonceOffset + 4 + 32 + 8 + 8;
    const signatureOffset = ephemeralOffset + 4
      + V2_LIMITS.hpkePublicKeyBytes;
    const challengeCases: readonly [Uint8Array, string][] = [
      [
        corruptTextAt(state.challenge.challengeBytes, 0),
        "invalid Agent Runtime handoff domain",
      ],
      [
        corruptTextAt(
          state.challenge.challengeBytes,
          frameSize(AGENT_RUNTIME_HANDOFF_DOMAIN),
        ),
        "invalid Agent Runtime handoff challenge kind",
      ],
      [
        shortenFrameAt(state.challenge.challengeBytes, nonceOffset),
        "Agent Runtime handoff challenge nonce must contain exactly 32 bytes",
      ],
      [
        shortenFrameAt(state.challenge.challengeBytes, ephemeralOffset),
        "Target ephemeral public key must contain exactly 65 bytes",
      ],
      [
        shortenFrameAt(state.challenge.challengeBytes, signatureOffset),
        "Target handoff signature must contain exactly 64 bytes",
      ],
    ];
    for (const [challengeBytes, message] of challengeCases) {
      expect(await rejectedMessage(() =>
        prepareAgentRuntimeHandoffResponse({
          crypto: state.crypto,
          challengeBytes,
          expectedPlan: state.plan,
          sourceDomainRoot: state.sourceDomainRoot,
          sourceEnvelope: state.sourceEnvelope,
          resolveHistoricalSourceCommitter: () =>
            state.sourceSigning.publicKey,
          sourceCommitterSigningPrivateKey:
            state.sourceSigning.privateKey,
          resolveCurrentCommitter: state.currentCommitter,
        })
      )).toBe(message);
    }

    const responseHashOffset = messagePrefixSize("response");
    const responseSignatureOffset = state.response.length
      - V2_LIMITS.signatureBytes - 4;
    const responseCases: readonly [Uint8Array, string][] = [
      [
        corruptTextAt(state.response, 0),
        "invalid Agent Runtime handoff domain",
      ],
      [
        corruptTextAt(
          state.response,
          frameSize(AGENT_RUNTIME_HANDOFF_DOMAIN),
        ),
        "invalid Agent Runtime handoff response kind",
      ],
      [
        shortenFrameAt(state.response, responseHashOffset),
        "Agent Runtime handoff challenge hash must contain exactly 32 bytes",
      ],
      [
        shortenFrameAt(state.response, responseSignatureOffset),
        "Source handoff signature must contain exactly 64 bytes",
      ],
    ];
    for (const [responseBytes, message] of responseCases) {
      expect(await rejectedMessage(() =>
        finalize(state, { responseBytes })
      )).toBe(message);
    }

    const secretHashOffset = messagePrefixSize("secret")
      + planWireSize(state.plan);
    const secretCases: readonly [
      (plaintext: Uint8Array) => Uint8Array,
      string,
    ][] = [
      [
        (plaintext) => corruptTextAt(plaintext, 0),
        "invalid Agent Runtime handoff secret domain",
      ],
      [
        (plaintext) =>
          corruptTextAt(
            plaintext,
            frameSize(AGENT_RUNTIME_HANDOFF_DOMAIN),
          ),
        "invalid Agent Runtime handoff secret kind",
      ],
      [
        (plaintext) => shortenFrameAt(plaintext, secretHashOffset),
        "Agent Runtime handoff challenge hash must contain exactly 32 bytes",
      ],
      [
        (plaintext) => {
          const copy = plaintext.slice();
          const operationOffset = messagePrefixSize("secret") + 4;
          copy[
            operationOffset
              + textEncoder.encode(state.plan.operationId).length - 1
          ] = "2".charCodeAt(0);
          return copy;
        },
        "Agent Runtime handoff secret does not match the challenge",
      ],
      [
        (plaintext) => {
          const copy = plaintext.slice();
          copy[secretHashOffset + 4] =
            copy[secretHashOffset + 4]! ^ 1;
          return copy;
        },
        "Agent Runtime handoff secret does not match the challenge",
      ],
      [
        (plaintext) => {
          const copy = plaintext.slice();
          const encodedAgent = textEncoder.encode(state.plan.agentId);
          const runtimeAgentOffset =
            lastIndexOfBytes(copy, encodedAgent);
          copy[runtimeAgentOffset + encodedAgent.length - 1] =
            "x".charCodeAt(0);
          return copy;
        },
        "Agent Runtime handoff secret does not match the challenge",
      ],
      [
        (plaintext) => {
          const copy = plaintext.slice();
          const encodedAgent = textEncoder.encode(state.plan.agentId);
          const runtimeAgentOffset =
            lastIndexOfBytes(copy, encodedAgent);
          const generationOffset =
            runtimeAgentOffset + encodedAgent.length;
          copy[generationOffset + 7] =
            copy[generationOffset + 7]! ^ 1;
          return copy;
        },
        "Agent Runtime handoff secret does not match the challenge",
      ],
    ];
    for (const [transform, message] of secretCases) {
      const fresh = await setup();
      fresh.crypto.openedPlaintextTransform = transform;
      expect(await rejectedMessage(() => finalize(fresh))).toBe(message);
    }
  });

  test("mutation contract: handoff foundation enforces every freshness and byte-limit boundary", async () => {
    const beforeCreation = await setup();
    beforeCreation.clock.set(999_999);
    expect(await rejectedMessage(() => finalize(beforeCreation))).toBe(
      "Agent Runtime handoff challenge is stale",
    );

    const atExpiry = await setup();
    atExpiry.clock.set(1_060_000);
    expect(await rejectedMessage(() => finalize(atExpiry))).toBe(
      "Agent Runtime handoff challenge is stale",
    );

    const state = await setup();
    const nonceOffset = messagePrefixSize("challenge")
      + planWireSize(state.plan);
    const createdOffset = nonceOffset + 4 + 32;
    const expiresOffset = createdOffset + 8;
    const zeroLifetime = replaceU64At(
      state.challenge.challengeBytes,
      expiresOffset,
      1_000_000,
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffResponse({
        crypto: state.crypto,
        challengeBytes: zeroLifetime,
        expectedPlan: state.plan,
        sourceDomainRoot: state.sourceDomainRoot,
        sourceEnvelope: state.sourceEnvelope,
        resolveHistoricalSourceCommitter: () =>
          state.sourceSigning.publicKey,
        sourceCommitterSigningPrivateKey: state.sourceSigning.privateKey,
        resolveCurrentCommitter: state.currentCommitter,
      })
    )).toBe("Agent Runtime handoff challenge lifetime is invalid");
    const excessiveLifetime = replaceU64At(
      state.challenge.challengeBytes,
      expiresOffset,
      1_000_000 + V2_LIMITS.grantTtlMs + 1,
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffResponse({
        crypto: state.crypto,
        challengeBytes: excessiveLifetime,
        expectedPlan: state.plan,
        sourceDomainRoot: state.sourceDomainRoot,
        sourceEnvelope: state.sourceEnvelope,
        resolveHistoricalSourceCommitter: () =>
          state.sourceSigning.publicKey,
        sourceCommitterSigningPrivateKey: state.sourceSigning.privateKey,
        resolveCurrentCommitter: state.currentCommitter,
      })
    )).toBe("Agent Runtime handoff challenge lifetime is invalid");

    state.clock.set(50_000_000);
    const maximumLifetime = prepareAgentRuntimeHandoffChallenge({
      crypto: state.crypto,
      plan: state.plan,
      targetEphemeralPublicKey: state.targetEphemeral.publicKey,
      targetCommitterSigningPrivateKey: state.targetSigning.privateKey,
      resolveCurrentCommitter: state.currentCommitter,
      ttlMs: V2_LIMITS.grantTtlMs,
    });
    const maximumLifetimeResponse =
      await prepareAgentRuntimeHandoffResponse({
      crypto: state.crypto,
      challengeBytes: maximumLifetime.challengeBytes,
      expectedPlan: state.plan,
      sourceDomainRoot: state.sourceDomainRoot,
      sourceEnvelope: state.sourceEnvelope,
      resolveHistoricalSourceCommitter: () =>
        state.sourceSigning.publicKey,
      sourceCommitterSigningPrivateKey: state.sourceSigning.privateKey,
      resolveCurrentCommitter: state.currentCommitter,
      });
    expect(maximumLifetimeResponse).toBeInstanceOf(Uint8Array);

    const exactLimit = new Uint8Array(V2_LIMITS.ciphertextBytes);
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffResponse({
        crypto: state.crypto,
        challengeBytes: exactLimit,
        expectedPlan: state.plan,
        sourceDomainRoot: state.sourceDomainRoot,
        sourceEnvelope: state.sourceEnvelope,
        resolveHistoricalSourceCommitter: () =>
          state.sourceSigning.publicKey,
        sourceCommitterSigningPrivateKey: state.sourceSigning.privateKey,
        resolveCurrentCommitter: state.currentCommitter,
      })
    )).toBe("invalid Agent Runtime handoff domain");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffResponse({
        crypto: state.crypto,
        challengeBytes: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
        expectedPlan: state.plan,
        sourceDomainRoot: state.sourceDomainRoot,
        sourceEnvelope: state.sourceEnvelope,
        resolveHistoricalSourceCommitter: () =>
          state.sourceSigning.publicKey,
        sourceCommitterSigningPrivateKey: state.sourceSigning.privateKey,
        resolveCurrentCommitter: state.currentCommitter,
      })
    )).toBe("Agent Runtime handoff challenge exceeds its byte limit");
    expect(createdOffset).toBeLessThan(expiresOffset);
  });

  test("mutation contract: handoff workflow validates clock, TTL, roots, keys, and trusted state exactly", async () => {
    const state = await setup();
    const challengeInput = {
      crypto: state.crypto,
      plan: state.plan,
      targetEphemeralPublicKey: state.targetEphemeral.publicKey,
      targetCommitterSigningPrivateKey: state.targetSigning.privateKey,
      resolveCurrentCommitter: state.currentCommitter,
      ttlMs: 60_000,
    };
    for (const [ttlMs, message] of [
      [0, `Agent Runtime handoff TTL must be between 1 and ${V2_LIMITS.grantTtlMs}`],
      [V2_LIMITS.grantTtlMs + 1,
        `Agent Runtime handoff TTL exceeds the ${V2_LIMITS.grantTtlMs} limit`],
    ] as const) {
      expect(thrownMessage(() =>
        prepareAgentRuntimeHandoffChallenge({
          ...challengeInput,
          ttlMs,
        })
      )).toBe(message);
    }
    for (const now of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
      state.clock.set(now);
      expect(thrownMessage(() =>
        prepareAgentRuntimeHandoffChallenge({
          ...challengeInput,
          ttlMs: 1,
        })
      )).toBe(
        "Agent Runtime handoff clock is outside the safe timestamp range",
      );
    }
    state.clock.set(0);
    expect(() =>
      prepareAgentRuntimeHandoffChallenge({
        ...challengeInput,
        ttlMs: 1,
      })
    ).not.toThrow();
    state.clock.set(1_000_000);

    state.crypto.reuseHashOutput = true;
    const ownedChallenge =
      prepareAgentRuntimeHandoffChallenge(challengeInput);
    const ownedHash = ownedChallenge.challengeHash.slice();
    state.crypto.hash(bytes(0xee));
    expect(ownedChallenge.challengeHash).toEqual(ownedHash);
    state.crypto.reuseHashOutput = false;

    const responseInput = {
      crypto: state.crypto,
      challengeBytes: state.challenge.challengeBytes,
      expectedPlan: state.plan,
      sourceDomainRoot: state.sourceDomainRoot,
      sourceEnvelope: state.sourceEnvelope,
      resolveHistoricalSourceCommitter: () =>
        state.sourceSigning.publicKey,
      sourceCommitterSigningPrivateKey:
        state.sourceSigning.privateKey,
      resolveCurrentCommitter: state.currentCommitter,
    };
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffResponse({
        ...responseInput,
        sourceDomainRoot: bytes(1, 31),
      })
    )).toBe("Source AI Domain root must contain exactly 32 bytes");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffResponse({
        ...responseInput,
        sourceCommitterSigningPrivateKey: bytes(1, 31),
      })
    )).toBe(
      "Agent Runtime handoff source signing private key must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffResponse({
        ...responseInput,
        sourceCommitterSigningPrivateKey:
          state.targetSigning.privateKey,
      })
    )).toBe(
      "Agent Runtime handoff source signing key does not match the current committer",
    );

    const targetBase = {
      crypto: state.crypto,
      challengeBytes: state.challenge.challengeBytes,
      responseBytes: state.response,
      expectedPlan: state.plan,
      trustedChallengeState: {
        challengeHash: state.challenge.challengeHash,
        consumed: false,
      },
      targetEphemeralPrivateKey: state.targetEphemeral.privateKey,
      targetDomainRoot: state.targetDomainRoot,
      targetCommitterSigningPrivateKey:
        state.targetSigning.privateKey,
      resolveCurrentCommitter: state.currentCommitter,
    };
    for (const trustedChallengeState of [null, 42]) {
      expect(await rejectedMessage(() =>
        prepareAgentRuntimeHandoffTarget({
          ...targetBase,
          trustedChallengeState: trustedChallengeState as never,
        })
      )).toBe(
        "trusted Agent Runtime handoff challenge state is required",
      );
    }
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffTarget({
        ...targetBase,
        trustedChallengeState: {
          challengeHash: bytes(1, 31),
          consumed: false,
        },
      })
    )).toBe(
      "Trusted Agent Runtime handoff challenge hash must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffTarget({
        ...targetBase,
        targetEphemeralPrivateKey: bytes(1, 31),
      })
    )).toBe(
      "Target ephemeral private key must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffTarget({
        ...targetBase,
        targetDomainRoot: bytes(1, 31),
      })
    )).toBe("Target AI Domain root must contain exactly 32 bytes");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffTarget({
        ...targetBase,
        targetCommitterSigningPrivateKey: bytes(1, 31),
      })
    )).toBe(
      "Agent Runtime handoff target signing private key must contain exactly 32 bytes",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffTarget({
        ...targetBase,
        targetCommitterSigningPrivateKey:
          state.sourceSigning.privateKey,
      })
    )).toBe(
      "Agent Runtime handoff target signing key does not match the current committer",
    );
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffTarget({
        ...targetBase,
        responseBytes: "response" as never,
      })
    )).toBe("Agent Runtime handoff response exceeds its byte limit");
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffTarget({
        ...targetBase,
        responseBytes: new Uint8Array(V2_LIMITS.ciphertextBytes),
      })
    )).toBe("invalid Agent Runtime handoff domain");

    const tamperedResponse = state.response.slice();
    const responseSignatureIndex = tamperedResponse.length - 1;
    tamperedResponse[responseSignatureIndex] =
      tamperedResponse[responseSignatureIndex]! ^ 1;
    expect(await rejectedMessage(() =>
      prepareAgentRuntimeHandoffTarget({
        ...targetBase,
        responseBytes: tamperedResponse,
      })
    )).toBe("Agent Runtime handoff response signature is invalid");

    const targetContexts: unknown[] = [];
    await prepareAgentRuntimeHandoffTarget({
      ...targetBase,
      resolveCurrentCommitter: (context) => {
        targetContexts.push(context);
        return context.role === "source"
          ? state.sourceSigning.publicKey
          : state.targetSigning.publicKey;
      },
    });
    expect(
      (targetContexts.at(-1) as { readonly role: unknown }).role,
    ).toBe("target");
  });

  test("mutation contract: handoff workflow bounds the complete response wire at the exact ceiling", async () => {
    const base = await setup();
    const responseFor = async (
      state: Awaited<ReturnType<typeof setup>>,
      sealedLength: number,
    ) => {
      state.crypto.sealToResultLength = sealedLength;
      return prepareAgentRuntimeHandoffResponse({
        crypto: state.crypto,
        challengeBytes: state.challenge.challengeBytes,
        expectedPlan: state.plan,
        sourceDomainRoot: state.sourceDomainRoot,
        sourceEnvelope: state.sourceEnvelope,
        resolveHistoricalSourceCommitter: () =>
          state.sourceSigning.publicKey,
        sourceCommitterSigningPrivateKey:
          state.sourceSigning.privateKey,
        resolveCurrentCommitter: state.currentCommitter,
      });
    };
    const emptySealedResponse = await responseFor(base, 0);
    const overhead = emptySealedResponse.length;

    const exact = await setup();
    const exactResponse = await responseFor(
      exact,
      V2_LIMITS.ciphertextBytes - overhead,
    );
    expect(exactResponse).toHaveLength(V2_LIMITS.ciphertextBytes);

    const oversized = await setup();
    expect(await rejectedMessage(() =>
      responseFor(
        oversized,
        V2_LIMITS.ciphertextBytes - overhead + 1,
      )
    )).toBe(
      "Agent Runtime handoff response exceeds its byte limit",
    );
  });

  test("returns detached target bytes and an explicit CAS consumption intent", async () => {
    const state = await setup();
    const prepared = await finalize(state);
    const originalCiphertext = prepared.targetEnvelope.ciphertext.slice();
    const originalHash = prepared.challengeConsumption.challengeHash.slice();

    state.challenge.challengeBytes.fill(0);
    state.challenge.challengeHash.fill(0);
    state.response.fill(0);
    state.targetDomainRoot.fill(0);

    expect(prepared.targetEnvelope.ciphertext).toEqual(originalCiphertext);
    expect(prepared.challengeConsumption.challengeHash).toEqual(originalHash);
    expect(prepared.challengeConsumption.expectedConsumed).toBe(false);
    expect(prepared.challengeConsumption.intendedConsumed).toBe(true);
  });

  test("zeroizes temporary HPKE plaintext on both handoff devices", async () => {
    const state = await setup();
    const sourcePlaintext = state.crypto.sealedHandoffPlaintext;
    expect(sourcePlaintext).not.toBeNull();
    expect(sourcePlaintext!.some((byte) => byte !== 0)).toBe(false);

    await finalize(state);
    const targetPlaintext = state.crypto.openedHandoffPlaintext;
    expect(targetPlaintext).not.toBeNull();
    expect(targetPlaintext!.some((byte) => byte !== 0)).toBe(false);
  });

  test("owns and wipes source signing authority across the HPKE await", async () => {
    const state = await setup();
    const callerKey = Buffer.from(state.sourceSigning.privateKey);
    state.crypto.captureSigningKey = true;
    state.crypto.capturedSigningKey = null;
    state.crypto.afterSealTo = () => callerKey.fill(0xff);

    const response = await prepareAgentRuntimeHandoffResponse({
      crypto: state.crypto,
      challengeBytes: state.challenge.challengeBytes,
      expectedPlan: state.plan,
      sourceDomainRoot: state.sourceDomainRoot,
      sourceEnvelope: state.sourceEnvelope,
      resolveHistoricalSourceCommitter: () =>
        state.sourceSigning.publicKey,
      sourceCommitterSigningPrivateKey: callerKey,
      resolveCurrentCommitter: state.currentCommitter,
    });
    const capturedSourceKey =
      state.crypto.capturedSigningKey as Uint8Array | null;
    state.crypto.afterSealTo = null;
    state.crypto.captureSigningKey = false;
    const prepared = await prepareAgentRuntimeHandoffTarget({
      crypto: state.crypto,
      challengeBytes: state.challenge.challengeBytes,
      responseBytes: response,
      expectedPlan: state.plan,
      trustedChallengeState: {
        challengeHash: state.challenge.challengeHash,
        consumed: false,
      },
      targetEphemeralPrivateKey: state.targetEphemeral.privateKey,
      targetDomainRoot: state.targetDomainRoot,
      targetCommitterSigningPrivateKey: state.targetSigning.privateKey,
      resolveCurrentCommitter: state.currentCommitter,
    });

    expect(prepared.challengeConsumption.intendedConsumed).toBe(true);
    expect(capturedSourceKey).not.toBeNull();
    expect(Buffer.isBuffer(capturedSourceKey)).toBeFalse();
    expect(
      capturedSourceKey!.every((byte) => byte === 0),
    ).toBe(true);
  });

  test("owns and wipes every target secret across the HPKE await", async () => {
    const state = await setup();
    const ephemeralKey = Buffer.from(state.targetEphemeral.privateKey);
    const domainRoot = Buffer.from(state.targetDomainRoot);
    const signingKey = Buffer.from(state.targetSigning.privateKey);
    state.crypto.captureSigningKey = true;
    state.crypto.capturedSigningKey = null;
    state.crypto.capturedOpenPrivateKey = null;
    state.crypto.afterOpenSealed = () => {
      ephemeralKey.fill(0xe1);
      domainRoot.fill(0xe2);
      signingKey.fill(0xe3);
    };

    const prepared = await prepareAgentRuntimeHandoffTarget({
      crypto: state.crypto,
      challengeBytes: state.challenge.challengeBytes,
      responseBytes: state.response,
      expectedPlan: state.plan,
      trustedChallengeState: {
        challengeHash: state.challenge.challengeHash,
        consumed: false,
      },
      targetEphemeralPrivateKey: ephemeralKey,
      targetDomainRoot: domainRoot,
      targetCommitterSigningPrivateKey: signingKey,
      resolveCurrentCommitter: state.currentCommitter,
    });
    const opened = openAgentRuntimeFromDomain({
      crypto: state.crypto,
      domainRoot: state.targetDomainRoot,
      envelope: prepared.targetEnvelope,
      expected: {
        agentId: state.plan.agentId,
        domainId: state.plan.target.domainId,
        domainEpoch: state.plan.target.domainEpoch,
        agentAuthorizationRevision:
          state.plan.target.agentAuthorizationRevision,
        runtimeGeneration: state.plan.runtimeGeneration,
        committerDeviceId: state.plan.target.committerDeviceId,
      },
      resolveHistoricalCommitter: () => state.targetSigning.publicKey,
    });

    expect(opened.key).toEqual(state.runtime.key);
    expect(state.crypto.capturedOpenPrivateKey).not.toBeNull();
    expect(Buffer.isBuffer(state.crypto.capturedOpenPrivateKey)).toBeFalse();
    expect(
      state.crypto.capturedOpenPrivateKey!.every((byte) => byte === 0),
    ).toBe(true);
    expect(state.crypto.capturedSigningKey).not.toBeNull();
    expect(Buffer.isBuffer(state.crypto.capturedSigningKey)).toBeFalse();
    expect(
      state.crypto.capturedSigningKey!.every((byte) => byte === 0),
    ).toBe(true);
    opened.key.fill(0);
  });

  test("zeroizes handoff plaintext when source or target crypto fails", async () => {
    const sourceFailure = await setup();
    sourceFailure.crypto.failSealToAfterEncrypt = true;
    expect(
      prepareAgentRuntimeHandoffResponse({
        crypto: sourceFailure.crypto,
        challengeBytes: sourceFailure.challenge.challengeBytes,
        expectedPlan: sourceFailure.plan,
        sourceDomainRoot: sourceFailure.sourceDomainRoot,
        sourceEnvelope: sourceFailure.sourceEnvelope,
        resolveHistoricalSourceCommitter: () =>
          sourceFailure.sourceSigning.publicKey,
        sourceCommitterSigningPrivateKey:
          sourceFailure.sourceSigning.privateKey,
        resolveCurrentCommitter: sourceFailure.currentCommitter,
      }),
    ).rejects.toThrow("forced HPKE seal failure");
    expect(sourceFailure.crypto.sealedHandoffPlaintext).not.toBeNull();
    expect(
      sourceFailure.crypto.sealedHandoffPlaintext!.some((byte) => byte !== 0),
    ).toBe(false);

    const targetFailure = await setup();
    targetFailure.crypto.failAeadSeal = true;
    expect(finalize(targetFailure)).rejects.toThrow(
      "forced target seal failure",
    );
    expect(targetFailure.crypto.openedHandoffPlaintext).not.toBeNull();
    expect(
      targetFailure.crypto.openedHandoffPlaintext!.some((byte) => byte !== 0),
    ).toBe(false);
  });
});
