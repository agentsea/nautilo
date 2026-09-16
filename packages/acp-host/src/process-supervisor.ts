import { spawn } from "node:child_process";
import { basename, isAbsolute, normalize } from "node:path";
import { Readable, Writable } from "node:stream";
import type {
  AcpAdapterEvent,
  AcpPermissionRequest,
  AcpPermissionSelection,
  AcpTurnResult,
} from "./stable-v1-adapter.js";
import type { AcpCapabilityTruth } from "./capability-truth.js";

export const ACP_DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
/** OpenCode cold starts may legitimately exceed the Hermes/default handshake window. */
export const OPENCODE_ACP_INITIALIZE_TIMEOUT_MS = 30_000;
export const ACP_DEFAULT_TERMINATION_GRACE_MS = 2_000;
export const ACP_TOTAL_TEARDOWN_TIMEOUT_MS = 15_000;
export const ACP_STDERR_RING_BYTES = 32 * 1024;
export const ACP_DEFAULT_MAX_CHILDREN = 4;

const MAX_ENV_VALUE_BYTES = 32 * 1024;
const MAX_PATH_ENTRIES = 32;
const MAX_PATH_ENTRY_BYTES = 4 * 1024;
const textEncoder = new TextEncoder();

export type AcpRegistrationId = "hermes-acp" | "opencode-acp";

export type AcpLaunchDefinition = Readonly<{
  registrationId: AcpRegistrationId;
  executableBasename: "hermes" | "opencode";
  args: readonly string[];
}>;

export const ACP_LAUNCH_DEFINITIONS: Readonly<Record<AcpRegistrationId, AcpLaunchDefinition>> =
  Object.freeze({
    "hermes-acp": Object.freeze({
      registrationId: "hermes-acp",
      executableBasename: "hermes",
      args: Object.freeze(["-p", "nautilo-acp", "acp"]),
    }),
    "opencode-acp": Object.freeze({
      registrationId: "opencode-acp",
      executableBasename: "opencode",
      args: Object.freeze(["acp"]),
    }),
  });

export type AcpStartRequest = Readonly<{
  bindingId: string;
  registrationId: AcpRegistrationId;
}>;

/**
 * Returned only by an Electron-owned authority which revalidates the reviewed
 * executable and Current Folder immediately before spawn. No caller path or
 * environment is accepted by AcpHostRuntime.
 */
export type AcpCanonicalLaunchAdmission = Readonly<{
  executablePath: string;
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
}>;

export interface AcpCanonicalLaunchAuthority {
  resolveAndRevalidate(request: AcpStartRequest, signal: AbortSignal): Promise<AcpCanonicalLaunchAdmission>;
}

export type AcpSpawnSpec = Readonly<{
  executablePath: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
  detached: true;
}>;

export type AcpProcessExit = Readonly<{ code: number | null; signal: string | null }>;

export interface AcpSpawnedProcess<GroupIdentity = unknown> {
  readonly groupIdentity: GroupIdentity;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Settles on either the process exit event or a post-spawn process error. */
  readonly exited: Promise<AcpProcessExit>;
}

export interface AcpSpawnAdapter<GroupIdentity = unknown> {
  spawn(spec: AcpSpawnSpec, signal: AbortSignal): Promise<AcpSpawnedProcess<GroupIdentity>>;
}

export interface AcpProcessTreeAdapter<GroupIdentity = unknown> {
  signalGroup(identity: GroupIdentity, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
  isGroupAbsent(identity: GroupIdentity): Promise<boolean>;
  /**
   * Optional shell-free, metadata-only observation of the exact detached
   * group. Implementations must not retain or export command lines, paths,
   * environment, or process output.
   */
  observeGroup?(identity: GroupIdentity): Promise<AcpProcessGroupObservation>;
}

/** Fixed-shape local process metadata. No process identity or content crosses this seam. */
export type AcpProcessGroupObservation = Readonly<{
  processCount: number;
  descendantCount: number;
  cpuTimeMs: number;
}>;

/**
 * Exact-generation health available only to the Electron execution owner.
 * It deliberately contains fixed numeric/boolean counters rather than raw
 * process inspection, output, provider, or workspace information.
 */
export type AcpHostHealthSnapshot = Readonly<{
  groupPresent: boolean;
  exited: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  protocolEvents: number;
  processCount: number;
  descendantCount: number;
  cpuTimeMs: number;
  groupObservationAvailable: boolean;
}>;

export interface AcpHostClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Task 3.1 integration seam. The implementation owns stable-v1 initialize and session/new. */
export interface AcpStableV1ReadinessConnector {
  connect(request: Readonly<{
    input: ReadableStream<Uint8Array>;
    output: WritableStream<Uint8Array>;
    cwd: string;
    signal: AbortSignal;
    bindingId: string;
    registrationId: AcpRegistrationId;
    generation: number;
  }>): Promise<AcpReadyBinding>;
}

export interface AcpReadyBinding {
  /** The one prompt was admitted before connect and shares this initialized session. */
  turn?(): Promise<AcpTurnResult>;
  close(): Promise<void>;
}

export type AcpLiveTurnRequest = Readonly<{
  prompt: string;
  /** Agent-owned policy mode, selected through stable session/set_mode. */
  sessionModeId?: string;
  onNegotiated: (capabilities: AcpCapabilityTruth) => Promise<void> | void;
  onSessionStarted: (input: Readonly<{ sessionId: string; capabilities: AcpCapabilityTruth }>) => Promise<void> | void;
  /** Bounded canonical `session/prompt` write completed; no prompt result is implied. */
  onPromptAdmitted?: (input: Readonly<{ sessionId: string; capabilities: AcpCapabilityTruth }>) => void;
  /** Closes host-side permission admission before the stable cancel write. */
  onStopping?: () => Promise<void> | void;
  onEvent: (event: AcpAdapterEvent) => Promise<void> | void;
  onPermission?: (request: AcpPermissionRequest) => Promise<AcpPermissionSelection> | AcpPermissionSelection;
}>;

export type AcpStderrState = "none" | "present" | "truncated";
export type AcpRuntimeState = "absent" | "starting" | "ready" | "unavailable" | "cleanup_uncertain";

export type AcpRuntimeStatus = Readonly<{
  bindingId: string;
  registrationId: AcpRegistrationId | null;
  generation: number;
  state: AcpRuntimeState;
  stderr: AcpStderrState;
}>;

export class AcpHostRuntimeError extends Error {
  constructor(
    readonly code: "invalid_request" | "unavailable" | "generation_stale" | "cleanup_uncertain",
    message: string,
  ) {
    super(message);
    this.name = "AcpHostRuntimeError";
  }
}

export type AcpHostRuntimeOptions<GroupIdentity = unknown> = Readonly<{
  launches: AcpCanonicalLaunchAuthority;
  processes: AcpSpawnAdapter<GroupIdentity>;
  processTree: AcpProcessTreeAdapter<GroupIdentity>;
  readiness: AcpStableV1ReadinessConnector;
  clock?: AcpHostClock;
  platform?: "posix" | "win32";
  pathDelimiter?: string;
  initializeTimeoutMs?: number;
  terminationGraceMs?: number;
  maxChildren?: number;
}>;

type ChildRecord<GroupIdentity> = {
  readonly request: AcpStartRequest;
  readonly generation: number;
  readonly process: AcpSpawnedProcess<GroupIdentity>;
  readonly stderr: StderrRing;
  readonly abort: AbortController;
  binding?: AcpReadyBinding;
  stopping: Promise<boolean> | undefined;
  terminal: boolean;
  exited: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  protocolEvents: number;
};

type StartRecord<GroupIdentity> = {
  readonly request: AcpStartRequest;
  readonly generation: number;
  readonly abort: AbortController;
  cancelled: boolean;
  settled: boolean;
  child?: ChildRecord<GroupIdentity>;
  completion?: Promise<AcpRuntimeStatus>;
};

export class AcpHostRuntime<GroupIdentity = unknown> {
  readonly #children = new Map<string, ChildRecord<GroupIdentity>>();
  readonly #starting = new Map<string, StartRecord<GroupIdentity>>();
  readonly #inflightStarts = new Set<StartRecord<GroupIdentity>>();
  readonly #generations = new Map<string, number>();
  readonly #statuses = new Map<string, AcpRuntimeStatus>();
  readonly #clock: AcpHostClock;
  readonly #platform: "posix" | "win32";
  readonly #pathDelimiter: string;
  readonly #initializeTimeoutMs: number;
  readonly #terminationGraceMs: number;
  readonly #maxChildren: number;
  #closed = false;

  constructor(readonly options: AcpHostRuntimeOptions<GroupIdentity>) {
    this.#clock = options.clock ?? nodeClock;
    this.#platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
    this.#pathDelimiter = options.pathDelimiter ?? (this.#platform === "win32" ? ";" : ":");
    this.#initializeTimeoutMs = boundedPositiveInteger(options.initializeTimeoutMs ?? ACP_DEFAULT_INITIALIZE_TIMEOUT_MS, OPENCODE_ACP_INITIALIZE_TIMEOUT_MS, "initialize timeout");
    this.#terminationGraceMs = boundedPositiveInteger(options.terminationGraceMs ?? ACP_DEFAULT_TERMINATION_GRACE_MS, ACP_DEFAULT_TERMINATION_GRACE_MS, "termination grace");
    this.#maxChildren = boundedPositiveInteger(options.maxChildren ?? ACP_DEFAULT_MAX_CHILDREN, ACP_DEFAULT_MAX_CHILDREN, "child capacity");
  }

  status(bindingId: string): AcpRuntimeStatus {
    assertIdentifier(bindingId, "binding ID");
    return this.#statuses.get(bindingId) ?? Object.freeze({
      bindingId,
      registrationId: null,
      generation: this.#generations.get(bindingId) ?? 0,
      state: "absent",
      stderr: "none",
    });
  }

  /**
   * Returns only the exact ready generation's one-turn adapter binding. This
   * keeps child ownership, launch admission, and containment inside this
   * runtime while allowing Electron to attach semantic projection callbacks.
   */
  binding(bindingId: string, generation: number): AcpReadyBinding {
    assertIdentifier(bindingId, "binding ID");
    const child = this.#children.get(bindingId);
    if (!child || child.generation !== generation || !this.#isCurrent(child) || !child.binding) {
      throw new AcpHostRuntimeError("generation_stale", "ACP process generation is stale");
    }
    return child.binding;
  }

  /**
   * Samples only the current exact process generation. The caller receives
   * bounded metadata and must never relay it outside the local execution
   * owner. A stale sibling cannot be sampled through this API.
   */
  async health(bindingId: string, generation: number): Promise<AcpHostHealthSnapshot> {
    assertIdentifier(bindingId, "binding ID");
    const child = this.#children.get(bindingId);
    if (!child || child.generation !== generation || !this.#isCurrent(child)) {
      throw new AcpHostRuntimeError("generation_stale", "ACP process generation is stale");
    }
    const groupPresent = !(await this.#probeGroup(child.process.groupIdentity));
    let observation: AcpProcessGroupObservation | undefined;
    if (groupPresent && this.options.processTree.observeGroup) {
      observation = await this.#observeGroup(child.process.groupIdentity);
    }
    return Object.freeze({
      groupPresent,
      exited: child.exited,
      stdoutBytes: child.stdoutBytes,
      stderrBytes: child.stderrBytes,
      protocolEvents: child.protocolEvents,
      processCount: observation?.processCount ?? 0,
      descendantCount: observation?.descendantCount ?? 0,
      cpuTimeMs: observation?.cpuTimeMs ?? 0,
      groupObservationAvailable: observation !== undefined,
    });
  }

  /** Records local ACP protocol/frame progress for the exact ready generation. */
  recordProtocolProgress(bindingId: string, generation: number): void {
    assertIdentifier(bindingId, "binding ID");
    const child = this.#children.get(bindingId);
    if (!child || child.generation !== generation || !this.#isCurrent(child)) return;
    child.protocolEvents = incrementCounter(child.protocolEvents, 1);
  }

  async start(request: AcpStartRequest): Promise<AcpRuntimeStatus> {
    validateStartRequest(request);
    if (this.#closed) throw new AcpHostRuntimeError("unavailable", "ACP host is shut down");
    const prior = this.#statuses.get(request.bindingId);
    if (prior?.state === "cleanup_uncertain") {
      throw new AcpHostRuntimeError("cleanup_uncertain", "Prior ACP process containment is uncertain");
    }
    if (this.#children.has(request.bindingId) || this.#starting.has(request.bindingId)) {
      throw new AcpHostRuntimeError("invalid_request", "ACP binding already has an active process");
    }
    if ([...this.#inflightStarts].some((start) => start.request.bindingId === request.bindingId)) {
      throw new AcpHostRuntimeError("unavailable", "ACP binding start is still being contained");
    }
    if (this.#occupiedBindingCount() >= this.#maxChildren) {
      throw new AcpHostRuntimeError("unavailable", "ACP host capacity reached");
    }

    const generation = (this.#generations.get(request.bindingId) ?? 0) + 1;
    this.#generations.set(request.bindingId, generation);
    const startRecord: StartRecord<GroupIdentity> = {
      request: Object.freeze({ ...request }),
      generation,
      abort: new AbortController(),
      cancelled: false,
      settled: false,
    };
    this.#starting.set(request.bindingId, startRecord);
    this.#inflightStarts.add(startRecord);
    this.#setStatus(request, generation, "starting", "none");

    const completion = this.#runStart(startRecord);
    startRecord.completion = completion;
    void completion.then(
      () => this.#settleStart(startRecord),
      () => this.#settleStart(startRecord),
    );
    return this.#awaitStartDeadline(startRecord, completion);
  }

  async #runStart(startRecord: StartRecord<GroupIdentity>): Promise<AcpRuntimeStatus> {
    const request = startRecord.request;
    const generation = startRecord.generation;
    let child: ChildRecord<GroupIdentity> | undefined;
    try {
      const definition = ACP_LAUNCH_DEFINITIONS[request.registrationId];
      const admission = await this.options.launches.resolveAndRevalidate(request, startRecord.abort.signal);
      this.#assertCurrentStart(startRecord);
      const spec = buildSpawnSpec(definition, admission, this.#platform, this.#pathDelimiter);
      const process = await this.options.processes.spawn(spec, startRecord.abort.signal);
      child = {
        request: startRecord.request,
        generation,
        process,
        stderr: new StderrRing(ACP_STDERR_RING_BYTES),
        abort: startRecord.abort,
        stopping: undefined,
        terminal: false,
        exited: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        protocolEvents: 0,
      };
      startRecord.child = child;
      try {
        this.#assertCurrentStart(startRecord);
      } catch (error) {
        child.terminal = true;
        const absent = await this.#terminateUnpublished(process);
        if (!absent) {
          child.stopping = Promise.resolve(false);
          if (!this.#children.has(request.bindingId) && this.#generations.get(request.bindingId) === generation) {
            this.#children.set(request.bindingId, child);
            void this.#consumeStderr(child);
          }
          this.#setStatus(request, generation, "cleanup_uncertain", child.stderr.state);
        }
        throw absent ? error : new AcpHostRuntimeError("cleanup_uncertain", "ACP process containment is uncertain");
      }
      this.#children.set(request.bindingId, child);
      void this.#consumeStderr(child);
      void process.exited.then(
        () => this.#onExit(child!),
        () => this.#onExit(child!),
      );

      const readinessInput = request.registrationId === "opencode-acp"
        ? observeStdout(process.stdout, (bytes) => {
            if (this.#isCurrent(child!)) child!.stdoutBytes = incrementCounter(child!.stdoutBytes, bytes);
          })
        : process.stdout;
      child.binding = await this.options.readiness.connect({
        input: readinessInput,
        output: process.stdin,
        cwd: admission.cwd,
        signal: child.abort.signal,
        bindingId: request.bindingId,
        registrationId: request.registrationId,
        generation,
      });
      this.#assertCurrentStart(startRecord);
      if (!this.#isCurrent(child) || child.terminal) {
        throw new AcpHostRuntimeError("generation_stale", "ACP process generation is stale");
      }
      return this.#setStatus(request, generation, "ready", child.stderr.state);
    } catch (error) {
      if (child) {
        child.terminal = true;
        child.abort.abort();
        await this.#closeBinding(child.binding);
        const absent = child.stopping
          ? await child.stopping
          : this.#isCurrent(child)
            ? await (child.stopping = this.#stopRecord(child))
            : await this.#probeGroup(child.process.groupIdentity);
        if (this.#isCurrent(child)) this.#children.delete(request.bindingId);
        if (!absent) {
          this.#setStatus(request, generation, "cleanup_uncertain", child.stderr.state);
          throw new AcpHostRuntimeError("cleanup_uncertain", "ACP process containment is uncertain");
        }
      }
      if (this.#statuses.get(request.bindingId)?.state !== "cleanup_uncertain") {
        this.#setStatus(request, generation, "unavailable", child?.stderr.state ?? "none");
      }
      if (error instanceof AcpHostRuntimeError) throw error;
      throw new AcpHostRuntimeError("unavailable", "ACP process could not be started");
    } finally {
      if (this.#starting.get(request.bindingId) === startRecord) this.#starting.delete(request.bindingId);
    }
  }

  #settleStart(start: StartRecord<GroupIdentity>): void {
    start.settled = true;
    this.#inflightStarts.delete(start);
    if (this.#starting.get(start.request.bindingId) === start) this.#starting.delete(start.request.bindingId);
    if (start.cancelled && !start.child && this.#statuses.get(start.request.bindingId)?.state === "cleanup_uncertain") {
      this.#setStatus(start.request, start.generation, "unavailable", "none");
    }
  }

  async #awaitStartDeadline(
    start: StartRecord<GroupIdentity>,
    completion: Promise<AcpRuntimeStatus>,
  ): Promise<AcpRuntimeStatus> {
    let handle: unknown;
    try {
      return await new Promise<AcpRuntimeStatus>((resolve, reject) => {
        let timedOut = false;
        void completion.then(
          (result) => { if (!timedOut) resolve(result); },
          (error: unknown) => {
            if (!timedOut) reject(error instanceof Error ? error : new AcpHostRuntimeError("unavailable", "ACP process could not be started"));
          },
        );
        handle = this.#clock.setTimeout(() => {
          timedOut = true;
          start.cancelled = true;
          start.abort.abort();
          if (this.#starting.get(start.request.bindingId) === start) this.#starting.delete(start.request.bindingId);
          void this.#settleTimedOutStart(start, completion).then(reject);
        }, this.#initializeTimeoutMs);
      });
    } finally {
      if (handle !== undefined) this.#clock.clearTimeout(handle);
    }
  }

  async #settleTimedOutStart(
    start: StartRecord<GroupIdentity>,
    completion: Promise<AcpRuntimeStatus>,
  ): Promise<AcpHostRuntimeError> {
    const containment = this.#containCancelledStart(start);
    const result = await this.#boundedOperation<{ settled: boolean; absent: boolean }>(
      Promise.all([
        completion.then(() => undefined, () => undefined),
        containment,
      ]).then(([, absent]) => ({ settled: true as const, absent })),
      { settled: false as const, absent: false },
      ACP_TOTAL_TEARDOWN_TIMEOUT_MS,
    );
    if (!result.settled || !result.absent || this.#statuses.get(start.request.bindingId)?.state === "cleanup_uncertain") {
      this.#setStatus(start.request, start.generation, "cleanup_uncertain", start.child?.stderr.state ?? "none");
      return new AcpHostRuntimeError("cleanup_uncertain", "ACP process containment is uncertain");
    }
    this.#setStatus(start.request, start.generation, "unavailable", start.child?.stderr.state ?? "none");
    return new AcpHostRuntimeError("unavailable", "ACP start timed out");
  }

  async #containCancelledStart(start: StartRecord<GroupIdentity>): Promise<boolean> {
    const child = start.child;
    if (!child) return true;
    child.terminal = true;
    child.abort.abort();
    const containment = child.stopping ?? this.#stopRecord(child);
    child.stopping = containment;
    const absent = await containment;
    if (!absent) this.#setStatus(start.request, start.generation, "cleanup_uncertain", child.stderr.state);
    return absent;
  }

  #occupiedBindingCount(): number {
    const occupied = new Set(this.#children.keys());
    for (const start of this.#inflightStarts) occupied.add(start.request.bindingId);
    return occupied.size;
  }

  async stop(bindingId: string, generation: number): Promise<AcpRuntimeStatus> {
    assertIdentifier(bindingId, "binding ID");
    const child = this.#children.get(bindingId);
    if (!child || child.generation !== generation || !this.#isCurrent(child)) {
      throw new AcpHostRuntimeError("generation_stale", "ACP process generation is stale");
    }
    if (child.terminal && this.#statuses.get(bindingId)?.state === "cleanup_uncertain") {
      const nowAbsent = await this.#probeGroup(child.process.groupIdentity);
      if (nowAbsent) {
        this.#children.delete(bindingId);
        return this.#setStatus(child.request, child.generation, "absent", child.stderr.state);
      }
      child.stopping = undefined;
    }
    const stopped = child.stopping ?? this.#stopRecord(child);
    child.stopping = stopped;
    const absent = await stopped;
    if (!absent) child.stopping = undefined;
    return this.#setStatus(
      child.request,
      child.generation,
      absent ? "absent" : "cleanup_uncertain",
      child.stderr.state,
    );
  }

  /** Returns false when exact process-group absence could not be proved. */
  async shutdown(): Promise<boolean> {
    this.#closed = true;
    const starts = [...this.#inflightStarts];
    for (const start of starts) {
      start.cancelled = true;
      start.abort.abort();
      if (this.#starting.get(start.request.bindingId) === start) this.#starting.delete(start.request.bindingId);
    }
    const children = [...this.#children.values()];
    const childStops = children.map(async (child) => {
      const stopped = child.stopping ?? this.#stopRecord(child);
      child.stopping = stopped;
      const absent = await stopped;
      if (!absent) child.stopping = undefined;
      this.#setStatus(child.request, child.generation, absent ? "absent" : "cleanup_uncertain", child.stderr.state);
    });
    const startContainments = starts.map((start) => this.#containCancelledStart(start));
    const completions = starts.flatMap((start) => start.completion ? [start.completion] : []);
    const settled = await this.#boundedOperation(
      Promise.allSettled([...childStops, ...startContainments, ...completions]).then(() => true),
      false,
      ACP_TOTAL_TEARDOWN_TIMEOUT_MS,
    );
    if (!settled) {
      for (const start of starts) {
        if (!start.settled) this.#setStatus(start.request, start.generation, "cleanup_uncertain", start.child?.stderr.state ?? "none");
      }
      for (const child of children) {
        if (this.#isCurrent(child)) this.#setStatus(child.request, child.generation, "cleanup_uncertain", child.stderr.state);
      }
    }
    return ![...this.#statuses.values()].some((status) => status.state === "cleanup_uncertain");
  }

  async #stopRecord(child: ChildRecord<GroupIdentity>): Promise<boolean> {
    child.terminal = true;
    child.abort.abort();
    await this.#closeBinding(child.binding);
    const absent = await this.#terminateExact(child);
    if (absent && this.#isCurrent(child)) this.#children.delete(child.request.bindingId);
    return absent;
  }

  async #terminateExact(child: ChildRecord<GroupIdentity>): Promise<boolean> {
    if (!this.#isCurrent(child)) return false;
    await this.#signalGroup(child.process.groupIdentity, "SIGTERM");
    await this.#waitGrace(child.process.exited);
    if (!this.#isCurrent(child)) return false;
    if (await this.#probeGroup(child.process.groupIdentity)) return true;
    await this.#signalGroup(child.process.groupIdentity, "SIGKILL");
    await this.#waitGrace(child.process.exited);
    if (!this.#isCurrent(child)) return false;
    return this.#probeGroup(child.process.groupIdentity);
  }

  async #terminateUnpublished(process: AcpSpawnedProcess<GroupIdentity>): Promise<boolean> {
    await this.#signalGroup(process.groupIdentity, "SIGTERM");
    await this.#waitGrace(process.exited);
    if (await this.#probeGroup(process.groupIdentity)) return true;
    await this.#signalGroup(process.groupIdentity, "SIGKILL");
    await this.#waitGrace(process.exited);
    return this.#probeGroup(process.groupIdentity);
  }

  async #onExit(child: ChildRecord<GroupIdentity>): Promise<void> {
    child.exited = true;
    if (!this.#isCurrent(child) || child.terminal) return;
    child.terminal = true;
    child.abort.abort();
    const containment = this.#containExitedGroup(child);
    child.stopping = containment;
    const absent = await containment;
    if (!absent) child.stopping = undefined;
    if (!this.#isCurrent(child)) return;
    if (absent) this.#children.delete(child.request.bindingId);
    this.#setStatus(
      child.request,
      child.generation,
      absent ? "unavailable" : "cleanup_uncertain",
      child.stderr.state,
    );
  }

  async #containExitedGroup(child: ChildRecord<GroupIdentity>): Promise<boolean> {
    await this.#closeBinding(child.binding);
    let absent = await this.#probeGroup(child.process.groupIdentity);
    if (!absent && this.#isCurrent(child)) {
      absent = await this.#terminateExact(child);
    }
    return absent;
  }

  async #consumeStderr(child: ChildRecord<GroupIdentity>): Promise<void> {
    const reader = child.process.stderr.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        if (!this.#isCurrent(child)) return;
        child.stderr.push(next.value);
        child.stderrBytes = incrementCounter(child.stderrBytes, next.value.byteLength);
        const state = this.#statuses.get(child.request.bindingId)?.state;
        if (state) this.#setStatus(child.request, child.generation, state, child.stderr.state);
      }
    } catch {
      // Stderr is diagnostic-only. Exit/readiness remains authoritative.
    } finally {
      reader.releaseLock();
    }
  }

  #assertCurrentStart(start: StartRecord<GroupIdentity>): void {
    if (this.#closed || start.cancelled || this.#starting.get(start.request.bindingId) !== start) {
      throw new AcpHostRuntimeError("generation_stale", "ACP start generation is stale");
    }
  }

  #isCurrent(child: ChildRecord<GroupIdentity>): boolean {
    return this.#children.get(child.request.bindingId) === child &&
      this.#generations.get(child.request.bindingId) === child.generation;
  }

  #setStatus(
    request: AcpStartRequest,
    generation: number,
    state: AcpRuntimeState,
    stderr: AcpStderrState,
  ): AcpRuntimeStatus {
    const status = Object.freeze({
      bindingId: request.bindingId,
      registrationId: request.registrationId,
      generation,
      state,
      stderr,
    });
    this.#statuses.set(request.bindingId, status);
    return status;
  }

  async #boundedOperation<T>(work: Promise<T>, fallback: T, timeoutMs = this.#terminationGraceMs): Promise<T> {
    let handle: unknown;
    try {
      return await Promise.race([
        work.catch(() => fallback),
        new Promise<T>((resolve) => {
          handle = this.#clock.setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ]);
    } finally {
      if (handle !== undefined) this.#clock.clearTimeout(handle);
    }
  }

  async #signalGroup(identity: GroupIdentity, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    await this.#boundedOperation(Promise.resolve().then(() => this.options.processTree.signalGroup(identity, signal)), undefined);
  }

  #probeGroup(identity: GroupIdentity): Promise<boolean> {
    return this.#boundedOperation(Promise.resolve().then(() => this.options.processTree.isGroupAbsent(identity)), false);
  }

  async #observeGroup(identity: GroupIdentity): Promise<AcpProcessGroupObservation | undefined> {
    if (!this.options.processTree.observeGroup) return undefined;
    const snapshot = await this.#boundedOperation(
      Promise.resolve().then(() => this.options.processTree.observeGroup?.(identity)),
      undefined,
    );
    return snapshot && isProcessGroupObservation(snapshot) ? snapshot : undefined;
  }

  async #closeBinding(binding: AcpReadyBinding | undefined): Promise<void> {
    if (!binding) return;
    await this.#boundedOperation(Promise.resolve().then(() => binding.close()), undefined);
  }

  async #waitGrace(exited: Promise<AcpProcessExit>): Promise<void> {
    let handle: unknown;
    try {
      await Promise.race([
        exited.then(() => undefined, () => undefined),
        new Promise<void>((resolve) => {
          handle = this.#clock.setTimeout(resolve, this.#terminationGraceMs);
        }),
      ]);
    } finally {
      if (handle !== undefined) this.#clock.clearTimeout(handle);
    }
  }
}

export function createNodeAcpSpawnAdapter(): AcpSpawnAdapter<number> {
  return {
    async spawn(spec, signal) {
      if (signal.aborted) throw new AcpHostRuntimeError("unavailable", "ACP start was cancelled");
      const child = spawn(spec.executablePath, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = new Promise<AcpProcessExit>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", () => resolve({ code: null, signal: null }));
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("ACP child did not provide a process identity");
      return {
        groupIdentity: child.pid,
        stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        exited,
      };
    },
  };
}

export function createNodeAcpProcessTreeAdapter(platform: NodeJS.Platform = process.platform): AcpProcessTreeAdapter<number> {
  if (platform === "win32") {
    throw new AcpHostRuntimeError("unavailable", "ACP process-tree containment is unavailable on this platform");
  }
  const trackedGroups = new Map<number, Set<number>>();
  const unprovenTrees = new Set<number>();
  const frozenTrees = new Set<number>();
  return {
    signalGroup: async (identity, signal) => {
      const groupSet = trackedGroups.get(identity) ?? new Set<number>([identity]);
      trackedGroups.set(identity, groupSet);
      if (signal === "SIGTERM") await freezeAndTrackPosixProcessTree(identity, groupSet, unprovenTrees, frozenTrees);
      const groups = [...(trackedGroups.get(identity) ?? [identity])];
      const signaledGroups: number[] = [];
      for (const group of groups) {
        try {
          process.kill(-group, signal);
          signaledGroups.push(group);
        } catch (error) {
          if (nodeErrorCode(error) !== "ESRCH") throw error;
        }
      }
      // ACP cancellation/close has already run before process containment.
      // Once the live tree is frozen, do not resume arbitrary signal handlers:
      // one could fork a new detached group after the stable snapshot. Queue
      // TERM for ordinary semantics, then hard-contain the frozen exact tree.
      if (signal === "SIGTERM") {
        // A group already absent at the TERM boundary must not be signalled
        // again: its numeric ID can be reused by an unrelated process group
        // before the immediate KILL pass.
        for (const group of signaledGroups) signalPosixGroupBestEffort(group, "SIGKILL");
      }
    },
    isGroupAbsent: (identity) => Promise.resolve().then(() => {
      const groups = trackedGroups.get(identity) ?? new Set([identity]);
      for (const group of groups) {
        try {
          process.kill(-group, 0);
          return false;
        } catch (error) {
          if (nodeErrorCode(error) !== "ESRCH") return false;
        }
      }
      if (!frozenTrees.has(identity)) {
        unprovenTrees.add(identity);
        return false;
      }
      if (unprovenTrees.has(identity)) return false;
      trackedGroups.delete(identity);
      frozenTrees.delete(identity);
      return true;
    }),
    observeGroup: async (identity) => {
      const rows = await readPosixProcessTree(identity);
      const groups = trackedGroups.get(identity) ?? new Set<number>([identity]);
      for (const row of rows) groups.add(row.pgid);
      trackedGroups.set(identity, groups);
      const cpuTimeMs = rows.reduce((total, row) => Math.min(Number.MAX_SAFE_INTEGER, total + row.cpuTimeMs), 0);
      return Object.freeze({
        processCount: rows.length,
        descendantCount: Math.max(0, rows.length - 1),
        cpuTimeMs,
      });
    },
  };
}

async function freezeAndTrackPosixProcessTree(
  identity: number,
  groups: Set<number>,
  unprovenTrees: Set<number>,
  frozenTrees: Set<number>,
): Promise<void> {
  // Freeze the ACP parent first. Descendants are then discovered and frozen
  // to a fixed point while their ancestry is still intact. This prevents a
  // live parent from creating a new detached group after the containment
  // snapshot but before TERM.
  signalPosixGroupBestEffort(identity, "SIGSTOP");
  let stablePasses = 0;
  let priorFingerprint = "";
  for (let pass = 0; pass < 8 && stablePasses < 2; pass += 1) {
    let rows: readonly PosixProcessRow[];
    try {
      rows = await readPosixProcessTree(identity);
    } catch {
      // Uncertainty is monotonic for this exact generation. A later snapshot
      // cannot prove that an independently detached child was not missed.
      unprovenTrees.add(identity);
      return;
    }
    if (rows.length === 0 && groups.size === 1) {
      // The root disappeared before any descendant identity was captured.
      // Reparented, independently detached children are no longer enumerable
      // by ancestry, so this generation can never be proven absent.
      unprovenTrees.add(identity);
      return;
    }
    for (const row of rows) groups.add(row.pgid);
    for (const group of groups) signalPosixGroupBestEffort(group, "SIGSTOP");
    const fingerprint = rows.map((row) => `${row.pid}:${row.ppid}:${row.pgid}`).sort().join("|");
    if (fingerprint === priorFingerprint) stablePasses += 1;
    else stablePasses = 0;
    priorFingerprint = fingerprint;
    if (stablePasses < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (stablePasses < 2) unprovenTrees.add(identity);
  else frozenTrees.add(identity);
}

function signalPosixGroupBestEffort(identity: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-identity, signal);
  } catch (error) {
    if (nodeErrorCode(error) !== "ESRCH") throw error;
  }
}

function buildSpawnSpec(
  definition: AcpLaunchDefinition,
  admission: AcpCanonicalLaunchAdmission,
  platform: "posix" | "win32",
  pathDelimiter: string,
): AcpSpawnSpec {
  assertCanonicalAbsolutePath(admission.executablePath, "executable");
  assertCanonicalAbsolutePath(admission.cwd, "workspace");
  if (basename(admission.executablePath) !== definition.executableBasename) {
    throw new AcpHostRuntimeError("unavailable", "Reviewed ACP executable is unavailable");
  }
  const env = buildChildEnvironment(admission.environment, definition.registrationId, platform, pathDelimiter);
  return Object.freeze({
    executablePath: admission.executablePath,
    args: definition.args,
    cwd: admission.cwd,
    env,
    shell: false,
    detached: true,
  });
}

function buildChildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  registrationId: AcpRegistrationId,
  platform: "posix" | "win32",
  pathDelimiter: string,
): Readonly<Record<string, string>> {
  const required = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;
  const allowed = new Set<string>(required);
  if (platform === "win32") {
    allowed.add("SystemRoot");
    allowed.add("ComSpec");
  }
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new AcpHostRuntimeError("unavailable", "ACP launch environment is not allowlisted");
  }
  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = source[key];
    if (required.includes(key as (typeof required)[number]) && value === undefined) {
      throw new AcpHostRuntimeError("unavailable", "ACP launch environment is incomplete");
    }
    if (value !== undefined) env[key] = validateEnvironmentValue(value);
  }
  const pathEntries = env["PATH"]!.split(pathDelimiter);
  if (pathEntries.length > MAX_PATH_ENTRIES || pathEntries.some((entry) => entry.length === 0 || textEncoder.encode(entry).byteLength > MAX_PATH_ENTRY_BYTES)) {
    throw new AcpHostRuntimeError("unavailable", "ACP launch PATH is invalid");
  }
  if (registrationId === "hermes-acp") env["HERMES_ACP_SKIP_CONFIGURED_MCP"] = "1";
  return Object.freeze(env);
}

function validateEnvironmentValue(value: string): string {
  if (value.includes("\0") || textEncoder.encode(value).byteLength > MAX_ENV_VALUE_BYTES) {
    throw new AcpHostRuntimeError("unavailable", "ACP launch environment value is invalid");
  }
  return value;
}

function assertCanonicalAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || normalize(value) !== value || value.includes("\0")) {
    throw new AcpHostRuntimeError("unavailable", `Canonical ACP ${label} is unavailable`);
  }
}

function validateStartRequest(request: AcpStartRequest): void {
  assertIdentifier(request.bindingId, "binding ID");
  if (!(request.registrationId in ACP_LAUNCH_DEFINITIONS)) {
    throw new AcpHostRuntimeError("invalid_request", "Unknown ACP registration");
  }
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || textEncoder.encode(value).byteLength > 512) {
    throw new AcpHostRuntimeError("invalid_request", `Invalid ACP ${label}`);
  }
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function incrementCounter(current: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + Math.max(0, increment));
}

function isProcessGroupObservation(value: AcpProcessGroupObservation): boolean {
  return Number.isSafeInteger(value.processCount) && value.processCount >= 0 &&
    Number.isSafeInteger(value.descendantCount) && value.descendantCount >= 0 &&
    Number.isSafeInteger(value.cpuTimeMs) && value.cpuTimeMs >= 0;
}

/** Reads the exact root and recursive descendants through `ps` without a
 * shell. Command text, paths, environment, and raw output are never requested
 * and the parsed snapshot is discarded after fixed-shape aggregation or
 * containment. */
function readPosixProcessTree(identity: number): Promise<readonly PosixProcessRow[]> {
  if (!Number.isSafeInteger(identity) || identity <= 0) return Promise.reject(new Error("Invalid ACP process group"));
  return new Promise((resolve, reject) => {
    const observer = spawn("/bin/ps", ["-axo", "pid=,ppid=,pgid=,time="], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let settled = false;
    const settle = (work: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      work();
    };
    const timeout = setTimeout(() => {
      observer.kill("SIGKILL");
      settle(() => reject(new Error("ACP process observation timed out")));
    }, 500);
    observer.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) {
        observer.kill("SIGKILL");
        settle(() => reject(new Error("ACP process observation exceeded bounds")));
        return;
      }
      chunks.push(new Uint8Array(chunk));
    });
    observer.once("error", () => settle(() => reject(new Error("ACP process observation unavailable"))));
    observer.once("close", (code) => {
      if (code !== 0) return settle(() => reject(new Error("ACP process observation unavailable")));
      const output = new TextDecoder().decode(concatBytes(chunks, bytes));
      const allRows: PosixProcessRow[] = [];
      for (const line of output.split("\n")) {
        if (line.trim().length === 0) continue;
        const row = parsePosixProcessRow(line);
        if (!row) return settle(() => reject(new Error("ACP process observation was malformed")));
        allRows.push(row);
      }
      const root = allRows.find((row) => row.pid === identity);
      if (!root) return settle(() => resolve(Object.freeze([])));
      const children = new Map<number, PosixProcessRow[]>();
      for (const row of allRows) {
        const siblings = children.get(row.ppid) ?? [];
        siblings.push(row);
        children.set(row.ppid, siblings);
      }
      const tree: PosixProcessRow[] = [root];
      const seen = new Set([identity]);
      for (let cursor = 0; cursor < tree.length; cursor += 1) {
        for (const child of children.get(tree[cursor]!.pid) ?? []) {
          if (seen.has(child.pid)) continue;
          seen.add(child.pid);
          tree.push(child);
        }
      }
      // Linux may expose unrelated kernel processes with PGID 0 in the
      // system-wide snapshot. They must not invalidate observation of an
      // otherwise valid ACP tree, but no selected ACP process may carry an
      // unsignalable group identity.
      if (tree.some((row) => row.pgid <= 0)) {
        return settle(() => reject(new Error("ACP process observation was malformed")));
      }
      settle(() => resolve(Object.freeze(tree)));
    });
  });
}

type PosixProcessRow = Readonly<{ pid: number; ppid: number; pgid: number; cpuTimeMs: number }>;

function parsePosixProcessRow(line: string): PosixProcessRow | null {
  const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([^\s]+)\s*$/.exec(line);
  if (!fields) return null;
  const pid = Number(fields[1]);
  const ppid = Number(fields[2]);
  const pgid = Number(fields[3]);
  const cpuTimeMs = parsePosixCpuTime(fields[4]!);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || pgid < 0 || cpuTimeMs === null) return null;
  return Object.freeze({ pid, ppid, pgid, cpuTimeMs });
}

function parsePosixCpuTime(value: string): number | null {
  const days = /^(\d+)-(\d+):(\d{2}):(\d{2})$/.exec(value);
  if (days) return cpuMillis((Number(days[1]) * 24) + Number(days[2]), Number(days[3]), Number(days[4]), 0);
  const hours = /^(\d+):(\d{2}):(\d{2})$/.exec(value);
  if (hours) return cpuMillis(Number(hours[1]), Number(hours[2]), Number(hours[3]), 0);
  // BSD and procps both commonly emit M:SS.CS for `ps time` below an hour.
  const minutes = /^(\d+):(\d{2})\.(\d{1,3})$/.exec(value);
  if (!minutes) return null;
  const totalMinutes = Number(minutes[1]);
  const seconds = Number(minutes[2]);
  const fraction = Number(minutes[3]);
  if (!Number.isSafeInteger(totalMinutes) || !Number.isSafeInteger(seconds) || seconds > 59 || !Number.isSafeInteger(fraction)) return null;
  const milliseconds = fraction * 10 ** (3 - minutes[3]!.length);
  return Math.min(Number.MAX_SAFE_INTEGER, ((totalMinutes * 60 + seconds) * 1_000) + milliseconds);
}

function cpuMillis(hours: number, minutes: number, seconds: number, milliseconds: number): number | null {
  if ([hours, minutes, seconds, milliseconds].some((part) => !Number.isSafeInteger(part)) || minutes > 59 || seconds > 59 || milliseconds > 999) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, (((hours * 60 + minutes) * 60 + seconds) * 1_000) + milliseconds);
}

function concatBytes(chunks: readonly Uint8Array[], bytes: number): Uint8Array {
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function observeStdout(source: ReadableStream<Uint8Array>, onBytes: (bytes: number) => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          release();
          return;
        }
        onBytes(next.value.byteLength);
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        release();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { release(); }
    },
  }, { highWaterMark: 0 });
}

class StderrRing {
  readonly #limit: number;
  #bytes = new Uint8Array(0);
  #seen = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Uint8Array): void {
    this.#seen = Math.min(Number.MAX_SAFE_INTEGER, this.#seen + chunk.byteLength);
    if (chunk.byteLength >= this.#limit) {
      this.#bytes = chunk.slice(chunk.byteLength - this.#limit);
      return;
    }
    const keep = Math.min(this.#bytes.byteLength, this.#limit - chunk.byteLength);
    const next = new Uint8Array(keep + chunk.byteLength);
    next.set(this.#bytes.subarray(this.#bytes.byteLength - keep));
    next.set(chunk, keep);
    this.#bytes = next;
  }

  get state(): AcpStderrState {
    if (this.#seen === 0) return "none";
    return this.#seen > this.#limit ? "truncated" : "present";
  }
}

const nodeClock: AcpHostClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
