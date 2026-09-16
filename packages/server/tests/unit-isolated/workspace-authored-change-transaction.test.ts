import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const transactionHandle = { select: mock(() => undefined) };
let transactionShouldThrow = false;
let releaseTransaction: (() => void) | null = null;
let transactionBodyFinished: (() => void) | null = null;
const transactionMock = mock(async (run: (tx: typeof transactionHandle) => Promise<unknown>) => {
  if (transactionShouldThrow) throw new Error("database unavailable");
  const result = await run(transactionHandle);
  transactionBodyFinished?.();
  await new Promise<void>((resolve) => { releaseTransaction = resolve; });
  return result;
});

let artifact: Record<string, unknown>;
let historyRecord: Record<string, unknown>;
const lockMock = mock(async (_scope: unknown, tx: unknown) => {
  expect(tx).toBe(transactionHandle);
  return artifact;
});
const historyMock = mock(async (tx: unknown) => {
  expect(tx).toBe(transactionHandle);
  return [historyRecord];
});
const reduceMock = mock(() => ({ kind: "valid", undo: [historyRecord], redo: [], current: historyRecord }));

mock.module("@nautilo/db", () => ({
  lockWorkspaceArtifactForCurrentRoomAuthority: lockMock,
  listWorkspaceRoomDocumentHistory: historyMock,
  reduceWorkspaceDocumentHistoryLineage: reduceMock,
}));
mock.module("@nautilo/agent", () => ({
  USER_SAVE_TEXT_LIMIT_BYTES: 50 * 1024 * 1024,
}));
mock.module("@nautilo/trust", () => ({
  isScopeMemoryEnvelope: (value: { memoryMode?: string }) => value.memoryMode === "scope",
}));
mock.module("../../src/lib/server-direct-db.ts", () => ({
  getServerDirectDb: () => ({ transaction: transactionMock }),
}));

const { readWorkspaceAuthoredChange } = await import(
  "../../src/document-mutations/workspace-authored-change"
);

const roots: string[] = [];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const input = (expectedSha256: string) => ({
  envelope: {
    memoryMode: "namespace" as const,
    ownerId: "viewer-owner",
    actorId: "human-actor",
    agentId: "room-agent",
    roomId: "current-room",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: {},
  },
  sessionUserId: "viewer-user",
  artifactId: "artifact-row",
  expectedRevision: 3,
  expectedSha256,
});

beforeEach(async () => {
  transactionShouldThrow = false;
  releaseTransaction = null;
  transactionBodyFinished = null;
  transactionMock.mockClear();
  lockMock.mockClear();
  historyMock.mockClear();
  reduceMock.mockClear();

  const root = await mkdtemp(join(tmpdir(), "workspace-authored-transaction-"));
  roots.push(root);
  const head = "current human head";
  const before = "before Genie edit";
  const after = "after Genie edit";
  const headPath = join(root, "head.html");
  const beforePath = join(root, "before.html");
  const afterPath = join(root, "after.html");
  await Promise.all([
    writeFile(headPath, head),
    writeFile(beforePath, before),
    writeFile(afterPath, after),
  ]);
  artifact = {
    id: "artifact-row",
    path: "cut.video.html",
    storageUri: `file://${headPath}`,
    size: Buffer.byteLength(head),
    revision: 3,
    deletedAt: null,
  };
  historyRecord = {
    mutation: {
      id: "mutation-row",
      operationId: "operation-row",
      agentId: "room-agent",
      roomId: "current-room",
      actorKind: "agent",
      actorId: "room-agent",
    },
    entry: {
      id: "entry-row",
      artifactInternalId: "artifact-row",
      historyEligible: true,
      mutationKind: "update",
      historyOperation: "document.write",
      restoreFromEntryId: null,
      beforeLogicalPath: "cut.video.html",
      afterLogicalPath: "cut.video.html",
      beforeRevision: 1,
      afterRevision: 2,
      beforeStorageUri: `file://${beforePath}`,
      afterStorageUri: `file://${afterPath}`,
      beforeSize: Buffer.byteLength(before),
      afterSize: Buffer.byteLength(after),
      beforeSha256: digest(before),
      afterSha256: digest(after),
    },
    revisionId: "revision-row",
  };
});

afterEach(async () => {
  releaseTransaction?.();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("default authored-change read keeps lock proof and history on one transaction until completion", async () => {
  const headSha = digest("current human head");
  let bodyFinished!: () => void;
  const finished = new Promise<void>((resolve) => { bodyFinished = resolve; });
  transactionBodyFinished = bodyFinished;
  let settled = false;
  const pending = readWorkspaceAuthoredChange(input(headSha)).finally(() => { settled = true; });

  await finished;
  expect(settled).toBe(false);
  expect(transactionMock).toHaveBeenCalledTimes(1);
  expect(lockMock).toHaveBeenCalledTimes(3);
  expect(historyMock).toHaveBeenCalledTimes(1);
  expect(historyMock.mock.calls[0]?.[0]).toBe(transactionHandle);

  releaseTransaction?.();
  expect(await pending).toEqual({
    kind: "ready",
    operationId: "operation-row",
    author: { kind: "agent", displayName: "Genie" },
    before: { content: "before Genie edit", sha256: digest("before Genie edit") },
    after: { content: "after Genie edit", sha256: digest("after Genie edit") },
    currentSha256: headSha,
  });
});

test("default authored-change read closes transaction failures as unavailable", async () => {
  transactionShouldThrow = true;
  expect(await readWorkspaceAuthoredChange(input(digest("current human head")))).toEqual({
    kind: "unavailable",
    code: "history_unavailable",
  });
  expect(transactionMock).toHaveBeenCalledTimes(1);
  expect(lockMock).not.toHaveBeenCalled();
  expect(historyMock).not.toHaveBeenCalled();
});
