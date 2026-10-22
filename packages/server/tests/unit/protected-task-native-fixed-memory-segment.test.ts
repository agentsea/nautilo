import { describe, expect, spyOn, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";

import type {
  ProtectedTaskMemoryAccessHandoff,
  ProtectedTaskMemoryProjectionHandoff,
  ProtectedRepoDocsOpenedSelection,
} from "@nautilo/agent";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import { bindEncryptionDataOperationOwner, deriveTaskContentCryptoObjectIdV1, type TaskPayloadV1 } from "@nautilo/lattice-bridge";
import {
  LatticeCrypto,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  createTaskRuntimeBackgroundAuthorizationRequestV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV2,
} from "@nautilo/lattice-crypto/background";
import { agentRuntimeObjectSignerKeyIdV1 } from "@nautilo/lattice-crypto/wire";
import {
  createProtectedTaskTranscriptPort,
  ProtectedTaskExecutionDidNotBeginError,
} from "@nautilo/runtime";
import type {
  ConversationProductCanonicalTransactionRunner,
  ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskOccurrence,
  ProtectedTaskRunningOccurrence,
  ProtectedTaskPredispatchPlan,
  RunProtectedTaskNativeSegmentInput,
  TaskRuntimeGrantClaimPlan,
} from "@nautilo/runtime";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1";

import {
  createProtectedTaskNativeFixedMemorySegment,
  type ProtectedTaskNativeFixedMemorySegmentInput,
} from "../../src/routes/protected-task-native-fixed-memory-segment";
import type {
  ProtectedTaskRuntimeMemoryPolicy,
} from "../../src/routes/protected-task-runtime-grant-plan";

const NOW = 2_230_000_000_000;
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const DEVICE = "30000000-0000-4000-8000-000000000003";
const AGENT = "40000000-0000-4000-8000-000000000004";
const TASK = "50000000-0000-4000-8000-000000000005";
const RUN = "60000000-0000-4000-8000-000000000006";
const JOB = "70000000-0000-4000-8000-000000000007";
const ROOM = "80000000-0000-4000-8000-000000000008";
const NAMESPACE = "90000000-0000-4000-8000-000000000009";
const OTHER_NAMESPACE = "a1000000-0000-4000-8000-00000000000a";
const DOMAIN = "a0000000-0000-4000-8000-00000000000a";
const SCOPE = "b0000000-0000-4000-8000-00000000000b";
const MEMORY_ROOM = "c0000000-0000-4000-8000-00000000000c";
const INPUT_OBJECT = `task-definition:v1:${"a".repeat(64)}`;
const RESULT_OBJECT = deriveTaskContentCryptoObjectIdV1({
  kind: "run_result", taskId: TASK, taskRunId: RUN, contentRevision: 1,
});
const REQUEST = `task-run-authorization:${RUN}`;

const bytes = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

async function fixture(mode: "namespace" | "scope" = "namespace", requestId = REQUEST, wireVersion: 1 | 2 = 1) {
  const crypto = new LatticeCrypto();
  const recipient = await crypto.generateEncryptionKeyPair();
  const domainRequirement = {
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(1),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 3,
    authorizationRevision: authorizationRevision(5),
    headDigest: bytes(2),
    activeNamespaceBindingSetDigest: bytes(3),
    activeNamespaceBindingCount: 1,
  };
  const namespaceRequirement = {
    ordinal: 0,
    namespaceId: NAMESPACE,
    domainId: DOMAIN,
    operations: ["decrypt", "encrypt"] as const,
    expectedAccessRevision: 4,
    expectedPolicyRevision: 17,
  };
  const authorization = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: requestId,
    policyRevision: 17,
    sessionId: `task-run:${RUN}`,
    roomId: ROOM,
    subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId(DEVICE),
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(9),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(11),
    recipientRuntimeGeneration: 2,
    recipientKeyId: "fixed-memory-recipient",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
    maximumSecretBytes: 4_096,
    domains: [domainRequirement],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: requestId,
    workId: RUN,
    workKind: "task.execute",
    workPurpose: "task.execute",
    recipientGeneration: 2,
    episodeId: authorization.sessionId,
    sourceRoomId: authorization.roomId,
    recipientKeyId: authorization.recipientKeyId,
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: authorization,
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
  });
  let descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
  if (wireVersion === 2) {
    const signer = crypto.generateSigningKeyPair();
    try {
      const carrier = createTaskRuntimeBackgroundAuthorizationRequestV2(crypto, {
        baseRequest: request,
        work: { taskId: TASK, taskRunId: RUN, inputObjectId: INPUT_OBJECT,
          resultObjectId: RESULT_OBJECT, executionSegment: 1, workIdentityHash: bytes(12) },
        signer: { agentId: AGENT, runtimeGeneration: 0,
          signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signer.publicKey),
          signerPublicKey: signer.publicKey },
        deviceGroupHead: { serverInstanceId: "server:fixed-memory", lineageGeneration: 1,
          epoch: 2, headDigest: bytes(13), signingPublicKeyHash: bytes(14) },
        namespaceRequirements: [namespaceRequirement],
      });
      descriptorBytes.fill(0);
      descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV2(crypto, carrier);
    } finally { signer.privateKey.fill(0); }
  }
  const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
    requestId: requestId,
    workId: RUN,
    claimId: "fixed-memory-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 2,
    recipientKeyId: authorization.recipientKeyId,
    authorizationDigest: bytes(4),
    policyRevision: 17,
    episodeId: authorization.sessionId,
    sourceRoomId: authorization.roomId,
    hostAuthorizationRevision: 9,
    recipientAuthorizationRevision: 11,
    result: {
      taskId: TASK,
      taskRunId: RUN,
      contentRevision: 1,
      objectId: RESULT_OBJECT,
      signerAgentId: AGENT,
      namespace: {
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        operations: ["encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: 17,
      },
    },
    domainRequirements: [domainRequirement],
    namespaceRequirements: [namespaceRequirement],
  };
  const occurrence: ProtectedTaskOccurrence = Object.freeze({
    task: Object.freeze({
      id: TASK,
      ownerId: USER,
      requestorId: USER,
      agentId: AGENT,
      callingRoomId: ROOM,
      scheduleKind: "now" as const,
      contentRepresentation: "protected" as const,
      contentNamespaceId: NAMESPACE,
      contentRevision: 2,
      cryptoObjectId: INPUT_OBJECT,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: bytes(5),
    }),
    run: Object.freeze({
      id: RUN,
      taskId: TASK,
      jobId: null,
      graphThreadId: `subagent:task:${TASK}:${RUN}`,
      status: "awaiting" as const,
      startedAt: new Date(NOW - 1_000),
    }),
  });
  const envelope = mode === "namespace"
    ? Object.freeze({
        memoryMode: "namespace" as const,
        ownerId: USER,
        actorId: HUMAN,
        agentId: AGENT,
        roomId: ROOM,
        readableNamespaces: [NAMESPACE],
        mutableNamespaces: [NAMESPACE],
        writableNamespaces: [NAMESPACE],
        toolPolicy: Object.freeze({ search_memory: "allow" as const }),
      })
    : Object.freeze({
        memoryMode: "scope" as const,
        ownerId: USER,
        actorId: HUMAN,
        agentId: AGENT,
        roomId: MEMORY_ROOM,
        scopeId: SCOPE,
        originWritableNamespaceId: NAMESPACE,
        toolPolicy: Object.freeze({ search_memory: "allow" as const }),
      });
  const predispatch: ProtectedTaskPredispatchPlan = Object.freeze({
    occurrence,
    scheduling: Object.freeze({
      ownerId: USER,
      requestorId: USER,
      agentId: AGENT,
      roomId: ROOM,
      callingRoomId: ROOM,
      graphThreadId: occurrence.run.graphThreadId,
    }),
    target: Object.freeze({ roomId: ROOM, targetUserIds: [USER] }),
    memory: Object.freeze({
      mode,
      authorityStatus: "exact" as const,
      provenance: mode === "scope"
        ? "scope_existing" as const
        : "target_users_namespace" as const,
      envelope,
    }),
  });
  const policy: ProtectedTaskRuntimeMemoryPolicy = Object.freeze({
    mode: "encrypted_only",
    shadowBehavior: "strict",
    revision: 17,
  });
  const reference: TaskRuntimeGrantClaimPlan["reference"] = Object.freeze({
    kind: "protected_task_run_v1",
    taskId: TASK,
    taskRunId: RUN,
    inputObjectId: INPUT_OBJECT,
    resultObjectId: RESULT_OBJECT,
    authorizationRequestId: requestId,
    policyRevision: 17,
    executionSegment: 1,
  });
  const record = {
    snapshot: {
      formatVersion: 3,
      credentialSubject: {
        kind: "runtime",
        runtimeKind: "task",
        runtimeVersion: 1,
      },
      requestId: requestId,
      workId: RUN,
      state: "claimed",
      descriptorDigest: "11".repeat(32),
      recipientGeneration: 2,
      recipient: {
        recipientKeyId: authorization.recipientKeyId,
        recipientPublicKey: Buffer.from(recipient.publicKey).toString("base64url"),
        expiresAt: NOW + 60_000,
      },
      acceptedResponse: {
        kind: "runtime",
        responseDigest: "22".repeat(32),
        credentialDigest: "33".repeat(32),
        issuingHumanId: HUMAN,
        issuingDeviceId: DEVICE,
        recipientGeneration: 2,
        acceptedAt: NOW,
      },
      claimId: "fixed-memory-claim",
      claimExpiresAt: NOW + 60_000,
    },
    descriptorBytes,
    workKind: "task.execute",
    purpose: "task.execute",
    expectedPolicyRevision: 17,
    authoritySet: {
      namespaceRequirements: [namespaceRequirement],
      domainRequirements: [{
        ordinal: 0,
        domainId: DOMAIN,
        expectedEpoch: 3,
        expectedAuthorizationRevision: authorizationRevision(5),
      }],
    },
    acceptedMaterial: {
      responseBytes: bytes(6),
      credentialId: requestId,
      issuingDeviceAuthorizationRevision: authorizationRevision(9),
      issuerSigningPublicKeyHash: bytes(7),
      authorizationExpiresAt: NOW + 60_000,
    },
  } as unknown as BackgroundAuthorizationTaskRuntimeRecordV3;
  const domains = [Object.freeze({
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: domainRequirement.participantDigest,
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 3,
    authorizationRevision: authorizationRevision(5),
    headDigest: domainRequirement.headDigest,
    domainKey: bytes(8),
  })];
  recipient.privateKey.fill(0);
  const runningOccurrence: ProtectedTaskRunningOccurrence = Object.freeze({
    task: occurrence.task,
    run: Object.freeze({
      ...occurrence.run,
      jobId: JOB,
      status: "running" as const,
    }),
  });
  return {
    crypto,
    request,
    evidenceInput,
    occurrence,
    runningOccurrence,
    predispatch,
    policy,
    reference,
    stableRoutingDigest: bytes(12),
    record,
    domains,
    scopeMemory: mode === "scope" ? Object.freeze({
      scopeId: SCOPE,
      memoryRoomId: MEMORY_ROOM,
      originWritableNamespaceId: NAMESPACE,
      readableNamespaceIds: Object.freeze([NAMESPACE]),
    }) : undefined,
  };
}

function productHandle(
  role: "nautilo" | "nautilo_agent",
): ConversationProductPostgresHandle {
  return Object.freeze({ role }) as ConversationProductPostgresHandle;
}

function runner(): ConversationProductCanonicalTransactionRunner {
  return Object.freeze({ transaction: async () => undefined }) as unknown as
    ConversationProductCanonicalTransactionRunner;
}

function compositionInput(
  crypto: LatticeCrypto,
  canonicalRunner: ConversationProductCanonicalTransactionRunner,
): ProtectedTaskNativeFixedMemorySegmentInput {
  return {
    restricted: Object.freeze({}) as PostgresJsBridgeConnection,
    crypto,
    serverScope: "https://server.example.test",
    product: { handle: productHandle("nautilo"), canonicalRunner },
    agentProduct: {
      handle: productHandle("nautilo_agent"),
      canonicalRunner: runner(),
    },
    owner: Object.freeze({}) as ProtectedTaskNativeFixedMemorySegmentInput["owner"],
    embedding: Object.freeze({}) as ProtectedTaskNativeFixedMemorySegmentInput["embedding"],
    createDedicatedPool: () => Object.freeze({}) as ReturnType<
      ProtectedTaskNativeFixedMemorySegmentInput["createDedicatedPool"]
    >,
    parkSegment: async () => true,
    resolveExecutionContext: async () => ({
      assistantName: "Protected Genie",
      soulFile: "",
      modelId: "protected-model",
      currentFolder: "",
      workspacePath: "",
      subagentDepth: 1,
      subagentMaxDepth: 4,
      roomRoster: [],
    }),
    createTranscriptPublisher: async () => async () => undefined,
    now: () => NOW,
  };
}

function executorInput(
  occurrence: ProtectedTaskOccurrence,
  transient: Record<string, unknown>,
  published: unknown[],
  calls?: string[],
): Record<string, unknown> {
  return {
    ...transient,
    ownerId: USER,
    requestorId: USER,
    agentId: AGENT,
    roomId: ROOM,
    callingRoomId: ROOM,
    taskId: occurrence.task.id,
    currentTaskId: occurrence.task.id,
    taskRunId: occurrence.run.id,
    turnId: occurrence.run.id,
    graphThreadId: occurrence.run.graphThreadId,
    protectedTaskResultPublication: {
      publish: async (payload: unknown) => {
        calls?.push("result-publish");
        published.push(payload);
      },
      park: async (settle: (parkedAt: number) => Promise<boolean>) => {
        calls?.push("result-park");
        if (!await settle(NOW)) throw new Error("park rejected");
      },
      awaitSettled: async () => true,
    },
  };
}

async function consume(
  stream: AsyncGenerator<unknown>,
): Promise<void> {
  for await (const _entry of stream) {
    // This executor intentionally emits no ordinary ServerEvent.
  }
}

function overrides(
  calls: string[],
  outcome: "complete" | "throw" | "interrupt" | "prove_it" | "identity" | "await_reply" | "additional-authority" = "complete",
  protectedMetadata: TaskPayloadV1["protectedMetadata"] = {},
  onDefinitionClose?: () => void,
  definitionRequirement: Readonly<{
    requireNativeExecution?: true;
    requireRepoDocsSelection?: Readonly<{
      mode: "init" | "update" | "auto";
      publish: "branch" | "push" | "pr";
    }>;
  }> = { requireNativeExecution: true },
) {
  const repository = Object.freeze({
    search: async () => ({ status: "success" as const, value: [] }),
    save: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
    replace: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
    setTier: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
  });
  const projection: ProtectedTaskMemoryProjectionHandoff = Object.freeze({
    prepare: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
    restore: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
    planPublication: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
    publishAuthorized: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
  });
  const access = Object.freeze({
    prepareApproval: async () => ({ status: "unavailable" as const,
      reason: "authorization_required" as const }),
    restoreApproval: async () => ({ status: "unavailable" as const,
      reason: "authorization_required" as const }),
    planChange: async () => ({ status: "unavailable" as const,
      reason: "authorization_required" as const }),
    changeAuthorized: async () => ({ status: "unavailable" as const,
      reason: "authorization_required" as const }),
  }) as ProtectedTaskMemoryAccessHandoff;
  return {
    destroyRequest: () => { calls.push("request-destroy"); },
    createDefinitionLoader: (
      _dependencies: unknown,
      options: typeof definitionRequirement,
    ) => {
      expect(options).toEqual(definitionRequirement);
      return async () => ({
        taskId: TASK,
        taskRunId: RUN,
        sourceRoomId: ROOM,
        agentId: AGENT,
        requesterHumanId: HUMAN,
        objectId: INPUT_OBJECT,
        contentRevision: 2,
        cryptoAccessRevision: 0,
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        expectedAccessRevision: 4,
        expectedPolicyRevision: 17,
      });
    },
    openDefinition: async (input: Parameters<
      typeof import("@nautilo/lattice-bridge/server").withNativeProtectedTaskDefinitionV1
    >[0]) => {
      calls.push("definition-open");
      try {
        const assertCurrent = async () => { calls.push("definition-current"); };
        const value = await input.execute({
          formatVersion: 1,
          prompt: "Protected work",
          expectedOutput: "One result",
          protectedMetadata,
        }, assertCurrent);
        await assertCurrent();
        return value;
      } finally {
        calls.push("definition-close");
        onDefinitionClose?.();
      }
    },
    withSigner: async (input: { use: (
      signer: unknown,
      history: () => Promise<null>,
    ) => Promise<unknown> }) => {
      calls.push("signer-open");
      try {
        return await input.use({
          agentAuthorizationRevision: 5,
          runtime: { agentId: AGENT },
          signerPublication: { agentId: AGENT },
        }, async () => null);
      } finally {
        calls.push("signer-close");
      }
    },
    withCurrentMemoryAuthority: async (_input: unknown, use: (
      held: { policy: ProtectedTaskRuntimeMemoryPolicy; assertCurrent(): Promise<void> },
    ) => Promise<unknown>) => use({
      policy: {
        mode: "encrypted_only",
        shadowBehavior: "strict",
        revision: 17,
      },
      assertCurrent: async () => undefined,
    }),
    withMemoryRepository: async (input: {
      execute(value: typeof repository,
        projection: ProtectedTaskMemoryProjectionHandoff,
        access: ProtectedTaskMemoryAccessHandoff): Promise<unknown>;
      current: { jobId: string };
      authority: { mode: string };
    }) => {
      calls.push(`repository-open:${input.current.jobId}:${input.authority.mode}`);
      try { return await input.execute(repository, projection, access); }
      finally { calls.push("repository-close"); }
    },
    withCheckpointSaver: async (input: {
      owner: unknown;
      execute(value: unknown): Promise<unknown>;
    }) => {
      expect(input.owner).toBeDefined();
      calls.push("checkpoint-open");
      try {
        return {
          value: await input.execute(Object.freeze({})),
          checkpointAadBinding: { version: 1 as const, namespaceId: NAMESPACE, domainId: DOMAIN, namespaceAccessRevision: 4, policyRevision: 17 },
          manifest: Object.freeze({
            contract: "encrypted_langgraph_v1" as const,
            expectedCheckpointCount: 1,
            checkpointOrderedDigest: bytes(21),
            expectedBlobCount: 0,
            blobOrderedDigest: bytes(22),
            expectedPendingWriteCount: 0,
            pendingWriteOrderedDigest: bytes(23),
          }),
        };
      }
      finally { calls.push("checkpoint-close"); }
    },
    createTranscriptPort: () => Object.freeze({
      quiesce: async () => {
        calls.push("transcript-quiesce");
        return { failedPublicationCount: 0 };
      },
      publishBatch: async () => undefined,
    }),
    runSegment: async (input: {
      memoryHandoff: Record<string, unknown>;
    }) => {
      calls.push("runner");
      expect(Object.keys(input.memoryHandoff).sort()).toEqual([
        "access",
        "fullEncryptionOnly",
        "projection",
        "repository",
        "search",
      ]);
      expect(input.memoryHandoff["access"]).toBe(access);
      expect(input.memoryHandoff["projection"]).toBe(projection);
      if (outcome === "throw") throw new Error("runner failed");
      if (outcome === "interrupt" || outcome === "prove_it"
        || outcome === "identity" || outcome === "await_reply") {
        return {
          status: "interrupted" as const,
          threadId: `subagent:task:${TASK}:${RUN}`,
          interrupt: {},
          interruptCoordinates: [{ id: "approval-1", kind: outcome === "interrupt"
            ? "approval" as const : outcome,
            requestId: "request-1" }],
        };
      }
      if (outcome === "additional-authority") {
        return {
          status: "interrupted" as const,
          threadId: `subagent:task:${TASK}:${RUN}`,
          interrupt: {},
          interruptCoordinates: [{
            id: "additional-authority-1",
            kind: "additional_authority" as const,
            requestId: `task-run-authorization:${RUN}:segment:2`,
          }],
          additionalAuthority: {
            kind: "pre_effect_interrupt_v1" as const,
            reason: "additional_authority" as const,
            effectDisposition: "not_started_v1" as const,
            interruptId: "additional-authority-1",
            operationId: "memory-operation-1",
            requestDigest: bytes(31),
            requiredAuthorityDigest: bytes(32),
            semanticAuthorityRequirements: [{
              namespaceId: OTHER_NAMESPACE,
              operations: ["decrypt" as const],
            }],
          },
        };
      }
      const payload = {
        formatVersion: 1 as const,
        resultText: "done",
        lastError: null,
      };
      return payload;
    },
  } as unknown as Parameters<
    typeof createProtectedTaskNativeFixedMemorySegment
  >[1];
}

async function executeScenario(
  mode: "namespace" | "scope" = "namespace",
  outcome: "complete" | "throw" | "interrupt" | "prove_it" | "identity" | "await_reply" = "complete",
) {
  const value = await fixture(mode);
  const calls: string[] = [];
  const published: unknown[] = [];
  const canonicalRunner = runner();
  const prepare = createProtectedTaskNativeFixedMemorySegment(
    compositionInput(value.crypto, canonicalRunner),
    overrides(calls, outcome),
  );
  return withTaskRuntimeExecutionEvidenceV1({
    evidence: value.evidenceInput,
    signal: new AbortController().signal,
    now: () => NOW,
    execute: async evidence => {
      const prepared = await prepare({
        occurrence: value.occurrence,
        predispatch: value.predispatch,
        policy: value.policy,
        reference: value.reference,
        stableRoutingDigest: value.stableRoutingDigest,
        ...(value.scopeMemory === undefined ? {} : {
          scopeMemory: value.scopeMemory,
          scopeWorkIdentity: "fixed-scope-work-identity",
        }),
      });
      const transient = await prepared.openTransientInput({
        occurrence: value.runningOccurrence,
        reference: value.reference,
        record: value.record,
        domains: value.domains,
        evidence,
        signal: new AbortController().signal,
      });
      const input = executorInput(value.occurrence, transient, published, calls);
      return { value, calls, published, prepared, transient, input };
    },
  });
}

async function withScenario<Value>(
  mode: "namespace" | "scope",
  outcome: "complete" | "throw" | "interrupt" | "prove_it" | "identity" | "await_reply",
  use: (scenario: Awaited<ReturnType<typeof executeScenario>>) => Promise<Value>,
  onDefinitionClose?: () => void,
  grantSignal: AbortSignal = new AbortController().signal,
  wireVersion: 1 | 2 = 1,
): Promise<Value> {
  const value = await fixture(mode, REQUEST, wireVersion);
  const calls: string[] = [];
  const published: unknown[] = [];
  const prepare = createProtectedTaskNativeFixedMemorySegment(
    compositionInput(value.crypto, runner()),
    overrides(calls, outcome, {}, onDefinitionClose),
  );
  return withTaskRuntimeExecutionEvidenceV1({
    evidence: value.evidenceInput,
    signal: new AbortController().signal,
    now: () => NOW,
    execute: async evidence => {
      const prepared = await prepare({
        occurrence: value.occurrence,
        predispatch: value.predispatch,
        policy: value.policy,
        reference: value.reference,
        stableRoutingDigest: value.stableRoutingDigest,
        ...(value.scopeMemory === undefined ? {} : {
          scopeMemory: value.scopeMemory,
          scopeWorkIdentity: "fixed-scope-work-identity",
        }),
      });
      const transient = await prepared.openTransientInput({
        occurrence: value.runningOccurrence,
        reference: value.reference,
        record: value.record,
        domains: value.domains,
        evidence,
        signal: grantSignal,
      });
      const input = executorInput(value.occurrence, transient, published, calls);
      return use({ value, calls, published, prepared, transient, input });
    },
  });
}

describe("protected Task native fixed Memory segment", () => {
  test("runs a certified request carrier through the production segment decoder", async () => {
    await withScenario("namespace", "complete", async scenario => {
      await consume(scenario.prepared.executor(
        scenario.input, JOB, `task:${TASK}`, new AbortController().signal,
      ));
      expect(scenario.calls).toContain("runner");
      expect(scenario.published).toEqual([{
        formatVersion: 1, resultText: "done", lastError: null,
      }]);
    }, undefined, new AbortController().signal, 2);
  });

  test("defers an offline local target before opening protected content or execution", async () => {
    const value = await fixture();
    const calls: string[] = [];
    let ready = false;
    let readinessChecks = 0;
    const input = {
      ...compositionInput(value.crypto, runner()),
      localExecutionReadyBeforeStart: async (current: Readonly<{
        occurrence: ProtectedTaskRunningOccurrence;
        signal: AbortSignal;
      }>) => {
        readinessChecks += 1;
        expect(current.occurrence).toBe(value.runningOccurrence);
        current.signal.throwIfAborted();
        return ready;
      },
    };
    const prepare = createProtectedTaskNativeFixedMemorySegment(
      input,
      overrides(calls),
    );
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async evidence => {
        const prepared = await prepare({
          occurrence: value.occurrence,
          predispatch: value.predispatch,
          policy: value.policy,
          reference: value.reference,
          stableRoutingDigest: value.stableRoutingDigest,
        });
        const grant = {
          occurrence: value.runningOccurrence,
          reference: value.reference,
          record: value.record,
          domains: value.domains,
          evidence,
          signal: new AbortController().signal,
        };
        await Promise.resolve(expect(prepared.openTransientInput(grant)).rejects.toBeInstanceOf(
          ProtectedTaskExecutionDidNotBeginError,
        ));
        expect(calls).toEqual([]);
        ready = true;
        const transient = await prepared.openTransientInput(grant);
        expect(transient).toBeDefined();
      },
    });
    expect(readinessChecks).toBe(2);
    expect(calls).toEqual([]);
  });

  test.each([{ writableNamespaces: [NAMESPACE] }, { writableNamespaces: [OTHER_NAMESPACE, NAMESPACE] }])("keeps the primary writable Namespace in multi-Namespace Memory authority: %j", async ({ writableNamespaces }) => {
    const value = await fixture();
    const calls: string[] = [];
    const published: unknown[] = [];
    const base = overrides(calls);
    if (base === undefined) throw new TypeError("Test overrides are unavailable");
    const baseWithMemoryRepository = base.withMemoryRepository!;
    const envelope = value.predispatch.memory.envelope;
    if (envelope.memoryMode !== "namespace") {
      throw new Error("expected Namespace Memory envelope");
    }
    const predispatch: ProtectedTaskPredispatchPlan = Object.freeze({
      ...value.predispatch,
      memory: Object.freeze({
        ...value.predispatch.memory,
        envelope: Object.freeze({
          ...envelope,
          readableNamespaces: [OTHER_NAMESPACE, NAMESPACE],
          mutableNamespaces: [OTHER_NAMESPACE, NAMESPACE],
          writableNamespaces: [...writableNamespaces],
        }),
      }),
    });
    const prepare = createProtectedTaskNativeFixedMemorySegment(
      compositionInput(value.crypto, runner()),
      {
        ...base,
        withMemoryRepository: async input => {
          expect(input.authority).toEqual({
            mode: "namespace",
            subjectUserId: USER,
            agentId: AGENT,
            readableNamespaceIds: [NAMESPACE, OTHER_NAMESPACE],
            mutableNamespaceIds: [NAMESPACE, OTHER_NAMESPACE],
            writableNamespaceId: writableNamespaces[0],
          });
          return baseWithMemoryRepository(input);
        },
      },
    );
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async evidence => {
        const prepared = await prepare({
          occurrence: value.occurrence,
          predispatch,
          policy: value.policy,
          reference: value.reference,
          stableRoutingDigest: value.stableRoutingDigest,
        });
        const transient = await prepared.openTransientInput({
          occurrence: value.runningOccurrence,
          reference: value.reference,
          record: value.record,
          domains: value.domains,
          evidence,
          signal: new AbortController().signal,
        });
        await consume(prepared.executor(
          executorInput(value.occurrence, transient, published, calls),
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ));
      },
    });
    expect(calls).toContain("runner");
    expect(published).toHaveLength(1);
  });

  test("keeps Namespace and Scope repositories and checkpoint saver around the runner", async () => {
    for (const mode of ["namespace", "scope"] as const) {
      await withScenario(mode, "complete", async scenario => {
        await consume(scenario.prepared.executor(
          scenario.input,
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ));
        expect(scenario.published).toEqual([{
          formatVersion: 1,
          resultText: "done",
          lastError: null,
        }]);
        expect(scenario.calls).toEqual([
          "definition-open",
          "signer-open",
          `repository-open:${JOB}:${mode}`,
          "checkpoint-open",
          "runner",
          "transcript-quiesce",
          "checkpoint-close",
          "repository-close",
          "signer-close",
          "definition-current",
          "definition-close",
          "result-publish",
          "request-destroy",
        ]);
      });
    }
  });

  test("rejects cross-spliced executor identity before opening protected state", async () => {
    await withScenario("namespace", "complete", async scenario => {
      scenario.input["taskRunId"] = "substituted-run";
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(consume(scenario.prepared.executor(
        scenario.input,
        JOB,
        `task:${TASK}`,
        new AbortController().signal,
      ))).rejects.toThrow("executor identity changed");
      expect(scenario.calls).toEqual([]);
    });
  });

  test("rejects an executor Job different from the admitted running occurrence", async () => {
    await withScenario("namespace", "complete", async scenario => {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(consume(scenario.prepared.executor(
        scenario.input,
        "substituted-job",
        `task:${TASK}`,
        new AbortController().signal,
      ))).rejects.toThrow("Job changed");
      expect(scenario.calls).toEqual([]);
    });
  });

  test("rejects a retained closure after genuine evidence custody closes", async () => {
    const scenario = await executeScenario();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(consume(scenario.prepared.executor(
      scenario.input,
      JOB,
      `task:${TASK}`,
      new AbortController().signal,
    ))).rejects.toThrow();
    expect(scenario.calls).toEqual([]);
  });

  test("publishes one generic failure after each protected setup owner unwinds", async () => {
    const phaseCodes = {
      definition: "PTFMS001",
      context: "PTFMS002",
      signer: "PTFMS003",
      transcript: "PTFMS004",
      memory: "PTFMS005",
      checkpoint: "PTFMS006",
    } as const;
    for (const stage of [
      "definition",
      "context",
      "signer",
      "transcript",
      "memory",
      "checkpoint",
    ] as const) {
      const value = await fixture();
      const calls: string[] = [];
      const terminal: unknown[] = [];
      const sentinel = `raw ${stage} failure`;
      let fixedInput = compositionInput(value.crypto, runner());
      let fixedOverrides = overrides(calls);
      if (stage === "definition") {
        fixedOverrides = {
          ...fixedOverrides,
          openDefinition: async () => {
            calls.push("definition-open", "definition-close");
            throw new Error(sentinel);
          },
        };
      } else if (stage === "context") {
        fixedInput = {
          ...fixedInput,
          resolveExecutionContext: async () => { throw new Error(sentinel); },
        };
      } else if (stage === "signer") {
        fixedOverrides = {
          ...fixedOverrides,
          withSigner: async () => {
            calls.push("signer-open", "signer-close");
            throw new Error(sentinel);
          },
        };
      } else if (stage === "transcript") {
        fixedOverrides = {
          ...fixedOverrides,
          createTranscriptPort: () => { throw new Error(sentinel); },
        };
      } else if (stage === "memory") {
        fixedOverrides = {
          ...fixedOverrides,
          withMemoryRepository: async () => {
            calls.push("repository-open", "repository-close");
            throw new Error(sentinel);
          },
        };
      } else {
        fixedOverrides = {
          ...fixedOverrides,
          withCheckpointSaver: async () => {
            calls.push("checkpoint-open", "checkpoint-close");
            throw new Error(sentinel);
          },
        };
      }
      const prepare = createProtectedTaskNativeFixedMemorySegment(
        fixedInput,
        fixedOverrides,
      );
      const diagnostics: string[] = [];
      const logSpy = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
        diagnostics.push(values.map(String).join(" "));
      });
      try {
        await withTaskRuntimeExecutionEvidenceV1({
          evidence: value.evidenceInput,
          signal: new AbortController().signal,
          now: () => NOW,
          execute: async evidence => {
            const prepared = await prepare({
              occurrence: value.occurrence,
              predispatch: value.predispatch,
              policy: value.policy,
              reference: value.reference,
              stableRoutingDigest: value.stableRoutingDigest,
            });
            const transient = await prepared.openTransientInput({
              occurrence: value.runningOccurrence,
              reference: value.reference,
              record: value.record,
              domains: value.domains,
              evidence,
              signal: new AbortController().signal,
            });
            await consume(prepared.executor(
              executorInput(value.occurrence, transient, terminal, calls),
              JOB,
              `task:${TASK}`,
              new AbortController().signal,
            ));
          },
        });
      } finally {
        logSpy.mockRestore();
      }
      expect(terminal).toEqual([{
        formatVersion: 1,
        resultText: null,
        lastError: "Protected Task execution failed",
      }]);
      expect(JSON.stringify(terminal)).not.toContain(sentinel);
      expect(diagnostics).toEqual([
        `[task-observer] protected fixed Memory segment rejected code=${phaseCodes[stage]}`,
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain(sentinel);
      const finalOwnerClose = stage === "definition" || stage === "context"
        ? "definition-close"
        : stage === "signer" || stage === "transcript"
          ? "signer-close"
          : stage === "memory"
            ? "repository-close"
            : "checkpoint-close";
      expect(calls).toContain(finalOwnerClose);
      expect(calls.indexOf(finalOwnerClose))
        .toBeLessThan(calls.indexOf("result-publish"));
      expect(calls.at(-2)).toBe("result-publish");
      expect(calls.at(-1)).toBe("request-destroy");
    }
  });

  test("constructs the transcript publisher under the signer owner and cleans up construction failure", async () => {
    const value = await fixture();
    const calls: string[] = [];
    const terminal: unknown[] = [];
    let signerOwnerOpen = false;
    const base = overrides(calls);
    if (base === undefined) throw new TypeError("Test overrides are unavailable");
    const baseWithSigner = base.withSigner!;
    const prepare = createProtectedTaskNativeFixedMemorySegment({
      ...compositionInput(value.crypto, runner()),
      createTranscriptPublisher: async publisher => {
        calls.push("publisher-build");
        expect(signerOwnerOpen).toBe(true);
        expect(publisher.domains).toBe(value.domains);
        expect(publisher.signer).toMatchObject({
          agentAuthorizationRevision: 5,
          runtime: { agentId: AGENT },
          signerPublication: { agentId: AGENT },
        });
        expect(typeof publisher.resolveHistoricalSignerPublicationManager)
          .toBe("function");
        throw new Error("publisher construction failed");
      },
    }, {
      ...base,
      withSigner: async input => {
        signerOwnerOpen = true;
        try {
          return await baseWithSigner(input);
        } finally {
          signerOwnerOpen = false;
        }
      },
    });

    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async evidence => {
        const prepared = await prepare({
          occurrence: value.occurrence,
          predispatch: value.predispatch,
          policy: value.policy,
          reference: value.reference,
          stableRoutingDigest: value.stableRoutingDigest,
        });
        const transient = await prepared.openTransientInput({
          occurrence: value.runningOccurrence,
          reference: value.reference,
          record: value.record,
          domains: value.domains,
          evidence,
          signal: new AbortController().signal,
        });
        await consume(prepared.executor(
          executorInput(value.occurrence, transient, terminal, calls),
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ));
      },
    });

    expect(signerOwnerOpen).toBe(false);
    expect(terminal).toEqual([{
      formatVersion: 1,
      resultText: null,
      lastError: "Protected Task execution failed",
    }]);
    expect(JSON.stringify(terminal)).not.toContain("publisher construction failed");
    expect(calls).toEqual([
      "definition-open",
      "signer-open",
      "publisher-build",
      "signer-close",
      "definition-close",
      "result-publish",
      "request-destroy",
    ]);
  });

  for (const fails of [false, true]) {
    test(`drains escaped transcript writes before owner close (failure=${fails})`, async () => {
      const value = await fixture();
      const calls: string[] = [];
      const terminal: unknown[] = [];
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const prepare = createProtectedTaskNativeFixedMemorySegment({
        ...compositionInput(value.crypto, runner()),
        createTranscriptPublisher: async () => async () => {
          started.resolve();
          await release.promise;
          if (fails) throw new Error("transcript storage failed");
          calls.push("transcript-stored");
        },
      }, {
        ...overrides(calls),
        createTranscriptPort: createProtectedTaskTranscriptPort,
        runSegment: async segment => {
          void segment.transcriptPort.publishBatch({
            taskId: segment.taskId,
            taskRunId: segment.taskRunId,
            graphThreadId: segment.graphThreadId,
            roomId: segment.execution.roomId,
            humanTurnId: segment.execution.parentTurnId,
            agentId: segment.execution.subEnvelope.agentId,
            messages: [new AIMessage("protected progress")],
          }).catch(() => undefined);
          return { formatVersion: 1, resultText: "done", lastError: null };
        },
      });
      await withTaskRuntimeExecutionEvidenceV1({
        evidence: value.evidenceInput,
        signal: new AbortController().signal,
        now: () => NOW,
        execute: async evidence => {
          const prepared = await prepare({
            occurrence: value.occurrence, predispatch: value.predispatch,
            policy: value.policy, reference: value.reference,
            stableRoutingDigest: value.stableRoutingDigest,
          });
          const transient = await prepared.openTransientInput({
            occurrence: value.runningOccurrence, reference: value.reference,
            record: value.record,
            domains: value.domains, evidence, signal: new AbortController().signal,
          });
          const execution = consume(prepared.executor(
            executorInput(value.occurrence, transient, terminal, calls),
            JOB, `task:${TASK}`, new AbortController().signal,
          ));
          await started.promise;
          expect(terminal).toEqual([]);
          release.resolve();
          if (fails) {
            await execution;
            expect(terminal).toEqual([{
              formatVersion: 1,
              resultText: null,
              lastError: "Protected Task execution failed",
            }]);
          } else {
            await execution;
            expect(terminal).toHaveLength(1);
            expect(calls.indexOf("transcript-stored"))
              .toBeLessThan(calls.indexOf("signer-close"));
          }
          expect(calls).toContain("definition-close");
          expect(calls.indexOf("definition-close"))
            .toBeLessThan(calls.indexOf("result-publish"));
        },
      });
    });
  }

  test("uses the runner parent turn for the actual protected transcript port", async () => {
    const value = await fixture();
    const calls: string[] = [];
    const terminal: unknown[] = [];
    const transcript: unknown[] = [];
    const base = overrides(calls);
    const prepare = createProtectedTaskNativeFixedMemorySegment({
      ...compositionInput(value.crypto, runner()),
      createTranscriptPublisher: async () => async publication => {
        transcript.push(publication);
      },
    }, {
      ...base,
      createTranscriptPort: createProtectedTaskTranscriptPort,
      runSegment: async (segment: RunProtectedTaskNativeSegmentInput) => {
        calls.push("runner");
        await segment.transcriptPort.publishBatch({
          taskId: segment.taskId,
          taskRunId: segment.taskRunId,
          graphThreadId: segment.graphThreadId,
          roomId: segment.execution.roomId,
          humanTurnId: segment.execution.parentTurnId,
          agentId: segment.execution.subEnvelope.agentId,
          messages: [new AIMessage("protected progress")],
        });
        return {
          formatVersion: 1,
          resultText: "done",
          lastError: null,
        };
      },
    });
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async evidence => {
        const prepared = await prepare({
          occurrence: value.occurrence,
          predispatch: value.predispatch,
          policy: value.policy,
          reference: value.reference,
          stableRoutingDigest: value.stableRoutingDigest,
        });
        const transient = await prepared.openTransientInput({
          occurrence: value.runningOccurrence,
          reference: value.reference,
          record: value.record,
          domains: value.domains,
          evidence,
          signal: new AbortController().signal,
        });
        await consume(prepared.executor(
          executorInput(value.occurrence, transient, terminal, calls),
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ));
      },
    });
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      identity: { taskRunId: RUN, humanTurnId: RUN },
    });
    expect(terminal).toEqual([{
      formatVersion: 1,
      resultText: "done",
      lastError: null,
    }]);
    expect(calls.indexOf("result-publish")).toBeGreaterThan(
      calls.indexOf("definition-close"),
    );
  });

  test("settles runner failure after closing plaintext owners", async () => {
    await withScenario("namespace", "throw", async scenario => {
      await consume(scenario.prepared.executor(
        scenario.input, JOB, `task:${TASK}`, new AbortController().signal,
      ));
      expect(scenario.published).toEqual([{
        formatVersion: 1, resultText: null,
        lastError: "Protected Task execution failed",
      }]);
      expect(JSON.stringify(scenario.published)).not.toContain("runner failed");
      expect(scenario.calls.indexOf("definition-close"))
        .toBeLessThan(scenario.calls.indexOf("result-publish"));
      expect(scenario.calls.at(-1)).toBe("request-destroy");
    });
  });

  test.each(["manual_pause", "time_limit", "grant_refresh"] as const)(
    "seals a requested %s checkpoint only after every plaintext owner closes", async reason => {
      const value = await fixture();
      const calls: string[] = [];
      const published: unknown[] = [];
      const parked: unknown[] = [];
      const pauseRequestId = "d0000000-0000-4000-8000-00000000000d";
      const prepare = createProtectedTaskNativeFixedMemorySegment({
        ...compositionInput(value.crypto, runner()),
        parkSegment: async input => { parked.push(input); return true; },
      }, { ...overrides(calls), runSegment: async segment => {
        expect(segment.protectedTaskCheckpointPauseController?.currentRequestedReason()).toBe(reason);
        return { status: "checkpoint_paused", threadId: segment.graphThreadId, reason };
      } });
      await withTaskRuntimeExecutionEvidenceV1({ evidence: value.evidenceInput,
        signal: new AbortController().signal, now: () => NOW,
        execute: async evidence => {
          const prepared = await prepare({ occurrence: value.occurrence,
            predispatch: value.predispatch, policy: value.policy, reference: value.reference,
            stableRoutingDigest: value.stableRoutingDigest });
          expect(prepared.requestCheckpointPause?.(reason,
            reason === "grant_refresh" ? undefined : pauseRequestId)).toBe(true);
          expect(prepared.requestCheckpointPause?.(reason,
            reason === "grant_refresh" ? undefined : pauseRequestId)).toBe(false);
          const transient = await prepared.openTransientInput({ occurrence: value.runningOccurrence,
            reference: value.reference, record: value.record, domains: value.domains, evidence,
            signal: new AbortController().signal });
          await consume(prepared.executor(executorInput(value.occurrence, transient, published, calls),
            JOB, `task:${TASK}`, new AbortController().signal));
        },
      });
      expect(published).toEqual([]);
      expect(parked).toHaveLength(1);
      expect(parked[0]).toMatchObject({
        park: { taskId: TASK, taskRunId: RUN, jobId: JOB, interrupts: [] },
        continuation: { kind: "checkpoint_safe_v1", reason, effectDisposition: "none_v1" },
        pauseRequestId: reason === "grant_refresh" ? null : pauseRequestId,
        stableRoutingDigest: value.stableRoutingDigest,
      });
      for (const close of ["transcript-quiesce", "checkpoint-close", "repository-close", "signer-close", "definition-close"]) {
        expect(calls.indexOf(close)).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf(close)).toBeLessThan(calls.indexOf("result-park"));
      }
      expect(calls).not.toContain("result-publish");
    },
  );

  test.each(["interrupt", "prove_it", "identity", "await_reply"] as const)(
    "parks Human %s only after checkpoint and plaintext owners close", async outcome => {
      await withScenario("namespace", outcome, async scenario => {
        await consume(scenario.prepared.executor(
          scenario.input, JOB, `task:${TASK}`, new AbortController().signal,
        ));
        expect(scenario.published).toEqual([]);
        expect(scenario.calls).not.toContain("result-publish");
        for (const close of ["transcript-quiesce", "checkpoint-close", "repository-close",
          "signer-close", "definition-close"]) {
          expect(scenario.calls.indexOf(close)).toBeGreaterThanOrEqual(0);
          expect(scenario.calls.indexOf(close))
            .toBeLessThan(scenario.calls.indexOf("result-park"));
        }
        expect(scenario.calls.at(-1)).toBe("request-destroy");
      });
    },
  );

  test("continues from the immutable checkpoint and parks only after every plaintext owner closes", async () => {
    const value = await fixture("namespace");
    const calls: string[] = [];
    const published: unknown[] = [];
    const parked: unknown[] = [];
    const reference: TaskRuntimeGrantClaimPlan["reference"] = Object.freeze({
      ...value.reference,
      executionSegment: 2,
      resumeContinuationFingerprint: "A".repeat(43),
    });
    const additionalAuthorityResume = Object.freeze({
      interruptId: "prior-additional-authority",
      authorizationRequestId: REQUEST,
      effectDisposition: "not_started_v1" as const,
      operationId: "prior-memory-operation",
      requestDigest: bytes(31),
      requiredAuthorityDigest: bytes(37),
    });
    let carriedResume: unknown;
    const baseOverrides = overrides(calls, "additional-authority");
    if (baseOverrides === undefined) {
      throw new TypeError("Test overrides are unavailable");
    }
    const baseRunSegment = baseOverrides.runSegment!;
    const prepare = createProtectedTaskNativeFixedMemorySegment({
      ...compositionInput(value.crypto, runner()),
      parkSegment: async input => {
        parked.push(input);
        expect(calls.indexOf("transcript-quiesce"))
          .toBeLessThan(calls.indexOf("checkpoint-close"));
        expect(calls.indexOf("checkpoint-close"))
          .toBeLessThan(calls.indexOf("repository-close"));
        expect(calls.indexOf("repository-close"))
          .toBeLessThan(calls.indexOf("signer-close"));
        expect(calls.indexOf("signer-close"))
          .toBeLessThan(calls.indexOf("definition-close"));
        expect(calls.indexOf("definition-close"))
          .toBeLessThan(calls.indexOf("result-park"));
        return true;
      },
    }, {
      ...baseOverrides,
      runSegment: async segment => {
        carriedResume = segment.execution.resume;
        expect(segment.execution.continueFromCheckpoint).toBeUndefined();
        return baseRunSegment(segment);
      },
    });
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async evidence => {
        const prepared = await prepare({
          occurrence: value.occurrence,
          predispatch: value.predispatch,
          policy: value.policy,
          reference,
          stableRoutingDigest: value.stableRoutingDigest,
          checkpointAadBinding: { version: 1, namespaceId: NAMESPACE, domainId: DOMAIN, namespaceAccessRevision: 4, policyRevision: 17 },
          additionalAuthorityResume,
        });
        const transient = await prepared.openTransientInput({
          occurrence: value.runningOccurrence,
          reference,
          record: value.record,
          domains: value.domains,
          evidence,
          signal: new AbortController().signal,
        });
        await consume(prepared.executor(
          executorInput(value.occurrence, transient, published, calls),
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ));
      },
    });
    expect(carriedResume).toEqual({
      "prior-additional-authority": {
        type: "protected_task_additional_authority_granted_v1",
        authorizationRequestId: REQUEST,
        effectDisposition: "not_started_v1",
        operationId: "prior-memory-operation",
        requestDigest: bytes(31),
        requiredAuthorityDigest: bytes(37),
      },
    });
    expect(published).toEqual([]);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      park: {
        taskId: TASK,
        taskRunId: RUN,
        jobId: JOB,
        generation: 2,
        executionSegment: 2,
        jobReference: reference,
      },
      segment: {
        route: "native_langgraph_v1",
        checkpoint: {
          contract: "encrypted_langgraph_v1",
          expectedCheckpointCount: 1,
        },
      },
      continuation: {
        kind: "pre_effect_interrupt_v1",
        reason: "additional_authority",
        effectDisposition: "not_started_v1",
        interruptId: "additional-authority-1",
        operationId: "memory-operation-1",
      },
    });
    expect((parked[0] as { continuation: { stableRoutingDigest: Uint8Array } })
      .continuation.stableRoutingDigest).toEqual(value.stableRoutingDigest);
  });

  test("resumes a safe checkpoint without fabricating a Human or additional-authority reply", async () => {
    const calls: string[] = [];
    const published: unknown[] = [];
    const fingerprint = "A".repeat(43);
    const value = await fixture("namespace", `task-checkpoint-continuation:${RUN}:2:${fingerprint}`);
    const reference: TaskRuntimeGrantClaimPlan["reference"] = Object.freeze({
      ...value.reference,
      executionSegment: 2,
      resumeContinuationFingerprint: fingerprint,
      authorizationRequestId: `task-checkpoint-continuation:${RUN}:2:${fingerprint}`,
    });
    const baseOverrides = overrides(calls, "complete")!;
    const baseRunSegment = baseOverrides.runSegment!;
    let executions = 0;
    const prepare = createProtectedTaskNativeFixedMemorySegment(
      compositionInput(value.crypto, runner()), {
        ...baseOverrides,
        runSegment: async segment => {
          executions += 1;
          expect(segment.execution.continueFromCheckpoint).toBe(true);
          expect(segment.execution.resume).toBeUndefined();
          return baseRunSegment(segment);
        },
      },
    );
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async evidence => {
        const prepared = await prepare({
          occurrence: value.occurrence, predispatch: value.predispatch,
          policy: value.policy, reference,
          stableRoutingDigest: value.stableRoutingDigest, checkpointResume: true,
          checkpointAadBinding: { version: 1, namespaceId: NAMESPACE, domainId: DOMAIN, namespaceAccessRevision: 4, policyRevision: 17 },
        });
        const transient = await prepared.openTransientInput({
          occurrence: value.runningOccurrence, reference, record: value.record,
          domains: value.domains, evidence, signal: new AbortController().signal,
        });
        await consume(prepared.executor(
          executorInput(value.occurrence, transient, published, calls),
          JOB, `task:${TASK}`, new AbortController().signal,
        ));
      },
    });
    expect(executions).toBe(1);
    expect(published).toHaveLength(1);
    expect(calls.indexOf("definition-close")).toBeLessThan(calls.indexOf("result-publish"));
  });

  test("does not publish a terminal result after Job cancellation during owner close", async () => {
    const job = new AbortController();
    await withScenario("namespace", "throw", async scenario => {
      const failure = await consume(scenario.prepared.executor(
        scenario.input,
        JOB,
        `task:${TASK}`,
        job.signal,
      )).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw failure;
      expect(failure.message).not.toContain("runner failed");
      expect(scenario.published).toEqual([]);
      expect(scenario.calls).not.toContain("result-publish");
      expect(scenario.calls).toContain("definition-close");
    }, () => { job.abort(); });
  });

  test("does not publish a terminal result after grant cancellation during owner close", async () => {
    const grant = new AbortController();
    await withScenario("namespace", "throw", async scenario => {
      const failure = await consume(scenario.prepared.executor(
        scenario.input,
        JOB,
        `task:${TASK}`,
        new AbortController().signal,
      )).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw failure;
      expect(failure.message).not.toContain("runner failed");
      expect(scenario.published).toEqual([]);
      expect(scenario.calls).not.toContain("result-publish");
      expect(scenario.calls).toContain("definition-close");
    }, () => { grant.abort(); }, grant.signal);
  });

  test("propagates one terminal publication failure after all protected owners close", async () => {
    for (const outcome of ["complete", "throw"] as const) {
      await withScenario("namespace", outcome, async scenario => {
        let attempts = 0;
        let attemptedPayload: unknown;
        scenario.input["protectedTaskResultPublication"] = {
          publish: async (payload: unknown) => {
            attempts += 1;
            attemptedPayload = payload;
            throw new Error("terminal publication failed");
          },
          park: async () => { throw new Error("unexpected park"); },
          awaitSettled: async () => false,
        };
        const diagnostics: string[] = [];
        const logSpy = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
          diagnostics.push(values.map(String).join(" "));
        });
        let failure: unknown;
        try {
          failure = await consume(scenario.prepared.executor(
            scenario.input,
            JOB,
            `task:${TASK}`,
            new AbortController().signal,
          )).then(() => null, (error: unknown) => error);
        } finally {
          logSpy.mockRestore();
        }
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw failure;
        expect(failure.message).toContain("terminal publication failed");
        expect(attempts).toBe(1);
        if (outcome === "throw") {
          expect(attemptedPayload).toEqual({
            formatVersion: 1,
            resultText: null,
            lastError: "Protected Task execution failed",
          });
          expect(diagnostics).toEqual([
            "[task-observer] protected fixed Memory segment rejected code=PTFMS007",
            "[task-observer] protected fixed Memory failure publication rejected code=PTFMS008 source=PTFMS007",
          ]);
        } else {
          expect(diagnostics).toEqual([]);
        }
        expect(JSON.stringify(diagnostics)).not.toContain("runner failed");
        expect(JSON.stringify(diagnostics)).not.toContain("terminal publication failed");
        expect(scenario.calls.slice(-2)).toEqual([
          "definition-close",
          "request-destroy",
        ]);
      });
    }
  });

  test("snapshots admitted identity and prohibits initial-segment resume context", async () => {
    const value = await fixture();
    const calls: string[] = [];
    const canonicalRunner = runner();
    const input = compositionInput(value.crypto, canonicalRunner);
    const mutableOccurrence = structuredClone(value.occurrence);
    const mutablePredispatch = structuredClone(value.predispatch);
    const prepare = createProtectedTaskNativeFixedMemorySegment(
      {
        ...input,
        resolveExecutionContext: async () => ({
          assistantName: "Protected Genie",
          soulFile: "",
          modelId: "protected-model",
          currentFolder: "",
          workspacePath: "",
          subagentDepth: 1,
          subagentMaxDepth: 4,
          roomRoster: [],
          continueFromCheckpoint: true,
        }),
      },
      overrides(calls),
    );
    const prepared = await prepare({
      occurrence: mutableOccurrence,
      predispatch: mutablePredispatch,
      policy: value.policy,
      reference: value.reference,
      stableRoutingDigest: value.stableRoutingDigest,
    });
    Reflect.set(mutableOccurrence.run, "graphThreadId", "substituted-thread");
    mutableOccurrence.task.cryptoRequiredNamespaceFingerprint.fill(0);
    Reflect.set(
      mutablePredispatch.memory.envelope.toolPolicy,
      "search_memory",
      "forbidden",
    );

    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async (evidence: TaskRuntimeExecutionEvidence) => {
        const terminal: unknown[] = [];
        const transient = await prepared.openTransientInput({
          occurrence: value.runningOccurrence,
          reference: value.reference,
          record: value.record,
          domains: value.domains,
          evidence,
          signal: new AbortController().signal,
        });
        await consume(prepared.executor(
          executorInput(value.occurrence, transient, terminal),
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ));
        expect(terminal).toEqual([{
          formatVersion: 1,
          resultText: null,
          lastError: "Protected Task execution failed",
        }]);
      },
    });
  });

  test("rejects plaintext policy at the direct segment boundary", async () => {
    const value = await fixture();
    const prepare = createProtectedTaskNativeFixedMemorySegment(
      compositionInput(value.crypto, runner()),
      overrides([]),
    );
    expect(() => prepare({
      occurrence: value.occurrence,
      predispatch: value.predispatch,
      policy: {
        mode: "plaintext_only",
        shadowBehavior: "fallback",
        revision: 17,
      } as unknown as ProtectedTaskRuntimeMemoryPolicy,
      reference: value.reference,
      stableRoutingDigest: value.stableRoutingDigest,
    })).toThrow("preparation is not exact");
  });

  test("refuses a fabricated transient callback before invoking it", async () => {
    const value = await fixture();
    const prepared = await createProtectedTaskNativeFixedMemorySegment(
      compositionInput(value.crypto, runner()), overrides([]),
    )({ occurrence: value.occurrence, predispatch: value.predispatch,
      policy: value.policy, reference: value.reference,
      stableRoutingDigest: value.stableRoutingDigest });
    let invoked = false;
    const fabricated = { protectedTaskNativeFixedMemorySegment: {
      run: async () => { invoked = true; },
    } };
    await Promise.resolve(expect(consume(prepared.executor(executorInput(value.occurrence, fabricated, []),
      JOB, `task:${TASK}`, new AbortController().signal))).rejects.toThrow("not issued"));
    expect(invoked).toBe(false);
  });

  test("keeps an immutable dual definition eligible under current Full policy", async () => {
    const value = await fixture();
    const task = Object.freeze({
      ...value.occurrence.task,
      contentRepresentation: "dual" as const,
    });
    const occurrence = Object.freeze({ ...value.occurrence, task });
    const predispatch = Object.freeze({
      ...value.predispatch,
      occurrence: Object.freeze({
        ...value.predispatch.occurrence,
        task,
      }),
    });
    const prepare = createProtectedTaskNativeFixedMemorySegment(
      compositionInput(value.crypto, runner()),
      overrides([]),
    );
    const prepared = await prepare({
      occurrence,
      predispatch,
      policy: value.policy,
      reference: value.reference,
      stableRoutingDigest: value.stableRoutingDigest,
    });
    expect(prepared.openTransientInput).toBeFunction();
  });

  test("does not run a protected-only definition under Shadow policy", async () => {
    const value = await fixture();
    const prepare = createProtectedTaskNativeFixedMemorySegment(
      compositionInput(value.crypto, runner()),
      overrides([]),
    );
    expect(() => prepare({
      occurrence: value.occurrence,
      predispatch: value.predispatch,
      policy: {
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: 17,
      },
      reference: value.reference,
      stableRoutingDigest: value.stableRoutingDigest,
    })).toThrow("preparation is not exact");
  });

  test("requires a typed resume matching its exact continuation reference", async () => {
    const value = await fixture();
    const prepare = createProtectedTaskNativeFixedMemorySegment(
      compositionInput(value.crypto, runner()),
      overrides([]),
    );
    const additionalAuthorityResume = {
      interruptId: "additional-authority-exact",
      authorizationRequestId: REQUEST,
      effectDisposition: "not_started_v1" as const,
      operationId: "memory-operation-exact",
      requestDigest: bytes(41),
      requiredAuthorityDigest: bytes(43),
    };
    expect(() => prepare({
      occurrence: value.occurrence,
      predispatch: value.predispatch,
      policy: value.policy,
      reference: value.reference,
      stableRoutingDigest: value.stableRoutingDigest,
      additionalAuthorityResume,
    })).toThrow("preparation is not exact");

    const continuationReference: TaskRuntimeGrantClaimPlan["reference"] = {
      ...value.reference,
      executionSegment: 2,
      resumeContinuationFingerprint: "A".repeat(43),
    };
    expect(() => prepare({
      occurrence: value.occurrence,
      predispatch: value.predispatch,
      policy: value.policy,
      reference: continuationReference,
      stableRoutingDigest: value.stableRoutingDigest,
    })).toThrow("preparation is not exact");
    expect(() => prepare({
      occurrence: value.occurrence,
      predispatch: value.predispatch,
      policy: value.policy,
      reference: continuationReference,
      stableRoutingDigest: value.stableRoutingDigest,
      additionalAuthorityResume: {
        ...additionalAuthorityResume,
        authorizationRequestId: "foreign-request",
      },
    })).toThrow("preparation is not exact");
    const humanResume = {
      kind: "approval" as const, interruptId: "approval-exact",
      requestId: "approval-request", verb: "once" as const,
    };
    const base = {
      occurrence: value.occurrence, predispatch: value.predispatch,
      policy: value.policy, stableRoutingDigest: value.stableRoutingDigest,
    };
    expect(() => prepare({ ...base, reference: value.reference, humanResume }))
      .toThrow("preparation is not exact");
    expect(() => prepare({ ...base, reference: continuationReference, humanResume,
      additionalAuthorityResume })).toThrow("preparation is not exact");
    const humanReference = { ...value.reference, executionSegment: 2,
      resumeAcceptanceId: "accepted-human-response" };
    expect(() => prepare({ ...base, reference: humanReference }))
      .toThrow("preparation is not exact");
    expect(() => prepare({ ...base, reference: humanReference, humanResume,
      additionalAuthorityResume })).toThrow("preparation is not exact");
  });

  test("rejects specialized protected metadata before context resolution", async () => {
    const value = await fixture();
    let contextResolutions = 0;
    const input = compositionInput(value.crypto, runner());
    const prepare = createProtectedTaskNativeFixedMemorySegment({
      ...input,
      resolveExecutionContext: async request => {
        contextResolutions += 1;
        return input.resolveExecutionContext(request);
      },
    }, overrides([], "complete", {
      execution: { harness: "external" },
    }));
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async evidence => {
        const terminal: unknown[] = [];
        const prepared = await prepare({
          occurrence: value.occurrence,
          predispatch: value.predispatch,
          policy: value.policy,
          reference: value.reference,
          stableRoutingDigest: value.stableRoutingDigest,
        });
        const transient = await prepared.openTransientInput({
          occurrence: value.runningOccurrence,
          reference: value.reference,
          record: value.record,
          domains: value.domains,
          evidence,
          signal: new AbortController().signal,
        });
        await consume(prepared.executor(
          executorInput(value.occurrence, transient, terminal),
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ));
        expect(terminal).toEqual([{
          formatVersion: 1,
          resultText: null,
          lastError: "Protected Task execution failed",
        }]);
      },
    });
    expect(contextResolutions).toBe(0);
  });

  test("rejoins the closed repo docs selector with encrypted target content", async () => {
    const value = await fixture();
    const selection = Object.freeze({ mode: "auto" as const, publish: "pr" as const });
    const protectedMetadata = Object.freeze({
      target: "https://example.test/repository.git",
      instructions: "Document the public package boundaries.",
      preparation: { status: "ready" },
    });
    const executionPort = Object.freeze({
      plan: async () => null,
      execute: async () => { throw new Error("unused"); },
      inspect: async () => ({ status: "absent" as const }),
    });
    const createProjectFilePort = (workDir: string) => Object.freeze({
      taskId: TASK,
      taskRunId: RUN,
      agentId: AGENT,
      humanUserId: USER,
      relayId: "relay",
      workspaceRoot: workDir,
      dispatch: async () => ({ ok: false as const, message: "unused" }),
    });
    let opened: ProtectedRepoDocsOpenedSelection | undefined;
    let segment: RunProtectedTaskNativeSegmentInput | undefined;
    const baseInput = compositionInput(value.crypto, runner());
    const prepare = createProtectedTaskNativeFixedMemorySegment({
      ...baseInput,
      resolveExecutionContext: async input => {
        opened = input.repoDocs;
        await input.assertCurrentTaskAuthority();
        return {
          ...await baseInput.resolveExecutionContext(input),
          toolWhitelist: ["file"],
          protectedRepoDocsExecutionPort: executionPort,
          createProtectedRepoDocsProjectFilePort: createProjectFilePort,
        };
      },
    }, {
      ...overrides([], "complete", protectedMetadata, undefined, {
        requireRepoDocsSelection: selection,
      }),
      runSegment: async input => {
        segment = input;
        return { formatVersion: 1, resultText: "done", lastError: null };
      },
    }, { repoDocsSelection: selection });
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async evidence => {
        const published: unknown[] = [];
        const prepared = await prepare({
          occurrence: value.occurrence,
          predispatch: value.predispatch,
          policy: value.policy,
          reference: value.reference,
          stableRoutingDigest: value.stableRoutingDigest,
        });
        const transient = await prepared.openTransientInput({
          occurrence: value.runningOccurrence,
          reference: value.reference,
          record: value.record,
          domains: value.domains,
          evidence,
          signal: new AbortController().signal,
        });
        await consume(prepared.executor(
          executorInput(value.occurrence, transient, published),
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ));
      },
    });
    expect(opened).toEqual({
      target: protectedMetadata.target,
      instructions: protectedMetadata.instructions,
      mode: "auto",
      publish: "pr",
    });
    expect(segment?.mode).toBe("repo_docs");
    expect(segment?.execution.toolWhitelist).toEqual(["file"]);
    const expectedOpened = opened;
    if (expectedOpened === undefined) throw new Error("Missing opened repo docs selection");
    expect(segment?.execution.protectedRepoDocs).toEqual({
      selection: expectedOpened,
      executionPort,
      createProjectFilePort,
    });
  });
});


test.each([false, true])("opens an accepted reply only inside fresh grant custody (stale=%s)", async stale => {
  const value = await fixture();
  const calls: string[] = [];
  const published: unknown[] = [];
  let replyHeld = false;
  let graphRuns = 0;
  const reference = { ...value.reference, executionSegment: 2, resumeAcceptanceId: REQUEST };
  const humanResume = { kind: "await_reply" as const, interruptId: "reply-interrupt",
    acceptedBy: { userId: USER, humanActorId: HUMAN },
    message: { roomId: ROOM, sessionId: ROOM, messageId: "12", editRevision: 0,
      cryptoObjectId: "reply-object", namespaceId: NAMESPACE, sourceUserId: USER } };
  const prepare = createProtectedTaskNativeFixedMemorySegment({
    ...compositionInput(value.crypto, runner()),
    owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: value.policy, revalidationToken: 17 }),
      revalidate: async () => {},
    } }),
  }, {
    ...overrides(calls, "complete"),
    createReplyAuthority: seed => {
      expect(seed.message).toEqual(humanResume.message);
      return { readCurrent: async () => stale ? null : {} as never };
    },
    replyTarget: () => ({} as never),
    verifyReplyHandle: async () => ({} as never),
    openReply: async input => {
      replyHeld = true;
      try { return await input.execute({ role: "user", content: "Accepted private answer" }, async () => {}); }
      finally { replyHeld = false; calls.push("reply-close"); }
    },
    runSegment: async segment => {
      expect(replyHeld).toBe(true);
      graphRuns++;
      expect(segment.execution.protectedTaskHumanResume).toEqual({ kind: "await_reply",
        interruptId: "reply-interrupt", reply: "Accepted private answer", fromUserId: USER });
      return { formatVersion: 1, resultText: "done", lastError: null };
    },
  });
  const prepared = await prepare({ occurrence: value.occurrence,
    predispatch: value.predispatch, policy: value.policy, reference,
    stableRoutingDigest: value.stableRoutingDigest, humanResume,
    checkpointAadBinding: { version: 1, namespaceId: NAMESPACE, domainId: DOMAIN, namespaceAccessRevision: 4, policyRevision: 17 } });
  expect(replyHeld).toBe(false);
  await withTaskRuntimeExecutionEvidenceV1({ evidence: value.evidenceInput,
    signal: new AbortController().signal, now: () => NOW,
    execute: async evidence => {
      const transient = await prepared.openTransientInput({ occurrence: value.runningOccurrence,
        reference, record: value.record, domains: value.domains, evidence,
        signal: new AbortController().signal });
      expect(JSON.stringify(transient)).not.toContain("Accepted private answer");
      expect(replyHeld).toBe(false);
      await consume(prepared.executor(executorInput(value.occurrence, transient, published, calls),
        JOB, `task:${TASK}`, new AbortController().signal));
    } });
  expect(graphRuns).toBe(stale ? 0 : 1);
  expect(replyHeld).toBe(false);
  expect(published).toHaveLength(1);
  if (!stale) expect(calls.indexOf("reply-close")).toBeLessThan(calls.indexOf("result-publish"));
});
