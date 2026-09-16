import {
  BinaryAcquisitionError,
  BoundedBinaryAcquisitionOwner,
  type BinaryChunkSource,
  classifyBinaryAcquisitionError,
} from "./bounded-binary-acquisition";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";

type ArtifactBytes = (id: string, options?: {
  roomId?: string; signal?: AbortSignal; expectedBytes?: number; maxBytes?: number;
}) => Promise<ArrayBuffer>;
type BinaryReadResult<T> = { ok: true; data: T } | { ok: false; error: { code: string } };
type BinaryReadBridge = {
  binaryRead?: {
    open: (path: string) => Promise<BinaryReadResult<{ id: string; size: number; chunkSize: number }>>;
    read: (id: string, position: number) => Promise<BinaryReadResult<{
      bytes: Uint8Array; position: number; done: boolean;
    }>>;
    close: (id: string) => Promise<BinaryReadResult<null>>;
  };
  fs?: { stat: (path: string) => Promise<{ exists: boolean; size: number }> };
};

export type BinaryPreviewDependencies = {
  getWorkspaceArtifactBytesArrayBuffer: ArtifactBytes;
  desktopAPI: BinaryReadBridge | null | undefined;
};
export type BinaryPreviewResult =
  | { kind: "ready"; bytes: ArrayBuffer }
  | { kind: "too_large"; sizeBytes: number; maxBytes: number }
  | { kind: "error"; message: string };

class BinaryPreviewSourceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BinaryPreviewSourceError"; }
}
const sourceError = (code: string) => new BinaryPreviewSourceError(code);
const isSafeSize = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Process-wide preview ingress limit; excess work waits rather than failing sibling cards. */
const MAX_CONCURRENT_BINARY_PREVIEWS = 1;
let activePreviewAcquisitions = 0;
const previewWaiters: Array<() => void> = [];
async function acquirePreviewSlot(signal: AbortSignal, timeoutMs?: number): Promise<() => void> {
  if (signal.aborted) throw new DOMException("Binary acquisition was cancelled.", "AbortError");
  let reserved = false;
  if (activePreviewAcquisitions >= MAX_CONCURRENT_BINARY_PREVIEWS) {
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish(() => reject(new DOMException("Binary acquisition was cancelled.", "AbortError")));
      const finish = (done: () => void) => {
        signal.removeEventListener("abort", onAbort);
        if (timeout !== undefined) clearTimeout(timeout);
        const index = previewWaiters.indexOf(wake);
        if (index >= 0) previewWaiters.splice(index, 1);
        done();
      };
      const wake = () => finish(() => { reserved = true; resolve(); });
      previewWaiters.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) timeout = setTimeout(
        () => finish(() => reject(new BinaryAcquisitionError("timeout", "Binary acquisition timed out."))),
        timeoutMs,
      );
    });
  }
  // A releaser transfers its occupied slot directly to the selected waiter.
  // A new caller cannot observe a temporarily-free slot and jump that FIFO.
  if (!reserved) activePreviewAcquisitions += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = previewWaiters.shift();
    if (next !== undefined) next();
    else activePreviewAcquisitions -= 1;
  };
}

function deadlineAt(options: { timeoutMs?: number; deadlineAt?: number }): number | undefined {
  if (options.deadlineAt !== undefined) return options.deadlineAt;
  return options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
}

function remainingDeadline(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new BinaryAcquisitionError("timeout", "Binary acquisition timed out.");
  return remaining;
}

/** Rejects promptly without allowing a late local stat to open a binary session. */
async function withinDeadline<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  if (signal.aborted) throw new DOMException("Binary acquisition was cancelled.", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (timeout !== undefined) clearTimeout(timeout);
      done();
    };
    const onAbort = () => finish(() => reject(new DOMException("Binary acquisition was cancelled.", "AbortError")));
    if (timeoutMs !== undefined) {
      timeout = setTimeout(
        () => finish(() => reject(new BinaryAcquisitionError("timeout", "Binary acquisition timed out."))),
        timeoutMs,
      );
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error instanceof Error ? error : new Error("Local file metadata read failed."))),
    );
  });
}

function sourceErrorMessage(error: unknown): string {
  if (error instanceof BinaryPreviewSourceError) {
    if (error.code === "not_found" || error.code === "not_file") return "File no longer exists.";
    if (error.code === "unavailable") return "Desktop file bridge unavailable.";
    if (error.code === "mutated") return "File changed while it was being read.";
  }
  const failure = classifyBinaryAcquisitionError(error);
  if (failure.kind === "authorization") return "You are not authorized to read this file.";
  if (failure.kind === "timeout") return "Preview loading timed out.";
  if (failure.kind === "cancelled") return "Preview loading was cancelled.";
  return "Unable to load this file preview.";
}

/** Artifact authority remains in api-client; its private buffer is handed through unchanged. */
function createArtifactBinaryChunkSource(
  file: Extract<OpenFileTarget, { kind: "artifact" }>, getBytes: ArtifactBytes, maxBytes: number,
): BinaryChunkSource {
  return {
    ...(file.sizeBytes !== undefined ? { knownSize: file.sizeBytes } : {}),
    arrayBuffer: async (signal) => await getBytes(file.id, {
      maxBytes,
      ...(file.sizeBytes !== undefined ? { expectedBytes: file.sizeBytes } : {}),
      ...(file.roomId !== undefined ? { roomId: file.roomId } : {}),
      signal,
    }),
  };
}

/** Validates ordered IPC chunks and closes the opaque session idempotently. */
export function createCurrentFolderBinaryChunkSource(
  path: string, expectedSize: number, bridge: BinaryReadBridge | null | undefined,
): BinaryChunkSource {
  let sessionId: string | undefined;
  let closed = false;
  const close = async () => {
    if (closed || sessionId === undefined) return;
    closed = true;
    await bridge?.binaryRead?.close(sessionId).catch(() => undefined);
  };
  return {
    knownSize: expectedSize,
    async *chunks(signal) {
      if (!bridge?.binaryRead) throw sourceError("unavailable");
      const opened = await bridge.binaryRead.open(path);
      if (!opened.ok) throw sourceError(opened.error.code);
      sessionId = opened.data.id;
      try {
        if (signal.aborted) throw new DOMException("Binary acquisition was cancelled.", "AbortError");
        if (!isSafeSize(opened.data.size) || opened.data.size !== expectedSize || opened.data.chunkSize <= 0) throw sourceError("mutated");
        let position = 0;
        while (true) {
          if (signal.aborted) throw new DOMException("Binary acquisition was cancelled.", "AbortError");
          const read = await bridge.binaryRead.read(sessionId, position);
          if (!read.ok) throw sourceError(read.error.code);
          if (!(read.data.bytes instanceof Uint8Array) ||
            read.data.bytes.byteLength > opened.data.chunkSize ||
            read.data.bytes.byteLength > expectedSize - position) throw sourceError("mutated");
          const nextPosition = position + read.data.bytes.byteLength;
          // Electron returns the ordered file position *after* this chunk.
          // Validate that end offset before accepting bytes; comparing it with
          // the request's starting offset rejects every non-empty live read.
          if (read.data.position !== nextPosition) throw sourceError("mutated");
          position = nextPosition;
          if (read.data.bytes.byteLength > 0) yield read.data.bytes;
          if (read.data.done) {
            if (position !== expectedSize) throw sourceError("mutated");
            return;
          }
          if (read.data.bytes.byteLength === 0) throw sourceError("mutated");
        }
      } finally { await close(); }
    },
    cancel: close,
  };
}

/** Acquires one private ArrayBuffer under a caller-owned deadline/signal. */
export async function loadBinaryPreview(
  file: OpenFileTarget, dependencies: BinaryPreviewDependencies,
  options: { maxBytes: number; signal: AbortSignal; timeoutMs?: number; deadlineAt?: number },
): Promise<BinaryPreviewResult> {
  let knownSize: number | undefined = file.kind === "artifact" ? file.sizeBytes : undefined;
  const deadline = deadlineAt(options);
  let release: (() => void) | undefined;
  try {
    let source: BinaryChunkSource;
    if (file.kind === "artifact") source = createArtifactBinaryChunkSource(file, dependencies.getWorkspaceArtifactBytesArrayBuffer, options.maxBytes);
    else {
      const bridge = dependencies.desktopAPI;
      if (!bridge?.fs?.stat || !bridge.binaryRead) return { kind: "error", message: "Desktop file bridge unavailable." };
      const stat = await withinDeadline(
        bridge.fs.stat(file.path),
        options.signal,
        remainingDeadline(deadline),
      );
      // The race helper leaves the underlying desktop promise alone; never let
      // its late completion continue into binaryRead after cancellation/timeout.
      if (options.signal.aborted) throw new DOMException("Binary acquisition was cancelled.", "AbortError");
      remainingDeadline(deadline);
      if (!stat.exists) return { kind: "error", message: "File no longer exists." };
      if (!isSafeSize(stat.size)) return { kind: "error", message: "Unable to load this file preview." };
      knownSize = stat.size;
      if (knownSize > options.maxBytes) return { kind: "too_large", sizeBytes: knownSize, maxBytes: options.maxBytes };
      source = createCurrentFolderBinaryChunkSource(file.path, knownSize, bridge);
    }
    if (knownSize !== undefined && knownSize > options.maxBytes) return { kind: "too_large", sizeBytes: knownSize, maxBytes: options.maxBytes };
    release = await acquirePreviewSlot(options.signal, remainingDeadline(deadline));
    const owner = new BoundedBinaryAcquisitionOwner({ maxBytes: options.maxBytes });
    const remainingTimeout = remainingDeadline(deadline);
    return { kind: "ready", bytes: await owner.acquire(source, { ...options, ...(remainingTimeout !== undefined ? { timeoutMs: remainingTimeout } : {}) }) };
  } catch (error) {
    const failure = classifyBinaryAcquisitionError(error);
    if (failure.kind === "size") return { kind: "too_large", sizeBytes: knownSize ?? options.maxBytes + 1, maxBytes: options.maxBytes };
    return { kind: "error", message: sourceErrorMessage(error) };
  } finally { release?.(); }
}
