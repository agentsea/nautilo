/** Direct D564 Claude Agent SDK contract probe; no Nautilo imports. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { forkSession, getSessionInfo, getSessionMessages, getSubagentMessages, listSessions, listSubagents, query, type CanUseTool, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const SDK_VERSION = "0.3.235";
const ROOT_TOKEN = "ROOT_SYNTHETIC_17";
const FORK_TOKEN = "FORK_ONLY_SYNTHETIC_91";
const STALE_SESSION = "00000000-0000-4000-8000-000000000000";
const ROOT_COMMAND = "printf 'ROOT_PROOF\\n' > root-proof.txt";
const RESUME_COMMAND = "printf 'RESUME_PROOF\\n' > resume-proof.txt";
const PREDECESSOR_COMMAND = "printf 'PREDECESSOR_PROOF\\n' > predecessor-proof.txt";
const FORK_COMMAND = "printf 'FORK_PROOF\\n' > fork-proof.txt";
const STREAM_COMMAND = "printf 'ACTIVE_STARTED\\n' > active-started.txt; sleep 5; printf 'ACTIVE_FINISHED\\n' > active-finished.txt";
const BASE_COMMAND = "printf 'BASE_DECISION\\n' > base-decision.txt";
const REDIRECTED_COMMAND = "printf 'REDIRECTED_DECISION\\n' > redirected-decision.txt";
const CHILD_COMMAND = "printf 'CHILD_COMPLETE\\n' > child-complete.txt";
const REVIEW_COMMAND = "test \"$(cat review-target.txt)\" = REVIEW_TARGET";
type Fact = Record<string, boolean | number | string | string[]>;
type GuardRecord = { readonly events: string[]; sendMessageAttempted: boolean; taskOutputAllowed: boolean; readAllowed: boolean; bashAllowed: boolean };

function say(fact: Fact): void { console.log(JSON.stringify(fact)); }
function usage(): void { console.log("usage: bun dev/probes/d564-claude-agent-sdk-contract.ts --help|--static|--live"); }
function scratchFile(scratch: string, key: string): string { return join(scratch, `${key}.opaque`); }
function saveOpaque(scratch: string, key: string, value: string): void { writeFileSync(scratchFile(scratch, key), value, { mode: 0o600 }); }
function opaque(scratch: string, key: string): string { return readFileSync(scratchFile(scratch, key), "utf8"); }
function marker(repo: string, name: string, expected: string): boolean { const file = join(repo, name); return existsSync(file) && readFileSync(file, "utf8").trimEnd() === expected; }
function eventKind(message: SDKMessage): string { if (message.type === "system") return `system:${message.subtype}`; if (message.type === "result") return `result:${message.subtype}`; return message.type; }
function event(message: SDKMessage, into: string[]): void { into.push(eventKind(message)); }
function oneMessage(text: string): AsyncIterable<SDKUserMessage> {
  // The SDK requires an AsyncIterable even though this probe emits one ready value.
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* () { yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: crypto.randomUUID() }; })();
}
function inside(repo: string, input: unknown, expectedName: string): boolean {
  if (typeof input !== "string") return false;
  const target = resolve(repo, input);
  // The SDK may spell Darwin temporary roots through /private while mkdtemp
  // returns the /var alias. Canonicalize the existing parent, never the target.
  const canonicalTarget = resolve(realpathSync(dirname(target)), basename(target));
  return relative(realpathSync(repo), canonicalTarget) === expectedName;
}
function permit(options: { repo: string; writes?: Readonly<Record<string, string>>; bash?: string | readonly string[]; taskAgent?: string; taskName?: string; taskId?: () => string | undefined; taskOutput?: boolean; read?: string; record: GuardRecord }): CanUseTool {
  // The provider callback contract is asynchronous; the guard itself is local.
  // eslint-disable-next-line @typescript-eslint/require-await
  return async (toolName, input, control) => {
    const deny = () => ({ behavior: "deny" as const, message: "outside D564 disposable-repository probe authority", toolUseID: control.toolUseID });
    const allow = () => ({ behavior: "allow" as const, toolUseID: control.toolUseID });
    if (toolName === "Write" && options.writes !== undefined) {
      const pathMatches = Object.keys(options.writes).some((name) => inside(options.repo, input["file_path"], name));
      const contentMatches = Object.values(options.writes).some((expected) => typeof input["content"] === "string" && input["content"].trimEnd() === expected);
      for (const [name, expected] of Object.entries(options.writes)) if (inside(options.repo, input["file_path"], name) && typeof input["content"] === "string" && input["content"].trimEnd() === expected) { options.record.events.push("guard:Write:allowed"); return allow(); }
      options.record.events.push(`guard:Write:denied:path-${pathMatches}:content-${contentMatches}`); return deny();
    }
    if (toolName === "Read" && options.read !== undefined) {
      if (inside(options.repo, input["file_path"], options.read)) { options.record.readAllowed = true; options.record.events.push("guard:Read:allowed"); return allow(); }
      options.record.events.push("guard:Read:denied"); return deny();
    }
    if (toolName === "Bash" && options.bash !== undefined) {
      const known = typeof options.bash === "string" ? [options.bash] : options.bash;
      const safe = known.includes(input["command"] as string) && input["run_in_background"] !== true && input["dangerouslyDisableSandbox"] !== true;
      options.record.bashAllowed ||= safe;
      options.record.events.push(`guard:Bash:${safe ? "allowed" : "denied"}`); return safe ? allow() : deny();
    }
    if (toolName === "Agent" && options.taskAgent !== undefined) {
      const safe = input["subagent_type"] === options.taskAgent && input["name"] === options.taskName && input["run_in_background"] === true;
      options.record.events.push(`guard:Agent:${safe ? "allowed" : "denied"}`); return safe ? allow() : deny();
    }
    if (toolName === "TaskOutput" && options.taskOutput === true) {
      const safe = input["task_id"] === options.taskId?.() && input["block"] === true && input["timeout"] === 3000;
      options.record.taskOutputAllowed ||= safe; options.record.events.push(`guard:TaskOutput:${safe ? "allowed" : "denied"}`); return safe ? allow() : deny();
    }
    if (toolName === "SendMessage") { options.record.sendMessageAttempted = true; options.record.events.push("guard:SendMessage:denied"); return deny(); }
    options.record.events.push("guard:other:denied"); return deny();
  };
}
function locked(repo: string, tools: string[], canUseTool: CanUseTool): Parameters<typeof query>[0]["options"] {
  return { cwd: repo, tools, canUseTool, settingSources: [], strictMcpConfig: true, mcpServers: {}, includePartialMessages: false };
}
async function turn(label: string, repo: string, scratch: string, idKey: string | undefined, options: Parameters<typeof query>[0]["options"], prompt: string): Promise<Fact> {
  const q = query({ prompt, options }); const events: string[] = []; let sessionIdentityEmitted = false; let resultSeen = false; let eof = false; let rootTokenInResult = false; let claudeCodeVersion = "unobserved";
  try {
    for await (const message of q) {
      event(message, events);
      if (message.type === "system" && message.subtype === "init") { sessionIdentityEmitted = typeof message.session_id === "string"; claudeCodeVersion = message.claude_code_version; if (idKey !== undefined) saveOpaque(scratch, idKey, message.session_id); }
      if (message.type === "result") { resultSeen = true; rootTokenInResult ||= message.subtype === "success" && message.result.includes(ROOT_TOKEN); }
    }
    eof = true;
  } catch { events.push("iterator:rejected"); } finally { q.close(); }
  return { run: label, events, sessionIdentityEmitted, resultSeen, eof, rootTokenInResult, claudeCodeVersion };
}
function record(): GuardRecord { return { events: [], sendMessageAttempted: false, taskOutputAllowed: false, readAllowed: false, bashAllowed: false }; }
async function root(repo: string, scratch: string): Promise<void> {
  const guard = record(); const fact = await turn("root", repo, scratch, "root", { ...locked(repo, ["Bash"], permit({ repo, bash: ROOT_COMMAND, record: guard })), persistSession: true }, `Remember the synthetic label ${ROOT_TOKEN}. Use Bash once with this exact command: ${ROOT_COMMAND}. Then state the remembered label.`);
  say({ ...fact, guardEvents: guard.events, usefulFilesystemEffect: marker(repo, "root-proof.txt", "ROOT_PROOF") });
}
async function resume(repo: string, scratch: string, label: "resume" | "predecessor"): Promise<void> {
  const guard = record(); const file = `${label}-proof.txt`; const expected = `${label.toUpperCase()}_PROOF`; const command = label === "resume" ? RESUME_COMMAND : PREDECESSOR_COMMAND;
  const fact = await turn(label, repo, scratch, undefined, { ...locked(repo, ["Bash"], permit({ repo, bash: command, record: guard })), persistSession: true, resume: opaque(scratch, "root") }, `Continue the completed synthetic task without session-file tools. Use Bash once with this exact command: ${command}. Then state the root synthetic label.`);
  say({ ...fact, guardEvents: guard.events, freshClientResume: true, usefulFilesystemEffect: marker(repo, file, expected) });
}
async function fork(repo: string, scratch: string): Promise<void> {
  const before = (await getSessionMessages(opaque(scratch, "root"), { dir: repo })).length; const branch = await forkSession(opaque(scratch, "root"), { dir: repo }); saveOpaque(scratch, "fork", branch.sessionId);
  const guard = record(); const fact = await turn("fork", repo, scratch, undefined, { ...locked(repo, ["Bash"], permit({ repo, bash: FORK_COMMAND, record: guard })), persistSession: true, resume: branch.sessionId }, `This is a fork. Remember the fork-only synthetic label ${FORK_TOKEN}. Use Bash once with this exact command: ${FORK_COMMAND}. Then state both synthetic labels.`);
  const after = (await getSessionMessages(opaque(scratch, "root"), { dir: repo })).length;
  say({ ...fact, guardEvents: guard.events, forkReturnedDistinctOpaqueIdentity: branch.sessionId !== opaque(scratch, "root"), usefulFilesystemEffect: marker(repo, "fork-proof.txt", "FORK_PROOF"), predecessorChainUnchangedByFork: before === after, predecessorMessageCountBeforeFork: before, predecessorMessageCountAfterFork: after });
}
async function stale(repo: string, scratch: string): Promise<void> {
  const guard = record(); const fact = await turn("stale", repo, scratch, undefined, { ...locked(repo, [], permit({ repo, record: guard })), persistSession: true, resume: STALE_SESSION }, "Return a concise status only.");
  say({ ...fact, guardEvents: guard.events, intentionallyMissingSession: true });
}
async function stream(repo: string): Promise<void> {
  const guard = record(); const q = query({ prompt: oneMessage(`Use Bash once with this exact command: ${STREAM_COMMAND}. After it finishes, use Bash with this exact command: ${BASE_COMMAND}.`), options: { ...locked(repo, ["Bash"], permit({ repo, bash: [STREAM_COMMAND, BASE_COMMAND, REDIRECTED_COMMAND], record: guard })), persistSession: false, maxTurns: 4 } });
  const events: string[] = []; let activeProof = false; let injected = false; let streamResolved = false; let streamRejected = false; let results = 0; let control: Promise<void> | undefined;
  try {
    for await (const message of q) {
      event(message, events); const running = existsSync(join(repo, "active-started.txt")) && !existsSync(join(repo, "active-finished.txt"));
      if ((message.type === "tool_progress" && message.tool_name === "Bash") || running) activeProof ||= running || message.type === "tool_progress";
      if (activeProof && !injected) { injected = true; control = q.streamInput(oneMessage(`Change the current turn: do not run ${BASE_COMMAND}. Instead run this exact command: ${REDIRECTED_COMMAND}, then finish this turn.`)).then(() => { streamResolved = true; events.push("control:streamInput:resolved"); }).catch(() => { streamRejected = true; events.push("control:streamInput:rejected"); }); }
      if (message.type === "result") results++;
    }
    events.push("iterator:eof");
  } catch { events.push("iterator:rejected"); } finally { q.close(); }
  if (control !== undefined) await control;
  say({ run: "stream", events, guardEvents: guard.events, activeProofBeforeInjection: activeProof, injectedDuringActiveOperation: injected, streamInputResolved: streamResolved, streamInputRejected: streamRejected, resultCount: results, baseDecisionEffect: marker(repo, "base-decision.txt", "BASE_DECISION"), redirectedDecisionEffect: marker(repo, "redirected-decision.txt", "REDIRECTED_DECISION") });
}
async function child(repo: string, scratch: string): Promise<void> {
  const guard = record(); let taskId: string | undefined; let taskNotification = "unobserved"; let taskUpdate = "unobserved"; let taskOutputRequested = false; let taskOutputResult = false; let taskStarted = false; let initTask = false; let initAgent = false; let initTaskOutput = false; let initSendMessage = false; const toolNames: string[] = [];
  const q = query({ prompt: `Use Agent once to start tiny-complete as background name tiny-child, asking it to run this exact command: ${CHILD_COMMAND}. Then call TaskOutput for that task with block true and timeout 3000. Do not use any other tool.`, options: { ...locked(repo, ["Agent", "TaskOutput"], permit({ repo, taskAgent: "tiny-complete", taskName: "tiny-child", taskId: () => taskId, taskOutput: true, bash: CHILD_COMMAND, record: guard })), persistSession: true, agents: { "tiny-complete": { description: "write one synthetic marker", prompt: `Use Bash only with this exact command: ${CHILD_COMMAND}, then report completion.`, tools: ["Bash"], background: true, maxTurns: 2 } } } });
  let sessionId: string | undefined;
  try {
    for await (const message of q) {
      event(message, guard.events);
      if (message.type === "system" && message.subtype === "init") { sessionId = message.session_id; saveOpaque(scratch, "child", sessionId); initTask = message.tools.includes("Task"); initAgent = message.tools.includes("Agent"); initTaskOutput = message.tools.includes("TaskOutput"); initSendMessage = message.tools.includes("SendMessage"); }
      if (message.type === "system" && message.subtype === "task_started" && !taskStarted) { taskStarted = true; taskId = message.task_id; }
      if (message.type === "system" && message.subtype === "task_notification") taskNotification = message.status;
      if (message.type === "system" && message.subtype === "task_updated") taskUpdate = message.patch.status ?? taskUpdate;
      if (message.type === "assistant") for (const part of message.message.content) if (part.type === "tool_use") { toolNames.push(part.name); taskOutputRequested ||= part.name === "TaskOutput"; }
      if (message.type === "user" && message.tool_use_result !== undefined) taskOutputResult ||= taskOutputRequested;
    }
    guard.events.push("iterator:eof");
  } catch { guard.events.push("iterator:rejected"); } finally { q.close(); }
  const subagents = sessionId ? await listSubagents(sessionId, { dir: repo }) : []; const childMessages = sessionId && subagents[0] ? await getSubagentMessages(sessionId, subagents[0], { dir: repo }) : []; const sessions = await listSessions({ dir: repo, includeProgrammatic: true }); const info = sessionId ? await getSessionInfo(sessionId, { dir: repo }) : undefined; const rootMessages = sessionId ? await getSessionMessages(sessionId, { dir: repo }) : [];
  say({ run: "child", events: guard.events, toolNames, initExposesTask: initTask, initExposesAgent: initAgent, initExposesTaskOutput: initTaskOutput, initExposesSendMessage: initSendMessage, nativeTaskStarted: taskStarted, taskNotification, taskUpdate, taskOutputRequested, taskOutputAllowed: guard.taskOutputAllowed, taskOutputResultObserved: taskOutputResult, childEffectCompleted: marker(repo, "child-complete.txt", "CHILD_COMPLETE"), childListed: subagents.length > 0, childMessageCount: childMessages.length, sessionListed: sessions.some((row) => row.sessionId === sessionId), sessionInfoFound: Boolean(info), rootMessageCount: rootMessages.length });
}
async function stopChild(repo: string): Promise<void> {
  const guard = record(); let taskId: string | undefined; let stopped = false; let terminal = "unobserved";
  const q = query({ prompt: "Use Agent once to start tiny-stop in the background as tiny-stop-child. Do not use another tool.", options: { ...locked(repo, ["Agent"], permit({ repo, taskAgent: "tiny-stop", taskName: "tiny-stop-child", bash: "sleep 5", record: guard })), persistSession: false, agents: { "tiny-stop": { description: "bounded waiting child", prompt: "Use Bash only with the exact command sleep 5, then report completion.", tools: ["Bash"], background: true, maxTurns: 2 } } } });
  try {
    for await (const message of q) {
      event(message, guard.events);
      if (message.type === "system" && message.subtype === "task_started" && taskId === undefined) { taskId = message.task_id; try { await q.stopTask(taskId); stopped = true; guard.events.push("control:stopTask:resolved"); } catch { guard.events.push("control:stopTask:rejected"); } }
      if (message.type === "system" && message.subtype === "task_notification") terminal = message.status;
    }
    guard.events.push("iterator:eof");
  } catch { guard.events.push("iterator:rejected"); } finally { q.close(); }
  say({ run: "child-stop", events: guard.events, nativeTaskStarted: taskId !== undefined, stopTaskResolved: stopped, taskNotification: terminal });
}
async function sendBoundary(repo: string): Promise<void> {
  const guard = record(); let initSendMessage = false; let toolAttempted = false;
  const q = query({ prompt: "Attempt SendMessage once to the synthetic nonexistent recipient named no-such-child with the text SYNTHETIC_NOTE. Do not use another tool.", options: { ...locked(repo, ["SendMessage"], permit({ repo, record: guard })), persistSession: false } });
  try {
    for await (const message of q) {
      event(message, guard.events);
      if (message.type === "system" && message.subtype === "init") initSendMessage = message.tools.includes("SendMessage");
      if (message.type === "assistant") toolAttempted ||= message.message.content.some((part) => part.type === "tool_use" && part.name === "SendMessage");
    }
    guard.events.push("iterator:eof");
  } catch { guard.events.push("iterator:rejected"); } finally { q.close(); }
  say({ run: "send-boundary", events: guard.events, initExposesSendMessage: initSendMessage, sendMessageToolAttempted: toolAttempted, sendMessagePermissionCallbackObserved: guard.sendMessageAttempted });
}
async function review(repo: string): Promise<void> {
  writeFileSync(join(repo, "review-target.txt"), "REVIEW_TARGET\n"); const guard = record(); let taskStarted = false; let taskTerminal = "unobserved"; let verdictPass = false; let initVerifier = false; let initTask = false; let initAgent = false;
  const q = query({ prompt: `Use Agent once to invoke verifier to inspect review-target.txt. Do not edit it. Report the verifier verdict.`, options: { ...locked(repo, ["Agent"], permit({ repo, taskAgent: "verifier", taskName: "review-child", bash: REVIEW_COMMAND, record: guard })), persistSession: false, agents: { verifier: { description: "read-only synthetic review", prompt: `Use Bash only with this exact command: ${REVIEW_COMMAND}. Report PASS if it succeeds, otherwise FAIL.`, tools: ["Bash"], background: true, maxTurns: 2 } } } });
  try {
    for await (const message of q) {
      event(message, guard.events);
      if (message.type === "system" && message.subtype === "init") { initVerifier = message.agents?.includes("verifier") === true; initTask = message.tools.includes("Task"); initAgent = message.tools.includes("Agent"); }
      if (message.type === "system" && message.subtype === "task_started") taskStarted = true;
      if (message.type === "system" && message.subtype === "task_notification") taskTerminal = message.status;
      if (message.type === "result" && message.subtype === "success") verdictPass ||= message.result.includes("PASS");
    }
    guard.events.push("iterator:eof");
  } catch { guard.events.push("iterator:rejected"); } finally { q.close(); }
  say({ run: "review", events: guard.events, initExposesVerifier: initVerifier, initExposesTask: initTask, initExposesAgent: initAgent, reviewTaskStarted: taskStarted, reviewTaskTerminal: taskTerminal, reviewEvidenceToolAllowed: guard.bashAllowed, parentResultContainsPass: verdictPass, reviewTargetUnchanged: marker(repo, "review-target.txt", "REVIEW_TARGET") });
}
async function worker(mode: string, repo: string, scratch: string): Promise<void> {
  if (mode === "root") return root(repo, scratch);
  if (mode === "resume") return resume(repo, scratch, "resume");
  if (mode === "fork") return fork(repo, scratch);
  if (mode === "predecessor") return resume(repo, scratch, "predecessor");
  if (mode === "stale") return stale(repo, scratch);
  if (mode === "stream") return stream(repo);
  if (mode === "child") return child(repo, scratch);
  if (mode === "child-stop") return stopChild(repo);
  if (mode === "send-boundary") return sendBoundary(repo);
  if (mode === "review") return review(repo);
  throw new Error("unknown worker");
}
function live(): void {
  const scratch = mkdtempSync(join(tmpdir(), "d564-claude-contract-")); const repo = mkdtempSync(join(tmpdir(), "d564-claude-repo-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    for (const mode of ["root", "resume", "fork", "predecessor", "stale", "stream", "child", "child-stop", "send-boundary", "review"]) {
      const child = Bun.spawnSync([process.execPath, process.argv[1]!, "--worker", mode, repo, scratch], { stdout: "pipe", stderr: "pipe" });
      process.stdout.write(child.stdout); if (child.exitCode !== 0) say({ run: mode, workerExitCode: child.exitCode, workerFailedWithoutRawDiagnostics: true });
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
}
const args = process.argv.slice(2);
if (args[0] === "--help") usage();
else if (args[0] === "--static") say({ static: "ok", sdkVersionPinned: SDK_VERSION, noNautiloImports: true, structuralToolsOnly: true, settingSourcesEmpty: true, strictMcpConfig: true, opaqueIdsOutsideModelCwd: true, streamTurnBudget: 4, childTurnBudget: 2, stopChildTurnBudget: 2, reviewTurnBudget: 2 });
else if (args[0] === "--worker") await worker(args[1]!, args[2]!, args[3]!);
else if (args[0] === "--live") live();
else { usage(); process.exitCode = 2; }
