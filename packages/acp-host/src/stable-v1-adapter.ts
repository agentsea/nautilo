import * as acp from "@agentclientprotocol/sdk";
import {
  validateAcpInitializeCapabilityTruth,
  type AcpCapabilityTruth,
} from "./capability-truth.js";

/** D452 locked pre-SDK NDJSON ceiling, including the newline delimiter. */
export const ACP_MAX_LINE_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_PERMISSION_OPTIONS = 20;
const MAX_PENDING_PERMISSIONS = 16;
const MAX_UPDATE_BACKLOG_COUNT = 128;
const MAX_UPDATE_BACKLOG_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export type AcpAdapterLimits = Readonly<{
  maxLineBytes: number;
  maxUpdateBacklogCount: number;
  maxUpdateBacklogBytes: number;
}>;

const DEFAULT_LIMITS: AcpAdapterLimits = {
  maxLineBytes: ACP_MAX_LINE_BYTES,
  maxUpdateBacklogCount: MAX_UPDATE_BACKLOG_COUNT,
  maxUpdateBacklogBytes: MAX_UPDATE_BACKLOG_BYTES,
};

export class AcpAdapterError extends Error {
  constructor(
    readonly code:
      | "invalid_response"
      | "line_too_large"
      | "update_overflow"
      | "permission_overflow"
      | "closed",
    message: string,
  ) {
    super(message);
    this.name = "AcpAdapterError";
  }
}

/**
 * A host-owned callback can throw this narrow marker to refuse permission
 * authority for the exact live turn. It is never translated into an ACP
 * permission selection or cancellation outcome.
 */
export class AcpPermissionUnsupportedError extends Error {
  constructor() {
    super("ACP permission authority is unsupported");
    this.name = "AcpPermissionUnsupportedError";
  }
}

export type AcpPermissionSelection =
  | Readonly<{ outcome: "cancelled" }>
  | Readonly<{ outcome: "selected"; optionId: string }>;

export type AcpPermissionRequest = Readonly<{
  sessionId: string;
  toolCallId: string;
  tool: Readonly<{ title: string | null; kind: string | null }>;
  options: readonly Readonly<{
    optionId: string;
    name: string;
    kind: string;
  }>[];
}>;

export type AcpAdapterEvent =
  | Readonly<{
      kind: "agent_text_chunk";
      sessionId: string;
      messageId: string | null;
      text: string;
    }>
  | Readonly<{
      kind: "tool_call";
      sessionId: string;
      toolCallId: string;
      title: string;
      status: "pending" | "in_progress" | "completed" | "failed" | null;
    }>;

export type AcpRunTurn = Readonly<{ cwd: string; prompt: string }>;
export type AcpTurnResult = Readonly<{
  sessionId: string;
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
}>;

export type AcpStableV1AdapterOptions = Readonly<{
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  onEvent?: (event: AcpAdapterEvent) => Promise<void> | void;
  onPermission?: (
    request: AcpPermissionRequest,
  ) => Promise<AcpPermissionSelection> | AcpPermissionSelection;
  onNegotiated?: (capabilities: AcpCapabilityTruth) => Promise<void> | void;
  /** Runs after the one stable session/new response and before prompt. */
  onSessionStarted?: (input: Readonly<{ sessionId: string; capabilities: AcpCapabilityTruth }>) => Promise<void> | void;
  /** Runs only after the bounded writer has completed the canonical prompt request write. */
  onPromptWritten?: (input: Readonly<{ sessionId: string; capabilities: AcpCapabilityTruth }>) => void;
  /** Runs once before the exact stable session/cancel notification is written. */
  onStopping?: () => Promise<void> | void;
  /** Optional agent-owned session mode selected after session/new and before prompt. */
  sessionModeId?: string;
  /** Supervisor-owned cancellation for pre-session handshake containment. */
  signal?: AbortSignal;
  limits?: Partial<AcpAdapterLimits>;
}>;

/**
 * Stable-v1 only, intentionally scoped to one initialize/new/prompt lifecycle.
 * It creates no active-session helper: SDK methods/correlation are used directly
 * and every host-visible item is admitted through a bounded semantic queue.
 */
export class AcpStableV1Adapter {
  readonly #input: ReadableStream<Uint8Array>;
  readonly #output: WritableStream<Uint8Array>;
  readonly #onEvent: (event: AcpAdapterEvent) => Promise<void> | void;
  readonly #onPermission: (
    request: AcpPermissionRequest,
  ) => Promise<AcpPermissionSelection> | AcpPermissionSelection;
  readonly #sessionModeId: string | undefined;
  readonly #limits: AcpAdapterLimits;
  readonly #onNegotiated: (capabilities: AcpCapabilityTruth) => Promise<void> | void;
  readonly #onSessionStarted: (input: Readonly<{ sessionId: string; capabilities: AcpCapabilityTruth }>) => Promise<void> | void;
  readonly #onPromptWritten: (input: Readonly<{ sessionId: string; capabilities: AcpCapabilityTruth }>) => void;
  readonly #onStopping: () => Promise<void> | void;
  readonly #signal: AbortSignal | undefined;
  #stopActive: (() => Promise<void>) | undefined;
  #stopPromise: Promise<void> | undefined;
  #waitForPermissionWrites: (() => Promise<void>) | undefined;
  #active = false;

  constructor(options: AcpStableV1AdapterOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#onPermission = options.onPermission ?? (() => ({ outcome: "cancelled" }));
    this.#sessionModeId = options.sessionModeId;
    this.#onNegotiated = options.onNegotiated ?? (() => undefined);
    this.#onSessionStarted = options.onSessionStarted ?? (() => undefined);
    this.#onPromptWritten = options.onPromptWritten ?? (() => undefined);
    this.#onStopping = options.onStopping ?? (() => undefined);
    this.#signal = options.signal;
    this.#limits = resolveLimits(options.limits);
  }

  /** Sends one stable session/cancel for the exact active session. */
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    const active = this.#stopActive;
    if (!active) {
      return Promise.reject(new AcpAdapterError("closed", "ACP turn has no active session to stop"));
    }
    this.#stopPromise = (async () => {
      await this.#onStopping();
      await this.#waitForPermissionWrites?.();
      await active();
    })();
    return this.#stopPromise;
  }

  async runTurn(turn: AcpRunTurn): Promise<AcpTurnResult> {
    if (this.#active) {
      throw new AcpAdapterError("closed", "one ACP adapter supports one active lifecycle");
    }
    if (this.#signal?.aborted) throw new AcpAdapterError("closed", "ACP turn was cancelled");
    this.#active = true;
    assertNonEmptyText(turn.cwd, "cwd");
    assertNonEmptyText(turn.prompt, "prompt");

    let fault: AcpAdapterError | undefined;
    const permissionWrites = new PermissionWriteBarrier();
    let rejectFault: ((error: AcpAdapterError) => void) | undefined;
    const faultPromise = new Promise<never>((_resolve, reject) => {
      rejectFault = reject as (error: AcpAdapterError) => void;
    });
    // Early AbortSignal containment can reject before the normal race is
    // installed below; retain a local handler for that narrow interval.
    void faultPromise.catch(() => undefined);
    const fail = (error: AcpAdapterError): void => {
      if (!fault) {
        fault = error;
        permissionWrites.fail(error);
        boundedReader.close();
        rejectFault?.(error);
      }
    };
    let liveSessionId: string | undefined;
    let negotiatedCapabilities: AcpCapabilityTruth | undefined;
    const eventQueue = new BoundedDispatchQueue<AcpAdapterEvent>(
      this.#limits.maxUpdateBacklogCount,
      this.#limits.maxUpdateBacklogBytes,
      (event) => serializedBytes(event),
      this.#onEvent,
      () => fail(new AcpAdapterError("update_overflow", "ACP update consumer is over capacity")),
    );
    const boundedWriter = createBoundedWriter(
      this.#output,
      this.#limits,
      fail,
      (id) => permissionWrites.written(id),
      () => {
        if (!liveSessionId || !negotiatedCapabilities) {
          fail(new AcpAdapterError("invalid_response", "ACP prompt write preceded session admission"));
          return;
        }
        this.#onPromptWritten({ sessionId: liveSessionId, capabilities: negotiatedCapabilities });
      },
    );
    const boundedReader = createBoundedReader(
      this.#input,
      this.#limits.maxLineBytes,
      fail,
      () => liveSessionId,
      (id) => permissionWrites.admit(id),
    );
    const onAbort = () => fail(new AcpAdapterError("closed", "ACP turn was cancelled"));
    this.#signal?.addEventListener("abort", onAbort, { once: true });
    // `AbortSignal` does not replay an already-fired event to a listener
    // added after the check above. Rechecking closes that admission race.
    if (this.#signal?.aborted) onAbort();
    if (fault) {
      this.#signal?.removeEventListener("abort", onAbort);
      permissionWrites.fail(fault);
      boundedReader.close();
      eventQueue.close();
      await boundedWriter.close().catch(() => undefined);
      throw fault;
    }
    this.#waitForPermissionWrites = () => permissionWrites.drain();
    const stream = acp.ndJsonStream(
      boundedWriter.stream,
      boundedReader.stream,
    );

    let pendingPermissions = 0;
    let admittedPermissions = 0;
    const client = acp
      .client({ name: "nautilo-acp-host" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        try {
          const event = validateUpdate(params, liveSessionId);
          if (event) eventQueue.push(event);
        } catch (error) {
          fail(toAdapterError(error));
          return;
        }
      })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        if (
          admittedPermissions >= MAX_PENDING_PERMISSIONS ||
          pendingPermissions >= MAX_PENDING_PERMISSIONS
        ) {
          fail(new AcpAdapterError("permission_overflow", "too many ACP permissions in one turn"));
          return { outcome: { outcome: "cancelled" } };
        }
        admittedPermissions += 1;
        pendingPermissions += 1;
        try {
          const request = validatePermissionRequest(params, liveSessionId);
          const selection = await this.#onPermission(request);
          return { outcome: validateSelection(selection, request.options) };
        } catch (error) {
          if (error instanceof AcpPermissionUnsupportedError) {
            const permissionFault = new AcpAdapterError(
              "invalid_response",
              "ACP permission authority is unsupported",
            );
            fail(permissionFault);
            // Throwing makes the SDK use its transport failure path. In
            // particular, no `result.outcome` is ever written for this
            // host-owned refusal, while the fault closes the exact turn.
            throw permissionFault;
          }
          fail(toAdapterError(error));
          return { outcome: { outcome: "cancelled" } };
        } finally {
          pendingPermissions -= 1;
        }
      });

    try {
      const operation = client.connectWith(stream, async (context) => {
        const initialize = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const capabilities = validateInitialize(initialize);
        negotiatedCapabilities = capabilities;
        await this.#onNegotiated(capabilities);
        throwIfFault(fault);

        const created = await context.request(acp.methods.agent.session.new, {
          cwd: turn.cwd,
          mcpServers: [],
        });
        const sessionId = validateNewSession(created);
        liveSessionId = sessionId;
        this.#stopActive = () => context.notify(acp.methods.agent.session.cancel, { sessionId });
        if (this.#sessionModeId !== undefined) {
          validateRequestedSessionMode(created, this.#sessionModeId);
          await context.request(acp.methods.agent.session.setMode, {
            sessionId,
            modeId: this.#sessionModeId,
          });
        }
        await this.#onSessionStarted({ sessionId, capabilities });
        throwIfFault(fault);

        const prompted = await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: turn.prompt }],
        });
        const stopReason = validatePrompt(prompted);
        throwIfFault(fault);
        return { sessionId, stopReason };
      });
      const result = await Promise.race([operation, faultPromise]);
      await eventQueue.drain();
      throwIfFault(fault);
      return result;
    } catch (error) {
      if (fault) throw toAdapterError(fault);
      throw toAdapterError(error);
    } finally {
      this.#signal?.removeEventListener("abort", onAbort);
      this.#stopActive = undefined;
      this.#waitForPermissionWrites = undefined;
      permissionWrites.fail(new AcpAdapterError("closed", "ACP permission writer is closed"));
      boundedReader.close();
      eventQueue.close();
      await boundedWriter.close().catch(() => undefined);
    }
  }
}

type BoundedInboundReader = Readonly<{ stream: ReadableStream<Uint8Array>; close: () => void }>;

function createBoundedReader(
  source: ReadableStream<Uint8Array>,
  maxLineBytes: number,
  fail: (error: AcpAdapterError) => void,
  currentSessionId: () => string | undefined,
  onPermissionRequest: (id: string | number) => void,
): BoundedInboundReader {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sourceReader: ReturnType<ReadableStream<Uint8Array>["getReader"]> | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      controller?.close();
    } catch {
      // A terminal controller is already closed; its source reader still needs cancellation.
    }
    void sourceReader?.cancel().catch(() => undefined);
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      controller = streamController;
      const reader = source.getReader();
      sourceReader = reader;
      const line = new Uint8Array(maxLineBytes);
      let lineBytes = 0;
      const reject = (error: AcpAdapterError): void => {
        fail(error);
        close();
      };
      try {
        while (!closed) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = next.value;
          for (let index = 0; index < chunk.byteLength; index += 1) {
            if (lineBytes === maxLineBytes) {
              reject(new AcpAdapterError("line_too_large", "ACP NDJSON line exceeds pre-SDK limit"));
              return;
            }
            line[lineBytes] = chunk[index] as number;
            lineBytes += 1;
            if (chunk[index] !== 0x0a) continue;
            try {
              const admitted = admitInboundEnvelope(
                line.subarray(0, lineBytes),
                currentSessionId(),
              );
              if (admitted?.["method"] === "session/request_permission" && isRequestId(admitted["id"])) {
                onPermissionRequest(admitted["id"]);
              }
              if (admitted) streamController.enqueue(encoder.encode(`${JSON.stringify(admitted)}\n`));
            } catch {
              reject(new AcpAdapterError("invalid_response", "ACP inbound message is not an admitted stable-v1 envelope"));
              return;
            }
            lineBytes = 0;
          }
        }
        if (!closed && lineBytes !== 0) {
          reject(new AcpAdapterError("invalid_response", "ACP input ended before an NDJSON message completed"));
          return;
        }
        if (!closed) streamController.close();
      } catch {
        reject(new AcpAdapterError("closed", "ACP inbound stream closed unexpectedly"));
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        sourceReader = undefined;
      }
    },
  });
  return { stream, close };
}

function createBoundedWriter(
  sink: WritableStream<Uint8Array>,
  limits: AcpAdapterLimits,
  fail: (error: AcpAdapterError) => void,
  onPermissionResponse: (id: string | number) => void,
  onPromptWritten: () => void,
): Readonly<{ stream: WritableStream<Uint8Array>; close: () => Promise<void> }> {
  let lineBytes = 0;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  let sinkClosed = false;
  let observedLine: number[] = [];
  const closeSink = async (): Promise<void> => {
    if (sinkClosed) return;
    sinkClosed = true;
    const writer = sink.getWriter();
    try {
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  };
  const write = async (chunk: Uint8Array): Promise<void> => {
    for (let index = 0; index < chunk.byteLength; index += 1) {
      lineBytes += 1;
      if (lineBytes > limits.maxLineBytes) {
        const error = new AcpAdapterError("line_too_large", "ACP outbound NDJSON line exceeds pre-write limit");
        fail(error);
        throw error;
      }
      if (chunk[index] === 0x0a) lineBytes = 0;
    }
    const scheduled = chain.then(async () => {
      const writer = sink.getWriter();
      try {
        await writer.write(chunk);
        for (const byte of chunk) {
          observedLine.push(byte);
          if (byte !== 0x0a) continue;
          observeOutboundResponse(new Uint8Array(observedLine), onPermissionResponse);
          observeOutboundPromptWrite(new Uint8Array(observedLine), onPromptWritten);
          observedLine = [];
        }
      } finally {
        writer.releaseLock();
      }
    });
    chain = scheduled.catch(() => undefined);
    try {
      await scheduled;
    } catch {
      const error = new AcpAdapterError("closed", "ACP outbound writer failed");
      fail(error);
      throw error;
    }
  };
  const stream = new WritableStream({
    write,
    async close() {
      if (closed) return;
      closed = true;
      await chain;
      if (lineBytes !== 0) {
        const error = new AcpAdapterError("line_too_large", "ACP outbound NDJSON stream ended with an unterminated line");
        fail(error);
        throw error;
      }
      await closeSink();
    },
    async abort(reason) {
      if (closed) return;
      closed = true;
      const writer = sink.getWriter();
      try {
        await writer.abort(reason);
      } finally {
        writer.releaseLock();
      }
    },
  });
  return {
    stream,
    async close() {
      await chain;
      if (!closed) {
        let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
        try {
          writer = stream.getWriter();
          await writer.close();
        } catch {
          // The SDK may hold the wrapper lock while it unwinds the connection.
        } finally {
          writer?.releaseLock();
        }
      }
      await closeSink().catch(() => undefined);
    },
  };
}

class PermissionWriteBarrier {
  readonly #pending = new Set<string>();
  readonly #waiters = new Set<Readonly<{ resolve: () => void; reject: (error: Error) => void }>>();
  #failure: Error | undefined;

  admit(id: string | number): void {
    const key = requestIdKey(id);
    if (this.#pending.has(key)) {
      throw new AcpAdapterError("invalid_response", "duplicate in-flight ACP request ID");
    }
    this.#pending.add(key);
  }

  written(id: string | number): void {
    this.#pending.delete(requestIdKey(id));
    if (this.#pending.size !== 0) return;
    for (const waiter of this.#waiters) waiter.resolve();
    this.#waiters.clear();
  }

  drain(): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => { this.#waiters.add({ resolve, reject }); });
  }

  fail(error: Error): void {
    this.#failure ??= error;
    for (const waiter of this.#waiters) waiter.reject(this.#failure);
    this.#waiters.clear();
  }
}

function observeOutboundResponse(
  line: Uint8Array,
  onPermissionResponse: (id: string | number) => void,
): void {
  try {
    const value = JSON.parse(strictDecoder.decode(line)) as unknown;
    const record = asRecord(value, "outbound response");
    if (record["method"] === undefined && isRequestId(record["id"]) && (Object.hasOwn(record, "result") || Object.hasOwn(record, "error"))) {
      onPermissionResponse(record["id"]);
    }
  } catch {
    // SDK output still passes its independent size/write checks; observation grants no authority.
  }
}

function observeOutboundPromptWrite(line: Uint8Array, onPromptWritten: () => void): void {
  try {
    const value = JSON.parse(strictDecoder.decode(line)) as unknown;
    const record = asRecord(value, "outbound request");
    if (record["method"] === "session/prompt" && isRequestId(record["id"])) onPromptWritten();
  } catch {
    // The canonical bounded writer remains authoritative; observation adds no authority.
  }
}

function requestIdKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

class BoundedDispatchQueue<T> {
  #items: T[] = [];
  #bytes = 0;
  #inFlightCount = 0;
  #inFlightBytes = 0;
  #draining: Promise<void> | undefined;
  #closed = false;
  readonly #countLimit: number;
  readonly #byteLimit: number;
  readonly #measure: (item: T) => number;
  readonly #consume: (item: T) => Promise<void> | void;
  readonly #overflow: () => void;

  constructor(
    countLimit: number,
    byteLimit: number,
    measure: (item: T) => number,
    consume: (item: T) => Promise<void> | void,
    overflow: () => void,
  ) {
    this.#countLimit = countLimit;
    this.#byteLimit = byteLimit;
    this.#measure = measure;
    this.#consume = consume;
    this.#overflow = overflow;
  }

  push(item: T): void {
    if (this.#closed) return;
    const size = this.#measure(item);
    if (
      this.#items.length + this.#inFlightCount + 1 > this.#countLimit ||
      this.#bytes + this.#inFlightBytes + size > this.#byteLimit
    ) {
      this.#closed = true;
      this.#items = [];
      this.#bytes = 0;
      this.#overflow();
      return;
    }
    this.#items.push(item);
    this.#bytes += size;
    this.#start();
  }

  async drain(): Promise<void> {
    await this.#draining;
  }

  close(): void {
    this.#closed = true;
    this.#items = [];
    this.#bytes = 0;
  }

  async #run(): Promise<void> {
    while (!this.#closed) {
      const item = this.#items.shift();
      if (!item) return;
      const size = this.#measure(item);
      this.#bytes -= size;
      this.#inFlightCount += 1;
      this.#inFlightBytes += size;
      try {
        await this.#consume(item);
      } catch {
        this.#closed = true;
        this.#items = [];
        this.#bytes = 0;
        this.#overflow();
        return;
      } finally {
        this.#inFlightCount -= 1;
        this.#inFlightBytes -= size;
      }
    }
  }

  #start(): void {
    if (this.#draining) return;
    const task = this.#run();
    this.#draining = task.finally(() => {
      this.#draining = undefined;
      if (!this.#closed && this.#items.length > 0) this.#start();
    });
  }
}

function validateInitialize(value: unknown): AcpCapabilityTruth {
  const record = asRecord(value, "initialize response");
  if (record["protocolVersion"] !== acp.PROTOCOL_VERSION) {
    throw new AcpAdapterError("invalid_response", "ACP initialize response has an unsupported protocol version");
  }
  if (record["agentInfo"] !== undefined && record["agentInfo"] !== null) {
    const agentInfo = asRecord(record["agentInfo"], "agentInfo");
    assertText(agentInfo["name"], "agentInfo.name");
    if (agentInfo["version"] !== undefined && agentInfo["version"] !== null) assertText(agentInfo["version"], "agentInfo.version");
  }
  return validateAcpInitializeCapabilityTruth(record);
}

function validateNewSession(value: unknown): string {
  const sessionId = asRecord(value, "session/new response")["sessionId"];
  assertIdentifier(sessionId, "sessionId");
  return sessionId;
}

function validateRequestedSessionMode(value: unknown, requestedModeId: string): void {
  assertIdentifier(requestedModeId, "session mode ID");
  const modes = asRecord(asRecord(value, "session/new response")["modes"], "session modes");
  const available = modes["availableModes"];
  if (!Array.isArray(available) || available.length === 0 || available.length > 20) {
    throw new AcpAdapterError("invalid_response", "ACP session modes are unavailable");
  }
  const supported = available.some((candidate) => {
    const record = asRecord(candidate, "session mode");
    assertIdentifier(record["id"], "session mode ID");
    return record["id"] === requestedModeId;
  });
  if (!supported) {
    throw new AcpAdapterError("invalid_response", "Requested ACP session mode is unavailable");
  }
}

function validatePrompt(value: unknown): AcpTurnResult["stopReason"] {
  const stopReason = asRecord(value, "session/prompt response")["stopReason"];
  if (
    stopReason !== "end_turn" &&
    stopReason !== "max_tokens" &&
    stopReason !== "max_turn_requests" &&
    stopReason !== "refusal" &&
    stopReason !== "cancelled"
  ) {
    throw new AcpAdapterError("invalid_response", "ACP prompt response has no stable stop reason");
  }
  return stopReason;
}

function validateUpdate(value: unknown, expectedSessionId: string | undefined): AcpAdapterEvent | undefined {
  const notification = asRecord(value, "session update");
  const sessionId = notification["sessionId"];
  assertIdentifier(sessionId, "session update sessionId");
  if (!expectedSessionId || sessionId !== expectedSessionId) {
    throw new AcpAdapterError("invalid_response", "ACP update does not belong to the live session");
  }
  const update = asRecord(notification["update"], "session update payload");
  const kind = update["sessionUpdate"];
  if (kind === "agent_message_chunk") {
    const content = asRecord(update["content"], "agent message content");
    if (content["type"] !== "text") return undefined;
    assertText(content["text"], "agent message text");
    const messageId = update["messageId"];
    if (messageId !== undefined && messageId !== null) assertIdentifier(messageId, "messageId");
    return { kind: "agent_text_chunk", sessionId, messageId: messageId ?? null, text: content["text"] };
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const toolCallId = update["toolCallId"];
    assertIdentifier(toolCallId, "toolCallId");
    const title = update["title"] ?? "";
    assertText(title, "tool title");
    const status = update["status"] ?? null;
    if (status !== null && status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "failed") {
      throw new AcpAdapterError("invalid_response", "ACP tool update has an invalid status");
    }
    return { kind: "tool_call", sessionId, toolCallId, title, status };
  }
  return undefined;
}

function validatePermissionRequest(value: unknown, expectedSessionId: string | undefined): AcpPermissionRequest {
  const request = asRecord(value, "permission request");
  const sessionId = request["sessionId"];
  assertIdentifier(sessionId, "permission sessionId");
  if (!expectedSessionId || sessionId !== expectedSessionId) {
    throw new AcpAdapterError("invalid_response", "ACP permission does not belong to the live session");
  }
  const toolCall = asRecord(request["toolCall"], "permission toolCall");
  const toolCallId = toolCall["toolCallId"];
  assertIdentifier(toolCallId, "permission toolCallId");
  const title = toolCall["title"] ?? null;
  if (title !== null) assertText(title, "permission tool title");
  const toolKind = toolCall["kind"] ?? null;
  if (toolKind !== null) assertIdentifier(toolKind, "permission tool kind");
  if (!Array.isArray(request["options"]) || request["options"].length > MAX_PERMISSION_OPTIONS) {
    throw new AcpAdapterError("invalid_response", "ACP permission options exceed the host limit");
  }
  const options = request["options"].map((item) => {
    const option = asRecord(item, "permission option");
    const optionId = option["optionId"];
    const name = option["name"];
    const kind = option["kind"];
    assertIdentifier(optionId, "permission optionId");
    assertText(name, "permission option name");
    assertIdentifier(kind, "permission option kind");
    return { optionId, name, kind } as const;
  });
  if (new Set(options.map((option) => option.optionId)).size !== options.length) {
    throw new AcpAdapterError("invalid_response", "ACP permission option IDs must be unique");
  }
  return { sessionId, toolCallId, tool: { title, kind: toolKind }, options };
}

function validateSelection(
  selection: AcpPermissionSelection,
  options: readonly Readonly<{ optionId: string }>[],
): acp.RequestPermissionOutcome {
  if (selection.outcome === "cancelled") return { outcome: "cancelled" };
  assertIdentifier(selection.optionId, "selected permission optionId");
  if (!options.some((option) => option.optionId === selection.optionId)) {
    throw new AcpAdapterError("invalid_response", "permission selection is not one of the offered options");
  }
  return { outcome: "selected", optionId: selection.optionId };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AcpAdapterError("invalid_response", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || encoder.encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new AcpAdapterError("invalid_response", `${label} must be bounded text`);
  }
}

function assertNonEmptyText(value: unknown, label: string): asserts value is string {
  assertText(value, label);
  if (value.length === 0) throw new AcpAdapterError("invalid_response", `${label} must not be empty`);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || encoder.encode(value).byteLength > MAX_IDENTIFIER_BYTES) {
    throw new AcpAdapterError("invalid_response", `${label} must be a bounded opaque identifier`);
  }
}

function serializedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function throwIfFault(fault: AcpAdapterError | undefined): asserts fault is undefined {
  if (fault) throw fault;
}

function toAdapterError(error: unknown): AcpAdapterError {
  if (error instanceof AcpAdapterError) return error;
  return new AcpAdapterError("invalid_response", "ACP protocol operation failed");
}

function admitInboundEnvelope(
  line: Uint8Array,
  expectedSessionId: string | undefined,
): Record<string, unknown> | undefined {
  const parsed = JSON.parse(strictDecoder.decode(line)) as unknown;
  const envelope = asRecord(parsed, "ACP inbound envelope");
  if (envelope["jsonrpc"] !== "2.0") throw new TypeError("not JSON-RPC 2.0");
  const method = envelope["method"];
  if (typeof method === "string") {
    if (method === "session/update") {
      if (envelope["id"] !== undefined || envelope["params"] === undefined) {
        throw new TypeError("invalid session update envelope");
      }
      const event = validateUpdate(envelope["params"], expectedSessionId);
      return event ? canonicalUpdateEnvelope(event) : undefined;
    }
    if (method === "session/request_permission") {
      if (!isRequestId(envelope["id"]) || envelope["params"] === undefined) {
        throw new TypeError("invalid permission envelope");
      }
      return canonicalPermissionEnvelope(
        envelope["id"],
        validatePermissionRequest(envelope["params"], expectedSessionId),
      );
    }
    throw new TypeError("unsupported inbound method");
  }
  if (!isRequestId(envelope["id"])) throw new TypeError("invalid response identifier");
  const hasResult = Object.hasOwn(envelope, "result");
  const hasError = Object.hasOwn(envelope, "error");
  if (hasResult === hasError) throw new TypeError("invalid response envelope");
  if (hasError) return canonicalErrorEnvelope(envelope["id"], envelope["error"]);
  return envelope;
}

function canonicalUpdateEnvelope(event: AcpAdapterEvent): Record<string, unknown> {
  if (event.kind === "agent_text_chunk") {
    return {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: event.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.text },
          ...(event.messageId === null ? {} : { messageId: event.messageId }),
        },
      },
    };
  }
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: event.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        title: event.title,
        ...(event.status === null ? {} : { status: event.status }),
      },
    },
  };
}

function canonicalPermissionEnvelope(
  id: string | number,
  request: AcpPermissionRequest,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId: request.sessionId,
      toolCall: {
        toolCallId: request.toolCallId,
        ...(request.tool.title === null ? {} : { title: request.tool.title }),
        ...(request.tool.kind === null ? {} : { kind: request.tool.kind }),
      },
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    },
  };
}

function canonicalErrorEnvelope(id: string | number, value: unknown): Record<string, unknown> {
  const error = asRecord(value, "ACP error response");
  if (!Number.isSafeInteger(error["code"]) || typeof error["message"] !== "string") {
    throw new TypeError("invalid error response");
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: error["code"], message: "ACP peer request failed" },
  };
}

function isRequestId(value: unknown): value is string | number {
  return (
    (typeof value === "string" &&
      value.length > 0 &&
      !value.includes("\0") &&
      encoder.encode(value).byteLength <= MAX_IDENTIFIER_BYTES) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function resolveLimits(overrides: Partial<AcpAdapterLimits> | undefined): AcpAdapterLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const maxima: AcpAdapterLimits = DEFAULT_LIMITS;
  for (const key of Object.keys(maxima) as (keyof AcpAdapterLimits)[]) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maxima[key]) {
      throw new TypeError("ACP adapter limits must be positive integers no greater than D452 maxima");
    }
  }
  return limits;
}
