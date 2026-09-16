import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { USER_SAVE_TEXT_LIMIT_BYTES } from "@nautilo/agent";
import {
  saveWorkspaceEditorPatch,
  saveWorkspaceEditorSnapshot,
  type WorkspaceEditorReplayLookup,
} from "../../src/document-mutations/workspace-editor-save-service";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const authority = {
  envelope: {
    memoryMode: "namespace" as const,
    ownerId: "owner-1",
    actorId: "human-1",
    agentId: "agent-1",
    roomId: "room-1",
    readableNamespaces: ["namespace-1"],
    mutableNamespaces: ["namespace-1"],
    writableNamespaces: ["namespace-1"],
    toolPolicy: {},
  },
  artifact: {
    id: "artifact-1",
    artifactId: "artifact-public-1",
    path: "notes/draft.md",
    mimeType: "text/markdown",
    size: 0,
    storageUri: "file:///definitely/not/read",
    revision: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  },
};

test("D448 patch compatibility rejects either oversized anchored side before storage access", async () => {
  const oversizedOld = await saveWorkspaceEditorPatch({
    ...authority,
    requestId: "request-old",
    baseRevision: 1,
    baseSha256: "a".repeat(64),
    checkpoint: false,
    patch: {
      kind: "anchored_text",
      oldString: "x".repeat(USER_SAVE_TEXT_LIMIT_BYTES + 1),
      newString: "",
    },
  });
  expect(oversizedOld).toEqual({
    ok: false,
    rejection: {
      kind: "too_large",
      reason: `patch payload exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte limit`,
    },
  });

  const oversizedNew = await saveWorkspaceEditorPatch({
    ...authority,
    requestId: "request-new",
    baseRevision: 1,
    baseSha256: "a".repeat(64),
    checkpoint: false,
    patch: {
      kind: "anchored_text",
      oldString: "",
      newString: "y".repeat(USER_SAVE_TEXT_LIMIT_BYTES + 1),
    },
  });
  expect(oversizedNew).toEqual({
    ok: false,
    rejection: {
      kind: "too_large",
      reason: `patch payload exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte limit`,
    },
  });
});

test("D448 same patch request replays the exact durable result before reading current postimage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nautilo-d448-replay-"));
  try {
    const before = "before\n";
    const after = "after\n";
    const beforePath = join(dir, "before.txt");
    const afterPath = join(dir, "after.txt");
    await Promise.all([writeFile(beforePath, before), writeFile(afterPath, after)]);
    const replay: WorkspaceEditorReplayLookup = {
      kind: "replay",
      beforeStorageUri: `file://${beforePath}`,
      beforeSize: Buffer.byteLength(before),
      afterStorageUri: `file://${afterPath}`,
      afterSize: Buffer.byteLength(after),
      event: {
        type: "document.mutation.committed",
        operationId: "workspace-editor:durable",
        revisionGroupId: "workspace-editor-group:durable",
        sequence: 0,
        outcome: "applied",
        actor: { kind: "human", humanId: "human-1" },
        mutation: "update",
        path: {
          kind: "update",
          before: { kind: "workspace_artifact", artifactId: "artifact-1", logicalPath: "notes/draft.md" },
          after: { kind: "workspace_artifact", artifactId: "artifact-1", logicalPath: "notes/draft.md" },
        },
        before: {
          identity: { kind: "workspace_artifact", artifactId: "artifact-1", logicalPath: "notes/draft.md" },
          backendVersion: { kind: "artifact_revision", revision: 1 },
          sha256: sha256(before),
        },
        after: {
          identity: { kind: "workspace_artifact", artifactId: "artifact-1", logicalPath: "notes/draft.md" },
          backendVersion: { kind: "artifact_revision", revision: 2 },
          sha256: sha256(after),
        },
        editorSave: {
          checkpoint: false,
          requestId: "request-retry",
          anchoredPatch: { kind: "anchored_text", oldString: "before", newString: "after" },
        },
      },
    };
    const result = await saveWorkspaceEditorPatch({
      ...authority,
      requestId: "request-retry",
      baseRevision: 1,
      baseSha256: sha256(before),
      checkpoint: false,
      patch: { kind: "anchored_text", oldString: "before", newString: "after" },
    }, { lookupReplay: async () => replay });
    expect(result).toMatchObject({
      ok: true,
      applied: {
        requestId: "request-retry",
        revision: 2,
        sha256: sha256(after),
        content: after,
      },
    });
    expect(result.ok && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      result.applied.patchId,
    )).toBe(true);
    const changedPatchRetry = await saveWorkspaceEditorPatch({
      ...authority,
      requestId: "request-retry",
      baseRevision: 1,
      baseSha256: sha256(before),
      checkpoint: false,
      patch: { kind: "anchored_text", oldString: "before", newString: "different" },
    }, { lookupReplay: async () => replay });
    expect(changedPatchRetry).toMatchObject({
      ok: false,
      code: "recovery_required",
      retryable: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D448 correlated snapshot retry returns receipt evidence without rebuilding against postimage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nautilo-d448-snapshot-replay-"));
  try {
    const after = "after";
    const afterPath = join(dir, "after.txt");
    await writeFile(afterPath, after);
    const replay: WorkspaceEditorReplayLookup = {
      kind: "replay",
      beforeStorageUri: "file:///not-read-before",
      beforeSize: 3,
      afterStorageUri: `file://${afterPath}`,
      afterSize: Buffer.byteLength(after),
      event: {
        type: "document.mutation.committed",
        operationId: "workspace-editor:durable",
        revisionGroupId: "workspace-editor-group:durable",
        sequence: 0,
        outcome: "applied",
        actor: { kind: "human", humanId: "human-1" },
        mutation: "update",
        path: {
          kind: "update",
          before: { kind: "workspace_artifact", artifactId: "artifact-1", logicalPath: "notes/draft.md" },
          after: { kind: "workspace_artifact", artifactId: "artifact-1", logicalPath: "notes/draft.md" },
        },
        before: {
          identity: { kind: "workspace_artifact", artifactId: "artifact-1", logicalPath: "notes/draft.md" },
          backendVersion: { kind: "artifact_revision", revision: 1 }, sha256: "a".repeat(64),
        },
        after: {
          identity: { kind: "workspace_artifact", artifactId: "artifact-1", logicalPath: "notes/draft.md" },
          backendVersion: { kind: "artifact_revision", revision: 2 }, sha256: sha256(after),
        },
        editorSave: { checkpoint: false, clientMutationId: "client-retry" },
      },
    };
    const saved = await saveWorkspaceEditorSnapshot({
      ...authority,
      newText: after,
      baseRevision: 1,
      baseSha256: "a".repeat(64),
      checkpoint: false,
      clientMutationId: "client-retry",
    }, { lookupReplay: async () => replay });
    expect(saved).toEqual({
      ok: true, revision: 2, size: 5, sha256: sha256(after),
    });
    const changedSnapshotRetry = await saveWorkspaceEditorSnapshot({
      ...authority,
      newText: "different",
      baseRevision: 1,
      baseSha256: "a".repeat(64),
      checkpoint: false,
      clientMutationId: "client-retry",
    }, { lookupReplay: async () => replay });
    expect(changedSnapshotRetry).toMatchObject({
      ok: false,
      code: "recovery_required",
      retryable: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D448 snapshot and patch preserve coordinator recovery_required as one retry contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nautilo-d448-recovery-"));
  try {
    const before = "before\n";
    const beforePath = join(dir, "current.txt");
    await writeFile(beforePath, before);
    const liveAuthority = {
      ...authority,
      artifact: {
        ...authority.artifact,
        storageUri: `file://${beforePath}`,
        size: Buffer.byteLength(before),
      },
    };
    const operationIds: string[] = [];
    const executeCoordinator: NonNullable<
      Parameters<typeof saveWorkspaceEditorSnapshot>[1]
    >["executeCoordinator"] = async (request) => {
      operationIds.push(request.operationId);
      return {
        kind: "recovery_required",
        commitState: "unknown",
        operationId: request.operationId,
        code: "inconsistent_outcome",
        paths: [],
        events: [],
      };
    };
    const expected = {
      ok: false,
      code: "recovery_required",
      retryable: true,
      message:
        "Mutation outcome requires recovery. Retry with identical requestId and clientMutationId values, including any omitted value.",
    } as const;

    const snapshotResult = await saveWorkspaceEditorSnapshot({
      ...liveAuthority,
      newText: "after\n",
      baseRevision: 1,
      baseSha256: sha256(before),
      checkpoint: false,
    }, {
      lookupReplay: async () => ({ kind: "absent" }),
      executeCoordinator,
    });
    expect(snapshotResult).toEqual(expected);
    const snapshotRetry = await saveWorkspaceEditorSnapshot({
      ...liveAuthority,
      newText: "after\n",
      baseRevision: 1,
      baseSha256: sha256(before),
      checkpoint: false,
    }, {
      lookupReplay: async () => ({ kind: "absent" }),
      executeCoordinator,
    });
    expect(snapshotRetry).toEqual(expected);
    expect(operationIds[1]).toBe(operationIds[0]);

    const patchResult = await saveWorkspaceEditorPatch({
      ...liveAuthority,
      requestId: "request-recovery",
      baseRevision: 1,
      baseSha256: sha256(before),
      checkpoint: false,
      patch: { kind: "anchored_text", oldString: "before", newString: "after" },
    }, {
      lookupReplay: async () => ({ kind: "absent" }),
      executeCoordinator,
    });
    expect(patchResult).toEqual(expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
