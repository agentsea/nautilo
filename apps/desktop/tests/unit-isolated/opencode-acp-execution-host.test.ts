import { describe, expect, test } from "bun:test";
import type {
  RelayAcpClientMessage,
  RelayAcpHostTransport,
  RelayAcpPrepareCommand,
  RelayAcpSession,
  RelayAcpStartCommand,
} from "@nautilo/relay";
import { ACP_EXECUTION_RECEIPT_LIFETIME_MS, ElectronOpenCodeAcpExecutionHost, type ElectronOpenCodeAcpTurnClock } from "../../electron/opencode-acp-execution-host";
import {
  ACP_TOTAL_TEARDOWN_TIMEOUT_MS,
  AcpHostRuntime,
  OPENCODE_ACP_INITIALIZE_TIMEOUT_MS,
  createAcpStableV1LiveSessionConnector,
  type AcpCanonicalLaunchAdmission,
  type AcpHostClock,
  type AcpHostRuntime as AcpHostRuntimeType,
  type AcpProcessExit,
  type AcpProcessTreeAdapter,
  type AcpSpawnAdapter,
  type AcpSpawnSpec,
  type AcpSpawnedProcess,
} from "@nautilo/acp-host";
import { validateAcpInitializeCapabilityTruth } from "../../../../packages/acp-host/src/capability-truth";

const UNSUPPORTED_REQUEST_CAPABILITIES = validateAcpInitializeCapabilityTruth({ protocolVersion: 1, agentCapabilities: {} });

const socket: RelayAcpSession = {
  relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop-session",
  pairingGenerationRef: "pairing", selectedProtocolVersion: 15, capabilityRevision: 1,
};
const binding = {
  bindingId: "binding", bindingGeneration: "binding-generation", ownerId: "owner", taskId: "task",
  taskRunId: "task-run", jobId: "job", profileId: "profile", profileGeneration: "profile-generation",
  postureId: "posture", postureGeneration: "posture-generation",
} as const;

function prepare(requestId: string): RelayAcpPrepareCommand {
  return { type: "relay:acp-prepare", requestId, registrationId: "opencode-acp", scope: socket, binding };
}
function prepareFor(requestId: string, nextBinding: typeof binding): RelayAcpPrepareCommand {
  return { type: "relay:acp-prepare", requestId, registrationId: "opencode-acp", scope: socket, binding: nextBinding };
}

type Json = Record<string, unknown>;
type FakePeerKind = "normal" | "malformed" | "end_turn_without_candidate" | "stall" | "emit_stall" | "permission_wait" | "set_mode_rejected";
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((yes) => { resolve = yes; }), resolve };
}
function isRequest(value: Json, method: string): value is Json & { id: string | number } {
  return value["method"] === method && (typeof value["id"] === "string" || typeof value["id"] === "number");
}
function startFrom(
  prepared: Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>,
  executionProfile: "interactive" | "autonomous" | "plan" = "interactive",
): RelayAcpStartCommand {
  return {
    type: "relay:acp-start", registrationId: "opencode-acp", prompt: "answer the task",
    executionProfile,
    scope: { socket: prepared.scope, binding: prepared.binding, workspace: prepared.workspace },
  };
}
function within<T>(work: Promise<T>, milliseconds = 3_000): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error("bounded ACP test timed out")), milliseconds)),
  ]);
}
async function eventually(predicate: () => boolean, milliseconds = 3_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("bounded ACP condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class ManualTurnClock implements ElectronOpenCodeAcpTurnClock {
  #now = 0;
  #next = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, milliseconds: number): number {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.#now + milliseconds, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.#timers.delete(handle as number); }
  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= this.#now)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) return;
      this.#timers.delete(due[0]);
      due[1].callback();
    }
  }
}

class FakeAcpPeer {
  readonly #toAgent = new TransformStream<Uint8Array, Uint8Array>();
  readonly #fromAgent = new TransformStream<Uint8Array, Uint8Array>();
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  readonly methods: string[] = [];
  readonly modeIds: string[] = [];
  error: unknown;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  readonly #output: WritableStream<Uint8Array>;

  constructor(
    private readonly advertisedModeIds: readonly string[] = ["build", "plan"],
    private readonly currentModeId = "build",
    private readonly sessionNewGate?: Promise<void>,
  ) {
    const target = this.#toAgent;
    this.#output = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        const writer = target.writable.getWriter();
        try { await writer.write(chunk); } finally { writer.releaseLock(); }
      },
      close: async () => {
        const writer = target.writable.getWriter();
        try { await writer.close(); } finally { writer.releaseLock(); }
      },
      abort: async (reason) => {
        const writer = target.writable.getWriter();
        try { await writer.abort(reason); } finally { writer.releaseLock(); }
      },
    });
  }

  get stdin(): WritableStream<Uint8Array> { return this.#output; }
  get stdout(): ReadableStream<Uint8Array> { return this.#fromAgent.readable; }

  latePromptAttempted = false;
  promptId: string | number | undefined;
  permissionRequestSeen = false;
  permissionResponse: Json | undefined;
  start(kind: FakePeerKind = "normal"): void { void this.#receive(kind).catch((error: unknown) => { this.error = error; }); }

  async #send(value: Json): Promise<void> {
    this.#writer ??= this.#fromAgent.writable.getWriter();
    await this.#writer.write(this.#encoder.encode(`${JSON.stringify(value)}\n`));
  }

  async emitText(text: string): Promise<void> {
    await this.#send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-opaque", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId: "item-opaque" } } });
  }

  async sendLatePromptResult(): Promise<void> {
    if (this.promptId === undefined) throw new Error("prompt was not admitted");
    await this.#send({ jsonrpc: "2.0", id: this.promptId, result: { stopReason: "end_turn" } });
    await this.#close();
  }

  /** Stable-v1 permission traffic is injected only after the prompt is live. */
  async emitPermissionRequest(options: readonly Json[] = [{ optionId: "allow", name: "Allow", kind: "allow_once" }]): Promise<void> {
    if (this.promptId === undefined) throw new Error("prompt was not admitted");
    this.permissionRequestSeen = true;
    await this.#send({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "session-opaque",
        toolCall: { toolCallId: "tool-permission" },
        options,
      },
    });
    // A provider completion racing its own permission request cannot revive
    // this faulted turn into a completed/user-stop terminal.
    this.latePromptAttempted = true;
    await this.#send({ jsonrpc: "2.0", id: this.promptId, result: { stopReason: "end_turn" } }).catch(() => undefined);
    await this.#close();
  }

  async #close(): Promise<void> { await this.#writer?.close().catch(() => undefined); }

  async #receive(kind: FakePeerKind): Promise<void> {
    const reader = this.#toAgent.readable.getReader();
    let pending = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        pending += this.#decoder.decode(next.value, { stream: true });
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as Json;
          if (typeof message["method"] === "string") this.methods.push(message["method"]);
          if (message["id"] === "permission-1" && message["method"] === undefined) {
            this.permissionResponse = message;
          }
          if (isRequest(message, "initialize")) {
            await this.#send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentInfo: { name: "fixture", version: "1" } } });
          } else if (isRequest(message, "session/new")) {
            await this.sessionNewGate;
            const availableModes = [
              { id: "build", name: "Build", description: "Execute with native permissions." },
              { id: "plan", name: "Plan", description: "Plan without ordinary edits." },
              ...(this.currentModeId === "build" || this.currentModeId === "plan"
                ? []
                : [{ id: this.currentModeId, name: "Owner primary", description: "Owner-selected primary mode." }]),
            ].filter((mode) => this.advertisedModeIds.includes(mode.id));
            await this.#send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                sessionId: "session-opaque",
                modes: {
                  currentModeId: this.currentModeId,
                  availableModes,
                },
              },
            });
          } else if (isRequest(message, "session/set_mode")) {
            const params = message["params"] as Json;
            if (typeof params["modeId"] === "string") this.modeIds.push(params["modeId"]);
            if (kind === "set_mode_rejected") {
              await this.#send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "private mode rejection detail" } });
              continue;
            }
            await this.#send({ jsonrpc: "2.0", id: message.id, result: {} });
          } else if (isRequest(message, "session/prompt")) {
            this.promptId = message.id;
            if (kind === "malformed") {
              await this.#send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "wrong-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "private raw ACP" } } } });
              await new Promise((resolve) => setTimeout(resolve, 10));
              this.latePromptAttempted = true;
              await this.#send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }).catch(() => undefined);
            } else if (kind === "end_turn_without_candidate") {
              await this.#send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
            } else if (kind === "stall") {
              continue;
            } else if (kind === "emit_stall") {
              await this.#send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-opaque", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before reconnect" }, messageId: "item-opaque" } } });
              continue;
            } else if (kind === "permission_wait") {
              continue;
            } else {
              await this.#send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-opaque", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "safe output" }, messageId: "item-opaque" } } });
              await this.#send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-opaque", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-opaque", title: "safe command", status: "completed" } } });
              await this.#send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
            }
            if (kind !== "stall" && kind !== "permission_wait") {
              // A completed prompt is the terminal inbound fact for this fake.
              // Closing it prevents the adapter's reader from retaining this test.
              await this.#close();
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

type FakeProcess = AcpSpawnedProcess<number> & {
  readonly exit: Deferred<AcpProcessExit>;
  absent: boolean;
  cpuTimeMs: number;
  descendantCount: number;
};
class FakeProcessRuntime implements AcpSpawnAdapter<number>, AcpProcessTreeAdapter<number> {
  readonly specs: AcpSpawnSpec[] = [];
  readonly peers: FakeAcpPeer[] = [];
  readonly processes: FakeProcess[] = [];
  readonly signals: Array<readonly [number, "SIGTERM" | "SIGKILL"]> = [];
  nextPeerKind: FakePeerKind = "normal";
  advertisedModeIds: readonly string[] = ["build", "plan"];
  currentModeId = "build";
  readonly peerKinds: FakePeerKind[] = [];
  sessionNewGate: Promise<void> | undefined;

  async spawn(spec: AcpSpawnSpec): Promise<FakeProcess> {
    this.specs.push(spec);
    const peer = new FakeAcpPeer(this.advertisedModeIds, this.currentModeId, this.sessionNewGate);
    peer.start(this.peerKinds.shift() ?? this.nextPeerKind);
    const exit = deferred<AcpProcessExit>();
    const process: FakeProcess = {
      groupIdentity: this.processes.length + 1,
      stdin: peer.stdin,
      stdout: peer.stdout,
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      exited: exit.promise,
      exit,
      absent: false,
      cpuTimeMs: 0,
      descendantCount: 0,
    };
    this.peers.push(peer);
    this.processes.push(process);
    return process;
  }

  async signalGroup(identity: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    this.signals.push([identity, signal]);
    const process = this.processes.find((candidate) => candidate.groupIdentity === identity);
    if (process) {
      process.absent = true;
      process.exit.resolve({ code: null, signal });
    }
  }
  async isGroupAbsent(identity: number): Promise<boolean> {
    return this.processes.find((candidate) => candidate.groupIdentity === identity)?.absent ?? true;
  }
  async observeGroup(identity: number): Promise<{ processCount: number; descendantCount: number; cpuTimeMs: number }> {
    const process = this.processes.find((candidate) => candidate.groupIdentity === identity);
    if (!process || process.absent) return { processCount: 0, descendantCount: 0, cpuTimeMs: 0 };
    return { processCount: 1 + process.descendantCount, descendantCount: process.descendantCount, cpuTimeMs: process.cpuTimeMs };
  }
}

function liveRuntime(processes: FakeProcessRuntime, clock?: AcpHostClock, observedTimeouts?: number[]): NonNullable<ConstructorParameters<typeof ElectronOpenCodeAcpExecutionHost>[1]>["createRuntime"] {
  return ({ resolveLaunch, turnFor, initializeTimeoutMs }) => {
    observedTimeouts?.push(initializeTimeoutMs);
    return new AcpHostRuntime({
      launches: { resolveAndRevalidate: async (request) => resolveLaunch(request.bindingId) },
      processes,
      processTree: processes,
      readiness: createAcpStableV1LiveSessionConnector((request) => turnFor(request.bindingId, request.generation)),
      initializeTimeoutMs,
      ...(clock ? { clock } : {}),
    });
  };
}

describe("ElectronOpenCodeAcpExecutionHost", () => {
  test("keeps receipt authority beyond the OpenCode handshake and containment windows", () => {
    expect(OPENCODE_ACP_INITIALIZE_TIMEOUT_MS).toBe(30_000);
    expect(ACP_EXECUTION_RECEIPT_LIFETIME_MS).toBeGreaterThan(OPENCODE_ACP_INITIALIZE_TIMEOUT_MS + ACP_TOTAL_TEARDOWN_TIMEOUT_MS + 5_000);
  });

  test("keeps a cold OpenCode session/new alive past the legacy ten-second deadline", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    const sessionNewGate = deferred<void>();
    const clock = new ManualTurnClock();
    const observedTimeouts: number[] = [];
    processes.sessionNewGate = sessionNewGate.promise;
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes, clock, observedTimeouts),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("cold-start"));
    const starting = host.onStart(startFrom(messages[0] as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>, "autonomous"));
    await eventually(() => processes.peers[0]?.methods.includes("session/new") === true);
    clock.advance(10_001);
    await Promise.resolve();
    expect(observedTimeouts).toEqual([OPENCODE_ACP_INITIALIZE_TIMEOUT_MS]);
    expect(processes.signals).toEqual([]);
    expect(messages.map((message) => message.type)).toEqual(["relay:acp-prepared"]);

    sessionNewGate.resolve();
    await within(starting);
    expect(messages.some((message) => message.type === "relay:acp-started")).toBeTrue();
  });

  test("ignores below-v15 and sibling-provider execution commands", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      { launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }), createRuntime: liveRuntime(processes) },
    );
    host.onRegistered({ ...socket, selectedProtocolVersion: 14 }, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare({ ...prepare("old"), scope: { ...socket, selectedProtocolVersion: 14 } });
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare({ ...prepare("sibling"), registrationId: "hermes-acp" });
    expect(messages).toEqual([]);
    expect(processes.specs).toEqual([]);
  });

  test("fails plan closed before prompting when its exact native mode is absent", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.advertisedModeIds = ["build"];
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("missing-plan-mode"));
    const prepared = messages[0] as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    await within(host.onStart(startFrom(prepared, "plan")));

    expect(processes.peers[0]?.methods).toEqual(["initialize", "session/new"]);
    expect(processes.peers[0]?.modeIds).toEqual([]);
    expect(messages.slice(1)).toEqual([expect.objectContaining({
      type: "relay:acp-start-failed", registrationId: "opencode-acp", scope: expect.objectContaining({ socket: prepared.scope }), stage: "initialized",
    })]);
    expect(processes.signals).toEqual([[1, "SIGTERM"]]);
    expect(processes.processes[0]?.absent).toBeTrue();
  });

  test("drives one admitted ACP turn over one stream and exposes only ordered semantic facts", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    let nextId = 0;
    const folder = process.cwd();
    const launch: AcpCanonicalLaunchAdmission = {
      executablePath: "/reviewed/opencode", cwd: folder,
      environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" },
    };
    let runtime: AcpHostRuntime<number> | undefined;
    let turnWasAdmitted = false;
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 7 }) },
      {
        mintId: () => `opaque-${++nextId}`,
        launchAdmission: async () => launch,
        createRuntime: (input) => {
          runtime = new AcpHostRuntime({
            launches: { resolveAndRevalidate: async (request) => input.resolveLaunch(request.bindingId) },
            processes,
            processTree: processes,
            readiness: createAcpStableV1LiveSessionConnector((request) => {
              const turn = input.turnFor(request.bindingId, request.generation);
              turnWasAdmitted = turn !== undefined;
              return turn;
            }),
          });
          return runtime;
        },
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("prepare-1"));
    const prepared = messages[0] as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;

    await within(host.onStart(startFrom(prepared)));

    expect(processes.specs).toHaveLength(1);
    expect(turnWasAdmitted).toBeTrue();
    expect(processes.peers[0]?.error).toBeUndefined();
    expect(processes.peers[0]?.methods).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(processes.peers[0]?.modeIds).toEqual([]);
    expect(processes.specs).toEqual([{
      executablePath: "/reviewed/opencode", args: ["acp"], cwd: folder,
      env: launch.environment, shell: false, detached: true,
    }]);
    expect(processes.specs[0]?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(messages.map((message) => message.type)).toEqual([
      "relay:acp-prepared", "relay:acp-started", "relay:acp-semantic", "relay:acp-semantic", "relay:acp-semantic", "relay:acp-terminal",
    ]);
    const turnEvents = messages.slice(1) as Array<Extract<RelayAcpClientMessage, { eventSequence: number }>>;
    expect(turnEvents.map((event) => event.eventSequence)).toEqual([1, 2, 3, 4, 5]);
    expect(turnEvents[1]).toMatchObject({ type: "relay:acp-semantic", payload: { kind: "output_delta", text: "safe output" } });
    expect(turnEvents[2]).toMatchObject({ type: "relay:acp-semantic", payload: { kind: "command_summary", commands: [{ summary: "safe command", status: "completed" }] } });
    expect(turnEvents[3]).toMatchObject({ type: "relay:acp-semantic", payload: { kind: "assistant_completed", text: "safe output" } });
    expect(turnEvents[4]).toMatchObject({ type: "relay:acp-terminal", status: "completed" });
    const exported = JSON.stringify(messages);
    for (const forbidden of [folder, "/reviewed", "/private", "OPENAI_API_KEY", "_meta", "provider", "model", "permission", "session/prompt", "session/update", "raw ACP", "SIGTERM"]) {
      expect(exported).not.toContain(forbidden);
    }
    expect(processes.signals).toEqual([[1, "SIGTERM"]]);
    expect(processes.processes[0]?.absent).toBeTrue();
    expect(runtime?.status("binding").state).toBe("absent");
  });

  test("keeps a custom owner-selected primary mode for autonomous work", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.currentModeId = "owner-primary";
    processes.advertisedModeIds = ["owner-primary", "plan"];
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("custom-primary-autonomous"));
    await within(host.onStart(startFrom(messages[0] as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>, "autonomous")));

    expect(processes.peers[0]?.methods).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(processes.peers[0]?.modeIds).toEqual([]);
    expect(messages.at(-1)).toMatchObject({ type: "relay:acp-terminal", status: "completed" });
  });

  test("emits only its fixed start marker when native Plan mode rejects before prompting", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const diagnostics: string[] = [];
    const processes = new FakeProcessRuntime();
    processes.nextPeerKind = "set_mode_rejected";
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        startFailureDiagnostic: (message) => { diagnostics.push(message); },
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("rejected-plan-mode"));
    await within(host.onStart(startFrom(messages[0] as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>, "plan")));

    expect(processes.peers[0]?.methods).toEqual(["initialize", "session/new", "session/set_mode"]);
    expect(processes.peers[0]?.modeIds).toEqual(["plan"]);
    expect(diagnostics).toEqual(["opencode-acp start_failure_after=initialized"]);
    expect(JSON.stringify(diagnostics)).not.toContain("private mode rejection detail");
    const failed = messages.at(-1);
    expect(failed).toMatchObject({ type: "relay:acp-start-failed", registrationId: "opencode-acp", stage: "initialized" });
    expect(Object.keys(failed ?? {}).sort()).toEqual(["registrationId", "scope", "stage", "type"]);
    expect(JSON.stringify(failed)).not.toContain("private mode rejection detail");
  });

  test("writes only the closed OpenCode terminal-failure diagnostic before its existing failure terminal", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const diagnostics: string[] = [];
    const processes = new FakeProcessRuntime();
    processes.nextPeerKind = "end_turn_without_candidate";
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        terminalFailureDiagnostic: (message) => { diagnostics.push(message); },
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("terminal-diagnostic"));
    await within(host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>)));

    expect(diagnostics).toEqual(["opencode-acp terminal_failure=end_turn_without_candidate"]);
    expect(messages.filter((message) => message.type === "relay:acp-terminal")).toEqual([
      expect.objectContaining({ status: "failed", code: "upstream_failure" }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(folder);
    expect(processes.processes[0]?.absent).toBeTrue();
  });

  test("rejects expired, mismatched, drifted, and duplicate receipt starts before an extra spawn", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    const folder = process.cwd();
    let current = { path: folder, revision: 1 };
    let now = 0;
    let ids = 0;
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => current },
      {
        now: () => now,
        mintId: () => `id-${++ids}`,
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });

    await host.onPrepare(prepare("expired"));
    const expired = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    expect(Date.parse(expired.workspace.workspaceExpiresAt)).toBe(ACP_EXECUTION_RECEIPT_LIFETIME_MS);
    now = 60_001;
    await host.onStart(startFrom(expired));
    expect(processes.specs).toHaveLength(0);

    now = 0;
    await host.onPrepare(prepare("start-boundary"));
    const boundary = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    now = 60_000;
    await host.onStart(startFrom(boundary));
    expect(processes.specs).toHaveLength(0);

    now = 0;
    await host.onPrepare(prepare("start-last-valid"));
    const lastValid = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    now = 59_999;
    await within(host.onStart(startFrom(lastValid)));
    expect(processes.specs).toHaveLength(1);

    now = 0;
    await host.onPrepare(prepare("mismatch"));
    const mismatch = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    await host.onStart({ ...startFrom(mismatch), scope: { ...startFrom(mismatch).scope, workspace: { ...mismatch.workspace, workspaceFingerprint: "other" } } });

    await host.onPrepare(prepare("drift"));
    const drift = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    current = { path: folder, revision: 2 };
    await host.onStart(startFrom(drift));

    current = { path: folder, revision: 3 };
    await host.onPrepare(prepare("once"));
    const once = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    await within(host.onStart(startFrom(once)));
    await host.onStart(startFrom(once));
    expect(processes.specs).toHaveLength(2);
  });

  test("revalidates the selected folder after delayed launch admission before spawning", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    const folder = process.cwd();
    let current = { path: folder, revision: 1 };
    let launchCalls = 0;
    const admission = deferred<AcpCanonicalLaunchAdmission>();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => current },
      {
        launchAdmission: async () => {
          launchCalls += 1;
          return admission.promise;
        },
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("launch-drift"));
    const receipt = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    const start = host.onStart(startFrom(receipt));
    await eventually(() => launchCalls === 1);

    // The slow reviewed-executable probe is not workspace authority. A new
    // Current Folder selection while it is pending must make this admission stale.
    current = { path: `${folder}/.`, revision: 2 };
    admission.resolve({
      executablePath: "/reviewed/opencode", cwd: folder,
      environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" },
    });
    await within(start);
    expect(processes.specs).toHaveLength(0);
    expect(messages.map((message) => message.type)).toEqual(["relay:acp-prepared", "relay:acp-start-failed"]);
  });

  test("cancels an unpublished prompt-written projection when its supervisor rejects, then retries cleanly", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    const folder = process.cwd();
    let runtimes = 0;
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: ({ resolveLaunch, turnFor }) => {
          runtimes += 1;
          if (runtimes === 1) return {
            start: async ({ bindingId }: { bindingId: string }) => {
              const request = turnFor(bindingId, 1);
              if (!request) throw new Error("missing admitted test turn");
              await request.onSessionStarted({ sessionId: "session-opaque", capabilities: UNSUPPORTED_REQUEST_CAPABILITIES });
              request.onPromptAdmitted?.({ sessionId: "session-opaque", capabilities: UNSUPPORTED_REQUEST_CAPABILITIES });
              void request.onEvent({ kind: "agent_text_chunk", sessionId: "session-opaque", messageId: null, text: "must remain gated" });
              throw new Error("supervisor final readiness rejection");
            },
            shutdown: async () => true,
          } as unknown as AcpHostRuntime<number>;
          return new AcpHostRuntime({
            launches: { resolveAndRevalidate: async (request) => resolveLaunch(request.bindingId) },
            processes,
            processTree: processes,
            readiness: createAcpStableV1LiveSessionConnector((request) => turnFor(request.bindingId, request.generation)),
          });
        },
      },
    );
    const transport = { send: (message: RelayAcpClientMessage) => { messages.push(message); return true; } };
    host.onRegistered(socket, transport);
    await host.onPrepare(prepare("rejected-after-prompt"));
    await within(host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>)));
    expect(messages.map((message) => message.type)).toEqual(["relay:acp-prepared", "relay:acp-start-failed"]);
    expect(processes.specs).toHaveLength(0);

    host.onDisconnected();
    await eventually(() => host.isReady());
    host.onRegistered(socket, transport);
    await host.onPrepare(prepare("clean-retry"));
    await within(host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>)));
    expect(messages.filter((message) => message.type === "relay:acp-started")).toHaveLength(1);
    expect(messages.filter((message) => message.type === "relay:acp-terminal")).toHaveLength(1);
  });

  test("fences a delayed old runtime generation after reconnect before the successor reuses it", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.peerKinds.push("stall", "stall");
    const folder = process.cwd();
    const oldResult = deferred<{ sessionId: string; stopReason: "end_turn" }>();
    const successorResult = deferred<{ sessionId: string; stopReason: "end_turn" }>();
    const clock = new ManualTurnClock();
    let emitOldNonterminal: (() => Promise<void>) | undefined;
    const successorStops: Array<readonly [string, number]> = [];
    let runtimes = 0;
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        mintId: () => "reused-opaque-id",
        turnClock: clock,
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: ({ resolveLaunch, turnFor }) => {
          runtimes += 1;
          if (runtimes === 1) return {
            start: async ({ bindingId }: { bindingId: string }) => {
              const request = turnFor(bindingId, 1);
              if (!request) throw new Error("missing admitted test turn");
              await request.onSessionStarted({ sessionId: "session-old", capabilities: UNSUPPORTED_REQUEST_CAPABILITIES });
              emitOldNonterminal = () => request.onEvent({
                kind: "agent_text_chunk", sessionId: "session-old", messageId: null, text: "old generation must be fenced",
              });
              return { bindingId, registrationId: "opencode-acp", generation: 1, state: "ready", stderr: "none" };
            },
            binding: () => ({
              turn: () => oldResult.promise,
              close: async () => undefined,
            }),
            stop: async () => ({ bindingId: binding.bindingId, registrationId: null, generation: 1, state: "absent", stderr: "none" }),
            shutdown: async () => true,
          } as unknown as AcpHostRuntime<number>;
          return {
            start: async ({ bindingId }: { bindingId: string }) => {
              const request = turnFor(bindingId, 1);
              if (!request) throw new Error("missing successor test turn");
              await request.onSessionStarted({ sessionId: "session-successor", capabilities: UNSUPPORTED_REQUEST_CAPABILITIES });
              return { bindingId, registrationId: "opencode-acp", generation: 1, state: "ready", stderr: "none" };
            },
            binding: () => ({ turn: () => successorResult.promise, close: async () => undefined }),
            stop: async (bindingId: string, generation: number) => {
              successorStops.push([bindingId, generation]);
              return { bindingId, registrationId: null, generation, state: "absent", stderr: "none" };
            },
            shutdown: async () => true,
          } as unknown as AcpHostRuntime<number>;
        },
      },
    );
    const transport = { send: (message: RelayAcpClientMessage) => { messages.push(message); return true; } };
    host.onRegistered(socket, transport);
    await host.onPrepare(prepare("old-generation"));
    const oldStart = host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>));
    let oldFailure: unknown;
    void oldStart.catch((error: unknown) => { oldFailure = error; });
    await eventually(() => messages.some((message) => message.type === "relay:acp-started") || oldFailure !== undefined);
    if (oldFailure !== undefined) throw oldFailure;

    host.onDisconnected();
    await eventually(() => host.isReady());
    host.onRegistered(socket, transport);
    await host.onPrepare(prepare("successor"));
    const marker = messages.length;
    const successor = host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>));
    await eventually(() => messages.slice(marker).some((message) => message.type === "relay:acp-started"));

    await emitOldNonterminal?.();
    expect(messages.slice(marker).filter((message) => message.type === "relay:acp-semantic")).toHaveLength(0);
    oldResult.resolve({ sessionId: "session-old", stopReason: "end_turn" });
    await within(oldStart);
    successorResult.resolve({ sessionId: "session-successor", stopReason: "end_turn" });
    await within(successor);
    expect(messages.filter((message) => message.type === "relay:acp-terminal")).toHaveLength(1);
    expect(messages.slice(marker).filter((message) => message.type === "relay:acp-terminal"))
      .toEqual([expect.objectContaining({ status: "failed", code: "upstream_failure" })]);
    expect(successorStops).toEqual([[binding.bindingId, 1]]);
  });

  test("keeps a quiet sleeping descendant running beyond the former absolute deadline", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.peerKinds.push("stall");
    const diagnostics: string[] = [];
    const folder = process.cwd();
    const clock = new ManualTurnClock();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        turnClock: clock,
        turnLimits: { stallTimeoutMs: 5, observationIntervalMs: 1 },
        turnHealthDiagnostic: (message) => { diagnostics.push(message); },
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("sleeping-descendant"));
    const start = host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>));
    await eventually(() => messages.some((message) => message.type === "relay:acp-started"));

    // A `sleep 180`-style child is deliberately quiet and CPU-idle. Its
    // exact group is still present, so the watcher may diagnose but must not
    // silently contain it after the former five-minute/15-minute cliffs.
    processes.processes[0]!.descendantCount = 1;
    clock.advance(6);
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(20);
    await Promise.resolve();
    await Promise.resolve();
    expect(diagnostics).toEqual(["opencode-acp turn_health=possibly_stalled"]);
    expect(messages.filter((message) => message.type === "relay:acp-semantic" && message.payload.kind === "runtime_status"))
      .toEqual([expect.objectContaining({ payload: { kind: "runtime_status", state: "possibly_stalled" } })]);
    expect(processes.peers[0]?.methods).not.toContain("session/cancel");
    expect(processes.signals).toEqual([]);
    expect(messages.filter((message) => message.type === "relay:acp-terminal")).toHaveLength(0);

    host.onDisconnected();
    await eventually(() => host.isReady());
    await within(start);
  });

  test("does not consume event sequencing when advisory runtime status is rejected", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.peerKinds.push("stall");
    const folder = process.cwd();
    const clock = new ManualTurnClock();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        turnClock: clock,
        turnLimits: { stallTimeoutMs: 5, observationIntervalMs: 1 },
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, {
      send: (message) => {
        if (message.type === "relay:acp-semantic" && message.payload.kind === "runtime_status") return false;
        messages.push(message);
        return true;
      },
    });
    await host.onPrepare(prepare("rejected-advisory-status"));
    const start = host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>));
    await eventually(() => messages.some((message) => message.type === "relay:acp-started"));

    // Advisory status is intentionally rejected by transport. Its failed send
    // must not reserve sequence 2 before ordinary exact-turn output arrives.
    clock.advance(6);
    await Promise.resolve();
    await Promise.resolve();
    await processes.peers[0]!.emitText("ordinary exact-turn output");
    await processes.peers[0]!.sendLatePromptResult();
    await within(start);

    const acceptedEvents = messages.filter((message): message is RelayAcpClientMessage & { eventSequence: number } => "eventSequence" in message);
    expect(acceptedEvents.map((message) => message.eventSequence)).toEqual([1, 2, 3, 4]);
    expect(messages.filter((message) => message.type === "relay:acp-terminal"))
      .toEqual([expect.objectContaining({ status: "completed", eventSequence: 4 })]);
  });

  test("rejects a second same-binding admission without mutating the live first turn", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.peerKinds.push("stall", "stall");
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("first-live"));
    const first = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    const firstStart = host.onStart(startFrom(first));
    await eventually(() => messages.some((message) => message.type === "relay:acp-started"));

    const before = messages.length;
    await host.onPrepare(prepare("same-binding-second"));
    expect(messages).toHaveLength(before);
    expect(processes.specs).toHaveLength(1);
    expect(processes.processes[0]?.absent).toBeFalse();
    expect(processes.signals).toEqual([]);

    await processes.peers[0]!.emitText("first remains healthy after the refused admission");
    await processes.peers[0]!.sendLatePromptResult();
    await within(firstStart);
    expect(messages.filter((message) => message.type === "relay:acp-terminal" && message.scope.binding.bindingId === binding.bindingId))
      .toEqual([expect.objectContaining({ status: "completed" })]);
    expect(processes.processes[0]?.absent).toBeTrue();
  });

  test("turn faults emit one sanitized terminal and contain only their exact child", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.nextPeerKind = "malformed";
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("fault"));
    await within(host.onStart(startFrom(messages[0] as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>)));
    await eventually(() => processes.peers[0]?.latePromptAttempted === true);
    const terminals = messages.filter((message): message is Extract<RelayAcpClientMessage, { type: "relay:acp-terminal" }> => message.type === "relay:acp-terminal");
    expect(terminals).toEqual([expect.objectContaining({ status: "failed", code: "upstream_failure" })]);
    expect(processes.peers[0]?.latePromptAttempted).toBeTrue();
    expect(JSON.stringify(terminals)).not.toContain("wrong-session");
    expect(processes.signals).toEqual([[1, "SIGTERM"]]);
    expect(processes.processes[0]?.absent).toBeTrue();
  });

  test("faults a live stable-v1 permission request without granting, projecting, or reviving its exact turn", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.peerKinds.push("permission_wait", "stall");
    const folder = process.cwd();
    const sibling = { ...binding, bindingId: "permission-sibling", bindingGeneration: "permission-sibling-generation" } as const;
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("permission"));
    const firstStart = host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>));
    await eventually(() => messages.some((message) => message.type === "relay:acp-started" && message.scope.binding.bindingId === binding.bindingId));

    await host.onPrepare(prepareFor("permission-sibling", sibling));
    const siblingStart = host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>));
    await eventually(() => messages.filter((message) => message.type === "relay:acp-started").length === 2);

    await processes.peers[0]!.emitPermissionRequest();
    await within(firstStart);
    await eventually(() => processes.peers[0]?.latePromptAttempted === true);

    const firstTerminals = messages.filter((message): message is Extract<RelayAcpClientMessage, { type: "relay:acp-terminal" }> =>
      message.type === "relay:acp-terminal" && message.scope.binding.bindingId === binding.bindingId,
    );
    expect(processes.peers[0]?.permissionRequestSeen).toBeTrue();
    expect(processes.peers[0]?.permissionResponse?.["result"]).toBeUndefined();
    expect(JSON.stringify(processes.peers[0]?.permissionResponse ?? {})).not.toContain("outcome");
    expect(messages.find((message): message is Extract<RelayAcpClientMessage, { type: "relay:acp-started" }> =>
      message.type === "relay:acp-started" && message.scope.binding.bindingId === binding.bindingId,
    )?.capabilities).toEqual({ requests: "unsupported" });
    expect(firstTerminals).toEqual([expect.objectContaining({ status: "failed", code: "upstream_failure" })]);
    expect(messages.filter((message) => message.type === "relay:acp-semantic" && message.scope.binding.bindingId === binding.bindingId)).toEqual([]);
    expect(JSON.stringify(firstTerminals)).not.toContain("user_stop");
    expect(processes.peers[0]?.latePromptAttempted).toBeTrue();
    expect(processes.peers[0]?.methods).not.toContain("session/cancel");
    expect(processes.processes[0]?.absent).toBeTrue();
    expect(processes.signals).toEqual([[1, "SIGTERM"]]);
    expect(processes.processes[1]?.absent).toBeFalse();
    expect(messages.filter((message) => message.type === "relay:acp-terminal" && message.scope.binding.bindingId === sibling.bindingId)).toEqual([]);

    host.onDisconnected();
    await eventually(() => host.isReady());
    await within(siblingStart);
  });

  test("uses Plan mode and keeps its permission requests unsupported", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.nextPeerKind = "permission_wait";
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("plan"));
    const running = host.onStart(startFrom(messages[0] as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>, "plan"));
    await eventually(() => messages.some((message) => message.type === "relay:acp-started"));
    expect(processes.peers[0]?.modeIds).toEqual(["plan"]);
    await processes.peers[0]!.emitPermissionRequest();
    await within(running);
    expect(processes.peers[0]?.permissionResponse?.["result"]).toBeUndefined();
  });

  test.each([
    ["one allow_once", [{ optionId: "opaque-allow", name: "whatever", kind: "allow_once" }], true],
    ["no allow_once", [{ optionId: "always", name: "Allow", kind: "allow_always" }], false],
    ["multiple allow_once", [{ optionId: "one", name: "Yes", kind: "allow_once" }, { optionId: "two", name: "Also yes", kind: "allow_once" }], false],
  ] as const)("Autonomous selects by opaque ID only for %s", async (_name, options, selected) => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.nextPeerKind = "permission_wait";
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare(`autonomous-${_name}`));
    const running = host.onStart(startFrom(messages[0] as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>, "autonomous"));
    await eventually(() => messages.some((message) => message.type === "relay:acp-started"));
    expect(processes.peers[0]?.modeIds).toEqual([]);
    await processes.peers[0]!.emitPermissionRequest(options);
    await within(running);
    const response = processes.peers[0]?.permissionResponse;
    if (selected) {
      expect(response?.["result"]).toEqual({ outcome: { outcome: "selected", optionId: "opaque-allow" } });
      expect(JSON.stringify(response)).not.toContain("whatever");
    } else {
      expect(response?.["result"]).toBeUndefined();
    }
  });

  test("rejects a late or sibling scope without disturbing the exact live generation", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.peerKinds.push("stall", "normal");
    const folder = process.cwd();
    const sibling = { ...binding, bindingId: "sibling", bindingGeneration: "sibling-generation" } as const;
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("first"));
    const first = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    const liveStart = host.onStart(startFrom(first));
    await eventually(() => messages.some((message) => message.type === "relay:acp-started"));

    await host.onPrepare(prepareFor("sibling", sibling));
    const second = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    await within(host.onStart(startFrom(second)));
    const beforeLate = processes.specs.length;
    await host.onStart({ ...startFrom(first), scope: { ...startFrom(first).scope, binding: { ...binding, bindingGeneration: "late-generation" } } });
    expect(processes.specs).toHaveLength(beforeLate);
    const siblingTerminal = messages.filter((message): message is Extract<RelayAcpClientMessage, { type: "relay:acp-terminal" }> =>
      message.type === "relay:acp-terminal" && message.scope.binding.bindingId === "sibling",
    );
    expect(siblingTerminal).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(processes.processes[0]?.absent).toBeFalse();
    expect(processes.signals.filter(([identity]) => identity === processes.processes[0]?.groupIdentity)).toEqual([]);

    host.onDisconnected();
    await eventually(() => host.isReady());
    await within(liveStart);
    expect(processes.processes[0]?.absent).toBeTrue();
    expect(processes.processes[1]?.absent).toBeTrue();
  });

  test("resets event sequencing on reconnect even when opaque process IDs are reused", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.peerKinds.push("emit_stall", "normal");
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        mintId: () => "reused-opaque-id",
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    const transport = { send: (message: RelayAcpClientMessage) => { messages.push(message); return true; } };
    host.onRegistered(socket, transport);
    await host.onPrepare(prepare("before-reconnect"));
    const before = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    const oldTurn = host.onStart(startFrom(before));
    await eventually(() => messages.some((message) => message.type === "relay:acp-semantic"));
    host.onDisconnected();
    await eventually(() => host.isReady());
    await within(oldTurn);

    host.onRegistered(socket, transport);
    await host.onPrepare(prepare("after-reconnect"));
    const after = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    const marker = messages.length;
    await within(host.onStart(startFrom(after)));
    const events = messages.slice(marker) as Array<Extract<RelayAcpClientMessage, { eventSequence: number }>>;
    expect(events.map((event) => event.eventSequence)).toEqual([1, 2, 3, 4, 5]);
  });

  test("treats exact CPU and descendant movement as healthy without ACP semantic frames", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.peerKinds.push("stall");
    const diagnostics: string[] = [];
    const clock = new ManualTurnClock();
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        turnClock: clock,
        turnLimits: { stallTimeoutMs: 5, observationIntervalMs: 1 },
        turnHealthDiagnostic: (message) => { diagnostics.push(message); },
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });

    await host.onPrepare(prepare("health-movement"));
    const first = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    const firstTurn = host.onStart(startFrom(first));
    await eventually(() => messages.some((message) => message.type === "relay:acp-started"));
    // This exceeds the old silence/absolute test thresholds while the ACP
    // stream remains quiet. Exact aggregate CPU/descendant changes refresh
    // only this generation's health state.
    for (let index = 0; index < 20; index += 1) {
      processes.processes[0]!.cpuTimeMs += 1;
      if (index === 8) processes.processes[0]!.descendantCount = 1;
      clock.advance(1);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(diagnostics.at(-1)).toBe("opencode-acp turn_health=healthy");
    expect(messages.filter((message) => message.type === "relay:acp-semantic" && message.payload.kind === "runtime_status").map((message) => message.payload))
      .toEqual([{ kind: "runtime_status", state: "possibly_stalled" }, { kind: "runtime_status", state: "healthy" }]);
    expect(processes.peers[0]?.methods).not.toContain("session/cancel");
    expect(processes.signals).toEqual([]);
    expect(messages.filter((message) => message.type === "relay:acp-terminal")).toHaveLength(0);

    host.onDisconnected();
    await eventually(() => host.isReady());
    await within(firstTurn);
  });

  test("faults and settles an exited exact group without touching its sibling", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.peerKinds.push("stall", "stall");
    const clock = new ManualTurnClock();
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        turnClock: clock,
        turnLimits: { stallTimeoutMs: 5, observationIntervalMs: 1 },
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("exit-first"));
    const prepared = messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>;
    const start = host.onStart(startFrom(prepared));
    await eventually(() => messages.some((message) => message.type === "relay:acp-started"));
    const sibling = { ...binding, bindingId: "exit-sibling", bindingGeneration: "exit-sibling-generation" } as const;
    await host.onPrepare(prepareFor("exit-sibling", sibling));
    const siblingStart = host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>));
    await eventually(() => messages.filter((message) => message.type === "relay:acp-started").length === 2);
    processes.processes[0]!.absent = true;
    processes.processes[0]!.exit.resolve({ code: 1, signal: null });
    clock.advance(1);
    await eventually(() => messages.some((message) => message.type === "relay:acp-terminal"));
    expect(messages.filter((message): message is Extract<RelayAcpClientMessage, { type: "relay:acp-terminal" }> => message.type === "relay:acp-terminal"))
      .toEqual([expect.objectContaining({ status: "failed", code: "upstream_failure" })]);
    expect(processes.processes[0]?.absent).toBeTrue();
    expect(processes.processes[1]?.absent).toBeFalse();
    expect(processes.signals.filter(([identity]) => identity === 2)).toEqual([]);
    await within(start);
    host.onDisconnected();
    await eventually(() => host.isReady());
    await within(siblingStart);
  });

  test("contains only the exact live relay turn through stable cancel and upstream failure", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const processes = new FakeProcessRuntime();
    processes.peerKinds.push("stall", "stall");
    const clock = new ManualTurnClock();
    const folder = process.cwd();
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: folder, revision: 1 }) },
      {
        turnClock: clock,
        turnLimits: { stallTimeoutMs: 20, observationIntervalMs: 1 },
        launchAdmission: async () => ({ executablePath: "/reviewed/opencode", cwd: folder, environment: { PATH: "/reviewed:/usr/bin", HOME: "/private/home", TMPDIR: "/private/tmp", LANG: "C", LC_ALL: "C" } }),
        createRuntime: liveRuntime(processes),
      },
    );
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await host.onPrepare(prepare("contain"));
    const start = host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>));
    await eventually(() => messages.some((message) => message.type === "relay:acp-started"));
    const sibling = { ...binding, bindingId: "contain-sibling", bindingGeneration: "contain-sibling-generation" } as const;
    await host.onPrepare(prepareFor("contain-sibling", sibling));
    const siblingStart = host.onStart(startFrom(messages.at(-1) as Extract<RelayAcpClientMessage, { type: "relay:acp-prepared" }>));
    await eventually(() => messages.filter((message) => message.type === "relay:acp-started").length === 2);
    const started = messages.find((message): message is Extract<RelayAcpClientMessage, { type: "relay:acp-started" }> => message.type === "relay:acp-started");
    if (!started) throw new Error("missing started turn");
    const baseContain = { type: "relay:acp-contain" as const, registrationId: "opencode-acp" as const, containmentRef: "contain-1", scope: started.scope, process: started.process, code: "upstream_failure" as const };
    await host.onContain({ ...baseContain, containmentRef: "stale-socket", scope: { ...started.scope, socket: { ...started.scope.socket, relaySessionId: "stale" } } });
    await host.onContain({ ...baseContain, containmentRef: "stale-scope", scope: { ...started.scope, binding: { ...started.scope.binding, bindingGeneration: "stale" } } });
    await host.onContain({ ...baseContain, containmentRef: "stale-process", process: { ...started.process, turnRef: "stale" } });
    expect(processes.peers[0]?.methods).not.toContain("session/cancel");
    await host.onContain(baseContain);
    await host.onContain(baseContain);
    await host.onContain({ ...baseContain, process: { ...started.process, turnRef: "conflict" } });
    await host.onContain({ ...baseContain, containmentRef: "contain-2" });
    await eventually(() => processes.peers[0]?.methods.filter((method) => method === "session/cancel").length === 1);
    clock.advance(10_000);
    await eventually(() => messages.filter((message) => message.type === "relay:acp-terminal" && message.scope.binding.bindingId === binding.bindingId).length === 1);
    expect(messages.filter((message) => message.type === "relay:acp-terminal" && message.scope.binding.bindingId === binding.bindingId)).toEqual([expect.objectContaining({ status: "failed", code: "upstream_failure" })]);
    expect(processes.signals).toEqual([[1, "SIGTERM"]]);
    expect(processes.processes[1]?.absent).toBeFalse();
    expect(processes.signals.filter(([identity]) => identity === 2)).toEqual([]);
    await within(start);
    host.onDisconnected();
    await eventually(() => host.isReady());
    await within(siblingStart);
  });

  test("prepares one opaque Current Folder receipt without exposing its local path", async () => {
    const messages: RelayAcpClientMessage[] = [];
    let id = 0;
    const host = new ElectronOpenCodeAcpExecutionHost({ currentFolder: () => ({ path: process.cwd(), revision: 7 }) }, {
      mintId: () => `opaque-${++id}`,
    });
    const transport: RelayAcpHostTransport = { send: (message) => { messages.push(message); return true; } };
    host.onRegistered(socket, transport);
    await host.onPrepare(prepare("request"));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "relay:acp-prepared", requestId: "request", workspace: { workspaceReceiptId: "opaque-1", workspaceRevision: "7", workspaceFingerprint: "opaque-2" } });
    expect(JSON.stringify(messages[0])).not.toContain(process.cwd());
  });

  test("reports correlated readiness unavailable without a Current Folder and preserves folder-present delegation", async () => {
    const request = { type: "relay:acp-readiness", requestId: "readiness", registrationId: "opencode-acp", scope: socket } as const;
    const noFolderMessages: RelayAcpClientMessage[] = [];
    const noFolderDelegateCalls: string[] = [];
    const noFolder = new ElectronOpenCodeAcpExecutionHost({ currentFolder: () => null }, {
      readiness: {
        onRegistered: () => { noFolderDelegateCalls.push("registered"); },
        onReadiness: () => { noFolderDelegateCalls.push("readiness"); },
      },
    });
    noFolder.onRegistered(socket, { send: (message) => { noFolderMessages.push(message); return true; } });
    await noFolder.onReadiness(request);
    expect(noFolderDelegateCalls).toEqual(["registered"]);
    expect(noFolderMessages).toEqual([{
      type: "relay:acp-readiness-result", requestId: "readiness", registrationId: "opencode-acp",
      scope: socket, state: "unavailable",
    }]);

    const folderMessages: RelayAcpClientMessage[] = [];
    const folderDelegateCalls: string[] = [];
    let delegateTransport: RelayAcpHostTransport | null = null;
    const withFolder = new ElectronOpenCodeAcpExecutionHost({ currentFolder: () => ({ path: process.cwd(), revision: 1 }) }, {
      readiness: {
        onRegistered: (_session, transport) => { folderDelegateCalls.push("registered"); delegateTransport = transport; },
        onReadiness: (message) => {
          folderDelegateCalls.push("readiness");
          delegateTransport?.send({ ...message, type: "relay:acp-readiness-result", state: "ready" });
        },
      },
    });
    withFolder.onRegistered(socket, { send: (message) => { folderMessages.push(message); return true; } });
    await withFolder.onReadiness(request);
    expect(folderDelegateCalls).toEqual(["registered", "readiness"]);
    expect(folderMessages).toEqual([expect.objectContaining({
      type: "relay:acp-readiness-result", requestId: "readiness", registrationId: "opencode-acp", state: "ready",
    })]);
  });

  test("fails closed without a Current Folder and caps unconsumed opaque receipts", async () => {
    const messages: RelayAcpClientMessage[] = [];
    const noFolder = new ElectronOpenCodeAcpExecutionHost({ currentFolder: () => null });
    noFolder.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    await noFolder.onPrepare(prepare("none"));
    expect(messages).toHaveLength(0);

    let id = 0;
    const host = new ElectronOpenCodeAcpExecutionHost({ currentFolder: () => ({ path: process.cwd(), revision: 1 }) }, { mintId: () => `receipt-${++id}` });
    host.onRegistered(socket, { send: (message) => { messages.push(message); return true; } });
    for (let index = 0; index < 33; index += 1) await host.onPrepare(prepare(`request-${index}`));
    expect(messages).toHaveLength(32);
  });

  test("blocks a re-registered socket until disconnect containment proves absence", async () => {
    let resolveCleanup!: (value: boolean) => void;
    const cleanup = new Promise<boolean>((resolve) => { resolveCleanup = resolve; });
    const oldRuntime = { shutdown: () => cleanup } as unknown as AcpHostRuntimeType<number>;
    const nextRuntime = { shutdown: async () => true } as unknown as AcpHostRuntimeType<number>;
    const messages: RelayAcpClientMessage[] = [];
    let availabilityChanges = 0;
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: process.cwd(), revision: 1 }) },
      { runtime: oldRuntime, runtimeFactory: () => nextRuntime, onAvailabilityChanged: () => { availabilityChanges += 1; } },
    );
    const transport = { send: (message: RelayAcpClientMessage) => { messages.push(message); return true; } };
    host.onRegistered(socket, transport);
    host.onDisconnected();
    host.onRegistered(socket, transport);
    expect(host.isReady()).toBeFalse();
    await host.onPrepare(prepare("blocked"));
    expect(messages).toHaveLength(0);
    resolveCleanup(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(host.isReady()).toBeTrue();
    expect(availabilityChanges).toBe(1);
    await host.onPrepare(prepare("admitted"));
    expect(messages).toHaveLength(1);
  });

  test("keeps the host unavailable when disconnect containment is uncertain", async () => {
    const oldRuntime = { shutdown: async () => false } as unknown as AcpHostRuntimeType<number>;
    const nextRuntime = { shutdown: async () => true } as unknown as AcpHostRuntimeType<number>;
    let availabilityChanges = 0;
    const host = new ElectronOpenCodeAcpExecutionHost(
      { currentFolder: () => ({ path: process.cwd(), revision: 1 }) },
      { runtime: oldRuntime, runtimeFactory: () => nextRuntime, onAvailabilityChanged: () => { availabilityChanges += 1; } },
    );
    host.onRegistered(socket, { send: () => true });
    host.onDisconnected();
    await Promise.resolve();
    expect(host.isReady()).toBeFalse();
    expect(availabilityChanges).toBe(0);
  });

});
