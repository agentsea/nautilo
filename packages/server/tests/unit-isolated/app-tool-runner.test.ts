// Real child-worker deadline tests must not share an ordinary --isolate batch
// with app-bundle builds: CPU contention can expire the deadline before the
// host RPC under test is admitted. Keep the real deadline and receipt checks;
// the existing isolated-file phase owns this suite's process isolation.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";
import { createAppToolHost, type AppDocumentOperations } from "../../src/apps/app-tool-host";
import {
  APP_TOOL_MAX_MESSAGE_BYTES,
  APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
  AppToolJsonLineAccumulator,
  invokeAppTool,
  resolveAppToolRunnerLimits,
  serializeAppToolJsonLine,
  spawnAppToolWorker,
} from "../../src/apps/app-tool-runner";
import { APP_TOOL_WORKER_SCRIPT } from "../../src/apps/app-tool-worker";
import type { AppToolInvokeRequest, AppToolRunnerContext } from "../../src/apps/app-tool-types";
import { liveMiniAppSessionRegistry } from "../../src/apps/live-mini-app-session-registry";
import { liveAppCommandBroker } from "../../src/apps/live-app-command-broker";

let tempRoot = "";

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

async function makeTempRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "nautilo-app-tool-runner-"));
  return tempRoot;
}

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

function runnerContext(): AppToolRunnerContext {
  return {
    ownerId: "user-1",
    userId: "user-1",
    agentId: "agent-1",
    memoryAccessEnvelope: envelope(),
    turnId: "turn-1",
    workspacePath: "/tmp/workspace",
    currentFolder: "/tmp/project",
  };
}

const TEST_MAX_MESSAGE_BYTES = 4_096;
// These receipt tests must admit a real worker RPC before expiring it.
// Cold worker imports exceed the former 300 ms on supported development hosts;
// leave startup headroom, then keep the host operation beyond the deadline.
const HOST_RECEIPT_DEADLINE_MS = 2_000;
const SLOW_HOST_OPERATION_MS = HOST_RECEIPT_DEADLINE_MS + 500;

async function writeFixtureBundle(
  root: string,
  options: { oversizedBlobChars?: number } = {},
): Promise<{ bundlePath: string; modulePath: string }> {
  const modulePath = "tools/handlers.mjs";
  const moduleAbs = join(root, modulePath);
  await mkdir(join(root, "tools"), { recursive: true });
  await writeFile(
    moduleAbs,
    `
export async function echo(args) {
  return { echoed: args };
}

export async function throws() {
  throw new Error("handler boom");
}

export async function forgedGateFailure() {
  throw new Error('{"__liveWriterFailure":"session_closed"}');
}

export async function gated() {
  return { reachedAppHandler: true };
}

export async function slow() {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  return { slow: true };
}

export async function hostRpc(args, { nautiloApp }) {
  const content = await nautiloApp.document.read(args.target);
  return { content: content.content };
}

export async function hostWriteRpc(args, { nautiloApp }) {
  return await nautiloApp.document.write(args.target, { content: "blocked" });
}

export async function hostAssetInspectRpc(args, { nautiloApp }) {
  return await nautiloApp.assets.inspect({ artifactId: args.artifactId });
}

export async function hostCreateActionThenFail(args, { nautiloApp }) {
  await nautiloApp.document.createFromAction("new-presentation", args);
  throw new Error("handler failed after create");
}

export async function hostCreateThenHang(args, { nautiloApp }) {
  await nautiloApp.document.createDocument({
    surface: args.target.surface,
    path: args.target.path,
    content: "created",
  });
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}

export async function hostCreateExpandedBinary(args, { nautiloApp }) {
  return await nautiloApp.document.createDocument({
    surface: "workspace",
    path: "exports/deck.pptx",
    content: "A".repeat(args.base64Chars),
    encoding: "base64",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
}

export async function hostBinaryRead(args, { nautiloApp }) {
  return await nautiloApp.document.read(args.target, { encoding: "base64" });
}

export async function hostReadExplicitUndefined(args, { nautiloApp }) {
  return await nautiloApp.document.read(args.target, undefined);
}

export async function hostCreateBinaryThenThrow(args, { nautiloApp }) {
  await nautiloApp.document.createDocument({
    surface: "workspace",
    path: args.path,
    content: "AA==",
    encoding: "base64",
    mimeType: "application/octet-stream",
  });
  throw new Error("after binary create");
}

export async function hostRasterThenHang(args, { nautiloApp }) {
  await nautiloApp.document.createRasterFromSvg({
    surface: args.target.surface,
    path: args.target.path,
    svg: "<svg xmlns='http://www.w3.org/2000/svg'/>",
    format: "png",
  });
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}

export async function hugeResult() {
  return { blob: "x".repeat(${options.oversizedBlobChars ?? TEST_MAX_MESSAGE_BYTES + 32}) };
}
`.trim(),
  );

  const bundlePath = join(root, "agent-tools.mjs");
  await writeFile(
    bundlePath,
    `import * as handlers from "./tools/handlers.mjs";
export const __nautiloAppToolModules = {
  ${JSON.stringify(modulePath)}: handlers,
};`,
  );

  return { bundlePath, modulePath };
}

function baseRequest(
  root: string,
  bundlePath: string,
  modulePath: string,
  handler: string,
  args: unknown = {},
): AppToolInvokeRequest {
  return {
    appId: "test-canvas",
    appRoot: join(root, "app"),
    appsRoot: root,
    sourceHash: "hash-1",
    cacheDir: join(root, "cache"),
    bundlePath,
    manifest: TEST_MINI_APP_MANIFEST,
    tool: {
      id: "inspect",
      description: "test tool",
      runtime: "server",
      module: modulePath,
      handler,
      inputSchema: { type: "object" },
      impact: "read-only",
    },
    args,
    context: runnerContext(),
  };
}

function testHost(root: string, documentOps?: AppDocumentOperations) {
  return createAppToolHost({
    appId: "test-canvas",
    appsRoot: root,
    manifest: TEST_MINI_APP_MANIFEST,
    context: runnerContext(),
    ...(documentOps ? { documentOps } : {}),
  });
}

describe("invokeAppTool runner", () => {
  test("live command cancellation releases the in-flight receiver and reports unknown, never retryable failure", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const request = baseRequest(root, bundlePath, modulePath, "echo");
    const binding = { targetKind: "artifact" as const, appId: "nautilo-video", userId: "user-1", namespaceIds: ["ns-1"], artifactId: "video-artifact", documentId: "video", documentVersion: { kind: "artifact_revision" as const, revision: 1 } };
    const issued = liveMiniAppSessionRegistry.issue(binding);
    request.appId = "nautilo-video";
    request.manifest = { ...request.manifest, id: request.appId, liveReview: { enabled: true } };
    request.tool = { ...request.tool, id: "control-open-video" };
    request.context.liveMiniAppSession = { appId: request.appId, sessionToken: issued.token, sessionId: issued.sessionId, documentVersion: binding.documentVersion, instructions: "Video" };
    const controller = new AbortController();
    try {
      const receiving = liveAppCommandBroker.listen(issued.sessionId, controller.signal);
      const pending = invokeAppTool(request, {
        signal: controller.signal,
        spawnWorker: async (_path, _payload, host) => ({ ok: true, result: await host.session.command({ action: "play" }) }),
      });
      const command = (await receiving)!;
      controller.abort();
      expect(await pending).toEqual({ ok: true, result: { status: "unknown", stateChanged: "unknown", retrySafe: false } });
      expect(liveAppCommandBroker.complete(issued.sessionId, command.requestId, {})).toBe(false);
      const timedOut = await invokeAppTool(request, { spawnWorker: async () => ({ ok: false, code: "timeout", error: "timeout" }) });
      expect(timedOut).toEqual({ ok: true, result: { status: "unknown", stateChanged: "unknown", retrySafe: false } });
    } finally {
      controller.abort(); liveMiniAppSessionRegistry.revokeForSubject(issued.token, binding);
    }
  });
  test("production message limits default to 50 MiB", () => {
    expect(APP_TOOL_MAX_MESSAGE_BYTES).toBe(50 * 1024 * 1024);
    expect(resolveAppToolRunnerLimits()).toEqual({ maxMessageBytes: APP_TOOL_MAX_MESSAGE_BYTES });
  });

  test("JSON-line accounting uses UTF-8 bytes for escaping, media, and the LF delimiter", () => {
    const mediaDataUrl = `data:image/png;base64,${"A".repeat(96)}`;
    const rpcResponse = {
      type: "rpc-res" as const,
      id: 7,
      ok: true as const,
      value: {
        title: "Résumé 😀\nquoted: \\\"",
        mediaByRelId: { "rId12": mediaDataUrl },
      },
    };
    const encoded = serializeAppToolJsonLine(rpcResponse);
    const json = JSON.stringify(rpcResponse);

    expect(encoded.line).toBe(`${json}\n`);
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.line, "utf8"));
    expect(encoded.bytes).toBe(Buffer.byteLength(json, "utf8") + 1);
    expect(encoded.bytes).toBeGreaterThan(json.length + 1);
  });

  test("keeps partial JSON-line chunks separate until their delimiter arrives", () => {
    const accumulator = new AppToolJsonLineAccumulator(4_096);
    for (let index = 0; index < 128; index += 1) {
      expect(accumulator.push(Buffer.from("x".repeat(16)))).toEqual({
        lines: [],
        oversized: false,
      });
    }
    expect(accumulator.pendingChunkCount).toBe(128);

    const completed = accumulator.push(Buffer.from("\n"));
    expect(completed.oversized).toBe(false);
    expect(completed.lines).toHaveLength(1);
    expect(completed.lines[0]?.toString("utf8")).toBe("x".repeat(2_048));
    expect(accumulator.pendingChunkCount).toBe(0);
  });

  test("rejects an oversized unterminated stdout line while it accumulates", async () => {
    const root = await makeTempRoot();
    const workerScriptPath = join(root, "unterminated-worker.mjs");
    await writeFile(workerScriptPath, `process.stdout.write(${JSON.stringify("😀".repeat(64))});`);
    const result = await spawnAppToolWorker(
      workerScriptPath,
      { bundlePath: "/fixture.mjs", modulePath: "tools/handlers.mjs", handler: "echo", args: {} },
      testHost(root),
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
      { maxMessageBytes: 128 },
    );

    expect(result).toEqual({
      ok: false,
      error: "Worker stdout line exceeds size limit.",
      code: "bounded",
    });
  });

  test("accepts a result exactly within its complete JSON-line envelope budget", async () => {
    const root = await makeTempRoot();
    const workerResult = {
      type: "result" as const,
      ok: true as const,
      value: { text: "😀".repeat(1_024) },
    };
    const workerLine = serializeAppToolJsonLine(workerResult);
    const workerScriptPath = join(root, "bounded-result-worker.mjs");
    await writeFile(workerScriptPath, `process.stdout.write(${JSON.stringify(workerLine.line)});`);

    const result = await spawnAppToolWorker(
      workerScriptPath,
      { bundlePath: "/fixture.mjs", modulePath: "tools/handlers.mjs", handler: "echo", args: {} },
      testHost(root),
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
      { maxMessageBytes: workerLine.bytes },
    );

    // The already-bounded worker result envelope is authoritative; its value
    // is returned unchanged rather than being measured by a second clamp.
    expect(result).toEqual({ ok: true, result: workerResult.value });
  });

  test("counts the newline when enforcing a complete worker stdout line", async () => {
    const root = await makeTempRoot();
    const workerResult = {
      type: "result" as const,
      ok: true as const,
      value: { text: "x".repeat(1_024) },
    };
    const workerLine = serializeAppToolJsonLine(workerResult);
    const workerScriptPath = join(root, "newline-worker.mjs");
    await writeFile(workerScriptPath, `process.stdout.write(${JSON.stringify(workerLine.line)});`);

    const result = await spawnAppToolWorker(
      workerScriptPath,
      { bundlePath: "/fixture.mjs", modulePath: "tools/handlers.mjs", handler: "echo", args: {} },
      testHost(root),
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
      { maxMessageBytes: workerLine.bytes - 1 },
    );

    expect(result).toEqual({
      ok: false,
      error: "Worker stdout line exceeds size limit.",
      code: "bounded",
    });
  });

  test("bounds a media data URL as part of the full host RPC response envelope", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const readResult = {
      content: `data:image/png;base64,${"A".repeat(4_096)}`,
      mimeType: "text/plain",
      displayPath: "notes.html",
      baseSha256: "abc",
      baseRevision: 1,
    };
    const rpcResponse = serializeAppToolJsonLine({
      type: "rpc-res" as const,
      id: 1,
      ok: true as const,
      value: readResult,
    });
    const documentOps: AppDocumentOperations = {
      createFromAction: async () => ({
        target: { surface: "workspace", path: "notes.html" },
        displayPath: "notes.html",
        opened: false,
      }),
      read: async () => readResult,
      stat: async () => ({
        exists: true,
        size: 5,
        mimeType: "text/plain",
        baseSha256: "abc",
        baseRevision: 1,
      }),
      write: async () => ({ kind: "saved", sha256: "def" }),
      getState: async () => null,
      setState: async () => undefined,
    };

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostRpc",
        args: { target: { surface: "workspace", path: "notes.html" } },
      },
      testHost(root, documentOps),
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
      { maxMessageBytes: rpcResponse.bytes - 1 },
    );

    expect(result).toEqual({
      ok: false,
      code: "bounded",
      error: "Host RPC response exceeds size limit.",
    });
  });

  test("rejects base64-expanded createDocument RPC before host mutation", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    let mutations = 0;
    const host = {
      document: {
        createDocument: async () => {
          mutations += 1;
          return { ok: true, artifactPath: "exports/deck.pptx", sha256: "abc", byteLength: 600 };
        },
      },
    } as unknown as ReturnType<typeof createAppToolHost>;

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      { bundlePath, modulePath, handler: "hostCreateExpandedBinary", args: { base64Chars: 800 } },
      host,
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
      { maxMessageBytes: 640 },
    );

    expect(result).toEqual({ ok: false, error: "Worker stdout line exceeds size limit.", code: "bounded" });
    expect(mutations).toBe(0);
  });

  test("bounds a base64 document.read response using the exact RPC envelope", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const readResult = {
      content: "A".repeat(800), encoding: "base64" as const, byteLength: 600,
      mimeType: "application/octet-stream", displayPath: "deck.pptx", baseSha256: "abc", baseRevision: 4,
    };
    const rpcResponse = serializeAppToolJsonLine({ type: "rpc-res" as const, id: 1, ok: true as const, value: readResult });
    const host = { document: { read: async () => readResult } } as unknown as ReturnType<typeof createAppToolHost>;

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      { bundlePath, modulePath, handler: "hostBinaryRead", args: { target: { surface: "workspace", path: "deck.pptx" } } },
      host,
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
      { maxMessageBytes: rpcResponse.bytes - 1 },
    );

    expect(result).toEqual({ ok: false, code: "bounded", error: "Host RPC response exceeds size limit." });
  });

  test("preserves an explicit undefined read option through worker JSON RPC as default UTF-8", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const readCalls: unknown[] = [];
    const documentOps: AppDocumentOperations = {
      createFromAction: async () => ({
        target: { surface: "workspace", path: "notes.html" },
        displayPath: "notes.html",
        opened: false,
      }),
      read: async (target, options) => {
        readCalls.push({ target, options });
        return {
          content: "unchanged UTF-8 text",
          mimeType: "text/plain",
          displayPath: "notes.html",
          baseSha256: "abc",
          baseRevision: 1,
        };
      },
      stat: async () => ({ exists: true, size: 20, mimeType: "text/plain", baseSha256: "abc", baseRevision: 1 }),
      write: async () => ({ kind: "saved", sha256: "def" }),
      getState: async () => null,
      setState: async () => undefined,
    };

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostReadExplicitUndefined",
        args: { target: { surface: "workspace", path: "notes.html" } },
      },
      testHost(root, documentOps),
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
    );

    expect(result).toEqual({
      ok: true,
      result: {
        content: "unchanged UTF-8 text",
        mimeType: "text/plain",
        displayPath: "notes.html",
        baseSha256: "abc",
        baseRevision: 1,
      },
    });
    expect(readCalls).toEqual([{
      target: { surface: "workspace", path: "notes.html" },
      options: undefined,
    }]);
  });

  test("retains an exact completed binary create when the handler throws afterward", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const receipt = { ok: true as const, artifactPath: "exports/deck.pptx", sha256: "binary-sha", byteLength: 1 };
    const host = { document: { createDocument: async () => receipt } } as unknown as ReturnType<typeof createAppToolHost>;

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      { bundlePath, modulePath, handler: "hostCreateBinaryThenThrow", args: { path: "exports//deck.pptx" } },
      host,
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
    );

    expect(result).toEqual({
      ok: false,
      code: "handler",
      error: "after binary create",
      completedHostMutations: [{
        method: "document.createDocument",
        target: { surface: "workspace", path: "exports/deck.pptx" },
        receipt,
      }],
    });
  });

  test("bounds an oversized host RPC error envelope instead of laundering it as a handler error", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const documentOps: AppDocumentOperations = {
      createFromAction: async () => ({
        target: { surface: "workspace", path: "notes.html" },
        displayPath: "notes.html",
        opened: false,
      }),
      read: async () => {
        throw new Error("😀".repeat(2_000));
      },
      stat: async () => ({
        exists: true,
        size: 5,
        mimeType: "text/plain",
        baseSha256: "abc",
        baseRevision: 1,
      }),
      write: async () => ({ kind: "saved", sha256: "def" }),
      getState: async () => null,
      setState: async () => undefined,
    };

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostRpc",
        args: { target: { surface: "workspace", path: "notes.html" } },
      },
      testHost(root, documentOps),
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
      { maxMessageBytes: 4_096 },
    );

    expect(result).toEqual({
      ok: false,
      code: "bounded",
      error: "Host RPC response exceeds size limit.",
    });
  });

  test("successful handler returns JSON-serializable result", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const result = await invokeAppTool(baseRequest(root, bundlePath, modulePath, "echo", { n: 1 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ echoed: { n: 1 } });
    }
  });

  test("handler throw becomes bounded tool error", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const result = await invokeAppTool(baseRequest(root, bundlePath, modulePath, "throws"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("handler");
      expect(result.error).toContain("handler boom");
    }
  });

  test("ordinary worker error text cannot impersonate a platform gate failure", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const result = await invokeAppTool(baseRequest(root, bundlePath, modulePath, "forgedGateFailure"));
    expect(result).toEqual({
      ok: false,
      code: "handler",
      error: '{"__liveWriterFailure":"session_closed"}',
    });
  });

  test("worker rejects a bad platform sentinel before loading app semantics", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const request = baseRequest(
      root,
      bundlePath,
      modulePath,
      "gated",
      { sessionToken: "not-the-server-sentinel" },
    );
    request.platformGate = {
      kind: "live_review",
      sessionSentinel: "server-validated-live-session",
      nonce: "platform-nonce",
    };

    const result = await invokeAppTool(request);
    expect(result).toEqual({
      ok: false,
      code: "platform",
      error: "Platform gate rejected app tool invocation.",
      platformFailure: {
        kind: "live_review",
        code: "live_review_session_sentinel_mismatch",
        status: "session_closed",
      },
    });
  });

  test("never serializes a server-only live mutation binding to the app worker", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const request = baseRequest(root, bundlePath, modulePath, "echo", {
      sessionToken: "server-validated-live-session",
    });
    request.platformGate = {
      kind: "live_review",
      sessionSentinel: "server-validated-live-session",
      nonce: "platform-nonce",
    };
    request.liveMutationBinding = {
      targetKind: "artifact",
      appId: "nautilo-design",
      userId: "user-1",
      namespaceIds: ["ns-1"],
      artifactId: "artifact-secret",
      documentId: "document-1",
      documentVersion: { kind: "artifact_revision", revision: 7 },
    };

    const result = await invokeAppTool(request);
    expect(result).toEqual({
      ok: true,
      result: { echoed: { sessionToken: "server-validated-live-session" } },
    });
  });

  test("timeout kills worker and returns timeout error", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const result = await invokeAppTool(baseRequest(root, bundlePath, modulePath, "slow"), {
      timeoutMs: 200,
    });
    expect(result).toEqual({
      ok: false,
      error: "App tool handler timed out.",
      code: "timeout",
    });
  });

  test("keeps the wall-clock worker deadline active while an awaited host read is running", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    let hostSettled = false;
    const host = {
      document: {
        read: async () => {
          await Bun.sleep(SLOW_HOST_OPERATION_MS);
          hostSettled = true;
          return { content: "host result" };
        },
      },
    } as unknown as ReturnType<typeof createAppToolHost>;

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostRpc",
        args: { target: { surface: "workspace", path: "notes.html" } },
      },
      host,
      HOST_RECEIPT_DEADLINE_MS,
    );

    expect(result).toEqual({
      ok: false,
      error: "App tool handler timed out.",
      code: "timeout",
    });
    expect(hostSettled).toBe(true);
  });

  test("reports an exact create receipt when worker code hangs after the host write", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const host = {
      document: {
        createDocument: async () => ({
          ok: true as const,
          artifactPath: "designs/Hero.svg",
          sha256: "created-sha",
          byteLength: 7,
        }),
      },
    } as unknown as ReturnType<typeof createAppToolHost>;

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostCreateThenHang",
        args: { target: { surface: "workspace", path: "designs//Hero.svg" } },
      },
      host,
      HOST_RECEIPT_DEADLINE_MS,
    );

    expect(result).toEqual({
      ok: false,
      error: "App tool handler timed out.",
      code: "timeout",
      completedHostMutations: [{
        method: "document.createDocument",
        target: { surface: "workspace", path: "designs/Hero.svg" },
        receipt: {
          ok: true,
          artifactPath: "designs/Hero.svg",
          sha256: "created-sha",
          byteLength: 7,
        },
      }],
    });
  });

  test("preserves a template creation receipt if app code fails after saving", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const host = { document: { createFromAction: async () => ({
      target: { surface: "workspace", path: "New.presentation.html" },
      displayPath: "New.presentation.html", opened: false,
      sha256: "a".repeat(64), byteLength: 123,
    }) } } as unknown as ReturnType<typeof createAppToolHost>;
    const result = await spawnAppToolWorker(APP_TOOL_WORKER_SCRIPT, {
      bundlePath, modulePath, handler: "hostCreateActionThenFail",
      args: { targetSurface: "workspace", filename: "New.presentation.html" },
    }, host, 10_000);
    expect(result).toMatchObject({ ok: false, completedHostMutations: [{
      method: "document.createFromAction", target: { surface: "workspace", path: "New.presentation.html" },
      receipt: { ok: true, artifactPath: "New.presentation.html", sha256: "a".repeat(64), byteLength: 123 },
    }] });
  });

  test("awaits a slow admitted create after the deadline and reports its exact receipt", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    let hostSettled = false;
    const host = {
      document: {
        createDocument: async () => {
          await Bun.sleep(SLOW_HOST_OPERATION_MS);
          hostSettled = true;
          return {
            ok: true as const,
            artifactPath: "designs/Slow.svg",
            sha256: "slow-created-sha",
            byteLength: 11,
          };
        },
      },
    } as unknown as ReturnType<typeof createAppToolHost>;

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostCreateThenHang",
        args: { target: { surface: "workspace", path: "designs/Slow.svg" } },
      },
      host,
      HOST_RECEIPT_DEADLINE_MS,
    );

    expect(hostSettled).toBe(true);
    expect(result).toEqual({
      ok: false,
      error: "App tool handler timed out.",
      code: "timeout",
      completedHostMutations: [{
        method: "document.createDocument",
        target: { surface: "workspace", path: "designs/Slow.svg" },
        receipt: {
          ok: true,
          artifactPath: "designs/Slow.svg",
          sha256: "slow-created-sha",
          byteLength: 11,
        },
      }],
    });
  });

  test("preserves a slow admitted partial write after the worker deadline", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    let hostSettled = false;
    const host = {
      document: {
        createRasterFromSvg: async () => {
          await Bun.sleep(SLOW_HOST_OPERATION_MS);
          hostSettled = true;
          return {
            ok: false as const,
            code: "PARTIAL_WRITE",
            message: "PNG bytes were written but artifact metadata was not confirmed.",
            displayPath: "designs/Partial.png",
            bytesWritten: 23,
            metadataConfirmed: false as const,
            stateChanged: true as const,
            retrySafe: false as const,
            internalDiagnostics: "must not cross the worker boundary",
          };
        },
      },
    } as unknown as ReturnType<typeof createAppToolHost>;

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostRasterThenHang",
        args: { target: { surface: "workspace", path: "designs//Partial.png" } },
      },
      host,
      HOST_RECEIPT_DEADLINE_MS,
    );

    expect(hostSettled).toBe(true);
    expect(result).toEqual({
      ok: false,
      error: "App tool handler timed out.",
      code: "timeout",
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "designs/Partial.png" },
        receipt: {
          ok: false,
          code: "PARTIAL_WRITE",
          message: "PNG bytes were written but artifact metadata was not confirmed.",
          displayPath: "designs/Partial.png",
          bytesWritten: 23,
          metadataConfirmed: false,
          stateChanged: true,
          retrySafe: false,
        },
      }],
    });
  });

  test("preserves a partial createDocument receipt when app code hangs afterward", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const host = {
      document: {
        createDocument: async () => ({
          ok: false as const,
          code: "PARTIAL_WRITE",
          message: "SVG bytes were written but artifact metadata was not confirmed.",
          displayPath: "designs/Partial.svg",
          bytesWritten: 29,
          metadataConfirmed: false as const,
          stateChanged: true as const,
          retrySafe: false as const,
        }),
      },
    } as unknown as ReturnType<typeof createAppToolHost>;

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostCreateThenHang",
        args: { target: { surface: "workspace", path: "designs//Partial.svg" } },
      },
      host,
      HOST_RECEIPT_DEADLINE_MS,
    );

    expect(result).toEqual({
      ok: false,
      error: "App tool handler timed out.",
      code: "timeout",
      completedHostMutations: [{
        method: "document.createDocument",
        target: { surface: "workspace", path: "designs/Partial.svg" },
        receipt: {
          ok: false,
          code: "PARTIAL_WRITE",
          message: "SVG bytes were written but artifact metadata was not confirmed.",
          displayPath: "designs/Partial.svg",
          bytesWritten: 29,
          metadataConfirmed: false,
          stateChanged: true,
          retrySafe: false,
        },
      }],
    });
  });

  test("records raster creation without retaining SVG or PNG bytes in the receipt", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const host = {
      document: {
        createRasterFromSvg: async () => ({
          ok: true as const,
          artifactPath: "designs/Hero.png",
          sha256: "raster-sha",
          byteLength: 19,
        }),
      },
    } as unknown as ReturnType<typeof createAppToolHost>;

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostRasterThenHang",
        args: { target: { surface: "workspace", path: "designs/Hero.png" } },
      },
      host,
      HOST_RECEIPT_DEADLINE_MS,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "timeout",
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "designs/Hero.png" },
        receipt: {
          ok: true,
          artifactPath: "designs/Hero.png",
          sha256: "raster-sha",
          byteLength: 19,
        },
      }],
    });
    expect(JSON.stringify(result)).not.toContain("<svg");
    expect(JSON.stringify(result)).not.toContain("created");
  });

  test("rejects a buffered host mutation RPC after the worker deadline has expired", async () => {
    const root = await makeTempRoot();
    const workerScriptPath = join(root, "late-rpc-worker.mjs");
    const rpcLine = serializeAppToolJsonLine({
      type: "rpc",
      id: 1,
      method: "document.createDocument",
      args: [{ surface: "workspace", path: "late.svg", content: "late" }],
    }).line;
    const childCode = `setTimeout(() => process.stdout.write(${JSON.stringify(rpcLine)}), 350)`;
    await writeFile(
      workerScriptPath,
      `import { spawn } from "node:child_process";\n` +
        `spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: ["ignore", "inherit", "ignore"] }).unref();\n` +
        `await new Promise(() => {});\n`,
    );
    let creates = 0;
    const host = {
      document: {
        createDocument: async () => {
          creates += 1;
          return { ok: true as const, artifactPath: "late.svg", sha256: "late", byteLength: 4 };
        },
      },
    } as unknown as ReturnType<typeof createAppToolHost>;

    const result = await spawnAppToolWorker(
      workerScriptPath,
      { bundlePath: "/unused", modulePath: "/unused", handler: "unused", args: {} },
      host,
      200,
    );

    expect(result).toEqual({
      ok: false,
      error: "App tool handler timed out.",
      code: "timeout",
    });
    expect(creates).toBe(0);
  });

  test("oversized handler result is bounded", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root, {
      oversizedBlobChars: TEST_MAX_MESSAGE_BYTES + 32,
    });
    const result = await invokeAppTool(baseRequest(root, bundlePath, modulePath, "hugeResult"), {
      maxMessageBytes: TEST_MAX_MESSAGE_BYTES,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("bounded");
      expect(result.error).toMatch(/size limit/i);
    }
  });

  test("worker host RPC reaches injected host document ops", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);

    const documentOps: AppDocumentOperations = {
      createFromAction: async () => ({
        target: { surface: "workspace", path: "notes.html" },
        displayPath: "notes.html",
        opened: false,
      }),
      read: async () => ({
        content: "hello",
        mimeType: "text/plain",
        displayPath: "notes.html",
        baseSha256: "abc",
        baseRevision: 1,
      }),
      stat: async () => ({
        exists: true,
        size: 5,
        mimeType: "text/plain",
        baseSha256: "abc",
        baseRevision: 1,
      }),
      write: async () => ({ kind: "saved", sha256: "def" }),
      getState: async () => null,
      setState: async () => undefined,
    };

    const host = createAppToolHost({
      appId: "test-canvas",
      appsRoot: root,
      manifest: TEST_MINI_APP_MANIFEST,
      context: runnerContext(),
      documentOps,
    });

    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostRpc",
        args: { target: { surface: "workspace", path: "notes.html" } },
      },
      host,
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ content: "hello" });
    }
  });

  test("worker exposes the bounded asset inspection RPC without granting third-party access", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const host = testHost(root);
    const result = await spawnAppToolWorker(
      APP_TOOL_WORKER_SCRIPT,
      {
        bundlePath,
        modulePath,
        handler: "hostAssetInspectRpc",
        args: { artifactId: "11111111-1111-4111-8111-111111111111" },
      },
      host,
      APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
    );
    expect(result).toMatchObject({
      ok: true,
      result: { ok: false, code: "FORBIDDEN" },
    });
  });

  test("carries structured open-Writer mutation failures through the worker", async () => {
    const root = await makeTempRoot();
    const { bundlePath, modulePath } = await writeFixtureBundle(root);
    const issued = liveMiniAppSessionRegistry.issue({
      targetKind: "artifact",
      appId: "nautilo-writer",
      userId: "user-1",
      namespaceIds: ["ns-1"],
      artifactId: "artifact-1",
      documentId: "document-1",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    });
    try {
      const documentOps: AppDocumentOperations = {
        createFromAction: async () => ({
          target: { surface: "workspace", path: "notes.html" },
          displayPath: "notes.html",
          opened: false,
        }),
        read: async () => ({
          content: "hello",
          mimeType: "text/plain",
          displayPath: "notes.html",
          baseSha256: "abc",
          baseRevision: 1,
        }),
        stat: async () => ({
          exists: true,
          size: 5,
          mimeType: "text/plain",
          baseSha256: "abc",
          baseRevision: 1,
        }),
        write: async () => ({ kind: "saved", sha256: "def" }),
        getState: async () => null,
        setState: async () => undefined,
      };
      const host = createAppToolHost({
        appId: "test-canvas",
        appsRoot: root,
        manifest: TEST_MINI_APP_MANIFEST,
        context: runnerContext(),
        documentOps,
        liveReviewArtifactId: async () => "artifact-1",
      });
      const result = await spawnAppToolWorker(
        APP_TOOL_WORKER_SCRIPT,
        {
          bundlePath,
          modulePath,
          handler: "hostWriteRpc",
          args: { target: { surface: "workspace", path: "notes.html" } },
        },
        host,
        APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS,
      );
      const failure = {
        ok: false as const,
        status: "use_edit_open_writer" as const,
        code: "use_edit_open_writer" as const,
        message: "This document is open in Writer review. Use edit-open-writer." as const,
      };
      expect(result).toEqual({
        ok: false,
        error: JSON.stringify(failure),
        code: "direct_mutation",
        directMutationFailure: failure,
      });
    } finally {
      liveMiniAppSessionRegistry.revokeForSubject(issued.token, {
        appId: "nautilo-writer",
        userId: "user-1",
      });
    }
  });
});
