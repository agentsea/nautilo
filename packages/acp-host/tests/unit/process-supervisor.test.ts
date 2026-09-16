import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import {
  ACP_DEFAULT_INITIALIZE_TIMEOUT_MS,
  OPENCODE_ACP_INITIALIZE_TIMEOUT_MS,
  ACP_LAUNCH_DEFINITIONS,
  ACP_STDERR_RING_BYTES,
  AcpHostRuntime,
  createNodeAcpProcessTreeAdapter,
  type AcpCanonicalLaunchAdmission,
  type AcpCanonicalLaunchAuthority,
  type AcpHostClock,
  type AcpProcessExit,
  type AcpProcessTreeAdapter,
  type AcpReadyBinding,
  type AcpSpawnAdapter,
  type AcpSpawnSpec,
  type AcpSpawnedProcess,
  type AcpStableV1ReadinessConnector,
} from "../../src/index.js";

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class ManualClock implements AcpHostClock {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, milliseconds: number): number {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + milliseconds, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= this.#now) {
        this.#timers.delete(id);
        timer.callback();
      }
    }
  }
}

type FakeProcess = AcpSpawnedProcess<number> & {
  readonly stdoutController: ReadableStreamDefaultController<Uint8Array>;
  readonly stderrController: ReadableStreamDefaultController<Uint8Array>;
  readonly exit: Deferred<AcpProcessExit>;
  absent: boolean;
  termMakesAbsent: boolean;
  killMakesAbsent: boolean;
  cpuTimeMs: number;
  descendantCount: number;
};

class FakeProcesses implements AcpSpawnAdapter<number>, AcpProcessTreeAdapter<number> {
  readonly specs: AcpSpawnSpec[] = [];
  readonly processes: FakeProcess[] = [];
  readonly signals: Array<readonly [number, "SIGTERM" | "SIGKILL"]> = [];
  stdoutPulls = 0;
  failNextSpawn = false;
  termMakesAbsent = true;
  killMakesAbsent = true;
  pendingSpawn: Deferred<void> | undefined;
  waitSpawnForAbort = false;
  readonly spawnSignals: AbortSignal[] = [];
  hangSignals = false;
  hangProbes = false;

  async spawn(spec: AcpSpawnSpec, signal: AbortSignal): Promise<FakeProcess> {
    this.specs.push(spec);
    this.spawnSignals.push(signal);
    if (this.failNextSpawn) {
      this.failNextSpawn = false;
      throw new Error("private spawn failure with /private/path and pid 99");
    }
    if (this.waitSpawnForAbort) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    const exit = deferred<AcpProcessExit>();
    const process: FakeProcess = {
      groupIdentity: this.processes.length + 100,
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          stdoutController = controller;
        },
        pull: () => { this.stdoutPulls += 1; },
      }),
      stdoutController,
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          stderrController = controller;
        },
      }),
      stderrController,
      exited: exit.promise,
      exit,
      absent: false,
      termMakesAbsent: this.termMakesAbsent,
      killMakesAbsent: this.killMakesAbsent,
      cpuTimeMs: 0,
      descendantCount: 0,
    };
    this.processes.push(process);
    if (this.pendingSpawn) await this.pendingSpawn.promise;
    return process;
  }

  async signalGroup(identity: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    this.signals.push([identity, signal]);
    if (this.hangSignals) return await new Promise<void>(() => undefined);
    const process = this.processes.find((candidate) => candidate.groupIdentity === identity)!;
    if ((signal === "SIGTERM" && process.termMakesAbsent) || (signal === "SIGKILL" && process.killMakesAbsent)) {
      process.absent = true;
      process.exit.resolve({ code: null, signal });
    }
  }

  async isGroupAbsent(identity: number): Promise<boolean> {
    if (this.hangProbes) return await new Promise<boolean>(() => undefined);
    return this.processes.find((candidate) => candidate.groupIdentity === identity)?.absent ?? true;
  }

  async observeGroup(identity: number): Promise<{ processCount: number; descendantCount: number; cpuTimeMs: number }> {
    const process = this.processes.find((candidate) => candidate.groupIdentity === identity);
    if (!process || process.absent) return { processCount: 0, descendantCount: 0, cpuTimeMs: 0 };
    return { processCount: 1 + process.descendantCount, descendantCount: process.descendantCount, cpuTimeMs: process.cpuTimeMs };
  }
}

class FakeReadiness implements AcpStableV1ReadinessConnector {
  readonly calls: Array<{ cwd: string; signal: AbortSignal }> = [];
  readonly bindings: Array<{ closed: number }> = [];
  pending: Deferred<AcpReadyBinding> | undefined;
  failNext = false;
  waitForAbort = false;

  async connect(request: Parameters<AcpStableV1ReadinessConnector["connect"]>[0]): Promise<AcpReadyBinding> {
    this.calls.push({ cwd: request.cwd, signal: request.signal });
    if (this.failNext) {
      this.failNext = false;
      throw new Error("private protocol failure and secret output");
    }
    if (this.waitForAbort) {
      return await new Promise<AcpReadyBinding>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (this.pending) return this.pending.promise;
    const state = { closed: 0 };
    this.bindings.push(state);
    return { close: async () => { state.closed += 1; } };
  }
}

const baseEnvironment = Object.freeze({
  PATH: "/managed/bin:/usr/bin",
  HOME: "/managed/home",
  TMPDIR: "/managed/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
});

function admission(registrationId: "hermes-acp" | "opencode-acp"): AcpCanonicalLaunchAdmission {
  return {
    executablePath: registrationId === "hermes-acp" ? "/approved/bin/hermes" : "/approved/bin/opencode",
    cwd: "/approved/workspace",
    environment: baseEnvironment,
  };
}

function harness(options: {
  admission?: (registrationId: "hermes-acp" | "opencode-acp") => AcpCanonicalLaunchAdmission;
  resolve?: AcpCanonicalLaunchAuthority["resolveAndRevalidate"];
  maxChildren?: number;
  initializeTimeoutMs?: number;
} = {}) {
  const clock = new ManualClock();
  const processes = new FakeProcesses();
  const readiness = new FakeReadiness();
  const runtime = new AcpHostRuntime({
    launches: {
      resolveAndRevalidate: options.resolve ?? (async (request) => (options.admission ?? admission)(request.registrationId)),
    },
    processes,
    processTree: processes,
    readiness,
    clock,
    platform: "posix",
    pathDelimiter: ":",
    ...(options.maxChildren === undefined ? {} : { maxChildren: options.maxChildren }),
    ...(options.initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs: options.initializeTimeoutMs }),
  });
  return { runtime, clock, processes, readiness };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function driveGrace(clock: ManualClock, attempts = 16): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await flush();
    clock.advance(2_000);
  }
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("AcpHostRuntime", () => {
  test("uses only reviewed shell-free definitions, exact canonical cwd, and a fresh allowlisted env", async () => {
    const h = harness();
    const hermes = await h.runtime.start({ bindingId: "binding-hermes", registrationId: "hermes-acp" });
    expect(h.processes.specs[0]).toEqual({
      executablePath: "/approved/bin/hermes",
      args: ["-p", "nautilo-acp", "acp"],
      cwd: "/approved/workspace",
      env: { ...baseEnvironment, HERMES_ACP_SKIP_CONFIGURED_MCP: "1" },
      shell: false,
      detached: true,
    });
    expect(h.readiness.calls[0]?.cwd).toBe("/approved/workspace");
    expect(hermes).toEqual({ bindingId: "binding-hermes", registrationId: "hermes-acp", generation: 1, state: "ready", stderr: "none" });
    expect(JSON.stringify(hermes)).not.toContain("approved");
    await h.runtime.stop("binding-hermes", 1);

    await h.runtime.start({ bindingId: "binding-opencode", registrationId: "opencode-acp" });
    expect(h.processes.specs[1]).toMatchObject({
      executablePath: "/approved/bin/opencode",
      args: ["acp"],
      cwd: "/approved/workspace",
      env: baseEnvironment,
      shell: false,
      detached: true,
    });
    expect(ACP_LAUNCH_DEFINITIONS["hermes-acp"].args).toEqual(["-p", "nautilo-acp", "acp"]);
  });

  test("reports only fixed exact-generation health metadata and rejects stale siblings", async () => {
    const h = harness();
    await h.runtime.start({ bindingId: "binding", registrationId: "opencode-acp" });
    const process = h.processes.processes[0]!;
    process.cpuTimeMs = 17;
    process.descendantCount = 1;
    h.runtime.recordProtocolProgress("binding", 1);
    process.stderrController.enqueue(new TextEncoder().encode("private stderr bytes only"));
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();

    const snapshot = await h.runtime.health("binding", 1);
    expect(snapshot).toEqual({
      groupPresent: true,
      exited: false,
      stdoutBytes: 0,
      stderrBytes: "private stderr bytes only".length,
      protocolEvents: 1,
      processCount: 2,
      descendantCount: 1,
      cpuTimeMs: 17,
      groupObservationAvailable: true,
    });
    expect(Object.values(snapshot).every((value) => typeof value === "number" || typeof value === "boolean")).toBeTrue();
    expect(JSON.stringify(snapshot)).not.toContain("private");
    await expectCode(h.runtime.health("binding", 2), "generation_stale");
    await h.runtime.stop("binding", 1);
  });

  test("distinguishes optional group-observer unavailability from an exited exact group", async () => {
    const h = harness();
    await h.runtime.start({ bindingId: "binding", registrationId: "opencode-acp" });
    h.processes.observeGroup = async () => { throw new Error("observer unavailable"); };
    expect(await h.runtime.health("binding", 1)).toMatchObject({
      groupPresent: true,
      exited: false,
      groupObservationAvailable: false,
      processCount: 0,
      descendantCount: 0,
      cpuTimeMs: 0,
    });
    h.processes.processes[0]!.absent = true;
    expect(await h.runtime.health("binding", 1)).toMatchObject({ groupPresent: false, exited: false });
    await h.runtime.stop("binding", 1);
  });

  test("counts OpenCode stdout on the readiness consumer path without pulling ahead", async () => {
    const clock = new ManualClock();
    const processes = new FakeProcesses();
    let input: ReadableStream<Uint8Array> | undefined;
    let pullsAtConnect = -1;
    const runtime = new AcpHostRuntime({
      launches: { resolveAndRevalidate: async (request) => admission(request.registrationId) },
      processes,
      processTree: processes,
      clock,
      platform: "posix" as const,
      pathDelimiter: ":",
      readiness: {
        connect: async (request) => {
          input = request.input;
          pullsAtConnect = processes.stdoutPulls;
          return { close: async () => undefined };
        },
      },
    });
    await runtime.start({ bindingId: "binding", registrationId: "opencode-acp" });
    // Capturing a readiness input must not start consuming the process stream.
    expect(processes.stdoutPulls).toBe(pullsAtConnect);
    const reader = input!.getReader();
    const pending = reader.read();
    for (let attempt = 0; attempt < 4; attempt += 1) await flush();
    expect(processes.stdoutPulls).toBe(pullsAtConnect + 1);
    processes.processes[0]!.stdoutController.enqueue(new TextEncoder().encode("private stdout bytes only"));
    expect((await pending).value?.byteLength).toBe("private stdout bytes only".length);
    expect((await runtime.health("binding", 1)).stdoutBytes).toBe("private stdout bytes only".length);
    await reader.cancel();
    await runtime.stop("binding", 1);
  });

  test("rejects noncanonical paths, executable substitution, and non-allowlisted environment before spawn", async () => {
    const cases: AcpCanonicalLaunchAdmission[] = [
      { ...admission("hermes-acp"), cwd: "/approved/../different" },
      { ...admission("hermes-acp"), executablePath: "/approved/bin/opencode" },
      { ...admission("hermes-acp"), environment: { ...baseEnvironment, OPENAI_API_KEY: "must-not-cross" } },
    ];
    for (const [index, value] of cases.entries()) {
      const h = harness({ admission: () => value });
      await expectCode(h.runtime.start({ bindingId: `binding-${index}`, registrationId: "hermes-acp" }), "unavailable");
      expect(h.processes.processes).toHaveLength(0);
    }
  });

  test("enforces exact PATH entry count and entry byte bounds", async () => {
    const exactCount = Array.from({ length: 32 }, (_, index) => `/p${index}`).join(":");
    const exactWidth = `/${"x".repeat(4 * 1024 - 1)}`;
    for (const [index, path] of [exactCount, exactWidth].entries()) {
      const h = harness({ admission: (id) => ({ ...admission(id), environment: { ...baseEnvironment, PATH: path } }) });
      const status = await h.runtime.start({ bindingId: `exact-path-${index}`, registrationId: "hermes-acp" });
      expect(status.state).toBe("ready");
      await h.runtime.stop(`exact-path-${index}`, 1);
    }
    const tooMany = Array.from({ length: 33 }, (_, index) => `/p${index}`).join(":");
    const tooWide = `/${"x".repeat(4 * 1024)}`;
    for (const [index, path] of [tooMany, tooWide].entries()) {
      const h = harness({ admission: (id) => ({ ...admission(id), environment: { ...baseEnvironment, PATH: path } }) });
      await expectCode(h.runtime.start({ bindingId: `path-${index}`, registrationId: "hermes-acp" }), "unavailable");
      expect(h.processes.processes).toHaveLength(0);
    }
  });

  test("locks initialize, grace, and child-capacity overrides at their reviewed maxima", () => {
    const h = harness();
    expect(() => new AcpHostRuntime({
      launches: h.runtime.options.launches,
      processes: h.processes,
      processTree: h.processes,
      readiness: h.readiness,
      initializeTimeoutMs: OPENCODE_ACP_INITIALIZE_TIMEOUT_MS + 1,
    })).toThrow();
    expect(() => new AcpHostRuntime({
      launches: h.runtime.options.launches,
      processes: h.processes,
      processTree: h.processes,
      readiness: h.readiness,
      initializeTimeoutMs: OPENCODE_ACP_INITIALIZE_TIMEOUT_MS,
    })).not.toThrow();
    expect(() => new AcpHostRuntime({
      launches: h.runtime.options.launches,
      processes: h.processes,
      processTree: h.processes,
      readiness: h.readiness,
      terminationGraceMs: 2_001,
    })).toThrow();
    expect(() => new AcpHostRuntime({
      launches: h.runtime.options.launches,
      processes: h.processes,
      processTree: h.processes,
      readiness: h.readiness,
      maxChildren: 5,
    })).toThrow();
  });

  test("admits exactly four child bindings and rejects N+1 without affecting siblings", async () => {
    const h = harness();
    for (let index = 0; index < 4; index += 1) {
      await h.runtime.start({ bindingId: `binding-${index}`, registrationId: index % 2 === 0 ? "hermes-acp" : "opencode-acp" });
    }
    await expectCode(h.runtime.start({ bindingId: "binding-4", registrationId: "hermes-acp" }), "unavailable");
    expect(h.processes.processes).toHaveLength(4);
    for (let index = 0; index < 4; index += 1) expect(h.runtime.status(`binding-${index}`).state).toBe("ready");
  });

  test("monotonic generations fence stale exit and stop callbacks from a replacement", async () => {
    const h = harness();
    await h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    const first = h.processes.processes[0]!;
    await h.runtime.stop("binding", 1);
    const second = await h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    expect(second.generation).toBe(2);
    first.exit.resolve({ code: 1, signal: null });
    await flush();
    expect(h.runtime.status("binding")).toMatchObject({ generation: 2, state: "ready" });
    await expectCode(h.runtime.stop("binding", 1), "generation_stale");
    expect(h.processes.signals.filter(([identity]) => identity === h.processes.processes[1]!.groupIdentity)).toHaveLength(0);
  });

  test("applies a 10 second readiness deadline, aborts integration, and contains the exact group", async () => {
    const h = harness();
    h.readiness.waitForAbort = true;
    const start = h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    await flush();
    expect(h.runtime.status("binding").state).toBe("starting");
    h.clock.advance(ACP_DEFAULT_INITIALIZE_TIMEOUT_MS);
    await expectCode(start, "unavailable");
    expect(h.readiness.calls[0]?.signal.aborted).toBe(true);
    expect(h.processes.signals).toEqual([[100, "SIGTERM"]]);
    expect(h.runtime.status("binding")).toMatchObject({ generation: 1, state: "unavailable" });
  });

  test("admits a delayed valid OpenCode cold start within its explicit 30 second handshake window", async () => {
    const h = harness({ initializeTimeoutMs: OPENCODE_ACP_INITIALIZE_TIMEOUT_MS });
    h.readiness.pending = deferred<AcpReadyBinding>();
    const start = h.runtime.start({ bindingId: "cold-opencode", registrationId: "opencode-acp" });
    await flush();
    h.clock.advance(16_960);
    let settled = false;
    void start.finally(() => { settled = true; }).catch(() => undefined);
    await flush();
    expect(settled).toBeFalse();
    h.readiness.pending.resolve({ close: async () => undefined });
    expect(await start).toMatchObject({ state: "ready", registrationId: "opencode-acp" });
    expect(h.processes.signals).toEqual([]);
  });

  test("contains OpenCode only when its explicit 30 second handshake window expires", async () => {
    const h = harness({ initializeTimeoutMs: OPENCODE_ACP_INITIALIZE_TIMEOUT_MS });
    h.readiness.waitForAbort = true;
    const start = h.runtime.start({ bindingId: "cold-opencode", registrationId: "opencode-acp" });
    await flush();
    h.clock.advance(OPENCODE_ACP_INITIALIZE_TIMEOUT_MS - 1);
    await flush();
    expect(h.processes.signals).toEqual([]);
    h.clock.advance(1);
    await expectCode(start, "unavailable");
    expect(h.readiness.calls[0]?.signal.aborted).toBeTrue();
    expect(h.processes.signals).toEqual([[100, "SIGTERM"]]);
  });

  test("the same 10 second deadline covers a cooperative launch-authority stall and clears capacity", async () => {
    let authoritySignal: AbortSignal | undefined;
    const h = harness({
      maxChildren: 1,
      resolve: async (request, signal) => {
        if (request.bindingId !== "stalled") return admission(request.registrationId);
        authoritySignal = signal;
        return await new Promise<AcpCanonicalLaunchAdmission>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    const start = h.runtime.start({ bindingId: "stalled", registrationId: "hermes-acp" });
    await flush();
    h.clock.advance(ACP_DEFAULT_INITIALIZE_TIMEOUT_MS);
    await expectCode(start, "unavailable");
    expect(authoritySignal?.aborted).toBe(true);
    expect(h.processes.processes).toHaveLength(0);
    await flush();
    expect(h.runtime.status("stalled").state).toBe("unavailable");
    const sibling = await h.runtime.start({ bindingId: "sibling", registrationId: "opencode-acp" });
    expect(sibling.state).toBe("ready");
  });

  test("the same 10 second deadline covers a cooperative pre-process spawn stall", async () => {
    const h = harness();
    h.processes.waitSpawnForAbort = true;
    const start = h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    await flush();
    h.clock.advance(ACP_DEFAULT_INITIALIZE_TIMEOUT_MS);
    await expectCode(start, "unavailable");
    expect(h.processes.spawnSignals[0]?.aborted).toBe(true);
    expect(h.processes.processes).toHaveLength(0);
    expect(h.runtime.status("binding").state).toBe("unavailable");
    h.processes.waitSpawnForAbort = false;
    const retry = await h.runtime.start({ bindingId: "binding", registrationId: "opencode-acp" });
    expect(retry).toMatchObject({ state: "ready", generation: 2 });
  });

  test("a late readiness binding is closed after the total start deadline", async () => {
    const h = harness();
    const pending = deferred<AcpReadyBinding>();
    h.readiness.pending = pending;
    const state = { closed: 0 };
    const start = h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    await flush();
    h.clock.advance(ACP_DEFAULT_INITIALIZE_TIMEOUT_MS);
    pending.resolve({ close: async () => { state.closed += 1; } });
    await expectCode(start, "unavailable");
    for (let attempt = 0; attempt < 8; attempt += 1) await flush();
    expect(state.closed).toBe(1);
  });

  test("four distinct noncooperative timed-out starts retain all global capacity until exact settlement", async () => {
    const h = harness();
    h.processes.pendingSpawn = deferred<void>();
    const starts = Array.from({ length: 4 }, (_, index) =>
      h.runtime.start({ bindingId: `stalled-${index}`, registrationId: index % 2 === 0 ? "hermes-acp" : "opencode-acp" }));
    await flush();
    h.clock.advance(ACP_DEFAULT_INITIALIZE_TIMEOUT_MS);
    await flush();
    await expectCode(h.runtime.start({ bindingId: "overflow", registrationId: "hermes-acp" }), "unavailable");
    expect(h.processes.processes).toHaveLength(4);
    h.processes.pendingSpawn.resolve(undefined);
    for (const start of starts) await expectCode(start, "unavailable");
    expect(h.processes.signals).toEqual([
      [100, "SIGTERM"],
      [101, "SIGTERM"],
      [102, "SIGTERM"],
      [103, "SIGTERM"],
    ]);
  });

  test("a timed-out late spawn reports cleanup uncertainty when exact containment fails", async () => {
    const h = harness();
    h.processes.termMakesAbsent = false;
    h.processes.killMakesAbsent = false;
    h.processes.pendingSpawn = deferred<void>();
    const start = h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    await flush();
    h.clock.advance(ACP_DEFAULT_INITIALIZE_TIMEOUT_MS);
    await flush();
    h.processes.pendingSpawn.resolve(undefined);
    // Drive both bounded signal/wait/probe stages, but stay below the outer
    // 15-second settlement ceiling (clock is at 10s here; seven steps reach 24s).
    await driveGrace(h.clock, 7);
    await expectCode(start, "cleanup_uncertain");
    expect(h.runtime.status("binding")).toMatchObject({ state: "cleanup_uncertain", generation: 1 });
    expect(h.processes.signals).toEqual([[100, "SIGTERM"], [100, "SIGKILL"]]);
    await expectCode(h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" }), "cleanup_uncertain");
  });

  test("shutdown cancels a pending launch and contains a process that arrives late", async () => {
    const h = harness();
    h.processes.pendingSpawn = deferred<void>();
    const start = h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    await flush();
    let shutdownSettled = false;
    const shutdown = h.runtime.shutdown().then(() => { shutdownSettled = true; });
    await flush();
    expect(shutdownSettled).toBe(false);
    h.processes.pendingSpawn.resolve(undefined);
    await shutdown;
    expect(shutdownSettled).toBe(true);
    await expectCode(start, "generation_stale");
    expect(h.processes.signals).toEqual([[100, "SIGTERM"]]);
    expect(h.runtime.status("binding").state).toBe("unavailable");
    await expectCode(h.runtime.start({ bindingId: "later", registrationId: "hermes-acp" }), "unavailable");
  });

  test("an exit during abort-aware readiness settles start without restart or an orphan", async () => {
    const h = harness();
    h.readiness.waitForAbort = true;
    const start = h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    await flush();
    const process = h.processes.processes[0]!;
    process.absent = true;
    process.exit.resolve({ code: 9, signal: null });
    await expectCode(start, "unavailable");
    expect(h.readiness.calls[0]?.signal.aborted).toBe(true);
    expect(h.runtime.status("binding").state).toBe("unavailable");
    expect(h.processes.processes).toHaveLength(1);
  });

  test("spawn and readiness failures are sanitized, registration-local, and retryable", async () => {
    const h = harness();
    h.processes.failNextSpawn = true;
    try {
      await h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "unavailable", message: "ACP process could not be started" });
      expect(String(error)).not.toContain("private");
    }
    const retry = await h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    expect(retry).toMatchObject({ generation: 2, state: "ready" });

    h.readiness.failNext = true;
    await expectCode(h.runtime.start({ bindingId: "sibling", registrationId: "opencode-acp" }), "unavailable");
    expect(h.runtime.status("binding").state).toBe("ready");
    expect(h.runtime.status("sibling").state).toBe("unavailable");
  });

  test("retains only bounded stderr internally and exports content-free state", async () => {
    const h = harness();
    await h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    const process = h.processes.processes[0]!;
    process.stderrController.enqueue(new TextEncoder().encode("secret path /private/work and token"));
    await flush();
    expect(h.runtime.status("binding").stderr).toBe("present");
    process.stderrController.enqueue(new Uint8Array(ACP_STDERR_RING_BYTES));
    await flush();
    const status = h.runtime.status("binding");
    expect(status.stderr).toBe("truncated");
    expect(JSON.stringify(status)).not.toMatch(/secret|private|token|pid|path/);
  });

  test("uses exact generation TERM then KILL and blocks a successor when absence is uncertain", async () => {
    const h = harness();
    h.processes.termMakesAbsent = false;
    h.processes.killMakesAbsent = false;
    await h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    const stop = h.runtime.stop("binding", 1);
    await driveGrace(h.clock);
    const result = await stop;
    expect(h.processes.signals).toEqual([[100, "SIGTERM"], [100, "SIGKILL"]]);
    expect(result).toMatchObject({ generation: 1, state: "cleanup_uncertain" });
    await expectCode(h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" }), "cleanup_uncertain");
    expect(h.processes.processes).toHaveLength(1);
    h.processes.processes[0]!.absent = true;
    const recovered = await h.runtime.stop("binding", 1);
    expect(recovered).toMatchObject({ generation: 1, state: "absent" });
    h.processes.termMakesAbsent = true;
    h.processes.killMakesAbsent = true;
    const successor = await h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    expect(successor).toMatchObject({ generation: 2, state: "ready" });
    await expectCode(h.runtime.stop("binding", 1), "generation_stale");
  });

  test("bounds stalled signal and absence adapters and reports cleanup uncertainty", async () => {
    const h = harness();
    await h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    h.processes.hangSignals = true;
    h.processes.hangProbes = true;
    const stop = h.runtime.stop("binding", 1);
    await driveGrace(h.clock, 24);
    const status = await stop;
    expect(status.state).toBe("cleanup_uncertain");
    expect(h.processes.signals).toEqual([[100, "SIGTERM"], [100, "SIGKILL"]]);
  });

  test("unexpected exit does not restart and cannot disturb a live sibling", async () => {
    const h = harness();
    await h.runtime.start({ bindingId: "a", registrationId: "hermes-acp" });
    await h.runtime.start({ bindingId: "b", registrationId: "opencode-acp" });
    const first = h.processes.processes[0]!;
    first.absent = true;
    first.exit.resolve({ code: 7, signal: null });
    for (let attempt = 0; attempt < 20; attempt += 1) await flush();
    expect(h.runtime.status("a")).toMatchObject({ generation: 1, state: "unavailable" });
    expect(h.runtime.status("b")).toMatchObject({ generation: 1, state: "ready" });
    expect(h.processes.processes).toHaveLength(2);
    expect(h.processes.signals).toHaveLength(0);
  });

  test("unexpected root exit TERM-cleans surviving descendants before reporting unavailable", async () => {
    const h = harness();
    await h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    const process = h.processes.processes[0]!;
    expect(process.absent).toBe(false);
    process.exit.resolve({ code: 8, signal: null });
    for (let attempt = 0; attempt < 20; attempt += 1) await flush();
    expect(h.processes.signals).toEqual([[100, "SIGTERM"]]);
    expect(h.runtime.status("binding")).toMatchObject({ state: "unavailable", generation: 1 });
  });

  test("unexpected root exit escalates surviving descendants from TERM to KILL", async () => {
    const h = harness();
    h.processes.termMakesAbsent = false;
    h.processes.killMakesAbsent = true;
    await h.runtime.start({ bindingId: "binding", registrationId: "hermes-acp" });
    const process = h.processes.processes[0]!;
    process.exit.resolve({ code: 8, signal: null });
    for (let attempt = 0; attempt < 24; attempt += 1) await flush();
    expect(h.processes.signals).toEqual([[100, "SIGTERM"], [100, "SIGKILL"]]);
    expect(h.runtime.status("binding")).toMatchObject({ state: "unavailable", generation: 1 });
  });

  test("the built-in Node process-tree adapter fails closed on Windows without a Job Object", () => {
    expect(() => createNodeAcpProcessTreeAdapter("win32")).toThrow("ACP process-tree containment is unavailable");
  });

  test("the built-in POSIX adapter contains independently detached descendant groups", async () => {
    if (process.platform === "win32") return;
    const detachedChildScript = [
      'const { spawn } = require("node:child_process");',
      'process.on("SIGTERM", () => undefined);',
      'const leaf = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => undefined); setInterval(() => undefined, 1_000)"], { detached: true, stdio: "ignore" });',
      "leaf.unref();",
      'process.stdout.write(String(leaf.pid) + "\\n");',
      "setInterval(() => undefined, 1_000);",
    ].join("\n");
    const root = spawn(process.execPath, ["-e", [
      'const { spawn } = require("node:child_process");',
      'process.on("SIGTERM", () => undefined);',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(detachedChildScript)}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });`,
      'child.stdout.once("data", (data) => process.stdout.write(String(child.pid) + ":" + data));',
      "setInterval(() => undefined, 1_000);",
    ].join("\n")], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!root.pid || !root.stdout) throw new Error("Detached ACP test root did not start");
    const rootPid = root.pid;
    const rootStdout = root.stdout;
    let childPid: number | undefined;
    let leafPid: number | undefined;
    try {
      [childPid, leafPid] = await new Promise<readonly [number, number]>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Detached ACP test child did not start")), 5_000);
        root.once("error", reject);
        rootStdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          const line = output.split("\n")[0];
          if (!line) return;
          const parsed = line.split(":").map(Number);
          if (parsed.length !== 2 || parsed.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) return;
          clearTimeout(timer);
          resolve([parsed[0]!, parsed[1]!] as const);
        });
      });
      const adapter = createNodeAcpProcessTreeAdapter(process.platform);
      let observation = await adapter.observeGroup!(rootPid);
      for (let attempt = 0; attempt < 50 && observation.descendantCount < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        observation = await adapter.observeGroup!(rootPid);
      }
      expect(observation.processCount).toBeGreaterThanOrEqual(3);
      expect(observation.descendantCount).toBeGreaterThanOrEqual(2);

      await adapter.signalGroup(rootPid, "SIGTERM");
      let absent = false;
      for (let attempt = 0; attempt < 100 && !absent; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        absent = await adapter.isGroupAbsent(rootPid);
      }
      expect(absent).toBe(true);
      expect(pidIsAbsent(rootPid)).toBe(true);
      expect(pidIsAbsent(childPid)).toBe(true);
      expect(pidIsAbsent(leafPid)).toBe(true);
    } finally {
      killExactGroupBestEffort(rootPid);
      if (childPid !== undefined) killExactGroupBestEffort(childPid);
      if (leafPid !== undefined) killExactGroupBestEffort(leafPid);
    }
  });

  test("the built-in POSIX adapter never claims absence after ancestry was lost before capture", async () => {
    if (process.platform === "win32") return;
    const root = spawn(process.execPath, ["-e", [
      'const { spawn } = require("node:child_process");',
      'const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });',
      "child.unref();",
      'process.stdout.write(String(child.pid) + "\\n");',
      "setInterval(() => undefined, 1_000);",
    ].join("\n")], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    if (!root.pid || !root.stdout) throw new Error("Detached ACP uncertainty root did not start");
    const rootPid = root.pid;
    const rootStdout = root.stdout;
    let childPid: number | undefined;
    try {
      childPid = await new Promise<number>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Detached ACP uncertainty child did not start")), 5_000);
        root.once("error", reject);
        rootStdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          const parsed = Number(output.split("\n")[0]);
          if (!Number.isSafeInteger(parsed) || parsed <= 0) return;
          clearTimeout(timer);
          resolve(parsed);
        });
      });
      process.kill(-rootPid, "SIGKILL");
      for (let attempt = 0; attempt < 100 && !pidIsAbsent(rootPid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pidIsAbsent(rootPid)).toBe(true);
      expect(pidIsAbsent(childPid)).toBe(false);

      const adapter = createNodeAcpProcessTreeAdapter(process.platform);
      expect(await adapter.isGroupAbsent(rootPid)).toBe(false);
      await adapter.signalGroup(rootPid, "SIGTERM");
      expect(await adapter.isGroupAbsent(rootPid)).toBe(false);
      expect(pidIsAbsent(childPid)).toBe(false);
    } finally {
      killExactGroupBestEffort(rootPid);
      if (childPid !== undefined) killExactGroupBestEffort(childPid);
    }
  });
});

function pidIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function killExactGroupBestEffort(identity: number): void {
  try {
    process.kill(-identity, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The assertions above already proved the owned processes absent. Under
    // rapid repeated runs the kernel may reuse the numeric process-group ID
    // for a foreign group before this emergency cleanup executes; never fail
    // or signal that unrelated replacement.
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}
