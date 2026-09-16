/**
 * D448 Phase 6.1 — WOPI compatibility characterization.
 *
 * This gate deliberately uses the existing route seam with a real temporary
 * byte target and real event bus. The database query/bump port is mocked only
 * because this is an isolated WOPI route characterization; production DB
 * integration belongs to the workspace artifact suite.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as actualDb from "@nautilo/db";
import * as actualTrust from "@nautilo/trust";
import { eventBus } from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

const ARTIFACT_ID = "d448-wopi-artifact";
const NAMESPACE_ID = "d448-wopi-namespace";

type ArtifactRow = {
  id: string;
  artifactId: string;
  path: string;
  mimeType: string | null;
  size: number | null;
  storageUri: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

let row: ArtifactRow;
const findArtifactMock = mock(async (input: {
  internalId: string;
  readableNamespaceIds: string[];
}): Promise<ArtifactRow | null> => {
  return input.internalId === ARTIFACT_ID && input.readableNamespaceIds.includes(NAMESPACE_ID)
    ? row
    : null;
});
const bumpArtifactRevisionMock = mock(async (input: {
  id: string;
  size: number;
  mimeType?: string;
}): Promise<ArtifactRow> => {
  if (input.id !== ARTIFACT_ID) throw new Error("unexpected WOPI artifact bump");
  row = {
    ...row,
    revision: row.revision + 1,
    size: input.size,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    updatedAt: new Date(),
  };
  return row;
});

mock.module("@nautilo/db", () => ({
  ...actualDb,
  findArtifactByInternalIdForNamespaces: findArtifactMock,
  bumpArtifactRevision: bumpArtifactRevisionMock,
}));

mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  // This D448 characterization owns WOPI byte/lock/version semantics. M259
  // capability denial and revocation are covered by the dedicated route and
  // integration matrices, so keep this older harness hermetic and admitted.
  assertCanWriteArtifacts: mock(async () => {}),
}));

const {
  __resetWopiAutosaveThrottleForTests,
  __resetWopiLockStoreForTests,
  __resetWopiTokenStoreForTests,
  issueWopiToken,
  wopiRoutes,
} = await import("../../src/routes/wopi");

function writableToken(): string {
  return issueWopiToken(ARTIFACT_ID, {
    readableNamespaces: [NAMESPACE_ID],
    writableNamespaces: [NAMESPACE_ID],
    mutableNamespaces: [NAMESPACE_ID],
    ownerId: "d448-owner",
    userId: "d448-user",
    userFriendlyName: "D448 User",
  }).token;
}

function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.memoryEnvelope = {
      memoryMode: "namespace",
      ownerId: "d448-owner",
      actorId: "d448-actor",
      agentId: "d448-agent",
      roomId: "d448-room",
      readableNamespaces: [NAMESPACE_ID],
      mutableNamespaces: [NAMESPACE_ID],
      writableNamespaces: [NAMESPACE_ID],
      toolPolicy: {},
    } satisfies MemoryAccessEnvelope;
    request.sessionUserId = "d448-user";
  });
  wopiRoutes(app);
  return app;
}

beforeEach(() => {
  __resetWopiTokenStoreForTests();
  __resetWopiLockStoreForTests();
  __resetWopiAutosaveThrottleForTests();
  findArtifactMock.mockClear();
  bumpArtifactRevisionMock.mockClear();
});

afterEach(() => {
  __resetWopiTokenStoreForTests();
  __resetWopiLockStoreForTests();
  __resetWopiAutosaveThrottleForTests();
});

describe("D448 WOPI compatibility", () => {
  test("PutFile persists every byte but defers autosave revisions/events, flushes user saves, and preserves token/lock/write gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "d448-wopi-"));
    const absPath = join(root, "compatibility.docx");
    await writeFile(absPath, Buffer.from("initial-bytes"));
    row = {
      id: ARTIFACT_ID,
      artifactId: "d448-wopi-external-artifact",
      path: "office/compatibility.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: Buffer.byteLength("initial-bytes"),
      storageUri: `file://${absPath}`,
      revision: 7,
      createdAt: new Date("2026-07-23T00:00:00.000Z"),
      updatedAt: new Date("2026-07-23T00:00:00.000Z"),
      deletedAt: null,
    };
    const app = makeApp();
    const token = writableToken();
    const url = `/wopi/files/${ARTIFACT_ID}/contents?access_token=${encodeURIComponent(token)}`;
    const events: ServerEvent[] = [];
    const handler = (event: ServerEvent) => {
      if (event.type === "workspace.artifact.changed" && event.id === ARTIFACT_ID) {
        events.push(event);
      }
    };
    eventBus.on(handler);

    try {
      const check = await app.inject({
        method: "GET",
        url: `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`,
      });
      expect(check.statusCode).toBe(200);
      expect(JSON.parse(check.body)).toMatchObject({
        UserCanWrite: true,
        SupportsUpdate: true,
        Version: "7",
      });

      const firstAutosave = await app.inject({
        method: "POST",
        url,
        headers: {
          "content-type": "application/octet-stream",
          "x-wopi-override": "PUT",
          "x-wopi-isautosave": "true",
        },
        payload: Buffer.from("autosave-one"),
      });
      expect(firstAutosave.statusCode).toBe(200);
      expect(firstAutosave.headers["x-wopi-itemversion"]).toBe("8");
      expect(await readFile(absPath, "utf8")).toBe("autosave-one");
      expect(row.revision).toBe(8);
      expect(events).toHaveLength(1);

      const deferredAutosave = await app.inject({
        method: "POST",
        url,
        headers: {
          "content-type": "application/octet-stream",
          "x-wopi-override": "PUT",
          "x-wopi-isautosave": "true",
        },
        payload: Buffer.from("autosave-two"),
      });
      expect(deferredAutosave.statusCode).toBe(200);
      // Current behavior: bytes are durable immediately, but the row version
      // and invalidation are deferred while the autosave debounce is hot.
      expect(deferredAutosave.headers["x-wopi-itemversion"]).toBe("8");
      expect(await readFile(absPath, "utf8")).toBe("autosave-two");
      expect(row.revision).toBe(8);
      expect(events).toHaveLength(1);
      expect(bumpArtifactRevisionMock).toHaveBeenCalledTimes(1);

      const userSave = await app.inject({
        method: "POST",
        url,
        headers: {
          "content-type": "application/octet-stream",
          "x-wopi-override": "PUT",
          "x-wopi-isautosave": "true",
          "x-wopi-ismodifiedbyuser": "true",
        },
        payload: Buffer.from("user-flush"),
      });
      expect(userSave.statusCode).toBe(200);
      expect(userSave.headers["x-wopi-itemversion"]).toBe("9");
      expect(await readFile(absPath, "utf8")).toBe("user-flush");
      expect(row.revision).toBe(9);
      expect(events).toHaveLength(2);
      expect(bumpArtifactRevisionMock).toHaveBeenCalledTimes(2);

      const lockUrl = `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`;
      expect((await app.inject({
        method: "POST",
        url: lockUrl,
        headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "d448-lock-a" },
      })).statusCode).toBe(200);
      const conflictingLock = await app.inject({
        method: "POST",
        url: lockUrl,
        headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "d448-lock-b" },
      });
      expect(conflictingLock.statusCode).toBe(409);
      expect(conflictingLock.headers["x-wopi-lock"]).toBe("d448-lock-a");

      const readOnlyToken = issueWopiToken(ARTIFACT_ID, {
        readableNamespaces: [NAMESPACE_ID],
        ownerId: "d448-owner",
        userId: "d448-user",
        userFriendlyName: "D448 User",
      }).token;
      const readOnlyCheck = await app.inject({
        method: "GET",
        url: `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(readOnlyToken)}`,
      });
      expect(JSON.parse(readOnlyCheck.body)).toMatchObject({ UserCanWrite: false, SupportsUpdate: false });
      const deniedWrite = await app.inject({
        method: "POST",
        url: `/wopi/files/${ARTIFACT_ID}/contents?access_token=${encodeURIComponent(readOnlyToken)}`,
        headers: { "content-type": "application/octet-stream", "x-wopi-override": "PUT" },
        payload: Buffer.from("must-not-write"),
      });
      expect(deniedWrite.statusCode).toBe(403);
      expect(await readFile(absPath, "utf8")).toBe("user-flush");
      expect(row.revision).toBe(9);
      expect(events).toHaveLength(2);
    } finally {
      eventBus.off(handler);
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
