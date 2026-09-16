import type { Writable } from "node:stream";
import { CodexRpcError } from "./rpc-types";

export const MAX_JSONL_FRAME_BYTES = 4 * 1024 * 1024;
export const JSONL_FRAME_STRUCTURE_LIMITS = Object.freeze({
  maxDepth: 128,
  maxNodes: 1_000_000,
});

export type RpcId = string | number;
export interface RpcRequestEnvelope {
  readonly kind: "request";
  readonly id: RpcId;
  readonly method: string;
  readonly params: unknown;
}
export interface RpcNotificationEnvelope {
  readonly kind: "notification";
  readonly method: string;
  readonly params: unknown;
}
export interface RpcSuccessEnvelope {
  readonly kind: "success";
  readonly id: RpcId;
  readonly result: unknown;
}
export interface RpcFailureEnvelope {
  readonly kind: "failure";
  readonly id: RpcId;
  readonly error: unknown;
}
export type RpcEnvelope =
  | RpcRequestEnvelope
  | RpcNotificationEnvelope
  | RpcSuccessEnvelope
  | RpcFailureEnvelope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is RpcId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

type JsonLexFrame =
  | { kind: "object"; state: "key" | "colon" | "value" | "after" }
  | { kind: "array"; state: "value" | "after" };

export function preflightJsonFrame(
  bytes: Uint8Array,
  limits: { readonly maxDepth: number; readonly maxNodes: number } =
    JSONL_FRAME_STRUCTURE_LIMITS,
): void {
  const stack: JsonLexFrame[] = [];
  let rootState: "value" | "after" = "value";
  let nodes = 0;
  const expectsValue = () => {
    const parent = stack.at(-1);
    return parent ? parent.state === "value" : rootState === "value";
  };
  const startValue = () => {
    if (!expectsValue()) return;
    if (stack.length > limits.maxDepth) {
      throw new CodexRpcError("invalid_frame");
    }
    nodes += 1;
    if (nodes > limits.maxNodes) throw new CodexRpcError("invalid_frame");
    const parent = stack.at(-1);
    if (parent) parent.state = "after";
    else rootState = "after";
  };
  const whitespace = (byte: number) =>
    byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index]!;
    if (whitespace(byte)) continue;
    const parent = stack.at(-1);
    if (byte === 0x22) {
      let closed = false;
      for (index += 1; index < bytes.byteLength; index += 1) {
        if (bytes[index] === 0x5c) index += 1;
        else if (bytes[index] === 0x22) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new CodexRpcError("invalid_json");
      if (parent?.kind === "object" && parent.state === "key") {
        parent.state = "colon";
      } else {
        startValue();
      }
      continue;
    }
    if (byte === 0x7b || byte === 0x5b) {
      if (!expectsValue()) continue;
      startValue();
      stack.push(byte === 0x7b
        ? { kind: "object", state: "key" }
        : { kind: "array", state: "value" });
      continue;
    }
    if (byte === 0x7d || byte === 0x5d) {
      stack.pop();
      continue;
    }
    if (byte === 0x3a) {
      if (parent?.kind === "object" && parent.state === "colon") {
        parent.state = "value";
      }
      continue;
    }
    if (byte === 0x2c) {
      if (parent?.kind === "object") parent.state = "key";
      else if (parent?.kind === "array") parent.state = "value";
      continue;
    }
    if (expectsValue()) {
      startValue();
      while (
        index + 1 < bytes.byteLength &&
        !whitespace(bytes[index + 1]!) &&
        ![0x2c, 0x5d, 0x7d].includes(bytes[index + 1]!)
      ) index += 1;
    }
  }
}

export function discriminateEnvelope(value: unknown): RpcEnvelope {
  if (!isRecord(value)) throw new CodexRpcError("invalid_frame");
  const hasId = Object.hasOwn(value, "id");
  const hasMethod = Object.hasOwn(value, "method");
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasMethod) {
    if (typeof value["method"] !== "string" || hasResult || hasError) {
      throw new CodexRpcError("invalid_frame");
    }
    const params = Object.hasOwn(value, "params") ? value["params"] : undefined;
    if (!hasId) return { kind: "notification", method: value["method"], params };
    if (!isId(value["id"])) throw new CodexRpcError("invalid_frame");
    return { kind: "request", id: value["id"], method: value["method"], params };
  }
  if (!hasId || !isId(value["id"]) || hasResult === hasError) {
    throw new CodexRpcError("invalid_frame");
  }
  if (hasResult) return { kind: "success", id: value["id"], result: value["result"] };
  return { kind: "failure", id: value["id"], error: value["error"] };
}

export class JsonlFramer {
  private buffered = Buffer.alloc(0);
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: Buffer): RpcEnvelope[] {
    const frames: RpcEnvelope[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      const lf = chunk.indexOf(0x0a, offset);
      if (lf < 0) {
        const remainder = chunk.subarray(offset);
        if (
          this.buffered.byteLength + remainder.byteLength >
          MAX_JSONL_FRAME_BYTES
        ) {
          throw new CodexRpcError("frame_too_large");
        }
        this.buffered = Buffer.concat([this.buffered, remainder]);
        return frames;
      }
      const segment = chunk.subarray(offset, lf);
      if (
        this.buffered.byteLength + segment.byteLength >
        MAX_JSONL_FRAME_BYTES
      ) {
        throw new CodexRpcError("frame_too_large");
      }
      let line =
        this.buffered.byteLength === 0
          ? segment
          : Buffer.concat([this.buffered, segment]);
      this.buffered = Buffer.alloc(0);
      offset = lf + 1;
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.byteLength === 0) throw new CodexRpcError("invalid_frame");
      preflightJsonFrame(line);
      let text: string;
      try {
        text = this.decoder.decode(line);
      } catch {
        throw new CodexRpcError("invalid_utf8");
      }
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new CodexRpcError("invalid_json");
      }
      frames.push(discriminateEnvelope(value));
    }
    return frames;
  }

  finish(): void {
    if (this.buffered.byteLength !== 0) {
      throw new CodexRpcError("truncated_frame");
    }
  }
}

export function serializeJsonl(value: unknown): Buffer {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new CodexRpcError("invalid_frame");
  }
  if (json === undefined) throw new CodexRpcError("invalid_frame");
  const bytes = Buffer.from(`${json}\n`, "utf8");
  if (bytes.byteLength - 1 > MAX_JSONL_FRAME_BYTES) {
    throw new CodexRpcError("frame_too_large");
  }
  return bytes;
}

interface WriteJob {
  readonly bytes: Buffer;
  readonly resolve: () => void;
  readonly reject: (error: CodexRpcError) => void;
  readonly control: boolean;
  settled: boolean;
}

export const WRITER_LIMITS = Object.freeze({
  dataFrames: 256,
  dataBytes: 8 * 1024 * 1024,
  controlFrames: 32,
  controlBytes: 512 * 1024,
});

export class SerializedJsonlWriter {
  private readonly control: WriteJob[] = [];
  private readonly regular: WriteJob[] = [];
  private pumping = false;
  private closed = false;
  private accepting = true;
  private active: WriteJob | undefined;
  private dataFrames = 0;
  private dataBytes = 0;
  private controlFrames = 0;
  private controlBytes = 0;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly writable: Writable) {}

  write(value: unknown, control = false): Promise<void> {
    if (this.closed || !this.accepting) {
      return Promise.reject(new CodexRpcError("closed"));
    }
    const bytes = serializeJsonl(value);
    const frames = control ? this.controlFrames : this.dataFrames;
    const byteCount = control ? this.controlBytes : this.dataBytes;
    const frameLimit = control ? WRITER_LIMITS.controlFrames : WRITER_LIMITS.dataFrames;
    const byteLimit = control ? WRITER_LIMITS.controlBytes : WRITER_LIMITS.dataBytes;
    if (frames + 1 > frameLimit || byteCount + bytes.byteLength > byteLimit) {
      return Promise.reject(new CodexRpcError("queue_full"));
    }
    if (control) {
      this.controlFrames += 1;
      this.controlBytes += bytes.byteLength;
    } else {
      this.dataFrames += 1;
      this.dataBytes += bytes.byteLength;
    }
    const queue = control ? this.control : this.regular;
    return new Promise<void>((resolve, reject) => {
      queue.push({ bytes, resolve, reject, control, settled: false });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed) {
        const job = this.control.shift() ?? this.regular.shift();
        if (!job) break;
        this.active = job;
        try {
          await new Promise<void>((resolve, reject) => {
            let callbackDone = false;
            let drainDone = false;
            let settled = false;
            const cleanup = () => {
              this.writable.off("error", onError);
              this.writable.off("drain", onDrain);
            };
            const succeedIfComplete = () => {
              if (!settled && callbackDone && drainDone) {
                settled = true;
                cleanup();
                resolve();
              }
            };
            const onError = () => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new CodexRpcError("transport_failed"));
            };
            const onDrain = () => {
              drainDone = true;
              succeedIfComplete();
            };
            this.writable.once("error", onError);
            const accepted = this.writable.write(job.bytes, (error?: Error | null) => {
              if (error) {
                onError();
                return;
              }
              callbackDone = true;
              succeedIfComplete();
            });
            drainDone = accepted;
            if (!accepted) this.writable.once("drain", onDrain);
            succeedIfComplete();
          });
          this.settle(job);
        } catch {
          this.settle(job, new CodexRpcError("transport_failed"));
          this.failQueued(new CodexRpcError("transport_failed"));
          this.closed = true;
          this.accepting = false;
        } finally {
          if (this.active === job) this.active = undefined;
        }
      }
    } finally {
      this.pumping = false;
      this.notifyIdle();
    }
  }

  private settle(job: WriteJob, error?: CodexRpcError): void {
    if (job.settled) return;
    job.settled = true;
    if (job.control) {
      this.controlFrames -= 1;
      this.controlBytes -= job.bytes.byteLength;
    } else {
      this.dataFrames -= 1;
      this.dataBytes -= job.bytes.byteLength;
    }
    if (error) job.reject(error);
    else job.resolve();
  }

  private failQueued(error: CodexRpcError): void {
    for (const job of [...this.control.splice(0), ...this.regular.splice(0)]) {
      this.settle(job, error);
    }
  }

  private notifyIdle(): void {
    if (this.active || this.control.length > 0 || this.regular.length > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  abort(error = new CodexRpcError("transport_failed")): void {
    if (this.closed) return;
    this.accepting = false;
    this.closed = true;
    if (this.active) this.settle(this.active, error);
    this.failQueued(error);
    this.notifyIdle();
  }

  async close(timeoutMs: number): Promise<void> {
    if (this.closed) return;
    this.accepting = false;
    for (const job of this.regular.splice(0)) {
      this.settle(job, new CodexRpcError("closed"));
    }
    const idle = new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
      this.notifyIdle();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      idle,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (this.active) this.settle(this.active, new CodexRpcError("closed"));
    this.failQueued(new CodexRpcError("closed"));
    this.closed = true;
    this.notifyIdle();
  }
}
