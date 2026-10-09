import { createHash, randomUUID } from "node:crypto";
import { RunShellStreamRedactor, knownRunShellSecretValues } from "./run-shell-output-continuity";
import { searchLocalExecutionOutput, type LocalExecutionSearchProgress } from "./local-execution-search";
import {
  spawnLocalExecutionProcess,
  type LocalExecutionProcess,
  type LocalExecutionSpawner,
  type PreparedLocalExecution,
} from "./local-execution-process";

export type LocalExecutionState =
  | "starting" | "running" | "cancelling" | "completed" | "cancelled" | "failed" | "unknown";

export interface LocalExecutionSnapshot {
  readonly executionId: string;
  readonly state: LocalExecutionState;
  readonly tty: boolean;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly terminationScope: "owned_process_group";
  readonly output: {
    readonly data: string;
    readonly cursor: number;
    readonly nextCursor: number;
    readonly availableFrom: number;
    readonly produced: number;
    readonly gap: boolean;
    readonly hasMore: boolean;
  };
  readonly failureCode: string | null;
  readonly expiresAt: number | null;
  readonly resources: "pending" | "owned" | "released" | "release_failed";
}

export interface LocalExecutionRead {
  readonly executionId: string;
  /** Exact trusted binding, reauthorized by the Desktop dispatch adapter. */
  readonly ownerKey: string;
  /** Byte offset in the combined sanitized UTF-8 output stream. */
  readonly cursor: number;
  readonly maxBytes: number;
  /** Response wait only. Never terminates or restarts a process. */
  readonly yieldMs?: number;
}

export interface LocalExecutionStart {
  readonly executionId: string;
  readonly requestIdentity: string;
  readonly requestFingerprint: string;
  readonly ownerKey: string;
  /** Exact current Electron owner generation; stale work cannot be replayed. */
  readonly hostGeneration: string;
  readonly tty: boolean;
  readonly prepare: (signal: AbortSignal) => Promise<PreparedLocalExecution>;
  readonly signal?: AbortSignal | undefined;
}

export type LocalExecutionSearch = Omit<LocalExecutionRead, "yieldMs"> & { readonly literal: string };
export interface LocalExecutionSearchResult {
  readonly snapshot: LocalExecutionSnapshot;
  readonly search: LocalExecutionSearchProgress;
}

export interface LocalExecutionRetention {
  readonly maxOutputBytes: number;
  readonly maxTotalOutputBytes: number;
  /** Lifetime reservations in this generation, including expired tombstones. */
  readonly maxExecutions: number;
  readonly maxActiveExecutions: number;
  readonly completedTtlMs: number;
  readonly maxInputRequestsPerExecution: number;
}

type Entry = {
  request: Omit<LocalExecutionStart, "prepare" | "signal">;
  cancellationReserved: boolean;
  readonly preparationAbort: AbortController;
  prepare: ((signal: AbortSignal) => Promise<PreparedLocalExecution>) | null;
  readonly inputRequests: Map<string, { fingerprint: string; failureCode: string | null }>;
  capture: SanitizedCapture | null;
  readonly changed: Set<() => void>;
  process: LocalExecutionProcess | null;
  pid: number | null;
  prepared: PreparedLocalExecution | null;
  state: LocalExecutionState;
  exitCode: number | null;
  signal: string | null;
  failureCode: string | null;
  resources: LocalExecutionSnapshot["resources"];
  output: Buffer;
  produced: number;
  expiresAt: number | null;
  expired: boolean;
  cancelled: boolean;
  settled: boolean;
  removeAbort: () => void;
};

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Same existing streaming redaction, without a second retained inline copy. */
class SanitizedCapture {
  private readonly streams: Record<"stdout" | "stderr", {
    redactor: RunShellStreamRedactor; decoder: TextDecoder;
  }>;

  constructor(secrets: readonly Buffer[], private readonly appendOutput: (bytes: Buffer) => void) {
    this.streams = {
      stdout: { redactor: new RunShellStreamRedactor(secrets), decoder: new TextDecoder() },
      stderr: { redactor: new RunShellStreamRedactor(secrets), decoder: new TextDecoder() },
    };
  }

  append(stream: "stdout" | "stderr", raw: Buffer): void {
    const target = this.streams[stream];
    this.appendOutput(Buffer.from(target.decoder.decode(target.redactor.push(raw).bytes, { stream: true })));
  }

  finish(): void {
    for (const target of Object.values(this.streams)) {
      this.appendOutput(Buffer.from(target.decoder.decode(target.redactor.finish().bytes, { stream: true })));
      this.appendOutput(Buffer.from(target.decoder.decode()));
    }
  }
}

/**
 * Electron-owned execution records. Preparation and every public operation
 * require fresh admission in the caller; references carry no authority.
 * Human terminal sessions never enter this owner or acquire command receipts.
 */
export class LocalExecutionHost {
  readonly hostGeneration = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private readonly requests = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly launches = new Set<Promise<void>>();
  private readonly historyWrites = new Set<Promise<void>>();
  private readonly settlementListeners = new Set<(snapshot: LocalExecutionSnapshot, ownerKey: string) => Promise<void>>();
  private readonly fencedOwners = new Set<string>();
  private totalOutputBytes = 0;
  private disposed = false;

  constructor(private readonly options: {
    readonly retention: LocalExecutionRetention;
    readonly spawn?: LocalExecutionSpawner;
    readonly now?: () => number;
    readonly additionalRedactionSecrets?: () => readonly Buffer[];
  }) {
    const { maxOutputBytes, maxTotalOutputBytes, maxExecutions, maxActiveExecutions, completedTtlMs, maxInputRequestsPerExecution } = options.retention;
    for (const value of [maxOutputBytes, maxTotalOutputBytes, maxExecutions, maxActiveExecutions, completedTtlMs, maxInputRequestsPerExecution]) {
      if (!positiveInteger(value)) throw new Error("LOCAL_EXECUTION_RETENTION_INVALID");
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** Reserves the identity synchronously, before preparation or spawn effects. */
  start(request: LocalExecutionStart): string {
    this.prune();
    if (request.hostGeneration !== this.hostGeneration) throw new Error("LOCAL_EXECUTION_GENERATION_STALE");
    if (this.disposed || this.fencedOwners.has(request.ownerKey)) {
      throw new Error("LOCAL_EXECUTION_OWNER_FENCED");
    }
    if (!request.executionId || !request.requestIdentity || !request.ownerKey || !request.requestFingerprint) {
      throw new Error("LOCAL_EXECUTION_IDENTITY_REQUIRED");
    }
    const requestKey = JSON.stringify([request.ownerKey, request.requestIdentity]);
    const existingId = this.requests.get(requestKey);
    const existing = this.entries.get(existingId ?? request.executionId);
    if (existing !== undefined) {
      if (existing.cancellationReserved && existing.request.ownerKey === request.ownerKey) {
        if (existing.expired) throw new Error("LOCAL_EXECUTION_RECEIPT_EXPIRED");
        const { prepare: _prepare, signal: _signal, ...identity } = request;
        existing.request = identity;
        existing.cancellationReserved = false;
        this.requests.set(requestKey, request.executionId);
        return request.executionId;
      }
      if (existing.request.ownerKey !== request.ownerKey ||
          existing.request.executionId !== request.executionId ||
          existing.request.requestIdentity !== request.requestIdentity ||
          existing.request.requestFingerprint !== request.requestFingerprint ||
          existing.request.hostGeneration !== request.hostGeneration ||
          existing.request.tty !== request.tty) {
        throw new Error("LOCAL_EXECUTION_REQUEST_CONFLICT");
      }
      if (existing.expired) throw new Error("LOCAL_EXECUTION_RECEIPT_EXPIRED");
      return existing.request.executionId;
    }
    if (this.entries.size >= this.options.retention.maxExecutions) {
      throw new Error("LOCAL_EXECUTION_CAPACITY_REACHED");
    }
    if ([...this.entries.values()].filter((entry) => !entry.settled).length >= this.options.retention.maxActiveExecutions) {
      throw new Error("LOCAL_EXECUTION_ACTIVE_CAPACITY_REACHED");
    }
    const { prepare, signal, ...identity } = request;
    const entry: Entry = {
      request: identity, prepare, cancellationReserved: false, preparationAbort: new AbortController(),
      inputRequests: new Map(),
      capture: new SanitizedCapture(
        [...knownRunShellSecretValues(), ...(this.options.additionalRedactionSecrets?.() ?? [])],
        (bytes) => this.append(entry, bytes),
      ),
      changed: new Set(), process: null, pid: null, prepared: null, state: "starting",
      exitCode: null, signal: null, failureCode: null, resources: "pending",
      output: Buffer.alloc(0), produced: 0, expiresAt: null, expired: false,
      cancelled: false, settled: false, removeAbort: () => undefined,
    };
    this.entries.set(request.executionId, entry);
    this.requests.set(requestKey, request.executionId);
    const onAbort = () => this.stop(entry);
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.removeAbort = () => signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) this.stop(entry);
    this.notify(entry);
    const launch = this.launch(entry);
    this.launches.add(launch);
    void launch.finally(() => this.launches.delete(launch));
    return request.executionId;
  }

  async read(input: LocalExecutionRead): Promise<LocalExecutionSnapshot> {
    this.validateRead(input);
    let entry = this.lookup(input.executionId, input.ownerKey);
    this.validateCursor(entry, input.cursor);
    if (!entry.settled && entry.produced <= input.cursor && (input.yieldMs ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        const changed = () => {
          if (entry.settled || entry.produced > input.cursor || entry.state === "unknown") done();
        };
        const done = () => {
          clearTimeout(timer);
          entry.changed.delete(changed);
          resolve();
        };
        const timer = setTimeout(done, input.yieldMs);
        entry.changed.add(changed);
      });
      entry = this.lookup(input.executionId, input.ownerKey);
    }
    return this.snapshot(entry, input.cursor, input.maxBytes);
  }

  /** Immediate retained-output search; references grant no additional access.
   * A miss returns an empty page, not a claimed terminal outcome. */
  search(input: LocalExecutionSearch): LocalExecutionSearchResult {
    this.validateRead(input);
    const entry = this.lookup(input.executionId, input.ownerKey);
    this.validateCursor(entry, input.cursor);
    const search = searchLocalExecutionOutput({ output: entry.output, produced: entry.produced,
      cursor: input.cursor, literal: input.literal, settled: entry.settled });
    return { search, snapshot: this.snapshot(entry, search.matchedAt ?? entry.produced, input.maxBytes) };
  }

  async write(input: LocalExecutionRead & { readonly inputId: string; readonly chars: string }): Promise<LocalExecutionSnapshot> {
    this.validateRead(input);
    const entry = this.lookup(input.executionId, input.ownerKey);
    this.validateCursor(entry, input.cursor);
    if (input.chars.length === 0) return this.read(input);
    if (!input.inputId) throw new Error("LOCAL_EXECUTION_INPUT_ID_REQUIRED");
    const fingerprint = digest(input.chars);
    const prior = entry.inputRequests.get(input.inputId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) throw new Error("LOCAL_EXECUTION_INPUT_CONFLICT");
      if (prior.failureCode !== null) throw new Error(prior.failureCode);
      return this.read(input);
    }
    if (this.disposed || this.fencedOwners.has(input.ownerKey) || entry.cancelled || entry.state !== "running" || entry.process === null) {
      throw new Error("LOCAL_EXECUTION_INPUT_FENCED");
    }
    if (!entry.request.tty) throw new Error("LOCAL_EXECUTION_STDIN_REQUIRES_PTY");
    if (entry.inputRequests.size >= this.options.retention.maxInputRequestsPerExecution) {
      throw new Error("LOCAL_EXECUTION_INPUT_CAPACITY_REACHED");
    }
    // Store BEFORE delivery. A throwing write can still have delivered bytes.
    const delivery = { fingerprint, failureCode: null as string | null };
    entry.inputRequests.set(input.inputId, delivery);
    try { entry.process.write(input.chars); } catch {
      delivery.failureCode = "LOCAL_EXECUTION_INPUT_OUTCOME_UNKNOWN";
      throw new Error(delivery.failureCode);
    }
    return this.read(input);
  }

  async cancel(input: LocalExecutionRead): Promise<LocalExecutionSnapshot> {
    this.validateRead(input);
    const entry = this.lookup(input.executionId, input.ownerKey);
    this.validateCursor(entry, input.cursor);
    this.stop(entry);
    return this.read(input);
  }

  /** A trusted Stop can arrive before the async start handler has reserved its ID. */
  reserveCancellation(input: { readonly executionId: string; readonly ownerKey: string; readonly hostGeneration: string }): string {
    if (input.hostGeneration !== this.hostGeneration) throw new Error("LOCAL_EXECUTION_GENERATION_STALE");
    if (!input.executionId || !input.ownerKey) throw new Error("LOCAL_EXECUTION_IDENTITY_REQUIRED");
    this.prune();
    const existing = this.entries.get(input.executionId);
    if (existing !== undefined) {
      if (existing.request.ownerKey !== input.ownerKey) throw new Error("LOCAL_EXECUTION_REQUEST_CONFLICT");
      this.stop(existing);
      return input.executionId;
    }
    if (this.disposed) throw new Error("LOCAL_EXECUTION_OWNER_FENCED");
    if (this.entries.size >= this.options.retention.maxExecutions) throw new Error("LOCAL_EXECUTION_CAPACITY_REACHED");
    const entry: Entry = {
      request: { ...input, requestIdentity: "", requestFingerprint: "", tty: false },
      cancellationReserved: true, preparationAbort: new AbortController(), prepare: null,
      inputRequests: new Map(), capture: null, changed: new Set(), process: null, pid: null, prepared: null,
      state: "cancelled", exitCode: null, signal: null, failureCode: null, resources: "released",
      output: Buffer.alloc(0), produced: 0, expiresAt: this.now() + this.options.retention.completedTtlMs,
      expired: false, cancelled: true, settled: true, removeAbort: () => undefined,
    };
    this.entries.set(input.executionId, entry);
    this.publishSettlement(entry);
    this.notify(entry);
    return input.executionId;
  }

  async cancelOrReserve(input: LocalExecutionRead & { readonly hostGeneration: string }): Promise<LocalExecutionSnapshot> {
    this.validateRead(input);
    const entry = this.entries.get(input.executionId);
    if (entry === undefined) {
      if (input.cursor !== 0) throw new Error("LOCAL_EXECUTION_CURSOR_INVALID");
    } else {
      this.validateCursor(this.lookup(input.executionId, input.ownerKey), input.cursor);
    }
    this.reserveCancellation(input);
    return this.read(input);
  }

  /** Local revocation fences input synchronously before requesting cleanup. */
  fenceOwner(ownerKey: string): void {
    if (![...this.entries.values()].some((entry) => entry.request.ownerKey === ownerKey)) return;
    this.fencedOwners.add(ownerKey);
    for (const entry of this.entries.values()) if (entry.request.ownerKey === ownerKey) this.stop(entry);
  }

  list(ownerKey: string): LocalExecutionSnapshot[] {
    this.prune();
    return [...this.entries.values()]
      .filter((entry) => entry.request.ownerKey === ownerKey && !entry.expired)
      .map((entry) => this.snapshot(entry, entry.produced, 0));
  }

  /** Resource custody outlives output expiry; this grants no read or execution authority. */
  getCustodyState(executionId: string, ownerKey: string): Pick<LocalExecutionSnapshot, "resources" | "state"> | undefined {
    const entry = this.entries.get(executionId);
    return entry?.request.ownerKey === ownerKey ? { resources: entry.resources, state: entry.state } : undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Final sanitized capture only. Persistence never changes execution truth. */
  subscribeSettled(listener: (snapshot: LocalExecutionSnapshot, ownerKey: string) => Promise<void>): () => void {
    this.settlementListeners.add(listener);
    return () => this.settlementListeners.delete(listener);
  }

  /** Quit/session retirement fences all work; receipts survive until expiry. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) this.stop(entry);
  }

  /** Retirement awaits actual adapter settlement and owned-resource disposal. */
  async finishDisposal(): Promise<void> {
    this.dispose();
    await Promise.all([...this.launches]);
    await Promise.all([...this.historyWrites]);
  }

  private async launch(entry: Entry): Promise<void> {
    if (entry.cancelled) {
      entry.prepare = null;
      entry.capture = null;
      entry.state = "cancelled";
      entry.resources = "released";
      this.settle(entry);
      return;
    }
    let terminalState: LocalExecutionState;
    try {
      const prepare = entry.prepare!;
      entry.prepare = null;
      entry.prepared = await prepare(entry.preparationAbort.signal);
      entry.resources = "owned";
      if (entry.cancelled) {
        entry.capture = null;
        if (await this.release(entry)) entry.state = "cancelled";
        this.settle(entry);
        return;
      }
      entry.process = (this.options.spawn ?? spawnLocalExecutionProcess)(
        entry.prepared, entry.request.tty, (stream, bytes) => entry.capture?.append(stream, bytes),
      );
      entry.pid = entry.process.pid;
      entry.state = "running";
      // A synchronous adapter may deliver an abort during spawn.
      if (entry.cancelled) this.stop(entry);
      this.notify(entry);
      const exit = await entry.process.exited;
      entry.capture?.finish();
      entry.capture = null;
      entry.exitCode = exit.exitCode;
      entry.signal = exit.signal;
      // A failed Stop signal is provisional: the adapter can later confirm
      // exit, output drain and group cleanup. Its final failure remains binding.
      entry.failureCode = exit.failureCode ??
        (entry.failureCode === "LOCAL_EXECUTION_TERMINATION_UNCONFIRMED" ? null : entry.failureCode);
      terminalState = entry.failureCode !== null ?
        (entry.failureCode === "LOCAL_EXECUTION_SPAWN_FAILED" ? "failed" : "unknown") :
        entry.cancelled ? "cancelled" : "completed";
    } catch (error) {
      entry.capture?.finish();
      // Stable policy codes are safe receipts; arbitrary exception messages can
      // contain paths or credentials and never cross the execution boundary.
      const code = error instanceof Error && /^(?:LOCAL_EXECUTION|WORKSTATION_SHELL|WORKSTATION_CWD|WORKSTATION_CURRENT_FOLDER|GRANT)_[A-Z][A-Z0-9_]*$/.test(error.message)
        ? error.message : "LOCAL_EXECUTION_START_FAILED";
      entry.capture = null;
      entry.failureCode = entry.process === null ?
        (entry.cancelled ? null : code) : "LOCAL_EXECUTION_OUTCOME_UNKNOWN";
      terminalState = entry.process === null ? (entry.cancelled ? "cancelled" : "failed") : "unknown";
    }
    // A settled adapter no longer owns a live PID. Keep the receipt pending
    // until resource cleanup resolves, without signaling a potentially reused PID.
    entry.process = null;
    if (await this.release(entry)) entry.state = terminalState;
    this.settle(entry);
  }

  private async release(entry: Entry): Promise<boolean> {
    const prepared = entry.prepared;
    entry.prepared = null;
    if (prepared === null) {
      if (entry.resources === "pending") entry.resources = "released";
      return entry.resources === "released";
    }
    try {
      await prepared.dispose();
      entry.resources = "released";
      return true;
    } catch {
      entry.resources = "release_failed";
      entry.failureCode = "LOCAL_EXECUTION_RESOURCE_CLEANUP_FAILED";
      entry.state = "unknown";
      return false;
    }
  }

  private stop(entry: Entry): void {
    if (entry.settled || entry.expired) return;
    entry.cancelled = true;
    entry.preparationAbort.abort();
    entry.state = "cancelling";
    try { entry.process?.terminate(); } catch {
      entry.state = "unknown";
      entry.failureCode = "LOCAL_EXECUTION_TERMINATION_UNCONFIRMED";
    }
    this.notify(entry);
  }

  private settle(entry: Entry): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.process = null;
    entry.expiresAt = this.now() + this.options.retention.completedTtlMs;
    entry.removeAbort();
    entry.removeAbort = () => undefined;
    this.publishSettlement(entry);
    this.notify(entry);
  }

  private publishSettlement(entry: Entry): void {
    const snapshot = this.snapshot(entry, 0, Number.MAX_SAFE_INTEGER);
    for (const listener of this.settlementListeners) {
      let write: Promise<void>;
      try { write = listener(snapshot, entry.request.ownerKey).catch(() => {}); }
      catch { continue; } // Persistence cannot rewrite a real exit.
      this.historyWrites.add(write);
      void write.finally(() => this.historyWrites.delete(write));
    }
  }

  private append(entry: Entry, bytes: Buffer): void {
    if (entry.settled || bytes.length === 0) return;
    entry.produced += bytes.length;
    const available = Math.max(0, this.options.retention.maxTotalOutputBytes -
      (this.totalOutputBytes - entry.output.length));
    const budget = Math.min(this.options.retention.maxOutputBytes, available);
    const combined = Buffer.concat([entry.output, bytes]);
    let start = Math.max(0, combined.length - budget);
    // Never retain a partial UTF-8 character at the head of the tail.
    while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start += 1;
    this.totalOutputBytes -= entry.output.length;
    entry.output = Buffer.from(combined.subarray(start));
    this.totalOutputBytes += entry.output.length;
    this.notify(entry);
  }

  private notify(entry: Entry): void {
    for (const listener of [...entry.changed, ...this.listeners]) {
      try { listener(); } catch { /* Observers cannot control process ownership. */ }
    }
  }

  private validateRead(input: LocalExecutionRead): void {
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 ||
        // Four bytes allow progress for every valid UTF-8 code point.
        !positiveInteger(input.maxBytes) || input.maxBytes < 4 ||
        (input.yieldMs !== undefined && (!Number.isSafeInteger(input.yieldMs) || input.yieldMs < 0 || input.yieldMs > 2 ** 31 - 1))) {
      throw new Error("LOCAL_EXECUTION_READ_INVALID");
    }
  }

  private lookup(executionId: string, ownerKey: string): Entry {
    this.prune();
    const entry = this.entries.get(executionId);
    if (entry === undefined || entry.request.ownerKey !== ownerKey) {
      throw new Error("LOCAL_EXECUTION_UNAVAILABLE");
    }
    if (entry.expired) throw new Error("LOCAL_EXECUTION_RECEIPT_EXPIRED");
    return entry;
  }

  private validateCursor(entry: Entry, cursor: number): void {
    if (cursor > entry.produced) throw new Error("LOCAL_EXECUTION_CURSOR_INVALID");
    const availableFrom = entry.produced - entry.output.length;
    const from = Math.max(cursor, availableFrom);
    if (from < entry.produced && (entry.output[from - availableFrom]! & 0xc0) === 0x80) {
      throw new Error("LOCAL_EXECUTION_CURSOR_INVALID");
    }
  }

  private snapshot(entry: Entry, cursor: number, maxBytes: number): LocalExecutionSnapshot {
    this.validateCursor(entry, cursor);
    const availableFrom = entry.produced - entry.output.length;
    const from = Math.max(cursor, availableFrom);
    let end = Math.min(entry.produced, from + maxBytes);
    while (end < entry.produced && end > from && (entry.output[end - availableFrom]! & 0xc0) === 0x80) end -= 1;
    const data = entry.output.subarray(from - availableFrom, end - availableFrom).toString("utf8");
    return {
      executionId: entry.request.executionId, state: entry.state, tty: entry.request.tty,
      pid: entry.pid, exitCode: entry.exitCode, signal: entry.signal,
      terminationScope: "owned_process_group", failureCode: entry.failureCode,
      expiresAt: entry.expiresAt, resources: entry.resources,
      output: { data, cursor: from, nextCursor: end, availableFrom, produced: entry.produced,
        gap: cursor < availableFrom, hasMore: end < entry.produced },
    };
  }

  private prune(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (!entry.settled || entry.expiresAt === null || entry.expiresAt > now) continue;
      if (!entry.expired) {
        this.totalOutputBytes -= entry.output.length;
        entry.output.fill(0);
        entry.output = Buffer.alloc(0);
        entry.inputRequests.clear();
        entry.expired = true;
      }
      // Identity tombstones remain for this host generation. New work fails
      // capacity explicitly rather than forgetting whether a mutation ran.
    }
  }
}
