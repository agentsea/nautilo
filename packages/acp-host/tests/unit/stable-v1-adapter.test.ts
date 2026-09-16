import { describe, expect, test } from "bun:test";

import {
  ACP_MAX_LINE_BYTES,
  AcpPermissionUnsupportedError,
  AcpStableV1Adapter,
  type AcpAdapterEvent,
} from "../../src/index.js";

type Json = Record<string, unknown>;

class ByteControlAgent {
  readonly #toAgent = new TransformStream<Uint8Array, Uint8Array>();
  readonly #fromAgent = new TransformStream<Uint8Array, Uint8Array>();
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  readonly #output: WritableStream<Uint8Array>;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #resolveClosed: (() => void) | undefined;
  readonly closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });

  constructor(
    readonly onMessage: (message: Json, control: ByteControlAgent) => Promise<void> | void,
    beforeOutputWrite: (chunk: Uint8Array) => Promise<void> | void = () => undefined,
  ) {
    const target = this.#toAgent;
    this.#output = new WritableStream({
      write: async (chunk) => {
        await beforeOutputWrite(chunk);
        const writer = target.writable.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
      },
      close: async () => {
        const writer = target.writable.getWriter();
        try {
          await writer.close();
        } finally {
          writer.releaseLock();
        }
      },
      abort: async (reason) => {
        const writer = target.writable.getWriter();
        try {
          await writer.abort(reason);
        } finally {
          writer.releaseLock();
        }
      },
    });
  }

  get input(): ReadableStream<Uint8Array> {
    return this.#fromAgent.readable;
  }

  get output(): WritableStream<Uint8Array> {
    return this.#output;
  }

  start(): void {
    void this.#receive().catch(() => undefined);
  }

  async send(message: Json): Promise<void> {
    this.#writer ??= this.#fromAgent.writable.getWriter();
    await this.#writer.write(this.#encoder.encode(`${JSON.stringify(message)}\n`));
  }

  async sendBytes(bytes: Uint8Array): Promise<void> {
    this.#writer ??= this.#fromAgent.writable.getWriter();
    await this.#writer.write(bytes);
  }

  async close(): Promise<void> {
    await this.#writer?.close();
  }

  async #receive(): Promise<void> {
    const reader = this.#toAgent.readable.getReader();
    let pending = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        pending += this.#decoder.decode(next.value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line) await this.onMessage(JSON.parse(line) as Json, this);
          newline = pending.indexOf("\n");
        }
      }
    } finally {
      reader.releaseLock();
      this.#resolveClosed?.();
    }
  }
}

function createAdapter(
  onMessage: (message: Json, control: ByteControlAgent) => Promise<void> | void,
  options: Omit<ConstructorParameters<typeof AcpStableV1Adapter>[0], "input" | "output"> = {},
): { adapter: AcpStableV1Adapter; control: ByteControlAgent } {
  const control = new ByteControlAgent(onMessage);
  const adapter = new AcpStableV1Adapter({ input: control.input, output: control.output, ...options });
  control.start();
  return { adapter, control };
}

function isRequest(message: Json, method: string): message is Json & { id: string | number; method: string } {
  return message["method"] === method && (typeof message["id"] === "string" || typeof message["id"] === "number");
}

async function expectAcpError(run: Promise<unknown>, code: string): Promise<void> {
  try {
    await run;
    throw new Error("expected ACP adapter to reject");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("timed out waiting for bounded ACP containment")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function normalAgent(message: Json, control: ByteControlAgent): Promise<void> {
  if (isRequest(message, "initialize")) {
    await control.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentInfo: { name: "fixture", version: "1" }, unknown: "discarded" } });
  } else if (isRequest(message, "session/new")) {
    await control.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1", unknown: { ignored: true } } });
  } else if (isRequest(message, "session/prompt")) {
    await control.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" }, messageId: "message-1", unknown: "discarded" } } });
    await control.send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", usage: { totalTokens: 999 }, unknown: "discarded" } });
  }
}

describe("AcpStableV1Adapter", () => {
  test("uses direct stable-v1 initialize/new/prompt flow and discards unknown members", async () => {
    const events: AcpAdapterEvent[] = [];
    const methods: string[] = [];
    let negotiated: unknown;
    const { adapter, control } = createAdapter(async (message, agent) => {
      if (typeof message["method"] === "string") methods.push(message["method"]);
      await normalAgent(message, agent);
    }, {
      onEvent: (event) => {
        events.push(event);
      },
      onNegotiated: (capabilities) => { negotiated = capabilities; },
    });

    const result = await adapter.runTurn({ cwd: "/workspace", prompt: "hi" });
    expect(result).toEqual({ sessionId: "session-1", stopReason: "end_turn" });
    expect(events).toEqual([{ kind: "agent_text_chunk", sessionId: "session-1", messageId: "message-1", text: "hello" }]);
    expect(methods).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(negotiated).toEqual({
      execution: "supported",
      requests: "supported",
      stop: "unknown",
      resume: "unsupported",
      steer: "unsupported",
    });
    await control.closed;
  });

  test("selects only an advertised agent-owned session mode before prompt", async () => {
    const methods: string[] = [];
    let selected: unknown;
    const { adapter, control } = createAdapter(async (message, agent) => {
      if (typeof message["method"] === "string") methods.push(message["method"]);
      if (isRequest(message, "initialize")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      } else if (isRequest(message, "session/new")) {
        await agent.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId: "session-1",
            modes: {
              currentModeId: "default",
              availableModes: [
                { id: "default", name: "Default", description: "Ask before edits." },
                { id: "accept_edits", name: "Accept Edits", description: "Allow workspace edits." },
              ],
            },
          },
        });
      } else if (isRequest(message, "session/set_mode")) {
        selected = message["params"];
        await agent.send({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (isRequest(message, "session/prompt")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    }, { sessionModeId: "accept_edits" });

    const result = await adapter.runTurn({ cwd: "/workspace", prompt: "edit" });
    expect(result).toEqual({
      sessionId: "session-1",
      stopReason: "end_turn",
    });
    expect(methods).toEqual(["initialize", "session/new", "session/set_mode", "session/prompt"]);
    expect(selected).toEqual({ sessionId: "session-1", modeId: "accept_edits" });
    await control.closed;
  });

  test("fails closed before prompt when an agent-owned mode is not advertised", async () => {
    const methods: string[] = [];
    const { adapter, control } = createAdapter(async (message, agent) => {
      if (typeof message["method"] === "string") methods.push(message["method"]);
      if (isRequest(message, "initialize")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      } else if (isRequest(message, "session/new")) {
        await agent.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId: "session-1",
            modes: {
              currentModeId: "default",
              availableModes: [{ id: "default", name: "Default", description: "Ask before edits." }],
            },
          },
        });
      }
    }, { sessionModeId: "accept_edits" });

    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "edit" }), "invalid_response");
    expect(methods).toEqual(["initialize", "session/new"]);
    await control.closed;
  });

  test("rejects empty prompt and cwd before opening an ACP connection", async () => {
    const { adapter } = createAdapter(() => {
      throw new Error("adapter must not write for invalid host input");
    });
    await expectAcpError(adapter.runTurn({ cwd: "", prompt: "hi" }), "invalid_response");
    const second = new AcpStableV1Adapter({ input: new ReadableStream(), output: new WritableStream() });
    await expectAcpError(second.runTurn({ cwd: "/workspace", prompt: "" }), "invalid_response");
  });

  test("closes the listener-registration AbortSignal race before initialize can write", async () => {
    let reads = 0;
    let writes = 0;
    const racingSignal = {
      get aborted() { reads += 1; return reads >= 2; },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    const adapter = new AcpStableV1Adapter({
      input: new ReadableStream<Uint8Array>(),
      output: new WritableStream<Uint8Array>({ write: () => { writes += 1; } }),
      signal: racingSignal,
    });
    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "one" }), "closed");
    expect(writes).toBe(0);
  });

  test("Stop settles local permission admission then sends one exact stable session/cancel", async () => {
    let promptId: string | number | undefined;
    let promptStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    const wireMethods: string[] = [];
    const localOrder: string[] = [];
    const { adapter, control } = createAdapter(async (message, agent) => {
      if (typeof message["method"] === "string") {
        wireMethods.push(message["method"]);
      }
      if (isRequest(message, "initialize")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      } else if (isRequest(message, "session/new")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-stop" } });
      } else if (isRequest(message, "session/prompt")) {
        promptId = message.id;
        promptStarted?.();
      } else if (message["method"] === "session/cancel") {
        expect(message["params"]).toEqual({ sessionId: "session-stop" });
        if (promptId === undefined) throw new Error("prompt must precede Stop");
        await agent.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
      }
    }, {
      onStopping: () => { localOrder.push("permission-admission-closed"); },
    });

    const run = adapter.runTurn({ cwd: "/workspace", prompt: "wait" });
    await started;
    await Promise.all([adapter.stop(), adapter.stop()]);
    expect(await run).toEqual({ sessionId: "session-stop", stopReason: "cancelled" });
    expect(localOrder).toEqual(["permission-admission-closed"]);
    expect(wireMethods).toEqual(["initialize", "session/new", "session/prompt", "session/cancel"]);
    expect(wireMethods).not.toContain("$/cancel_request");
    await control.closed;
  });

  test("Stop-first writes one cancelled permission response before exact session/cancel", async () => {
    let promptId: string | number | undefined;
    let permissionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { permissionStarted = resolve; });
    let settlePermission: ((selection: { outcome: "cancelled" }) => void) | undefined;
    const wireOrder: string[] = [];
    const { adapter } = createAdapter(async (message, agent) => {
      if (isRequest(message, "initialize")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      } else if (isRequest(message, "session/new")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-race" } });
      } else if (isRequest(message, "session/prompt")) {
        promptId = message.id;
        await agent.send({
          jsonrpc: "2.0", id: "permission-race", method: "session/request_permission",
          params: {
            sessionId: "session-race",
            toolCall: { toolCallId: "tool-race", title: "Edit", kind: "edit" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
        });
        permissionStarted?.();
      } else if (message["id"] === "permission-race" && message["method"] === undefined) {
        wireOrder.push(`permission:${JSON.stringify(message["result"])}`);
      } else if (message["method"] === "session/cancel") {
        wireOrder.push("session/cancel");
        if (promptId === undefined) throw new Error("missing prompt");
        await agent.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
      }
    }, {
      onPermission: () => new Promise((resolve) => { settlePermission = resolve; }),
      onStopping: () => { settlePermission?.({ outcome: "cancelled" }); },
    });

    const run = adapter.runTurn({ cwd: "/workspace", prompt: "race" });
    await started;
    await adapter.stop();
    expect(await run).toEqual({ sessionId: "session-race", stopReason: "cancelled" });
    expect(wireOrder).toEqual([
      'permission:{"outcome":{"outcome":"cancelled"}}',
      "session/cancel",
    ]);
  });

  test("Human-first writes one selected permission response before later Stop", async () => {
    let promptId: string | number | undefined;
    let permissionWritten: (() => void) | undefined;
    const written = new Promise<void>((resolve) => { permissionWritten = resolve; });
    const wireOrder: string[] = [];
    const { adapter } = createAdapter(async (message, agent) => {
      if (isRequest(message, "initialize")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      } else if (isRequest(message, "session/new")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-human-first" } });
      } else if (isRequest(message, "session/prompt")) {
        promptId = message.id;
        await agent.send({
          jsonrpc: "2.0", id: "permission-human", method: "session/request_permission",
          params: {
            sessionId: "session-human-first",
            toolCall: { toolCallId: "tool-human" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
        });
      } else if (message["id"] === "permission-human" && message["method"] === undefined) {
        wireOrder.push(`permission:${JSON.stringify(message["result"])}`);
        permissionWritten?.();
      } else if (message["method"] === "session/cancel") {
        wireOrder.push("session/cancel");
        if (promptId === undefined) throw new Error("missing prompt");
        await agent.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
      }
    }, {
      onPermission: () => ({ outcome: "selected", optionId: "allow" }),
    });

    const run = adapter.runTurn({ cwd: "/workspace", prompt: "human first" });
    await written;
    await adapter.stop();
    expect(await run).toEqual({ sessionId: "session-human-first", stopReason: "cancelled" });
    expect(wireOrder).toEqual([
      'permission:{"outcome":{"outcome":"selected","optionId":"allow"}}',
      "session/cancel",
    ]);
  });

  test("rejects duplicate concurrent permission JSON-RPC IDs before Stop ordering can collapse", async () => {
    const { adapter } = createAdapter(async (message, agent) => {
      if (isRequest(message, "initialize")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      } else if (isRequest(message, "session/new")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-duplicate" } });
      } else if (isRequest(message, "session/prompt")) {
        const request = {
          jsonrpc: "2.0", id: "duplicate", method: "session/request_permission",
          params: {
            sessionId: "session-duplicate", toolCall: { toolCallId: "tool-duplicate" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
        };
        await agent.send(request);
        await agent.send(request);
      }
    }, { onPermission: () => new Promise(() => undefined) });
    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "duplicate" }), "invalid_response");
  });

  test("fails closed when initialize response lacks a supported protocol version", async () => {
    const { adapter } = createAdapter(async (message, control) => {
      if (isRequest(message, "initialize")) await control.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 2 } });
    });
    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response");
  });

  test("fails closed when session/new response lacks a bounded session ID", async () => {
    const { adapter } = createAdapter(async (message, control) => {
      if (isRequest(message, "initialize")) await control.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      if (isRequest(message, "session/new")) await control.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "" } });
    });
    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response");
  });

  test("fails closed when session/prompt response lacks a stable stop reason", async () => {
    const { adapter } = createAdapter(async (message, control) => {
      if (isRequest(message, "initialize")) await control.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      if (isRequest(message, "session/new")) await control.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
      if (isRequest(message, "session/prompt")) await control.send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "future_stop" } });
    });
    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response");
  });

  test("rejects an oversized fragmented NDJSON line before SDK parsing", async () => {
    const control = new ByteControlAgent(() => undefined);
    const adapter = new AcpStableV1Adapter({ input: control.input, output: control.output });
    control.start();
    const run = adapter.runTurn({ cwd: "/workspace", prompt: "hi" });
    await control.sendBytes(new Uint8Array(ACP_MAX_LINE_BYTES));
    await control.sendBytes(new Uint8Array([0x78, 0x0a]));
    await expectAcpError(run, "line_too_large");
  });

  test("rejects malformed raw NDJSON before SDK dispatch without leaking its content", async () => {
    const marker = "ACP_RAW_SECRET_MUST_NOT_LOG";
    const messages: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      messages.push(args);
    };
    try {
      const { adapter, control } = createAdapter(async (message, agent) => {
        if (isRequest(message, "initialize")) {
          await agent.sendBytes(new TextEncoder().encode(`{malformed:${marker}}\n`));
        }
      });
      await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response");
      await control.closed;
    } finally {
      console.error = originalError;
    }
    expect(JSON.stringify(messages)).not.toContain(marker);
  });

  test("rejects schema-invalid known updates before SDK logging and closes promptly", async () => {
    const marker = "ACP_KNOWN_UPDATE_SECRET_MUST_NOT_LOG";
    const messages: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      messages.push(args);
    };
    try {
      const { adapter, control } = createAdapter(async (message, agent) => {
        if (isRequest(message, "initialize")) await agent.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
        else if (isRequest(message, "session/new")) await agent.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
        else if (isRequest(message, "session/prompt")) {
          await agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: marker }, messageId: "" } } });
        }
      });
      await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response");
      await control.closed;
    } finally {
      console.error = originalError;
    }
    expect(JSON.stringify(messages)).not.toContain(marker);
  });

  test("sanitizes peer error envelopes before SDK propagation", async () => {
    const marker = "ACP_PEER_ERROR_SECRET_MUST_NOT_ESCAPE";
    const { adapter, control } = createAdapter(async (message, agent) => {
      if (isRequest(message, "initialize")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: marker, data: { marker } } });
      }
    });
    try {
      await adapter.runTurn({ cwd: "/workspace", prompt: "hi" });
      throw new Error("expected peer error");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_response", message: "ACP protocol operation failed" });
      expect(String(error)).not.toContain(marker);
    }
    await control.closed;
  });

  test("rejects unterminated EOF before SDK parsing and closes the host output", async () => {
    const control = new ByteControlAgent(() => undefined);
    const adapter = new AcpStableV1Adapter({ input: control.input, output: control.output });
    control.start();
    const run = adapter.runTurn({ cwd: "/workspace", prompt: "hi" });
    await control.sendBytes(new TextEncoder().encode('{"jsonrpc":"2.0"'));
    await control.close();
    await expectAcpError(run, "invalid_response");
    await control.closed;
  });

  test("rejects unknown inbound methods before the SDK can dispatch them", async () => {
    const { adapter, control } = createAdapter(async (message, agent) => {
      if (isRequest(message, "initialize")) {
        await agent.send({ jsonrpc: "2.0", id: "flood", method: "vendor/flood", params: {} });
      }
    });
    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response");
    await control.closed;
  });

  test("rejects an oversized inbound JSON-RPC ID before SDK correlation", async () => {
    const { adapter, control } = createAdapter(async (message, agent) => {
      if (isRequest(message, "initialize")) {
        await agent.send({
          jsonrpc: "2.0",
          id: "x".repeat(513),
          result: { protocolVersion: 1 },
        });
      }
    });
    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response");
    await control.closed;
  });

  test("enforces the outbound prewrite line limit before SDK output reaches the peer", async () => {
    const { adapter, control } = createAdapter(() => undefined, {
      limits: { maxLineBytes: 32 },
    });
    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "line_too_large");
    await control.closed;
  });

  test("rejects limit overrides above the locked D452 maxima", () => {
    expect(() => new AcpStableV1Adapter({
      input: new ReadableStream<Uint8Array>(),
      output: new WritableStream<Uint8Array>(),
      limits: { maxLineBytes: ACP_MAX_LINE_BYTES + 1 },
    })).toThrow(/no greater than D452 maxima/);
  });

  test("fails the scope when a slow semantic consumer exhausts the bounded update queue", async () => {
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, control } = createAdapter(async (message, agent) => {
      if (isRequest(message, "initialize")) await agent.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      if (isRequest(message, "session/new")) await agent.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
      if (isRequest(message, "session/prompt")) {
        for (let index = 0; index <= 128; index += 1) {
          await agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${index}` } } } });
        }
      }
    }, { onEvent: () => slow });
    const run = adapter.runTurn({ cwd: "/workspace", prompt: "hi" });
    await expectAcpError(run, "update_overflow");
    release?.();
    await control.close().catch(() => undefined);
  });

  test("rejects pre-session and foreign-session updates instead of projecting them", async () => {
    const { adapter } = createAdapter(async (message, control) => {
      if (isRequest(message, "initialize")) {
        await control.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "foreign", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "no" } } } });
      }
    });
    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response");
  });

  test("validates permission options and returns only the exact selected option", async () => {
    let response: Json | undefined;
    let promptId: string | number | undefined;
    const { adapter } = createAdapter(async (message, control) => {
      if (isRequest(message, "initialize")) await control.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      else if (isRequest(message, "session/new")) await control.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
      else if (isRequest(message, "session/prompt")) {
        promptId = message.id;
        await control.send({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: "tool-1" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
      } else if (message["id"] === "permission-1") {
        response = message;
        await control.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      }
    }, { onPermission: () => ({ outcome: "selected", optionId: "allow" }) });
    const permissionTurn = await adapter.runTurn({ cwd: "/workspace", prompt: "hi" });
    expect(permissionTurn).toMatchObject({ stopReason: "end_turn" });
    expect(response).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "allow" } } });
  });

  test("fails and closes a host-refused permission without writing an ACP permission outcome", async () => {
    let permissionResponse: Json | undefined;
    const { adapter, control } = createAdapter(async (message, agent) => {
      if (isRequest(message, "initialize")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      } else if (isRequest(message, "session/new")) {
        await agent.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-unsupported" } });
      } else if (isRequest(message, "session/prompt")) {
        await agent.send({
          jsonrpc: "2.0",
          id: "permission-unsupported",
          method: "session/request_permission",
          params: {
            sessionId: "session-unsupported",
            toolCall: { toolCallId: "tool-unsupported" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
        });
      } else if (message["id"] === "permission-unsupported" && message["method"] === undefined) {
        permissionResponse = message;
      }
    }, {
      onPermission: () => { throw new AcpPermissionUnsupportedError(); },
    });

    await within(expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response"));
    await within(control.closed);
    expect(permissionResponse?.["result"]).toBeUndefined();
    expect(JSON.stringify(permissionResponse ?? {})).not.toContain("outcome");
  });

  test("fails closed on invalid tool update fields and too many permission options", async () => {
    const foreignTool = createAdapter(async (message, control) => {
      if (isRequest(message, "initialize")) await control.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      else if (isRequest(message, "session/new")) await control.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
      else if (isRequest(message, "session/prompt")) {
        await control.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "x".repeat(64 * 1024 + 1) } } });
      }
    });
    await expectAcpError(foreignTool.adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response");
    await foreignTool.control.closed;

    const manyOptions = createAdapter(async (message, control) => {
      if (isRequest(message, "initialize")) await control.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      else if (isRequest(message, "session/new")) await control.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
      else if (isRequest(message, "session/prompt")) {
        await control.send({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: "tool-1" }, options: Array.from({ length: 21 }, (_, index) => ({ optionId: `${index}`, name: `${index}`, kind: "allow_once" })) } });
      }
    });
    await expectAcpError(manyOptions.adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "invalid_response");
  });

  test("caps concurrent permission requests while their responses are in flight", async () => {
    const releases: (() => void)[] = [];
    const { adapter, control } = createAdapter(async (message, control) => {
      if (isRequest(message, "initialize")) await control.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      else if (isRequest(message, "session/new")) await control.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
      else if (isRequest(message, "session/prompt")) {
        for (let index = 0; index <= 16; index += 1) {
          await control.send({ jsonrpc: "2.0", id: `permission-${index}`, method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: `tool-${index}` }, options: [{ optionId: "cancel", name: "Cancel", kind: "reject_once" }] } });
        }
      }
    }, { onPermission: () => new Promise((resolve) => {
      releases.push(() => resolve({ outcome: "cancelled" }));
    }) });
    await expectAcpError(adapter.runTurn({ cwd: "/workspace", prompt: "hi" }), "permission_overflow");
    for (const release of releases) release();
    await control.closed;
  });

  test("caps total permissions even with fast callbacks while output is slow", async () => {
    const slowOutput = new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    let outboundWrites = 0;
    let permissionCallbacks = 0;
    const control = new ByteControlAgent(async (message, agent) => {
      if (isRequest(message, "initialize")) await agent.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      else if (isRequest(message, "session/new")) await agent.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
      else if (isRequest(message, "session/prompt")) {
        const payload = Array.from({ length: 17 }, (_, index) => JSON.stringify({ jsonrpc: "2.0", id: `fast-${index}`, method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: `tool-${index}` }, options: [{ optionId: "cancel", name: "Cancel", kind: "reject_once" }] } })).join("\n");
        await agent.sendBytes(new TextEncoder().encode(`${payload}\n`));
      }
    }, async () => {
      outboundWrites += 1;
      if (outboundWrites > 3) await slowOutput;
    });
    const adapter = new AcpStableV1Adapter({
      input: control.input,
      output: control.output,
      onPermission: () => {
        permissionCallbacks += 1;
        return { outcome: "cancelled" };
      },
    });
    control.start();
    const run = adapter.runTurn({ cwd: "/workspace", prompt: "hi" });
    await expectAcpError(run, "permission_overflow");
    expect(permissionCallbacks).toBe(16);
    await control.closed;
  });

  test("contains only stable root imports and no ActiveSession convenience use", async () => {
    const source = await Bun.file(new URL("../../src/stable-v1-adapter.ts", import.meta.url)).text();
    expect(source).toContain('from "@agentclientprotocol/sdk"');
    expect(source).not.toContain("experimental/");
    expect(source).not.toContain("ActiveSession");
    expect(source).not.toContain("unstable_");
  });
});
