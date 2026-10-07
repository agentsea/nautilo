import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";

import type { PostgresJsBridgeConnection } from "@nautilo/db";
import type { TaskPayloadV1 } from "@nautilo/lattice-bridge";
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
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import { createProtectedTaskTranscriptPort } from "@nautilo/runtime";
import type {
  ConversationProductCanonicalTransactionRunner,
  ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskOccurrence,
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
const DOMAIN = "a0000000-0000-4000-8000-00000000000a";
const SCOPE = "b0000000-0000-4000-8000-00000000000b";
const MEMORY_ROOM = "c0000000-0000-4000-8000-00000000000c";
const INPUT_OBJECT = `task-definition:v1:${"a".repeat(64)}`;
const RESULT_OBJECT = `task-run-result:v1:${"b".repeat(64)}`;
const REQUEST = `task-run-authorization:${RUN}`;

const bytes = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

async function fixture(mode: "namespace" | "scope" = "namespace") {
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
    authorizationId: REQUEST,
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
    requestId: REQUEST,
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
  const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
    requestId: REQUEST,
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
    authorizationRequestId: REQUEST,
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
      requestId: REQUEST,
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
    descriptorBytes: encodeTaskRuntimeBackgroundAuthorizationRequestV1(request),
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
      credentialId: REQUEST,
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
  return {
    crypto,
    request,
    evidenceInput,
    occurrence,
    predispatch,
    policy,
    reference,
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
    repairExactCandidate: async () => ({
      status: "unavailable",
      reason: "authorization_required",
    }),
    fallbackOrdinary: Object.freeze({}) as ProtectedTaskNativeFixedMemorySegmentInput["fallbackOrdinary"],
    createDedicatedPool: () => Object.freeze({}) as ReturnType<
      ProtectedTaskNativeFixedMemorySegmentInput["createDedicatedPool"]
    >,
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
  outcome: "complete" | "throw" | "interrupt" = "complete",
  protectedMetadata: TaskPayloadV1["protectedMetadata"] = {},
  onDefinitionClose?: () => void,
) {
  const repository = Object.freeze({
    search: async () => ({ status: "success" as const, value: [] }),
    save: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
    replace: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
    setTier: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
  });
  return {
    decodeRequest: decodeTaskRuntimeBackgroundAuthorizationRequestV1,
    destroyRequest: () => { calls.push("request-destroy"); },
    createDefinitionLoader: (
      _dependencies: unknown,
      options: { requireNativeExecution?: true },
    ) => {
      expect(options).toEqual({ requireNativeExecution: true });
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
      execute(value: typeof repository): Promise<unknown>;
      current: { jobId: string };
      authority: { mode: string };
    }) => {
      calls.push(`repository-open:${input.current.jobId}:${input.authority.mode}`);
      try { return await input.execute(repository); }
      finally { calls.push("repository-close"); }
    },
    withCheckpointSaver: async (input: {
      execute(value: unknown): Promise<unknown>;
    }) => {
      calls.push("checkpoint-open");
      try { return await input.execute(Object.freeze({})); }
      finally { calls.push("checkpoint-close"); }
    },
    createTranscriptPort: () => Object.freeze({
      quiesce: async () => ({ failedPublicationCount: 0 }),
      publishBatch: async () => undefined,
    }),
    runSegment: async (input: {
      memoryHandoff: Record<string, unknown>;
    }) => {
      calls.push("runner");
      expect(Object.keys(input.memoryHandoff).sort()).toEqual([
        "fullEncryptionOnly",
        "repository",
        "search",
      ]);
      if (outcome === "throw") throw new Error("runner failed");
      if (outcome === "interrupt") {
        return {
          status: "interrupted" as const,
          threadId: `subagent:task:${TASK}:${RUN}`,
          interrupt: {},
          interruptCoordinates: [{ id: "approval-1", kind: "approval" as const,
            requestId: "request-1" }],
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
  outcome: "complete" | "throw" | "interrupt" = "complete",
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
        ...(value.scopeMemory === undefined ? {} : {
          scopeMemory: value.scopeMemory,
          scopeWorkIdentity: "fixed-scope-work-identity",
        }),
      });
      const transient = await prepared.openTransientInput({
        occurrence: value.occurrence,
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
  outcome: "complete" | "throw" | "interrupt",
  use: (scenario: Awaited<ReturnType<typeof executeScenario>>) => Promise<Value>,
  onDefinitionClose?: () => void,
): Promise<Value> {
  const value = await fixture(mode);
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
        ...(value.scopeMemory === undefined ? {} : {
          scopeMemory: value.scopeMemory,
          scopeWorkIdentity: "fixed-scope-work-identity",
        }),
      });
      const transient = await prepared.openTransientInput({
        occurrence: value.occurrence,
        record: value.record,
        domains: value.domains,
        evidence,
        signal: new AbortController().signal,
      });
      const input = executorInput(value.occurrence, transient, published, calls);
      return use({ value, calls, published, prepared, transient, input });
    },
  });
}

describe("protected Task native fixed Memory segment", () => {
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
          });
          const transient = await prepared.openTransientInput({
            occurrence: value.occurrence, record: value.record,
            domains: value.domains, evidence, signal: new AbortController().signal,
          });
          const execution = consume(prepared.executor(
            executorInput(value.occurrence, transient, terminal, calls),
            JOB, `task:${TASK}`, new AbortController().signal,
          ));
          await started.promise;
          expect(calls).not.toContain("checkpoint-close");
          expect(terminal).toEqual([]);
          release.resolve();
          if (fails) {
            // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
            await expect(execution).rejects.toThrow("transcript publication did not complete");
            expect(terminal).toEqual([]);
          } else {
            await execution;
            expect(terminal).toHaveLength(1);
            expect(calls.indexOf("transcript-stored"))
              .toBeLessThan(calls.indexOf("checkpoint-close"));
          }
          expect(calls).toContain("definition-close");
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
        });
        const transient = await prepared.openTransientInput({
          occurrence: value.occurrence,
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

  test("closes callback owners on runner failure and rejects unsupported continuation", async () => {
    for (const outcome of ["throw", "interrupt"] as const) {
      await withScenario("namespace", outcome, async scenario => {
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
        await expect(consume(scenario.prepared.executor(
          scenario.input,
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ))).rejects.toThrow(outcome === "throw"
          ? "runner failed"
          : "continuation is unavailable");
        expect(scenario.calls.slice(-5)).toEqual([
          "checkpoint-close",
          "repository-close",
          "signer-close",
          "definition-close",
          "request-destroy",
        ]);
      });
    }
  });

  test("does not publish a terminal result after Job cancellation during owner close", async () => {
    const job = new AbortController();
    await withScenario("namespace", "complete", async scenario => {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(consume(scenario.prepared.executor(
        scenario.input,
        JOB,
        `task:${TASK}`,
        job.signal,
      ))).rejects.toThrow();
      expect(scenario.published).toEqual([]);
      expect(scenario.calls).not.toContain("result-publish");
      expect(scenario.calls).toContain("definition-close");
    }, () => { job.abort(); });
  });

  test("awaits terminal publication failure after all protected owners close", async () => {
    await withScenario("namespace", "complete", async scenario => {
      let attempts = 0;
      scenario.input["protectedTaskResultPublication"] = {
        publish: async () => {
          attempts += 1;
          throw new Error("terminal publication failed");
        },
      };
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(consume(scenario.prepared.executor(
        scenario.input,
        JOB,
        `task:${TASK}`,
        new AbortController().signal,
      ))).rejects.toThrow("terminal publication failed");
      expect(attempts).toBe(1);
      expect(scenario.calls.slice(-2)).toEqual([
        "definition-close",
        "request-destroy",
      ]);
    });
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
        const transient = await prepared.openTransientInput({
          occurrence: value.occurrence,
          record: value.record,
          domains: value.domains,
          evidence,
          signal: new AbortController().signal,
        });
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
        await expect(consume(prepared.executor(
          executorInput(value.occurrence, transient, []),
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ))).rejects.toThrow("execution context is invalid");
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
    })).toThrow("preparation is not exact");
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
        const prepared = await prepare({
          occurrence: value.occurrence,
          predispatch: value.predispatch,
          policy: value.policy,
          reference: value.reference,
        });
        const transient = await prepared.openTransientInput({
          occurrence: value.occurrence,
          record: value.record,
          domains: value.domains,
          evidence,
          signal: new AbortController().signal,
        });
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
        await expect(consume(prepared.executor(
          executorInput(value.occurrence, transient, []),
          JOB,
          `task:${TASK}`,
          new AbortController().signal,
        ))).rejects.toThrow("requires a specialized route");
      },
    });
    expect(contextResolutions).toBe(0);
  });
});
