import { describe, expect, mock, test } from "bun:test";
import type { Artifact } from "@nautilo/db";
import type {
  ArtifactResolution,
  EnvelopeFacts,
  WorkspaceArtifactPatchMeta,
} from "../../src/tools/file/artifact-store";
import {
  preflightGeneratedImagePublication,
  publishGeneratedImages,
  type GeneratedImagePublicationDeps,
} from "../../src/tools/media/generated-image-publication";

const facts: EnvelopeFacts = {
  userId: "10000000-0000-4000-8000-000000000001",
  agentId: "20000000-0000-4000-8000-000000000002",
  readableNamespaces: ["ns-write"],
  mutableNamespaces: ["ns-write"],
  writableNamespaces: ["ns-write"],
};

function minted(logicalPath: string, suffix: string): Extract<ArtifactResolution, { ok: true }> {
  return {
    ok: true,
    artifact: null,
    physicalPath: `/retained/${suffix}`,
    artifactId: `artifact-${suffix}`,
    storageUri: `file:///retained/${suffix}`,
    logicalPath,
  };
}

function artifactFor(
  meta: WorkspaceArtifactPatchMeta,
  size: number,
): Artifact {
  return {
    id: `row-${meta.artifactId}`,
    artifactId: meta.artifactId,
    revision: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    path: meta.logicalPath,
    mimeType: meta.mimeType ?? "application/octet-stream",
    size,
    storageUri: meta.storageUri,
  };
}

describe("generated image publication", () => {
  test("recognizes the exact committed row after acknowledgement loss", async () => {
    const committed = new Map<string, Artifact>();
    const mintedByPath = new Map<string, Extract<ArtifactResolution, { ok: true }>>();
    const resolve = mock(async (input: {
      logicalPath: string;
      intent: "read" | "mutate" | "create" | "create_or_update";
    }): Promise<ArtifactResolution> => {
      const existing = committed.get(input.logicalPath);
      if (input.intent === "read") {
        return existing
          ? {
              ok: true,
              artifact: existing,
              physicalPath: existing.storageUri.slice("file://".length),
              artifactId: existing.artifactId,
              storageUri: existing.storageUri,
              logicalPath: input.logicalPath,
            }
          : { ok: false, reason: "absent" };
      }
      if (existing) return { ok: false, reason: "already exists" };
      const target = mintedByPath.get(input.logicalPath)
        ?? minted(input.logicalPath, String(mintedByPath.size + 1));
      mintedByPath.set(input.logicalPath, target);
      return target;
    });
    const apply = mock(async (meta: WorkspaceArtifactPatchMeta, size: number) => {
      committed.set(meta.logicalPath, artifactFor(meta, size));
      throw new Error("commit acknowledgement lost");
    });
    const writes: Array<{ path: string; bytes: Buffer }> = [];
    const deps: GeneratedImagePublicationDeps = {
      resolveWorkspaceArtifact: resolve as never,
      applyWorkspaceArtifactRowChange: apply as never,
      writeBytes: async (path, bytes) => { writes.push({ path, bytes }); },
      prepareStorage: async () => {},
    };
    const plan = await preflightGeneratedImagePublication({
      baseStem: "paid-result",
      subdirRel: "generated-images/2026-10-09",
      requestedCount: 1,
      requestedMime: "image/png",
      requestedExtension: "png",
      facts,
      deps,
    });

    const result = await publishGeneratedImages({
      plan,
      bytes: [Buffer.from("image-one")],
      mime: "image/png",
      extension: "png",
      facts,
      targetNamespaceId: "ns-write",
      deps,
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    expect(result.publication).toEqual({
      status: "complete",
      publishedCount: 1,
      pendingCount: 0,
    });
    expect(result.images).toHaveLength(1);
    expect(result.pendingPublications).toEqual([]);
  });

  test("keeps the first image accessible and retains an unregistered second image", async () => {
    const committed = new Map<string, Artifact>();
    const mintedByPath = new Map<string, Extract<ArtifactResolution, { ok: true }>>();
    const attemptsByPath = new Map<string, number>();
    const resolve = mock(async (input: {
      logicalPath: string;
      intent: "read" | "mutate" | "create" | "create_or_update";
    }): Promise<ArtifactResolution> => {
      const existing = committed.get(input.logicalPath);
      if (input.intent === "read") {
        return existing
          ? {
              ok: true,
              artifact: existing,
              physicalPath: existing.storageUri.slice("file://".length),
              artifactId: existing.artifactId,
              storageUri: existing.storageUri,
              logicalPath: input.logicalPath,
            }
          : { ok: false, reason: "absent" };
      }
      if (existing) return { ok: false, reason: "already exists" };
      const target = mintedByPath.get(input.logicalPath)
        ?? minted(input.logicalPath, String(mintedByPath.size + 1));
      mintedByPath.set(input.logicalPath, target);
      return target;
    });
    const apply = mock(async (meta: WorkspaceArtifactPatchMeta, size: number) => {
      const attempts = (attemptsByPath.get(meta.logicalPath) ?? 0) + 1;
      attemptsByPath.set(meta.logicalPath, attempts);
      if (meta.logicalPath.endsWith("-02.png")) {
        throw new Error(`index unavailable ${attempts}`);
      }
      committed.set(meta.logicalPath, artifactFor(meta, size));
      return {
        internalId: `row-${meta.artifactId}`,
        artifactId: meta.artifactId,
        path: meta.logicalPath,
        revision: 1,
        previousRevision: null,
      };
    });
    const writes: Array<{ path: string; bytes: Buffer }> = [];
    const deps: GeneratedImagePublicationDeps = {
      resolveWorkspaceArtifact: resolve as never,
      applyWorkspaceArtifactRowChange: apply as never,
      writeBytes: async (path, bytes) => { writes.push({ path, bytes }); },
      prepareStorage: async () => {},
    };
    const plan = await preflightGeneratedImagePublication({
      baseStem: "paid-result",
      subdirRel: "generated-images/2026-10-09",
      requestedCount: 2,
      requestedMime: "image/png",
      requestedExtension: "png",
      facts,
      deps,
    });

    const result = await publishGeneratedImages({
      plan,
      bytes: [Buffer.from("image-one"), Buffer.from("image-two")],
      mime: "image/png",
      extension: "png",
      facts,
      targetNamespaceId: "ns-write",
      deps,
    });

    expect(attemptsByPath.get("generated-images/2026-10-09/paid-result-01.png"))
      .toBe(1);
    expect(attemptsByPath.get("generated-images/2026-10-09/paid-result-02.png"))
      .toBe(2);
    expect(writes).toHaveLength(2);
    expect(result.images).toEqual([expect.objectContaining({
      path: "generated-images/2026-10-09/paid-result-01.png",
      artifactId: "artifact-1",
    })]);
    expect(result.pendingPublications).toEqual([{
      path: "generated-images/2026-10-09/paid-result-02.png",
      mime: "image/png",
      bytes: Buffer.byteLength("image-two"),
      retained: true,
      recoveryRef: "2",
    }]);
    expect(result.pendingPublications[0]).not.toHaveProperty("artifactId");
    expect(result.publication.status).toBe("partial");
    expect(result.publication.recovery).toContain("Do not regenerate");
    expect(result.publication.recovery).toContain("bill the user again");
  });
});
