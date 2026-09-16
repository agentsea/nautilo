/**
 * Transport-neutral bounded binary ingress for preview consumers.
 *
 * Each authority adapter is responsible for authorizing its own bytes before
 * it exposes a chunk source. This owner only enforces lifecycle, memory, and
 * error semantics; it deliberately has no knowledge of paths, Artifact IDs,
 * or Electron IPC.
 */

const DEFAULT_BINARY_ACQUISITION_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_BINARY_ACQUISITION_MAX_CONCURRENT = 1;

export type BinaryAcquisitionFailureKind =
  | "authorization"
  | "acquisition"
  | "size"
  | "timeout"
  | "cancelled";

export class BinaryAcquisitionError extends Error {
  constructor(
    readonly kind: BinaryAcquisitionFailureKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BinaryAcquisitionError";
  }
}

/**
 * An authority-specific, ordered chunk producer. `cancel` must be idempotent;
 * it is called after every terminal outcome so Electron sessions can close as
 * soon as their bytes are assembled.
 */
export interface BinaryChunkSource {
  /** Authoritative size when the adapter can obtain it before reading. */
  readonly knownSize?: number;
  /**
   * Returns an authority-owned private buffer. The owner validates and hands
   * this exact buffer on without cloning it.
   */
  arrayBuffer?(signal: AbortSignal): Promise<ArrayBuffer>;
  /** Ordered chunks for transports that cannot hand off one private buffer. */
  chunks?(signal: AbortSignal): AsyncIterable<Uint8Array>;
  cancel?(reason?: unknown): void | Promise<void>;
}

export type BinaryAcquisitionOptions = {
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
};

export type BoundedBinaryAcquisitionOwnerOptions = {
  maxBytes?: number;
  maxConcurrent?: number;
};

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function abortError(): DOMException {
  return new DOMException("Binary acquisition was cancelled.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function authorizationStatus(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function isSizeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "size";
}

/** Maps transport failures without importing a particular authority adapter. */
export function classifyBinaryAcquisitionError(error: unknown): BinaryAcquisitionError {
  if (error instanceof BinaryAcquisitionError) return error;
  if (isAbortError(error)) {
    return new BinaryAcquisitionError("cancelled", "Binary acquisition was cancelled.", error);
  }
  if (authorizationStatus(error)) {
    return new BinaryAcquisitionError("authorization", "You are not authorized to read this file.", error);
  }
  if (isSizeError(error)) {
    return new BinaryAcquisitionError("size", "File is too large to preview.", error);
  }
  return new BinaryAcquisitionError("acquisition", "Unable to acquire file bytes.", error);
}

/**
 * Bounded staging blocks avoid retaining an unbounded list of source chunks.
 * Since ArrayBuffer has fixed length, an unknown-length source needs one final
 * exact-size copy. Known-size chunk sources allocate one exact output buffer
 * and fill it directly.
 */
class ByteCollector {
  private static readonly blockBytes = 64 * 1024;
  private readonly blocks: Uint8Array[] = [];
  private length = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array): void {
    if (chunk.byteLength > this.maxBytes - this.length) {
      throw new BinaryAcquisitionError("size", "File is too large to preview.");
    }
    let offset = 0;
    while (offset < chunk.byteLength) {
      const currentOffset = this.length % ByteCollector.blockBytes;
      if (this.blocks.length === 0 || currentOffset === 0) {
        this.blocks.push(
          new Uint8Array(Math.min(ByteCollector.blockBytes, this.maxBytes - this.length)),
        );
      }
      const target = this.blocks.at(-1)!;
      const targetOffset = this.length % ByteCollector.blockBytes;
      const count = Math.min(target.byteLength - targetOffset, chunk.byteLength - offset);
      target.set(chunk.subarray(offset, offset + count), targetOffset);
      this.length += count;
      offset += count;
    }
  }

  toArrayBuffer(): ArrayBuffer {
    const output = new Uint8Array(this.length);
    let outputOffset = 0;
    for (const block of this.blocks) {
      const count = Math.min(block.byteLength, this.length - outputOffset);
      if (count === 0) break;
      output.set(block.subarray(0, count), outputOffset);
      outputOffset += count;
    }
    return output.buffer;
  }

  get byteLength(): number {
    return this.length;
  }
}

/**
 * Owns bounded acquisitions for one preview lifecycle. Consumers can retain a
 * shared owner for their route to cap active transfers, or create one for a
 * single viewer. It has no retries by design.
 */
export class BoundedBinaryAcquisitionOwner {
  private readonly maxBytes: number;
  private readonly maxConcurrent: number;
  private active = 0;

  constructor(options: BoundedBinaryAcquisitionOwnerOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_BINARY_ACQUISITION_MAX_BYTES;
    const maxConcurrent = options.maxConcurrent ?? DEFAULT_BINARY_ACQUISITION_MAX_CONCURRENT;
    if (!isNonNegativeSafeInteger(maxBytes) || maxBytes === 0) {
      throw new Error("maxBytes must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive safe integer.");
    }
    this.maxBytes = maxBytes;
    this.maxConcurrent = maxConcurrent;
  }

  async acquire(source: BinaryChunkSource, options: BinaryAcquisitionOptions = {}): Promise<ArrayBuffer> {
    const maxBytes = options.maxBytes ?? this.maxBytes;
    if (!isNonNegativeSafeInteger(maxBytes) || maxBytes === 0 || maxBytes > this.maxBytes) {
      throw new BinaryAcquisitionError("size", "Invalid binary acquisition size limit.");
    }
    if (source.knownSize !== undefined && !isNonNegativeSafeInteger(source.knownSize)) {
      throw new BinaryAcquisitionError("acquisition", "Source reported an invalid file size.");
    }
    if (source.knownSize !== undefined && source.knownSize > maxBytes) {
      throw new BinaryAcquisitionError("size", "File is too large to preview.");
    }
    if (options.signal?.aborted) {
      await Promise.resolve(source.cancel?.(options.signal.reason ?? abortError())).catch(() => undefined);
      throw new BinaryAcquisitionError("cancelled", "Binary acquisition was cancelled.");
    }
    if (this.active >= this.maxConcurrent) {
      throw new BinaryAcquisitionError("acquisition", "Too many active binary acquisitions.");
    }

    this.active += 1;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const closeSourceOnAbort = (): void => {
      void Promise.resolve(source.cancel?.(controller.signal.reason)).catch(() => undefined);
    };
    controller.signal.addEventListener("abort", closeSourceOnAbort, { once: true });
    const abortFromCaller = (): void => controller.abort(options.signal?.reason ?? abortError());
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options.signal?.aborted) abortFromCaller();
    if (options.timeoutMs !== undefined) {
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        options.signal?.removeEventListener("abort", abortFromCaller);
        controller.signal.removeEventListener("abort", closeSourceOnAbort);
        this.active -= 1;
        throw new BinaryAcquisitionError("timeout", "Invalid binary acquisition timeout.");
      }
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("Binary acquisition timed out.", "TimeoutError"));
      }, options.timeoutMs);
    }

    let iterator: AsyncIterator<Uint8Array> | undefined;
    try {
      if (source.arrayBuffer !== undefined) {
        const bytes = await source.arrayBuffer(controller.signal);
        if (!(bytes instanceof ArrayBuffer)) {
          throw new BinaryAcquisitionError("acquisition", "Source returned invalid binary bytes.");
        }
        if (bytes.byteLength > maxBytes) {
          throw new BinaryAcquisitionError("size", "File is too large to preview.");
        }
        if (source.knownSize !== undefined && bytes.byteLength !== source.knownSize) {
          throw new BinaryAcquisitionError("acquisition", "File transfer ended before all bytes arrived.");
        }
        if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
        return bytes;
      }
      if (source.chunks === undefined) {
        throw new BinaryAcquisitionError("acquisition", "Source did not provide binary bytes.");
      }
      const knownOutput =
        source.knownSize === undefined ? undefined : new Uint8Array(source.knownSize);
      const collector = knownOutput === undefined ? new ByteCollector(maxBytes) : undefined;
      let received = 0;
      iterator = source.chunks(controller.signal)[Symbol.asyncIterator]();
      while (true) {
        if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
        const next = await iterator.next();
        if (next.done) break;
        const chunk = next.value;
        if (chunk.byteLength > maxBytes - received) {
          throw new BinaryAcquisitionError("size", "File is too large to preview.");
        }
        if (knownOutput !== undefined) {
          if (chunk.byteLength > knownOutput.byteLength - received) {
            throw new BinaryAcquisitionError("acquisition", "File transfer exceeded its expected size.");
          }
          knownOutput.set(chunk, received);
        } else {
          collector!.append(chunk);
        }
        received += chunk.byteLength;
      }
      if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
      if (source.knownSize !== undefined && received !== source.knownSize) {
        throw new BinaryAcquisitionError("acquisition", "File transfer ended before all bytes arrived.");
      }
      return knownOutput?.buffer ?? collector!.toArrayBuffer();
    } catch (error) {
      if (timedOut) {
        throw new BinaryAcquisitionError("timeout", "Binary acquisition timed out.", error);
      }
      if (controller.signal.aborted || isAbortError(error)) {
        throw new BinaryAcquisitionError("cancelled", "Binary acquisition was cancelled.", error);
      }
      throw classifyBinaryAcquisitionError(error);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
      controller.signal.removeEventListener("abort", closeSourceOnAbort);
      try {
        await iterator?.return?.();
      } finally {
        await source.cancel?.(controller.signal.reason);
        this.active -= 1;
      }
    }
  }

  /** Keeps timeout/cancellation ownership through the consumer handoff. */
  async acquireFor<T>(
    source: BinaryChunkSource,
    consume: (bytes: ArrayBuffer, signal: AbortSignal) => Promise<T> | T,
    options: BinaryAcquisitionOptions = {},
  ): Promise<T> {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new BinaryAcquisitionError("timeout", "Invalid binary acquisition timeout.");
    }
    if (options.signal?.aborted) {
      await Promise.resolve(source.cancel?.(options.signal.reason ?? abortError())).catch(() => undefined);
      throw new BinaryAcquisitionError("cancelled", "Binary acquisition was cancelled.");
    }
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort(options.signal?.reason ?? abortError());
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort(new DOMException("Binary acquisition timed out.", "TimeoutError"));
          }, options.timeoutMs);
    try {
      const bytes = await this.acquire(source, {
        ...options,
        signal: controller.signal,
        timeoutMs: undefined,
      });
      if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
      const result = await consume(bytes, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
      return result;
    } catch (error) {
      if (timedOut) {
        throw new BinaryAcquisitionError("timeout", "Binary acquisition timed out.", error);
      }
      if (controller.signal.aborted || isAbortError(error)) {
        throw new BinaryAcquisitionError("cancelled", "Binary acquisition was cancelled.", error);
      }
      throw classifyBinaryAcquisitionError(error);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
