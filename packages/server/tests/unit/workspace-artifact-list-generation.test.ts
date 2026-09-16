import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import {
  artifactListScopeGenerationDigest,
  bumpWorkspaceArtifactListGenerationForNamespaces,
  clearWorkspaceArtifactListGenerationForTests,
  getWorkspaceArtifactListNamespaceGeneration,
  invalidateWorkspaceArtifactListFromServerEvent,
  setWorkspaceArtifactListNamespaceResolverForTests,
} from "../../src/lib/workspace-artifact-list-generation";

describe("workspace-artifact-list-generation invalidation (M213 Phase 8/11)", () => {
  beforeEach(() => {
    clearWorkspaceArtifactListGenerationForTests();
    setWorkspaceArtifactListNamespaceResolverForTests(null);
  });

  test("delete events invalidate via namespaceIds on the bus payload", async () => {
    const before = artifactListScopeGenerationDigest({
      readableNamespaceIds: ["ns-a", "ns-b"],
      viewerActorId: "actor-1",
      agentId: "agent-1",
      roomId: "room-1",
      limit: 500,
    });

    await invalidateWorkspaceArtifactListFromServerEvent({
      type: "workspace.artifact.deleted",
      id: "row-1",
      artifactId: "artifact-1",
      namespaceIds: ["ns-a"],
    } satisfies ServerEvent);

    expect(getWorkspaceArtifactListNamespaceGeneration("ns-a")).toBe(1);
    expect(getWorkspaceArtifactListNamespaceGeneration("ns-b")).toBe(0);
    const after = artifactListScopeGenerationDigest({
      readableNamespaceIds: ["ns-a", "ns-b"],
      viewerActorId: "actor-1",
      agentId: "agent-1",
      roomId: "room-1",
      limit: 500,
    });
    expect(after).not.toBe(before);
  });

  test("changed events resolve namespaces and invalidate matching scope only", async () => {
    setWorkspaceArtifactListNamespaceResolverForTests(async (internalIds) => {
      expect(internalIds).toEqual(["row-2"]);
      return new Map([["row-2", ["ns-peer"]]]);
    });

    await invalidateWorkspaceArtifactListFromServerEvent({
      type: "workspace.artifact.changed",
      id: "row-2",
      artifactId: "artifact-2",
      path: "docs/b.md",
    } satisfies ServerEvent);

    expect(getWorkspaceArtifactListNamespaceGeneration("ns-peer")).toBe(1);
    expect(getWorkspaceArtifactListNamespaceGeneration("ns-owner")).toBe(0);
  });

  test("document.patch.applied on artifact targets invalidates namespace generation", async () => {
    setWorkspaceArtifactListNamespaceResolverForTests(async () =>
      new Map([["row-3", ["ns-write"]]]),
    );

    await invalidateWorkspaceArtifactListFromServerEvent({
      type: "document.patch.applied",
      target: {
        kind: "artifact",
        artifactInternalId: "row-3",
        path: "notes/c.md",
      },
      patchId: "patch-1",
      revision: 2,
      sha256: "sha-2",
      previousRevision: 1,
      previousSha256: "sha-1",
      patch: { kind: "anchored_text", oldString: "a", newString: "b" },
      author: { kind: "human", displayName: "User" },
    } satisfies ServerEvent);

    expect(getWorkspaceArtifactListNamespaceGeneration("ns-write")).toBe(1);
  });

  test("committed workspace artifact creates invalidate after the row is visible", async () => {
    setWorkspaceArtifactListNamespaceResolverForTests(async (internalIds) => {
      expect(internalIds).toEqual(["row-created"]);
      return new Map([["row-created", ["ns-write"]]]);
    });

    await invalidateWorkspaceArtifactListFromServerEvent({
      type: "document.mutation.committed",
      operationId: "operation-create",
      revisionGroupId: "group-create",
      sequence: 0,
      outcome: "applied",
      actor: { kind: "agent", agentId: "agent-1" },
      mutation: "create",
      path: {
        kind: "create",
        after: {
          kind: "workspace_artifact",
          artifactId: "row-created",
          logicalPath: "notes/created.md",
        },
      },
      after: {
        identity: {
          kind: "workspace_artifact",
          artifactId: "row-created",
          logicalPath: "notes/created.md",
        },
        backendVersion: { kind: "artifact_revision", revision: 1 },
        sha256: "a".repeat(64),
      },
    } satisfies ServerEvent);

    expect(getWorkspaceArtifactListNamespaceGeneration("ns-write")).toBe(1);
  });

  test("bumpWorkspaceArtifactListGenerationForNamespaces increments per namespace", () => {
    bumpWorkspaceArtifactListGenerationForNamespaces(["ns-a", "ns-a", "ns-b"]);
    expect(getWorkspaceArtifactListNamespaceGeneration("ns-a")).toBe(2);
    expect(getWorkspaceArtifactListNamespaceGeneration("ns-b")).toBe(1);
    bumpWorkspaceArtifactListGenerationForNamespaces(["ns-a"]);
    expect(getWorkspaceArtifactListNamespaceGeneration("ns-a")).toBe(3);
  });
});
