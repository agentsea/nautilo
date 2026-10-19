import { describe, expect, test } from "bun:test";
import {
  encryptionTransitionPolicy,
  groupMembers,
  protectedTaskRunOutputBindings,
  roomMembers,
  rooms,
  sessions,
  taskRuns,
  tasks,
  type ProtectedTaskWakeContinuationReceipt,
  type ProtectedTaskWakeScheduling,
} from "@nautilo/db";
import type { ForegroundChatFundingSession } from "@nautilo/agent";
import type { DomainForegroundSecretEntry } from "@nautilo/lattice-crypto";
import type { CanonicalTranscriptTx, PolicyResolver } from "@nautilo/trust";
import { withWakeEvidence } from
  "../../../lattice-bridge/tests/fixtures/task-wake-foreground-evidence";
import {
  createProtectedTaskWakeForegroundContextOwner,
  protectedTaskWakeSourceEnvelopeDigest,
} from "../../src/routes/protected-task-wake-foreground-context";
import type {
  ProtectedTaskWakePublication,
} from "../../src/routes/protected-task-wake-foreground-publication";

const NOW = 1_800_500_000_000;
const USER = "60000000-0000-4000-8000-000000000001";
const ROOM_OWNER = "60000000-0000-4000-8000-000000000002";
const OWNER_ACTOR = "60000000-0000-4000-8000-000000000003";
const AGENT_ACTOR = "60000000-0000-4000-8000-000000000004";
const AGENT = "80000000-0000-4000-8000-000000000001";
const NS = "90000000-0000-4000-8000-000000000001";
const PARENT = "90000000-0000-4000-8000-000000000002";
const CHANGED_PARENT = "90000000-0000-4000-8000-000000000004";
const EXECUTION_JOB = "90000000-0000-4000-8000-000000000003";
const domain = Object.freeze({ domainId: "wake-domain", sourceNamespaceId: NS,
  keyClass: "ai", participantCount: 1, participantDigest: new Uint8Array(32).fill(1),
  domainKeyGeneration: 1, authorizationRevision: 2,
  headDigest: new Uint8Array(32).fill(2), domainKey: new Uint8Array(32).fill(7),
}) as DomainForegroundSecretEntry;

type Options = Readonly<{
  subthread?: boolean;
  readableNamespaces?: readonly string[];
  mode?: "shadow_encryption" | "encrypted_only" | "plaintext_only";
  definitionRepresentation?: "ordinary" | "dual" | "protected";
  policyRevision?: number;
  messagePublished?: boolean;
  deliveryMode?: "wake" | "raw_and_wake";
  sessionOwnerId?: string;
  requesterPresent?: boolean;
  fundingMode?: "caller" | "legacy_server";
  runStatus?: "completed" | "errored" | "cancelled";
  syntheticCancelledRun?: boolean;
  resume?: boolean;
  mutableNamespaces?: readonly string[];
  writableNamespaces?: readonly string[];
  toolPolicy?: Readonly<Record<string, "allow" | "forbidden">>;
  secondReadableNamespaces?: readonly string[];
  secondToolPolicy?: Readonly<Record<string, "allow" | "forbidden">>;
  secondOwnerId?: string;
  changedParentOnSecondPass?: boolean;
}>;

async function withFixture<Value>(options: Options,
  execute: (fixture: Awaited<ReturnType<typeof make>>) => Promise<Value>,
): Promise<Value> {
  return withWakeEvidence({ now: NOW, clock: () => NOW, domain,
    namespaceId: NS, accessRevision: 3, policyRevision: 7,
    signerAgentId: AGENT,
    execute: async wakeEvidence => execute(await make(wakeEvidence, options)),
  });
}

async function make(
  wakeEvidence: ProtectedTaskWakePublication["wakeEvidence"],
  options: Options,
) {
  const result = wakeEvidence.invocation.reference;
  const runStatus = options.runStatus ?? "completed";
  const deliveryMode = options.deliveryMode ?? "wake";
  const messagePublished = options.messagePublished ?? false;
  const fundingMode = options.fundingMode ?? "caller";
  const scheduling: ProtectedTaskWakeScheduling = Object.freeze({
    taskId: result.taskId,
    taskRunId: result.taskRunId,
    jobId: wakeEvidence.workId,
    ownerId: USER,
    requestorId: USER,
    agentId: AGENT,
    roomId: wakeEvidence.sourceRoomId,
    namespaceId: NS,
    sessionId: wakeEvidence.episodeId,
    sessionOwnerId: options.sessionOwnerId ?? ROOM_OWNER,
    graphThreadId: "wake-thread",
    laneKey: `room:${wakeEvidence.sourceRoomId}`,
    reference: wakeEvidence.invocation.reference,
    jobState: "running",
  });
  const defaultResumeToolPolicy = Object.freeze({ save_memory: "allow" as const,
    share_memory: "allow" as const });
  const retainedEnvelope = Object.freeze({ memoryMode: "namespace" as const,
    ownerId: USER, actorId: wakeEvidence.requesterHumanId, agentId: AGENT,
    roomId: wakeEvidence.sourceRoomId, readableNamespaces: [NS],
    mutableNamespaces: [NS], writableNamespaces: [NS],
    toolPolicy: defaultResumeToolPolicy });
  const continuation: ProtectedTaskWakeContinuationReceipt | undefined = options.resume
    ? Object.freeze({ taskId: result.taskId, taskRunId: result.taskRunId,
        wakeJobId: scheduling.jobId, bindingId: result.bindingId,
        wakeOperationId: result.wakeOperationId, segment: 2,
        priorRecipientGeneration: 1,
        wakeAuthorizationRequestId: `task-wake-authorization:${scheduling.jobId}`,
        additionalAuthorizationRequestId: "projection:authorization:2",
        interruptId: "projection:interrupt:2", operationId: "projection:operation:2",
        requestDigest: new Uint8Array(32).fill(11),
        requiredAuthorityDigest: new Uint8Array(32).fill(12),
        semanticAuthorityRequirements: [], retainedSourceNamespaceIds: [NS],
        sourceEnvelopeDigest: protectedTaskWakeSourceEnvelopeDigest(retainedEnvelope),
        initialPolicyRevision: 5, initialAgentAuthorizationRevision: 9,
        destinationRoomId: PARENT, destinationNamespaceId: PARENT,
        destinationAuthorityDigest: new Uint8Array(32).fill(13),
        checkpointThreadId: `protected-task-wake:${scheduling.jobId}`,
        checkpointContract: "encrypted_langgraph_v1", expectedCheckpointCount: 2,
        checkpointOrderedDigest: new Uint8Array(32).fill(14), expectedBlobCount: 1,
        blobOrderedDigest: new Uint8Array(32).fill(15), expectedPendingWriteCount: 0,
        pendingWriteOrderedDigest: new Uint8Array(32).fill(16),
        sealedAt: new Date(NOW - 500),
      })
    : undefined;
  const publication = {
    wakeEvidence,
    signal: new AbortController().signal,
    plan: {
      foregroundNamespaceIds: [NS],
      intent: {
        requesterUserId: USER,
        requesterHumanId: wakeEvidence.requesterHumanId,
        agentId: AGENT,
        contentNamespaceId: "private-result",
        representation: options.mode === "shadow_encryption" ? "dual" : "protected",
        expectedPolicyRevision: 7,
        acceptedPolicyRevision: 6,
        initialState: "wake_running",
        ...(continuation === undefined ? {} : { continuation }),
        result: {
          taskId: result.taskId,
          taskRunId: result.taskRunId,
          terminalStatus: runStatus,
          contentRevision: 1,
          objectId: result.resultObjectId,
          cryptoAccessRevision: 0,
          genesisManifestHash: new Uint8Array(32).fill(5),
          signerAgentId: AGENT,
        },
        invocation: wakeEvidence.invocation,
      },
    },
  } as unknown as ProtectedTaskWakePublication;
  let roomRead = 0;
  const rows = (table: unknown): readonly unknown[] => {
    if (table === rooms) {
      roomRead += 1;
      if (!options.subthread || roomRead % 2 === 1) return [{ id: scheduling.roomId, ownerId: ROOM_OWNER,
        namespaceId: NS, graphThreadId: "child-thread",
        kind: options.subthread ? "subthread" : "group",
        parentRoomId: options.subthread ? PARENT : null,
        threadRootMessageId: options.subthread ? 42 : null,
        deletedThreadRootMessageId: null, archivedAt: null }];
      const parentId = options.changedParentOnSecondPass && roomRead > 2
        ? CHANGED_PARENT : PARENT;
      return [{ id: parentId, archivedAt: null, parentRoomId: null, kind: "group" }];
    }
    if (table === sessions) return [{ id: scheduling.sessionId,
      ownerId: ROOM_OWNER, agentId: AGENT, roomId: scheduling.roomId,
      threadId: scheduling.graphThreadId, personaId: "owner" }];
    if (table === roomMembers) return [
      ...(options.requesterPresent === false ? [] : [{
        actorId: wakeEvidence.requesterHumanId, kind: "user",
        displayName: "Requester", agentId: null, ownerId: USER,
        userHandle: "requester", userDisplayName: "Requester",
        agentHandle: null, agentAvatar: null, roomRole: "member",
        agentResponseMode: null,
      }]),
      { actorId: OWNER_ACTOR, kind: "user", displayName: "Room owner",
        agentId: null, ownerId: ROOM_OWNER, userHandle: "room-owner",
        userDisplayName: "Room owner", agentHandle: null, agentAvatar: null,
        roomRole: "admin", agentResponseMode: null },
      { actorId: AGENT_ACTOR, kind: "agent", displayName: "Genie",
        agentId: AGENT, ownerId: ROOM_OWNER, userHandle: "room-owner",
        userDisplayName: "Room owner", agentHandle: "genie", agentAvatar: null,
        roomRole: "member", agentResponseMode: "active" },
    ];
    if (table === groupMembers) return [{ slug: "member" }, { slug: "admin" }];
    if (table === encryptionTransitionPolicy) return [{ id: "server",
      mode: options.mode ?? "encrypted_only", shadowBehavior: "strict",
      revision: options.policyRevision ?? 7 }];
    if (table === protectedTaskRunOutputBindings) return [{
      bindingId: result.bindingId, taskRunId: result.taskRunId,
      destinationRoomId: scheduling.roomId, destinationNamespaceId: NS,
      wakeOperationId: result.wakeOperationId, wakeJobId: scheduling.jobId,
      deliveryMode, messageId: messagePublished ? 51 : null,
      messagePublishedAt: messagePublished ? new Date(NOW - 100) : null,
    }];
    if (table === tasks) return [{ id: result.taskId, ownerId: USER,
      requestorId: USER, agentId: AGENT, preset: "in_background",
      callingRoomId: "70000000-0000-4000-8000-000000000001",
      targetChat: "last_in_namespace", targetChatHandle: null,
      targetRoomId: "70000000-0000-4000-8000-000000000001",
      targetUserIds: [USER], useScope: false, scopeId: null,
      toolsMode: "none", toolsWhitelist: [], awaitResponse: false,
      selectionProfile: "balanced", selectionSpec: null,
      requestedModelId: "anthropic:test", parentTaskId: null, depth: 0,
      fundingMode, metadata: {}, contentRepresentation:
        options.definitionRepresentation ?? (options.mode === "shadow_encryption" ? "dual" : "protected"),
      contentNamespaceId: "private-result", contentRevision: 1,
      cryptoObjectId: "task-definition:v1:a", cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(8),
      cryptoMappingState: "verified" }];
    if (table === taskRuns) return [{ id: result.taskRunId, taskId: result.taskId,
      jobId: !options.syntheticCancelledRun
        ? EXECUTION_JOB : null,
      graphThreadId: "task-thread", status: runStatus,
      modelId: !options.syntheticCancelledRun
        ? "anthropic:test" : null,
      fundingBinding: fundingMode === "caller" && !options.syntheticCancelledRun
        ? { kind: "server", providerRoute: "anthropic" } : null,
      fundingPredecessorRunId: null }];
    throw new Error("unexpected table");
  };
  const transaction = {
    select() {
      let table: unknown;
      const query = {
        from(value: unknown) { table = value; return query; },
        innerJoin() { return query; },
        leftJoin() { return query; },
        where() { return query; },
        orderBy() { return query; },
        limit() { return query; },
        then(resolve: (value: readonly unknown[]) => unknown) {
          return Promise.resolve(resolve(rows(table)));
        },
      };
      return query;
    },
  } as unknown as CanonicalTranscriptTx;
  let borrowed = false;
  let authorityChecks = 0;
  let authorityCurrent = true;
  const events: string[] = [];
  const funding: ForegroundChatFundingSession = Object.freeze({ kind: "server" as const,
    recheckAttempt: async () => undefined,
    runAttempt: async <Value>(_model: string,
      use: (value: never) => Promise<Value>) => use({} as never),
  });
  let resolverCalls = 0;
  const resolver = { buildEnvelope: async (_actor: string, lane: string,
    _agent: string, roomId: string) => {
    if (borrowed) throw new Error("global resolver invoked under borrowed facts");
    resolverCalls += 1;
    events.push(`envelope:${lane}`);
    return { memoryMode: "namespace", ownerId: resolverCalls === 2
        ? options.secondOwnerId ?? USER : USER,
      actorId: wakeEvidence.requesterHumanId, agentId: AGENT, roomId,
      readableNamespaces: [...(resolverCalls === 2
        ? options.secondReadableNamespaces ?? options.readableNamespaces ?? [NS]
        : options.readableNamespaces ?? [NS])],
      mutableNamespaces: [...(options.mutableNamespaces ?? [NS])],
      writableNamespaces: [...(options.writableNamespaces ?? [NS])],
      toolPolicy: { ...(resolverCalls === 2
        ? options.secondToolPolicy ?? options.toolPolicy
          ?? (options.resume ? defaultResumeToolPolicy : {})
        : options.toolPolicy
        ?? (options.resume ? defaultResumeToolPolicy : {})) } };
  } } as unknown as PolicyResolver;
  const owner = createProtectedTaskWakeForegroundContextOwner({ resolver,
    withCurrentFacts: async operation => {
      borrowed = true;
      events.push("borrowed");
      try {
        return await operation.use(transaction, async () => {
          authorityChecks += 1;
          events.push("current");
          if (!authorityCurrent) throw new Error("wake_authority_revoked");
        });
      } finally { borrowed = false; events.push("released"); }
    },
    openWakeFunding: async operation => {
      expect(borrowed).toBeFalse();
      expect(operation.taskSource.id).toBe(result.taskId);
      expect(operation.runSource.id).toBe(result.taskRunId);
      expect(operation.modelId).toBe(options.syntheticCancelledRun
        ? null : "anthropic:test");
      events.push("funding");
      await operation.assertCurrent();
      return funding;
    },
    readPolicy: async () => ({ mode: options.mode ?? "encrypted_only",
      shadowBehavior: "strict", revision: options.policyRevision ?? 7 }),
  });
  return { owner, publication, scheduling, events, continuation,
    borrowed: () => borrowed, authorityChecks: () => authorityChecks,
    revoke: () => { authorityCurrent = false; },
    funding };
}

describe("protected Task wake foreground context", () => {
  test("source binding is insensitive to ordering and changes with effective capabilities", () => {
    const envelope = { memoryMode: "namespace" as const, ownerId: USER,
      actorId: OWNER_ACTOR, agentId: AGENT, roomId: PARENT,
      readableNamespaces: [NS, PARENT], mutableNamespaces: [NS, PARENT],
      writableNamespaces: [NS],
      toolPolicy: { save_memory: "allow" as const, share_memory: "allow" as const } };
    const expected = protectedTaskWakeSourceEnvelopeDigest(envelope);
    expect(protectedTaskWakeSourceEnvelopeDigest({ ...envelope,
      readableNamespaces: [PARENT, NS], mutableNamespaces: [PARENT, NS],
      toolPolicy: { share_memory: "allow", save_memory: "allow" },
    })).toEqual(expected);
    for (const change of [
      { roomId: NS }, { mutableNamespaces: [NS] }, { writableNamespaces: [PARENT] },
      { toolPolicy: { save_memory: "forbidden" as const } },
    ]) expect(protectedTaskWakeSourceEnvelopeDigest({ ...envelope, ...change }))
      .not.toEqual(expected);
  });

  test("lends a peer-owned destination context only after current locks release", () =>
    withFixture({ messagePublished: true, deliveryMode: "raw_and_wake" }, async fixture => {
      const controller = new AbortController();
      const value = await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: controller.signal,
        use: async context => {
          expect(fixture.borrowed()).toBeFalse();
          expect(context.actorRole).toBe("admin");
          expect(context.resultMessagePublished).toBeTrue();
          expect(context.roomRoster.map(member => member.kind)).toEqual([
            "user", "user", "agent",
          ]);
          expect(context.memoryAccessEnvelope.ownerId).toBe(USER);
          expect(context.memoryAccessEnvelope.roomId).toBe(fixture.scheduling.roomId);
          expect(context.fundingSession).toBe(fixture.funding);
          expect(context.checkpointBinding.retainedSourceNamespaceIds).toEqual([NS]);
          expect(context.checkpointBinding.initialPolicyRevision).toBe(7);
          expect(context.checkpointBinding.initialAgentAuthorizationRevision)
            .toBe(0);
          expect(context.checkpointBinding.sourceEnvelopeDigest)
            .toEqual(protectedTaskWakeSourceEnvelopeDigest(context.memoryAccessEnvelope));
          expect(context.enforcementPolicy).toEqual({ mode: "encrypted_only",
            shadowBehavior: "strict", revision: 7 });
          const snapshot = await context.dataOperationPolicy.resolve();
          expect(snapshot.revalidationToken).toBe(7);
          return 42;
        } });
      expect(value).toBe(42);
      expect(fixture.events.indexOf("released")).toBeLessThan(
        fixture.events.indexOf("funding"),
      );
      expect(fixture.events.slice(0, 10)).toEqual([
        "borrowed", "released", "current",
        `envelope:room:${fixture.scheduling.roomId}`, "current",
        "borrowed", "released", "current",
        `envelope:room:${fixture.scheduling.roomId}`, "current",
      ]);
      expect(fixture.authorityChecks()).toBeGreaterThanOrEqual(4);
    }));

  test.each([
    { secondOwnerId: ROOM_OWNER },
    { secondReadableNamespaces: [PARENT] },
    { secondToolPolicy: { save_memory: "forbidden" as const } },
  ])("rejects a changed canonical envelope after locked facts release: %o", options =>
    withFixture(options, async fixture => {
      expect(await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async () => { throw new Error("must not run"); },
      }).then(
        () => null,
        (error: unknown) => (error as Error).message,
      )).toContain("Protected Task wake foreground context");
      expect(fixture.events).not.toContain("funding");
    }));

  test("rejects a changed Subthread parent between coordinate and full facts", () =>
    withFixture({ subthread: true, changedParentOnSecondPass: true }, async fixture => {
      expect(await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async () => { throw new Error("must not run"); },
      }).then(
        () => null,
        (error: unknown) => (error as Error).message,
      )).toContain("context is unavailable");
      expect(fixture.events).not.toContain("funding");
    }));

  test("Full wake uses a retained dual definition with current protected output authority", () =>
    withFixture({ mode: "encrypted_only", definitionRepresentation: "dual", fundingMode: "legacy_server" }, async fixture => {
      expect(await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async context => {
          expect(context.enforcementPolicy.mode).toBe("encrypted_only");
          expect(fixture.publication.plan.intent.representation).toBe("protected");
          expect(context.fundingSession).toBe(fixture.funding);
          expect(fixture.events).toContain("funding");
          return 42;
        },
      })).toBe(42);
    }));

  test.each([
    { mode: "encrypted_only", definitionRepresentation: "ordinary" },
    { mode: "shadow_encryption", definitionRepresentation: "protected" },
  ] as const)("refuses incompatible source %s before wake funding or execution", options =>
    withFixture(options, async fixture => {
      expect(await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async () => { throw new Error("must not run"); },
      }).then(() => null, (error: unknown) => (error as Error).message))
        .toContain("context is unavailable");
      expect(fixture.events).not.toContain("funding");
    }));

  test("uses the real parent envelope and retained anchor for a Subthread", () =>
    withFixture({ subthread: true, fundingMode: "legacy_server" }, async fixture => {
      await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async context => {
          expect(context.subthread).toEqual({ parentRoomId: PARENT,
            anchorMessageId: 42 });
          expect(context.memoryAccessEnvelope.roomId).toBe(PARENT);
          expect(context.fundingSession).toBe(fixture.funding);
          expect(fixture.events).toContain("funding");
        } });
      expect(fixture.events).toContain(`envelope:room:${PARENT}`);
    }));

  test("keeps a synthetic cancelled Run null while opening fresh caller funding", () =>
    withFixture({ runStatus: "cancelled", syntheticCancelledRun: true },
      async fixture => {
        await fixture.owner({ publication: fixture.publication,
          scheduling: fixture.scheduling, signal: new AbortController().signal,
          use: async context => {
            expect(context.fundingSession).toBe(fixture.funding);
            expect(fixture.events).toContain("funding");
          } });
      }));

  test("resume restricts fresh readable and mutable expansion to the retained source envelope", () =>
    withFixture({ resume: true, readableNamespaces: [PARENT, NS],
      mutableNamespaces: [NS, PARENT] }, async fixture => {
      const continuation = fixture.continuation;
      if (continuation === undefined) throw new Error("missing continuation");
      await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async context => {
          const envelope = context.memoryAccessEnvelope;
          expect(envelope.memoryMode).toBe("namespace");
          if (envelope.memoryMode !== "namespace") {
            throw new Error("expected Namespace wake Memory envelope");
          }
          expect(envelope.readableNamespaces).toEqual([NS]);
          expect(envelope.mutableNamespaces).toEqual([NS]);
          expect(envelope.writableNamespaces).toEqual([NS]);
          expect(context.checkpointBinding).toEqual({
            retainedSourceNamespaceIds: [NS],
            sourceEnvelopeDigest: continuation.sourceEnvelopeDigest,
            initialPolicyRevision: 5,
            initialAgentAuthorizationRevision: 9,
          });
          expect(context.continuation).toEqual({ segment: 2,
            checkpointThreadId: `protected-task-wake:${fixture.scheduling.jobId}`,
            resume: { interruptId: "projection:interrupt:2",
              authorizationRequestId: "projection:authorization:2",
              effectDisposition: "not_started_v1", operationId: "projection:operation:2",
              requestDigest: new Uint8Array(32).fill(11),
              requiredAuthorityDigest: new Uint8Array(32).fill(12) } });
        } });
      expect(fixture.events).toContain("funding");
    }));

  test("resume waits without funding when a retained source Namespace is no longer readable", () =>
    withFixture({ resume: true, readableNamespaces: [PARENT] }, async fixture => {
      expect(await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async () => { throw new Error("must not run"); },
      }).then(() => null, (error: unknown) => (error as Error).message))
        .toContain("context is unavailable");
      expect(fixture.events).not.toContain("funding");
    }));

  test("resume refuses changed retained mutation or tool capabilities before funding", async () => {
    for (const options of [
      { mutableNamespaces: [] as string[] },
      { writableNamespaces: [] as string[] },
      { toolPolicy: { save_memory: "forbidden" as const, share_memory: "allow" as const } },
    ]) await withFixture({ resume: true, ...options }, async fixture => {
      expect(await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async () => { throw new Error("must not run"); },
      }).then(() => null, (error: unknown) => (error as Error).message))
        .toContain("retained source changed");
      expect(fixture.events).not.toContain("funding");
    });
  });

  test("resume source comparison ignores Namespace and tool-policy insertion order", () =>
    withFixture({ resume: true, readableNamespaces: [PARENT, NS],
      toolPolicy: { share_memory: "allow", save_memory: "allow" } }, async fixture => {
      await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async context => {
          const envelope = context.memoryAccessEnvelope;
          expect(envelope.memoryMode).toBe("namespace");
          if (envelope.memoryMode !== "namespace") {
            throw new Error("expected Namespace wake Memory envelope");
          }
          expect(envelope.readableNamespaces).toEqual([NS]);
          expect(envelope.toolPolicy).toEqual({
            share_memory: "allow", save_memory: "allow",
          });
        } });
      expect(fixture.events).toContain("funding");
    }));

  test("rejects Namespace expansion, stale policy, requester removal, and raw receipt gaps", async () => {
    for (const options of [
      { readableNamespaces: [NS, PARENT] },
      { policyRevision: 8 },
      { requesterPresent: false },
      { deliveryMode: "raw_and_wake" as const, messagePublished: false },
    ]) await withFixture(options, async fixture => {
      expect(await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async () => { throw new Error("must not run"); },
      }).then(
        () => null,
        (error: unknown) => (error as Error).message,
      )).toContain("context is unavailable");
      expect(fixture.events).not.toContain("funding");
    });
  });

  test("rechecks operation authority after the request-local callback", () =>
    withFixture({}, async fixture => {
      expect(await fixture.owner({ publication: fixture.publication,
        scheduling: fixture.scheduling, signal: new AbortController().signal,
        use: async () => { fixture.revoke(); },
      }).then(
        () => null,
        (error: unknown) => (error as Error).message,
      )).toBe("wake_authority_revoked");
    }));
});
