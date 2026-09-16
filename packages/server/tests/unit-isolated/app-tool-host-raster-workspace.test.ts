/**
 * Isolated because Bun's mock.module replacements are process-global and sticky.
 * This exercises the host-to-canonical-workspace-writer seam with real Sharp
 * rasterization while keeping artifact storage and database state hermetic.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import sharp from "sharp";

const actualAgent = await import("@nautilo/agent");
const actualDb = await import("@nautilo/db");

type CreateBinaryInput = Parameters<typeof actualAgent.createWorkspaceBinaryArtifact>[0];
type CreateBinaryResult = Awaited<ReturnType<typeof actualAgent.createWorkspaceBinaryArtifact>>;
type ResolveArtifactInput = Parameters<typeof actualAgent.resolveWorkspaceArtifact>[0];
type ResolveArtifactResult = Awaited<ReturnType<typeof actualAgent.resolveWorkspaceArtifact>>;

let binaryResult: CreateBinaryResult = {
  ok: true,
  artifactId: "png-external-id",
  artifactInternalId: "png-row-id",
  displayPath: "exports/card.png",
  revision: 1,
  size: 777,
  sha256: "a".repeat(64),
};
const createWorkspaceBinaryArtifactMock = mock(
  async (_input: CreateBinaryInput): Promise<CreateBinaryResult> => binaryResult,
);
const resolveWorkspaceArtifactMock = mock(
  async (input: ResolveArtifactInput): Promise<ResolveArtifactResult> => {
    if (input.intent !== "read" || input.logicalPath !== "designs/card.design.html") {
      return { ok: false, reason: "unexpected artifact resolution" };
    }
    return {
      ok: true,
      artifact: { id: "source-row-id" },
      physicalPath: "/workspace/source",
      artifactId: "source-external-id",
      storageUri: "file:///workspace/source",
      logicalPath: input.logicalPath,
    } as ResolveArtifactResult;
  },
);
const trustTransaction = { kind: "agent-trust-transaction" } as never;
const getArtifactNamespacesMock = mock(async (_artifactId: string, connection?: unknown) => {
  if (connection !== trustTransaction) throw new Error("namespace read escaped the trust transaction");
  return ["ns-other", "ns-shared"];
});
const withAgentTrustContextMock = mock(async (
  _context: { userId: string; agentId?: string },
  operation: (connection: typeof trustTransaction) => Promise<unknown>,
): Promise<unknown> => operation(trustTransaction));

mock.module("@nautilo/agent", () => ({
  ...actualAgent,
  createWorkspaceBinaryArtifact: createWorkspaceBinaryArtifactMock,
  resolveWorkspaceArtifact: resolveWorkspaceArtifactMock,
  withAgentTrustContext: withAgentTrustContextMock,
}));
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getArtifactNamespaces: getArtifactNamespacesMock,
}));

const { createAppToolHost } = await import("../../src/apps/app-tool-host");
const { TEST_MINI_APP_MANIFEST } = await import("../helpers/test-mini-app-manifest");
const { computeAppSourceHash } = await import("../../src/apps/app-registry");

const DESIGN_ROOT = join(import.meta.dir, "..", "..", "..", "first-party-apps", "design");
const DESIGN_SOURCE_HASH = await computeAppSourceHash(DESIGN_ROOT);
const IMAGE_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_BYTES = await sharp({
  create: { width: 3, height: 2, channels: 4, background: "#ef4444" },
}).png().toBuffer();
const IMAGE_SHA = createHash("sha256").update(IMAGE_BYTES).digest("hex");
const IMAGE_REF = `artifact:${IMAGE_ID}:${IMAGE_SHA}`;

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="5" viewBox="0 0 7 5"><rect x="0" y="0" width="7" height="5" fill="#2563eb"/></svg>';

function envelope(): MemoryAccessEnvelope {
  return {
    ownerId: "user-1",
    actorId: "actor-1",
    agentId: "agent-1",
    roomId: "room-1",
    memoryMode: "namespace",
    readableNamespaces: ["ns-default", "ns-source", "ns-shared"],
    mutableNamespaces: ["ns-default", "ns-shared"],
    writableNamespaces: ["ns-default", "ns-shared"],
    toolPolicy: {},
  };
}

function context() {
  return {
    ownerId: "user-1",
    userId: "user-1",
    agentId: "agent-1",
    memoryAccessEnvelope: envelope(),
    workspacePath: "/workspace",
    turnId: "turn-1",
  };
}

function manifest(artifact: "read" | "readwrite") {
  return {
    ...TEST_MINI_APP_MANIFEST,
    capabilities: {
      ...TEST_MINI_APP_MANIFEST.capabilities,
      document: { artifact, currentFolder: "none" as const },
    },
  };
}

function designManifest() {
  return { ...manifest("readwrite"), id: "nautilo-design" };
}

function designAssetOptions() {
  return {
    appId: "nautilo-design",
    appRoot: DESIGN_ROOT,
    appsRoot: join(DESIGN_ROOT, ".."),
    sourceHash: DESIGN_SOURCE_HASH,
    manifest: designManifest(),
    context: context(),
    liveReviewArtifactId: async () => null,
    assetDependencies: {
      findArtifact: async (input: { internalId: string; readableNamespaceIds: string[] }) => {
        expect(input).toEqual({
          internalId: IMAGE_ID,
          readableNamespaceIds: ["ns-default", "ns-source", "ns-shared"],
        });
        return {
          id: IMAGE_ID,
          artifactId: "external-image-id",
          path: "assets/source.png",
          mimeType: "image/png",
          size: IMAGE_BYTES.byteLength,
          storageUri: "file:///workspace/source.png",
          revision: 1,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          deletedAt: null,
        };
      },
      readArtifactBytes: async () => IMAGE_BYTES,
    },
  };
}

beforeEach(() => {
  createWorkspaceBinaryArtifactMock.mockClear();
  resolveWorkspaceArtifactMock.mockClear();
  getArtifactNamespacesMock.mockClear();
  withAgentTrustContextMock.mockClear();
  binaryResult = {
    ok: true,
    artifactId: "png-external-id",
    artifactInternalId: "png-row-id",
    displayPath: "exports/card.png",
    revision: 1,
    size: 777,
    sha256: "a".repeat(64),
  };
});

describe("createRasterFromSvg Workspace authority", () => {
  test("verified Design inspects a known readable raster without returning bytes", async () => {
    const host = createAppToolHost(designAssetOptions());
    expect(await host.assets.inspect({ artifactId: IMAGE_ID })).toEqual({
      ok: true,
      ref: IMAGE_REF,
      name: "source.png",
      width: 3,
      height: 2,
    });
  });

  test("verified Design resolves pinned images for PNG and SVG artifact writes", async () => {
    const host = createAppToolHost(designAssetOptions());
    const image = `<image href="nautilo-asset:${IMAGE_REF}" x="0" y="0" width="6" height="4" preserveAspectRatio="xMidYMid meet"/>`;
    expect(await host.document.createRasterFromSvg({
      surface: "workspace",
      path: "exports/with-image.png",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="4">${image}</svg>`,
      format: "png",
    })).toMatchObject({ ok: true });
    const pngWrite = createWorkspaceBinaryArtifactMock.mock.calls[0]![0];
    expect(pngWrite.mimeType).toBe("image/png");
    expect(await sharp(pngWrite.bytes).metadata()).toMatchObject({ width: 6, height: 4 });

    createWorkspaceBinaryArtifactMock.mockClear();
    expect(await host.document.createDocument({
      surface: "workspace",
      path: "exports/with-image.svg",
      content: `<svg xmlns="http://www.w3.org/2000/svg"><text>Kept text</text>${image}</svg>`,
      mimeType: "image/svg+xml",
    })).toMatchObject({ ok: true });
    const svgWrite = createWorkspaceBinaryArtifactMock.mock.calls[0]![0];
    const writtenSvg = Buffer.from(svgWrite.bytes).toString("utf8");
    expect(svgWrite.mimeType).toBe("image/svg+xml");
    expect(writtenSvg).toContain("Kept text");
    expect(writtenSvg).toContain("data:image/png;base64,");
    expect(writtenSvg).not.toContain("nautilo-asset:");
  });

  test("same app id with a noncanonical source cannot resolve asset references", async () => {
    const host = createAppToolHost({
      ...designAssetOptions(),
      appRoot: "/apps/modified-design",
    });
    expect(await host.assets.inspect({ artifactId: IMAGE_ID })).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await host.document.createRasterFromSvg({
      surface: "workspace",
      path: "exports/blocked.png",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="nautilo-asset:${IMAGE_REF}" x="0" y="0" width="1" height="1" preserveAspectRatio="xMidYMid meet"/></svg>`,
      format: "png",
    })).toMatchObject({ ok: false, code: "FORBIDDEN_ASSET_REFERENCE" });
    expect(createWorkspaceBinaryArtifactMock).not.toHaveBeenCalled();
  });

  test("rasterizes real PNG bytes and colocates them in a writable source namespace", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: manifest("readwrite"),
      context: context(),
      liveReviewArtifactId: async () => null,
    });
    const result = await host.document.createRasterFromSvg({
      surface: "workspace",
      path: "exports/card.png",
      svg: SVG,
      format: "png",
      colocateWith: { surface: "workspace", path: "designs/card.design.html" },
    });

    expect(result).toEqual({
      ok: true,
      artifactPath: "exports/card.png",
      sha256: "a".repeat(64),
      byteLength: 777,
    });
    expect(resolveWorkspaceArtifactMock).toHaveBeenCalledTimes(1);
    expect(withAgentTrustContextMock).toHaveBeenCalledWith(
      { userId: "user-1", agentId: "agent-1" },
      expect.any(Function),
    );
    expect(getArtifactNamespacesMock).toHaveBeenCalledWith("source-row-id", trustTransaction);
    expect(createWorkspaceBinaryArtifactMock).toHaveBeenCalledTimes(1);
    const written = createWorkspaceBinaryArtifactMock.mock.calls[0]![0];
    expect(written.logicalPath).toBe("exports/card.png");
    expect(written.mimeType).toBe("image/png");
    expect(written.namespaceId).toBe("ns-shared");
    expect(written.overwrite).toBe(false);
    expect(written.actor).toEqual({ kind: "agent", agentId: "agent-1" });
    expect([...Buffer.from(written.bytes).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(await sharp(written.bytes).metadata()).toMatchObject({ width: 7, height: 5, format: "png" });
  });

  test("attributes host-issued app creation to the authenticated Human", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: manifest("readwrite"),
      context: {
        ...context(),
        turnId: null,
        appOperationId: "app:test-canvas:11111111-1111-4111-8111-111111111111",
      },
      liveReviewArtifactId: async () => null,
    });

    expect(await host.document.createRasterFromSvg({
      surface: "workspace",
      path: "exports/human-card.png",
      svg: SVG,
      format: "png",
    })).toMatchObject({ ok: true });
    expect(createWorkspaceBinaryArtifactMock.mock.calls[0]![0].actor).toEqual({
      kind: "human",
      userId: "user-1",
    });
  });

  test("suppresses the passive event without failing creation when provenance is absent", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: manifest("readwrite"),
      context: { ...context(), turnId: null, appOperationId: null },
      liveReviewArtifactId: async () => null,
    });

    expect(await host.document.createRasterFromSvg({
      surface: "workspace",
      path: "exports/unattributed-card.png",
      svg: SVG,
      format: "png",
    })).toMatchObject({ ok: true });
    expect(createWorkspaceBinaryArtifactMock.mock.calls[0]![0].actor).toBeNull();
  });

  test("preserves canonical collision and overwrite-conflict results", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: manifest("readwrite"),
      context: context(),
      liveReviewArtifactId: async () => null,
    });
    binaryResult = { ok: false, code: "EXISTS", message: "target exists" };
    expect(await host.document.createRasterFromSvg({
      surface: "workspace",
      path: "exports/card.png",
      svg: SVG,
      format: "png",
    })).toEqual({ ok: false, code: "EXISTS", message: "target exists" });
    expect(createWorkspaceBinaryArtifactMock.mock.calls[0]![0].overwrite).toBe(false);

    createWorkspaceBinaryArtifactMock.mockClear();
    binaryResult = { ok: false, code: "CONFLICT", message: "target changed" };
    expect(await host.document.createRasterFromSvg({
      surface: "workspace",
      path: "exports/card.png",
      svg: SVG,
      format: "png",
      overwrite: true,
    })).toEqual({ ok: false, code: "CONFLICT", message: "target changed" });
    expect(createWorkspaceBinaryArtifactMock.mock.calls[0]![0].overwrite).toBe(true);
  });

  test("returns partial binary-write facts unchanged without retrying persistence", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: manifest("readwrite"),
      context: context(),
      liveReviewArtifactId: async () => null,
    });
    binaryResult = {
      ok: false,
      code: "PARTIAL_WRITE",
      message: "Bytes reached storage but artifact metadata is unconfirmed.",
      displayPath: "exports/card.png",
      bytesWritten: 321,
      metadataConfirmed: false,
      stateChanged: true,
      retrySafe: false,
    };

    const result = await host.document.createRasterFromSvg({
      surface: "workspace",
      path: "exports/card.png",
      svg: SVG,
      format: "png",
    });

    expect(result).toEqual(binaryResult);
    expect(createWorkspaceBinaryArtifactMock).toHaveBeenCalledTimes(1);
  });

  test("preserves partial Workspace SVG write facts for caller reconciliation", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: manifest("readwrite"),
      context: context(),
      liveReviewArtifactId: async () => null,
    });
    binaryResult = {
      ok: false,
      code: "PARTIAL_WRITE",
      message: "SVG bytes reached storage but artifact metadata is unconfirmed.",
      displayPath: "exports/card.svg",
      bytesWritten: 654,
      metadataConfirmed: false,
      stateChanged: true,
      retrySafe: false,
    };

    const result = await host.document.createDocument({
      surface: "workspace",
      path: "exports/card.svg",
      content: SVG,
      mimeType: "image/svg+xml",
    });

    expect(result).toEqual(binaryResult);
    expect(createWorkspaceBinaryArtifactMock).toHaveBeenCalledTimes(1);
  });

  test("rejects missing artifact write authority before rasterization or persistence", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: manifest("read"),
      context: context(),
      liveReviewArtifactId: async () => null,
    });
    let rejection: unknown;
    try {
      await host.document.createRasterFromSvg({
        surface: "workspace",
        path: "exports/card.png",
        svg: "not svg",
        format: "png",
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/workspace artifact write/i);
    expect(resolveWorkspaceArtifactMock).not.toHaveBeenCalled();
    expect(createWorkspaceBinaryArtifactMock).not.toHaveBeenCalled();
  });
});
