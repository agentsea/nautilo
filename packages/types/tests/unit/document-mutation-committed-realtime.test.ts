import { expect, test } from "bun:test";
import type { ServerEvent } from "../../src/realtime";

test("D448 committed document truth is a ServerEvent without reviving patch projection", () => {
  const event = {
    type: "document.mutation.committed",
    operationId: "workspace-editor:artifact-1:request-1",
    revisionGroupId: "workspace-editor-group:1",
    sequence: 0,
    outcome: "applied",
    actor: { kind: "human" as const, humanId: "human-1" },
    mutation: "update" as const,
    path: {
      kind: "update" as const,
      before: {
        kind: "workspace_artifact" as const,
        artifactId: "artifact-1",
        logicalPath: "notes/draft.md",
      },
      after: {
        kind: "workspace_artifact" as const,
        artifactId: "artifact-1",
        logicalPath: "notes/draft.md",
      },
    },
    before: {
      identity: {
        kind: "workspace_artifact" as const,
        artifactId: "artifact-1",
        logicalPath: "notes/draft.md",
      },
      backendVersion: { kind: "artifact_revision" as const, revision: 1 },
      sha256: "a".repeat(64),
    },
    after: {
      identity: {
        kind: "workspace_artifact" as const,
        artifactId: "artifact-1",
        logicalPath: "notes/draft.md",
      },
      backendVersion: { kind: "artifact_revision" as const, revision: 2 },
      sha256: "b".repeat(64),
    },
    editorSave: {
      checkpoint: false,
      requestId: "request-1",
      clientMutationId: "client-1",
      anchoredPatch: { kind: "anchored_text" as const, oldString: "a", newString: "b" },
    },
    workspaceArtifactMetadata: {
      beforeMimeType: "text/markdown",
      afterMimeType: "text/x-markdown",
    },
  } satisfies ServerEvent;
  expect(event.type).toBe("document.mutation.committed");
  expect(event.editorSave?.anchoredPatch).toEqual({
    kind: "anchored_text",
    oldString: "a",
    newString: "b",
  });
  expect(event.workspaceArtifactMetadata).toEqual({
    beforeMimeType: "text/markdown",
    afterMimeType: "text/x-markdown",
  });
});
