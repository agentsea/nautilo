import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { setRelayRegistry, sha256Hex } from "@nautilo/agent";
import { RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { MiniAppManifest } from "../../src/apps/app-manifest";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";
import {
  createAppToolHost,
  createProductionDocumentOperations,
  getArtifactNamespacesInTrustContext,
  handleHostRpc,
  HostOperationError,
  type AppDocumentOperations,
} from "../../src/apps/app-tool-host";
import { liveMiniAppSessionRegistry } from "../../src/apps/live-mini-app-session-registry";
import { liveAppCommandBroker } from "../../src/apps/live-app-command-broker";
import type {
  AppDocumentTarget,
  AppToolRunnerContext,
} from "../../src/apps/app-tool-types";
import { writerLiveReviewExtension as registeredLiveReviewExtension } from "@nautilo/writer-proposal-core";

function readOnlyManifest(): MiniAppManifest {
  return {
    ...TEST_MINI_APP_MANIFEST,
    capabilities: {
      document: { artifact: "read", currentFolder: "none" },
      state: "read",
    },
    createActions: TEST_MINI_APP_MANIFEST.createActions,
  };
}

function noCapsManifest(): MiniAppManifest {
  return {
    ...TEST_MINI_APP_MANIFEST,
    capabilities: {
      document: { artifact: "none", currentFolder: "none" },
      state: "none",
    },
  };
}

function writableManifest(): MiniAppManifest {
  return {
    ...TEST_MINI_APP_MANIFEST,
    capabilities: {
      document: { artifact: "readwrite", currentFolder: "readwrite" },
      state: "read",
    },
  };
}

const SIMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="5" viewBox="0 0 7 5"><rect x="0" y="0" width="7" height="5" fill="#2563eb"/></svg>';

function envelope(): MemoryAccessEnvelope {
  return {
    ownerId: "user-1",
    agentId: "agent-1",
    memoryMode: "namespace",
    readableNamespaceIds: ["ns-1"],
    mutableNamespaceIds: ["ns-1"],
    writableNamespaceIds: ["ns-1"],
  } as unknown as MemoryAccessEnvelope;
}

function context(): AppToolRunnerContext {
  return {
    ownerId: "user-1",
    userId: "user-1",
    agentId: "agent-1",
    memoryAccessEnvelope: envelope(),
    currentFolder: "/tmp/project",
    workspacePath: "/tmp/workspace",
    turnId: "turn-1",
  };
}

const workspaceTarget: AppDocumentTarget = { surface: "workspace", path: "notes.html" };
const folderTarget: AppDocumentTarget = { surface: "currentFolder", relativePath: "notes.html" };

async function expectHostOperationError(
  promise: Promise<unknown>,
  expected?: RegExp | typeof HostOperationError,
): Promise<HostOperationError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HostOperationError);
  if (expected instanceof RegExp) {
    expect(thrown instanceof Error ? thrown.message : "").toMatch(expected);
  }
  return thrown as HostOperationError;
}

function mockDocumentOps(): AppDocumentOperations {
  return {
    createFromAction: async () => ({
      target: workspaceTarget,
      displayPath: "notes.html",
      opened: false,
    }),
    read: async (target) => ({
      content: target.surface === "workspace" ? target.path : target.relativePath,
      mimeType: "text/plain",
      displayPath: target.surface === "workspace" ? target.path : target.relativePath,
      baseSha256: "abc",
      baseRevision: 1,
    }),
    stat: async () => ({
      exists: true,
      size: 3,
      mimeType: "text/plain",
      baseSha256: "abc",
      baseRevision: 1,
    }),
    write: async () => ({ kind: "saved", sha256: "def" }),
    getState: async () => ({ ok: true }),
    setState: async () => undefined,
  };
}

test("artifact namespace reads use the exact caller trust context and transaction handle", async () => {
  const protectedConnection = { protected: true } as never;
  const seen: unknown[] = [];
  const protectedReader = async (artifactId: string, connection: unknown): Promise<string[]> => {
    seen.push({ artifactId, connection });
    if (connection !== protectedConnection) throw new Error("protected read requires transaction");
    return ["namespace-1"];
  };
  const namespaces = await getArtifactNamespacesInTrustContext(
    "artifact-row-1",
    { userId: "user-1", agentId: "agent-1" },
    protectedReader as unknown as Parameters<typeof getArtifactNamespacesInTrustContext>[2],
    async (context, read) => {
      expect(context).toEqual({ userId: "user-1", agentId: "agent-1" });
      return read(protectedConnection);
    },
  );

  expect(namespaces).toEqual(["namespace-1"]);
  expect(seen).toEqual([{ artifactId: "artifact-row-1", connection: protectedConnection }]);
});

function liveReviewManifest(): MiniAppManifest {
  return {
    ...TEST_MINI_APP_MANIFEST,
    id: registeredLiveReviewExtension.appId,
    capabilities: {
      document: { artifact: "readwrite", currentFolder: "none" },
      state: "read",
    },
    liveReview: { enabled: true },
  };
}

function issueLiveReviewSession(userId = "user-1"): { token: string } {
  return liveMiniAppSessionRegistry.issue({
    targetKind: "artifact",
    appId: registeredLiveReviewExtension.appId,
    userId,
    namespaceIds: ["ns-1"],
    artifactId: "artifact-1",
    documentId: "document-1",
    documentVersion: { kind: "artifact_revision", revision: 1 },
  });
}

describe("production workspace write revision fence", () => {
  function operationsAt(revision: number, readWorkspaceFile: (path: string) => Promise<Buffer>) {
    return createProductionDocumentOperations({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: TEST_MINI_APP_MANIFEST,
      context: context(),
      resolveWorkspaceArtifactFn: (async () => ({
        ok: true,
        artifact: {
          id: "artifact-1",
          path: "notes.html",
          revision,
          mimeType: "text/html",
        },
        physicalPath: "/must-not-touch/workspace-artifact.html",
      })) as never,
      readWorkspaceFile,
    });
  }

  test("refuses a human save between the bound check and downstream resolution before reading or planning", async () => {
    let reads = 0;
    const operations = operationsAt(8, async () => {
      reads += 1;
      throw new Error("raced content must not be adopted");
    });

    const result = await operations.write(
      workspaceTarget,
      { content: "stale agent result from revision 7" },
      { baseRevision: 7 },
    );
    expect(result).toEqual({ kind: "conflict", currentSha256: null });
    expect(reads).toBe(0);
  });

  test("preserves matching and omitted revision callers through the production no-op plan", async () => {
    const content = "unchanged content";
    const matching = operationsAt(7, async () => Buffer.from(content));
    expect(await matching.write(workspaceTarget, { content }, { baseRevision: 7 })).toMatchObject({
      kind: "saved",
      revision: 7,
    });

    const omitted = operationsAt(8, async () => Buffer.from(content));
    expect(await omitted.write(workspaceTarget, { content })).toMatchObject({
      kind: "saved",
      revision: 8,
    });
  });

  test("reads invalid UTF-8 workspace bytes exactly as base64 without inventing a text mutation base", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x61, 0x80]);
    let reads = 0;
    const operations = operationsAt(7, async () => { reads += 1; return bytes; });

    const binary = await operations.read(workspaceTarget, { encoding: "base64" });
    expect(binary).toEqual({
      content: bytes.toString("base64"),
      encoding: "base64",
      byteLength: bytes.byteLength,
      mimeType: "text/html",
      displayPath: "notes.html",
      baseSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      baseRevision: 7,
    });

    const text = bytes.toString("utf8");
    // Replacement-character decoding changes the bytes and requires a real
    // mutation. This read-only fixture deliberately has no commit coordinator.
    expect(await operations.write(workspaceTarget, { content: text }, { baseRevision: 7 })).toEqual({
      kind: "error",
      message: "Workspace document mutation coordinator context is unavailable.",
    });
    expect(reads).toBe(2);
  });

  test("keeps the default workspace read response text-shaped", async () => {
    const bytes = Buffer.from("plain text", "utf8");
    const operations = operationsAt(3, async () => bytes);
    const result = await operations.read(workspaceTarget);
    expect(result).toMatchObject({ content: "plain text", baseRevision: 3 });
    expect(result).not.toHaveProperty("encoding");
    expect(result).not.toHaveProperty("byteLength");
  });

  test("binary Current Folder reads require exact relay bytes", async () => {
    const operations = operationsAt(3, async () => Buffer.from("unused"));
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    let payload: unknown = { binary: true, content: bytes.toString("base64") };
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-binary"],
      getCapabilities: () => ({ profile: "desktop-agent", canReadWorkspace: true, canWriteWorkspace: true, localFileExecution: true, allowedRoots: ["/tmp/project"] }),
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      dispatch: async () => { throw new Error("fs dispatch must not be used"); },
      localFileDispatch: async () => ({ ok: true, result: JSON.stringify(payload) }),
    });
    try {
      expect(await operations.read(folderTarget, { encoding: "base64" })).toMatchObject({ content: bytes.toString("base64"), encoding: "base64", byteLength: bytes.length, baseSha256: sha256Hex(bytes) });
      for (const invalid of [{ content: "text" }, { binary: true, content: "not-base64" }]) {
        payload = invalid;
        await expectHostOperationError(operations.read(folderTarget, { encoding: "base64" }), /binary read/i);
      }
    } finally { setRelayRegistry(null); }
  });
});

test("live Video transport binds app/user/version/tool and preserves ordinary saved edits", async () => {
  const binding = { targetKind: "artifact" as const, appId: "nautilo-video", userId: "user-1", namespaceIds: ["ns-1"], artifactId: "video-artifact", documentId: "video-document", documentVersion: { kind: "artifact_revision" as const, revision: 1 } };
  const issued = liveMiniAppSessionRegistry.issue(binding);
  const life = new AbortController();
  const trusted = { appId: binding.appId, sessionToken: issued.token, sessionId: issued.sessionId, documentVersion: binding.documentVersion, instructions: "Video" };
  const options = {
    appId: "nautilo-video", appsRoot: "/apps", manifest: { ...liveReviewManifest(), id: "nautilo-video" },
    context: { ...context(), liveMiniAppSession: trusted }, documentOps: mockDocumentOps(),
    liveReviewArtifactId: async () => "video-artifact",
    invocation: { toolId: "control-open-video", signal: life.signal, deadline: Date.now() + 10_000 },
  };
  try {
    const host = createAppToolHost(options);
    const received = liveAppCommandBroker.listen(issued.sessionId, life.signal);
    const pending = host.session.command({ action: "pause" });
    const command = (await received)!;
    expect(command.documentVersion).toEqual(binding.documentVersion);
    const result = { status: "ready", documentChanged: false, playbackConfirmed: false, state: { playheadSec: 1, durationSec: 3, playing: false, range: { inSec: 0, outSec: 0 } } };
    expect(liveAppCommandBroker.complete(issued.sessionId, command.requestId, result)).toBe(true);
    expect(await pending).toEqual(result);
    // Opening a transport session must not restore the old save/editor block.
    expect(await host.document.write(workspaceTarget, { content: "next" }, { baseRevision: 1 })).toMatchObject({ kind: "saved" });
    for (const override of [
      { context: { ...options.context, userId: "other-user" } },
      { context: { ...options.context, currentTaskId: "background-task" } },
      { context: { ...options.context, liveMiniAppSession: { ...trusted, documentVersion: { kind: "artifact_revision" as const, revision: 0 } } } },
      { invocation: { ...options.invocation, toolId: "edit-timeline" } },
      { appId: "nautilo-design" },
    ]) {
      expect(await createAppToolHost({ ...options, ...override }).session.command({ action: "play" })).toMatchObject({ status: "unavailable", stateChanged: false });
    }
    await assert.rejects(
      () => host.session.command({ action: "play", path: "other" }),
      /Invalid live app command/,
    );
    liveMiniAppSessionRegistry.revokeForSubject(issued.token, binding);
    expect(await host.session.command({ action: "play" })).toMatchObject({ status: "unavailable" });
  } finally {
    life.abort();
    liveMiniAppSessionRegistry.revokeForSubject(issued.token, binding);
  }
});

describe("createAppToolHost capability enforcement", () => {
  test("forwards an agent write's observed sha and revision to the document authority", async () => {
    let observed:
      | { target: AppDocumentTarget; content: string; opts: { baseSha256?: string | null; baseRevision?: number | null } | undefined }
      | undefined;
    const documentOps = mockDocumentOps();
    documentOps.write = async (target, next, opts) => {
      observed = { target, content: next.content, opts };
      return { kind: "saved", sha256: "def", revision: 2 };
    };
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: TEST_MINI_APP_MANIFEST,
      context: context(),
      documentOps,
    });

    await host.document.write(folderTarget, { content: "agent change" }, { baseSha256: "abc", baseRevision: 1 });
    expect(observed).toEqual({
      target: folderTarget,
      content: "agent change",
      opts: { baseSha256: "abc", baseRevision: 1 },
    });
  });

  test("read-only manifest rejects workspace write and create", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: readOnlyManifest(),
      context: context(),
      documentOps: mockDocumentOps(),
    });

    const read = await host.document.read(workspaceTarget);
    expect(read).toMatchObject({
      displayPath: "notes.html",
    });

    await expectHostOperationError(host.document.write(workspaceTarget, { content: "x" }));
    await expectHostOperationError(
      host.document.createFromAction("new-canvas", {
        targetSurface: "workspace",
        filename: "x.html",
      }),
    );
    await expectHostOperationError(
      host.document.createRasterFromSvg({
        surface: "workspace",
        path: "blocked.png",
        svg: SIMPLE_SVG,
        format: "png",
      }),
      /workspace artifact write/i,
    );
  });

  test("createRasterFromSvg validates its closed contract before rasterization", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: writableManifest(),
      context: context(),
      documentOps: mockDocumentOps(),
    });

    await expectHostOperationError(
      host.document.createRasterFromSvg({
        surface: "workspace",
        path: "out.svg",
        svg: SIMPLE_SVG,
        format: "png",
      }),
      /\.png/i,
    );
    await expectHostOperationError(
      host.document.createRasterFromSvg({
        surface: "workspace",
        path: "out.png",
        svg: SIMPLE_SVG,
        format: "jpeg" as "png",
      }),
      /format "png"/i,
    );
  });

  test("createRasterFromSvg explicitly refuses current-folder writes", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: writableManifest(),
      context: context(),
      documentOps: mockDocumentOps(),
    });
    const result = await host.document.createRasterFromSvg({
      surface: "currentFolder",
      path: "exports/out.png",
      // Invalid SVG proves the unsupported surface returns before rasterization.
      svg: "not svg",
      format: "png",
    });
    expect(result).toEqual({
      ok: false,
      code: "UNSUPPORTED_CURRENT_FOLDER",
      message:
        "PNG export to Current Folder is unavailable until the relay provides atomic create-only binary writes. Export to Workspace instead.",
    });
  });

  test("forwards app-tool write preconditions to the authoritative document operation", async () => {
    let received:
      | {
          target: AppDocumentTarget;
          content: string;
          opts: { baseSha256?: string | null; baseRevision?: number | null } | undefined;
        }
      | undefined;
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: TEST_MINI_APP_MANIFEST,
      context: context(),
      documentOps: {
        ...mockDocumentOps(),
        write: async (target, next, opts) => {
          received = { target, content: next.content, opts };
          return { kind: "saved", sha256: "def", revision: 2 };
        },
      },
      liveReviewArtifactId: async () => null,
    });

    const result = await Promise.resolve(
      host.document.write(workspaceTarget, { content: "agent snapshot" }, {
        baseSha256: "base-sha",
        baseRevision: 1,
      }),
    );
    expect(result).toEqual({ kind: "saved", sha256: "def", revision: 2 });
    expect(received).toEqual({
      target: workspaceTarget,
      content: "agent snapshot",
      opts: { baseSha256: "base-sha", baseRevision: 1 },
    });
  });

  test("validates and forwards document read encoding through host and RPC", async () => {
    const calls: unknown[] = [];
    const host = createAppToolHost({
      appId: "test-canvas", appsRoot: "/apps", manifest: readOnlyManifest(), context: context(),
      documentOps: {
        ...mockDocumentOps(),
        read: async (target, options) => {
          calls.push({ target, options });
          if (!options) {
            return { content: "plain text", mimeType: "text/plain", displayPath: "notes.html", baseSha256: "abc", baseRevision: 1 };
          }
          return { content: "/w==", encoding: "base64", byteLength: 1, mimeType: "application/octet-stream", displayPath: "notes.html", baseSha256: "abc", baseRevision: 1 };
        },
      },
    });

    expect(await handleHostRpc(host, "document.read", [workspaceTarget, { encoding: "base64" }])).toMatchObject({ encoding: "base64", byteLength: 1 });
    expect(await handleHostRpc(host, "document.read", [workspaceTarget, null])).toMatchObject({ content: "plain text" });
    expect(calls).toEqual([
      { target: workspaceTarget, options: { encoding: "base64" } },
      { target: workspaceTarget, options: undefined },
    ]);
    await expectHostOperationError(host.document.read(workspaceTarget, { encoding: "latin1" as "utf8" }), /utf8.*base64/i);
    expect(calls).toHaveLength(2);
  });

  test("rejects binary creation admission failures before workspace mutation", async () => {
    const host = createAppToolHost({
      appId: "test-canvas", appsRoot: "/apps", manifest: writableManifest(), context: context(),
      documentOps: mockDocumentOps(), liveReviewArtifactId: async () => null,
    });
    const create = (overrides: Record<string, unknown>) => host.document.createDocument({
      surface: "workspace", path: "exports/deck.pptx", content: "AA==", encoding: "base64", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ...overrides,
    } as never);

    await expectHostOperationError(create({ encoding: "hex" }), /encoding.*utf8.*base64/i);
    for (const content of ["not base64", "AA==\n", "AA", "_-=="]) {
      await expectHostOperationError(create({ content }), /canonical base64/i);
    }
    await expectHostOperationError(create({ mimeType: "application/octet-stream; charset=binary" }), /valid mimeType/i);
    await expectHostOperationError(create({ mimeType: "" }), /valid mimeType/i);
    await expectHostOperationError(create({ path: "../deck.pptx" }), /path/i);
    await expectHostOperationError(create({ overwrite: "yes" }), /overwrite must be a boolean/i);
    await expectHostOperationError(create({ colocateWith: { surface: "currentFolder", path: "source.pptx" } }), /workspace target/i);

    await expectHostOperationError(create({ surface: "currentFolder", path: "../deck.pptx" }), /path/i);
  });

  test("binary Current Folder copies use create-only relay admission and verify receipts", async () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    const calls: Record<string, unknown>[] = [];
    let response: unknown = { applied: true, revisionId: "local:relay-binary:revision", sha256: sha256Hex(bytes) };
    let transportFailure = false;
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-binary"],
      getCapabilities: () => ({ profile: "desktop-agent", canReadWorkspace: true, canWriteWorkspace: true, localFileExecution: true, allowedRoots: ["/tmp/project"] }),
      getProtocolVersion: () => RELAY_PROTOCOL_VERSION,
      dispatch: async () => { throw new Error("fs dispatch must not be used"); },
      localFileDispatch: async (_relayId, request) => {
        expect(request.operation.kind).toBe("file");
        if (request.operation.kind !== "file") throw new Error("unexpected dispatch");
        expect(request.operation.command).toBe("write");
        calls.push(request.operation.args);
        return transportFailure ? { ok: false, message: "Disconnected after delivery" } : { ok: true, result: JSON.stringify(response) };
      },
    });
    try {
      const host = createAppToolHost({ appId: "test-canvas", appsRoot: "/apps", manifest: writableManifest(), context: context(), liveReviewArtifactId: async () => null });
      const create = (overwrite = false) => host.document.createDocument({ surface: "currentFolder", path: "Copy.pptx", content: bytes.toString("base64"), encoding: "base64", mimeType: "application/octet-stream", overwrite });
      expect(await create()).toMatchObject({ ok: true, sha256: sha256Hex(bytes), byteLength: bytes.length });
      expect(calls[0]).toMatchObject({ path: "Copy.pptx", encoding: "base64", content: bytes.toString("base64"), expectedSha256: null });
      expect(calls[0]!["_routing"]).toHaveProperty("mutationRequestId");
      expect(await create(true)).toMatchObject({ ok: true });
      expect(calls[1]).not.toHaveProperty("expectedSha256");
      for (const error of ["destination_exists", "stale_sha256"]) {
        response = { error, message: "Concurrent destination" };
        expect(await create()).toMatchObject({ ok: false, code: "CONFLICT" });
      }
      response = { error: "reapply_required", message: "Reinspect the destination before retrying" };
      expect(await create()).toMatchObject({ ok: false, code: "UNCONFIRMED_WRITE", retrySafe: false });
      response = { applied: true, revisionId: "revision", sha256: "f".repeat(64) };
      expect(await create()).toMatchObject({ ok: false, code: "UNCONFIRMED_WRITE", retrySafe: false });
      transportFailure = true;
      expect(await create()).toMatchObject({ ok: false, code: "UNCONFIRMED_WRITE", retrySafe: false });
      expect(calls).toHaveLength(7);
    } finally { setRelayRegistry(null); }
  });

  test("denies binary creation without write permission", async () => {
    const host = createAppToolHost({ appId: "test-canvas", appsRoot: "/apps", manifest: readOnlyManifest(), context: context(), documentOps: mockDocumentOps() });
    await expectHostOperationError(host.document.createDocument({
      surface: "workspace", path: "deck.pptx", content: "AA==", encoding: "base64", mimeType: "application/octet-stream",
    }), /workspace artifact write/i);
  });

  test("does not let base64 Design SVG bypass first-party asset authority", async () => {
    const designManifest: MiniAppManifest = { ...writableManifest(), id: "nautilo-design" };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="nautilo-asset:artifact-secret"/></svg>';
    const host = createAppToolHost({ appId: "nautilo-design", appsRoot: "/apps", manifest: designManifest, context: context(), documentOps: mockDocumentOps(), liveReviewArtifactId: async () => null });
    expect(await host.document.createDocument({
      surface: "workspace", path: "exports/design.svg", content: Buffer.from(svg).toString("base64"), encoding: "base64", mimeType: "image/svg+xml",
    })).toEqual({
      ok: false,
      code: "FORBIDDEN_ASSET_REFERENCE",
      message: "SVG image assets require the verified first-party Design app.",
    });
  });

  test("manifest without currentFolder capability rejects folder targets", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: readOnlyManifest(),
      context: context(),
      documentOps: mockDocumentOps(),
    });

    await expectHostOperationError(host.document.read(folderTarget), /current folder/i);
  });

  test("manifest without capabilities rejects reads", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: noCapsManifest(),
      context: context(),
      documentOps: mockDocumentOps(),
    });

    await expectHostOperationError(host.document.read(workspaceTarget), /workspace artifact read/i);
  });

  test("state set requires readwrite capability", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: readOnlyManifest(),
      context: context(),
      documentOps: mockDocumentOps(),
    });

    expect(await host.state.get(workspaceTarget, "view")).toEqual({ ok: true });
    await expectHostOperationError(host.state.set(workspaceTarget, "view", true), /state write/i);
  });

  test("currentFolder state returns unsupported error", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: TEST_MINI_APP_MANIFEST,
      context: context(),
      documentOps: mockDocumentOps(),
    });

    await expectHostOperationError(host.state.get(folderTarget, "view"), /only supported for workspace/i);
  });

  test("createFromAction validates basename filename", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: TEST_MINI_APP_MANIFEST,
      context: context(),
      documentOps: mockDocumentOps(),
    });

    await expectHostOperationError(
      host.document.createFromAction("new-canvas", {
        targetSurface: "workspace",
        filename: "../evil.html",
      }),
      /basename/i,
    );
  });

  test("createFromAction rejects unsupported target surface for action", async () => {
    const workspaceOnlyManifest: MiniAppManifest = {
      ...TEST_MINI_APP_MANIFEST,
      createActions: [
        {
          ...TEST_MINI_APP_MANIFEST.createActions![0]!,
          targetSurfaces: ["workspace"],
        },
      ],
    };
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: workspaceOnlyManifest,
      context: context(),
      documentOps: mockDocumentOps(),
    });

    await expectHostOperationError(
      host.document.createFromAction("new-canvas", {
        targetSurface: "currentFolder",
        filename: "x.html",
      }),
      /does not support surface/i,
    );
  });
});

describe("createAppToolHost live-review document gate", () => {
  test("bound current-file writes re-prove relay identity and do not permit targeted reads", async () => {
    let writeCalls = 0;
    const binding = {
      targetKind: "currentFile" as const,
      appId: "nautilo-design",
      userId: "user-1",
      localTargetId: "opaque-current-target",
      relayId: "relay-desktop",
      canonicalPath: "/tmp/project/notes.design",
      currentFolderRoot: "/tmp/project",
      relativePath: "notes.design",
      documentVersion: { kind: "local_sha" as const, sha256: "a".repeat(64) },
    };
    const relayRegistry = {
      findByCapabilityForUser: () => ["relay-desktop"],
      getCapabilities: () => ({
        profile: "desktop-agent" as const,
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/tmp/project"],
      }),
      getProtocolVersion: () => 7,
      dispatch: async () => ({ status: "error" as const, error: "unexpected" }),
      localFileDispatch: async () => ({ ok: false as const, message: "unexpected" }),
    };
    let canonicalIdentity = "/tmp/project/other.design";
    const host = createAppToolHost({
      appId: "nautilo-design",
      appsRoot: "/apps",
      manifest: {
        ...TEST_MINI_APP_MANIFEST,
        id: "nautilo-design",
        capabilities: { document: { artifact: "readwrite", currentFolder: "readwrite" }, state: "read" },
      },
      context: context(),
      relayRegistry,
      documentOps: {
        ...mockDocumentOps(),
        write: async (target) => {
          writeCalls += 1;
          expect(target).toEqual({ surface: "currentFolder", relativePath: "notes.design" });
          return { kind: "saved", sha256: "def" };
        },
      },
      liveMutationBinding: binding,
      liveReviewCurrentFileIdentity: async () => canonicalIdentity,
    });

    await expectHostOperationError(host.document.writeBound({ content: "blocked" }), /limited to its open document/i);
    await expectHostOperationError(host.document.write(folderTarget, { content: "blocked" }), /must use document\.writeBound/i);
    await expectHostOperationError(host.document.read(folderTarget), /targeted reads are unavailable/i);
    await expectHostOperationError(host.state.get(workspaceTarget, "draft"), /cannot access app state/i);
    await expectHostOperationError(host.office.run({ input: { surface: "workspace", path: "notes.design" }, readArgv: ["get"] }), /cannot use office operations/i);
    expect(writeCalls).toBe(0);
    canonicalIdentity = "/tmp/project/notes.design";
    expect(await host.document.writeBound({ content: "allowed" })).toMatchObject({ kind: "saved" });
    expect(writeCalls).toBe(1);
  });

  test("rejects a forged bound mutation authority from another app or user", async () => {
    const host = createAppToolHost({
      appId: "nautilo-design",
      appsRoot: "/apps",
      manifest: TEST_MINI_APP_MANIFEST,
      context: context(),
      documentOps: mockDocumentOps(),
      liveMutationBinding: {
        targetKind: "artifact",
        appId: "nautilo-writer",
        userId: "someone-else",
        namespaceIds: ["ns-1"],
        artifactId: "artifact-1",
        documentId: "document-1",
        documentVersion: { kind: "artifact_revision", revision: 1 },
      },
    });
    await expectHostOperationError(host.document.writeBound({ content: "forged" }), /not valid for this app or user/i);
  });

  test("blocks an app-tool document write before document persistence for an open authoritative artifact", async () => {
    let writeCalls = 0;
    const session = issueLiveReviewSession();
    try {
      const host = createAppToolHost({
        appId: registeredLiveReviewExtension.appId,
        appsRoot: "/apps",
        manifest: liveReviewManifest(),
        context: context(),
        documentOps: {
          ...mockDocumentOps(),
          write: async () => {
            writeCalls += 1;
            return { kind: "saved", sha256: "def" };
          },
        },
        liveReviewArtifactId: async (target) =>
          target.path === workspaceTarget.path ? "artifact-1" : null,
      });

      await expectHostOperationError(
        host.document.write(workspaceTarget, { content: "blocked" }),
        /use_edit_open_writer/i,
      );
      expect(writeCalls).toBe(0);
    } finally {
      liveMiniAppSessionRegistry.revokeForSubject(session.token, {
        appId: registeredLiveReviewExtension.appId,
        userId: "user-1",
      });
    }
  });

  test("blocks createDocument before artifact creation for an open authoritative artifact", async () => {
    const session = issueLiveReviewSession();
    try {
      const host = createAppToolHost({
        appId: registeredLiveReviewExtension.appId,
        appsRoot: "/apps",
        manifest: liveReviewManifest(),
        context: context(),
        liveReviewArtifactId: async (target) =>
          target.path === workspaceTarget.path ? "artifact-1" : null,
      });

      for (const args of [
        { surface: "workspace" as const, path: workspaceTarget.path, content: "blocked" },
        { surface: "workspace" as const, path: workspaceTarget.path, content: "AA==", encoding: "base64" as const, mimeType: "application/octet-stream" },
      ]) {
        await expectHostOperationError(host.document.createDocument(args), /use_edit_open_writer/i);
      }
    } finally {
      liveMiniAppSessionRegistry.revokeForSubject(session.token, {
        appId: registeredLiveReviewExtension.appId,
        userId: "user-1",
      });
    }
  });

  test("blocks createRasterFromSvg before rasterization for an open authoritative artifact", async () => {
    const session = issueLiveReviewSession();
    try {
      const host = createAppToolHost({
        appId: registeredLiveReviewExtension.appId,
        appsRoot: "/apps",
        manifest: liveReviewManifest(),
        context: context(),
        liveReviewArtifactId: async () => "artifact-1",
      });

      await expectHostOperationError(
        host.document.createRasterFromSvg({
          surface: "workspace",
          path: workspaceTarget.path.replace(/\.html$/, ".png"),
          svg: SIMPLE_SVG,
          format: "png",
        }),
        /use_edit_open_writer/i,
      );
    } finally {
      liveMiniAppSessionRegistry.revokeForSubject(session.token, {
        appId: registeredLiveReviewExtension.appId,
        userId: "user-1",
      });
    }
  });

  test("allows writes after revocation and for a session belonging to another user", async () => {
    let writeCalls = 0;
    const revokedSession = issueLiveReviewSession();
    const otherUserSession = issueLiveReviewSession("user-2");
    liveMiniAppSessionRegistry.revokeForSubject(revokedSession.token, {
      appId: registeredLiveReviewExtension.appId,
      userId: "user-1",
    });
    try {
      const host = createAppToolHost({
        appId: registeredLiveReviewExtension.appId,
        appsRoot: "/apps",
        manifest: liveReviewManifest(),
        context: context(),
        documentOps: {
          ...mockDocumentOps(),
          write: async () => {
            writeCalls += 1;
            return { kind: "saved", sha256: "def" };
          },
        },
        liveReviewArtifactId: async () => "artifact-1",
      });

      expect(await host.document.write(workspaceTarget, { content: "allowed-after-revocation" })).toMatchObject({
        kind: "saved",
      });
      expect(await host.document.write(workspaceTarget, { content: "allowed-for-other-user-session" })).toMatchObject({
        kind: "saved",
      });
      expect(writeCalls).toBe(2);
    } finally {
      liveMiniAppSessionRegistry.revokeForSubject(revokedSession.token, {
        appId: registeredLiveReviewExtension.appId,
        userId: "user-1",
      });
      liveMiniAppSessionRegistry.revokeForSubject(otherUserSession.token, {
        appId: registeredLiveReviewExtension.appId,
        userId: "user-2",
      });
    }
  });

  test("blocks the exact current file on the selected relay and carries a path-free structured failure", async () => {
    let writeCalls = 0;
    const session = liveMiniAppSessionRegistry.issue({
      targetKind: "currentFile",
      appId: registeredLiveReviewExtension.appId,
      userId: "user-1",
      localTargetId: "opaque-current-target",
      relayId: "relay-desktop",
      canonicalPath: "/tmp/project/notes.html",
      currentFolderRoot: "/tmp/project",
      relativePath: "notes.html",
      documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
    });
    const relayRegistry = {
      findByCapabilityForUser: () => ["relay-desktop"],
      getCapabilities: () => ({
        profile: "desktop-agent" as const,
        canReadWorkspace: true,
        canWriteWorkspace: true,
        localFileExecution: true,
        allowedRoots: ["/tmp/project"],
      }),
      getProtocolVersion: () => 7,
      dispatch: async () => ({ status: "error" as const, error: "unexpected" }),
      localFileDispatch: async () => ({ ok: false as const, message: "unexpected" }),
    };
    const manifest: MiniAppManifest = {
      ...liveReviewManifest(),
      capabilities: {
        document: { artifact: "readwrite", currentFolder: "readwrite" },
        state: "read",
      },
    };
    try {
      const host = createAppToolHost({
        appId: registeredLiveReviewExtension.appId,
        appsRoot: "/apps",
        manifest,
        context: context(),
        relayRegistry,
        documentOps: {
          ...mockDocumentOps(),
          write: async () => {
            writeCalls += 1;
            return { kind: "saved", sha256: "def" };
          },
        },
        liveReviewCurrentFileIdentity: async (input) => {
          expect(input).toEqual({
            ownerId: "user-1",
            relayId: "relay-desktop",
            candidatePath: "/tmp/project/notes.html",
          });
          return input.candidatePath;
        },
      });

      expect(await host.document.read(folderTarget)).toMatchObject({
        displayPath: "notes.html",
      });
      const error = await expectHostOperationError(
        host.document.write(folderTarget, { content: "blocked" }),
        /use_edit_open_writer/,
      );
      expect(error.directMutationFailure).toEqual({
        ok: false,
        status: "use_edit_open_writer",
        code: "use_edit_open_writer",
        message: "This document has an active mini-app editing session. Use that app’s live editing tools in the tab where it is open, or close that editor before editing the saved file.",
      });
      expect(error.message).not.toContain("/tmp/project");
      expect(error.message).not.toContain("notes.html");
      expect(writeCalls).toBe(0);
    } finally {
      liveMiniAppSessionRegistry.revokeForSubject(session.token, {
        appId: registeredLiveReviewExtension.appId,
        userId: "user-1",
      });
    }
  });
});

describe("handleHostRpc", () => {
  test("handleHostRpc rejects unknown methods", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: TEST_MINI_APP_MANIFEST,
      context: context(),
      documentOps: mockDocumentOps(),
    });
    await expectHostOperationError(handleHostRpc(host, "document.bogus", []), /Unsupported host RPC method/);
  });

  test("dispatches document.createRasterFromSvg", async () => {
    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: "/apps",
      manifest: writableManifest(),
      context: context(),
      documentOps: mockDocumentOps(),
      liveReviewArtifactId: async () => null,
    });
    const result = await handleHostRpc(host, "document.createRasterFromSvg", [{
      surface: "workspace",
      path: "out.png",
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="https://example.com/x.png"/></svg>',
      format: "png",
    }]);
    expect(result).toMatchObject({ ok: false, code: "INVALID_SVG" });
  });
});
