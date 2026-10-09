/**
 * PTY session host (Electron main process).
 *
 * A per-process pool of `node-pty` sessions keyed by id, shared by two
 * consumers that both live in the Electron main process:
 *   - the workbench renderer, via the preload `terminal:*` IPC bridge
 *     (streams output through `webContents.send`), and
 *   - the desktop relay (`relay.ts`), via the exported `*Session` ops
 *     below (agent `terminal` tool — P2). Same pool ⇒ agent output shows
 *     up in the user's open surface.
 *
 * Sessions are the durable object; a renderer surface is just a view.
 * The host never kills a session on renderer unmount — only an explicit
 * kill (or `disposeAllTerminals` on quit) ends one.
 *
 * Agent-spawned sessions are sandbox-wrapped (Gap-1) by passing a
 * `Sandbox` (the relay's per-turn envelope) to `spawnSession`; the wrap
 * path is `Sandbox.wrap(shell, [], cwd, env)` → `node-pty.spawn(...)`,
 * verified in spike 0.6. User (renderer) sessions omit the sandbox and
 * run the real shell.
 *
 * node-pty is a native addon (esbuild-external, asarUnpack'd in the
 * packaged app) — a plain runtime `import` here.
 */

import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import type { IPty } from "node-pty";
import type { Sandbox } from "@nautilo/sandbox";
import { parseHumanTerminalOperation, parseHumanTerminalOwner, parseHumanTerminalConsentOwner, sameHumanTerminalConsentOwner,
  type HumanTerminalConsent, type HumanTerminalConsentOwner,
  type HumanTerminalGrant, type HumanTerminalOperation, type HumanTerminalOwner,
  type HumanTerminalResult } from "../../../packages/types/src/human-terminal";

const require = createRequire(import.meta.url);

export interface TerminalCreateArgs {
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly shell?: string;
  /** When set, the session is sandbox-wrapped (agent-grantable session). */
  readonly sandbox?: Sandbox;
}

/** P2.2b — who holds the single-writer input lock for a session. */
export type Controller = "user" | "agent";

export interface TerminalSessionInfo {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  /** True for sandbox-wrapped (agent) sessions. */
  readonly sandboxed: boolean;
  /** Current input-lock owner (P2.2b). */
  readonly controller: Controller;
  /** P2.2b — agent tried to write while the user holds the lock (a pending request). */
  readonly requested: boolean;
  /** main-owned per-PTY consent: the user has explicitly handed this
   *  one PTY to Genie until Human retake. False at birth for both origins
   *  (sandboxed PTYs are born agent-controlled and need no consent; a
   *  user-created real shell needs this set before `setController("agent")`
   *  can transfer). Not durable: dies with the session map entry. */
  readonly agentControlConsented: boolean;
}

/** Result of a write: enforced against the single-writer lock (P2.2b). */
export type WriteResult =
  | { ok: true }
  | { ok: false; reason: "no-session" | "locked" };

interface Session {
  readonly id: string;
  readonly pty: IPty;
  readonly title: string;
  readonly cwd: string;
  readonly sandboxed: boolean;
  /** P2.2b input lock: only the controller may write; the other side is refused. */
  controller: Controller;
  /** P2.2b — set when the agent's write was refused (user holds the lock); a
   *  standing request the user can approve. Cleared on any control transfer. */
  requested: boolean;
  /** main-owned per-PTY consent flag (see TerminalSessionInfo). */
  agentControlConsented: boolean;
  /** Once scoped, legacy Agent APIs remain unavailable even after revocation. */
  humanTerminalScoped: boolean;
  /** Bounded scrollback so a reopened view / late reader isn't blank. */
  scrollback: string;
  /** Total UTF-16 code units produced — the existing monotone cursor space. */
  produced: number;
  /** 0.5 throughput — output coalesced within a frame before one IPC send. */
  pendingOut: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Session>();
let counter = 0;
// Exact one-shot handoff from the Human's "Let Genie drive" action to the
// next agent terminal operation. This is local PTY routing state, not durable
// permission: consent and the controller lock remain authoritative on Session.
// Keeping the exact id prevents a mistaken `spawn` from opening a second,
// sandboxed terminal after the Human explicitly handed over an existing one.
let pendingAgentHandoffSessionId: string | null = null;
// Durable default routing for session-less agent terminal operations. Unlike
// the pending notification above, this survives the first successful call and
// lasts exactly as long as the Human keeps Genie in control of that PTY.
let boundAgentTerminalSessionId: string | null = null;
// One explicitly selected Human PTY. Neither the grant nor its PTY id is a
// model-facing selector; terminal-host remains the sole owner of that PTY.
let humanTerminalGrant: (HumanTerminalConsent & { readonly sessionId: string; conversationId: string | null; inputs: Map<string, { digest: string; result: Promise<HumanTerminalResult> }> }) | null = null;
let humanTerminalInputCapacity = 0;
let publishHumanTerminalConsentChanged: (() => void | Promise<void>) | null = null;
let publishAgentHandoffChanged: ((pending: boolean) => void | Promise<void>) | null = null;
let pendingAgentHandoffPublication: Promise<void> = Promise.resolve();

function setPendingAgentHandoffSessionId(sessionId: string | null): void {
  if (pendingAgentHandoffSessionId === sessionId) return;
  pendingAgentHandoffSessionId = sessionId;
  const publisher = publishAgentHandoffChanged;
  if (publisher === null) return;
  pendingAgentHandoffPublication = Promise.resolve(publisher(sessionId !== null)).catch((err) => {
    console.warn(
      `[terminal] failed to publish agent handoff availability: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

async function waitForAgentHandoffPublication(): Promise<void> {
  await pendingAgentHandoffPublication;
}

function humanTerminalConsentChanged(): void {
  const publisher = publishHumanTerminalConsentChanged;
  if (!publisher) return;
  pendingAgentHandoffPublication = pendingAgentHandoffPublication
    .then(() => publisher(), () => publisher()).catch(() => {
      console.warn("[terminal] Human terminal availability could not be refreshed");
    });
}

/** Scrollback cap per session (chars). Head is dropped past the cap. */
const SCROLLBACK_CAP = 256 * 1024;

/** Max concurrent sessions (P-6 bound). Refuses new spawns past this so a
 *  runaway caller can't pile up unbounded PTYs. Ample for human + agent use. */
const MAX_SESSIONS = 32;

/** Push target for streamed output (the renderer). Set by registerTerminalHost. */
let getWebContents: (() => WebContents | null) | null = null;

/** Coalesce window (ms) — one IPC send per frame instead of per PTY chunk.
 *  Caps IPC/xterm-write pressure under floods (`yes`, big builds) at ~60/s. */
const OUTPUT_FLUSH_MS = 16;

function defaultShell(): string {
  const fromEnv = process.env["SHELL"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return process.platform === "win32" ? "powershell.exe" : "/bin/zsh";
}

/** node-pty requires a complete string map when an environment is explicit. */
function hostEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** Lazy bind — node-pty is native; defer load so bun:test imports of relay.ts
 *  don't require pty.node on Linux CI (only spawnSession needs it). */
export function spawnTerminalPty(...args: Parameters<typeof import("node-pty").spawn>): IPty {
  // `require` here is the module-scope createRequire binding (line 31), not the
  // global — so `@typescript-eslint/no-require-imports` does not flag it and no
  // eslint-disable is needed. (A prior directive here was flagged "unused" and
  // auto-stripped by `eslint --fix` on every cold-cache commit; removed at the
  // source. Intent preserved: node-pty is a native addon loaded lazily so
  // bun:test imports of relay.ts skip pty.node on Linux CI.)
  const { spawn } = require("node-pty") as typeof import("node-pty");
  return spawn(...args);
}

/** Flush a session's coalesced output to the renderer in a single IPC message. */
function flushOutput(session: Session): void {
  session.flushTimer = null;
  if (session.pendingOut.length === 0) return;
  const chunk = session.pendingOut;
  session.pendingOut = "";
  getWebContents?.()?.send("terminal:data", { sessionId: session.id, chunk });
}

function onChunk(session: Session, chunk: string): void {
  // Scrollback + cursor accounting stay immediate so polled reads (agent) and
  // reattach see fresh bytes; only the renderer stream is coalesced.
  session.produced += chunk.length;
  const next = session.scrollback + chunk;
  session.scrollback =
    next.length > SCROLLBACK_CAP ? next.slice(next.length - SCROLLBACK_CAP) : next;
  session.pendingOut += chunk;
  if (session.flushTimer === null) {
    session.flushTimer = setTimeout(() => flushOutput(session), OUTPUT_FLUSH_MS);
  }
}

// ---------------------------------------------------------------------------
// Shared session ops — consumed by BOTH the renderer IPC handlers and the
// relay (agent `terminal` tool).
// ---------------------------------------------------------------------------

/** Spawn a session. Pass `sandbox` for an agent-grantable (contained) shell. */
export function spawnSession(args: TerminalCreateArgs = {}): TerminalSessionInfo {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(
      `terminal: session limit reached (${MAX_SESSIONS}); close a terminal before opening another`,
    );
  }
  const id = `t${++counter}`;
  const cwd =
    args.cwd && args.cwd.length > 0 ? args.cwd : process.env["HOME"] ?? process.cwd();
  const shell = args.shell && args.shell.length > 0 ? args.shell : defaultShell();
  // Renderer-created sessions inherit the user's real workstation environment.
  // A sandboxed session replaces this with the exact map constructed by wrap(),
  // or explicitly asks node-pty to inherit its parent environment with `null`.
  let env: Record<string, string> | null = hostEnvironment();

  let program = shell;
  let spawnArgs: string[] = [];
  const sandboxed = args.sandbox !== undefined;
  if (args.sandbox !== undefined) {
    // Gap-1: contained agent session. Same shape verified in spike 0.6.
    const wrapped = args.sandbox.wrap(shell, [], cwd, {});
    program = wrapped.program;
    spawnArgs = [...wrapped.args];
    // `null` is the Sandbox contract for intentional parent-env inheritance.
    // Otherwise preserve its constructed HOME/PATH policy without allowing the
    // host environment to override it.
    env = wrapped.env;
  }

  const pty = spawnTerminalPty(program, spawnArgs, {
    name: "xterm-color",
    cols: args.cols && args.cols > 0 ? args.cols : 80,
    rows: args.rows && args.rows > 0 ? args.rows : 24,
    cwd,
    ...(env !== null ? { env } : {}),
  });
  const title = shell.split("/").pop() ?? "shell";
  // Birth lock (P2.2b): the user owns their own shell; an agent-spawned
  // (sandboxed) session is Genie's workspace and starts under agent control.
  const controller: Controller = sandboxed ? "agent" : "user";
  const session: Session = {
    id,
    pty,
    title,
    cwd,
    sandboxed,
    controller,
    requested: false,
    agentControlConsented: false,
    humanTerminalScoped: false,
    scrollback: "",
    produced: 0,
    pendingOut: "",
    flushTimer: null,
  };
  sessions.set(id, session);

  pty.onData((chunk) => onChunk(session, chunk));
  pty.onExit(({ exitCode }) => {
    // Flush any buffered tail so the last output isn't lost to the exit race.
    if (session.flushTimer !== null) clearTimeout(session.flushTimer);
    flushOutput(session);
    sessions.delete(id);
    if (humanTerminalGrant?.sessionId === id) { humanTerminalGrant = null; humanTerminalConsentChanged(); }
    if (pendingAgentHandoffSessionId === id) setPendingAgentHandoffSessionId(null);
    if (boundAgentTerminalSessionId === id) boundAgentTerminalSessionId = null;
    getWebContents?.()?.send("terminal:exit", { sessionId: id, exitCode });
  });

  return { id, title, cwd, sandboxed, controller, requested: false, agentControlConsented: false };
}

export function writeSession(id: string, data: string, by: Controller = "user"): WriteResult {
  const s = sessions.get(id);
  if (!s) return { ok: false, reason: "no-session" };
  // Legacy Agent input has no authenticated tuple and cannot borrow a scoped
  // Human grant. Human IPC continues to use its existing controller lock.
  if (by === "agent" && s.humanTerminalScoped) return { ok: false, reason: "locked" };
  // P2.2b single-writer lock: only the current controller may write. The
  // other party (a user keystroke while Genie drives, or an agent write while
  // the user holds control) is refused — no interleaved bytes on one stdin.
  if (s.controller !== by) {
    // The agent's refused write IS its request for control: raise a standing
    // flag the user can approve from the surface (no chat round-trip needed).
    // this applies to BOTH origins: an agent write against a live
    // user-controlled PTY (sandboxed or not) raises at most one standing
    // request and returns `locked`. The relay then waits on the bounded
    // grant path; the user's explicit `grantAgentControl` (or a consented
    // `setController("agent")`) completes it. There is no impossible-to-grant
    // short-circuit here — every live PTY is grantable through the consent
    // state machine.
    if (by === "agent" && !s.requested) {
      s.requested = true;
      getWebContents?.()?.send("terminal:request", { sessionId: id, requested: true });
    }
    return { ok: false, reason: "locked" };
  }
  s.pty.write(data);
  return { ok: true };
}

/**
 * Transfer the input lock (P2.2b). A generic renderer request may hand Genie
 * a sandbox-wrapped session (born agent-controlled) OR a user-created session
 * whose per-PTY consent has already been recorded by the explicit grant
 * operation. It may NOT mint consent for a real user shell — that requires
 * {@link grantAgentControl}, the active-sender-validated grant IPC.
 *
 * User retake (`controller="user"`) revokes consent and all routing state.
 * A later Agent transfer requires a fresh explicit grant. Neither transfer
 * kills the PTY or interrupts the Human's job.
 */
function setController(id: string, controller: Controller): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (controller === "agent" && s.humanTerminalScoped) return false;
  if (controller === "agent" && !s.sandboxed && !s.agentControlConsented) return false;
  s.controller = controller;
  if (controller === "agent" && !s.sandboxed && s.agentControlConsented) {
    boundAgentTerminalSessionId = id;
    setPendingAgentHandoffSessionId(id);
  } else if (controller === "user") {
    s.agentControlConsented = false;
    if (humanTerminalGrant?.sessionId === id) { humanTerminalGrant = null; humanTerminalConsentChanged(); }
    if (pendingAgentHandoffSessionId === id) setPendingAgentHandoffSessionId(null);
    if (boundAgentTerminalSessionId === id) boundAgentTerminalSessionId = null;
  }
  getWebContents?.()?.send("terminal:controller", { sessionId: id, controller });
  if (s.requested) {
    s.requested = false;
    getWebContents?.()?.send("terminal:request", { sessionId: id, requested: false });
  }
  return true;
}

/**
 * the explicit, active-sender-validated grant operation. Atomically
 * records per-PTY consent, transfers the input lock to Genie, emits the
 * authoritative `terminal:controller` event, and clears/emits any standing
 * `terminal:request`. Missing or scoped sessions refuse this legacy grant.
 *
 * This operation mints legacy consent only. Generic `setController` may
 * consume it but never creates it. Human retake revokes it; scoped handoff
 * uses grantHumanTerminalConsent with an authenticated owner instead.
 */
function grantAgentControl(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.humanTerminalScoped) return false;
  s.agentControlConsented = true;
  s.controller = "agent";
  boundAgentTerminalSessionId = id;
  setPendingAgentHandoffSessionId(id);
  getWebContents?.()?.send("terminal:controller", { sessionId: id, controller: "agent" });
  if (s.requested) {
    s.requested = false;
    getWebContents?.()?.send("terminal:request", { sessionId: id, requested: false });
  }
  return true;
}

/** Dismiss a pending agent control request without handing over (P2.2b). */
function clearControlRequest(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.requested) {
    s.requested = false;
    getWebContents?.()?.send("terminal:request", { sessionId: id, requested: false });
  }
  return true;
}

function resizeSession(id: string, cols: number, rows: number): void {
  const s = sessions.get(id);
  if (s && cols > 0 && rows > 0) s.pty.resize(cols, rows);
}

function killSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  if (s.flushTimer !== null) clearTimeout(s.flushTimer);
  try {
    s.pty.kill();
  } catch {
    /* already dead */
  }
  sessions.delete(id);
  if (humanTerminalGrant?.sessionId === id) { humanTerminalGrant = null; humanTerminalConsentChanged(); }
  if (pendingAgentHandoffSessionId === id) setPendingAgentHandoffSessionId(null);
  if (boundAgentTerminalSessionId === id) boundAgentTerminalSessionId = null;
}

export function listSessions(): TerminalSessionInfo[] {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    sandboxed: s.sandboxed,
    controller: s.controller,
    requested: s.requested,
    agentControlConsented: s.agentControlConsented,
  }));
}

function attachSession(
  id: string,
): { ok: true; info: TerminalSessionInfo; scrollback: string } | { ok: false } {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  return {
    ok: true,
    info: {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      sandboxed: s.sandboxed,
      controller: s.controller,
      requested: s.requested,
      agentControlConsented: s.agentControlConsented,
    },
    scrollback: s.scrollback,
  };
}

/** Read a PTY only after the caller has checked its current consent owner. */
function readHumanTerminalSince(
  id: string,
  cursor: number,
): { ok: true; data: string; cursor: number; truncated: boolean } | { ok: false } {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  const bufferStart = s.produced - s.scrollback.length;
  if (cursor >= s.produced) {
    return { ok: true, data: "", cursor: s.produced, truncated: false };
  }
  if (cursor < bufferStart) {
    return { ok: true, data: s.scrollback, cursor: s.produced, truncated: true };
  }
  return {
    ok: true,
    data: s.scrollback.slice(cursor - bufferStart),
    cursor: s.produced,
    truncated: false,
  };
}

/** Explicit Human consent is pending until an admitted foreground dispatch
 * supplies the canonical conversation. Selection metadata is never a grant. */
export function grantHumanTerminalConsent(id: string, owner: HumanTerminalConsentOwner): HumanTerminalConsent | null {
  const parsed = parseHumanTerminalConsentOwner(owner);
  const session = sessions.get(id);
  if (!parsed || !session || session.sandboxed) return null;
  if (humanTerminalGrant) setController(humanTerminalGrant.sessionId, "user");
  if (boundAgentTerminalSessionId !== null && boundAgentTerminalSessionId !== id) setController(boundAgentTerminalSessionId, "user");
  const grant = { owner: parsed, generation: randomUUID(), sessionId: id, conversationId: null, inputs: new Map<string, { digest: string; result: Promise<HumanTerminalResult> }>() };
  humanTerminalGrant = grant;
  session.humanTerminalScoped = true;
  session.agentControlConsented = true;
  session.controller = "agent";
  // The scoped lane cannot be discovered or selected through legacy routing.
  boundAgentTerminalSessionId = null;
  setPendingAgentHandoffSessionId(null);
  humanTerminalConsentChanged();
  getWebContents?.()?.send("terminal:controller", { sessionId: id, controller: "agent" });
  if (session.requested) {
    session.requested = false;
    getWebContents?.()?.send("terminal:request", { sessionId: id, requested: false });
  }
  return { owner: { ...parsed }, generation: grant.generation };
}

/** Main-owned consent metadata only; no terminal bytes or model selector. */
export function peekHumanTerminalConsent(): HumanTerminalConsent | null {
  const grant = humanTerminalGrant;
  const session = grant && sessions.get(grant.sessionId);
  return grant && session?.controller === "agent" && session.agentControlConsented
    ? { owner: { ...grant.owner }, generation: grant.generation } : null;
}

/** Called only after fresh canonical foreground admission. Atomic binding
 * cannot select a different PTY or replace an already bound conversation. */
export function bindHumanTerminalConsent(owner: HumanTerminalOwner, generation: string): HumanTerminalGrant | null {
  const parsed = parseHumanTerminalOwner(owner);
  const grant = humanTerminalGrant;
  const consent = peekHumanTerminalConsent();
  if (!parsed || !grant || !consent || grant.generation !== generation
    || !sameHumanTerminalConsentOwner(grant.owner, parsed)
    || (grant.conversationId !== null && grant.conversationId !== parsed.conversationId)) return null;
  grant.conversationId = parsed.conversationId;
  return { owner: parsed, generation };
}

export function revokeHumanTerminalConsent(generation: string): boolean {
  const grant = humanTerminalGrant;
  return grant?.generation === generation ? setController(grant.sessionId, "user") : false;
}

/** Electron-local discovery for an already authenticated exact owner. */
export function peekHumanTerminalGrant(owner: HumanTerminalOwner): HumanTerminalGrant | null {
  const parsed = parseHumanTerminalOwner(owner);
  const grant = humanTerminalGrant;
  const session = grant && sessions.get(grant.sessionId);
  return parsed && grant && session && session.controller === "agent" && session.agentControlConsented
    && grant.conversationId === parsed.conversationId && sameHumanTerminalConsentOwner(grant.owner, parsed)
    ? { owner: { ...grant.owner, conversationId: grant.conversationId }, generation: grant.generation } : null;
}

/** Fresh checks surround awaits; the exact retained grant is rechecked in the
 * same turn immediately before reads/input. Input acknowledgement is not a
 * shell exit/completion receipt. Existing scrollback uses UTF-16 cursors. */
async function executeHumanTerminalOnce(owner: HumanTerminalOwner, generation: string,
  operation: HumanTerminalOperation, isCurrent: () => boolean | Promise<boolean>, signal?: AbortSignal): Promise<HumanTerminalResult> {
  const parsedOwner = parseHumanTerminalOwner(owner);
  const request = parseHumanTerminalOperation(operation);
  const action = request?.action ?? "read";
  let inputWritten = false;
  const failure = (code: Extract<HumanTerminalResult, { ok: false }>["code"]): HumanTerminalResult => ({
    ok: false, action, code, inputWritten: code === "input_failed" ? "unknown" : inputWritten, retrySafe: !inputWritten && code !== "input_failed",
  });
  if (!parsedOwner || !request || typeof generation !== "string" || !generation) return failure("invalid_request");
  const grant = humanTerminalGrant;
  const matches = () => !!grant && humanTerminalGrant === grant && grant.generation === generation
    && grant.conversationId === parsedOwner.conversationId && sameHumanTerminalConsentOwner(grant.owner, parsedOwner) && !signal?.aborted
    && sessions.get(grant.sessionId)?.controller === "agent" && sessions.get(grant.sessionId)?.agentControlConsented === true;
  if (!matches()) return failure("grant_required");
  const fresh = async () => {
    try { return await isCurrent() && matches(); } catch { return false; }
  };
  if (!await fresh()) return failure("authority_changed");
  const session = grant && sessions.get(grant.sessionId);
  if (!session) return failure("no_session");
  const cursor = request.action === "read" ? request.cursor ?? 0 : session.produced;
  if (!matches()) return failure("authority_changed");
  if (request.action !== "read") {
    try {
      // Preserve the current program: it may be a shell, REPL or TUI.
      session.pty.write(request.action === "run" ? `${request.command}\r` : request.data);
      inputWritten = true;
    } catch { return failure("input_failed"); }
  }
  if (!matches()) return failure(inputWritten ? "outcome_unknown" : "authority_changed");
  if (request.action !== "read") {
    if (!await fresh() || !matches()) return failure("outcome_unknown");
    // A submission receipt retains no duplicate scrollback. Read from this
    // pre-input cursor to observe subsequent output, including synchronous data.
    return { ok: true, action, inputWritten, commandOutcome: "not_observed", data: "", cursor,
      truncated: false, availableFrom: cursor, produced: cursor, cursorUnit: "utf16_code_units" };
  }
  const output = readHumanTerminalSince(session.id, cursor);
  const availableFrom = session.produced - session.scrollback.length;
  if (!output.ok) return failure(inputWritten ? "outcome_unknown" : "no_session");
  if (!await fresh() || !matches()) return failure(inputWritten ? "outcome_unknown" : "authority_changed");
  return { ...output, action, inputWritten, commandOutcome: "not_observed",
    availableFrom, produced: output.cursor, cursorUnit: "utf16_code_units" };
}

/** One grant owns its input identity ledger. Never evict an identity while
 * the grant can still write; exact concurrent repeats share the same outcome. */
export async function executeHumanTerminal(owner: HumanTerminalOwner, generation: string,
  operation: HumanTerminalOperation, isCurrent: () => boolean | Promise<boolean>, signal?: AbortSignal,
  invocationId?: string): Promise<HumanTerminalResult> {
  const request = parseHumanTerminalOperation(operation);
  if (!request || request.action === "read") return executeHumanTerminalOnce(owner, generation, operation, isCurrent, signal);
  const failure = (code: Extract<HumanTerminalResult, { ok: false }>["code"]): HumanTerminalResult => ({
    ok: false, action: request.action, code, inputWritten: false, retrySafe: true,
  });
  const grant = humanTerminalGrant;
  if (!grant || !peekHumanTerminalGrant(owner) || grant.generation !== generation) return {
    ok: false, action: request.action, code: "grant_required", inputWritten: "unknown", retrySafe: false,
  };
  if (!invocationId || invocationId.trim() !== invocationId) return failure("invalid_request");
  const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const previous = grant.inputs.get(invocationId);
  if (previous && previous.digest !== digest) return {
    ok: false, action: request.action, code: "invocation_conflict", inputWritten: "unknown", retrySafe: false,
  };
  if (!previous && grant.inputs.size >= humanTerminalInputCapacity) return failure("capacity_reached");
  if (previous) {
    const result = await previous.result;
    let current = false;
    try { current = await isCurrent(); } catch { /* fail closed */ }
    if (!current || signal?.aborted || humanTerminalGrant !== grant || !peekHumanTerminalGrant(owner)) {
      return { ok: false, action: request.action, code: "outcome_unknown", inputWritten: result.inputWritten, retrySafe: false };
    }
    return result;
  }
  const result = executeHumanTerminalOnce(owner, generation, request, isCurrent, signal);
  grant.inputs.set(invocationId, { digest, result });
  return result;
}

// ---------------------------------------------------------------------------
// Renderer IPC (user-driven sessions — real shell, no sandbox).
// ---------------------------------------------------------------------------

export interface TerminalHostDeps {
  readonly ipcMain: IpcMain;
  readonly assertSender: (e: IpcMainInvokeEvent) => void;
  readonly getWebContents: () => WebContents | null;
  /** Publishes only the presence/absence of an exact local Human handoff.
   * The PTY id and shell state remain Electron-local; session-less terminal
   * operations resolve through the local binding. */
  readonly onAgentHandoffChanged?: (pending: boolean) => void | Promise<void>;
  readonly onHumanTerminalConsentChanged?: () => void | Promise<void>;
  /** Explicit caller policy; capacity exhaustion refuses further input until fresh Human consent. */
  readonly humanTerminalInputCapacity?: number;
}

export function registerTerminalHost(deps: TerminalHostDeps): void {
  const { ipcMain, assertSender } = deps;
  humanTerminalInputCapacity = Number.isSafeInteger(deps.humanTerminalInputCapacity) && deps.humanTerminalInputCapacity! > 0 ? deps.humanTerminalInputCapacity! : 0;
  getWebContents = deps.getWebContents;
  publishAgentHandoffChanged = deps.onAgentHandoffChanged ?? null;
  publishHumanTerminalConsentChanged = deps.onHumanTerminalConsentChanged ?? null;

  ipcMain.handle(
    "terminal:create",
    (e: IpcMainInvokeEvent, args: TerminalCreateArgs = {}): TerminalSessionInfo => {
      assertSender(e);
      // Renderer never spawns sandboxed sessions — the user's real shell.
      return spawnSession({
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        ...(args.cols !== undefined ? { cols: args.cols } : {}),
        ...(args.rows !== undefined ? { rows: args.rows } : {}),
        ...(args.shell !== undefined ? { shell: args.shell } : {}),
      });
    },
  );

  ipcMain.handle(
    "terminal:attach",
    (e: IpcMainInvokeEvent, args: { sessionId: string }) => {
      assertSender(e);
      return attachSession(args.sessionId);
    },
  );

  ipcMain.handle(
    "terminal:write",
    (e: IpcMainInvokeEvent, args: { sessionId: string; data: string }): WriteResult => {
      assertSender(e);
      // Renderer writes are the user; the host lock refuses them while Genie drives.
      return writeSession(args.sessionId, args.data, "user");
    },
  );

  ipcMain.handle(
    "terminal:set-controller",
    async (
      e: IpcMainInvokeEvent,
      args: { sessionId: string; controller: Controller },
    ): Promise<boolean> => {
      assertSender(e);
      const changed = setController(args.sessionId, args.controller);
      if (changed) await waitForAgentHandoffPublication();
      return changed;
    },
  );

  // the explicit grant IPC, distinct from the generic
  // `terminal:set-controller`. It is the only operation that mints per-PTY
  // consent; `assertSender` keeps a background/foreign renderer from granting
  // control of another session's PTY. Registered separately so the generic
  // controller toggle can never accidentally create consent.
  ipcMain.handle(
    "terminal:grant-agent-control",
    async (e: IpcMainInvokeEvent, args: { sessionId: string }): Promise<boolean> => {
      assertSender(e);
      const granted = grantAgentControl(args.sessionId);
      if (granted) await waitForAgentHandoffPublication();
      return granted;
    },
  );

  ipcMain.handle(
    "terminal:clear-request",
    (e: IpcMainInvokeEvent, args: { sessionId: string }): boolean => {
      assertSender(e);
      return clearControlRequest(args.sessionId);
    },
  );

  ipcMain.handle(
    "terminal:resize",
    (
      e: IpcMainInvokeEvent,
      args: { sessionId: string; cols: number; rows: number },
    ): void => {
      assertSender(e);
      resizeSession(args.sessionId, args.cols, args.rows);
    },
  );

  ipcMain.handle(
    "terminal:kill",
    (e: IpcMainInvokeEvent, args: { sessionId: string }): void => {
      assertSender(e);
      killSession(args.sessionId);
    },
  );

  ipcMain.handle("terminal:list", (e: IpcMainInvokeEvent): TerminalSessionInfo[] => {
    assertSender(e);
    return listSessions();
  });
}

/** Kill every live PTY. Call on app quit so no orphaned shells linger. */
export function disposeAllTerminals(): void {
  for (const s of sessions.values()) {
    if (s.flushTimer !== null) clearTimeout(s.flushTimer);
    try {
      s.pty.kill();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
  humanTerminalGrant = null;
  setPendingAgentHandoffSessionId(null);
  boundAgentTerminalSessionId = null;
  publishAgentHandoffChanged = null;
  publishHumanTerminalConsentChanged = null;
}
