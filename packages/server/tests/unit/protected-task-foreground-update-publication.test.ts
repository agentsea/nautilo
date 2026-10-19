import { describe, expect, test } from "bun:test";
import { rejects, throws } from "node:assert/strict";
import type { TaskToolRuntime } from "@nautilo/agent";
import { bindEncryptionDataOperationOwner, deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type { PreparedTaskContentCryptoRevisionV1, TaskContentProductStorePort,
  TaskContentRepository, TaskContentRevisionStateV1 } from "@nautilo/lattice-bridge";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";
import { taskRuns, type Task } from "@nautilo/db";
import { createProtectedTaskForegroundUpdatePublication } from
  "../../src/routes/protected-task-foreground-update-publication";

const TASK = "10000000-0000-4000-8000-000000000001";
const USER = "20000000-0000-4000-8000-000000000001";
const AGENT = "30000000-0000-4000-8000-000000000001";
const ROOM = "40000000-0000-4000-8000-000000000001";

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
) {
  const abort = new AbortController();
  const authority = { authorityVersion: 1 as const, kind: "requester_private_namespace" as const,
    keyClass: "ai" as const, requesterHumanId: USER, namespaceId: NS, domainId: DOMAIN,
    expectedAccessRevision: 2, expectedPolicyRevision: 3 };
  const originalPrompt = "private original";
  let committedPayload = { formatVersion: 1 as const, prompt: originalPrompt,
    expectedOutput: null, protectedMetadata: {} };
  const base = {
    id: TASK, ownerId: USER, requestorId: USER, agentId: AGENT, callingRoomId: "stored-origin-room",
    prompt: representation === "dual" ? originalPrompt : "", expectedOutput: null,
    metadata: {}, parentTaskId: null, depth: 0, status: "pending", fireLockId: null,
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
  let committedOperation: TaskContentRevisionStateV1 | null = null;
  let workingOperation: TaskContentRevisionStateV1 | null = null;
  let failCommit = false;
  let prepares = 0;
  let completions = 0;
  let resumable = false;
  const transaction = {
    select: () => {
      let table: unknown;
      const query = { from: (value: unknown) => { table = value; return query; }, where: () => query,
        orderBy: () => query,
        limit: async () => table === taskRuns ? (resumable ? [{ id: "run", taskId: TASK, status: "paused" }] : [])
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
      workingOperation = { ...currentState(), lifecycle: { ...currentState().lifecycle,
        operationId: request.operationId, coordinate: request.prepared.coordinate,
        cryptoObjectId: request.prepared.objectId, completion: "pending", disposition: "active",
        requestDigest: request.requestDigest } };
      return { status: "reserved", coordinate: request.prepared.coordinate, cryptoObjectId: request.prepared.objectId };
    },
    completeRevision: async request => {
      if (working === null || workingOperation === null) throw new Error("Missing reservation");
      completions += 1;
      const payload = (request.prepared as unknown as { testPayload: typeof committedPayload }).testPayload;
      workingPayload = payload;
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
    withCurrentProduct: async (_request, use) => {
      working = structuredClone(committed); workingPayload = structuredClone(committedPayload);
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
        resolveAuthority: async namespaceId => namespaceId === NS ? authority : null,
        assertCurrent: async () => {} });
      if (failCommit && working?.contentRevision !== startingRevision) {
        working = null; workingOperation = null; throw new Error("Product commit rejected");
      }
      committed = working!; committedPayload = workingPayload; committedOperation = workingOperation;
      working = null; workingOperation = null; return value;
    },
  }, {
    verifyProduct: async value => value as never, verifyCrypto: async value => value as never,
    productStore: () => productStore,
    open: async input => ({ status: "opened", value: await input.use(workingPayload) }),
    inspectPrepared: async () => ({ status: "missing" }),
    prepare: async input => {
      prepares += 1;
      if (input.contentRevision === undefined) throw new Error("Expected explicit update revision");
      const coordinate = { kind: "definition" as const, taskId: TASK, contentRevision: input.contentRevision };
      return { coordinate: { kind: "definition", taskId: TASK, contentRevision: input.contentRevision },
        objectId: deriveTaskContentCryptoObjectIdV1(coordinate), testPayload: input.payload } as unknown as PreparedTaskContentCryptoRevisionV1;
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
  return { publisher, publish, request, row: () => committed, counts: () => ({ prepares, completions }),
    operation: () => committedOperation, setFailCommit: (value: boolean) => { failCommit = value; },
    setResumable: () => { resumable = true; }, setFunding: (fundingMode: Task["fundingMode"]) => { committed = { ...committed, fundingMode }; } };
}

describe("foreground protected Task update orchestration", () => {
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
