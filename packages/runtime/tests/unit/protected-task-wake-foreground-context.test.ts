import { expect, test } from "bun:test";
import type { ForegroundChatFundingSession } from "@nautilo/agent";
import {
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
  type ProtectedTaskWakeScheduling,
} from "@nautilo/db";
import type { LiveShadowAgentTurnSession } from "@nautilo/lattice-bridge/server";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import {
  withTaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-run-result-read-evidence-v1.ts";
import {
  withTaskRuntimeWakeForegroundEvidenceV1,
  type TaskRuntimeWakeForegroundEvidenceV1,
} from "../../../lattice-crypto/src/background/task-runtime-wake-foreground-evidence-v1.ts";
import { withPublicationSigner } from
  "../../../lattice-crypto/tests/fixtures/task-publication-signer.ts";
import {
  getCurrentLiveShadowTurnContext,
  getCurrentProtectedTaskWakeForegroundContext,
  runWithTaskWakeLiveShadowTurnSession,
} from "../../src/conversation/live-shadow-turn-context";
import { openTaskWakeFundingSessionForInvocation } from
  "../../src/task-funding-port";
import {
  freshProtectedTaskWakeForegroundActivationState,
  protectedTaskWakeForegroundMessages,
  resolveForegroundProtectedMemoryGraphDeps,
} from "../../src/executors/langgraph-executor";
import {
  assertProtectedTaskWakeForegroundJobInput,
  getCurrentProtectedTaskWakeExecutionCustody,
  protectedTaskWakeCheckpointThreadId,
  runWithProtectedTaskWakeExecutionCustody,
  snapshotProtectedTaskWakeForegroundSource,
  type ProtectedTaskWakeForegroundSource,
} from "../../src/tasks/protected-task-wake-foreground-context";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000001";
const OWNER = "30000000-0000-4000-8000-000000000001";
const REQUESTER = "40000000-0000-4000-8000-000000000001";
const HUMAN = "50000000-0000-4000-8000-000000000001";
const AGENT = "60000000-0000-4000-8000-000000000001";
const ROOM = "70000000-0000-4000-8000-000000000001";
const PARENT_ROOM = "71000000-0000-4000-8000-000000000001";
const SESSION = "80000000-0000-4000-8000-000000000001";
const NAMESPACE = "90000000-0000-4000-8000-000000000001";
const DOMAIN = "a0000000-0000-4000-8000-000000000001";
const NOW = 1_900_000_000_000;
const bytes = (value: number) => new Uint8Array(32).fill(value);

function domain() {
  return { domainId: DOMAIN, sourceNamespaceId: NAMESPACE, keyClass: "ai" as const,
    participantCount: 2, participantDigest: bytes(3), domainKeyGeneration: 4,
    authorizationRevision: 5, headDigest: bytes(6), activeNamespaceBindingCount: 1,
    activeNamespaceBindingSetDigest: bytes(7) };
}

function readEvidence(
  recipientGeneration = 1,
): TaskRuntimeRunResultReadEvidenceInputV1 {
  const jobId = protectedTaskRunWakeJobId(RUN);
  const bindingId = protectedTaskRunOutputBindingId(RUN);
  const operationId = protectedTaskRunWakeOperationId(RUN);
  return {
    purpose: "task.runtime.run_result_read", workKind: "task.delivery_wake",
    requestId: `task-wake-authorization:${jobId}`, workId: jobId,
    claimId: "claim", claimExpiresAt: NOW + 30_000,
    recipientExpiresAt: NOW + 20_000, authorizationExpiresAt: NOW + 10_000,
    expiresAt: NOW + 10_000, recipientGeneration, recipientKeyId: "recipient",
    authorizationDigest: bytes(1), requesterHumanId: HUMAN, policyRevision: 7,
    episodeId: SESSION, sourceRoomId: ROOM, hostAuthorizationRevision: 2,
    recipientAuthorizationRevision: 3, operations: ["decrypt"],
    result: { taskId: TASK, taskRunId: RUN, terminalStatus: "completed",
      contentRevision: 1, objectId: protectedTaskRunResultObjectId(TASK, RUN),
      cryptoAccessRevision: 0, genesisManifestHash: bytes(2), signerAgentId: AGENT,
      namespace: { namespaceId: "private", domainId: "private-domain",
        operations: ["decrypt"], expectedAccessRevision: 4,
        expectedPolicyRevision: 7 } },
    invocation: { kind: "wake", bindingId, operationId, roomId: ROOM,
      sessionId: SESSION, jobId,
      reference: { kind: "protected_task_delivery_v1", taskId: TASK,
        taskRunId: RUN, bindingId,
        resultObjectId: protectedTaskRunResultObjectId(TASK, RUN),
        wakeOperationId: operationId } },
    resultDomain: { ...domain(), domainId: "private-domain",
      sourceNamespaceId: "private" }, messageWrite: null,
  };
}

function withWake<T>(
  execute: (evidence: TaskRuntimeWakeForegroundEvidenceV1) => T | Promise<T>,
  recipientGeneration = 1,
) {
  return withTaskRuntimeRunResultReadEvidenceV1({
    evidence: readEvidence(recipientGeneration),
    now: () => NOW, signal: new AbortController().signal,
    execute: read => withTaskRuntimeWakeForegroundEvidenceV1({ readEvidence: read,
      committerDeviceId: "device", committerDeviceSigningGeneration: 2,
      committerDeviceSigningPublicKeyHash: bytes(8),
      namespaceRequirements: [{ ordinal: 1, namespaceId: NAMESPACE,
        domainId: DOMAIN, operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 4, expectedPolicyRevision: 7 }],
      domainRequirements: [domain()], execute }),
  });
}

const fundingSession: ForegroundChatFundingSession = {
  kind: "personal",
  admission: { modelId: "openai:model",
    binding: { kind: "personal", providerRoute: "openai", credentialId: "credential",
      credentialRevision: 1 } },
  recheckAttempt: async () => {},
  runAttempt: async (_model, callback) => callback({
    usageFunding: { kind: "personal", humanUserId: REQUESTER,
      payerHumanId: REQUESTER, providerRoute: "openai", credentialId: "credential",
      credentialRevision: 1 },
  }),
};

function source(
  evidence: TaskRuntimeWakeForegroundEvidenceV1,
  initialAgentAuthorizationRevision = 11,
): ProtectedTaskWakeForegroundSource {
  const namespaceId = evidence.namespaceRequirements[0]?.namespaceId;
  if (namespaceId === undefined) throw new Error("wake namespace fixture");
  const scheduling: ProtectedTaskWakeScheduling = {
    taskId: evidence.invocation.reference.taskId,
    taskRunId: evidence.invocation.reference.taskRunId,
    jobId: evidence.invocation.jobId,
    ownerId: REQUESTER, requestorId: REQUESTER,
    agentId: evidence.signerAgentId, roomId: evidence.sourceRoomId,
    namespaceId, sessionId: evidence.episodeId, sessionOwnerId: OWNER,
    graphThreadId: "room-thread", laneKey: `room:${evidence.sourceRoomId}`,
    reference: evidence.invocation.reference, jobState: "queued",
  };
  return { evidence, scheduling,
    result: { formatVersion: 1, resultText: "private result", lastError: null },
    resultMessagePublished: false, actorRole: "member",
    roomRoster: [
      { actorId: evidence.requesterHumanId, kind: "user", userId: REQUESTER,
        displayName: "Requester", roomRole: "member" },
      { actorId: "agent-actor", kind: "agent", agentId: evidence.signerAgentId,
        displayName: "Genie", roomRole: "member" },
    ],
    memoryAccessEnvelope: { ownerId: REQUESTER,
      actorId: evidence.requesterHumanId,
      agentId: evidence.signerAgentId, roomId: evidence.sourceRoomId,
      readableNamespaces: [namespaceId],
      mutableNamespaces: [namespaceId], writableNamespaces: [namespaceId],
      toolPolicy: {} }, subthread: null, fundingSession,
    checkpointBinding: {
      retainedSourceNamespaceIds: [namespaceId],
      sourceEnvelopeDigest: bytes(9),
      initialPolicyRevision: evidence.policyRevision,
      initialAgentAuthorizationRevision,
    } };
}

function jobInput() {
  return { ownerId: REQUESTER, requestorId: REQUESTER, agentId: AGENT,
    roomId: ROOM, graphThreadId: "room-thread", threadId: "room-thread",
    turnId: protectedTaskRunWakeOperationId(RUN), message: "",
    attachmentTextBlocks: [], multimodalImages: [], roomRoster: [],
    artifactRefs: [], focusedResources: [], verifiedOrdinaryOrigin: null,
    activeMiniApp: null, liveMiniAppSession: null };
}

test("binds a genuine wake to one protected foreground scope and reuses its funding custody", async () => {
  let retained: TaskRuntimeWakeForegroundEvidenceV1 | undefined;
  await withWake(async evidence => {
    retained = evidence;
    const controller = new AbortController();
    const session = { authorizationSignal: controller.signal,
      authorizationDeadlineAt: NOW + 10_000,
      checkpoint: {} } as LiveShadowAgentTurnSession;
    const current = source(evidence);
    await runWithTaskWakeLiveShadowTurnSession({ source: current, session,
      enforcementPolicy: { mode: "encrypted_only", shadowBehavior: "strict",
        revision: 7 },
      dataOperationPolicy: { resolve: async () => ({ policy: {
        mode: "encrypted_only", shadowBehavior: "strict" },
        revalidationToken: 7 }), revalidate: async () => {} },
      work: async () => {
        expect(getCurrentLiveShadowTurnContext()?.capability).toBeNull();
        expect(getCurrentProtectedTaskWakeForegroundContext()?.result.resultText)
          .toBe("private result");
        const graphDeps = await resolveForegroundProtectedMemoryGraphDeps({
          envelope: null, session: null, policy: undefined, normalForeground: true,
        });
        expect(graphDeps.confidential).toBe(true);
        assertProtectedTaskWakeForegroundJobInput({ source: current,
          jobInput: jobInput(), jobId: current.scheduling.jobId,
          laneKey: current.scheduling.laneKey });
        expect(await openTaskWakeFundingSessionForInvocation({
          authority: createAcceptedInvocationAuthority(REQUESTER,
            { originTaskId: TASK }),
          jobInput: jobInput(), causalHumanUserId: null, modelId: "openai:model",
          roomId: ROOM, agentId: AGENT,
        })).toBe(fundingSession);
        for (const changed of [
          { authority: createAcceptedInvocationAuthority(REQUESTER,
            { originTaskId: "foreign" }) },
          { authority: createAcceptedInvocationAuthority("foreign",
            { originTaskId: TASK }) },
          { causalHumanUserId: REQUESTER },
          { modelId: "openai:foreign" },
        ]) {
          // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun asynchronous assertion typing
          await expect(openTaskWakeFundingSessionForInvocation({
            authority: createAcceptedInvocationAuthority(REQUESTER,
              { originTaskId: TASK }),
            jobInput: jobInput(), causalHumanUserId: null,
            modelId: "openai:model", roomId: ROOM, agentId: AGENT,
            ...changed,
          })).rejects.toThrow();
        }
        const messages = protectedTaskWakeForegroundMessages(current);
        expect(messages.map(message => message._getType())).toEqual(["ai", "system"]);
        expect(messages[0]!.content).toBe("private result");
        const control = messages[1]!.content;
        if (typeof control !== "string") throw new Error("control fixture");
        expect(control).not.toContain("private result");
        expect(messages[1]!.additional_kwargs).toEqual({
          nautilo_task_wake_continuation: true,
        });
        expect(freshProtectedTaskWakeForegroundActivationState()).toMatchObject({
          trustedExecutionEntrypoint: "foreground.task_report_back",
          suppressToolLifecycleEvents: true,
          taskRun: false,
        });
      },
    });
    expect(getCurrentProtectedTaskWakeForegroundContext()).toBeUndefined();
    const ordinaryGraphDeps = await resolveForegroundProtectedMemoryGraphDeps({
      envelope: null, session: null, policy: undefined, normalForeground: true,
    });
    expect(ordinaryGraphDeps.confidential).toBeUndefined();
  });
  expect(() => snapshotProtectedTaskWakeForegroundSource(source(retained!))).toThrow();
});

test("rejects serialized wake markers, substituted identities and caller mutation", async () => {
  await withWake(async evidence => {
    const current = source(evidence);
    expect(() => assertProtectedTaskWakeForegroundJobInput({ source: current,
      jobInput: { ...jobInput(), metadata: { originatedBy: "task" } },
      jobId: current.scheduling.jobId, laneKey: current.scheduling.laneKey })).toThrow();
    expect(() => snapshotProtectedTaskWakeForegroundSource({ ...current,
      scheduling: { ...current.scheduling, roomId: "foreign" } })).toThrow();
    const mutable = source(evidence);
    const snap = snapshotProtectedTaskWakeForegroundSource(mutable);
    if (mutable.memoryAccessEnvelope.memoryMode === "scope") throw new Error("fixture");
    mutable.memoryAccessEnvelope.readableNamespaces.length = 0;
    mutable.roomRoster[0]!.displayName = "changed";
    mutable.checkpointBinding.sourceEnvelopeDigest.fill(0);
    expect(snap.memoryAccessEnvelope).toMatchObject({
      readableNamespaces: [NAMESPACE], roomId: ROOM,
    });
    expect(snap.roomRoster[0]!.displayName).toBe("Requester");
    expect(snap.checkpointBinding.sourceEnvelopeDigest).toEqual(bytes(9));
    expect(() => snapshotProtectedTaskWakeForegroundSource({
      ...source(evidence),
      checkpointBinding: {
        ...source(evidence).checkpointBinding,
        retainedSourceNamespaceIds: [ROOM],
      },
    })).toThrow();
    expect(protectedTaskWakeForegroundMessages({ ...snap,
      resultMessagePublished: true }).map(message => message._getType()))
      .toEqual(["system"]);
    expect(protectedTaskWakeForegroundMessages({ ...snap,
      resultMessagePublished: true })[0]!.additional_kwargs).toEqual({
      nautilo_task_wake_continuation: true,
    });
    const child = source(evidence);
    const childEnvelope = child.memoryAccessEnvelope;
    if (childEnvelope.memoryMode === "scope") throw new Error("fixture");
    expect(snapshotProtectedTaskWakeForegroundSource({ ...child,
      subthread: { parentRoomId: PARENT_ROOM, anchorMessageId: 42 },
      memoryAccessEnvelope: { ...childEnvelope, roomId: PARENT_ROOM },
    }).subthread).toEqual({ parentRoomId: PARENT_ROOM, anchorMessageId: 42 });
  });
});

test("binds revision zero to a live certified signer and retains an authenticated continuation revision", async () => {
  await withPublicationSigner(({ evidence }) => {
    const fresh = snapshotProtectedTaskWakeForegroundSource(source(evidence, 0));
    expect(fresh.checkpointBinding.initialAgentAuthorizationRevision).toBe(0);

    const continuation = {
      segment: 1,
      checkpointThreadId: protectedTaskWakeCheckpointThreadId(
        fresh.scheduling.jobId,
      ),
      resume: {
        interruptId: "interrupt:projection:1",
        authorizationRequestId: "task.memory.projection:request-1",
        effectDisposition: "not_started_v1" as const,
        operationId: "memory:projection:1",
        requestDigest: bytes(20),
        requiredAuthorityDigest: bytes(21),
      },
    };
    const resumed = snapshotProtectedTaskWakeForegroundSource({
      ...source(evidence, 11), continuation,
    });
    expect(resumed.checkpointBinding.initialAgentAuthorizationRevision).toBe(11);
    expect(() => snapshotProtectedTaskWakeForegroundSource({
      ...source(evidence, 11),
      continuation: { ...continuation, checkpointThreadId: "substituted" },
    })).toThrow("foreground source is invalid");
  }, { recipientGeneration: 1 });

  await withWake(evidence => {
    expect(() => snapshotProtectedTaskWakeForegroundSource(source(evidence, 0)))
      .toThrow("foreground source is invalid");
  });
});

test("binds continuation identity and park custody only to their live callbacks", async () => {
  await withWake(async evidence => {
    const current = source(evidence);
    const checkpointThreadId = protectedTaskWakeCheckpointThreadId(
      current.scheduling.jobId,
    );
    const resumed = snapshotProtectedTaskWakeForegroundSource({
      ...current,
      continuation: {
        segment: evidence.recipientGeneration,
        checkpointThreadId,
        resume: {
          interruptId: "interrupt:projection:1",
          authorizationRequestId: "task.memory.projection:request-1",
          effectDisposition: "not_started_v1",
          operationId: "memory:projection:1",
          requestDigest: bytes(20),
          requiredAuthorityDigest: bytes(21),
        },
      },
    });
    expect(resumed.continuation?.checkpointThreadId).toBe(checkpointThreadId);
    expect(() => snapshotProtectedTaskWakeForegroundSource({
      ...current,
      continuation: {
        ...resumed.continuation!,
        segment: evidence.recipientGeneration + 1,
      },
    })).toThrow();
    let retained: ReturnType<typeof getCurrentProtectedTaskWakeExecutionCustody>;
    await runWithProtectedTaskWakeExecutionCustody({
      park: async () => ({ status: "parked" }),
    }, async () => {
      retained = getCurrentProtectedTaskWakeExecutionCustody();
      expect(retained).toBeDefined();
    });
    expect(getCurrentProtectedTaskWakeExecutionCustody()).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun asynchronous assertion typing
    await expect(retained!.park({} as never)).rejects.toThrow("escaped");
  });
});

test("accepts an older committed continuation segment after recipient renewal", async () => {
  await withWake(async evidence => {
    const current = source(evidence);
    expect(snapshotProtectedTaskWakeForegroundSource({
      ...current,
      continuation: {
        segment: 1,
        checkpointThreadId: protectedTaskWakeCheckpointThreadId(
          current.scheduling.jobId,
        ),
        resume: {
          interruptId: "interrupt:projection:1",
          authorizationRequestId: "task.memory.projection:request-1",
          effectDisposition: "not_started_v1",
          operationId: "memory:projection:1",
          requestDigest: bytes(20),
          requiredAuthorityDigest: bytes(21),
        },
      },
    }).continuation?.segment).toBe(1);
  }, 2);
});

test("requires an encrypted checkpoint and protected policy before lending the wake", async () => {
  await withWake(async evidence => {
    let effects = 0;
    const common = {
      source: source(evidence),
      dataOperationPolicy: { resolve: async () => ({ policy: {
        mode: "encrypted_only" as const, shadowBehavior: "strict" as const },
        revalidationToken: 7 }), revalidate: async () => {} },
      work: async () => { effects++; },
    };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun asynchronous assertion typing
    await expect(runWithTaskWakeLiveShadowTurnSession({ ...common,
      session: { authorizationSignal: new AbortController().signal,
        authorizationDeadlineAt: NOW + 10_000 } as LiveShadowAgentTurnSession,
      enforcementPolicy: { mode: "encrypted_only", shadowBehavior: "strict",
        revision: 7 },
    })).rejects.toThrow();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun asynchronous assertion typing
    await expect(runWithTaskWakeLiveShadowTurnSession({ ...common,
      session: { authorizationSignal: new AbortController().signal,
        authorizationDeadlineAt: NOW + 10_000,
        checkpoint: {} } as LiveShadowAgentTurnSession,
      enforcementPolicy: { mode: "plaintext_only", shadowBehavior: "fallback",
        revision: 7 },
    })).rejects.toThrow();
    expect(effects).toBe(0);
  });
});
