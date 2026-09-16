import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  isTextLikePatchTarget,
  isWorkspaceArtifactSseEvent,
  parseDocumentPatchRequestBody,
  patchRejectionStatus,
  WORKSPACE_EDITOR_RECOVERY_RESPONSE,
} from "../../src/routes/workspace-artifacts";

describe("isWorkspaceArtifactSseEvent", () => {
  test("rejects irrelevant global traffic before per-connection async work", () => {
    expect(isWorkspaceArtifactSseEvent({ type: "task.updated" } as never)).toBe(false);
    expect(isWorkspaceArtifactSseEvent({
      type: "document.patch.applied",
      target: { kind: "artifact", artifactInternalId: "artifact-1", path: "Design.html" },
    } as never)).toBe(true);
    expect(isWorkspaceArtifactSseEvent({
      type: "document.patch.applied",
      target: { kind: "currentFile", currentFolderRef: "folder-1", relativePath: "Design.html" },
    } as never)).toBe(false);
    expect(isWorkspaceArtifactSseEvent({
      type: "document.mutation.committed",
      mutation: "create",
      after: { identity: { kind: "workspace_artifact" } },
      path: { after: { kind: "workspace_artifact" } },
    } as never)).toBe(true);
    expect(isWorkspaceArtifactSseEvent({
      type: "document.mutation.committed",
      mutation: "update",
      before: { identity: { kind: "workspace_artifact" } },
      after: { identity: { kind: "workspace_artifact" } },
      path: {
        before: { kind: "workspace_artifact" },
        after: { kind: "workspace_artifact" },
      },
    } as never)).toBe(true);
  });

  test("rejects committed events when any identity belongs to a local file", () => {
    const workspaceIdentity = {
      kind: "workspace_artifact",
      artifactId: "artifact-1",
      logicalPath: "notes/private.md",
    };
    const localIdentity = {
      kind: "local_file",
      relayId: "relay-1",
      canonicalPath: "/private/local.txt",
    };
    const workspaceVersion = {
      identity: workspaceIdentity,
      backendVersion: { kind: "artifact_revision", revision: 2 },
      sha256: "a".repeat(64),
    };
    const localVersion = {
      identity: localIdentity,
      backendVersion: { kind: "local_sha", sha256: "b".repeat(64) },
      sha256: "b".repeat(64),
    };
    const base = {
      type: "document.mutation.committed",
      mutation: "update",
      before: workspaceVersion,
      after: workspaceVersion,
      path: {
        kind: "update",
        before: workspaceIdentity,
        after: workspaceIdentity,
      },
    };

    expect(isWorkspaceArtifactSseEvent({
      ...base,
      before: localVersion,
    } as never)).toBe(false);
    expect(isWorkspaceArtifactSseEvent({
      ...base,
      after: localVersion,
    } as never)).toBe(false);
    expect(isWorkspaceArtifactSseEvent({
      ...base,
      path: { ...base.path, before: localIdentity },
    } as never)).toBe(false);
    expect(isWorkspaceArtifactSseEvent({
      ...base,
      path: { ...base.path, after: localIdentity },
    } as never)).toBe(false);
  });
});

describe("parseDocumentPatchRequestBody", () => {
  const validBase = {
    requestId: "req-1",
    baseSha256: "abc123",
    baseRevision: 1,
    target: {
      kind: "artifact" as const,
      artifactInternalId: "art-1",
      path: "notes/hello.md",
    },
    patch: {
      kind: "anchored_text" as const,
      oldString: "a",
      newString: "b",
    },
  };

  test("accepts a well-formed artifact patch body", () => {
    const parsed = parseDocumentPatchRequestBody(validBase);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.requestId).toBe("req-1");
      expect(parsed.request.target.kind).toBe("artifact");
    }
  });

  test("rejects missing requestId", () => {
    const parsed = parseDocumentPatchRequestBody({ ...validBase, requestId: "" });
    expect(parsed).toEqual({ ok: false, reason: "requestId is required" });
  });

  test("rejects non-anchored_text patch kind", () => {
    const parsed = parseDocumentPatchRequestBody({
      ...validBase,
      patch: { kind: "binary", oldString: "a", newString: "b" },
    });
    expect(parsed).toEqual({ ok: false, reason: "patch.kind must be anchored_text" });
  });

  test("accepts currentFile wire shape for route-level rejection", () => {
    const parsed = parseDocumentPatchRequestBody({
      ...validBase,
      target: { kind: "currentFile", currentFolderRef: "cf", relativePath: "x.md" },
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("patchRejectionStatus", () => {
  test("maps anchor conflicts to 409", () => {
    const base: { latestRevision: number | null; latestSha256: string } = {
      latestRevision: 2,
      latestSha256: "deadbeef",
    };
    expect(patchRejectionStatus({ kind: "anchor_not_found", ...base })).toBe(409);
    expect(patchRejectionStatus({ kind: "anchor_ambiguous", ...base })).toBe(409);
    expect(patchRejectionStatus({ kind: "stale_base_unrebaseable", ...base })).toBe(409);
  });

  test("maps forbidden to 403 and too_large to 413", () => {
    expect(patchRejectionStatus({ kind: "forbidden", reason: "nope" })).toBe(403);
    expect(patchRejectionStatus({ kind: "too_large", reason: "big" })).toBe(413);
  });
});

describe("isTextLikePatchTarget", () => {
  test("allows text and structured text formats", () => {
    expect(isTextLikePatchTarget("text/plain", "notes.txt")).toBe(true);
    expect(isTextLikePatchTarget("application/json", "data.bin")).toBe(true);
    expect(isTextLikePatchTarget("application/vnd.nautilo.spreadsheet+json", "sheet.html")).toBe(true);
    expect(isTextLikePatchTarget(null, "notes.md")).toBe(true);
  });

  test("rejects binary formats", () => {
    expect(isTextLikePatchTarget("application/octet-stream", "blob.bin")).toBe(false);
    expect(isTextLikePatchTarget("image/png", "image.png")).toBe(false);
    expect(isTextLikePatchTarget("application/pdf", "doc.pdf")).toBe(false);
  });
});

describe("D448 Workspace editor route cutover", () => {
  test("uses one stable retryable recovery contract for snapshot and patch routes", async () => {
    expect(WORKSPACE_EDITOR_RECOVERY_RESPONSE).toEqual({
      error: "recovery_required",
      retryable: true,
      message:
        "Mutation outcome requires recovery. Retry with identical requestId and clientMutationId values, including any omitted value.",
    });
    const source = await readFile(
      resolve(import.meta.dir, "../../src/routes/workspace-artifacts.ts"),
      "utf8",
    );
    expect(source.match(/reply\.code\(503\)\.send\(WORKSPACE_EDITOR_RECOVERY_RESPONSE\)/g))
      .toHaveLength(2);
  });

  test("keeps both compatibility routes while excluding legacy committers and forwarding direct-live patch truth", async () => {
    const source = await readFile(
      resolve(import.meta.dir, "../../src/routes/workspace-artifacts.ts"),
      "utf8",
    );
    expect(source).toContain('"/api/workspace/artifacts/:id/content"');
    expect(source).toContain('"/api/workspace/artifacts/:id/patch"');
    expect(source).toContain("saveWorkspaceEditorSnapshot(");
    expect(source).toContain("saveWorkspaceEditorPatch(");
    expect(source).not.toContain("userSaveWorkspaceArtifact(");
    expect(source).not.toContain("applyWorkspaceArtifactTextPatch(");
    expect(source).toContain('writeEvent("document.patch.applied", event)');
    expect(source).toContain("internalId: event.target.artifactInternalId");
    expect(source).toContain('writeEvent("document.mutation.committed", event)');
    expect(source).not.toContain('"/api/workspace/artifacts/:id/patches"');
    expect(source).not.toContain("getWorkspaceArtifactPatchEventsSince(");
  });
});
