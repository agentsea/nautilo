import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import corpusJson from "../../fixtures/0.146.0/protocol-corpus.json";
import {
  CodexRpcClient,
  DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
  DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS,
  MAX_APPROVAL_REQUEST_TIMEOUT_MS,
  type CodexRpcClientOptions,
} from "../../src/client";
import { MAX_JSONL_FRAME_BYTES } from "../../src/framing";
import {
  CodexRpcError,
  type ClientRequestParamsMap,
  type ClientResponseMap,
  type EnabledServerNotificationMethod,
  type EnabledServerRequestMethod,
  type RpcRuntimeDecoder,
  type ReviewedClientMethod,
  type ServerNotificationParamsMap,
  type ServerRequestParamsMap,
  type ServerRequestResponseMap,
} from "../../src/rpc-types";
import { createJsonlTestPeer, type JsonlTestPeer } from "../helpers/jsonl-peer";

const decoder: RpcRuntimeDecoder = {
  decodeError(value: unknown) {
    return value as { code: number; message: string };
  },
  decodeClientResponse<M extends keyof ClientResponseMap>(
    _method: M,
    value: unknown,
  ): ClientResponseMap[M] {
    return value as ClientResponseMap[M];
  },
  decodeServerRequest<M extends EnabledServerRequestMethod>(
    _method: M,
    value: unknown,
  ): ServerRequestParamsMap[M] {
    return value as ServerRequestParamsMap[M];
  },
  decodeServerRequestResponse<M extends EnabledServerRequestMethod>(
    _method: M,
    value: unknown,
  ): ServerRequestResponseMap[M] {
    return value as ServerRequestResponseMap[M];
  },
  decodeServerNotification<M extends EnabledServerNotificationMethod>(
    _method: M,
    value: unknown,
  ): ServerNotificationParamsMap[M] {
    return value as ServerNotificationParamsMap[M];
  },
};

const initializeParams: ClientRequestParamsMap["initialize"] = {
  clientName: "nautilo",
  clientTitle: "Nautilo",
  clientVersion: "0.1.0",
  experimentalApi: true,
};

function corpusFixture(id: string) {
  const fixture = corpusJson.fixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Missing protocol fixture: ${id}`);
  return fixture;
}

function createClient(
  peer: JsonlTestPeer,
  overrides: Partial<CodexRpcClientOptions> = {},
): CodexRpcClient {
  return new CodexRpcClient({
    readable: peer.clientReadable,
    writable: peer.clientWritable,
    decoder,
    delay: async () => {},
    ...overrides,
  });
}

async function initialize(client: CodexRpcClient, peer: JsonlTestPeer): Promise<void> {
  const pending = client.initialize(initializeParams);
  const request = await peer.nextClientFrame();
  expect(request).toMatchObject({ id: "c-1", method: "initialize" });
  const fixture = corpusFixture("initialize.success");
  const response = fixture?.frames.find(
    (frame) => frame.direction === "server_to_client",
  )?.message as { result: unknown };
  peer.send({ id: request["id"], result: response.result });
  await pending;
  expect(await peer.nextClientFrame()).toEqual({ method: "initialized" });
  expect(client.state).toBe("ready");
}

describe("CodexRpcClient", () => {
  test("initializes once and flushes initialized before becoming usable", async () => {
    const peer = createJsonlTestPeer();
    const client = createClient(peer);
    await initialize(client, peer);
    expect(() => client.initialize(initializeParams)).toThrow("protocol violation");
    await client.close();
  });

  test("concurrent close cannot reopen a stalled initialized handshake", async () => {
    const peer = createJsonlTestPeer();
    const faults: CodexRpcError[] = [];
    const client = createClient(peer, { onFault: (error) => faults.push(error) });
    const initialization = client.initialize(initializeParams);
    const request = await peer.nextClientFrame();
    peer.clientWritable.cork();
    const response = corpusFixture("initialize.success").frames[1]!.message as {
      result: unknown;
    };
    peer.send({ id: request["id"], result: response.result });
    await Bun.sleep(1);
    expect(client.state).toBe("initializing");
    const closing = client.close(5);
    await initialization.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "closed" }),
    );
    await closing;
    peer.clientWritable.uncork();
    expect(client.state).toBe("closed");
    expect(faults).toEqual([]);
  });

  test("correlates concurrent out-of-order responses with opaque string ids", async () => {
    const peer = createJsonlTestPeer();
    const client = createClient(peer);
    await initialize(client, peer);
    const first = client.readThread({ threadId: "a", includeTurns: false });
    const second = client.readThread({ threadId: "b", includeTurns: false });
    const one = await peer.nextClientFrame();
    const two = await peer.nextClientFrame();
    peer.send({ id: two["id"], result: { thread: { id: "b" } } });
    peer.send({ id: one["id"], result: { thread: { id: "a" } } }, true);
    expect((await first).thread.id).toBe("a");
    expect((await second).thread.id).toBe("b");
    await client.close();
  });

  test("exposes every reviewed enabled client method through typed params and results", async () => {
    const peer = createJsonlTestPeer();
    const client = createClient(peer);
    await initialize(client, peer);
    const calls = [
      client.startThread({ cwd: "/workspace" }),
      client.resumeThread({ threadId: "thread-1" }),
      client.readThread({ threadId: "thread-1" }),
      client.cancelLogin({ loginId: "login-1" }),
      client.logout(),
      client.getAuthStatus({ refreshToken: false }),
      client.archiveThread({ threadId: "thread-1" }),
      client.listThreads({ limit: 10 }),
      client.unarchiveThread({ threadId: "thread-1" }),
      client.startTurn({ threadId: "thread-1", text: "hello", collaborationMode: "work", collaborationModePreset: { name: "Default", mode: "default", model: null, reasoningEffort: null }, selectedThreadModel: "gpt-5" }),
      client.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }),
      client.steerTurn({
        threadId: "thread-1", text: "next", expectedTurnId: "turn-1",
      }),
      client.listModels({ includeHidden: false }),
      client.startLogin({ type: "chatgpt" }),
      client.readAccount({ refreshToken: false }),
      client.readRateLimits(),
      client.readUsage(),
    ];
    const methods = [
      "thread/start",
      "thread/resume",
      "thread/read",
      "account/login/cancel",
      "account/logout",
      "getAuthStatus",
      "thread/archive",
      "thread/list",
      "thread/unarchive",
      "turn/start",
      "turn/interrupt",
      "turn/steer",
      "model/list",
      "account/login/start",
      "account/read",
      "account/rateLimits/read",
      "account/usage/read",
    ];
    for (const method of methods) {
      const frame = await peer.nextClientFrame();
      expect(frame["method"]).toBe(method);
      peer.send({ id: frame["id"], result: {} });
    }
    await Promise.all(calls);
    await client.close();
  });

  test("times out and cancels locally while ignoring only retired late responses", async () => {
    const peer = createJsonlTestPeer();
    const client = createClient(peer);
    await initialize(client, peer);
    const timedOut = client.readThread(
      { threadId: "slow", includeTurns: false },
      { timeoutMs: 5 },
    );
    const timeoutFrame = await peer.nextClientFrame();
    await timedOut.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "timeout" }),
    );
    peer.send({ id: timeoutFrame["id"], result: { thread: {} } });

    const controller = new AbortController();
    const cancelled = client.readThread(
      { threadId: "cancel", includeTurns: false },
      { signal: controller.signal },
    );
    await peer.nextClientFrame();
    controller.abort();
    await cancelled.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "cancelled" }),
    );
    expect(client.state).toBe("ready");
    await client.close();
  });

  test("faults on unknown and duplicate completed response ids", async () => {
    const peer = createJsonlTestPeer();
    const faults: CodexRpcError[] = [];
    const client = createClient(peer, { onFault: (error) => faults.push(error) });
    await initialize(client, peer);
    peer.send(corpusFixture("transport-unknown-id").frames[0]!.message);
    await Bun.sleep(1);
    expect(client.state).toBe("faulted");
    expect(faults).toHaveLength(1);

    const peer2 = createJsonlTestPeer();
    const duplicateClient = createClient(peer2);
    await initialize(duplicateClient, peer2);
    const pending = duplicateClient.readThread({
      threadId: "a",
      includeTurns: false,
    });
    const frame = await peer2.nextClientFrame();
    peer2.send({ id: frame["id"], result: { thread: {} } });
    await pending;
    peer2.send({ id: frame["id"], result: { thread: {} } });
    await Bun.sleep(1);
    expect(duplicateClient.state).toBe("faulted");
  });

  test("retries only -32001 with fresh ids and one overall budget", async () => {
    const peer = createJsonlTestPeer();
    const client = createClient(peer, {
      random: () => 0,
      overloadDelayMs: () => 0,
    });
    await initialize(client, peer);
    const pending = client.readThread({ threadId: "a", includeTurns: false });
    const ids: unknown[] = [];
    const overloadFixture = corpusFixture("overload.error");
    const overloadError = (
      overloadFixture?.frames[0]?.message as { error: unknown }
    ).error;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const frame = await peer.nextClientFrame();
      ids.push(frame["id"]);
      peer.send({ id: frame["id"], error: overloadError });
    }
    const final = await peer.nextClientFrame();
    ids.push(final["id"]);
    peer.send({ id: final["id"], result: { thread: { id: "a" } } });
    await pending;
    expect(new Set(ids).size).toBe(3);

    const noRetry = client.readThread({ threadId: "b", includeTurns: false });
    const frame = await peer.nextClientFrame();
    peer.send({ id: frame["id"], error: { code: -32029, message: "rate limited" } });
    await noRetry.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "remote_error", remoteCode: -32029 }),
    );
    await client.close();
  });

  test("bounds overload exhaustion, abort during delay, and the overall deadline", async () => {
    const peer = createJsonlTestPeer();
    const client = createClient(peer, { overloadDelayMs: () => 0 });
    await initialize(client, peer);
    const exhausted = client.readThread({ threadId: "x", includeTurns: false });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const frame = await peer.nextClientFrame();
      peer.send({
        id: frame["id"],
        error: { code: -32001, message: "Server overloaded; retry later." },
      });
    }
    await exhausted.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "overloaded" }),
    );
    expect(client.state).toBe("ready");
    await client.close();

    const abortPeer = createJsonlTestPeer();
    const abortClient = createClient(abortPeer, {
      overloadDelayMs: () => 1,
      delay: async (_milliseconds, signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new CodexRpcError("cancelled")),
            { once: true },
          );
        }),
    });
    await initialize(abortClient, abortPeer);
    const controller = new AbortController();
    const aborted = abortClient.readThread(
      { threadId: "x", includeTurns: false },
      { signal: controller.signal },
    );
    const abortFrame = await abortPeer.nextClientFrame();
    abortPeer.send({
      id: abortFrame["id"],
      error: { code: -32001, message: "Server overloaded; retry later." },
    });
    controller.abort();
    await aborted.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "cancelled" }),
    );
    await abortClient.close();

    const deadlinePeer = createJsonlTestPeer();
    const deadlineClient = createClient(deadlinePeer, {
      overloadDelayMs: () => 0,
      delay: async () => await Bun.sleep(10),
    });
    await initialize(deadlineClient, deadlinePeer);
    const deadline = deadlineClient.readThread(
      { threadId: "x", includeTurns: false },
      { timeoutMs: 5 },
    );
    const deadlineFrame = await deadlinePeer.nextClientFrame();
    deadlinePeer.send({
      id: deadlineFrame["id"],
      error: { code: -32001, message: "Server overloaded; retry later." },
    });
    await deadline.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "timeout" }),
    );
    await deadlineClient.close();
  });

  test("answers typed server requests and sanitizes handler failure and timeout", async () => {
    const peer = createJsonlTestPeer();
    let observedExpiry: string | null = null;
    const client = createClient(peer, {
      serverRequestTimeoutMs: 5,
      serverRequestHandlers: {
        applyPatchApproval: async (_params, context) => {
          observedExpiry = context.expiresAt;
          return { decision: "approved" };
        },
        execCommandApproval: async () => ({ decision: "denied" }),
        "item/tool/requestUserInput": async () => {
          throw new Error("secret handler detail");
        },
        "item/permissions/requestApproval": async (_params, { signal }) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("late")));
          }),
      },
    });
    await initialize(client, peer);
    peer.send({
      id: "server-input", method: "item/tool/requestUserInput",
      params: { threadId: "thread", turnId: "turn", itemId: "item", questions: [] },
    });
    expect(await peer.nextClientFrame()).toEqual({
      id: "server-input", error: { code: -32603, message: "Request failed" },
    });
    peer.send({ id: "server-patch", method: "applyPatchApproval", params: {} });
    expect(await peer.nextClientFrame()).toEqual({
      id: "server-patch",
      result: { decision: "approved" },
    });
    expect(observedExpiry).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Date.parse(observedExpiry ?? "")).toBeGreaterThan(Date.now() - 100);
    peer.send({ id: "server-exec", method: "execCommandApproval", params: {} });
    expect(await peer.nextClientFrame()).toEqual({
      id: "server-exec",
      result: { decision: { denied: { rejection: "Denied by user." } } },
    });
    peer.send({ id: "server-2", method: "item/tool/requestUserInput", params: {} });
    expect(await peer.nextClientFrame()).toEqual({
      id: "server-2",
      error: { code: -32603, message: "Request failed" },
    });
    peer.send({ id: "server-3", method: "item/permissions/requestApproval", params: {} });
    expect(await peer.nextClientFrame()).toEqual({
      id: "server-3",
      error: { code: -32000, message: "Request failed" },
    });
    await client.close();
  });

  test("uses the upstream request id for resolved cleanup without a late response", async () => {
    const peer = createJsonlTestPeer();
    let observedRequestId: string | number | null = null;
    let signalAborted = false;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const notifications: string[] = [];
    const client = createClient(peer, {
      onNotification: ({ method }) => notifications.push(method),
      serverRequestHandlers: {
        "item/tool/requestUserInput": async (_params, context) => {
          observedRequestId = context.requestId;
          markStarted?.();
          await new Promise<never>((_resolve, reject) => {
            context.signal.addEventListener("abort", () => {
              signalAborted = true;
              reject(
                context.signal.reason instanceof Error
                  ? context.signal.reason
                  : new Error("request resolved"),
              );
            }, { once: true });
          });
          return { answers: {} };
        },
      },
    });
    await initialize(client, peer);
    peer.send({
      id: "upstream-request-7", method: "item/tool/requestUserInput",
      params: { threadId: "thread", turnId: "turn", itemId: "item", questions: [] },
    });
    await started;
    peer.send({
      method: "serverRequest/resolved",
      params: { threadId: "thread", requestId: "upstream-request-7" },
    });
    await Bun.sleep(5);
    expect(observedRequestId as string | number | null).toBe("upstream-request-7");
    expect(signalAborted).toBe(true);
    expect(notifications).toEqual(["serverRequest/resolved"]);
    expect(peer.queuedClientFrameCount()).toBe(0);
    await client.close();
  });

  test("uses method-sensitive request deadlines and caps native input at auto resolution", async () => {
    expect(DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(MAX_APPROVAL_REQUEST_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS).toBe(300_000);

    const peer = createJsonlTestPeer();
    const client = createClient(peer, {
      userInputRequestTimeoutMs: 50,
      serverRequestHandlers: {
        "item/tool/requestUserInput": async (_params, { signal }) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(
              signal.reason instanceof Error ? signal.reason : new Error("request expired"),
            ), { once: true });
          }),
      },
    });
    await initialize(client, peer);
    peer.send({
      id: "auto-resolution", method: "item/tool/requestUserInput",
      params: {
        threadId: "thread", turnId: "turn", itemId: "item", questions: [],
        autoResolutionMs: 5,
      },
    });
    expect(await peer.nextClientFrame()).toEqual({
      id: "auto-resolution", error: { code: -32000, message: "Request failed" },
    });
    await client.close();
  });

  test("faults enabled server-request decoder rejection without mapping or response", async () => {
    const peer = createJsonlTestPeer();
    const faults: CodexRpcError[] = [];
    const throwingDecoder: RpcRuntimeDecoder = {
      ...decoder,
      decodeServerRequest() {
        throw new Error("untrusted payload detail");
      },
    };
    const client = createClient(peer, {
      decoder: throwingDecoder,
      onFault: (error) => faults.push(error),
      serverRequestHandlers: {},
    });
    await initialize(client, peer);
    peer.send({
      id: "server-input", method: "item/tool/requestUserInput",
      params: { threadId: "thread", turnId: "turn", itemId: "item", questions: [] },
    });
    await Bun.sleep(1);
    expect(client.state).toBe("faulted");
    expect(peer.queuedClientFrameCount()).toBe(0);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ code: "protocol_violation" });
  });

  test("sanitizes and faults malformed handler results before serialization", async () => {
    const peer = createJsonlTestPeer();
    const faults: CodexRpcError[] = [];
    const rejectingResultDecoder: RpcRuntimeDecoder = {
      ...decoder,
      decodeServerRequestResponse() {
        throw new Error("handler result included forbidden detail");
      },
    };
    const client = createClient(peer, {
      decoder: rejectingResultDecoder,
      onFault: (error) => faults.push(error),
      serverRequestHandlers: {
        "item/tool/requestUserInput": async () => ({ answers: {} }),
      },
    });
    await initialize(client, peer);
    const request = {
      id: "server-input", method: "item/tool/requestUserInput",
      params: { threadId: "thread", turnId: "turn", itemId: "item", questions: [] },
    };
    peer.send(request);
    const response = await peer.nextClientFrame();
    expect(response).toEqual({
      id: (request as { id: unknown }).id,
      error: { code: -32603, message: "Request failed" },
    });
    expect(JSON.stringify(response)).not.toContain("secret");
    await Bun.sleep(1);
    expect(client.state).toBe("faulted");
    expect(faults).toHaveLength(1);
  });

  test("validates malformed JSON-RPC errors before overload classification and faults once", async () => {
    const peer = createJsonlTestPeer();
    const faults: CodexRpcError[] = [];
    const strictErrorDecoder: RpcRuntimeDecoder = {
      ...decoder,
      decodeError(value: unknown) {
        if (
          value === null || typeof value !== "object" ||
          typeof (value as { code?: unknown }).code !== "number" ||
          typeof (value as { message?: unknown }).message !== "string"
        ) throw new Error("malformed remote error");
        return value as { code: number; message: string };
      },
    };
    const client = createClient(peer, {
      decoder: strictErrorDecoder,
      onFault: (error) => faults.push(error),
    });
    await initialize(client, peer);
    const pending = client.readThread({
      threadId: "error",
      includeTurns: false,
    });
    const frame = await peer.nextClientFrame();
    peer.send({ id: frame["id"], error: { code: "-32001", message: "busy" } });
    await pending.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "protocol_violation" }),
    );
    await Bun.sleep(1);
    expect(client.state).toBe("faulted");
    expect(faults).toHaveLength(1);
  });

  test("faults malformed consumed notifications before invoking the notification mapper", async () => {
    const peer = createJsonlTestPeer();
    const faults: CodexRpcError[] = [];
    let mapped = false;
    const rejectingNotificationDecoder: RpcRuntimeDecoder = {
      ...decoder,
      decodeServerNotification() {
        throw new Error("malformed consumed notification");
      },
    };
    const client = createClient(peer, {
      decoder: rejectingNotificationDecoder,
      onFault: (error) => faults.push(error),
      onNotification: () => { mapped = true; },
    });
    await initialize(client, peer);
    peer.send({
      method: "turn/diff/updated",
      params: { threadId: "thread", turnId: "turn", diff: 1 },
    });
    await Bun.sleep(1);
    expect(client.state).toBe("faulted");
    expect(mapped).toBe(false);
    expect(faults).toHaveLength(1);
  });

  test("faults a malformed consumed response once before resolving it", async () => {
    const peer = createJsonlTestPeer();
    const faults: CodexRpcError[] = [];
    let initialized = false;
    const rejectingResponseDecoder: RpcRuntimeDecoder = {
      ...decoder,
      decodeClientResponse<M extends ReviewedClientMethod>(
        method: M,
        value: unknown,
      ): ClientResponseMap[M] {
        if (!initialized && method === "initialize") {
          initialized = true;
          return value as ClientResponseMap[M];
        }
        throw new Error("malformed response");
      },
    };
    const client = createClient(peer, {
      decoder: rejectingResponseDecoder,
      onFault: (error) => faults.push(error),
    });
    await initialize(client, peer);
    const pending = client.steerTurn({
      threadId: "thread", text: "next",
      expectedTurnId: "turn",
    });
    const frame = await peer.nextClientFrame();
    expect(frame["params"]).toEqual({
      threadId: "thread",
      input: [{ type: "text", text: "next", text_elements: [] }],
      expectedTurnId: "turn",
    });
    peer.send({ id: frame["id"], result: {} });
    await pending.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "protocol_violation" }),
    );
    expect(faults).toHaveLength(1);
  });

  test("fails initialize safely and rejects pending work exactly once on EOF", async () => {
    const peer = createJsonlTestPeer();
    const client = createClient(peer);
    const errorFixture = corpusFixture("transport-json-rpc-error");
    const initialization = client.initialize(initializeParams);
    const frame = await peer.nextClientFrame();
    expect(frame).toEqual(errorFixture.frames[0]!.message);
    peer.send(errorFixture.frames[1]!.message);
    await initialization.catch((error: unknown) =>
      expect(error).toMatchObject({
        code: "remote_error",
        message: "Codex app-server rejected the request",
      }),
    );
    expect(client.state).toBe("faulted");

    const peer2 = createJsonlTestPeer();
    const faults: CodexRpcError[] = [];
    const eofClient = createClient(peer2, { onFault: (error) => faults.push(error) });
    await initialize(eofClient, peer2);
    let rejections = 0;
    const pending = eofClient
      .readThread({ threadId: "pending", includeTurns: false })
      .catch((error: unknown) => {
        rejections += 1;
        throw error;
      });
    await peer2.nextClientFrame();
    peer2.end(Buffer.from('{"id":"truncated"'));
    await pending.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "truncated_frame" }),
    );
    await Bun.sleep(1);
    expect(rejections).toBe(1);
    expect(faults).toHaveLength(1);
  });

  test("classifies initialize timeout, cancellation, EOF, and pre-ready inbound request", async () => {
    const timeoutPeer = createJsonlTestPeer();
    const timeoutClient = createClient(timeoutPeer);
    const timeoutFixture = corpusFixture("transport-timeout");
    const timedOut = timeoutClient.initialize(initializeParams, { timeoutMs: 5 });
    expect(await timeoutPeer.nextClientFrame()).toEqual(
      timeoutFixture.frames[0]!.message,
    );
    expect(timeoutFixture.frames[1]!.message).toEqual({ event: "timeout" });
    await timedOut.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "timeout" }),
    );

    const cancelPeer = createJsonlTestPeer();
    const cancelClient = createClient(cancelPeer);
    const controller = new AbortController();
    const cancelFixture = corpusFixture("transport-cancellation");
    const cancelled = cancelClient.initialize(initializeParams, {
      signal: controller.signal,
    });
    expect(await cancelPeer.nextClientFrame()).toEqual(
      cancelFixture.frames[0]!.message,
    );
    expect(cancelFixture.frames[1]!.message).toEqual({ event: "abort" });
    controller.abort();
    await cancelled.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "cancelled" }),
    );

    const eofPeer = createJsonlTestPeer();
    const eofClient = createClient(eofPeer);
    const eof = eofClient.initialize(initializeParams);
    await eofPeer.nextClientFrame();
    expect(corpusFixture("transport-eof").frames[0]!.message).toEqual({
      event: "eof",
    });
    eofPeer.end();
    await eof.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "eof" }),
    );

    const earlyPeer = createJsonlTestPeer();
    const earlyClient = createClient(earlyPeer);
    const early = earlyClient.initialize(initializeParams);
    await earlyPeer.nextClientFrame();
    earlyPeer.send({ id: "early", method: "unsupported/method", params: {} });
    await early.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "protocol_violation" }),
    );
  });

  test("reserves unsupported inbound ids synchronously before stalled control writes", async () => {
    const peer = createJsonlTestPeer();
    const faults: CodexRpcError[] = [];
    const client = createClient(peer, { onFault: (error) => faults.push(error) });
    await initialize(client, peer);
    peer.clientWritable.cork();
    peer.send({ id: "duplicate", method: "unsupported/method", params: {} });
    peer.send({ id: "duplicate", method: "unsupported/method", params: {} });
    await Bun.sleep(1);
    expect(client.state).toBe("faulted");
    expect(faults).toHaveLength(1);
    peer.clientWritable.uncork();
  });

  test("queue saturation is nonfatal and rejects only the new request", async () => {
    const peer = createJsonlTestPeer();
    const client = createClient(peer);
    await initialize(client, peer);
    const oversized = client.readThread({
      threadId: "x".repeat(MAX_JSONL_FRAME_BYTES),
      includeTurns: false,
    });
    await oversized.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "frame_too_large" }),
    );
    expect(client.state).toBe("ready");
    peer.clientWritable.cork();
    const pending = Array.from({ length: 256 }, (_, index) =>
      client
        .readThread({ threadId: `thread-${index}`, includeTurns: false })
        .catch((error: unknown) => error),
    );
    const overflow = client.readThread({
      threadId: "overflow",
      includeTurns: false,
    });
    await overflow.catch((error: unknown) =>
      expect(error).toMatchObject({ code: "queue_full" }),
    );
    expect(client.state).toBe("ready");
    peer.clientWritable.uncork();
    await client.close(5);
    await Promise.allSettled(pending);
  });

  test("close during inbound and N outbound requests settles once without fault", async () => {
    const peer = createJsonlTestPeer();
    const faults: CodexRpcError[] = [];
    let markInboundStarted: (() => void) | undefined;
    const inboundStarted = new Promise<void>((resolve) => {
      markInboundStarted = resolve;
    });
    const client = createClient(peer, {
      onFault: (error) => faults.push(error),
      serverRequestHandlers: {
        "item/tool/requestUserInput": async (_params, { signal }) =>
          await new Promise((_resolve, reject) => {
            markInboundStarted?.();
            signal.addEventListener("abort", () => reject(new Error("closed")));
          }),
      },
    });
    await initialize(client, peer);
    peer.send({
      id: "inbound",
      method: "item/tool/requestUserInput",
      params: { threadId: "thread", turnId: "turn", itemId: "item", questions: [] },
    });
    await inboundStarted;
    const settlements = Array.from({ length: 20 }, (_, index) => {
      let count = 0;
      const promise = client
        .readThread({
          threadId: `pending-${index}`,
          includeTurns: false,
        })
        .catch((error: unknown) => {
          count += 1;
          expect(error).toMatchObject({ code: "closed" });
        });
      return { promise, count: () => count };
    });
    await client.close(10);
    await Promise.all(settlements.map(({ promise }) => promise));
    expect(settlements.every(({ count }) => count() === 1)).toBe(true);
    expect(faults).toEqual([]);
    expect(client.state).toBe("closed");
  });

  test("close is bounded and idempotent", async () => {
    const peer = createJsonlTestPeer();
    const client = createClient(peer);
    await initialize(client, peer);
    const closeOne = client.close(10);
    const closeTwo = client.close(10);
    expect(closeTwo).toBe(closeOne);
    await closeOne;
    expect(client.state).toBe("closed");
  });

  test("sanitizes readable and writable stream failures", async () => {
    const readable = new PassThrough();
    const faults: CodexRpcError[] = [];
    const failingWritable = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("sensitive write detail"));
      },
    });
    const writeClient = new CodexRpcClient({
      readable,
      writable: failingWritable,
      decoder,
      onFault: (error) => faults.push(error),
    });
    await writeClient.initialize(initializeParams).catch((error: unknown) =>
      expect(error).toMatchObject({
        code: "transport_failed",
        message: "Codex RPC transport failed",
      }),
    );
    expect(faults).toHaveLength(1);

    const peer = createJsonlTestPeer();
    const readFaults: CodexRpcError[] = [];
    const readClient = createClient(peer, {
      onFault: (error) => readFaults.push(error),
    });
    await initialize(readClient, peer);
    peer.clientReadable.destroy(new Error("sensitive read detail"));
    await Bun.sleep(1);
    expect(readClient.state).toBe("faulted");
    expect(readFaults).toHaveLength(1);
    expect(readFaults[0]?.message).toBe("Codex RPC transport failed");
  });
});
