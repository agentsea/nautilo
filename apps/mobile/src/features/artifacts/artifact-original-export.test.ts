import { describe, expect, test } from "bun:test";
import {
  acquireArtifactOriginal,
  nativeExportMimeType,
  safeArtifactBasename,
  type ArtifactOriginalExportDependencies,
  type ArtifactOriginalMetadata,
  type ArtifactOriginalExportScope,
} from "./artifact-original-export";

test("native destination MIME hints accept parameters without changing the original", () => {
  expect(nativeExportMimeType(" Text/Plain ; charset=utf-8")).toBe("text/plain");
  expect(nativeExportMimeType("application/vnd.example+zip")).toBe("application/vnd.example+zip");
  expect(nativeExportMimeType("invalid value")).toBe("application/octet-stream");
  expect(nativeExportMimeType("")).toBe("application/octet-stream");
});

const scope: ArtifactOriginalExportScope = {
  serverId: "server-a",
  accountId: "human-a",
  sourceKind: "artifact",
  sourceId: "row-a",
  generation: 7,
};

const artifact: ArtifactOriginalMetadata = {
  id: "row-a",
  artifactId: "stable-a",
  path: "reports/source.bin",
  mimeType: "application/octet-stream",
  size: 17,
  revision: 4,
  canWrite: false,
};

function fixture(overrides: Partial<ArtifactOriginalExportDependencies> = {}) {
  let currentScope: ArtifactOriginalExportScope | null = scope;
  let cleanups = 0;
  let metadataCalls = 0;
  const dependencies: ArtifactOriginalExportDependencies = {
    getCurrentScope: () => currentScope,
    loadMetadata: async () => {
      metadataCalls += 1;
      return { kind: "metadata", metadata: artifact };
    },
    acquireFile: async () => ({
      kind: "file",
      fileUri: "file:///owned/source.bin",
      cleanup: () => { cleanups += 1; },
    }),
    ...overrides,
  };
  return {
    dependencies,
    setCurrentScope: (next: ArtifactOriginalExportScope | null) => { currentScope = next; },
    cleanups: () => cleanups,
    metadataCalls: () => metadataCalls,
  };
}

describe("acquireArtifactOriginal", () => {
  test("acquires an unsupported read-only original without preview classification", async () => {
    const f = fixture();
    const result = await acquireArtifactOriginal(scope, f.dependencies);

    expect(result).toMatchObject({
      kind: "ready",
      fileUri: "file:///owned/source.bin",
      filename: "source.bin",
      mimeType: "application/octet-stream",
      size: 17,
      revision: 4,
      consistency: "metadata_rechecked_not_immutable",
      artifact: { canWrite: false },
    });
    expect(f.metadataCalls()).toBe(2);
    expect(f.cleanups()).toBe(0);
  });

  test.each([
    ["forbidden", "forbidden"],
    ["missing", "missing"],
    ["auth_dead", "auth_dead"],
  ] as const)("returns %s metadata denial without acquiring bytes", async (kind, reason) => {
    let acquired = false;
    const f = fixture({
      loadMetadata: async () => ({ kind }),
      acquireFile: async () => {
        acquired = true;
        throw new Error("must not acquire");
      },
    });
    expect(await acquireArtifactOriginal(scope, f.dependencies)).toEqual({ kind: "failed", reason });
    expect(acquired).toBe(false);
  });

  test("cancellation after acquisition cleans the owned file and cannot succeed", async () => {
    const controller = new AbortController();
    let cleaned = 0;
    const f = fixture({
      acquireFile: async () => {
        controller.abort();
        return { kind: "file", fileUri: "file:///owned/source.bin", cleanup: () => { cleaned += 1; } };
      },
    });
    expect(await acquireArtifactOriginal(scope, f.dependencies, controller.signal)).toEqual({ kind: "failed", reason: "cancelled" });
    expect(cleaned).toBe(1);
  });

  test("identity or generation change after acquisition cleans the owned file", async () => {
    let current: ArtifactOriginalExportScope | null = scope;
    let cleaned = 0;
    const f = fixture({
      getCurrentScope: () => current,
      acquireFile: async () => {
        current = { ...scope, accountId: "human-b", generation: 8 };
        return { kind: "file", fileUri: "file:///owned/source.bin", cleanup: () => { cleaned += 1; } };
      },
    });
    expect(await acquireArtifactOriginal(scope, f.dependencies)).toEqual({ kind: "failed", reason: "source_changed" });
    expect(cleaned).toBe(1);
  });

  test("metadata change during an unconditioned byte read cleans instead of claiming success", async () => {
    let call = 0;
    let cleaned = 0;
    const f = fixture({
      loadMetadata: async () => ({
        kind: "metadata",
        metadata: call++ === 0 ? artifact : { ...artifact, revision: 5, size: 19 },
      }),
      acquireFile: async () => ({
        kind: "file",
        fileUri: "file:///owned/source.bin",
        cleanup: () => { cleaned += 1; },
      }),
    });
    expect(await acquireArtifactOriginal(scope, f.dependencies)).toEqual({ kind: "failed", reason: "source_changed" });
    expect(cleaned).toBe(1);
  });

  test("a denied metadata recheck cleans the acquired file and returns no fake success", async () => {
    let call = 0;
    let cleaned = 0;
    const f = fixture({
      loadMetadata: async () => call++ === 0 ? { kind: "metadata", metadata: artifact } : { kind: "forbidden" },
      acquireFile: async () => ({ kind: "file", fileUri: "file:///owned/source.bin", cleanup: () => { cleaned += 1; } }),
    });
    expect(await acquireArtifactOriginal(scope, f.dependencies)).toEqual({ kind: "failed", reason: "forbidden" });
    expect(cleaned).toBe(1);
  });

  test("rejects an empty acquired URI and cleans it", async () => {
    let cleaned = 0;
    const f = fixture({
      acquireFile: async () => ({ kind: "file", fileUri: " ", cleanup: () => { cleaned += 1; } }),
    });
    expect(await acquireArtifactOriginal(scope, f.dependencies)).toEqual({ kind: "failed", reason: "invalid_file" });
    expect(cleaned).toBe(1);
  });

  test("reports residual cleanup failure after cancellation instead of claiming cancellation completed", async () => {
    const controller = new AbortController();
    const f = fixture({
      acquireFile: async () => {
        controller.abort();
        return { kind: "file", fileUri: "file:///owned/source.bin", cleanup: () => { throw new Error("synthetic cleanup failure"); } };
      },
    });
    expect(await acquireArtifactOriginal(scope, f.dependencies, controller.signal))
      .toEqual({ kind: "failed", reason: "cleanup_failed" });
  });

  test("reports residual cleanup failure after an identity change", async () => {
    let current: ArtifactOriginalExportScope | null = scope;
    const f = fixture({
      getCurrentScope: () => current,
      acquireFile: async () => {
        current = { ...scope, generation: scope.generation + 1 };
        return { kind: "file", fileUri: "file:///owned/source.bin", cleanup: () => { throw new Error("synthetic cleanup failure"); } };
      },
    });
    expect(await acquireArtifactOriginal(scope, f.dependencies))
      .toEqual({ kind: "failed", reason: "cleanup_failed" });
  });

  test("reports residual cleanup failure after a denied metadata recheck", async () => {
    let call = 0;
    const f = fixture({
      loadMetadata: async () => call++ === 0 ? { kind: "metadata", metadata: artifact } : { kind: "forbidden" },
      acquireFile: async () => ({
        kind: "file", fileUri: "file:///owned/source.bin", cleanup: () => { throw new Error("synthetic cleanup failure"); },
      }),
    });
    expect(await acquireArtifactOriginal(scope, f.dependencies))
      .toEqual({ kind: "failed", reason: "cleanup_failed" });
  });
});

describe("safeArtifactBasename", () => {
  test("removes traversal and control characters while preserving the suffix", () => {
    expect(safeArtifactBasename("../../private/repo\u0000rt.final.PDF")).toBe("repo_rt.final.PDF");
    expect(safeArtifactBasename("folder\\nested\\movie.mp4")).toBe("movie.mp4");
  });

  test("never returns dot traversal or an empty filename", () => {
    expect(safeArtifactBasename("../.. ")).toBe("file");
    expect(safeArtifactBasename("folder/\u0000\u0007")).toBe("__");
    expect(safeArtifactBasename("folder/")).toBe("folder");
  });
});
