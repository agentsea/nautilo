import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  WorkspaceFileStructuralMutationRequest,
} from "@nautilo/agent";
import type { Artifact } from "@nautilo/db";
import {
  buildWorkspaceFileStructuralPlan,
} from "../../src/document-mutations/workspace-file-structural-coordinator-adapter";

const sourceBytes = new TextEncoder().encode("source bytes\n");
const source: Artifact = {
  id: "11111111-1111-4111-8111-111111111111",
  artifactId: "artifact-1",
  path: "notes/source.txt",
  mimeType: "text/plain",
  size: sourceBytes.byteLength,
  storageUri: "file:///canonical/source",
  revision: 7,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
};

function request(
  command: "delete" | "move" | "copy",
): WorkspaceFileStructuralMutationRequest {
  return {
    authority: {
      ownerId: "owner-1",
      agentId: "agent-1",
      roomId: "room-1",
      turnId: "turn-1",
      envelope: {
        ownerId: "owner-1",
        actorId: "human-1",
        agentId: "agent-1",
        roomId: "room-1",
        readableNamespaces: ["namespace-1"],
        mutableNamespaces: ["namespace-1"],
        writableNamespaces: ["namespace-1"],
        toolPolicy: {},
      },
    },
    mutationRequestId: "request-1",
    command,
    logicalPath: source.path,
    ...(command === "delete"
      ? {}
      : { destinationPath: `notes/${command}.txt` }),
  };
}

describe("Workspace file structural coordinator adapter", () => {
  test("builds exact delete and move plans from canonical source bytes", () => {
    const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const deleted = buildWorkspaceFileStructuralPlan({
      operationId: "workspace-file:request-delete",
      request: request("delete"),
      source,
      sourceBytes,
    });
    expect(deleted).toMatchObject({
      actor: { kind: "agent", agentId: "agent-1" },
      turnId: "turn-1",
      entries: [{
        kind: "delete",
        before: {
          identity: {
            artifactId: source.id,
            logicalPath: source.path,
          },
          expectedVersion: {
            backendVersion: { kind: "artifact_revision", revision: 7 },
            sha256,
          },
          bytes: sourceBytes,
        },
      }],
    });

    const moved = buildWorkspaceFileStructuralPlan({
      operationId: "workspace-file:request-move",
      request: request("move"),
      source,
      sourceBytes,
    });
    expect(moved).toMatchObject({
      entries: [{
        kind: "move",
        source: {
          identity: {
            artifactId: source.id,
            logicalPath: source.path,
          },
        },
        after: {
          identity: {
            artifactId: source.id,
            logicalPath: "notes/move.txt",
          },
          sha256,
        },
      }],
    });
  });

  test("copies with a deterministic new identity and source CAS precondition", () => {
    const copyRequest = request("copy");
    const first = buildWorkspaceFileStructuralPlan({
      operationId: "workspace-file:request-copy",
      request: copyRequest,
      source,
      sourceBytes,
    });
    const retry = buildWorkspaceFileStructuralPlan({
      operationId: "workspace-file:request-copy",
      request: copyRequest,
      source,
      sourceBytes,
    });
    expect(first).toMatchObject({
      preconditions: [{
        identity: {
          artifactId: source.id,
          logicalPath: source.path,
        },
      }],
      entries: [{
        kind: "create",
        after: {
          identity: { logicalPath: "notes/copy.txt" },
        },
      }],
    });
    const firstId =
      first?.entries[0]?.kind === "create"
        ? first.entries[0].after.identity.artifactId
        : "";
    const retryId =
      retry?.entries[0]?.kind === "create"
        ? retry.entries[0].after.identity.artifactId
        : "";
    expect(firstId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(retryId).toBe(firstId);
    expect(firstId).not.toBe(source.id);
  });

  test("rejects recursive delete, same-path move, and byte-size drift", () => {
    expect(buildWorkspaceFileStructuralPlan({
      operationId: "workspace-file:recursive",
      request: { ...request("delete"), recursive: true },
      source,
      sourceBytes,
    })).toBeNull();
    expect(buildWorkspaceFileStructuralPlan({
      operationId: "workspace-file:same-path",
      request: {
        ...request("move"),
        destinationPath: source.path,
      },
      source,
      sourceBytes,
    })).toBeNull();
    expect(buildWorkspaceFileStructuralPlan({
      operationId: "workspace-file:drift",
      request: request("move"),
      source,
      sourceBytes: new Uint8Array(),
    })).toBeNull();
  });
});
