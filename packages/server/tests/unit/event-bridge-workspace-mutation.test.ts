import { expect, test } from "bun:test";
import { shouldBridgeRuntimeEventToWebSocket } from "../../src/realtime/event-bridge";
import type { ServerEvent } from "@nautilo/types";

test("D448 committed Workspace mutation events stay on the authorized SSE/outbox path", () => {
  const event = {
    type: "document.mutation.committed",
    operationId: "op-1",
    revisionGroupId: "group-1",
    sequence: 0,
    outcome: "applied",
    actor: { kind: "human", humanId: "human-1" },
    mutation: "update",
    path: {
      kind: "update",
      before: { kind: "workspace_artifact", artifactId: "11111111-1111-4111-8111-111111111111", logicalPath: "note.md" },
      after: { kind: "workspace_artifact", artifactId: "11111111-1111-4111-8111-111111111111", logicalPath: "note.md" },
    },
    before: {
      identity: { kind: "workspace_artifact", artifactId: "11111111-1111-4111-8111-111111111111", logicalPath: "note.md" },
      backendVersion: { kind: "artifact_revision", revision: 1 }, sha256: "a".repeat(64),
    },
    after: {
      identity: { kind: "workspace_artifact", artifactId: "11111111-1111-4111-8111-111111111111", logicalPath: "note.md" },
      backendVersion: { kind: "artifact_revision", revision: 2 }, sha256: "b".repeat(64),
    },
  } satisfies ServerEvent;
  expect(shouldBridgeRuntimeEventToWebSocket(event)).toBe(false);
});
