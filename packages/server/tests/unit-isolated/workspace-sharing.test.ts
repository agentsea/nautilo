import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ArtifactWriteDeniedError,
  type ContentAccessReceipt,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import { workspaceSharingRoutes, type WorkspaceSharingService } from "../../src/routes/workspace-sharing";

const USER_ID = "10000000-0000-4000-8000-000000000002";
const SENDER_ACTOR_ID = "10000000-0000-4000-8000-000000000009";
const RECIPIENT_USER_ID = "10000000-0000-4000-8000-000000000003";
const RECIPIENT_ACTOR_ID = "10000000-0000-4000-8000-000000000010";
const MISSING_USER_ID = "10000000-0000-4000-8000-000000000004";
const ROOM_ID = "10000000-0000-4000-8000-000000000011";
const artifact = { id: "10000000-0000-4000-8000-000000000001", artifactId: "external", path: "report.pdf", mimeType: "application/pdf", size: 12, revision: 1,
  createdAt: new Date(), updatedAt: new Date(), deletedAt: null, storageUri: "file:///fixture/report" };
const env = { memoryMode: "namespace", ownerId: USER_ID, actorId: SENDER_ACTOR_ID, agentId: "", roomId: ROOM_ID,
  readableNamespaces: ["source-namespace"], mutableNamespaces: ["source-namespace"], writableNamespaces: ["source-namespace"], toolPolicy: {} } as MemoryAccessEnvelope;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const policy = (mode: "plaintext_only" | "shadow_encryption" | "encrypted_only") => ({
  mode,
  shadowBehavior: "fallback" as const,
  revision: 1,
  shadowEncryptionStartedAt: null,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});
function setup(overrides: WorkspaceSharingService = {}, authenticated = true) {
  const share = mock(async (_input: Parameters<NonNullable<WorkspaceSharingService["share"]>>[0]) => ({ namespaceId: "hidden-access", alreadyShared: false }));
  const list = mock(async () => []);
  const emitChanged = mock(() => {});
  const app = Fastify(); apps.push(app);
  app.decorateRequest("memoryEnvelope", null); app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (req) => { req.memoryEnvelope = authenticated ? env : null; req.sessionUserId = authenticated ? USER_ID : null; });
  workspaceSharingRoutes(app, { findArtifact: async () => artifact,
    findActor: async (id) => id === MISSING_USER_ID ? null : ({
      id: id === USER_ID ? SENDER_ACTOR_ID : RECIPIENT_ACTOR_ID,
      displayName: id,
      trustState: "trusted",
    }),
    share, list, emitChanged, assertWrite: async () => {},
    loadEncryptionPolicy: async () => policy("shadow_encryption"), ...overrides });
  return { app, share, list, emitChanged };
}
const request = { method: "POST" as const, url: "/api/workspace/artifacts/10000000-0000-4000-8000-000000000001/share", payload: { recipientUserId: RECIPIENT_USER_ID } };

function receipt(outcome: ContentAccessReceipt["outcome"]): ContentAccessReceipt {
  const changed = outcome === "applied" || outcome === "partial";
  return { operationId: "10000000-0000-4000-8000-000000000012", outcome,
    stateChanged: changed, originalStateChanged: changed, replayed: false,
    attachedCount: changed ? 1 : 0, detachedCount: 0,
    skippedCount: outcome === "partial" ? 1 : 0 };
}

function legacyCoordinator(result: unknown) {
  const executeLegacyHuman = mock(async () => result);
  return {
    executeLegacyHuman,
    service: { executeLegacyHuman } as NonNullable<WorkspaceSharingService["contentAccessCoordinator"]>,
  };
}

describe("silent human workspace sharing", () => {
  test("rejects anonymous access before reading or mutating", async () => {
    const { app, share, list } = setup({}, false);
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/workspace/shared-with-me" })).statusCode).toBe(401);
    expect(share).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  });
  test("404 for unreadable files; no destination side effects", async () => {
    const { app, share } = setup({ findArtifact: async () => null });
    expect((await app.inject(request)).statusCode).toBe(404); expect(share).not.toHaveBeenCalled();
  });
  test("capability denial occurs before sharing", async () => {
    const { app, share } = setup({ assertWrite: async () => { throw new ArtifactWriteDeniedError({ humanUserId: USER_ID }); } });
    expect((await app.inject(request)).statusCode).toBe(403); expect(share).not.toHaveBeenCalled();
  });
  test("missing recipient and self-target never share", async () => {
    const { app, share } = setup();
    expect((await app.inject({ ...request, payload: { recipientUserId: MISSING_USER_ID } })).statusCode).toBe(404);
    expect((await app.inject({ ...request, payload: { recipientUserId: USER_ID } })).statusCode).toBe(400);
    expect(share).not.toHaveBeenCalled();
  });
  test("uses authenticated sender and exact source scope; no Genie required", async () => {
    const { app, share, emitChanged } = setup();
    const response = await app.inject({ ...request, payload: { recipientUserId: RECIPIENT_USER_ID, senderUserId: "forged", namespaceId: "forged" } });
    expect(response.statusCode).toBe(200); expect(response.json<{ status: string }>()).toEqual({ status: "shared" });
    expect(share.mock.calls[0]?.[0]).toEqual({ artifactId: artifact.id, readableNamespaceIds: ["source-namespace"], senderUserId: USER_ID, senderActorId: SENDER_ACTOR_ID, recipientUserId: RECIPIENT_USER_ID, recipientActorId: RECIPIENT_ACTOR_ID });
    expect(emitChanged).toHaveBeenCalledTimes(1);
  });
  test("repeat delivery is successful and advisory emit failure cannot undo it", async () => {
    const { app } = setup({ share: async () => ({ namespaceId: "hidden-access", alreadyShared: true }), emitChanged: () => { throw new Error("offline observer"); } });
    expect((await app.inject(request)).json<{ status: string }>()).toEqual({ status: "already_shared" });
  });
  test("plaintext sharing uses the legacy Human coordinator and preserves the frozen DTO", async () => {
    const ordinary = legacyCoordinator({ kind: "completed", receipt: receipt("applied"),
      details: { destinations: [{ namespaceId: "hidden", roomId: ROOM_ID,
        minted: true, label: "Private" }], accounting: {} } });
    const { app, share, emitChanged } = setup({
      loadEncryptionPolicy: async () => policy("plaintext_only"),
      contentAccessCoordinator: ordinary.service,
    });
    const response = await app.inject({ ...request, payload: {
      ...request.payload, operationId: "old-client-noop", previewToken: "old-client-noop",
    } });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>()).toEqual({ status: "shared" });
    expect(ordinary.executeLegacyHuman).toHaveBeenCalledWith({
      principal: { kind: "human", userId: USER_ID, actorId: SENDER_ACTOR_ID,
        sourceRoomId: ROOM_ID },
      audienceContract: "legacy_personal_grant",
      approvalContext: "nautilo/content-access/legacy-human-share/v1",
    }, { object: { kind: "artifact", id: artifact.id },
      change: { kind: "grant_people", selectedActorIds: [RECIPIENT_ACTOR_ID] } });
    expect(share).not.toHaveBeenCalled();
    expect(emitChanged).toHaveBeenCalledTimes(1);
  });
  test("plaintext receipt-only replay preserves already_shared", async () => {
    const ordinary = legacyCoordinator({ kind: "receipt_only", receipt: receipt("already_applied") });
    const { app, share, emitChanged } = setup({
      loadEncryptionPolicy: async () => policy("plaintext_only"),
      contentAccessCoordinator: ordinary.service,
    });
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>()).toEqual({ status: "already_shared" });
    expect(share).not.toHaveBeenCalled();
    expect(emitChanged).toHaveBeenCalledTimes(1);
  });
  test("encrypted modes retain the legacy share implementation", async () => {
    for (const mode of ["shadow_encryption", "encrypted_only"] as const) {
      const ordinary = legacyCoordinator({ kind: "completed", receipt: receipt("applied") });
      const { app, share } = setup({ loadEncryptionPolicy: async () => policy(mode),
        contentAccessCoordinator: ordinary.service });
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(share).toHaveBeenCalledTimes(1);
      expect(ordinary.executeLegacyHuman).not.toHaveBeenCalled();
    }
  });
  test("plaintext mode never falls back when the ordinary port is unavailable", async () => {
    const { app, share, emitChanged } = setup({
      loadEncryptionPolicy: async () => policy("plaintext_only"),
    });
    const response = await app.inject(request);
    expect(response.statusCode).toBe(503);
    expect(response.json<unknown>()).toEqual({
      error: "File sharing is temporarily unavailable", outcome: "failed", stateChanged: false,
    });
    expect(share).not.toHaveBeenCalled();
    expect(emitChanged).not.toHaveBeenCalled();
  });
  test("partial and non-success terminal outcomes are never reported as shared", async () => {
    for (const outcome of ["partial", "denied", "stale", "failed"] as const) {
      const ordinary = legacyCoordinator({ kind: "receipt_only", receipt: receipt(outcome) });
      const { app, share, emitChanged } = setup({
        loadEncryptionPolicy: async () => policy("plaintext_only"),
        contentAccessCoordinator: ordinary.service,
      });
      const response = await app.inject(request);
      expect(response.statusCode).toBe(outcome === "denied" ? 403
        : outcome === "failed" ? 503 : 409);
      expect(response.json<{ outcome: string }>().outcome).toBe(outcome);
      expect(share).not.toHaveBeenCalled();
      expect(emitChanged).toHaveBeenCalledTimes(outcome === "partial" ? 1 : 0);
    }
  });
  test("pending or unknown coordinator states are 503 and never emit success", async () => {
    const ordinary = legacyCoordinator({ outcome: "pending", stateChanged: "unknown" });
    const { app, share, emitChanged } = setup({
      loadEncryptionPolicy: async () => policy("plaintext_only"),
      contentAccessCoordinator: ordinary.service,
    });
    const response = await app.inject(request);
    expect(response.statusCode).toBe(503);
    expect(response.json<unknown>()).toEqual({
      error: "File sharing result is unavailable", outcome: "failed", stateChanged: "unknown",
    });
    expect(share).not.toHaveBeenCalled();
    expect(emitChanged).not.toHaveBeenCalled();
  });
  test("recipient listing always uses the authenticated Human, ignoring requested identities", async () => {
    const { app, list } = setup();
    const response = await app.inject({ url: `/api/workspace/shared-with-me?userId=someone-else&roomId=${ROOM_ID}` });
    expect(response.statusCode).toBe(200); expect(list).toHaveBeenCalledWith(SENDER_ACTOR_ID);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
});
