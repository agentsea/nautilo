/**
 * Isolated because Bun's mock.module replacements are process-global and sticky.
 * Exercises the real app host's base64 document-create path while keeping the
 * canonical workspace writer and artifact namespace lookup hermetic.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import type { MiniAppManifest } from "../../src/apps/app-manifest";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

const actualAgent = await import("@nautilo/agent");
const actualDb = await import("@nautilo/db");

type CreateInput = Parameters<typeof actualAgent.createWorkspaceBinaryArtifact>[0];
type CreateResult = Awaited<ReturnType<typeof actualAgent.createWorkspaceBinaryArtifact>>;
type ResolveInput = Parameters<typeof actualAgent.resolveWorkspaceArtifact>[0];
type ResolveResult = Awaited<ReturnType<typeof actualAgent.resolveWorkspaceArtifact>>;

let createResult: CreateResult;
let resolution: ResolveResult;
let namespaceResult: string[];
let namespaceError: Error | null;
const trustTransaction = { kind: "agent-trust-transaction" } as never;

const createWorkspaceBinaryArtifact = mock(async (_input: CreateInput): Promise<CreateResult> => createResult);
const resolveWorkspaceArtifact = mock(async (_input: ResolveInput): Promise<ResolveResult> => resolution);
const getArtifactNamespaces = mock(async (_artifactId: string, connection?: unknown): Promise<string[]> => {
  if (connection !== trustTransaction) throw new Error("namespace read escaped the trust transaction");
  if (namespaceError) throw namespaceError;
  return namespaceResult;
});
const withAgentTrustContext = mock(async (
  _context: { userId: string; agentId?: string },
  operation: (connection: typeof trustTransaction) => Promise<unknown>,
): Promise<unknown> => operation(trustTransaction));

mock.module("@nautilo/agent", () => ({
  ...actualAgent,
  createWorkspaceBinaryArtifact,
  resolveWorkspaceArtifact,
  withAgentTrustContext,
}));
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getArtifactNamespaces,
}));

const { createAppToolHost } = await import("../../src/apps/app-tool-host");
const { TEST_MINI_APP_MANIFEST } = await import("../helpers/test-mini-app-manifest");

const BYTES = Buffer.from([0, 255, 1, 128, 65]);
const CONTENT = BYTES.toString("base64");

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

function host() {
  return createAppToolHost({
    appId: "test-canvas",
    appsRoot: "/apps",
    manifest: {
      ...TEST_MINI_APP_MANIFEST,
      capabilities: {
        ...TEST_MINI_APP_MANIFEST.capabilities,
        document: { artifact: "readwrite" as const, currentFolder: "none" as const },
      },
    },
    context: {
      ownerId: "user-1",
      userId: "user-1",
      agentId: "agent-1",
      memoryAccessEnvelope: envelope(),
      workspacePath: "/workspace",
      turnId: "turn-1",
    },
    liveReviewArtifactId: async () => null,
  });
}

function createArgs() {
  return {
    surface: "workspace" as const,
    path: "exports/raw.bin",
    content: CONTENT,
    encoding: "base64" as const,
    mimeType: "application/octet-stream",
    colocateWith: { surface: "workspace" as const, path: "sources/input.bin" },
  };
}

beforeEach(() => {
  createWorkspaceBinaryArtifact.mockClear();
  resolveWorkspaceArtifact.mockClear();
  getArtifactNamespaces.mockClear();
  withAgentTrustContext.mockClear();
  createResult = {
    ok: true,
    artifactId: "created-external-id",
    artifactInternalId: "created-row-id",
    displayPath: "exports/raw.bin",
    revision: 4,
    size: BYTES.byteLength,
    sha256: "a".repeat(64),
  };
  resolution = {
    ok: true,
    artifact: { id: "source-row-id" },
    physicalPath: "/workspace/source",
    artifactId: "source-external-id",
    storageUri: "file:///workspace/source",
    logicalPath: "sources/input.bin",
  } as ResolveResult;
  namespaceResult = ["ns-source", "ns-shared"];
  namespaceError = null;
});

describe("app host binary document creation", () => {
  test("decodes exact bytes and preserves MIME, overwrite, and shared namespace", async () => {
    const result = await host().document.createDocument({ ...createArgs(), overwrite: true });

    expect(result).toEqual({
      ok: true,
      artifactPath: "exports/raw.bin",
      artifactInternalId: "created-row-id",
      artifactId: "created-external-id",
      sha256: "a".repeat(64),
      byteLength: BYTES.byteLength,
    });
    expect(resolveWorkspaceArtifact).toHaveBeenCalledWith(expect.objectContaining({
      logicalPath: "sources/input.bin",
      intent: "read",
    }));
    expect(withAgentTrustContext).toHaveBeenCalledWith(
      { userId: "user-1", agentId: "agent-1" },
      expect.any(Function),
    );
    expect(getArtifactNamespaces).toHaveBeenCalledWith("source-row-id", trustTransaction);
    expect(createWorkspaceBinaryArtifact).toHaveBeenCalledTimes(1);
    const write = createWorkspaceBinaryArtifact.mock.calls[0]![0];
    expect(Buffer.from(write.bytes)).toEqual(BYTES);
    expect(write).toMatchObject({
      logicalPath: "exports/raw.bin",
      mimeType: "application/octet-stream",
      namespaceId: "ns-shared",
      overwrite: true,
    });
  });

  test.each([
    ["collision", { ok: false, code: "EXISTS", message: "target exists" }],
    ["partial write", {
      ok: false,
      code: "PARTIAL_WRITE",
      message: "Bytes changed but metadata is unconfirmed.",
      displayPath: "exports/raw.bin",
      bytesWritten: BYTES.byteLength,
      metadataConfirmed: false,
      stateChanged: true,
      retrySafe: false,
    }],
  ] as const)("passes through canonical %s results", async (_label, failure) => {
    createResult = failure as CreateResult;

    expect(await host().document.createDocument(createArgs())).toEqual(failure);
    expect(createWorkspaceBinaryArtifact).toHaveBeenCalledTimes(1);
  });

  test("does not write when the colocation source is missing", async () => {
    resolution = { ok: true, artifact: null } as ResolveResult;

    expect(await host().document.createDocument(createArgs())).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "The source document is no longer available for colocation.",
    });
    expect(getArtifactNamespaces).not.toHaveBeenCalled();
    expect(createWorkspaceBinaryArtifact).not.toHaveBeenCalled();
  });

  test("does not fall back to a default namespace when none is shared and writable", async () => {
    namespaceResult = ["ns-source"];

    expect(await host().document.createDocument(createArgs())).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "No writable namespace is shared with the source document.",
    });
    expect(createWorkspaceBinaryArtifact).not.toHaveBeenCalled();
  });

  test("does not fall back to the writer when namespace lookup throws", async () => {
    namespaceError = new Error("database unavailable");

    expect(await host().document.createDocument(createArgs())).toEqual({
      ok: false,
      code: "COLOCATION_FAILED",
      message: "Could not confirm the source document namespace.",
    });
    expect(createWorkspaceBinaryArtifact).not.toHaveBeenCalled();
  });
});


test("Slides template creation uses exclusive Workspace bytes and the exact openable artifact identity", async () => {
  const appsRoot = resolve(import.meta.dir, "../../../first-party-apps");
  const manifest = await Bun.file(resolve(appsRoot, "presentation/app.json")).json() as MiniAppManifest;
  const appHost = createAppToolHost({ appId: manifest.id, appsRoot, manifest,
    context: { ownerId: "user-1", userId: "user-1", agentId: "agent-1",
      memoryAccessEnvelope: envelope(), turnId: "turn-1" },
    liveReviewArtifactId: async () => null });
  const result = await appHost.document.createFromAction("new-presentation", {
    targetSurface: "workspace", filename: "Deck.presentation.html", openAfterCreate: false,
  });
  expect(createWorkspaceBinaryArtifact).toHaveBeenCalledTimes(1);
  expect(createWorkspaceBinaryArtifact.mock.calls[0]![0]).toMatchObject({
    logicalPath: "Deck.presentation.html", overwrite: false, mimeType: "text/html",
  });
  expect(result).toMatchObject({ opened: false, openInApp: { appId: "nautilo-presentation", appName: "Slides",
    target: { surface: "workspace", artifactInternalId: "created-row-id", path: "exports/raw.bin",
      mimeType: "text/html", roomId: "room-1" } } });
  createResult = { ok: false, code: "EXISTS", message: "Already exists" };
  let failure: unknown;
  try { await appHost.document.createFromAction("new-presentation", {
    targetSurface: "workspace", filename: "Deck.presentation.html",
  }); } catch (error) { failure = JSON.parse((error as Error).message); }
  expect(failure).toMatchObject({ ok: false, code: "destination_exists", stateChanged: false, retrySafe: false });
});
