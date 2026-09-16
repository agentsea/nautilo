/**
 * D564 Wave 0 — direct Codex app-server contract probe.
 *
 * This deliberately owns its JSON-RPC transport instead of importing Nautilo's
 * app-server client, host, binding, or persistence layers.  It retains raw
 * JSONL only in a mkdtemp directory and prints a redacted semantic summary.
 * Run with: bun dev/probes/d564-codex-app-server-contract.ts
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RpcMessage = { readonly id?: number | string; readonly method?: string; readonly params?: Record<string, unknown>; readonly result?: unknown; readonly error?: { readonly code?: number; readonly message?: string } };
type SemanticEvent = { readonly n: number; readonly kind: string; readonly item?: string; readonly tool?: string; readonly status?: string };
type Capability = "PROVEN" | "PARTIAL" | "UNSUPPORTED" | "UNOBSERVED";

const CODEX_VERSION = "0.146.0";
const PROTOCOL_ANCHOR = "codex-app-server@0.146.0";
const ROOT_MARKER = "root-marker.txt";
const STEER_MARKER = "steer-marker.txt";
const INITIAL_MARKER = "initial-marker.txt";
const FORK_MARKER = "fork-marker.txt";
const GATE_STARTED = "gate-started";
const GATE_RELEASE = "gate-release";
const GATE_FINISHED = "gate-finished";

function fail(message: string): never { throw new Error(message); }

function textInput(text: string): readonly { readonly type: "text"; readonly text: string; readonly text_elements: readonly [] }[] {
  return [{ type: "text", text, text_elements: [] }];
}

async function observedCodexVersion(): Promise<string> {
  const child = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  const match = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(output);
  if (exitCode !== 0 || !match) fail("could not observe the installed Codex CLI version");
  return match[1];
}

function safeError(error: unknown): { readonly kind: "rpc_error" | "transport_error"; readonly code?: number } {
  if (typeof error === "object" && error !== null && "rpcCode" in error) {
    const code = (error as { readonly rpcCode?: unknown }).rpcCode;
    return typeof code === "number" ? { kind: "rpc_error", code } : { kind: "rpc_error" };
  }
  return { kind: "transport_error" };
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
}

function containsField(value: unknown, field: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (field in value) return true;
  return Object.values(value as Record<string, unknown>).some((entry) => containsField(entry, field));
}

class RpcFailure extends Error {
  constructor(readonly rpcCode: number | undefined) { super("Codex app-server rejected the request"); }
}

class DirectAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (reason: unknown) => void }>();
  private readonly turns = new Map<string, { readonly resolve: (value: { readonly status: string }) => void; readonly reject: (reason: unknown) => void }>();
  private readonly settledTurns = new Map<string, { readonly status: string }>();
  private readonly itemWaiters: { readonly item: string; readonly resolve: () => void }[] = [];
  private readonly aliases = new Map<string, string>();
  private readonly rawFrames: string[] = [];
  private readonly semantic: SemanticEvent[] = [];
  private readonly agentOutputNeedles = new Map<string, boolean>();
  private readonly collabParentFacts: { agentIdentity: boolean; parentThread: boolean } = { agentIdentity: false, parentThread: false };
  private nextId = 1;
  private eventNumber = 0;
  private stdoutBuffer = "";
  private closed = false;
  private exitObserved = false;
  private resolveExit!: () => void;
  private readonly exitPromise = new Promise<void>((resolve) => { this.resolveExit = resolve; });

  constructor(
    cwd: string,
    private readonly rawReceiptPath: string,
    private readonly onEvent?: (event: SemanticEvent) => void,
  ) {
    this.child = spawn("codex", ["app-server", "--stdio"], {
      cwd,
      env: { ...process.env },
      detached: true,
      stdio: "pipe",
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.retainRaw(`stderr:${chunk}`));
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("exit", () => {
      this.exitObserved = true;
      this.record("transport.exited");
      this.resolveExit();
      this.rejectAll(new Error("app-server exited before the pending operation settled"));
    });
  }

  events(): readonly SemanticEvent[] { return this.semantic; }
  sawAgentOutput(needle: string): boolean { return this.agentOutputNeedles.get(needle) === true; }
  collabFacts(): Readonly<{ readonly agentIdentity: boolean; readonly parentThread: boolean }> { return this.collabParentFacts; }
  alias(kind: "thread" | "turn", id: string): string {
    const key = `${kind}:${id}`;
    const known = this.aliases.get(key);
    if (known) return known;
    const created = `${kind}-${[...this.aliases.keys()].filter((entry) => entry.startsWith(`${kind}:`)).length + 1}`;
    this.aliases.set(key, created);
    return created;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "d564-direct-contract-probe", title: "D564 direct contract probe", version: CODEX_VERSION },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.send({ method: "initialized" });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async waitForTurn(turnId: string): Promise<{ readonly status: string }> {
    const settled = this.settledTurns.get(turnId);
    if (settled) return settled;
    return new Promise((resolve, reject) => this.turns.set(turnId, { resolve, reject }));
  }

  async waitForItemStart(item: string): Promise<void> {
    if (this.semantic.some((event) => event.kind === "item/started" && event.item === item)) return;
    await new Promise<void>((resolve) => this.itemWaiters.push({ item, resolve }));
  }

  killOwnedProcessGroup(): void {
    if (!this.child.pid) fail("app-server did not expose an owned process identifier");
    try { process.kill(-this.child.pid, "SIGTERM"); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ESRCH") return;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    if (!this.hasExited()) {
      this.record("transport.close.terminated");
      this.killOwnedProcessGroup();
    }
    await this.waitForExit();
    this.rejectAll(new Error("direct app-server client closed"));
  }

  async waitForExit(): Promise<void> {
    if (this.hasExited()) return;
    await this.exitPromise;
  }

  private hasExited(): boolean { return this.exitObserved || this.child.exitCode !== null || this.child.signalCode !== null; }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      this.retainRaw(`stdout:${line}\n`);
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; }
      catch { continue; }
      this.onMessage(message);
    }
  }

  private onMessage(message: RpcMessage): void {
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const id = typeof message.id === "number" ? message.id : Number.NaN;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) pending.reject(new RpcFailure(message.error.code));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      // The probe never grants a requested permission. Its only effect surface
      // is the disposable repository under workspace-write containment.
      this.record(`callback.declined.${message.method}`);
      const decline = message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval"
        ? { decision: "decline" }
        : { decision: { denied: { rejection: "direct probe declines unrecognized callback" } } };
      this.send({ id: message.id, result: decline });
      return;
    }
    if (!message.method) return;
    const params = message.params ?? {};
    for (const [needle] of this.agentOutputNeedles) {
      if (JSON.stringify(params).includes(needle)) this.agentOutputNeedles.set(needle, true);
    }
    const item = params.item;
    const itemType = typeof item === "object" && item !== null && "type" in item && typeof (item as { readonly type?: unknown }).type === "string"
      ? (item as { readonly type: string }).type
      : undefined;
    const tool = itemType === "collabAgentToolCall" ? stringField(item, "tool") : undefined;
    if (itemType === "collabAgentToolCall") {
      if (containsField(item, "agentId") || containsField(item, "agent_id")) this.collabParentFacts.agentIdentity = true;
      if (containsField(item, "parentThreadId") || containsField(item, "parent_thread_id")) this.collabParentFacts.parentThread = true;
    }
    const status = message.method === "turn/completed" && typeof params.turn === "object" && params.turn !== null && "status" in params.turn
      ? String((params.turn as { readonly status?: unknown }).status)
      : undefined;
    const semanticallyRelevant = message.method === "item/started"
      || message.method === "item/completed"
      || message.method === "turn/started"
      || message.method === "turn/completed"
      || message.method === "thread/status/changed";
    if (semanticallyRelevant) this.record(message.method, itemType, tool, status);
    if (message.method === "item/started" && itemType) {
      for (let index = this.itemWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.itemWaiters[index];
        if (waiter.item !== itemType) continue;
        this.itemWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
    if (message.method === "turn/completed" && typeof params.turn === "object" && params.turn !== null) {
      const turn = params.turn as { readonly id?: unknown; readonly status?: unknown };
      if (typeof turn.id === "string") {
        const settled = { status: typeof turn.status === "string" ? turn.status : "unknown" };
        this.settledTurns.set(turn.id, settled);
        const waiter = this.turns.get(turn.id);
        if (waiter) {
          this.turns.delete(turn.id);
          waiter.resolve(settled);
        }
      }
    }
  }

  private record(kind: string, item?: string, tool?: string, status?: string): void {
    const event = { n: ++this.eventNumber, kind, ...(item ? { item } : {}), ...(tool ? { tool } : {}), ...(status ? { status } : {}) };
    this.semantic.push(event);
    this.onEvent?.(event);
  }

  watchAgentOutput(needle: string): void { this.agentOutputNeedles.set(needle, false); }

  private send(value: unknown): void {
    const text = `${JSON.stringify(value)}\n`;
    this.retainRaw(`stdin:${text}`);
    this.child.stdin.write(text);
  }

  private retainRaw(line: string): void { this.rawFrames.push(line); }
  private rejectAll(reason: unknown): void {
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    for (const waiter of this.turns.values()) waiter.reject(reason);
    this.turns.clear();
  }

  async flushRaw(): Promise<void> { await writeFile(this.rawReceiptPath, this.rawFrames.join(""), "utf8"); }
}

async function createDisposableRepository(scratch: string): Promise<string> {
  const root = join(scratch, "repo");
  await mkdir(root);
  await writeFile(join(root, "README.md"), "# D564 disposable provider-contract probe\n", "utf8");
  await writeFile(join(root, "d564-gate.sh"), `#!/bin/sh\ntouch ${GATE_STARTED}\nwhile [ ! -f ${GATE_RELEASE} ]; do sleep 1; done\ntouch ${GATE_FINISHED}\n`, "utf8");
  const git = spawn("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => git.once("exit", (code) => code === 0 ? resolve() : reject(new Error("could not initialize disposable Git repository"))));
  return root;
}

function threadId(value: unknown): string {
  const id = (value as { readonly thread?: { readonly id?: unknown } }).thread?.id;
  return typeof id === "string" ? id : fail("thread/start did not return an opaque thread identifier");
}

function turnId(value: unknown): string {
  const id = (value as { readonly turn?: { readonly id?: unknown } }).turn?.id;
  return typeof id === "string" ? id : fail("turn request did not return an opaque turn identifier");
}

async function exists(root: string, name: string): Promise<boolean> {
  try { await stat(join(root, name)); return true; } catch { return false; }
}

async function waitForFile(root: string, name: string): Promise<void> {
  if (await exists(root, name)) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      watcher.close();
      resolve();
    };
    const watcher = watch(root, (_event, changed) => {
      if (changed !== name) return;
      finish();
    });
    watcher.once("error", reject);
    void exists(root, name).then((present) => { if (present) finish(); }, reject);
  });
}

async function waitForFileDuringClient(root: string, name: string, client: DirectAppServer): Promise<void> {
  await Promise.race([
    waitForFile(root, name),
    client.waitForExit().then(() => fail("app-server exited before the deterministic gate reached its started effect")),
  ]);
}

async function contentHash(root: string, name: string): Promise<string | null> {
  try { return createHash("sha256").update(await readFile(join(root, name))).digest("hex"); }
  catch { return null; }
}

function sameTurnIdentities(before: unknown, after: unknown): boolean {
  const turns = (value: unknown): readonly unknown[] => (value as { readonly thread?: { readonly turns?: readonly unknown[] } }).thread?.turns ?? [];
  const ids = (value: unknown): Set<string> => new Set(turns(value).flatMap((turn) => {
    const id = (turn as { readonly id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  }));
  const beforeIds = ids(before);
  const afterIds = ids(after);
  return beforeIds.size === afterIds.size && [...beforeIds].every((id) => afterIds.has(id));
}

async function runTurn(client: DirectAppServer, thread: string, text: string, extra: Record<string, unknown> = {}): Promise<{ readonly id: string; readonly status: string }> {
  const response = await client.request("turn/start", { threadId: thread, input: textInput(text), ...extra });
  const id = turnId(response);
  const terminal = await client.waitForTurn(id);
  return { id, status: terminal.status };
}

function classifyRoot(effect: boolean, terminal: string): Capability { return effect && terminal === "completed" ? "PROVEN" : "PARTIAL"; }

interface WorkerScope { readonly scratch: string; readonly root: string; readonly rawReceipt: string; }
type WorkerRow = { readonly worker: string; readonly capability: Capability; readonly facts: Record<string, unknown> };

async function withWorkerScope<T>(work: (scope: WorkerScope) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "d564-codex-contract-"));
  const root = await createDisposableRepository(scratch);
  try { return await work({ scratch, root, rawReceipt: join(scratch, "raw-app-server.jsonl") }); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}

async function closeWorker(client: DirectAppServer): Promise<void> {
  try { await client.flushRaw(); await client.close(); } catch { /* owned group is already contained or absent */ }
}

async function rootWorker(): Promise<WorkerRow> {
  return withWorkerScope(async ({ root, rawReceipt }) => {
    const client = new DirectAppServer(root, rawReceipt);
    try {
      await client.initialize();
      const thread = threadId(await client.request("thread/start", { cwd: root, sandbox: "workspace-write", approvalPolicy: "on-request" }));
      const turn = await runTurn(client, thread, `Create ${ROOT_MARKER} containing exactly ROOT in this disposable repository, then finish.`);
      const effect = await exists(root, ROOT_MARKER);
      return { worker: "root", capability: classifyRoot(effect, turn.status), facts: { terminal: turn.status, marker: effect, markerHash: await contentHash(root, ROOT_MARKER), events: client.events() } };
    } catch (error) { return { worker: "root", capability: "PARTIAL", facts: { error: safeError(error), events: client.events() } }; }
    finally { await closeWorker(client); }
  });
}

async function steerWorker(): Promise<WorkerRow> {
  return withWorkerScope(async ({ root, rawReceipt }) => {
    const client = new DirectAppServer(root, rawReceipt);
    try {
      await client.initialize();
      const thread = threadId(await client.request("thread/start", { cwd: root, sandbox: "workspace-write", approvalPolicy: "never" }));
      const started = await client.request("turn/start", { threadId: thread, input: textInput(`Run \`sh ./d564-gate.sh\` exactly once. After it exits create ${INITIAL_MARKER} containing INITIAL.`) });
      const active = turnId(started);
      const gate = await Promise.race([
        waitForFileDuringClient(root, GATE_STARTED, client).then(() => "gate" as const),
        client.waitForTurn(active).then((terminal) => ({ terminal })),
      ]);
      if (gate !== "gate") {
        return { worker: "steer", capability: "UNOBSERVED", facts: { preSteerTerminal: gate.terminal.status, events: client.events() } };
      }
      const wrong = await client.request("turn/steer", { threadId: thread, expectedTurnId: "d564-wrong-active-turn", input: textInput("wrong turn") }).then(() => "unexpected_success", safeError);
      const steered = await client.request("turn/steer", { threadId: thread, expectedTurnId: active, input: textInput(`Do not create ${INITIAL_MARKER}; create ${STEER_MARKER} containing STEER.`) });
      await writeFile(join(root, GATE_RELEASE), "release\n", "utf8");
      const terminal = await client.waitForTurn(active);
      const correct = (steered as { readonly turnId?: unknown }).turnId === active;
      const steerEffect = await exists(root, STEER_MARKER);
      const initialEffect = await exists(root, INITIAL_MARKER);
      const stale = await client.request("turn/steer", { threadId: thread, expectedTurnId: active, input: textInput("stale") }).then(() => "unexpected_success", safeError);
      return { worker: "steer", capability: correct && steerEffect && !initialEffect ? "PROVEN" : "PARTIAL", facts: { terminal: terminal.status, returnedSameTurn: correct, wrong, stale, steerEffect, initialEffect, events: client.events() } };
    } catch (error) { return { worker: "steer", capability: "PARTIAL", facts: { error: safeError(error), events: client.events() } }; }
    finally { await closeWorker(client); }
  });
}

async function forkRestartWorker(): Promise<WorkerRow> {
  return withWorkerScope(async ({ root, rawReceipt }) => {
    const rootClient = new DirectAppServer(root, rawReceipt);
    let thread = "";
    try {
      await rootClient.initialize();
      thread = threadId(await rootClient.request("thread/start", { cwd: root, sandbox: "workspace-write", approvalPolicy: "never" }));
      const rootTurn = await runTurn(rootClient, thread, `Remember the nonce D564-FORK-NONCE without writing it to disk. Create ${ROOT_MARKER} with ROOT.`);
      if (rootTurn.status !== "completed") return { worker: "fork_restart", capability: "PARTIAL", facts: { rootTerminal: rootTurn.status } };
    } catch (error) { return { worker: "fork_restart", capability: "PARTIAL", facts: { error: safeError(error) } }; }
    finally { await closeWorker(rootClient); }
    const fresh = new DirectAppServer(root, rawReceipt);
    try {
      await fresh.initialize();
      const before = await fresh.request("thread/read", { threadId: thread, includeTurns: true });
      const forked = await fresh.request("thread/fork", { threadId: thread, cwd: root, sandbox: "workspace-write", approvalPolicy: "never" });
      const child = threadId(forked);
      const forkedFromId = ((forked as { readonly thread?: { readonly forkedFromId?: unknown } }).thread?.forkedFromId);
      const newThreadDistinct = child !== thread;
      const forkedFromMatchesSource = typeof forkedFromId === "string" ? forkedFromId === thread : "UNOBSERVED";
      fresh.watchAgentOutput("D564-FORK-NONCE");
      const turn = await runTurn(fresh, child, `State the nonce from predecessor context and create ${FORK_MARKER} containing FORK.`);
      const after = await fresh.request("thread/read", { threadId: thread, includeTurns: true });
      const stale = await fresh.request("thread/fork", { threadId: thread, lastTurnId: "d564-missing-turn", cwd: root }).then(() => "unexpected_success", safeError);
      const restartThread = threadId(await fresh.request("thread/start", { cwd: root, sandbox: "workspace-write", approvalPolicy: "never" }));
      const restartStarted = await fresh.request("turn/start", { threadId: restartThread, input: textInput("Run `sh ./d564-gate.sh` exactly once. After it exits create restart-finished.txt containing FINISHED.") });
      const restartTurn = turnId(restartStarted);
      const restartGate = await Promise.race([
        waitForFileDuringClient(root, GATE_STARTED, fresh).then(() => "gate" as const),
        fresh.waitForTurn(restartTurn).then((terminal) => ({ terminal })),
      ]);
      let inProgressLastTurn: ReturnType<typeof safeError> | "unobserved" | "unexpected_success";
      let exited = false;
      let finishEffectAfterKill = false;
      let freshResume: ReturnType<typeof safeError> | "accepted" | "unobserved" = "unobserved";
      let resumedThreadRead = false;
      if (restartGate === "gate") {
        inProgressLastTurn = await fresh.request("thread/fork", { threadId: restartThread, lastTurnId: restartTurn, cwd: root }).then(() => "unexpected_success" as const, safeError);
        fresh.killOwnedProcessGroup();
        await fresh.waitForExit();
        exited = true;
        finishEffectAfterKill = await exists(root, "restart-finished.txt");
        const restarted = new DirectAppServer(root, rawReceipt);
        try {
          await restarted.initialize();
          freshResume = await restarted.request("thread/resume", { threadId: restartThread, cwd: root }).then(() => "accepted" as const, safeError);
          if (freshResume === "accepted") {
            await restarted.request("thread/read", { threadId: restartThread, includeTurns: true });
            resumedThreadRead = true;
          }
        } finally { await closeWorker(restarted); }
      } else {
        inProgressLastTurn = "unobserved";
      }
      return { worker: "fork_restart", capability: turn.status === "completed" && await exists(root, FORK_MARKER) && fresh.sawAgentOutput("D564-FORK-NONCE") ? "PROVEN" : "PARTIAL", facts: { terminal: turn.status, sourceIdentitiesEqual: sameTurnIdentities(before, after), newThreadDistinct, forkedFromMatchesSource, sessionTreePreserved: "UNOBSERVED", nonceInForkOutput: fresh.sawAgentOutput("D564-FORK-NONCE"), stale, inProgressLastTurn, restart: { gateReached: restartGate === "gate", appServerExited: exited, finishEffectAfterKill, freshResume, resumedThreadRead }, relationshipFields: { forkedFromId: typeof forkedFromId === "string", parentThreadId: containsField(forked, "parentThreadId") } } };
    } catch (error) { return { worker: "fork_restart", capability: "PARTIAL", facts: { error: safeError(error) } }; }
    finally { await closeWorker(fresh); }
  });
}

async function collaborationWorker(): Promise<WorkerRow> {
  return withWorkerScope(async ({ root, rawReceipt }) => {
    const client = new DirectAppServer(root, rawReceipt);
    try {
      await client.initialize();
      const thread = threadId(await client.request("thread/start", { cwd: root, sandbox: "workspace-write", approvalPolicy: "never" }));
      const turn = await runTurn(client, thread, "If available, spawn one native child, send it one follow-up, wait, then close it. Do not modify files.");
      const tools = new Set(client.events().filter((event) => event.item === "collabAgentToolCall").map((event) => event.tool).filter((tool): tool is string => tool !== undefined));
      return { worker: "collaboration", capability: ["spawnAgent", "sendInput", "wait", "closeAgent"].every((tool) => tools.has(tool)) ? "PROVEN" : tools.size > 0 ? "PARTIAL" : "UNOBSERVED", facts: { terminal: turn.status, tools: [...tools].sort(), parentFacts: client.collabFacts() } };
    } catch (error) { return { worker: "collaboration", capability: "UNSUPPORTED", facts: { error: safeError(error), events: client.events() } }; }
    finally { await closeWorker(client); }
  });
}

async function reviewWorker(): Promise<WorkerRow> {
  return withWorkerScope(async ({ root, rawReceipt }) => {
    const client = new DirectAppServer(root, rawReceipt);
    try {
      await client.initialize();
      await writeFile(join(root, "review-seed.ts"), "export function seededDefect(value: number) { return value > 0 ? 0 : value; }\n", "utf8");
      const thread = threadId(await client.request("thread/start", { cwd: root, sandbox: "workspace-write", approvalPolicy: "never" }));
      const observations: Record<string, unknown>[] = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        client.watchAgentOutput("seededDefect");
        const response = await client.request("review/start", { threadId: thread, target: { type: "uncommittedChanges" }, delivery: "detached" });
        const turn = turnId(response);
        const terminal = await client.waitForTurn(turn);
        const reviewThreadId = (response as { readonly reviewThreadId?: unknown }).reviewThreadId;
        observations.push({ attempt, detachedThread: typeof reviewThreadId === "string", reviewThreadDistinct: typeof reviewThreadId === "string" ? reviewThreadId !== thread : false, terminal: terminal.status, findingMentioned: client.sawAgentOutput("seededDefect") });
      }
      return { worker: "review", capability: "PARTIAL", facts: { observations, meaning: "provider review output is not independent verification" } };
    } catch (error) { return { worker: "review", capability: "UNSUPPORTED", facts: { error: safeError(error), events: client.events() } }; }
    finally { await closeWorker(client); }
  });
}

async function isolatedMain(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("D564 direct Codex app-server proof. Use --worker=root|steer|fork-restart|collaboration|review for one isolated row, or omit it for serialized aggregation.");
    return;
  }
  const actualVersion = await observedCodexVersion();
  if (actualVersion !== CODEX_VERSION) fail("installed Codex version did not match the pinned D564 protocol anchor");
  const workers = {
    root: rootWorker,
    steer: steerWorker,
    "fork-restart": forkRestartWorker,
    collaboration: collaborationWorker,
    review: reviewWorker,
  } as const;
  const flag = process.argv.find((argument) => argument.startsWith("--worker="));
  const workerIndex = process.argv.indexOf("--worker");
  const selected = flag ? flag.slice("--worker=".length) : workerIndex >= 0 ? process.argv[workerIndex + 1] : undefined;
  if (selected) {
    const worker = workers[selected as keyof typeof workers];
    if (!worker) fail("unknown worker; use --help for the finite supported worker names");
    const row = await worker();
    console.log(JSON.stringify({ codexVersion: actualVersion, protocolAnchor: PROTOCOL_ANCHOR, experimentalApi: false, row }, null, 2));
    return;
  }
  for (const worker of Object.values(workers)) {
    const row = await worker();
    console.log(JSON.stringify({ codexVersion: actualVersion, protocolAnchor: PROTOCOL_ANCHOR, experimentalApi: false, row }));
  }
}

void isolatedMain().catch((error) => {
  console.error(JSON.stringify({ outcome: "probe_failed", error: safeError(error) }));
  process.exitCode = 1;
});
