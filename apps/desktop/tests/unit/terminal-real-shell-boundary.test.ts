/**
 * D438 — terminal co-driving consent state machine.
 *
 * terminal-host imports a native node-pty binding lazily, so loading the
 * Electron runtime in bun:test is not viable. These structural tests pin the
 * OBSERVABLE state-machine contracts by slicing the source of
 * `electron/terminal-host.ts` (and the bridge/relay mirrors) — they assert on
 * the code that defines behavior, not on comments alone. If a future edit
 * regresses the consent model, one of these slices flips red.
 *
 * Contracts pinned:
 *  - `WriteResult` has no `non-grantable` member (every live PTY is grantable).
 *  - Both origins birth `agentControlConsented: false`; sandboxed PTYs still
 *    birth `controller: "agent"`, user PTYs birth `controller: "user"`.
 *  - An agent write against a user-controlled PTY raises at most one standing
 *    request and returns `locked` (no `non-grantable` short-circuit).
 *  - Generic `setController("agent")` may consume consent but never mints it:
 *    it refuses unsandboxed AND unconsented sessions, and user retake does not
 *    clear consent.
 *  - `grantAgentControl` is the single consent-minting op: records consent,
 *    transfers to agent, emits controller, clears the request, returns false
 *    only for a missing session.
 *  - A distinct, active-sender-validated `terminal:grant-agent-control` IPC is
 *    registered separately from `terminal:set-controller`.
 *  - list/attach expose `agentControlConsented`.
 *  - The sandboxed-birth environment contract (D373) is preserved.
 *  - The relay no longer branches on `non-grantable`; the Workbench + preload
 *    mirrors expose the consent field and the grant method.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");
const terminalHost = readFileSync(join(desktopRoot, "electron/terminal-host.ts"), "utf-8");
const desktopMain = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
const preload = readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8");
const relay = readFileSync(join(desktopRoot, "electron/relay.ts"), "utf-8");
const terminalDispatch = readFileSync(
  join(desktopRoot, "electron/relay-dispatch/terminal.ts"),
  "utf-8",
);
const terminalTool = readFileSync(
  join(desktopRoot, "../../packages/agent/src/tools/terminal/terminal.ts"),
  "utf-8",
);
const terminalSkill = readFileSync(
  join(desktopRoot, "../../packages/agent/src/skills/bundled/terminal-sessions.md"),
  "utf-8",
);
const desktopLib = readFileSync(
  join(desktopRoot, "../workbench/src/lib/desktop.ts"),
  "utf-8",
);

/** Slice the body of a top-level function/declaration by its signature line. */
function sliceFrom(src: string, signature: string, endMarker: string): string {
  const start = src.indexOf(signature);
  expect(start, `signature not found: ${signature}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end, `end marker not found after signature: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("terminal real-shell authority boundary", () => {
  test("sandboxed sessions pass Sandbox.wrap's constructed environment to node-pty", () => {
    const fn = sliceFrom(
      terminalHost,
      "export function spawnSession(args: TerminalCreateArgs = {}): TerminalSessionInfo",
      "\n}\n\nexport function writeSession",
    );

    const sandboxStart = fn.indexOf("if (args.sandbox !== undefined)");
    expect(sandboxStart).toBeGreaterThan(-1);
    const sandbox = fn.slice(sandboxStart);

    expect(sandbox).toContain("env = wrapped.env");
    expect(sandbox).not.toContain("env = process.env");
    expect(fn).toContain("...(env !== null ? { env } : {})");
  });

  test("WriteResult has no non-grantable member — every live PTY is grantable", () => {
    const slice = sliceFrom(
      terminalHost,
      "export type WriteResult =",
      "\n\ninterface Session",
    );
    expect(slice).toContain('{ ok: true }');
    expect(slice).toContain('"no-session" | "locked"');
    expect(slice).not.toContain("non-grantable");
    // Whole-file guard: the temp branch must be gone everywhere in the host.
    expect(terminalHost).not.toContain("non-grantable");
    expect(relay).not.toContain("non-grantable");
    expect(preload).not.toContain("non-grantable");
    expect(desktopLib).not.toContain("non-grantable");
  });

  test("both origins birth agentControlConsented:false; sandboxed->agent, user->user", () => {
    const fn = sliceFrom(
      terminalHost,
      "export function spawnSession(args: TerminalCreateArgs = {}): TerminalSessionInfo",
      "\n}\n\nexport function writeSession",
    );
    // Birth controller depends on sandboxed flag.
    expect(fn).toContain('const controller: Controller = sandboxed ? "agent" : "user";');
    // Session record carries the consent field, initialized false.
    expect(fn).toContain("agentControlConsented: false,");
    // Returned info exposes the consent field, initialized false.
    expect(fn).toMatch(/return \{[^}]*agentControlConsented: false[^}]*\};/s);
  });

  test("agent write against a user-controlled PTY raises one request and returns locked", () => {
    const fn = sliceFrom(
      terminalHost,
      "export function writeSession(id: string, data: string, by: Controller = \"user\"): WriteResult",
      "\n}\n\n/**\n * Transfer the input lock",
    );
    // No non-grantable short-circuit on unsandboxed sessions.
    expect(fn).not.toContain("non-grantable");
    expect(fn).not.toMatch(/by === "agent" && !s\.sandboxed/);
    // The refused agent write raises at most one standing request (guarded by !s.requested).
    expect(fn).toContain('if (by === "agent" && !s.requested)');
    expect(fn).toContain("s.requested = true;");
    expect(fn).toContain('"terminal:request"');
    // And returns locked (not some impossible-to-grant reason).
    expect(fn).toContain('return { ok: false, reason: "locked" };');
  });

  test("generic setController consumes consent but cannot mint it; retake keeps consent", () => {
    const fn = sliceFrom(
      terminalHost,
      "function setController(id: string, controller: Controller): boolean",
      "\n}\n\n/**\n * D438 — the explicit, active-sender-validated grant operation",
    );
    // Refuses agent transfer only when BOTH unsandboxed AND unconsented.
    expect(fn).toContain('if (controller === "agent" && !s.sandboxed && !s.agentControlConsented) return false;');
    // Emits the authoritative controller event on any accepted transfer.
    expect(fn).toContain('"terminal:controller"');
    // Resolves a standing request on transfer.
    expect(fn).toContain("s.requested = false;");
    // Must NOT clear consent on retake (consent survives for the PTY lifetime).
    expect(fn).not.toContain("s.agentControlConsented = false");
  });

  test("grantAgentControl is the single consent-minting atomic op; false only for missing session", () => {
    const fn = sliceFrom(
      terminalHost,
      "function grantAgentControl(id: string): boolean",
      "\n}\n\n/** Current lock state for a session",
    );
    // Missing session -> false (and that is the ONLY false return).
    expect(fn).toContain("if (!s) return false;");
    expect((fn.match(/return false/g) ?? []).length).toBe(1);
    // Records consent.
    expect(fn).toContain("s.agentControlConsented = true;");
    // Transfers to agent.
    expect(fn).toContain('s.controller = "agent";');
    // The exact user-created PTY becomes both the notification and durable default.
    expect(fn).toContain("boundAgentTerminalSessionId = id;");
    expect(fn).toContain("setPendingAgentHandoffSessionId(id);");
    // Emits authoritative controller event.
    expect(fn).toContain('"terminal:controller"');
    // Clears / emits the standing request.
    expect(fn).toContain("s.requested = false;");
    expect(fn).toContain('"terminal:request"');
    // Returns true on success.
    expect(fn).toContain("return true;");
  });

  test("the next useful agent terminal action binds the exact Human handoff without listing", () => {
    expect(terminalHost).toContain("export function peekAgentHandoffSession()");
    expect(terminalHost).toContain("export function consumeAgentHandoffSession()");
    expect(terminalHost).toContain("export function acknowledgeAgentHandoffSession(id: string)");

    expect(relay).toContain("const terminalDecision = await terminal({");
    const spawnCase = terminalDispatch.slice(
      terminalDispatch.indexOf('case "spawn": {'),
      terminalDispatch.indexOf('case "write": {'),
    );
    expect(spawnCase).toContain("const handedOver = deps.consumeAgentHandoffSession();");
    expect(spawnCase.indexOf("deps.consumeAgentHandoffSession()")).toBeLessThan(
      spawnCase.indexOf("deps.spawnSession({"),
    );
    expect(spawnCase).toContain("session_id: handedOver.id");
    expect(spawnCase).toContain("reused_handoff: true");

    const directBinding = terminalDispatch.slice(
      terminalDispatch.indexOf('if (input.request.toolName !== "terminal")'),
      terminalDispatch.indexOf("// Agent write that respects"),
    );
    expect(directBinding).toContain('const acceptsDirectHandoff = action === "run" || action === "read" || action === "write"');
    expect(directBinding).toContain("const directHandoff = requestedSessionId === \"\" && acceptsDirectHandoff");
    expect(directBinding).toContain("deps.peekBoundAgentTerminalSession()");
    expect(directBinding).toContain("const sessionId = requestedSessionId || directHandoff?.id || \"\"");
    expect(directBinding).toContain("session_id: directHandoff.id");
    expect(directBinding).toContain("reused_handoff: true");

    const listCase = terminalDispatch.slice(
      terminalDispatch.indexOf('case "list": {'),
      terminalDispatch.indexOf("default:", terminalDispatch.indexOf('case "list": {')),
    );
    expect(listCase).toContain("deps.peekAgentHandoffSession()");
    expect(listCase).toContain("preferred_for_agent");
  });

  test("terminal guidance directly uses a handed-over PTY without activation or listing", () => {
    expect(terminalTool).toContain("making list/discover/activate/spawn unnecessary");
    expect(terminalTool).toContain("every `run`, `read`, or `write`");
    expect(terminalTool).toContain("`reused_handoff:true`");
    expect(terminalSkill).toContain("start directly with `run`, `read`, or `write`");
    expect(terminalSkill).toContain("may remain omitted while Genie controls that PTY");
  });

  test("the handed-over PTY remains the session-less default until retake or exit", () => {
    expect(terminalHost).toContain("export function peekBoundAgentTerminalSession()");
    expect(terminalHost).toContain("let boundAgentTerminalSessionId: string | null = null;");
    const setControllerFn = sliceFrom(
      terminalHost,
      "function setController(id: string, controller: Controller): boolean",
      "\n}\n\n/**\n * D438 — the explicit, active-sender-validated grant operation",
    );
    expect(setControllerFn).toContain("boundAgentTerminalSessionId = id;");
    expect(setControllerFn).toContain("if (boundAgentTerminalSessionId === id) boundAgentTerminalSessionId = null;");
    expect(terminalHost).toContain("if (boundAgentTerminalSessionId === id) boundAgentTerminalSessionId = null;");
  });

  test("Let Genie drive publishes handoff availability before its IPC resolves", () => {
    expect(terminalHost).toContain("readonly onAgentHandoffChanged?:");
    expect(terminalHost).toContain("await waitForAgentHandoffPublication();");
    expect(desktopMain).toContain('refreshDesktopRelayCapabilities("terminal handoff changed")');
    expect(relay).toContain("hasPendingTerminalHandoff: true");
    expect(relay).not.toContain("TERMINAL_HANDOFF_PENDING");
  });

  test("a distinct active-sender-validated grant IPC is registered separately from set-controller", () => {
    // Generic controller IPC remains.
    expect(terminalHost).toContain('"terminal:set-controller"');
    // Distinct grant IPC exists and is asserted against the active sender.
    expect(terminalHost).toContain('"terminal:grant-agent-control"');
    const grantIpc = terminalHost.slice(
      terminalHost.indexOf('"terminal:grant-agent-control"'),
      terminalHost.indexOf('"terminal:grant-agent-control"') + 400,
    );
    expect(grantIpc).toContain("assertSender(e)");
    expect(grantIpc).toContain("grantAgentControl(args.sessionId)");
    // The generic set-controller handler must NOT call grantAgentControl.
    const setControllerIpc = terminalHost.slice(
      terminalHost.indexOf('"terminal:set-controller"'),
      terminalHost.indexOf('"terminal:grant-agent-control"'),
    );
    expect(setControllerIpc).not.toContain("grantAgentControl");
  });

  test("list/attach expose agentControlConsented", () => {
    const listFn = sliceFrom(
      terminalHost,
      "export function listSessions(): TerminalSessionInfo[]",
      "\n}\n\nfunction attachSession",
    );
    expect(listFn).toContain("agentControlConsented: s.agentControlConsented");

    const attachFn = sliceFrom(
      terminalHost,
      "function attachSession(",
      "\n}\n\n/**\n * Poll read for the agent",
    );
    expect(attachFn).toContain("agentControlConsented: s.agentControlConsented");
  });

  test("TerminalSessionInfo interface carries agentControlConsented", () => {
    const iface = sliceFrom(
      terminalHost,
      "export interface TerminalSessionInfo",
      "\n}\n\n/** Result of a write",
    );
    expect(iface).toContain("agentControlConsented: boolean;");
  });

  test("relay restores one shared locked-write wait path with truthful outcomes", () => {
    // The relay's agent-write helper must not branch on non-grantable.
    expect(relay).not.toContain('"non-grantable"');
    expect(relay).not.toContain("non-grantable");
    // It still enters the bounded grant-poll loop on a locked write.
    const waitStart = terminalDispatch.indexOf("const writeAgentWaiting = async");
    expect(waitStart).toBeGreaterThan(-1);
    const wait = terminalDispatch.slice(waitStart, terminalDispatch.indexOf("const cleanTerminalToolOutput", waitStart));
    expect(wait).toContain("deps.writeSession(sessionId, payload, \"agent\")");
    expect(wait).toContain("grantDeadline");
    expect(wait).toContain("deps.getSessionControl(sessionId)");
    // Approval retries the exact pending payload once.
    expect(wait).toContain('const retry = deps.writeSession(sessionId, payload, "agent")');
    // Denial (request cleared without grant) returns a truthful declined result.
    expect(wait).toContain("the user declined the control request");
    // No-session and timeout remain truthful.
    expect(wait).toContain("no live session");
    expect(wait).toContain("still under user control after waiting ~2m");
  });

  test("Workbench + preload mirrors expose consent field and grant method", () => {
    // Preload mirror.
    const preloadTerm = preload.slice(preload.indexOf("type TerminalSessionInfo"));
    expect(preloadTerm).toContain("agentControlConsented: boolean;");
    expect(preload).toContain("grantAgentControl:");
    expect(preload).toContain('"terminal:grant-agent-control"');

    // Workbench DesktopTerminalAPI mirror.
    expect(desktopLib).toContain("agentControlConsented: boolean;");
    expect(desktopLib).toContain("grantAgentControl: (sessionId: string) => Promise<boolean>;");
    expect(desktopLib).toContain("TerminalWriteResult");
    expect(desktopLib).not.toContain("non-grantable");
  });

  test("renderer-created sessions remain explicitly unsandboxed", () => {
    const ipcStart = terminalHost.indexOf('ipcMain.handle(\n    "terminal:create"');
    expect(ipcStart).toBeGreaterThan(-1);
    const ipcEnd = terminalHost.indexOf(
      '\n    },\n  );\n\n  ipcMain.handle(\n    "terminal:attach"',
      ipcStart,
    );
    expect(ipcEnd).toBeGreaterThan(ipcStart);

    const ipc = terminalHost.slice(ipcStart, ipcEnd);
    expect(ipc).toContain("Renderer never spawns sandboxed sessions");
    expect(ipc).not.toContain("sandbox:");
  });
});
