import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { messageAttachmentRoutes, type MessageAttachmentRouteDeps } from "../../src/routes/message-attachments";
import type { InsertPendingMessageAttachmentInput } from "@nautilo/db";
import { withListeningServer } from "./helpers/request-helpers";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_ID = "22222222-2222-4222-8222-222222222222";

const apps: FastifyInstance[] = [];
let prevArtifactsRoot: string | undefined;
let tempRoot: string | null = null;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
  if (prevArtifactsRoot === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
  else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevArtifactsRoot;
});

function envelope(
  readable: string[] = [NAMESPACE_ID],
  writable: string[] = [NAMESPACE_ID],
): MemoryAccessEnvelope {
  return {
    ownerId: "owner",
    actorId: ACTOR_ID,
    agentId: "agent",
    roomId: "room",
    readableNamespaces: readable,
    mutableNamespaces: [NAMESPACE_ID],
    writableNamespaces: writable,
    toolPolicy: { tools: {} },
  } as unknown as MemoryAccessEnvelope;
}

async function makeApp(
  deps: MessageAttachmentRouteDeps,
  role = "owner",
  readable: string[] = [NAMESPACE_ID],
  writable: string[] = [NAMESPACE_ID],
): Promise<FastifyInstance> {
  prevArtifactsRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
  tempRoot = await mkdtemp(join(tmpdir(), "nautilo-message-attachments-"));
  process.env["NAUTILO_ARTIFACTS_ROOT"] = tempRoot;
  const app = Fastify({ logger: false });
  app.register(multipart);
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("policyContext", null);
  app.decorateRequest("sessionActorId", null);
  app.addHook("preHandler", async (request) => {
    (request as unknown as { memoryEnvelope: MemoryAccessEnvelope }).memoryEnvelope = envelope(readable, writable);
    (request as unknown as { sessionActorId: string }).sessionActorId = ACTOR_ID;
    (request as unknown as { policyContext: { actorRole: string } }).policyContext = { actorRole: role };
  });
  messageAttachmentRoutes(app, deps);
  apps.push(app);
  await app.ready();
  return app;
}

async function postFile(app: FastifyInstance, bytes = "hello") {
  const fd = new FormData();
  fd.set("file", new Blob([bytes], { type: "text/markdown" }), "note.md");
  return app.inject({ method: "POST", url: "/api/message-attachments", payload: fd });
}

describe("message attachment upload route", () => {
  test("happy path writes blob, gates bytes, and inserts a pending row", async () => {
    const inserted: InsertPendingMessageAttachmentInput[] = [];
    const deps: MessageAttachmentRouteDeps = {
      sumPendingBytesForActor: async () => 0,
      insertPending: async (input) => {
        inserted.push(input);
        return {
          id: input.id!,
          namespaceId: input.namespaceId,
          uploaderActorId: input.uploaderActorId,
          status: "pending",
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          storageUri: input.storageUri,
          claimedMime: input.claimedMime ?? null,
          turnId: null,
          createdAt: new Date(),
          expiresAt: input.expiresAt,
          resolvedAt: null,
          deletedAt: null,
        };
      },
      cancelPending: async () => null,
      findRetained: async () => null,
      markRetainedDeleted: async () => null,
    };
    const app = await makeApp(deps);

    const res = await postFile(app, "hello markdown");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { attachmentId: string; filename: string; status: string };
    expect(body.filename).toBe("note.md");
    expect(body.status).toBe("pending");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.namespaceId).toBe(NAMESPACE_ID);
    expect(inserted[0]!.uploaderActorId).toBe(ACTOR_ID);
    const blobPath = new URL(inserted[0]!.storageUri);
    expect(existsSync(blobPath)).toBe(true);
    expect(await readFile(blobPath, "utf8")).toBe("hello markdown");
  });

  test("an authenticated writable Room envelope admits upload independent of Role name", async () => {
    let inserted: InsertPendingMessageAttachmentInput | null = null;
    const deps: MessageAttachmentRouteDeps = {
      sumPendingBytesForActor: async () => 0,
      insertPending: async (input) => {
        inserted = input;
        return {
          id: input.id!, namespaceId: input.namespaceId, uploaderActorId: input.uploaderActorId,
          status: "pending", filename: input.filename, mimeType: input.mimeType,
          sizeBytes: input.sizeBytes, storageUri: input.storageUri,
          claimedMime: input.claimedMime ?? null, turnId: null, createdAt: new Date(),
          expiresAt: input.expiresAt, resolvedAt: null, deletedAt: null,
        };
      },
      cancelPending: async () => null,
      findRetained: async () => null,
      markRetainedDeleted: async () => null,
    };
    const app = await makeApp(deps, "guest");

    const res = await postFile(app);

    expect(res.statusCode).toBe(200);
    expect(inserted).toMatchObject({
      namespaceId: NAMESPACE_ID,
      uploaderActorId: ACTOR_ID,
    });
  });

  test("a Role name cannot compensate for a missing writable Room namespace", async () => {
    let insertCalled = false;
    const deps: MessageAttachmentRouteDeps = {
      sumPendingBytesForActor: async () => 0,
      insertPending: async () => {
        insertCalled = true;
        throw new Error("should not insert");
      },
      cancelPending: async () => null,
      findRetained: async () => null,
      markRetainedDeleted: async () => null,
    };
    const app = await makeApp(deps, "owner", [NAMESPACE_ID], []);

    const res = await postFile(app);

    expect(res.statusCode).toBe(403);
    expect(insertCalled).toBe(false);
  });

  test("pending byte quota rejects without writing or inserting", async () => {
    let insertCalled = false;
    const deps: MessageAttachmentRouteDeps = {
      sumPendingBytesForActor: async () => 100 * 1024 * 1024,
      insertPending: async () => {
        insertCalled = true;
        throw new Error("should not insert");
      },
      cancelPending: async () => null,
      findRetained: async () => null,
      markRetainedDeleted: async () => null,
    };
    const app = await makeApp(deps);

    const res = await postFile(app);

    expect(res.statusCode).toBe(429);
    expect(insertCalled).toBe(false);
  });

  test("cancel deletes a pending blob", async () => {
    let filePath = "";
    const deps: MessageAttachmentRouteDeps = {
      sumPendingBytesForActor: async () => 0,
      insertPending: async () => {
        throw new Error("not used");
      },
      cancelPending: async () => ({
        id: "33333333-3333-4333-8333-333333333333",
        namespaceId: NAMESPACE_ID,
        uploaderActorId: ACTOR_ID,
        status: "deleted",
        filename: "note.md",
        mimeType: "text/markdown",
        sizeBytes: 5,
        storageUri: new URL(`file://${filePath}`).toString(),
        claimedMime: null,
        turnId: null,
        createdAt: new Date(),
        expiresAt: null,
        resolvedAt: null,
        deletedAt: new Date(),
      }),
      findRetained: async () => null,
      markRetainedDeleted: async () => null,
    };
    const app = await makeApp(deps);
    filePath = join(tempRoot!, "pending-cancel");
    await Bun.write(filePath, "hello");
    expect(existsSync(filePath)).toBe(true);

    const res = await app.inject({ method: "DELETE", url: "/api/message-attachments/33333333-3333-4333-8333-333333333333" });

    expect(res.statusCode).toBe(200);
    expect(existsSync(filePath)).toBe(false);
  });

});

// D391 — authed byte route + retained delete. The GET route streams a retained
// attachment's blob, gated by the same namespace-readability check the history
// read uses; non-members get 404 (existence hidden). Type-agnostic: serves any
// retained kind.
describe("message attachment byte route (D391)", () => {
  const RETAINED_ID = "44444444-4444-4444-8444-444444444444";

  function retainedRow(storageUri: string, mimeType = "image/png", sizeBytes = 5): {
    id: string; namespaceId: string; uploaderActorId: string; status: string;
    filename: string; mimeType: string; sizeBytes: number; storageUri: string;
    claimedMime: string | null; turnId: string | null; createdAt: Date;
    expiresAt: Date | null; resolvedAt: Date | null; deletedAt: Date | null;
  } {
    return {
      id: RETAINED_ID,
      namespaceId: NAMESPACE_ID,
      uploaderActorId: ACTOR_ID,
      status: "retained",
      filename: "pic.png",
      mimeType,
      sizeBytes,
      storageUri,
      claimedMime: null,
      turnId: "fp:v1:human:abc",
      createdAt: new Date(),
      expiresAt: null,
      resolvedAt: new Date(),
      deletedAt: null,
    };
  }

  function baseDeps(overrides: Partial<MessageAttachmentRouteDeps> = {}): MessageAttachmentRouteDeps {
    return {
      sumPendingBytesForActor: async () => 0,
      insertPending: async () => { throw new Error("not used"); },
      cancelPending: async () => null,
      findRetained: async () => null,
      markRetainedDeleted: async () => null,
      ...overrides,
    };
  }

  test("member GET streams the blob with Content-Type from mime_type", async () => {
    let blobPath = "";
    const app = await makeApp(baseDeps({
      findRetained: async () => retainedRow(new URL(`file://${blobPath}`).toString(), "image/png", 5),
    }));
    blobPath = join(tempRoot!, "retained-pic");
    await Bun.write(blobPath, "hello");

    try {
      await withListeningServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/message-attachments/${RETAINED_ID}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(await res.text()).toBe("hello");
      });
    } finally {
      const index = apps.indexOf(app);
      if (index >= 0) apps.splice(index, 1);
    }
  });

  test("non-member GET (no readable namespace) returns 404 and does not stream", async () => {
    let findCalled = false;
    const app = await makeApp(baseDeps({
      findRetained: async () => { findCalled = true; return null; },
    }), "owner", []); // empty readable namespaces => non-member of the attachment's namespace

    const res = await app.inject({ method: "GET", url: `/api/message-attachments/${RETAINED_ID}` });

    expect(res.statusCode).toBe(404);
    expect(findCalled).toBe(true);
  });

  test("retained DELETE removes the row + its blob (no orphans)", async () => {
    let blobPath = "";
    let markedDeletedId = "";
    const app = await makeApp(baseDeps({
      markRetainedDeleted: async (input) => {
        markedDeletedId = input.attachmentId;
        return retainedRow(new URL(`file://${blobPath}`).toString());
      },
    }));
    blobPath = join(tempRoot!, "retained-del");
    await Bun.write(blobPath, "hello");
    expect(existsSync(blobPath)).toBe(true);

    const res = await app.inject({ method: "DELETE", url: `/api/message-attachments/${RETAINED_ID}` });

    expect(res.statusCode).toBe(200);
    expect(markedDeletedId).toBe(RETAINED_ID);
    expect(existsSync(blobPath)).toBe(false);
  });
});
