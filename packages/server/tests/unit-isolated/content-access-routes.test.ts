import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  ContentAccessAdmission,
  ContentAccessCommand,
  ContentAccessFailure,
  ContentAccessPreparation,
  ContentAccessReceipt,
  MemoryAccessEnvelope,
} from "@nautilo/trust";
import {
  contentAccessRoutes,
  HUMAN_MANAGE_CONTENT_ACCESS_APPROVAL_CONTEXT,
  type ContentAccessCoordinatorPort,
  type ContentAccessRouteDependencies,
} from "../../src/routes/content-access";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "10000000-0000-4000-8000-000000000002";
const AGENT_ID = "10000000-0000-4000-8000-000000000003";
const ROOM_ID = "10000000-0000-4000-8000-000000000004";
const OTHER_ROOM_ID = "10000000-0000-4000-8000-000000000005";
const OPERATION_ID = "10000000-0000-4000-8000-000000000006";
const OBJECT_ID = "10000000-0000-4000-8000-000000000007";
const RECIPIENT_USER_ID = "10000000-0000-4000-8000-000000000008";
const RECIPIENT_ACTOR_ID = "10000000-0000-4000-8000-000000000009";

const envelope: MemoryAccessEnvelope = {
  memoryMode: "namespace",
  ownerId: USER_ID,
  actorId: ACTOR_ID,
  agentId: AGENT_ID,
  roomId: ROOM_ID,
  readableNamespaces: ["private-authority-must-not-be-forwarded"],
  mutableNamespaces: ["private-authority-must-not-be-forwarded"],
  writableNamespaces: ["private-authority-must-not-be-forwarded"],
  toolPolicy: {},
};
const command: ContentAccessCommand = {
  operationId: OPERATION_ID,
  object: { kind: "memory", id: OBJECT_ID },
  change: { kind: "grant_people", selectedActorIds: [RECIPIENT_ACTOR_ID] },
};
const prepareRequest = {
  method: "POST" as const,
  url: `/api/content-access/prepare?roomId=${ROOM_ID}`,
  payload: {
    ...command,
    change: { kind: "grant_people" as const, selectedUserIds: [RECIPIENT_USER_ID] },
  },
};
const commitRequest = {
  method: "POST" as const,
  url: `/api/content-access/commit?roomId=${ROOM_ID}`,
  payload: { ...command, previewToken: "signed-preview" },
};

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

type Context = Readonly<{
  sessionUserId: string | null;
  memoryEnvelope: MemoryAccessEnvelope | null;
}>;

function makeCoordinator(input: {
  prepare?: ContentAccessPreparation | ContentAccessFailure;
  commit?: ContentAccessReceipt | ContentAccessFailure;
  throwPrepare?: boolean;
  throwCommit?: boolean;
} = {}) {
  const prepare = mock(async (_admission: ContentAccessAdmission, _command: ContentAccessCommand) => {
    if (input.throwPrepare) throw new Error("private failure");
    return input.prepare ?? {
      outcome: "failed" as const,
      stateChanged: false as const,
      receiptPersisted: false as const,
      recovery: "prepare_again" as const,
    };
  });
  const commit = mock(async (
    _admission: ContentAccessAdmission,
    _command: ContentAccessCommand,
    _previewToken: string,
  ) => {
    if (input.throwCommit) throw new Error("private failure");
    return input.commit ?? {
      outcome: "failed" as const,
      stateChanged: false as const,
      receiptPersisted: false as const,
      recovery: "prepare_again" as const,
    };
  });
  return { coordinator: { prepare, commit } as ContentAccessCoordinatorPort, prepare, commit };
}

function setup(
  coordinator: ContentAccessCoordinatorPort,
  context: Context = { sessionUserId: USER_ID, memoryEnvelope: envelope },
  findActor: ContentAccessRouteDependencies["findActor"] = async (userId) => ({
    id: userId === RECIPIENT_USER_ID ? RECIPIENT_ACTOR_ID : ACTOR_ID,
    displayName: "Fixture person",
    trustState: "trusted",
  }),
  inspect?: ContentAccessRouteDependencies["inspect"],
  loadPolicy: ContentAccessRouteDependencies["loadPolicy"] = async () => ({ mode: "plaintext_only" }),
) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("memoryEnvelope", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = context.sessionUserId;
    request.memoryEnvelope = context.memoryEnvelope;
  });
  contentAccessRoutes(app, { coordinator, findActor, loadPolicy, ...(inspect ? { inspect } : {}) });
  return app;
}

function admission(): ContentAccessAdmission {
  return {
    principal: {
      kind: "human",
      userId: USER_ID,
      actorId: ACTOR_ID,
      sourceRoomId: ROOM_ID,
      agentId: AGENT_ID,
    },
    audienceContract: "invoking_room",
    approvalContext: HUMAN_MANAGE_CONTENT_ACCESS_APPROVAL_CONTEXT,
  };
}

describe("ordinary Human content-access routes", () => {
  test("mismatched owner and encrypted mode reject before recipient lookup", async () => {
    const { coordinator, prepare } = makeCoordinator();
    const findActor = mock(async () => null);
    const wrongOwner = setup(coordinator, { sessionUserId: USER_ID,
      memoryEnvelope: { ...envelope, ownerId: RECIPIENT_USER_ID } }, findActor);
    expect((await wrongOwner.inject(prepareRequest)).statusCode).toBe(403);
    expect(findActor).not.toHaveBeenCalled();
    const wrongMode = setup(coordinator, undefined, findActor, undefined, async () => ({ mode: "shadow_encryption" }));
    expect((await wrongMode.inject(prepareRequest)).statusCode).toBe(409);
    expect(findActor).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
  test("summary requires exact Room admission and returns only source-aware public fields", async () => {
    const inspect = mock(async () => ({ object: command.object,
      people: [{ actorId: ACTOR_ID, displayName: "Alice", userHandle: "alice", canRemove: false,
        sources: [{ kind: "immutable" as const, boundaryCount: 1, namespaceId: "hidden" }] }],
      rooms: [], otherAccessCount: 1, hiddenNamespace: "hidden" }));
    const { coordinator } = makeCoordinator();
    const app = setup(coordinator, undefined, undefined, inspect);
    const response = await app.inject({ method: "GET", url: `/api/content-access?roomId=${ROOM_ID}&kind=memory&id=${OBJECT_ID}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json<unknown>()).toEqual({ object: command.object, people: [{ actorId: ACTOR_ID,
      displayName: "Alice", userHandle: "alice", canRemove: false,
      sources: [{ kind: "immutable", boundaryCount: 1 }] }], rooms: [], otherAccessCount: 1 });
    const denied = await app.inject({ method: "GET", url: `/api/content-access?roomId=${OTHER_ROOM_ID}&kind=memory&id=${OBJECT_ID}` });
    expect(denied.statusCode).toBe(403);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  test("prepare binds only authenticated principal and exact requested Room", async () => {
    const prepared = {
      outcome: "prepared" as const,
      previewToken: "signed-preview",
      display: { kind: "memory", content: "private source body", type: "note" },
      expiresAt: 1_800_000_000,
      command: { ...command, privateNamespaceId: "hidden" },
      preview: {
        humanActorIds: [ACTOR_ID, RECIPIENT_ACTOR_ID],
        people: [{ actorId: ACTOR_ID, displayName: "Alice", userHandle: "alice", hidden: "private" },
          { actorId: RECIPIENT_ACTOR_ID, displayName: "Recipient", userHandle: null }],
        targetRoomId: OTHER_ROOM_ID,
        publicRoom: false,
        skippedAttachmentCount: 2,
        privateDestination: { namespaceId: "hidden" },
      },
      internalDetails: { namespaceIds: ["hidden"] },
    } as unknown as ContentAccessPreparation;
    const { coordinator, prepare } = makeCoordinator({ prepare: prepared });
    const findActor = mock(async () => ({
      id: RECIPIENT_ACTOR_ID,
      displayName: "Fixture person",
      trustState: "trusted" as const,
    }));
    const response = await setup(coordinator, undefined, findActor).inject(prepareRequest);

    expect(response.statusCode).toBe(200);
    expect(findActor).toHaveBeenCalledWith(RECIPIENT_USER_ID);
    expect(prepare).toHaveBeenCalledWith(admission(), command);
    expect(response.json<unknown>()).toEqual({
      outcome: "prepared",
      previewToken: "signed-preview",
      expiresAt: 1_800_000_000,
      command,
      preview: {
        humanActorIds: [ACTOR_ID, RECIPIENT_ACTOR_ID],
        people: [{ actorId: ACTOR_ID, displayName: "Alice", userHandle: "alice" },
          { actorId: RECIPIENT_ACTOR_ID, displayName: "Recipient", userHandle: null }],
        targetRoomId: OTHER_ROOM_ID,
        publicRoom: false,
        skippedAttachmentCount: 2,
      },
    });
  });

  test("commit passes the preview token separately and projects only receipt fields", async () => {
    const receipt = {
      operationId: OPERATION_ID,
      outcome: "partial" as const,
      stateChanged: true,
      originalStateChanged: true,
      replayed: false,
      attachedCount: 1,
      detachedCount: 1,
      skippedCount: 2,
      destinations: [{ namespaceId: "hidden" }],
      privateValue: "hidden",
    } as unknown as ContentAccessReceipt;
    const { coordinator, commit } = makeCoordinator({ commit: receipt });
    const response = await setup(coordinator).inject(commitRequest);

    expect(response.statusCode).toBe(200);
    expect(commit).toHaveBeenCalledWith(admission(), command, "signed-preview");
    expect(response.json<unknown>()).toEqual({
      operationId: OPERATION_ID,
      outcome: "partial",
      stateChanged: true,
      originalStateChanged: true,
      replayed: false,
      attachedCount: 1,
      detachedCount: 1,
      skippedCount: 2,
    });
  });

  test("rejects body attempts to override principal, source, or admission", async () => {
    const { coordinator, prepare } = makeCoordinator();
    const response = await setup(coordinator).inject({
      ...prepareRequest,
      payload: {
        ...prepareRequest.payload,
        principal: { userId: "forged" },
        sourceRoomId: OTHER_ROOM_ID,
        audienceContract: "legacy_personal_grant",
        approvalContext: "forged",
        namespaceIds: ["forged"],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  test("requires an explicit valid query Room matching the envelope", async () => {
    const { coordinator, prepare } = makeCoordinator();
    const app = setup(coordinator);
    for (const url of [
      "/api/content-access/prepare",
      "/api/content-access/prepare?roomId=not-a-uuid",
      `/api/content-access/prepare?roomId=${OTHER_ROOM_ID}`,
    ]) {
      const response = await app.inject({ ...prepareRequest, url });
      expect(response.statusCode).toBe(url.endsWith(OTHER_ROOM_ID) ? 403 : 400);
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  test("does not dispatch without session, namespace envelope, actor, and Room", async () => {
    const { coordinator, prepare } = makeCoordinator();
    const scopeEnvelope: MemoryAccessEnvelope = {
      memoryMode: "scope",
      ownerId: USER_ID,
      actorId: ACTOR_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      scopeId: "scope-1",
      toolPolicy: {},
    };
    const contexts: Context[] = [
      { sessionUserId: null, memoryEnvelope: envelope },
      { sessionUserId: USER_ID, memoryEnvelope: null },
      { sessionUserId: USER_ID, memoryEnvelope: scopeEnvelope },
      { sessionUserId: USER_ID, memoryEnvelope: { ...envelope, actorId: "" } },
      { sessionUserId: USER_ID, memoryEnvelope: { ...envelope, roomId: "" } },
    ];
    for (const context of contexts) {
      const response = await setup(coordinator, context).inject(prepareRequest);
      expect(response.statusCode).toBe(context.sessionUserId ? 403 : 401);
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  test("rejects malformed commands and tokens before dispatch", async () => {
    const { coordinator, prepare, commit } = makeCoordinator();
    const app = setup(coordinator);
    const malformed = await app.inject({
      ...prepareRequest,
      payload: { ...command, change: { kind: "grant_people", selectedUserIds: [] } },
    });
    const missingToken = await app.inject({ ...commitRequest, payload: command });
    expect(malformed.statusCode).toBe(400);
    expect(missingToken.statusCode).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  test("does not dispatch when an explicitly selected Human no longer resolves", async () => {
    const { coordinator, prepare } = makeCoordinator();
    const response = await setup(coordinator, undefined, async () => null).inject(prepareRequest);
    expect(response.statusCode).toBe(404);
    expect(response.json<unknown>()).toEqual({ error: "Person is no longer available" });
    expect(prepare).not.toHaveBeenCalled();
  });

  test("maps coordinator denials, staleness, and failures to typed safe errors", async () => {
    const failures: Array<{ failure: ContentAccessFailure; status: number }> = [
      { failure: { outcome: "denied", stateChanged: false, receiptPersisted: false,
        recovery: "prepare_again" }, status: 403 },
      { failure: { outcome: "stale", stateChanged: false, receiptPersisted: false,
        recovery: "prepare_again" }, status: 409 },
      { failure: { outcome: "failed", stateChanged: "unknown", receiptPersisted: false,
        recovery: "retry_receipt" }, status: 503 },
    ];
    for (const { failure, status } of failures) {
      const { coordinator } = makeCoordinator({ commit: failure });
      const response = await setup(coordinator).inject(commitRequest);
      expect(response.statusCode).toBe(status);
      expect(response.json<unknown>()).toEqual({
        error: failure.outcome === "denied" ? "Content access denied"
          : failure.outcome === "stale" ? "Content access changed. Prepare again."
          : "Content access result unavailable",
        ...failure,
      });
    }
  });

  test("does not claim no change when commit throws before the result is known", async () => {
    const { coordinator } = makeCoordinator({ throwCommit: true });
    const response = await setup(coordinator).inject(commitRequest);
    expect(response.statusCode).toBe(503);
    expect(response.json<unknown>()).toEqual({
      error: "Content access result unavailable",
      outcome: "failed",
      stateChanged: "unknown",
      receiptPersisted: false,
      recovery: "retry_receipt",
    });
  });

  test("returns persisted terminal receipts as errors rather than 2xx success", async () => {
    const terminal = {
      operationId: OPERATION_ID,
      outcome: "stale" as const,
      stateChanged: false,
      originalStateChanged: false,
      replayed: false,
      attachedCount: 0,
      detachedCount: 0,
      skippedCount: 0,
    };
    const { coordinator } = makeCoordinator({ commit: terminal });
    const response = await setup(coordinator).inject(commitRequest);
    expect(response.statusCode).toBe(409);
    expect(response.json<unknown>()).toEqual({
      error: "Content access changed. Prepare again.",
      outcome: "stale",
      stateChanged: false,
      receiptPersisted: true,
      recovery: "prepare_again",
    });
  });
});
