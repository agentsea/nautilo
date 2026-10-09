import { describe, expect, test } from "bun:test";

import type { LatticeCrypto } from "../../src/crypto/index.ts";
import {
  createInitialNamespaceKeyrings,
  sealNamespaceKeyring,
} from "../../src/namespace/keyrings.ts";
import {
  createNamespaceBinding,
  namespaceBindingHash,
  verifyNamespaceBindingProof,
} from "../../src/namespace/bindings.ts";
import {
  withTaskRuntimeCheckpointNamespaceV1 as withTaskRuntimeCheckpointNamespace,
  type TaskRuntimeCheckpointIdentityV1 as TaskRuntimeCheckpointIdentity,
  type TaskRuntimeCheckpointNamespaceMaterialV1 as TaskRuntimeCheckpointNamespaceMaterial,
} from "../../src/object/task-runtime-checkpoint-namespace-v1.ts";
import type {
  TaskRuntimeResultNamespaceSourceV1 as TaskRuntimeResultNamespaceSource,
} from "../../src/object/task-runtime-result-preparation-v1.ts";
import {
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
} from "../../src/v2-types/ids.ts";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../src/background/task-runtime-execution-evidence-v1.ts";
import {
  NOW,
  bytes,
  taskRuntimeAgentObjectSetFixture,
} from "../helpers/task-runtime-agent-object-set-fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

function namespaceSource(
  crypto: LatticeCrypto,
  input: Readonly<{
    seed: number;
    namespaceId: string;
    domainId: string;
    domainGeneration: number;
  }>,
): Readonly<{
  source: TaskRuntimeResultNamespaceSource;
  humanEnvelope: TaskRuntimeResultNamespaceSource["aiKeyringEnvelope"];
}> {
  const committer = crypto.generateSigningKeyPair();
  const root = bytes(0x41 + (input.seed % 8));
  const ns = namespaceId(input.namespaceId);
  const domain = cryptoDomainId(input.domainId);
  const revision = accessRevision(0);
  const metadata = {
    domainId: domain,
    domainEpoch: domainEpoch(input.domainGeneration),
    accessRevision: revision,
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId(`checkpoint-committer-${input.seed}`),
  };
  const rings = createInitialNamespaceKeyrings(crypto, ns);
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: bytes(0x31 + (input.seed % 8)),
    keyring: rings.human,
    metadata,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: root,
    keyring: rings.ai,
    metadata,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: {
      namespaceId: ns,
      accessRevision: revision,
      bindingHash: namespaceBindingHash(binding),
    },
    proof: [binding],
    resolveHistoricalCommitter: () => committer.publicKey,
  });
  return {
    source: {
      trustedHead,
      aiKeyringEnvelope: aiEnvelope,
      currentDomainRoot: root,
      resolveHistoricalCommitter: () => committer.publicKey,
    },
    humanEnvelope,
  };
}

async function fixture(seed = 91_001) {
  const base = await taskRuntimeAgentObjectSetFixture(seed);
  const namespaceFact = base.namespaceFacts[0]!;
  const domain = namespaceFact.domain;
  const evidence = {
    ...base.evidence,
    result: {
      ...base.evidence.result,
      namespace: {
        ...base.evidence.result.namespace,
        expectedAccessRevision: 0,
      },
    },
    namespaceRequirements: base.evidence.namespaceRequirements.map(
      (requirement, index) => index === 0
        ? { ...requirement, expectedAccessRevision: 0 }
        : requirement,
    ),
  } satisfies TaskRuntimeExecutionEvidenceInputV1;
  const current = namespaceSource(base.crypto, {
    seed,
    namespaceId: namespaceFact.namespaceId,
    domainId: domain.domainId,
    domainGeneration: domain.domainKeyGeneration,
  });
  const alternate = namespaceSource(base.crypto, {
    seed: seed + 1,
    namespaceId: `checkpoint-alternate-namespace-${seed}`,
    domainId: `checkpoint-alternate-domain-${seed}`,
    domainGeneration: domain.domainKeyGeneration,
  });
  const identity: TaskRuntimeCheckpointIdentity = {
    taskId: evidence.result.taskId,
    taskRunId: evidence.result.taskRunId,
    sourceRoomId: evidence.sourceRoomId,
    namespaceId: namespaceFact.namespaceId,
    domainId: domain.domainId,
    expectedAccessRevision: 0,
    expectedPolicyRevision: evidence.policyRevision,
  };
  return {
    crypto: base.crypto,
    evidence,
    identity,
    namespace: current.source,
    humanEnvelope: current.humanEnvelope,
    alternate,
  };
}

function runCheckpoint<Value>(
  value: Fixture,
  input: Readonly<{
    signal?: AbortSignal;
    evidence?: TaskRuntimeExecutionEvidenceInputV1;
    identity?: TaskRuntimeCheckpointIdentity;
    namespace?: TaskRuntimeResultNamespaceSource;
    assertCurrentTaskAuthority?: () => Promise<void>;
    execute(
      material: TaskRuntimeCheckpointNamespaceMaterial,
      assertCommitAllowed: () => Promise<void>,
      assertActive: () => void,
    ): Value | PromiseLike<Value>;
  }>,
): Promise<Value> {
  const signal = input.signal ?? new AbortController().signal;
  return withTaskRuntimeExecutionEvidenceV1({
    evidence: input.evidence ?? value.evidence,
    signal,
    now: () => NOW,
    execute: (evidence) => withTaskRuntimeCheckpointNamespace({
      crypto: value.crypto,
      evidence,
      identity: input.identity ?? value.identity,
      namespace: input.namespace ?? value.namespace,
      signal,
      assertCurrentTaskAuthority:
        input.assertCurrentTaskAuthority ?? (async () => undefined),
      execute: input.execute,
    }),
  });
}

async function rejected(operation: Promise<unknown>): Promise<Error> {
  const error = await operation.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) {
    throw new Error("checkpoint operation did not reject with an Error");
  }
  return error;
}

describe("Task Runtime checkpoint Namespace", () => {
  test("lends exact material, rechecks authority for every commit, and wipes keys", async () => {
    const value = await fixture();
    let authorityChecks = 0;
    let borrowedKey: Uint8Array | undefined;
    const result = await runCheckpoint(value, {
      assertCurrentTaskAuthority: async () => { authorityChecks += 1; },
      execute: async (material, assertCommitAllowed, assertActive) => {
        expect(material).toMatchObject({
          namespaceId: value.identity.namespaceId,
          domainId: value.identity.domainId,
          accessRevision: value.identity.expectedAccessRevision,
          policyRevision: value.identity.expectedPolicyRevision,
          currentGeneration: 0,
        });
        expect(Object.isFrozen(material)).toBe(true);
        expect(Object.isFrozen(material.generations)).toBe(true);
        expect(material.generations).toHaveLength(1);
        borrowedKey = material.generations[0]!.key;
        expect(borrowedKey.some((byte) => byte !== 0)).toBe(true);
        assertActive();
        await assertCommitAllowed();
        await assertCommitAllowed();
        return "committed";
      },
    });
    expect(result).toBe("committed");
    expect(authorityChecks).toBe(3);
    expect(borrowedKey).toBeDefined();
    expect(borrowedKey!.every((byte) => byte === 0)).toBe(true);
  });

  test("rejects every substituted exact execution identity before lending keys", async () => {
    const value = await fixture(91_010);
    const cases: readonly Partial<TaskRuntimeCheckpointIdentity>[] = [
      { taskId: "checkpoint-other-task" },
      { taskRunId: "checkpoint-other-run" },
      { sourceRoomId: "checkpoint-other-room" },
      { namespaceId: "checkpoint-other-namespace" },
      { domainId: "checkpoint-other-domain" },
      { expectedAccessRevision: 1 },
      { expectedPolicyRevision: value.identity.expectedPolicyRevision + 1 },
    ];
    for (const changed of cases) {
      let executed = false;
      await rejected(runCheckpoint(value, {
        identity: { ...value.identity, ...changed },
        execute: () => { executed = true; return "unreachable"; },
      }));
      expect(executed).toBe(false);
    }
  });

  test("rejects incomplete audience and substituted current Namespace authority", async () => {
    const value = await fixture(91_020);
    const target = value.evidence.namespaceRequirements[0]!;
    const decryptMissing: TaskRuntimeExecutionEvidenceInputV1 = {
      ...value.evidence,
      namespaceRequirements: [
        { ...target, operations: ["encrypt"] },
        ...value.evidence.namespaceRequirements.slice(1),
      ],
    };
    const duplicateDomain: TaskRuntimeExecutionEvidenceInputV1 = {
      ...value.evidence,
      domainRequirements: [
        value.evidence.domainRequirements[0]!,
        { ...value.evidence.domainRequirements[0]! },
        ...value.evidence.domainRequirements.slice(1),
      ],
    };
    const wrongRoot = bytes(0x7f);
    const cases: readonly Readonly<{
      evidence?: TaskRuntimeExecutionEvidenceInputV1;
      namespace?: TaskRuntimeResultNamespaceSource;
    }>[] = [
      { evidence: decryptMissing },
      { evidence: duplicateDomain },
      { namespace: value.alternate.source },
      {
        namespace: {
          ...value.namespace,
          aiKeyringEnvelope: value.alternate.source.aiKeyringEnvelope,
        },
      },
      {
        namespace: {
          ...value.namespace,
          aiKeyringEnvelope: value.humanEnvelope,
        },
      },
      {
        namespace: { ...value.namespace, currentDomainRoot: wrongRoot },
      },
      {
        namespace: {
          ...value.namespace,
          resolveHistoricalCommitter: () =>
            value.alternate.source.resolveHistoricalCommitter({
              purpose: "namespace-keyring-envelope",
              namespaceId: value.alternate.source.aiKeyringEnvelope.namespaceId,
              domainId: value.alternate.source.aiKeyringEnvelope.domainId,
              domainEpoch: value.alternate.source.aiKeyringEnvelope.domainEpoch,
              accessRevision:
                value.alternate.source.aiKeyringEnvelope.accessRevision,
              committerDeviceId:
                value.alternate.source.aiKeyringEnvelope.committerDeviceId,
              previousBindingHash:
                value.alternate.source.aiKeyringEnvelope.previousBindingHash,
            }),
        },
      },
    ];
    try {
      for (const item of cases) {
        let executed = false;
        await rejected(runCheckpoint(value, {
          ...item,
          execute: () => { executed = true; return "unreachable"; },
        }));
        expect(executed).toBe(false);
      }
    } finally {
      wrongRoot.fill(0);
    }
  });

  test("honors cancellation before authority, during preflight, and after execution", async () => {
    const value = await fixture(91_030);

    const before = new AbortController();
    before.abort();
    let beforeAuthorityChecks = 0;
    let beforeExecuted = false;
    await rejected(runCheckpoint(value, {
      signal: before.signal,
      assertCurrentTaskAuthority: async () => { beforeAuthorityChecks += 1; },
      execute: () => { beforeExecuted = true; return "unreachable"; },
    }));
    expect(beforeAuthorityChecks).toBe(0);
    expect(beforeExecuted).toBe(false);

    const preflight = new AbortController();
    let preflightExecuted = false;
    await rejected(runCheckpoint(value, {
      signal: preflight.signal,
      assertCurrentTaskAuthority: async () => { preflight.abort(); },
      execute: () => { preflightExecuted = true; return "unreachable"; },
    }));
    expect(preflightExecuted).toBe(false);

    for (const timing of ["during", "after"] as const) {
      const controller = new AbortController();
      let borrowedKey: Uint8Array | undefined;
      await rejected(runCheckpoint(value, {
        signal: controller.signal,
        execute: (material, _assertCommitAllowed, assertActive) => {
          borrowedKey = material.generations[0]!.key;
          if (timing === "during") {
            controller.abort();
            expect(() => assertActive()).toThrow();
          } else {
            queueMicrotask(() => { controller.abort(); });
          }
          return "must not escape";
        },
      }));
      expect(borrowedKey).toBeDefined();
      expect(borrowedKey!.every((byte) => byte === 0)).toBe(true);
    }
  });

  test("propagates authority and execution callback failures while wiping opened keys", async () => {
    const value = await fixture(91_040);
    const authorityFailure = new Error("current authority callback failed");
    let executed = false;
    expect(await rejected(runCheckpoint(value, {
      assertCurrentTaskAuthority: async () => { throw authorityFailure; },
      execute: () => { executed = true; return "unreachable"; },
    }))).toBe(authorityFailure);
    expect(executed).toBe(false);

    const executionFailure = new Error("execution callback failed");
    let executionKey: Uint8Array | undefined;
    expect(await rejected(runCheckpoint(value, {
      execute: (material) => {
        executionKey = material.generations[0]!.key;
        throw executionFailure;
      },
    }))).toBe(executionFailure);
    expect(executionKey).toBeDefined();
    expect(executionKey!.every((byte) => byte === 0)).toBe(true);

    const commitFailure = new Error("commit authority callback failed");
    let authorityChecks = 0;
    let commitKey: Uint8Array | undefined;
    expect(await rejected(runCheckpoint(value, {
      assertCurrentTaskAuthority: async () => {
        authorityChecks += 1;
        if (authorityChecks === 2) throw commitFailure;
      },
      execute: async (material, assertCommitAllowed) => {
        commitKey = material.generations[0]!.key;
        await assertCommitAllowed();
        return "unreachable";
      },
    }))).toBe(commitFailure);
    expect(authorityChecks).toBe(2);
    expect(commitKey).toBeDefined();
    expect(commitKey!.every((byte) => byte === 0)).toBe(true);
  });

  test("reproves the verified Namespace head immediately before commit", async () => {
    const value = await fixture(91_050);
    let borrowedKey: Uint8Array | undefined;
    let authorityChecks = 0;
    await rejected(runCheckpoint(value, {
      assertCurrentTaskAuthority: async () => { authorityChecks += 1; },
      execute: async (material, assertCommitAllowed) => {
        borrowedKey = material.generations[0]!.key;
        const hash = value.namespace.trustedHead.bindingHash;
        hash[0] = hash[0]! ^ 1;
        await assertCommitAllowed();
        return "unreachable";
      },
    }));
    expect(authorityChecks).toBe(2);
    expect(borrowedKey).toBeDefined();
    expect(borrowedKey!.every((byte) => byte === 0)).toBe(true);
  });
});
