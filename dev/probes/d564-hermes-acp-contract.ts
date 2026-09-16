/** Direct D564 Hermes ACP contract probe; it deliberately imports no Nautilo code. */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- raw cross-version JSON-RPC probe intentionally validates runtime wire values. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as nodeAcp from "@agentclientprotocol/sdk";

const ROOT_TOKEN = "HERMES_ROOT_SYNTHETIC_41";
const FORK_TOKEN = "HERMES_FORK_ONLY_SYNTHETIC_72";
const ACTIVE_COMMAND = "sh -c 'printf ACTIVE_STARTED > active-started; sleep 7; printf ACTIVE_FINISHED > active-finished'";
const ROOT_COMMAND = "printf ROOT_EFFECT > root-effect";
const RESUME_COMMAND = "printf RESUME_EFFECT > resume-effect";
const FORK_COMMAND = "printf FORK_EFFECT > fork-effect";
const FOLLOWUP_COMMAND = "printf FOLLOWUP_EFFECT > followup-effect";
const RESTART_COMMAND = "printf RESTART_EFFECT > restart-effect";
const HERMES_ACP_PROTOCOL_VERSION = 1;

type Facts = Record<string, boolean | number | string | string[]>;

function say(fact: Facts): void { console.log(JSON.stringify(fact)); }
function usage(): void { console.log("usage: bun dev/probes/d564-hermes-acp-contract.ts --help|--static|--live"); }
function marker(repo: string, name: string, expected: string): boolean {
  const file = join(repo, name);
  return existsSync(file) && readFileSync(file, "utf8") === expected;
}
function git(repo: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ""} failed`);
}
function classifyUpdate(update: any): string {
  const name = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "unknown";
  if (name === "tool_call" || name === "tool_call_update") {
    const status = typeof update.status === "string" ? update.status : "none";
    return `${name}:${status}`;
  }
  return name;
}
function choosePermission(params: any): { outcome: { outcome: "selected"; optionId: string } } | { outcome: { outcome: "cancelled" } } {
  const option = Array.isArray(params?.options) ? params.options.find((item: any) => item?.optionId === "allow_once") : undefined;
  return typeof option?.optionId === "string"
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}
function toSnake(value: any): any {
  if (Array.isArray(value)) return value.map(toSnake);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), toSnake(item)]));
  return value;
}
function toCamel(value: any): any {
  if (Array.isArray(value)) return value.map(toCamel);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), toCamel(item)]));
  return value;
}
function resetContextObservation(record: ProbeEvents): void { record.sawRootToken = false; record.sawForkToken = false; }
function capabilityInventory(initialized: any): string[] {
  const capabilities = initialized?.agentCapabilities;
  const root = capabilities && typeof capabilities === "object" ? Object.keys(capabilities).sort() : [];
  const session = capabilities?.sessionCapabilities && typeof capabilities.sessionCapabilities === "object"
    ? Object.keys(capabilities.sessionCapabilities).sort().map((key) => `sessionCapabilities.${key}`) : [];
  return [...root, ...session];
}

type ProbeEvents = {
  readonly events: string[];
  permissions: number;
  permissionAllowed: boolean;
  permissionDenied: boolean;
  expectedSessionId: string | undefined;
  expectedCommand: string | undefined;
  sawDelegateActivity: boolean;
  sawReviewVerdict: boolean;
  processGroupTerminationSent: boolean;
  processExitObserved: boolean;
  processGroupId: number | undefined;
  toolStarted: Promise<void>;
  markToolStarted(): void;
  sawRootToken: boolean;
  sawForkToken: boolean;
};

function events(): ProbeEvents {
  let resolveToolStarted!: () => void;
  let started = false;
  return {
    events: [], permissions: 0, permissionAllowed: false, permissionDenied: false, expectedSessionId: undefined, expectedCommand: undefined, sawDelegateActivity: false, sawReviewVerdict: false, processGroupTerminationSent: false, processExitObserved: false, processGroupId: undefined, toolStarted: new Promise<void>((resolve) => { resolveToolStarted = resolve; }), sawRootToken: false, sawForkToken: false,
    markToolStarted() { if (!started) { started = true; resolveToolStarted(); } },
  };
}

function permitExact(params: any, record: ProbeEvents): { outcome: { outcome: "selected"; optionId: string } } | { outcome: { outcome: "cancelled" } } {
  const sessionMatches = typeof params?.sessionId === "string" && params.sessionId === record.expectedSessionId;
  const command = params?.toolCall?.rawInput?.command;
  const commandMatches = typeof command === "string" && command === record.expectedCommand;
  if (!sessionMatches || !commandMatches) { record.permissionDenied = true; return { outcome: { outcome: "cancelled" } }; }
  const selection = choosePermission(params);
  record.permissionAllowed ||= selection.outcome.outcome === "selected";
  return selection;
}
async function withHermes<T>(repo: string, operation: (ctx: { request(method: string, params: any): Promise<any>; notify(method: string, params: any): void; terminateExactGroup(): void }, record: ProbeEvents, initialized: any) => Promise<T>): Promise<T> {
  // The minimal launcher gives this probe an owned process group; the exact
  // installed Hermes binary is still exec'd directly after `setsid`.
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-c", "import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])", "hermes", "-p", "nautilo-acp", "acp"], {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"], detached: false,
    // Preserve the ordinary logged-in provider route but prohibit unrelated configured MCP startup.
    env: { ...process.env, HERMES_ACP_SKIP_CONFIGURED_MCP: "1" },
  });
  const record = events();
  record.processGroupId = child.pid;
  let nextId = 1;
  const pending = new Map<number, { resolve(value: any): void; reject(reason: unknown): void }>();
  child.once("exit", () => {
    for (const waiting of pending.values()) waiting.reject(new Error("probe process exited"));
    pending.clear();
  });
  let buffered = "";
  const ctx = {
    request(method: string, params: any): Promise<any> {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: toSnake(params) })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method: string, params: any): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: toSnake(params) })}\n`);
    },
    terminateExactGroup(): void {
      if (child.pid) { record.processGroupTerminationSent = true; process.kill(-child.pid, "SIGTERM"); }
    },
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === "session/request_permission") {
        record.permissions += 1; record.events.push("permission:requested");
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: toSnake(permitExact(toCamel(message.params), record)) })}\n`);
        continue;
      }
      if (message.method === "session/update") {
        const update: any = toCamel(message.params?.update);
        const event = `update:${classifyUpdate(update)}`;
        if (!record.events.includes(event)) record.events.push(event);
        if (typeof update?.content?.text === "string") {
          record.sawRootToken ||= update.content.text.includes(ROOT_TOKEN);
          record.sawForkToken ||= update.content.text.includes(FORK_TOKEN);
        }
        if (typeof update?.title === "string") record.sawDelegateActivity ||= update.title.toLowerCase().includes("delegate");
        if (typeof update?.content?.text === "string") record.sawReviewVerdict ||= update.content.text.includes("REVIEW_PASS");
        if (update?.sessionUpdate === "tool_call" || (update?.sessionUpdate === "tool_call_update" && ["pending", "in_progress"].includes(update?.status))) record.markToolStarted();
        continue;
      }
      if (typeof message.id === "number" && pending.has(message.id)) {
        const waiting = pending.get(message.id)!; pending.delete(message.id);
        if (message.error) waiting.reject(new Error(`RPC ${String(message.error.code)}`)); else waiting.resolve(toCamel(message.result));
      }
    }
  });
  try {
    const initialized: any = await ctx.request("initialize", {
        protocolVersion: HERMES_ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "d564-hermes-contract-probe", version: "1" },
    });
    record.events.push(`initialize:v${String(initialized.protocolVersion)}`);
    return await operation(ctx, record, initialized);
  } finally {
    for (const waiting of pending.values()) waiting.reject(new Error("probe process closed"));
    pending.clear();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* exact group already exited */ }
    }
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    record.processExitObserved = child.exitCode !== null || child.signalCode !== null;
  }
}

async function prompt(ctx: any, sessionId: string, text: string): Promise<any> {
  return ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
}
async function newSession(ctx: any, repo: string): Promise<any> { return ctx.request("session/new", { cwd: repo, mcpServers: [] }); }
async function loadSession(ctx: any, repo: string, sessionId: string): Promise<any> { return ctx.request("session/load", { cwd: repo, sessionId, mcpServers: [] }); }
async function resumeSession(ctx: any, repo: string, sessionId: string): Promise<any> { return ctx.request("session/resume", { cwd: repo, sessionId, mcpServers: [] }); }
async function waitForMarker(repo: string, name: string): Promise<void> {
  while (!existsSync(join(repo, name))) await new Promise<void>((resolve) => setTimeout(resolve, 25));
}
function groupAbsent(groupId: number | undefined): boolean {
  if (!groupId) return false;
  const observed = spawnSync("ps", ["-o", "pid=", "-g", String(groupId)], { encoding: "utf8" });
  return observed.status === 1 || observed.stdout.trim() === "";
}

async function coreWorker(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "d564-hermes-acp-"));
  try {
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "probe@example.invalid");
    git(repo, "config", "user.name", "D564 Probe");

    const root = await withHermes(repo, async (ctx, record, init) => {
      const session = await newSession(ctx, repo);
      record.expectedSessionId = String(session.sessionId); record.expectedCommand = ROOT_COMMAND;
      const result = await prompt(ctx, session.sessionId, `Remember ${ROOT_TOKEN}. Use the execute tool exactly once with ${ROOT_COMMAND}. Then reply with the token only.`);
      const listed: any = await ctx.request("session/list", { cwd: repo });
      return { sessionId: String(session.sessionId), record, result, init, listed };
    });
    say({ run: "root", protocolVersion: String(root.init.protocolVersion), capabilityInventory: capabilityInventory(root.init), permissionRequests: root.record.permissions, orderedEvents: root.record.events, terminal: String(root.result.stopReason), usefulFilesystemEffect: marker(repo, "root-effect", "ROOT_EFFECT"), opaqueSessionIdentityReturned: root.sessionId.length > 0, sessionListContainsRoot: Array.isArray(root.listed.sessions) && root.listed.sessions.some((row: any) => row?.sessionId === root.sessionId), rootContextObserved: root.record.sawRootToken });

    const resume = await withHermes(repo, async (ctx, record) => {
      const loaded = await loadSession(ctx, repo, root.sessionId);
      const replayEvents = [...record.events]; resetContextObservation(record);
      record.expectedSessionId = root.sessionId; record.expectedCommand = RESUME_COMMAND;
      const result = await prompt(ctx, root.sessionId, `Use the execute tool exactly once with ${RESUME_COMMAND}. Then state the synthetic label remembered from the earlier completed turn, without inventing a new label.`);
      return { loaded, result, record, replayEvents };
    });
    say({ run: "fresh-process-load", loadReturned: resume.loaded !== null, replayEvents: resume.replayEvents, postPromptContextObserved: resume.record.sawRootToken, permissionRequests: resume.record.permissions, orderedEvents: resume.record.events, terminal: String(resume.result.stopReason), usefulFilesystemEffect: marker(repo, "resume-effect", "RESUME_EFFECT") });

    const freshResume = await withHermes(repo, async (ctx, record) => {
      const resumed: any = await resumeSession(ctx, repo, root.sessionId); resetContextObservation(record);
      const result = await prompt(ctx, String(resumed.sessionId ?? root.sessionId), "State the synthetic label remembered from the earlier completed turn, without inventing a new label.");
      return { resumed, result, record };
    });
    say({ run: "fresh-process-resume", returnedOpaqueIdentity: typeof freshResume.resumed?.sessionId === "string", postPromptContextObserved: freshResume.record.sawRootToken, terminal: String(freshResume.result.stopReason), orderedEvents: freshResume.record.events });

    const stale = await withHermes(repo, async (ctx, record) => {
      const missing = "00000000-0000-4000-8000-000000000000";
      let load = "unobserved"; let resume = "unobserved";
      try { await loadSession(ctx, repo, missing); load = "accepted"; } catch { load = "rejected"; }
      try { const value: any = await resumeSession(ctx, repo, missing); resume = typeof value?.sessionId === "string" ? "accepted-with-identity" : "accepted-without-identity"; } catch { resume = "rejected"; }
      return { record, load, resume };
    });
    say({ run: "fresh-process-missing-session", loadMissing: stale.load, resumeMissing: stale.resume, orderedEvents: stale.record.events });

    const fork = await withHermes(repo, async (ctx, record) => {
      const response: any = await ctx.request("session/fork", { cwd: repo, sessionId: root.sessionId, mcpServers: [] });
      const replayEvents = [...record.events]; resetContextObservation(record);
      record.expectedSessionId = String(response.sessionId); record.expectedCommand = FORK_COMMAND;
      const result = await prompt(ctx, response.sessionId, `Use the execute tool exactly once with ${FORK_COMMAND}. Then state the earlier remembered synthetic label and additionally remember the new branch label ${FORK_TOKEN}.`);
      return { forkId: String(response.sessionId), result, record, replayEvents };
    });
    say({ run: "fresh-process-fork", distinctOpaqueForkIdentity: fork.forkId !== root.sessionId, replayEvents: fork.replayEvents, parentContextObservedInFork: fork.record.sawRootToken, forkOnlyContextObserved: fork.record.sawForkToken, permissionRequests: fork.record.permissions, orderedEvents: fork.record.events, terminal: String(fork.result.stopReason), usefulFilesystemEffect: marker(repo, "fork-effect", "FORK_EFFECT") });

    const originalAfterFork = await withHermes(repo, async (ctx, record) => {
      await loadSession(ctx, repo, root.sessionId);
      resetContextObservation(record);
      const result = await prompt(ctx, root.sessionId, "State the synthetic label remembered from the earlier completed turn. Do not mention a branch-only label.");
      return { result, record };
    });
    say({ run: "parent-after-fork", predecessorContextPreserved: originalAfterFork.record.sawRootToken, forkOnlyContextLeakedToParent: originalAfterFork.record.sawForkToken, orderedEvents: originalAfterFork.record.events, terminal: String(originalAfterFork.result.stopReason) });

    const active = await withHermes(repo, async (ctx, record) => {
      const session = await newSession(ctx, repo);
      record.expectedSessionId = String(session.sessionId); record.expectedCommand = ACTIVE_COMMAND;
      const first = prompt(ctx, session.sessionId, `Use the execute tool exactly once with ${ACTIVE_COMMAND}. Do not use any other tool. After completion say ACTIVE_DONE.`)
        .then((result) => ({ kind: "response", stopReason: String(result.stopReason) }), () => ({ kind: "transport_error", stopReason: "unobserved" }));
      await record.toolStarted;
      ctx.notify("session/cancel", { sessionId: session.sessionId });
      const terminal = await first;
      return { sessionId: String(session.sessionId), first: terminal, record };
    });
    say({ run: "active-cancel", activeToolObservedBeforeControl: true, firstTurnSettlement: active.first.kind, firstTurnTerminal: active.first.stopReason, cancellationObserved: active.first.stopReason === "cancelled", permissionRequests: active.record.permissions, orderedEvents: active.record.events, startedEffect: existsSync(join(repo, "active-started")), finishedEffectAfterCancel: existsSync(join(repo, "active-finished")), nativeCurrentTurnSteerMethodObserved: false });

    const afterCancel = await withHermes(repo, async (ctx, record) => {
      await loadSession(ctx, repo, active.sessionId);
      record.expectedSessionId = active.sessionId; record.expectedCommand = FOLLOWUP_COMMAND;
      const result = await prompt(ctx, active.sessionId, `Use the execute tool exactly once with ${FOLLOWUP_COMMAND}. Then reply FOLLOWUP_DONE.`);
      return { result, record };
    });
    say({ run: "fresh-process-after-cancel", laterPromptTerminal: String(afterCancel.result.stopReason), permissionRequests: afterCancel.record.permissions, orderedEvents: afterCancel.record.events, usefulFilesystemEffect: marker(repo, "followup-effect", "FOLLOWUP_EFFECT") });

  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function disposableRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "d564-hermes-acp-"));
  git(repo, "init", "-q"); git(repo, "config", "user.email", "probe@example.invalid"); git(repo, "config", "user.name", "D564 Probe");
  return repo;
}
async function killWorker(): Promise<void> {
  const repo = disposableRepo();
  try {
    const terminated = await withHermes(repo, async (ctx, record) => {
      const session = await newSession(ctx, repo);
      record.expectedSessionId = String(session.sessionId); record.expectedCommand = ACTIVE_COMMAND;
      const original = prompt(ctx, session.sessionId, `Use the execute tool exactly once with ${ACTIVE_COMMAND}. Do not use any other tool.`)
        .then(() => "completed-before-termination", () => "connection-lost");
      await waitForMarker(repo, "active-started");
      ctx.terminateExactGroup();
      // A killed stdio peer closes every stream handle; retain this worker only
      // until the owned request settles so the post-kill recovery observation runs.
      const retained = setInterval(() => undefined, 1_000);
      try { return { sessionId: String(session.sessionId), record, settlement: await original }; } finally { clearInterval(retained); }
    });
    const restarted = await withHermes(repo, async (ctx, record) => {
      try {
        await loadSession(ctx, repo, terminated.sessionId);
        record.expectedSessionId = terminated.sessionId; record.expectedCommand = RESTART_COMMAND;
        const result = await prompt(ctx, terminated.sessionId, `Use the execute tool exactly once with ${RESTART_COMMAND}. Then reply RESTART_DONE.`);
        return { record, load: "accepted", terminal: String(result.stopReason) };
      } catch { return { record, load: "rejected", terminal: "unobserved" }; }
    });
    say({ run: "active-process-termination-and-restart", activeStartedFileObservedBeforeTermination: true, originalSettlement: terminated.settlement, exactProcessGroupTerminationSent: terminated.record.processGroupTerminationSent, exactProcessExitObserved: terminated.record.processExitObserved, groupAndDescendantsAbsent: groupAbsent(terminated.record.processGroupId), finishedMarkerAfterTermination: existsSync(join(repo, "active-finished")), freshProcessLoadAfterTermination: restarted.load, laterPromptTerminal: restarted.terminal, restartEffect: marker(repo, "restart-effect", "RESTART_EFFECT"), orderedEvents: restarted.record.events });
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
async function delegationWorker(): Promise<void> {
  const repo = disposableRepo();
  try {
    const delegated = await withHermes(repo, async (ctx, record) => {
      const session = await newSession(ctx, repo);
      const result = await prompt(ctx, session.sessionId, "Use delegate_task once for a tiny read-only subtask: state whether this repository is a Git repository. Do not create, edit, or execute files. Return the child result.");
      return { result, record };
    });
    say({ run: "delegate-task-attempt", promptTerminal: String(delegated.result.stopReason), ordinaryDelegateToolActivityObserved: delegated.record.sawDelegateActivity, structuredChildUpdateObserved: delegated.record.events.some((event) => event.includes("child") || event.includes("subagent")), orderedEvents: delegated.record.events });
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
async function reviewWorker(): Promise<void> {
  const repo = disposableRepo();
  try {
    const root = await withHermes(repo, async (ctx, record) => {
      const session = await newSession(ctx, repo);
      record.expectedSessionId = String(session.sessionId); record.expectedCommand = ROOT_COMMAND;
      await prompt(ctx, session.sessionId, `Use the execute tool exactly once with ${ROOT_COMMAND}. Then reply ROOT_DONE.`);
      return { sessionId: String(session.sessionId), record };
    });
    const review = await withHermes(repo, async (ctx, record) => {
      const forked: any = await ctx.request("session/fork", { cwd: repo, sessionId: root.sessionId, mcpServers: [] });
      const result = await prompt(ctx, forked.sessionId, "Act as a narrow reviewer. Inspect whether root-effect exists in the current repository. Do not edit files. Reply exactly REVIEW_PASS if it exists, otherwise REVIEW_FAIL.");
      return { result, record, distinctFork: String(forked.sessionId) !== root.sessionId };
    });
    say({ run: "fork-review-attempt", rootEffect: marker(repo, "root-effect", "ROOT_EFFECT"), distinctOpaqueForkIdentity: review.distinctFork, promptTerminal: String(review.result.stopReason), modelJudgmentObserved: review.record.sawReviewVerdict, structuredVerifierUpdateObserved: review.record.events.some((event) => event.includes("verifier") || event.includes("review")), orderedEvents: review.record.events });
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
async function nodeSdkWorker(): Promise<void> {
  const repo = disposableRepo();
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-c", "import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])", "hermes", "-p", "nautilo-acp", "acp"], { cwd: repo, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HERMES_ACP_SKIP_CONFIGURED_MCP: "1" } });
  try {
    let result = "unobserved";
    try {
      await nodeAcp.client({ name: "d564-node-acp-sdk-compat" }).connectWith(
        nodeAcp.ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        ),
        async (ctx) => {
          await ctx.request(nodeAcp.methods.agent.initialize, { protocolVersion: nodeAcp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "d564-node-acp-sdk-compat", version: "1" } });
          result = "accepted";
        },
      );
    } catch { result = "rejected"; }
    say({ run: "node-sdk-1.3-initialize", officialNodeSdkProtocolVersion: String(nodeAcp.PROTOCOL_VERSION), camelCaseInitialize: result, classification: result === "rejected" ? "incompatible" : "compatible" });
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already absent */ } }
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    rmSync(repo, { recursive: true, force: true });
  }
}
async function permissionWorker(): Promise<void> {
  const repo = disposableRepo();
  try {
    const attempted = await withHermes(repo, async (ctx, record) => {
      const session = await newSession(ctx, repo);
      record.expectedSessionId = String(session.sessionId); record.expectedCommand = "printf PERMISSION_ALLOW > permission-allow";
      const allowed = await prompt(ctx, session.sessionId, "Use the execute tool exactly once with printf PERMISSION_ALLOW > permission-allow. Do not use any other tool.");
      // The second operation has deliberately mismatched admitted authority.
      record.expectedCommand = "printf PERMISSION_ALLOW > permission-allow";
      const denied = await prompt(ctx, session.sessionId, "Use the execute tool exactly once with printf PERMISSION_DENY > permission-deny. Do not use any other tool.");
      return { record, allowed, denied };
    });
    say({ run: "permission-exact-and-mismatch", permissionRequests: attempted.record.permissions, exactAllowOnceObserved: attempted.record.permissionAllowed, mismatchedRequestCancelled: attempted.record.permissionDenied, firstTerminal: String(attempted.allowed.stopReason), secondTerminal: String(attempted.denied.stopReason), exactEffect: marker(repo, "permission-allow", "PERMISSION_ALLOW"), mismatchEffect: marker(repo, "permission-deny", "PERMISSION_DENY"), orderedEvents: attempted.record.events });
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
async function parent(): Promise<void> {
  for (const mode of ["--worker-node-sdk", "--worker-core", "--worker-permission", "--worker-kill", "--worker-delegate", "--worker-review"] as const) {
    const child = spawn(process.execPath, [process.argv[1]!, mode], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { output += chunk; });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    const rows = output.split("\n").flatMap((line) => { try { return [JSON.parse(line) as Facts]; } catch { return []; } });
    if (rows.length === 0 || code !== 0) say({ run: `worker:${mode.slice(9)}`, workerClassification: "PARTIAL", workerResult: "failed-before-semantic-row" });
    else for (const row of rows) say(row);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--help";
  if (mode === "--help") return usage();
  if (mode === "--static") {
    const check = spawnSync("hermes", ["-p", "nautilo-acp", "acp", "--check"], { encoding: "utf8" });
    say({ run: "static", hermesAcpCheckPassed: check.status === 0, outputClass: check.status === 0 ? "check-ok" : "check-failed" });
    return;
  }
  if (mode === "--live") return parent();
  if (mode === "--worker-core") return coreWorker();
  if (mode === "--worker-kill") return killWorker();
  if (mode === "--worker-delegate") return delegationWorker();
  if (mode === "--worker-review") return reviewWorker();
  if (mode === "--worker-node-sdk") return nodeSdkWorker();
  if (mode === "--worker-permission") return permissionWorker();
  usage();
  process.exitCode = 2;
}

main().catch(() => { process.exitCode = 1; });
