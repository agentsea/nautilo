import { describe, expect, test } from "bun:test";
import corpusJson from "../../fixtures/0.146.0/protocol-corpus.json";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "../../testkit";
import { CodexRpcClient } from "../../src/client";
import {
  CodexRpcError,
  type ClientRequestParamsMap,
} from "../../src/rpc-types";
import type { CodexRpcClientOptions } from "../../src/client";
import { rpcRuntimeDecoder } from "../../src/validators";

const initializeParams: ClientRequestParamsMap["initialize"] = {
  clientName: "nautilo",
  clientTitle: "Nautilo",
  clientVersion: "0.1.0",
  experimentalApi: false,
};

/** Checked-in 0.146.0 corpus for the enabled native request surface. */
const ANCHOR_CORPUS = "0.146.0";

function anchorResponse(id: string): unknown {
  expect(corpusJson.codexVersion).toBe(ANCHOR_CORPUS);
  const fixture = corpusJson.fixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Missing ${ANCHOR_CORPUS} fixture ${id}`);
  const response = fixture.frames.find((frame) => frame.direction === "server_to_client");
  if (!response || !("result" in response.message)) {
    throw new Error(`Fixture ${id} has no successful server response`);
  }
  return response.message.result;
}

function anchorServerRequest(id: string): { readonly method: string; readonly params: unknown } {
  expect(corpusJson.codexVersion).toBe(ANCHOR_CORPUS);
  const fixture = corpusJson.fixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Missing ${ANCHOR_CORPUS} fixture ${id}`);
  const request = fixture.frames.find((frame) =>
    frame.direction === "server_to_client" && "method" in frame.message,
  );
  const message = request?.message as Record<string, unknown> | undefined;
  if (!message || typeof message["method"] !== "string") {
    throw new Error(`Fixture ${id} has no server request`);
  }
  return { method: message["method"], params: message["params"] };
}

function createClient(
  server: FakeCodexAppServer,
  overrides: Partial<CodexRpcClientOptions> = {},
): CodexRpcClient {
  return new CodexRpcClient({
    readable: server.readable,
    writable: server.writable,
    decoder: rpcRuntimeDecoder,
    ...overrides,
  });
}

async function initialize(server: FakeCodexAppServer, client: CodexRpcClient): Promise<void> {
  const pending = client.initialize(initializeParams);
  const request = await server.expectClientRequest("initialize");
  request.reply(anchorResponse("initialize.success"));
  await pending;
  await server.expectClientNotification("initialized");
}

describe("faulting fake Codex app-server", () => {
  test("drives production client login, usage, approval, and sideband generations", async () => {
    const server = createFakeCodexAppServer();
    const notifications: string[] = [];
    const client = createClient(server, {
      onNotification: (notification) => notifications.push(notification.method),
      serverRequestHandlers: {
        "item/commandExecution/requestApproval": async () => ({ decision: "accept" }),
      },
    });
    await initialize(server, client);

    const login = client.startLogin({ type: "chatgpt" });
    const loginRequest = await server.expectClientRequest("account/login/start");
    loginRequest.reply(anchorResponse("login.success"), { generation: 2 });
    expect((await login).type).toBe("chatgptDeviceCode");

    const usage = client.readRateLimits();
    const usageRequest = await server.expectClientRequest("account/rateLimits/read");
    usageRequest.reply(anchorResponse("usage.success"), { generation: 2 });
    expect((await usage).rateLimits?.limitId).toBe("codex");

    server.notify("account/login/completed", {
      loginId: "login-1", success: true, error: null,
    }, { generation: 5 });
    const usageNotification = anchorResponse("usage.success") as { readonly rateLimits: unknown };
    server.notify("account/rateLimits/updated", {
      rateLimits: usageNotification.rateLimits,
    }, { generation: 5 });
    const approvalFixture = anchorServerRequest("approval.success");
    const approval = server.request(approvalFixture.method, approvalFixture.params, { generation: 6 });
    await approval.expectResult((result) => expect(result).toEqual({ decision: "accept" }));
    expect(notifications).toEqual([
      "account/login/completed",
      "account/rateLimits/updated",
    ]);
    const transcript = server.transcript();
    expect(transcript.some((event) => event.generation === 2 && event.kind === "success")).toBe(true);
    expect(transcript.some((event) => event.generation === 6 && event.kind === "request" && event.method === "item/commandExecution/requestApproval")).toBe(true);
    expect(transcript.some((event) => event.generation === 5 && event.kind === "notification" && event.method === "account/login/completed")).toBe(true);
    await client.close();
  });

  test("keeps arbitrary payload sentinels out of transcript metadata and assertion errors", async () => {
    const server = createFakeCodexAppServer();
    const sentinel = "never-render-this-secret";
    const client = createClient(server, {
    });
    await initialize(server, client);

    const unexpected = client.startTurn({ threadId: "thread-1", text: sentinel, collaborationMode: "work", collaborationModePreset: { name: "Default", mode: "default", model: null, reasoningEffort: null }, selectedThreadModel: "gpt-5" });
    await server.expectClientRequest("unexpected/method").catch((error: unknown) => {
      expect(String(error)).not.toContain(sentinel);
      expect(String(error)).toContain("turn/start");
    });
    const closing = client.close();
    await unexpected.catch((error: unknown) => expect(error).toMatchObject({ code: "closed" }));
    expect(JSON.stringify(server.transcript())).not.toContain(sentinel);
    expect(() => server.request("item/tool/requestUserInput", { secret: sentinel }, { generation: -1 }))
      .toThrow("non-negative safe integer");
    await closing;
  });

  test("provides synthetic malformed, oversized, truncated, EOF, and crash transport controls", async () => {
    await expectFault((server) => server.sendMalformed(), "invalid_json");
    await expectFault((server) => server.sendOversized(), "frame_too_large");
    await expectFault((server) => server.endTruncated(), "truncated_frame");
    await expectFault((server) => server.eof(), "eof");

    const server = createFakeCodexAppServer();
    const client = createClient(server);
    const pending = client.initialize(initializeParams);
    await server.expectClientRequest("initialize");
    server.crash({ code: 9, signal: "SIGKILL" }, { generation: 11 });
    await pending.catch((error: unknown) => expect(error).toBeInstanceOf(CodexRpcError));
    expect(server.transcript()).toContainEqual({
      direction: "server_to_client",
      generation: 11,
      kind: "crash",
      code: 9,
      signal: "SIGKILL",
    });
  });

  test("disposes every outstanding expectation idempotently without leaking payloads", async () => {
    const server = createFakeCodexAppServer();
    const privateValues = [
      "https://auth.example.invalid/device?code=secret",
      "device-code-secret",
      "user-code-secret",
      "git status --private-command",
      "/private/workspace",
      "/private/bin/codex-app-server",
      "/private/codex-home",
      "native-input-secret",
    ];
    const requestWaiter = server.expectClientRequest("thread/start");
    const notificationWaiter = server.expectClientNotification("initialized");
    const nativeRequest = server.request("item/tool/requestUserInput", {
      authUrl: privateValues[0],
      deviceCode: privateValues[1],
      userCode: privateValues[2],
      command: privateValues[3],
      cwd: privateValues[4],
      executable: privateValues[5],
      codexHome: privateValues[6],
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      autoResolutionMs: null,
      questions: [{
        id: "target",
        header: "Target",
        question: privateValues[7],
        isOther: false,
        isSecret: false,
        options: null,
      }],
    });
    const nativeRequestWaiter = nativeRequest.expectResult();

    server.dispose();
    server.dispose();

    await expectDisposed(nativeRequestWaiter);
    await expectDisposed(notificationWaiter);
    await expectDisposed(requestWaiter);
    await expectDisposed(server.expectClientRequest("thread/start"));
    await expectDisposed(server.expectClientNotification("initialized"));
    expect(server.readable.destroyed).toBe(true);
    expect(server.writable.destroyed).toBe(true);
    for (const value of privateValues) {
      expect(JSON.stringify(server.transcript())).not.toContain(value);
    }
    expect(() => server.notify("account/login/completed", {
      verificationUrl: privateValues[0], deviceCode: privateValues[1],
    })).toThrow(DISPOSED_MESSAGE);
    expect(() => server.request("item/tool/requestUserInput", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1",
      autoResolutionMs: null,
      questions: [],
    })).toThrow(DISPOSED_MESSAGE);
    expect(() => server.sendRaw(Buffer.from(privateValues[7]!))).toThrow(DISPOSED_MESSAGE);
  });
});

const DISPOSED_MESSAGE = "Fake app-server is disposed";

async function expectDisposed(promise: Promise<unknown>): Promise<void> {
  await promise.then(
    () => { throw new Error("Expected fake app-server disposal"); },
    (error: unknown) => {
      expect(String(error)).toBe(`Error: ${DISPOSED_MESSAGE}`);
    },
  );
}

async function expectFault(
  emit: (server: FakeCodexAppServer) => void,
  code: "invalid_json" | "frame_too_large" | "truncated_frame" | "eof",
): Promise<void> {
  const server = createFakeCodexAppServer();
  const client = createClient(server);
  const pending = client.initialize(initializeParams);
  await server.expectClientRequest("initialize");
  emit(server);
  await pending.catch((error: unknown) => expect(error).toMatchObject({ code }));
}
