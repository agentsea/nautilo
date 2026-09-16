/**
 * D373 / Stack 137 — PTY session host (Electron main process).
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
import type { IPty } from "node-pty";
import type { Sandbox } from "@nautilo/sandbox";

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
  /** D438 — main-owned per-PTY consent: the user has explicitly handed this
   *  one PTY to Genie for its lifetime. False at birth for both origins
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
  /** D438 — main-owned per-PTY consent flag (see TerminalSessionInfo). */
  agentControlConsented: boolean;
  /** Bounded scrollback so a reopened view / late reader isn't blank. */
  scrollback: string;
  /** Total bytes ever produced — the monotone cursor space for polled reads. */
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
function spawnPty(...args: Parameters<typeof import("node-pty").spawn>): IPty {
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

  const pty = spawnPty(program, spawnArgs, {
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
    if (pendingAgentHandoffSessionId === id) setPendingAgentHandoffSessionId(null);
    if (boundAgentTerminalSessionId === id) boundAgentTerminalSessionId = null;
    getWebContents?.()?.send("terminal:exit", { sessionId: id, exitCode });
  });

  return { id, title, cwd, sandboxed, controller, requested: false, agentControlConsented: false };
}

export function writeSession(id: string, data: string, by: Controller = "user"): WriteResult {
  const s = sessions.get(id);
  if (!s) return { ok: false, reason: "no-session" };
  // P2.2b single-writer lock: only the current controller may write. The
  // other party (a user keystroke while Genie drives, or an agent write while
  // the user holds control) is refused — no interleaved bytes on one stdin.
  if (s.controller !== by) {
    // The agent's refused write IS its request for control: raise a standing
    // flag the user can approve from the surface (no chat round-trip needed).
    // D438 — this applies to BOTH origins: an agent write against a live
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
 * User retake (`controller="user"`) is always allowed and does NOT clear
 * consent: once the user has handed a PTY to Genie, control may move back
 * and forth for that PTY's lifetime without re-confirming. Both directions
 * resolve a pending agent request.
 */
function setController(id: string, controller: Controller): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (controller === "agent" && !s.sandboxed && !s.agentControlConsented) return false;
  s.controller = controller;
  if (controller === "agent" && !s.sandboxed && s.agentControlConsented) {
    boundAgentTerminalSessionId = id;
    setPendingAgentHandoffSessionId(id);
  } else if (controller === "user") {
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
 * D438 — the explicit, active-sender-validated grant operation. Atomically
 * records per-PTY consent, transfers the input lock to Genie, emits the
 * authoritative `terminal:controller` event, and clears/emits any standing
 * `terminal:request`. Returns `false` only when the session is gone.
 *
 * This is the ONE operation that mints consent. Generic `setController` may
 * consume it but never creates it. After this call, `setController("agent")`
 * succeeds for this PTY for the rest of its lifetime (even after the user
 * retakes), and no confirmation is re-raised.
 */
function grantAgentControl(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
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

/** Current lock state for a session (P2.2b) — lets the relay wait for a grant. */
export function getSessionControl(
  id: string,
): { controller: Controller; requested: boolean } | null {
  const s = sessions.get(id);
  if (!s) return null;
  return { controller: s.controller, requested: s.requested };
}

/**
 * Exact Human-selected PTY awaiting the agent's next terminal operation.
 * `peek` powers truthful `terminal list` output; `consume` binds a mistaken
 * next `spawn` to this existing PTY instead. Any successful operation against
 * the exact session acknowledges the handoff through `acknowledge`.
 */
export function peekAgentHandoffSession(): TerminalSessionInfo | null {
  if (pendingAgentHandoffSessionId === null) return null;
  const s = sessions.get(pendingAgentHandoffSessionId);
  if (!s || s.sandboxed || !s.agentControlConsented || s.controller !== "agent") {
    setPendingAgentHandoffSessionId(null);
    return null;
  }
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    sandboxed: s.sandboxed,
    controller: s.controller,
    requested: s.requested,
    agentControlConsented: s.agentControlConsented,
  };
}

/** The Human-selected PTY that remains Genie's default while Genie controls it. */
export function peekBoundAgentTerminalSession(): TerminalSessionInfo | null {
  if (boundAgentTerminalSessionId === null) return null;
  const s = sessions.get(boundAgentTerminalSessionId);
  if (!s || s.sandboxed || !s.agentControlConsented || s.controller !== "agent") {
    boundAgentTerminalSessionId = null;
    return null;
  }
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    sandboxed: s.sandboxed,
    controller: s.controller,
    requested: s.requested,
    agentControlConsented: s.agentControlConsented,
  };
}

export function consumeAgentHandoffSession(): TerminalSessionInfo | null {
  const info = peekAgentHandoffSession();
  if (info !== null) setPendingAgentHandoffSessionId(null);
  return info;
}

export function acknowledgeAgentHandoffSession(id: string): void {
  if (pendingAgentHandoffSessionId === id) setPendingAgentHandoffSessionId(null);
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

export function killSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  if (s.flushTimer !== null) clearTimeout(s.flushTimer);
  try {
    s.pty.kill();
  } catch {
    /* already dead */
  }
  sessions.delete(id);
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

/**
 * Poll read for the agent (P2): return new output produced after `cursor`
 * and the next cursor. If `cursor` predates the retained scrollback (head
 * evicted under the cap), `truncated` flags the gap and we return the whole
 * buffer. First read: pass cursor 0.
 */
export function readTerminalSince(
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
}

export function registerTerminalHost(deps: TerminalHostDeps): void {
  const { ipcMain, assertSender } = deps;
  getWebContents = deps.getWebContents;
  publishAgentHandoffChanged = deps.onAgentHandoffChanged ?? null;

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

  // D438 — the explicit grant IPC, distinct from the generic
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
  setPendingAgentHandoffSessionId(null);
  boundAgentTerminalSessionId = null;
  publishAgentHandoffChanged = null;
}
