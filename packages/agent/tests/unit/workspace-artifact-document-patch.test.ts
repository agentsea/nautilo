import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DocumentPatchEvent } from "@nautilo/types";
import * as artifactStore from "../../src/tools/file/artifact-store";
import type { WorkspaceArtifactPatchMeta } from "../../src/tools/file/artifact-store";
import { applyEphemeralPatch } from "../../src/tools/file/commands/apply-core";
import { constructPatch, sha256Hex } from "../../src/tools/file/staged-patches";

describe("emitWorkspaceArtifactDocumentPatchApplied", () => {
  const events: DocumentPatchEvent[] = [];
  const restores: Array<() => void> = [];

  beforeEach(() => {
    events.length = 0;
    artifactStore.setWorkspaceArtifactEventSink((event) => {
      if (event.type === "document.patch.applied") {
        events.push(event);
      }
    });
  });

  afterEach(() => {
    artifactStore.setWorkspaceArtifactEventSink(null);
    while (restores.length) restores.pop()!();
  });

  test("emits document.patch.applied with artifact target metadata", () => {
    artifactStore.emitWorkspaceArtifactDocumentPatchApplied({
      rowInternalId: "row-1",
      logicalPath: "notes/a.md",
      mimeType: "text/markdown",
      roomId: "room-1",
      previousRevision: 2,
      previousSha256: "prev-sha",
      newRevision: 3,
      newSha256: "next-sha",
      patchId: "patch-1",
      anchoredPatch: { kind: "anchored_text", oldString: "a", newString: "b" },
      unifiedDiff: "diff",
      author: { kind: "agent", displayName: "agent-1" },
      rebased: true,
      clientMutationId: "mut-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "document.patch.applied",
      target: {
        kind: "artifact",
        artifactInternalId: "row-1",
        path: "notes/a.md",
        roomId: "room-1",
        mimeType: "text/markdown",
      },
      patchId: "patch-1",
      revision: 3,
      sha256: "next-sha",
      previousRevision: 2,
      previousSha256: "prev-sha",
      patch: { kind: "anchored_text", oldString: "a", newString: "b" },
      author: { kind: "agent", displayName: "agent-1" },
      clientMutationId: "mut-1",
      rebased: true,
    });
  });
});

describe("applyEphemeralPatch workspace document patch emission", () => {
  let TMP_ROOT: string;
  const events: DocumentPatchEvent[] = [];
  const restores: Array<() => void> = [];
  let rowApplyArgs: Parameters<typeof artifactStore.applyWorkspaceArtifactRowChange> | null = null;

  const wsMeta: WorkspaceArtifactPatchMeta = {
    mode: "update",
    artifactId: "artifact-ext",
    logicalPath: "notes/a.md",
    namespaceId: "ns-1",
    storageUri: "file:///unused",
    rowId: "row-1",
    mimeType: "text/markdown",
  };

  beforeEach(async () => {
    TMP_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-doc-patch-apply-"));
    events.length = 0;
    artifactStore.setWorkspaceArtifactEventSink((event) => {
      if (event.type === "document.patch.applied") {
        events.push(event);
      }
    });
    rowApplyArgs = null;
    const rowSpy = spyOn(artifactStore, "applyWorkspaceArtifactRowChange").mockImplementation(
      async (...args: Parameters<typeof artifactStore.applyWorkspaceArtifactRowChange>) => {
        rowApplyArgs = args;
        return {
          internalId: "row-1",
          artifactId: "artifact-ext",
          path: "notes/a.md",
          revision: 4,
          previousRevision: 3,
        };
      },
    );
    restores.push(() => rowSpy.mockRestore());
  });

  afterEach(async () => {
    artifactStore.setWorkspaceArtifactEventSink(null);
    while (restores.length) restores.pop()!();
    if (TMP_ROOT) await fsp.rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("emits document.patch.applied after anchored content write succeeds", async () => {
    const targetPath = path.join(TMP_ROOT, "file.txt");
    const originalBytes = Buffer.from("hello world\n");
    await fsp.writeFile(targetPath, originalBytes);
    const patch = constructPatch({
      turnId: "turn-1",
      ownerId: "owner-1",
      path: targetPath,
      zone: "absolute",
      zoneCtx: { workspaceRoot: "", currentFolder: null },
      originalBytes,
      originalSha256: sha256Hex(originalBytes),
      newBytes: Buffer.from("hello there\n"),
      anchoredEdit: { oldString: "world", newString: "there" },
      unifiedDiff: "diff",
      metadata: {
        command: "str_replace",
        args: {},
        workspaceArtifact: wsMeta,
      },
    });

    const result = await applyEphemeralPatch(patch, {
      zoneCtx: { workspaceRoot: "", currentFolder: null },
      ownerId: "owner-1",
      agentId: "agent-1",
      turnId: "turn-1",
      roomId: "room-1",
    });

    expect(result.error).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.rebased).toBe(false);
    expect(events[0]?.author).toEqual({ kind: "agent", displayName: "agent-1" });
    expect(events[0]?.previousSha256).toBe(sha256Hex(originalBytes));
    expect(events[0]?.sha256).toBe(sha256Hex(Buffer.from("hello there\n")));
  });

  test("does not emit document.patch.applied when row change fails", async () => {
    restores.pop()!();
    const rowSpy = spyOn(artifactStore, "applyWorkspaceArtifactRowChange").mockRejectedValue(
      new Error("row failed"),
    );
    restores.push(() => rowSpy.mockRestore());

    const targetPath = path.join(TMP_ROOT, "file2.txt");
    const originalBytes = Buffer.from("alpha\n");
    await fsp.writeFile(targetPath, originalBytes);
    const patch = constructPatch({
      turnId: "turn-1",
      ownerId: "owner-1",
      path: targetPath,
      zone: "absolute",
      zoneCtx: { workspaceRoot: "", currentFolder: null },
      originalBytes,
      originalSha256: sha256Hex(originalBytes),
      newBytes: Buffer.from("beta\n"),
      anchoredEdit: { oldString: "alpha", newString: "beta" },
      unifiedDiff: "diff",
      metadata: {
        command: "str_replace",
        args: {},
        workspaceArtifact: wsMeta,
      },
    });

    const result = await applyEphemeralPatch(patch, {
      zoneCtx: { workspaceRoot: "", currentFolder: null },
      ownerId: "owner-1",
      agentId: "agent-1",
      turnId: "turn-1",
    });

    expect(result.error).toBe(true);
    expect(events).toHaveLength(0);
  });

  test("does not emit document.patch.applied without anchoredEdit", async () => {
    const targetPath = path.join(TMP_ROOT, "file3.txt");
    const originalBytes = Buffer.from("same\n");
    await fsp.writeFile(targetPath, originalBytes);
    const patch = constructPatch({
      turnId: "turn-1",
      ownerId: "owner-1",
      path: targetPath,
      zone: "absolute",
      zoneCtx: { workspaceRoot: "", currentFolder: null },
      originalBytes,
      originalSha256: sha256Hex(originalBytes),
      newBytes: Buffer.from("changed\n"),
      unifiedDiff: "diff",
      metadata: {
        command: "write",
        args: {},
        workspaceArtifact: wsMeta,
      },
    });

    const result = await applyEphemeralPatch(patch, {
      zoneCtx: { workspaceRoot: "", currentFolder: null },
      ownerId: "owner-1",
      agentId: "agent-1",
      turnId: "turn-1",
    });

    expect(result.error).toBe(false);
    expect(events).toHaveLength(0);
    const meta = rowApplyArgs?.[0];
    expect(meta?.reloadRequired).toBe(true);
    expect(rowApplyArgs?.[1]).toBe(Buffer.byteLength("changed\n", "utf8"));
    expect(rowApplyArgs?.[2]).toBe("owner-1");
    expect(rowApplyArgs?.[3]).toBe("agent-1");
    expect(rowApplyArgs?.[4]).toEqual({ kind: "agent", agentId: "agent-1" });
  });
});
