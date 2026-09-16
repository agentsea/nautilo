import { PassThrough } from "node:stream";

export interface FakeTransportOptions {
  /** Test-only label; it is never placed in a JSON-RPC frame. */
  readonly generation?: number;
}

export interface FakeTranscriptEvent {
  readonly direction: "client_to_server" | "server_to_client";
  readonly generation: number;
  readonly kind: "request" | "notification" | "success" | "failure" | "raw" | "eof" | "crash" | "malformed";
  readonly method?: string;
  readonly id?: string | number;
  readonly byteLength?: number;
  readonly code?: number | null;
  readonly signal?: string | null;
}

export interface FakeClientRequest {
  readonly id: string | number;
  readonly method: string;
  reply(result: unknown, options?: FakeTransportOptions): void;
  fail(error: unknown, options?: FakeTransportOptions): void;
}

export interface FakeServerRequest {
  readonly id: string | number;
  readonly method: string;
  /**
   * Inspect the response while it is in flight. The fake never retains the
   * result, so callers must register before allowing the client to respond.
   */
  expectResult(inspect?: (result: unknown) => void): Promise<void>;
  expectFailure(inspect?: (error: unknown) => void): Promise<void>;
}

export interface FakeCrash {
  readonly code?: number | null;
  readonly signal?: string | null;
}

export interface FakeCodexAppServer {
  readonly readable: PassThrough;
  readonly writable: PassThrough;
  expectClientRequest(method: string): Promise<FakeClientRequest>;
  expectClientNotification(method: string): Promise<void>;
  notify(method: string, params: unknown, options?: FakeTransportOptions): void;
  request(method: string, params: unknown, options?: FakeTransportOptions): FakeServerRequest;
  sendRaw(bytes: Uint8Array, options?: FakeTransportOptions): void;
  sendMalformed(options?: FakeTransportOptions): void;
  sendOversized(options?: FakeTransportOptions): void;
  endTruncated(bytes?: Uint8Array, options?: FakeTransportOptions): void;
  eof(options?: FakeTransportOptions): void;
  crash(crash?: FakeCrash, options?: FakeTransportOptions): void;
  /** Ends both in-memory streams and rejects every outstanding expectation. */
  dispose(): void;
  transcript(): readonly FakeTranscriptEvent[];
}

type ClientEvent =
  | { readonly kind: "request"; readonly id: string | number; readonly method: string }
  | { readonly kind: "notification"; readonly method: string }
  | { readonly kind: "malformed" };

type ParsedClientFrame =
  | ClientEvent
  | { readonly kind: "success"; readonly id: string | number; readonly value: unknown }
  | { readonly kind: "failure"; readonly id: string | number; readonly value: unknown };

type PendingServerRequest = {
  readonly method: string;
  readonly resolveSuccess: (value: unknown) => void;
  readonly resolveFailure: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  settled: boolean;
};

const MAX_JSONL_FRAME_BYTES = 4 * 1024 * 1024;
const DISPOSED_MESSAGE = "Fake app-server is disposed";

function safeGeneration(options: FakeTransportOptions | undefined): number {
  const generation = options?.generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Fake app-server generation must be a non-negative safe integer");
  }
  return generation;
}

function safeId(value: unknown): string | number | null {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : null;
}

function recordFromClient(value: unknown): ParsedClientFrame {
  if (!isRecord(value)) return { kind: "malformed" };
  const id = safeId(value["id"]);
  const method = value["method"];
  if (typeof method === "string") {
    return id === null
      ? { kind: "notification", method }
      : { kind: "request", id, method };
  }
  if (id === null) return { kind: "malformed" };
  if (Object.hasOwn(value, "result")) return { kind: "success", id, value: value["result"] };
  if (Object.hasOwn(value, "error")) return { kind: "failure", id, value: value["error"] };
  return { kind: "malformed" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * In-memory JSONL app-server double. Its transcript deliberately contains
 * only protocol routing metadata; params, results, errors, and raw bytes are
 * consumed immediately and never stored or rendered by this helper.
 */
export function createFakeCodexAppServer(): FakeCodexAppServer {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const transcript: FakeTranscriptEvent[] = [];
  const clientEvents: ClientEvent[] = [];
  const clientWaiters: Array<{
    readonly resolve: (event: ClientEvent) => void;
    readonly reject: (reason: Error) => void;
  }> = [];
  const pendingServerRequests = new Map<string, PendingServerRequest>();
  let buffered = Buffer.alloc(0);
  let nextServerId = 1;
  let disposed = false;

  const add = (event: FakeTranscriptEvent) => transcript.push(Object.freeze(event));
  const disposedError = () => new Error(DISPOSED_MESSAGE);
  const assertActive = () => {
    if (disposed) throw disposedError();
  };
  const deliverClientEvent = (event: ClientEvent) => {
    const waiter = clientWaiters.shift();
    if (waiter) waiter.resolve(event);
    else clientEvents.push(event);
  };
  const nextClientEvent = (): Promise<ClientEvent> => {
    assertActive();
    const event = clientEvents.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolve, reject) => clientWaiters.push({ resolve, reject }));
  };
  const writeFrame = (frame: unknown, options?: FakeTransportOptions) => {
    assertActive();
    const generation = safeGeneration(options);
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    const value = frame as Record<string, unknown>;
    const id = safeId(value["id"]);
    const method = typeof value["method"] === "string" ? value["method"] : undefined;
    add({
      direction: "server_to_client",
      generation,
      kind: method ? (id === null ? "notification" : "request") : Object.hasOwn(value, "error") ? "failure" : "success",
      ...(method ? { method } : {}),
      ...(id === null ? {} : { id }),
      byteLength: bytes.byteLength,
    });
    readable.write(bytes);
  };
  const settleServerRequest = (event: Extract<ParsedClientFrame, { kind: "success" | "failure" }>): boolean => {
    const pending = pendingServerRequests.get(String(event.id));
    if (!pending || pending.settled) return false;
    pending.settled = true;
    pendingServerRequests.delete(String(event.id));
    if (event.kind === "success") pending.resolveSuccess(event.value);
    else pending.resolveFailure(event.value);
    return true;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    buffered = Buffer.alloc(0);
    clientEvents.splice(0, clientEvents.length);
    const error = disposedError();
    for (const waiter of clientWaiters.splice(0, clientWaiters.length)) {
      waiter.reject(error);
    }
    for (const pending of pendingServerRequests.values()) {
      if (!pending.settled) pending.reject(error);
    }
    pendingServerRequests.clear();
    readable.destroy();
    writable.destroy();
  };

  writable.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (true) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      let line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      let event: ParsedClientFrame;
      try {
        event = recordFromClient(JSON.parse(line.toString("utf8")) as unknown);
      } catch {
        event = { kind: "malformed" };
      }
      if (event.kind === "request") {
        add({ direction: "client_to_server", generation: 0, kind: "request", method: event.method, id: event.id, byteLength: line.byteLength });
      } else if (event.kind === "notification") {
        add({ direction: "client_to_server", generation: 0, kind: "notification", method: event.method, byteLength: line.byteLength });
      } else if (event.kind === "success" || event.kind === "failure") {
        add({ direction: "client_to_server", generation: 0, kind: event.kind, id: event.id, byteLength: line.byteLength });
        settleServerRequest(event);
        continue;
      } else {
        add({ direction: "client_to_server", generation: 0, kind: "malformed", byteLength: line.byteLength });
      }
      deliverClientEvent(event);
    }
  });

  return {
    readable,
    writable,
    async expectClientRequest(method) {
      const event = await nextClientEvent();
      if (event.kind !== "request" || event.method !== method) {
        throw new Error(`Expected client request ${method}, received ${event.kind === "request" ? event.method : event.kind}`);
      }
      return Object.freeze({
        id: event.id,
        method: event.method,
        reply: (result: unknown, options?: FakeTransportOptions) => writeFrame({ id: event.id, result }, options),
        fail: (error: unknown, options?: FakeTransportOptions) => writeFrame({ id: event.id, error }, options),
      });
    },
    async expectClientNotification(method) {
      const event = await nextClientEvent();
      if (event.kind !== "notification" || event.method !== method) {
        throw new Error(`Expected client notification ${method}, received ${event.kind === "notification" ? event.method : event.kind}`);
      }
    },
    notify(method, params, options) {
      assertActive();
      writeFrame({ method, params }, options);
    },
    request(method, params, options) {
      assertActive();
      const id = `s-${nextServerId++}`;
      const pending = {} as PendingServerRequest;
      const response = new Promise<{ readonly kind: "success" | "failure"; readonly value: unknown }>((resolve, reject) => {
        Object.assign(pending, {
          method,
          resolveSuccess: (value: unknown) => resolve({ kind: "success", value }),
          resolveFailure: (value: unknown) => resolve({ kind: "failure", value }),
          reject,
          settled: false,
        });
      });
      // A crash before a test begins awaiting the response is still observable
      // through expectResult/expectFailure, but must not create an unhandled
      // rejection in an unrelated test.
      void response.catch(() => undefined);
      pendingServerRequests.set(id, pending);
      writeFrame({ id, method, params }, options);
      return Object.freeze({
        id,
        method,
        async expectResult(inspect?: (result: unknown) => void) {
          const settled = await response;
          if (settled.kind !== "success") throw new Error(`Expected successful response for ${method}`);
          inspect?.(settled.value);
        },
        async expectFailure(inspect?: (error: unknown) => void) {
          const settled = await response;
          if (settled.kind !== "failure") throw new Error(`Expected failed response for ${method}`);
          inspect?.(settled.value);
        },
      });
    },
    sendRaw(bytes, options) {
      assertActive();
      add({ direction: "server_to_client", generation: safeGeneration(options), kind: "raw", byteLength: bytes.byteLength });
      readable.write(bytes);
    },
    sendMalformed(options) {
      assertActive();
      const bytes = Buffer.from('{"id":', "utf8");
      add({ direction: "server_to_client", generation: safeGeneration(options), kind: "malformed", byteLength: bytes.byteLength });
      readable.write(Buffer.concat([bytes, Buffer.from("\n", "utf8")]));
    },
    sendOversized(options) {
      assertActive();
      const bytes = Buffer.alloc(MAX_JSONL_FRAME_BYTES + 1, 0x20);
      add({ direction: "server_to_client", generation: safeGeneration(options), kind: "raw", byteLength: bytes.byteLength });
      readable.write(bytes);
    },
    endTruncated(bytes = Buffer.from('{"id":', "utf8"), options) {
      assertActive();
      add({ direction: "server_to_client", generation: safeGeneration(options), kind: "eof", byteLength: bytes.byteLength });
      readable.end(bytes);
    },
    eof(options) {
      assertActive();
      add({ direction: "server_to_client", generation: safeGeneration(options), kind: "eof" });
      readable.end();
    },
    crash(crash = {}, options) {
      assertActive();
      add({ direction: "server_to_client", generation: safeGeneration(options), kind: "crash", ...(crash.code === undefined ? {} : { code: crash.code }), ...(crash.signal === undefined ? {} : { signal: crash.signal }) });
      dispose();
    },
    dispose,
    transcript: () => Object.freeze([...transcript]),
  };
}
