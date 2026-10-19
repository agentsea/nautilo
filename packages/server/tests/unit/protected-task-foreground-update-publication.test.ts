import { describe, expect, test } from "bun:test";
import { rejects, throws } from "node:assert/strict";
import type { TaskToolRuntime } from "@nautilo/agent";
import { bindEncryptionDataOperationOwner, deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type { PreparedTaskContentCryptoRevisionV1, TaskContentProductStorePort,
  TaskContentRepository, TaskContentRevisionStateV1, TaskDefinitionContent,
  TaskPayloadV1 } from "@nautilo/lattice-bridge";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { assertProtectedTaskOperationalMetadataProjectionV1,
  classifyProtectedTaskMetadataV1, reconstructProtectedTaskMetadataV1 } from "@nautilo/types";
import { actors, rooms, taskRuns, type Task } from "@nautilo/db";
import { createProtectedTaskForegroundUpdatePublication } from
  "../../src/routes/protected-task-foreground-update-publication";

const TASK = "10000000-0000-4000-8000-000000000001";
const USER = "20000000-0000-4000-8000-000000000001";
const AGENT = "30000000-0000-4000-8000-000000000001";
const ROOM = "40000000-0000-4000-8000-000000000001";
const PRIVATE_ROOM = "40000000-0000-4000-8000-000000000002";
const updateIdentity = () => ({ taskId: TASK, ownerId: USER, requestorId: USER,
  agentId: AGENT, callingRoomId: ROOM });

function fixture(row?: Record<string, unknown>) {
  const abort = new AbortController();
  let productUses = 0;
  const transaction = {
    select: () => {
      const result = Promise.resolve(row === undefined ? [] : [row]);
      const query = { from: () => query, where: () => query, limit: () => result };
      return query;
    },
  };
  const publisher = createProtectedTaskForegroundUpdatePublication({
    owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: () => Promise.resolve({ policy: { mode: "encrypted_only", shadowBehavior: "strict" }, revalidationToken: 1 }),
      revalidate: () => Promise.resolve(),
    } }),
    crypto: new LatticeCrypto(),
    entities: { signal: abort.signal,
      use: async () => { throw new Error("Unexpected decrypt"); },
      useCurrentSet: async () => { throw new Error("Unexpected encryption"); } },
    publication: {} as never,
    withCurrentProduct: async (_request, use) => {
      productUses += 1;
      return use({ transaction: transaction as never, product: {} as never, restricted: {} as never,
        resolveCurrentForegroundDefinitionAuthorization: () => null,
        resolveAuthority: () => Promise.resolve(null), assertCurrent: () => Promise.resolve() });
    },
  });
  const request = { taskId: TASK, ownerId: USER, requestorId: USER, agentId: AGENT,
    callingRoomId: ROOM, prompt: "new private prompt" };
  const preflight = (value = request, operationId = "task-foreground-update:fixture") =>
    publisher.preflight({ operationId, request: value });
  return { publisher, request, preflight, productUses: () => productUses };
}

describe("foreground protected Task update publication", () => {
  test("invalid identity fails closed and disposal expires the port", async () => {
    const f = fixture();
    await rejects(f.preflight({ ...f.request, requestorId: "another-user" }), /identity/u);
    expect(f.productUses()).toBe(1);
    f.publisher.dispose();
    throws(() => f.preflight({ ...f.request, requestorId: "another-user" }), /closed/u);
  });

  test("an active fire lock rejects the update before authority or ciphertext access", async () => {
    const f = fixture({
      id: TASK, ownerId: USER, requestorId: USER, agentId: AGENT, callingRoomId: ROOM,
      parentTaskId: null, depth: 0, status: "pending", fireLockId: "active-fire",
      contentRepresentation: "protected", contentNamespaceId: "50000000-0000-4000-8000-000000000001",
      contentRevision: 3, cryptoMappingState: "verified", cryptoObjectId: "task-content-object",
    });
    await rejects(f.preflight(), /target changed/u);
    expect(f.productUses()).toBe(1);
  });
});

const NS = "50000000-0000-4000-8000-000000000001";
const DOMAIN = "60000000-0000-4000-8000-000000000001";
const metadata = classifyProtectedTaskMetadataV1({});
if (metadata.status !== "supported") throw new Error("Fixture metadata unsupported");
const operationalMetadata = metadata.operational;

function orchestrationFixture(
  representation: "protected" | "dual" = "protected",
  lifecycleMetadata: Record<string, unknown> = operationalMetadata,
  options: Readonly<{ retainedHistoricalError?: string; liveMetadata?: Record<string, unknown>;
    protectedMetadata?: TaskPayloadV1["protectedMetadata"];
    status?: "pending" | "paused" }> = {},
) {
  const abort = new AbortController();
  const authority = { authorityVersion: 1 as const, kind: "requester_private_namespace" as const,
    keyClass: "ai" as const, requesterHumanId: USER, namespaceId: NS, domainId: DOMAIN,
    expectedAccessRevision: 2, expectedPolicyRevision: 3 };
  const originalPrompt = "private original";
  let committedPayload: TaskPayloadV1 = { formatVersion: 1, prompt: originalPrompt,
    expectedOutput: null, protectedMetadata: options.protectedMetadata ?? {} };
  let committedRetainedHistoricalError = options.retainedHistoricalError ?? null;
  const base = {
    id: TASK, ownerId: USER, requestorId: USER, agentId: AGENT, callingRoomId: "stored-origin-room",
    prompt: representation === "dual" ? originalPrompt : "", expectedOutput: null,
    metadata: options.liveMetadata ?? {}, parentTaskId: null, depth: 0,
    status: options.status ?? "pending", fireLockId: null,
    scheduleKind: "now", runAt: null, cron: null, timezone: "UTC", targetChat: "orphan",
    targetRoomId: null, resultDelivery: "wake", toolsMode: "auto", toolsWhitelist: [],
    timeLimitSeconds: null, selectionProfile: "balanced", selectionSpec: null,
    requestedModelId: null, fundingMode: "caller", contentRepresentation: representation,
    contentNamespaceId: NS, contentRevision: 4, cryptoMappingState: "verified",
    cryptoObjectId: "task-definition:4", cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(7), mutationVersion: "1",
    localExecutionDelegation: null, nextFireAt: null,
  } as unknown as Task & { mutationVersion: string };
  let committed = structuredClone(base);
  let working: typeof committed | null = null;
  let workingPayload = committedPayload;
  let workingRetainedHistoricalError = committedRetainedHistoricalError;
  let committedOperation: TaskContentRevisionStateV1 | null = null;
  let workingOperation: TaskContentRevisionStateV1 | null = null;
  let failCommit = false;
  let clock = Date.parse("2030-01-02T03:59:30.000Z");
  let prepares = 0;
  let completions = 0;
  let resumable = false;
  let recoverPrepared = false;
  let lastPreparedContent: TaskDefinitionContent | null = null;
  let recoveredRequestDigest: Uint8Array | null = null;
  let privateRoomNamespace = NS;
  const openedTaskAgents: string[] = [];
  const inspectedAuthorAgents: string[] = [];
  const privateNamespaceLookups: Array<{ namespaceId: string; taskExecutorAgentId: string }> = [];
  const transaction = {
    select: () => {
      let table: unknown;
      const query = { from: (value: unknown) => { table = value; return query; }, innerJoin: () => query,
        where: () => query, groupBy: () => query, having: () => query, orderBy: () => query,
        limit: async () => table === taskRuns ? (resumable ? [{ id: "run", taskId: TASK, status: "paused" }] : [])
          : table === actors ? [{ id: USER }]
            : table === rooms ? [{ roomId: PRIVATE_ROOM,
                namespaceId: privateRoomNamespace, type: "private", kind: "private",
                graphThreadId: "app:default", createdAt: new Date(0),
                humanActorIds: [USER], memberCount: 2, humanCount: 1, agentCount: 1 }]
              : working === null ? [] : [working] };
      return query;
    },
    update: () => ({ set: (patch: Partial<Task>) => ({ where: () => ({ returning: async () => {
      if (working === null) return [];
      const literal = Object.fromEntries(Object.entries(patch).filter(([key, value]) =>
        !["status", "lastError", "fireLockId", "fireLockedAt"].includes(key)
        || value === null || typeof value === "string"));
      working = { ...working, ...literal, mutationVersion: String(Number(working.mutationVersion) + 1) };
      return [working];
    } }) }) }),
  };
  const currentState = (): TaskContentRevisionStateV1 => ({
    authority,
    lifecycle: {
      sequence: 1, operationId: `prior:${working!.contentRevision}`, coordinate: { kind: "definition", taskId: TASK,
        contentRevision: working!.contentRevision }, requesterHumanId: USER, namespaceId: NS,
      authorityFingerprint: new Uint8Array(32), requiredNamespaceFingerprint: working!.cryptoRequiredNamespaceFingerprint!,
      representation, requestDigest: new Uint8Array(32), cryptoObjectId: working!.cryptoObjectId!,
      objectType: `application/vnd.nautilo.task-definition.v1`, payloadVersion: 1,
      operationalMetadata: lifecycleMetadata, completion: "complete", disposition: "mapped",
      attemptCount: 0, nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null,
      failureCode: null, cryptoCompletedAt: new Date(1),
    },
    product: { coordinate: { kind: "definition", taskId: TASK, contentRevision: working!.contentRevision },
      namespaceId: NS, representation, cryptoObjectId: working!.cryptoObjectId!, cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: working!.cryptoRequiredNamespaceFingerprint!, cryptoMappingState: "verified" },
  } as unknown as TaskContentRevisionStateV1);
  const productStore: TaskContentProductStorePort = {
    getRevision: async coordinate => coordinate.contentRevision === working?.contentRevision ? currentState() : null,
    getRevisionByOperation: async ({ operationId }) => workingOperation?.lifecycle.operationId === operationId
      ? { status: "found", state: workingOperation } : { status: "missing" },
    reserveRevision: async () => { throw new Error("Repository override owns reservation"); },
    markCryptoComplete: async () => { throw new Error("Unexpected product mutation"); },
    compareAndSwapCryptoMapping: async () => { throw new Error("Unexpected product mutation"); },
    quarantineRevision: async () => { throw new Error("Unexpected product mutation"); },
    markAuthorityStale: async () => { throw new Error("Unexpected product mutation"); },
    claimReconciliationCandidates: async () => [],
    failReconciliationClaim: async () => null,
  };
  const repository: TaskContentRepository = {
    lookupPreparedReplay: async () => ({ status: "unavailable" }),
    reserveRevision: async request => {
      if (working === null) throw new Error("Missing working Task");
      assertProtectedTaskOperationalMetadataProjectionV1(request.operationalMetadata);
      workingOperation = { ...currentState(), lifecycle: { ...currentState().lifecycle,
        operationId: request.operationId, coordinate: request.prepared.coordinate,
        cryptoObjectId: request.prepared.objectId, completion: "pending", disposition: "active",
        requestDigest: request.requestDigest } };
      return { status: "reserved", coordinate: request.prepared.coordinate, cryptoObjectId: request.prepared.objectId };
    },
    completeRevision: async request => {
      if (working === null || workingOperation === null) throw new Error("Missing reservation");
      completions += 1;
      const content = (request.prepared as unknown as { testContent: TaskDefinitionContent }).testContent;
      const payload = content.formatVersion === 1 ? content : { formatVersion: 1 as const,
        prompt: content.prompt, expectedOutput: content.expectedOutput,
        protectedMetadata: content.protectedMetadata };
      workingPayload = payload;
      workingRetainedHistoricalError = content.formatVersion === 1 ? null : content.retainedHistoricalError;
      working = { ...working, contentRevision: request.coordinate.contentRevision,
        cryptoObjectId: request.prepared.objectId, cryptoMappingState: "verified",
        prompt: representation === "dual" ? payload.prompt : "", expectedOutput: representation === "dual" ? payload.expectedOutput : null };
      workingOperation = { ...workingOperation,
        lifecycle: { ...workingOperation.lifecycle, completion: "complete", disposition: "mapped" },
        product: { coordinate: request.coordinate, namespaceId: NS, representation,
          cryptoObjectId: request.prepared.objectId, cryptoAccessRevision: 0,
          cryptoRequiredNamespaceFingerprint: working.cryptoRequiredNamespaceFingerprint!, cryptoMappingState: "verified" } };
      return { status: "mapped", coordinate: request.coordinate, cryptoObjectId: request.prepared.objectId };
    },
    reconcilePending: async () => ({ outcomes: [] }),
    reconcileCoordinate: async () => "pending",
  };
  const publisher = createProtectedTaskForegroundUpdatePublication({
    owner: bindEncryptionDataOperationOwner({ policy: { resolve: async () => ({ policy: {
      mode: representation === "protected" ? "encrypted_only" : "shadow_encryption", shadowBehavior: "strict" }, revalidationToken: 1 }),
      revalidate: async () => {} } }),
    crypto: new LatticeCrypto(), entities: { signal: abort.signal,
      use: async () => { throw new Error("Open override expected"); },
      useCurrentSet: async () => { throw new Error("Prepare override expected"); } }, publication: {} as never,
    now: () => clock,
    withCurrentProduct: async (_request, use) => {
      working = structuredClone(committed); workingPayload = structuredClone(committedPayload);
      workingRetainedHistoricalError = committedRetainedHistoricalError;
      const startingRevision = committed.contentRevision;
      workingOperation = committedOperation === null ? null : { ...committedOperation,
        lifecycle: { ...committedOperation.lifecycle,
          authorityFingerprint: Uint8Array.from(committedOperation.lifecycle.authorityFingerprint),
          requiredNamespaceFingerprint: Uint8Array.from(committedOperation.lifecycle.requiredNamespaceFingerprint),
          requestDigest: Uint8Array.from(committedOperation.lifecycle.requestDigest) },
        product: committedOperation.product === null ? null : { ...committedOperation.product,
          cryptoRequiredNamespaceFingerprint: Uint8Array.from(committedOperation.product.cryptoRequiredNamespaceFingerprint!) } };
      const value = await use({ transaction: transaction as never, product: {} as never, restricted: {} as never,
        resolveCurrentForegroundDefinitionAuthorization: async () => null,
        resolveAuthority: async (namespaceId, taskExecutorAgentId) => {
          privateNamespaceLookups.push({ namespaceId, taskExecutorAgentId });
          return namespaceId === NS ? authority : null;
        },
        assertCurrent: async () => {} });
      if (failCommit && working?.contentRevision !== startingRevision) {
        working = null; workingOperation = null; throw new Error("Product commit rejected");
      }
      committed = working!; committedPayload = workingPayload;
      committedRetainedHistoricalError = workingRetainedHistoricalError;
      committedOperation = workingOperation;
      working = null; workingOperation = null; return value;
    },
  }, {
    verifyProduct: async value => value as never, verifyCrypto: async value => value as never,
    productStore: () => productStore,
    open: async input => {
      openedTaskAgents.push(input.expectedAgentId);
      return { status: "opened", value: await input.use({ payload: workingPayload,
        retainedHistoricalError: workingRetainedHistoricalError }) };
    },
    inspectPrepared: async input => {
      inspectedAuthorAgents.push(input.expectedAgentId);
      if (!recoverPrepared || lastPreparedContent === null) return { status: "missing" };
      if (input.expectedRequestDigest === undefined) throw new Error("Update recovery must retain request identity");
      recoveredRequestDigest = Uint8Array.from(input.expectedRequestDigest);
      expect(input.payload).toEqual(lastPreparedContent);
      return { status: "verified", value: await input.use({} as never) };
    },
    publishVerified: async input => {
      if (working === null || lastPreparedContent === null || recoveredRequestDigest === null) throw new Error("Missing recovered publication");
      const before = currentState();
      const coordinate = { kind: "definition" as const, taskId: TASK,
        contentRevision: working.contentRevision + 1 };
      const objectId = deriveTaskContentCryptoObjectIdV1(coordinate);
      const content = lastPreparedContent;
      workingPayload = content.formatVersion === 1 ? content : { formatVersion: 1,
        prompt: content.prompt, expectedOutput: content.expectedOutput,
        protectedMetadata: content.protectedMetadata };
      workingRetainedHistoricalError = content.formatVersion === 1
        ? null : content.retainedHistoricalError;
      working = { ...working, contentRevision: coordinate.contentRevision, cryptoObjectId: objectId,
        prompt: representation === "dual" ? workingPayload.prompt : "",
        expectedOutput: representation === "dual" ? workingPayload.expectedOutput : null };
      workingOperation = { ...before, lifecycle: { ...before.lifecycle,
        operationId: input.operationId, coordinate, cryptoObjectId: objectId,
        requestDigest: Uint8Array.from(recoveredRequestDigest),
        operationalMetadata: input.operationalMetadata, completion: "complete", disposition: "mapped" },
      product: { coordinate, namespaceId: NS, representation, cryptoObjectId: objectId,
        cryptoAccessRevision: 0,
        cryptoRequiredNamespaceFingerprint: working.cryptoRequiredNamespaceFingerprint!,
        cryptoMappingState: "verified" } };
      return "mapped" as const;
    },
    prepare: async input => {
      prepares += 1;
      lastPreparedContent = input.payload;
      if (input.contentRevision === undefined) throw new Error("Expected explicit update revision");
      const coordinate = { kind: "definition" as const, taskId: TASK, contentRevision: input.contentRevision };
      return { coordinate: { kind: "definition", taskId: TASK, contentRevision: input.contentRevision },
        objectId: deriveTaskContentCryptoObjectIdV1(coordinate), testContent: input.payload } as unknown as PreparedTaskContentCryptoRevisionV1;
    },
    repository: () => repository,
    resolveForegroundAgentAcceptedExecutionEvidence: async () => null,
    resolveHistoricalAgentSignerAuthority: async () => null,
  });
  const request: Parameters<NonNullable<TaskToolRuntime["updateProtectedTask"]>>[0] = {
    taskId: TASK, ownerId: USER, requestorId: USER, agentId: AGENT,
    callingRoomId: ROOM, prompt: "private changed", scheduleKind: "one_shot" as const,
    runAt: new Date("2030-01-02T03:04:05.000Z") };
  const publish = async (operationId: string, value = request) => {
    const preflight = await publisher.preflight({ operationId, request: value });
    return publisher.publish({ operationId, request: value, preflight });
  };
  return { publisher, publish, request, row: () => committed,
    payload: () => committedPayload,
    retainedHistoricalError: () => committedRetainedHistoricalError,
    preparedContent: () => lastPreparedContent,
    openedTaskAgents,
    inspectedAuthorAgents,
    privateNamespaceLookups,
    counts: () => ({ prepares, completions }),
    operation: () => committedOperation, setFailCommit: (value: boolean) => { failCommit = value; },
    recoverPrepared: (content?: TaskDefinitionContent) => {
      if (content !== undefined) lastPreparedContent = content;
      recoverPrepared = true;
    },
    advanceTime: (milliseconds: number) => { clock += milliseconds; },
    mismatchPrivateRoomNamespace: () => {
      privateRoomNamespace = "50000000-0000-4000-8000-000000000002";
    },
    setResumable: () => { resumable = true; }, setFunding: (fundingMode: Task["fundingMode"]) => { committed = { ...committed, fundingMode }; } };
}

describe("foreground protected Task update orchestration", () => {
  test("another admitted Genie edits the same Human's Task without changing its executor or origin", async () => {
    const f = orchestrationFixture();
    const authorAgentId = "30000000-0000-4000-8000-000000000002";
    await f.publish("task-foreground-update:other-author", {
      ...f.request, agentId: authorAgentId,
    });
    expect(f.openedTaskAgents).toEqual([AGENT]);
    expect(f.privateNamespaceLookups).toEqual([
      { namespaceId: NS, taskExecutorAgentId: AGENT },
      { namespaceId: NS, taskExecutorAgentId: AGENT },
    ]);
    expect(f.row()).toMatchObject({ ownerId: USER, requestorId: USER,
      agentId: AGENT, callingRoomId: "stored-origin-room", contentRevision: 5 });
    expect(f.payload().prompt).toBe("private changed");
    expect(f.counts()).toEqual({ prepares: 1, completions: 1 });
  });

  for (const representation of ["protected", "dual"] as const) test(`publishes ${representation} revision N+1 without exposing protected content`, async () => {
    const f = orchestrationFixture(representation);
    const result = await f.publish(`task-foreground-update:${representation}`);
    expect(result).toMatchObject({ id: TASK, ownerId: USER, status: "pending", scheduleKind: "one_shot" });
    expect(f.row().contentRevision).toBe(5);
    expect(f.row().prompt).toBe(representation === "dual" ? "private changed" : "");
    expect(JSON.stringify(result)).not.toContain("private changed");
    expect(f.counts()).toEqual({ prepares: 1, completions: 1 });
  });

  test("outer rollback retries the exact prepared revision and durable replay never advances twice", async () => {
    const f = orchestrationFixture();
    const operationId = "task-foreground-update:stable-effect";
    f.setFailCommit(true);
    await rejects(f.publish(operationId), /commit rejected/u);
    expect(f.row().contentRevision).toBe(4); expect(f.counts().prepares).toBe(1);
    f.setFailCommit(false);
    await f.publish(operationId);
    expect(f.row().contentRevision).toBe(5); expect(f.counts().prepares).toBe(1);
    await f.publish(operationId);
    expect(f.row().contentRevision).toBe(5); expect(f.counts()).toEqual({ prepares: 1, completions: 2 });
    await f.publish("task-foreground-update:next-effect", { ...f.request, prompt: "second edit" });
    expect(f.row().contentRevision).toBe(6); expect(f.counts().prepares).toBe(2);
  });

  test("rollback recovery adopts the exact published future V2 revision with its operation provenance", async () => {
    const f = orchestrationFixture("protected", operationalMetadata, {
      retainedHistoricalError: "provider unavailable",
    });
    const operationId = "task-foreground-update:recover-v2";
    f.setFailCommit(true);
    await rejects(f.publish(operationId), /commit rejected/u);
    expect(f.row().contentRevision).toBe(4);
    expect(f.counts()).toEqual({ prepares: 1, completions: 1 });
    const prepared = f.preparedContent();
    if (prepared === null) throw new Error("Expected prepared V2 revision");
    const restarted = orchestrationFixture("protected", operationalMetadata, {
      retainedHistoricalError: "provider unavailable",
    });
    restarted.recoverPrepared(prepared);
    await restarted.publish(operationId);
    expect(restarted.row().contentRevision).toBe(5);
    expect(restarted.retainedHistoricalError()).toBe("provider unavailable");
    expect(restarted.operation()?.lifecycle).toMatchObject({ operationId,
      coordinate: { kind: "definition", taskId: TASK, contentRevision: 5 },
      completion: "complete", disposition: "mapped" });
    expect(restarted.counts()).toEqual({ prepares: 0, completions: 0 });
    await restarted.publish(operationId);
    expect(restarted.row().contentRevision).toBe(5);
    expect(restarted.counts()).toEqual({ prepares: 0, completions: 0 });
  });

  test("cross-Genie recovery verifies the foreground author while preserving the stored executor", async () => {
    const f = orchestrationFixture();
    const authorAgentId = "30000000-0000-4000-8000-000000000002";
    const operationId = "task-foreground-update:recover-other-author";
    f.setFailCommit(true);
    await rejects(f.publish(operationId, { ...f.request, agentId: authorAgentId }), /commit rejected/u);
    expect(f.row().contentRevision).toBe(4);
    const prepared = f.preparedContent();
    if (prepared === null) throw new Error("Expected prepared definition");
    const restarted = orchestrationFixture();
    restarted.recoverPrepared(prepared);
    await restarted.publish(operationId, { ...restarted.request, agentId: authorAgentId });
    expect(restarted.inspectedAuthorAgents).toEqual([authorAgentId]);
    expect(restarted.openedTaskAgents).toEqual([AGENT]);
    expect(restarted.privateNamespaceLookups).toEqual([
      { namespaceId: NS, taskExecutorAgentId: AGENT },
      { namespaceId: NS, taskExecutorAgentId: AGENT },
    ]);
    expect(restarted.row()).toMatchObject({ agentId: AGENT,
      callingRoomId: "stored-origin-room", contentRevision: 5 });
    expect(restarted.counts()).toEqual({ prepares: 0, completions: 0 });
  });

  test("server-funded invalid effective selection stops before preparation and preflight stays content-free", async () => {
    const selection = orchestrationFixture(); selection.setFunding("legacy_server");
    await rejects(selection.publish("task-foreground-update:selection",
      { ...selection.request, requestedModelId: "pinned", selectionProfile: "smartest" }), /cannot be combined|selection/u);
    expect(selection.counts()).toEqual({ prepares: 0, completions: 0 });
    const preflight = await selection.publisher.preflight({ operationId: "task-foreground-update:closed-source",
      request: selection.request });
    expect(preflight.source).toMatchObject({ prompt: "", expectedOutput: null, mutationVersion: "1" });
    expect(preflight.patch).toMatchObject({ scheduleKind: "one_shot" });
  });

  test("an external-harness lifecycle is rejected before funding or content access", async () => {
    const f = orchestrationFixture("protected", { execution: { harnessId: "codex" } });
    await rejects(f.publisher.preflight({ operationId: "task-foreground-update:not-native",
      request: f.request }), /mapped definition changed/u);
    expect(f.counts()).toEqual({ prepares: 0, completions: 0 });
  });

  test("a private Room outside the mapped Namespace cannot authorize an update", async () => {
    const f = orchestrationFixture();
    f.mismatchPrivateRoomNamespace();
    await rejects(f.publish("task-foreground-update:wrong-private-room"),
      /private Room is unavailable/u);
    expect(f.counts()).toEqual({ prepares: 0, completions: 0 });
    expect(f.row().contentRevision).toBe(4);
  });

  for (const representation of ["protected", "dual"] as const) {
    for (const edit of ["content", "operational"] as const) {
      test(`${representation} ${edit}-only paused update retains V2 display error and runtime diagnostics`, async () => {
        const runtimeMetadata = {
          preparation: { stage: "using_tools", activity: "reading_source",
            researchWork: { role: "investigator",
              ...(representation === "dual" ? { subject: "Review access checks" } : {}) },
            taskRunId: "run-1", updatedAt: "2026-09-21T10:00:00.000Z" },
          lastInterruption: { code: "relay_unavailable", cause: "desktop_disconnected",
            stoppedBy: "task_runtime", outcome: "paused",
            observedAt: "2026-09-21T10:01:00.000Z", taskRunId: "run-1",
            graphThreadId: "thread-1", checkpointId: null, resumable: true,
            desktopExitCause: "unknown" },
        };
        const f = orchestrationFixture(representation, operationalMetadata, {
          retainedHistoricalError: "provider unavailable", liveMetadata: runtimeMetadata,
          status: "paused",
        });
        const request = edit === "content"
          ? { ...updateIdentity(), prompt: "content-only change" }
          : { ...updateIdentity(), scheduleKind: "cron" as const,
            cron: "0 * * * *", timezone: "UTC" };
        await f.publish(`task-foreground-update:${representation}:${edit}`, request);
        expect(f.retainedHistoricalError()).toBe("provider unavailable");
        expect(f.payload().prompt).toBe(edit === "content"
          ? "content-only change" : "private original");
        expect(f.row()).toMatchObject({ status: "paused", metadata: runtimeMetadata });
      });
    }
  }

  test("an immutable split runtime definition stays reconstructable while live diagnostics remain current", async () => {
    const definitionOperational = classifyProtectedTaskMetadataV1({
      preparation: { stage: "using_tools", researchWork: { role: "investigator",
        subject: "Review access checks" },
        taskRunId: "definition-run", updatedAt: "2026-09-20T10:00:00.000Z" },
      lastInterruption: { code: "no_progress", cause: "repeated_tool_failure",
        stoppedBy: "no_progress_guard", outcome: "errored",
        observedAt: "2026-09-20T10:01:00.000Z", taskRunId: "definition-run",
        graphThreadId: "definition-thread", checkpointId: null,
        toolName: "private_repository_lookup", operation: "read",
        resumeRequiresValidation: true },
    });
    if (definitionOperational.status !== "supported") throw new Error("Expected definition metadata");
    const definitionProtected = definitionOperational.protectedContent;
    const definition = reconstructProtectedTaskMetadataV1(
      definitionOperational.operational, definitionProtected);
    if (definition.status !== "supported") throw new Error("Expected split definition metadata");
    for (const representation of ["protected", "dual"] as const) {
      const liveOperational = classifyProtectedTaskMetadataV1({
        preparation: { stage: "using_tools", activity: "reading_source",
          researchWork: { role: "investigator", subject: "Current private work" },
          taskRunId: "live-run",
          updatedAt: "2026-09-21T10:00:00.000Z" },
        lastInterruption: { code: "no_progress", cause: "repeated_tool_failure",
          stoppedBy: "no_progress_guard", outcome: "errored",
          observedAt: "2026-09-21T10:01:00.000Z", taskRunId: "live-run",
          graphThreadId: "live-thread", checkpointId: null,
          toolName: "current_private_tool", operation: "write",
          resumeRequiresValidation: true },
      });
      if (liveOperational.status !== "supported") throw new Error("Expected live metadata");
      let liveMetadata: Record<string, unknown>;
      if (representation === "protected") {
        liveMetadata = liveOperational.operational;
      } else {
        const reconstructedLive = reconstructProtectedTaskMetadataV1(
          liveOperational.operational, liveOperational.protectedContent);
        if (reconstructedLive.status !== "supported") throw new Error("Expected live dual metadata");
        liveMetadata = reconstructedLive.metadata;
      }
      const f = orchestrationFixture(representation, definitionOperational.operational, {
        status: "paused", liveMetadata,
        protectedMetadata: definitionProtected,
      });
      await f.publish(`task-foreground-update:split-runtime:${representation}`, {
        ...updateIdentity(), targetChat: "last_in_namespace",
      });
      const future = reconstructProtectedTaskMetadataV1(
        f.operation()!.lifecycle.operationalMetadata ?? {}, f.payload().protectedMetadata);
      expect(future).toMatchObject({ status: "supported", metadata: definition.metadata });
      expect(f.row().metadata).toEqual(liveMetadata);
    }
  });

  test("non-canonical live runtime metadata fails before ciphertext preparation", async () => {
    const f = orchestrationFixture("protected", operationalMetadata, {
      status: "paused", liveMetadata: { preparation: { future: true } },
    });
    await rejects(f.publish("task-foreground-update:invalid-runtime", {
      ...updateIdentity(), prompt: "must not prepare",
    }), /metadata|projection/u);
    expect(f.counts()).toEqual({ prepares: 0, completions: 0 });
  });

  test("schedule computation uses one preflight instant across a funding delay", async () => {
    for (const schedule of [
      { operationId: "now", request: { ...updateIdentity(), scheduleKind: "now" as const },
        expected: new Date("2030-01-02T03:59:30.000Z") },
      { operationId: "cron", request: { ...updateIdentity(), scheduleKind: "cron" as const,
        cron: "0 * * * *", timezone: "UTC" }, expected: new Date("2030-01-02T04:00:00.000Z") },
    ]) {
      const f = orchestrationFixture();
      const operationId = `task-foreground-update:timing:${schedule.operationId}`;
      const preflight = await f.publisher.preflight({ operationId, request: schedule.request });
      f.advanceTime(90_000);
      await f.publisher.publish({ operationId, request: schedule.request, preflight });
      expect(f.row().nextFireAt).toEqual(schedule.expected);
    }
  });

  test("an exact old effect cannot replay after a later current revision", async () => {
    const f = orchestrationFixture();
    const oldOperation = "task-foreground-update:old-effect";
    await f.publish(oldOperation);
    await f.publish("task-foreground-update:new-effect", { ...f.request, prompt: "later edit" });
    expect(f.row().contentRevision).toBe(6);
    await rejects(f.publish(oldOperation), /no longer owns the current revision/u);
    expect(f.row().contentRevision).toBe(6);
  });

  test("a preflight cannot authorize a changed current mapping", async () => {
    const f = orchestrationFixture();
    const operationId = "task-foreground-update:stale-preflight";
    const preflight = await f.publisher.preflight({ operationId, request: f.request });
    f.row().contentRevision = 5;
    f.row().cryptoObjectId = deriveTaskContentCryptoObjectIdV1({
      kind: "definition", taskId: TASK, contentRevision: 5,
    });
    f.row().mutationVersion = "2";
    await rejects(f.publisher.publish({ operationId, request: f.request, preflight }),
      /changed after funding preflight/u);
    expect(f.counts()).toEqual({ prepares: 0, completions: 0 });
  });
});
