import { describe, expect, test } from "bun:test";
import {
  canonicalArtifactListProjectionForHash,
  workspaceArtifactListWeakETagFromProjection,
} from "../../src/lib/workspace-artifacts-conditional-http";
import {
  bumpWorkspaceArtifactListGenerationForNamespaces,
  clearWorkspaceArtifactListGenerationForTests,
  type ArtifactListReadScope,
} from "../../src/lib/workspace-artifact-list-generation";

function sampleScope(overrides: Partial<ArtifactListReadScope> = {}): ArtifactListReadScope {
  return {
    readableNamespaceIds: ["ns-a"],
    viewerActorId: "actor-1",
    agentId: "agent-1",
    roomId: "room-1",
    limit: 500,
    ...overrides,
  };
}

function sampleArtifact(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    artifactId: "artifact-1",
    path: "notes/a.md",
    mimeType: "text/markdown",
    size: 12,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    namespaceIds: ["ns-a"],
    canWrite: true,
    ...overrides,
  };
}

describe("workspaceArtifactListWeakETagFromProjection (M213 Phase 8/11)", () => {
  test("ETag is opaque weak W/\"base64url\" with no plain ids/paths/tokens", () => {
    const etag = workspaceArtifactListWeakETagFromProjection(sampleScope(), {
      artifacts: [sampleArtifact()],
    });
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(etag).not.toContain("row-1");
    expect(etag).not.toContain("artifact-1");
    expect(etag).not.toContain("notes/a.md");
    expect(etag).not.toContain("ns-a");
    expect(etag).not.toContain("agent-1");
  });

  test("stable across permuted list order (hash-only sort)", () => {
    const a = { artifacts: [sampleArtifact({ id: "row-z" }), sampleArtifact({ id: "row-a" })] };
    const b = { artifacts: [sampleArtifact({ id: "row-a" }), sampleArtifact({ id: "row-z" })] };
    expect(workspaceArtifactListWeakETagFromProjection(sampleScope(), a)).toBe(
      workspaceArtifactListWeakETagFromProjection(sampleScope(), b),
    );
    expect(a.artifacts[0]?.id).toBe("row-z");
    expect(b.artifacts[0]?.id).toBe("row-a");
  });

  test("changes when namespace generation changes", () => {
    clearWorkspaceArtifactListGenerationForTests();
    const body = { artifacts: [sampleArtifact()] };
    const before = workspaceArtifactListWeakETagFromProjection(sampleScope(), body);
    bumpWorkspaceArtifactListGenerationForNamespaces(["ns-a"]);
    const after = workspaceArtifactListWeakETagFromProjection(sampleScope(), body);
    expect(after).not.toBe(before);
  });

  test("changes when authorized projection changes", () => {
    const base = { artifacts: [sampleArtifact()] };
    const baseEtag = workspaceArtifactListWeakETagFromProjection(sampleScope(), base);
    expect(
      workspaceArtifactListWeakETagFromProjection(sampleScope(), {
        artifacts: [sampleArtifact({ revision: 2 })],
      }),
    ).not.toBe(baseEtag);
  });

  test("changes when mutable-namespace write eligibility changes", () => {
    const base = workspaceArtifactListWeakETagFromProjection(sampleScope(), { artifacts: [sampleArtifact({ canWrite: true })] });
    const readOnly = workspaceArtifactListWeakETagFromProjection(sampleScope(), { artifacts: [sampleArtifact({ canWrite: false })] });
    expect(readOnly).not.toBe(base);
  });

  test("does not share ETag across viewer/room/query scope", () => {
    const body = { artifacts: [sampleArtifact()] };
    const base = workspaceArtifactListWeakETagFromProjection(sampleScope(), body);
    expect(
      workspaceArtifactListWeakETagFromProjection(
        sampleScope({ readableNamespaceIds: ["ns-b"] }),
        body,
      ),
    ).not.toBe(base);
    expect(
      workspaceArtifactListWeakETagFromProjection(sampleScope({ roomId: "room-2" }), body),
    ).not.toBe(base);
    expect(
      workspaceArtifactListWeakETagFromProjection(sampleScope({ pathPrefix: "notes/" }), body),
    ).not.toBe(base);
    expect(
      workspaceArtifactListWeakETagFromProjection(sampleScope({ limit: 100 }), body),
    ).not.toBe(base);
    expect(
      workspaceArtifactListWeakETagFromProjection(sampleScope({ agentId: "agent-2" }), body),
    ).not.toBe(base);
    expect(
      workspaceArtifactListWeakETagFromProjection(sampleScope({ viewerActorId: "actor-2" }), body),
    ).not.toBe(base);
  });

  test("canonicalArtifactListProjectionForHash does not mutate the live body", () => {
    const body = {
      artifacts: [
        sampleArtifact({ id: "row-z", namespaceIds: ["ns-b", "ns-a"] }),
        sampleArtifact({ id: "row-a", namespaceIds: ["ns-a"] }),
      ],
    };
    const idsBefore = body.artifacts.map((artifact) => artifact.id);
    canonicalArtifactListProjectionForHash(body);
    expect(body.artifacts.map((artifact) => artifact.id)).toEqual(idsBefore);
  });
});
