/**
 * D448 Phase 6.1.2 — Workspace revision format compatibility.
 *
 * The fixture is a committed pre-D448 `file_revisions` row: it has the
 * legacy display-only `workspace_path`, but none of the D448 logical-history
 * provenance columns. It proves that the current read-only compatibility
 * lookup can still enumerate the row. D448 deliberately does not expose the
 * superseded server-side byte-restore mutation path.
 *
 * Requires: the disposable `test-cruft` instance selected by
 * `bootstrapTestDbInstance()`; never the protected `nautilo` database.
 */

import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actors,
  agents,
  artifactNamespaces,
  artifacts,
  createDirectDb,
  ensureDatabase,
  eq,
  fileRevisions,
  namespaces,
  roomMembers,
  rooms,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createStorageZones,
  ensureDirectoryTree,
  fromRuntimeConfig,
  resolveNautiloRuntimePaths,
} from "@nautilo/config";
import { findLatestRevisionForPath } from "../../src/tools/file/backups";
import { resetBackupStorage, setBackupStorage } from "../../src/tools/file/backups";
import { setWorkspaceArtifactEventSink } from "../../src/tools/file/artifact-store";

type Fixture = {
  format: string;
  artifact: {
    artifactId: string;
    logicalPath: string;
    mimeType: string;
    revision: number;
  };
  revision: {
    turnId: string;
    workspacePath: string;
    preContent: string;
    postContent: string;
    preSha256: string;
    preSize: number;
    kind: "blob";
    blobRef: string;
    blobSize: number;
    operation: "write";
    pinned: boolean;
    authoredBy: "agent";
  };
  expected: {
    undoSummary: string;
    restoredContent: string;
  };
};

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../fixtures/d448/workspace-revision-compatibility.json"),
    "utf8",
  ),
) as Fixture;

let db: ReturnType<typeof createDirectDb>;
let userId: string;
let agentId: string;
let namespaceId: string;
let roomId: string;
let artifactRowId: string;
let artifactPath: string;
let fixtureRoot: string;
let previousArtifactsRoot: string | undefined;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  fixtureRoot = join(tmpdir(), `d448-workspace-revision-${randomUUID()}`);
  mkdirSync(fixtureRoot, { recursive: true });
  const artifactRoot = join(realpathSync(fixtureRoot), "artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  previousArtifactsRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
  process.env["NAUTILO_ARTIFACTS_ROOT"] = artifactRoot;

  const runtimePaths = resolveNautiloRuntimePaths({
    config: fromRuntimeConfig({}),
    env: {},
    userHomeDir: fixtureRoot,
  });
  await ensureDirectoryTree(runtimePaths);
  setBackupStorage(createStorageZones(runtimePaths));

  const suffix = randomUUID().slice(0, 8);
  const [user] = await db
    .insert(users)
    .values({
      name: "d448-workspace-compatibility",
      email: `d448-workspace-${suffix}@test.local`,
      handle: `d448workspace${suffix}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("D448 fixture user insert failed");
  userId = user.id;

  const [agent] = await db
    .insert(agents)
    .values({ handle: `d448-workspace-${suffix}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("D448 fixture agent insert failed");
  agentId = agent.id;

  const [namespace] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `d448-workspace-${suffix}` })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("D448 fixture namespace insert failed");
  namespaceId = namespace.id;

  const [actor] = await db
    .insert(actors)
    .values({ ownerId: userId, displayName: "D448 fixture owner", kind: "user" })
    .returning({ id: actors.id });
  if (!actor) throw new Error("D448 fixture actor insert failed");

  const [room] = await db
    .insert(rooms)
    .values({
      namespaceId,
      ownerId: userId,
      type: "private",
      label: `D448 workspace fixture ${suffix}`,
      graphThreadId: `d448-workspace-${suffix}`,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("D448 fixture room insert failed");
  roomId = room.id;
  await db.insert(roomMembers).values({ roomId, actorId: actor.id });

  artifactPath = join(artifactRoot, randomUUID());
  writeFileSync(artifactPath, fixture.revision.postContent, "utf8");
  const [artifact] = await db
    .insert(artifacts)
    .values({
      artifactId: `${fixture.artifact.artifactId}-${suffix}`,
      path: fixture.artifact.logicalPath,
      mimeType: fixture.artifact.mimeType,
      size: Buffer.byteLength(fixture.revision.postContent),
      revision: fixture.artifact.revision,
      storageUri: `file://${artifactPath}`,
    })
    .returning({ id: artifacts.id });
  if (!artifact) throw new Error("D448 fixture artifact insert failed");
  artifactRowId = artifact.id;
  await db.insert(artifactNamespaces).values({ artifactId: artifactRowId, namespaceId });

  const storage = createStorageZones(runtimePaths).data;
  await storage.write(fixture.revision.blobRef, Buffer.from(fixture.revision.preContent, "utf8"));
  await db.insert(fileRevisions).values({
    id: randomUUID(),
    ownerId: userId,
    agentId,
    roomId,
    turnId: fixture.revision.turnId,
    absolutePath: artifactPath,
    workspacePath: fixture.revision.workspacePath,
    preSha256: fixture.revision.preSha256,
    preSize: fixture.revision.preSize,
    kind: fixture.revision.kind,
    blobRef: fixture.revision.blobRef,
    blobSize: fixture.revision.blobSize,
    operation: fixture.revision.operation,
    pinned: fixture.revision.pinned,
    authoredBy: fixture.revision.authoredBy,
  });

  setWorkspaceArtifactEventSink(() => {});
});

afterAll(async () => {
  resetBackupStorage();
  setWorkspaceArtifactEventSink(null);
  if (db) {
    await db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, artifactRowId));
    await db.delete(artifacts).where(eq(artifacts.id, artifactRowId));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
    await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(users).where(eq(users.id, userId));
    await db.end();
  }
  if (previousArtifactsRoot === undefined) {
    delete process.env["NAUTILO_ARTIFACTS_ROOT"];
  } else {
    process.env["NAUTILO_ARTIFACTS_ROOT"] = previousArtifactsRoot;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("D448 Workspace revision compatibility", () => {
  test("the current reader enumerates a committed pre-D448 artifact revision without mutating bytes", async () => {
    expect(fixture.format).toBe("file_revisions@0108");

    const legacy = await findLatestRevisionForPath(agentId, artifactPath);
    expect(legacy).not.toBeNull();
    expect(legacy).toMatchObject({
      absolutePath: artifactPath,
      workspacePath: fixture.revision.workspacePath,
      workspaceArtifactId: null,
      workspacePathBefore: null,
      workspacePathAfter: null,
      workspaceOperationId: null,
      kind: fixture.revision.kind,
      blobRef: fixture.revision.blobRef,
      preSha256: fixture.revision.preSha256,
      preSize: fixture.revision.preSize,
      operation: fixture.revision.operation,
    });

    expect(readFileSync(artifactPath, "utf8")).toBe(fixture.revision.postContent);
  });
});
