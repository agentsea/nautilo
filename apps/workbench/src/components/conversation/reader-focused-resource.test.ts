import { describe, expect, test } from "bun:test";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import { readerFocusedResourcesForSend } from "./reader-focused-resource";

const artifact: ArtifactDto = {
  id: "internal-row-id",
  artifactId: "agent-facing/doc-id",
  path: "plans/launch.md",
  mimeType: "text/markdown",
  size: 42,
  revision: 3,
  updatedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-08-31T00:00:00.000Z",
  namespaceIds: ["namespace-1"],
  canWrite: true,
};

describe("readerFocusedResourcesForSend", () => {
  test("maps the visible internal row to the authoritative external artifact id", () => {
    expect(
      readerFocusedResourcesForSend({
        target: { kind: "workspace-artifact", artifactInternalId: artifact.id },
        activeRoomId: "room-1",
        artifactProjectionRoomId: "room-1",
        artifacts: [artifact],
      }),
    ).toEqual([{ kind: "workspace-artifact", artifactId: artifact.artifactId }]);
  });

  test("does not borrow an artifact projection from a different Room", () => {
    expect(
      readerFocusedResourcesForSend({
        target: { kind: "workspace-artifact", artifactInternalId: artifact.id },
        activeRoomId: "room-1",
        artifactProjectionRoomId: "room-2",
        artifacts: [artifact],
      }),
    ).toEqual([]);
  });

  test("fails closed when the visible row is absent from the authoritative projection", () => {
    expect(
      readerFocusedResourcesForSend({
        target: { kind: "workspace-artifact", artifactInternalId: "missing" },
        activeRoomId: "room-1",
        artifactProjectionRoomId: "room-1",
        artifacts: [artifact],
      }),
    ).toEqual([]);
  });

  test("maps the visible local file with the current preload-owned relay identity", () => {
    expect(
      readerFocusedResourcesForSend({
        target: {
          kind: "local-file",
          path: "/Users/alice/project/docs/plan.md",
          rootPath: "/Users/alice/project",
        },
        relayId: "relay-current",
        activeRoomId: "room-1",
        artifactProjectionRoomId: "room-1",
        artifacts: [],
      }),
    ).toEqual([{
      kind: "local-file",
      path: "/Users/alice/project/docs/plan.md",
      rootPath: "/Users/alice/project",
      name: "plan.md",
      relayId: "relay-current",
    }]);
  });

  test("fails closed for a visible local file when the relay identity is unavailable", () => {
    expect(
      readerFocusedResourcesForSend({
        target: {
          kind: "local-file",
          path: "/Users/alice/project/docs/plan.md",
          rootPath: "/Users/alice/project",
        },
        relayId: null,
        activeRoomId: "room-1",
        artifactProjectionRoomId: "room-1",
        artifacts: [],
      }),
    ).toEqual([]);
  });
});
