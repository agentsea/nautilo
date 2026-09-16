import type { Readable, Writable } from "node:stream";

/**
 * Private Desktop ↔ Relay Host protocol. This is deliberately not a model
 * tool catalogue: the finite kinds below describe transport callbacks and
 * lifecycle only. Tool names and semantic arguments remain opaque payloads
 * that Electron's existing dispatch authority validates.
 */
export const RELAY_HOST_PROTOCOL_VERSION = 1 as const;
export const RELAY_HOST_COMPONENT = "nautilo-relay-host" as const;

/**
 * The largest current single bridge item is one 32 MiB Computer Use PNG
 * projected as base64 (about 42.7 MiB); local-file and media transfers are
 * otherwise chunked or capped lower. 64 MiB preserves that existing product
 * contract while bounding allocation below ws' 100 MiB message ceiling. This
 * is a transport safety bound, not a new model/tool limit.
 */
export const RELAY_HOST_CONTROL_MAX_BYTES = 64 * 1024 * 1024;

export const RELAY_HOST_COMMANDS = [
  "connect",
  "disconnect",
  "update-capabilities",
] as const;
export type RelayHostCommand = (typeof RELAY_HOST_COMMANDS)[number];

export const RELAY_HOST_CALLBACKS = [
  "capabilities",
  "dispatch",
  "ssh-prepare",
  "mcp-configure",
  "mcp-preflight",
  "mcp-configure-with-outcome",
  "mcp-dispatch",
  "mcp-stop",
] as const;
export type RelayHostCallback = (typeof RELAY_HOST_CALLBACKS)[number];

export const RELAY_HOST_EVENTS = [
  "status",
  "topology",
  "authentication-required",
] as const;
export type RelayHostEvent = (typeof RELAY_HOST_EVENTS)[number];

export const RELAY_HOST_PORT_EVENTS = [
  "codex-registered",
  "codex-command",
  "codex-cancel",
  "codex-credit",
  "codex-request-response",
  "codex-disconnected",
  "acp-registered",
  "acp-readiness",
  "acp-prepare",
  "acp-start",
  "acp-contain",
  "acp-disconnected",
  "claude-connection-registered",
  "claude-connection-discover",
  "claude-connection-disconnected",
  "claude-execution-registered",
  "claude-execution-command",
  "claude-execution-disconnected",
] as const;
export type RelayHostPortEvent = (typeof RELAY_HOST_PORT_EVENTS)[number];

export const RELAY_HOST_TRANSPORTS = [
  "codex",
  "acp",
  "claude-connection",
  "claude-execution",
] as const;
export type RelayHostTransport = (typeof RELAY_HOST_TRANSPORTS)[number];

type Versioned = Readonly<{ protocolVersion: typeof RELAY_HOST_PROTOCOL_VERSION }>;
type Generated = Versioned & Readonly<{ generation: string }>;

export type RelayHostReadyMessage = Versioned & Readonly<{
  kind: "ready";
  component: typeof RELAY_HOST_COMPONENT;
  hostVersion: string;
  nonce: string;
}>;

export type RelayHostInitializeMessage = Versioned & Readonly<{
  kind: "initialize";
  requestId: string;
  generation: string;
  nonce: string;
  payload: unknown;
}>;

export type RelayHostCommandMessage = Generated & Readonly<{
  kind: "command";
  requestId: string;
  command: RelayHostCommand;
  payload?: unknown;
}>;

export type RelayHostCallbackResultMessage = Generated & Readonly<{
  kind: "callback-result";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}>;

export type RelayHostCancelCallbackMessage = Generated & Readonly<{
  kind: "cancel-callback";
  requestId: string;
}>;

export type RelayHostCallbackEventMessage = Generated & Readonly<{
  kind: "callback-event";
  requestId: string;
  event: "run-shell-progress" | "structured-ssh-progress" | "security-scan-progress";
  payload: unknown;
}>;

export type RelayHostMcpToolsChangedMessage = Generated & Readonly<{
  kind: "mcp-tools-changed";
  serverName: string;
  payload: unknown;
}>;

export type RelayHostTransportSendMessage = Generated & Readonly<{
  kind: "transport-send";
  transport: RelayHostTransport;
  payload: unknown;
}>;

export type RelayHostParentMessage =
  | RelayHostInitializeMessage
  | RelayHostCommandMessage
  | RelayHostCallbackResultMessage
  | RelayHostCancelCallbackMessage
  | RelayHostCallbackEventMessage
  | RelayHostMcpToolsChangedMessage
  | RelayHostTransportSendMessage;

export type RelayHostInitializedMessage = Generated & Readonly<{
  kind: "initialized";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}>;

export type RelayHostCommandResultMessage = Generated & Readonly<{
  kind: "command-result";
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}>;

export type RelayHostCallbackMessage = Generated & Readonly<{
  kind: "callback";
  requestId: string;
  callback: RelayHostCallback;
  payload?: unknown;
}>;

export type RelayHostCallbackCancelledMessage = Generated & Readonly<{
  kind: "callback-cancelled";
  requestId: string;
}>;

export type RelayHostEventMessage = Generated & Readonly<{
  kind: "event";
  event: RelayHostEvent;
  payload?: unknown;
}>;

export type RelayHostPortEventMessage = Generated & Readonly<{
  kind: "port-event";
  event: RelayHostPortEvent;
  payload?: unknown;
}>;

export type RelayHostChildMessage =
  | RelayHostReadyMessage
  | RelayHostInitializedMessage
  | RelayHostCommandResultMessage
  | RelayHostCallbackMessage
  | RelayHostCallbackCancelledMessage
  | RelayHostEventMessage
  | RelayHostPortEventMessage;

export type RelayHostControlMessage = RelayHostParentMessage | RelayHostChildMessage;

export class RelayHostProtocolError extends Error {
  constructor(readonly code: "invalid-frame" | "frame-too-large" | "invalid-message") {
    super(code);
    this.name = "RelayHostProtocolError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function member<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function versioned(value: Record<string, unknown>): boolean {
  return value["protocolVersion"] === RELAY_HOST_PROTOCOL_VERSION;
}

function generated(value: Record<string, unknown>): boolean {
  return versioned(value) && identifier(value["generation"]);
}

type ObjectScanFrame = {
  readonly kind: "object";
  readonly keys: Set<string>;
  state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
};
type ArrayScanFrame = {
  readonly kind: "array";
  state: "valueOrEnd" | "value" | "commaOrEnd";
};

/** Reject duplicate decoded object keys before JSON.parse can collapse them. */
function hasUniqueJsonObjectKeys(raw: string): boolean {
  let offset = 0;
  const frames: Array<ObjectScanFrame | ArrayScanFrame> = [];
  const primitive = /(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  const whitespace = (): void => {
    while (offset < raw.length && /[\t\n\r ]/.test(raw[offset] ?? "")) offset += 1;
  };
  const readString = (decode: boolean): string | null => {
    if (raw[offset] !== "\"") return null;
    const start = offset;
    offset += 1;
    while (offset < raw.length) {
      const character = raw[offset];
      offset += 1;
      if (character === "\"") {
        if (!decode) return "";
        try {
          const value: unknown = JSON.parse(raw.slice(start, offset));
          return typeof value === "string" ? value : null;
        } catch {
          return null;
        }
      }
      if (character === "\\") {
        if (offset >= raw.length) return null;
        const escape = raw[offset];
        offset += 1;
        if (escape === "u") {
          const digits = raw.slice(offset, offset + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) return null;
          offset += 4;
        } else if (!"\"\\/bfnrt".includes(escape ?? "")) return null;
      } else if (character !== undefined && character.charCodeAt(0) < 0x20) return null;
    }
    return null;
  };
  const pushValue = (): boolean => {
    const character = raw[offset];
    if (character === "\"") return readString(false) !== null;
    if (character === "{") {
      offset += 1;
      frames.push({ kind: "object", keys: new Set(), state: "keyOrEnd" });
      return true;
    }
    if (character === "[") {
      offset += 1;
      frames.push({ kind: "array", state: "valueOrEnd" });
      return true;
    }
    primitive.lastIndex = offset;
    const match = primitive.exec(raw);
    if (match === null) return false;
    offset = primitive.lastIndex;
    return true;
  };

  whitespace();
  if (raw[offset] !== "{") return false;
  offset += 1;
  frames.push({ kind: "object", keys: new Set(), state: "keyOrEnd" });
  while (frames.length > 0) {
    whitespace();
    const frame = frames[frames.length - 1];
    if (frame === undefined) return false;
    if (frame.kind === "object") {
      if (frame.state === "keyOrEnd") {
        if (raw[offset] === "}") { offset += 1; frames.pop(); continue; }
        frame.state = "key";
      }
      if (frame.state === "key") {
        const key = readString(true);
        if (key === null || frame.keys.has(key)) return false;
        frame.keys.add(key);
        frame.state = "colon";
        continue;
      }
      if (frame.state === "colon") {
        if (raw[offset] !== ":") return false;
        offset += 1;
        frame.state = "value";
        continue;
      }
      if (frame.state === "value") {
        frame.state = "commaOrEnd";
        if (!pushValue()) return false;
        continue;
      }
      if (raw[offset] === ",") { offset += 1; frame.state = "key"; continue; }
      if (raw[offset] === "}") { offset += 1; frames.pop(); continue; }
      return false;
    }
    if (frame.state === "valueOrEnd") {
      if (raw[offset] === "]") { offset += 1; frames.pop(); continue; }
      frame.state = "value";
    }
    if (frame.state === "value") {
      frame.state = "commaOrEnd";
      if (!pushValue()) return false;
      continue;
    }
    if (raw[offset] === ",") { offset += 1; frame.state = "value"; continue; }
    if (raw[offset] === "]") { offset += 1; frames.pop(); continue; }
    return false;
  }
  whitespace();
  return offset === raw.length;
}

/** Closed-envelope parser used on both ends before any callback is invoked. */
export function parseRelayHostControlMessage(value: unknown): RelayHostControlMessage {
  if (!record(value) || !versioned(value) || typeof value["kind"] !== "string") {
    throw new RelayHostProtocolError("invalid-message");
  }
  const kind = value["kind"];
  if (kind === "ready" && exact(value, ["protocolVersion", "kind", "component", "hostVersion", "nonce"])
    && value["component"] === RELAY_HOST_COMPONENT && identifier(value["hostVersion"]) && identifier(value["nonce"])) {
    return value as RelayHostReadyMessage;
  }
  if (kind === "initialize" && exact(value, ["protocolVersion", "kind", "requestId", "generation", "nonce", "payload"])
    && identifier(value["requestId"]) && identifier(value["generation"]) && identifier(value["nonce"])) {
    return value as RelayHostInitializeMessage;
  }
  if (!generated(value)) throw new RelayHostProtocolError("invalid-message");
  if (kind === "command" && exact(value, ["protocolVersion", "kind", "requestId", "generation", "command"], ["payload"])
    && identifier(value["requestId"]) && member(value["command"], RELAY_HOST_COMMANDS)) return value as RelayHostCommandMessage;
  if ((kind === "callback-result" || kind === "initialized" || kind === "command-result")
    && exact(value, ["protocolVersion", "kind", "requestId", "generation", "ok"], ["payload", "error"])
    && identifier(value["requestId"]) && typeof value["ok"] === "boolean"
    && (value["error"] === undefined || identifier(value["error"]))) return value as RelayHostControlMessage;
  if ((kind === "cancel-callback" || kind === "callback-cancelled")
    && exact(value, ["protocolVersion", "kind", "requestId", "generation"])
    && identifier(value["requestId"])) return value as RelayHostControlMessage;
  if (kind === "callback" && exact(value, ["protocolVersion", "kind", "requestId", "generation", "callback"], ["payload"])
    && identifier(value["requestId"]) && member(value["callback"], RELAY_HOST_CALLBACKS)) return value as RelayHostCallbackMessage;
  if (kind === "callback-event" && exact(value, ["protocolVersion", "kind", "requestId", "generation", "event", "payload"])
    && identifier(value["requestId"]) && (value["event"] === "run-shell-progress" || value["event"] === "structured-ssh-progress" || value["event"] === "security-scan-progress")) return value as RelayHostCallbackEventMessage;
  if (kind === "event" && exact(value, ["protocolVersion", "kind", "generation", "event"], ["payload"])
    && member(value["event"], RELAY_HOST_EVENTS)) return value as RelayHostEventMessage;
  if (kind === "port-event" && exact(value, ["protocolVersion", "kind", "generation", "event"], ["payload"])
    && member(value["event"], RELAY_HOST_PORT_EVENTS)) return value as RelayHostPortEventMessage;
  if (kind === "mcp-tools-changed" && exact(value, ["protocolVersion", "kind", "generation", "serverName", "payload"])
    && identifier(value["serverName"])) return value as RelayHostMcpToolsChangedMessage;
  if (kind === "transport-send" && exact(value, ["protocolVersion", "kind", "generation", "transport", "payload"])
    && member(value["transport"], RELAY_HOST_TRANSPORTS)) return value as RelayHostTransportSendMessage;
  throw new RelayHostProtocolError("invalid-message");
}

export function encodeRelayHostFrame(message: RelayHostControlMessage): Uint8Array {
  const parsed = parseRelayHostControlMessage(message);
  let body: Uint8Array;
  try {
    body = new TextEncoder().encode(JSON.stringify(parsed));
  } catch {
    throw new RelayHostProtocolError("invalid-message");
  }
  if (body.byteLength > RELAY_HOST_CONTROL_MAX_BYTES) throw new RelayHostProtocolError("frame-too-large");
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
}

export class RelayHostFrameDecoder {
  readonly #prefix = new Uint8Array(4);
  #prefixOffset = 0;
  #body: Uint8Array | null = null;
  #bodyOffset = 0;

  push(chunk: Uint8Array): RelayHostControlMessage[] {
    const messages: RelayHostControlMessage[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.#body === null) {
        const count = Math.min(4 - this.#prefixOffset, chunk.byteLength - offset);
        this.#prefix.set(chunk.subarray(offset, offset + count), this.#prefixOffset);
        this.#prefixOffset += count;
        offset += count;
        if (this.#prefixOffset < 4) break;
        const length = new DataView(this.#prefix.buffer).getUint32(0, false);
        if (length > RELAY_HOST_CONTROL_MAX_BYTES) throw new RelayHostProtocolError("frame-too-large");
        if (length === 0) throw new RelayHostProtocolError("invalid-frame");
        this.#body = new Uint8Array(length);
        this.#bodyOffset = 0;
      }
      const count = Math.min(this.#body.byteLength - this.#bodyOffset, chunk.byteLength - offset);
      this.#body.set(chunk.subarray(offset, offset + count), this.#bodyOffset);
      this.#bodyOffset += count;
      offset += count;
      if (this.#bodyOffset === this.#body.byteLength) {
        try {
          const raw = new TextDecoder("utf-8", { fatal: true }).decode(this.#body);
          if (!hasUniqueJsonObjectKeys(raw)) throw new RelayHostProtocolError("invalid-message");
          messages.push(parseRelayHostControlMessage(JSON.parse(raw)));
        } catch (error) {
          if (error instanceof RelayHostProtocolError) throw error;
          throw new RelayHostProtocolError("invalid-message");
        }
        this.#body = null;
        this.#bodyOffset = 0;
        this.#prefixOffset = 0;
      }
    }
    return messages;
  }

  finish(): void {
    if (this.#prefixOffset !== 0 || this.#body !== null) throw new RelayHostProtocolError("invalid-frame");
  }
}

export async function writeRelayHostFrame(output: Writable, message: RelayHostControlMessage): Promise<void> {
  const frame = encodeRelayHostFrame(message);
  if (output.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    output.once("drain", resolve);
    output.once("error", reject);
  });
}

export async function* readRelayHostFrames(input: Readable): AsyncGenerator<RelayHostControlMessage> {
  const decoder = new RelayHostFrameDecoder();
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array) && typeof chunk !== "string") throw new RelayHostProtocolError("invalid-frame");
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : Uint8Array.from(chunk);
    for (const message of decoder.push(bytes)) yield message;
  }
  decoder.finish();
}
