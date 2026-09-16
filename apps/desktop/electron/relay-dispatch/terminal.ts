import { randomBytes } from "node:crypto";

import type { RelayDispatchRequest, RelayDispatchResult } from "@nautilo/relay";
import type { Sandbox } from "@nautilo/sandbox";

import type { TerminalSessionInfo } from "../terminal-host.ts";
import type { resolveTerminalSpawnCwd } from "../terminal-spawn-cwd.ts";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type DesktopDispatchDecision,
} from "./router.ts";

export interface TerminalDispatchDeps {
  readonly spawnSession: typeof import("../terminal-host.ts").spawnSession;
  readonly writeSession: typeof import("../terminal-host.ts").writeSession;
  readonly readTerminalSince: typeof import("../terminal-host.ts").readTerminalSince;
  readonly getSessionControl: typeof import("../terminal-host.ts").getSessionControl;
  readonly killSession: typeof import("../terminal-host.ts").killSession;
  readonly listSessions: typeof import("../terminal-host.ts").listSessions;
  readonly peekAgentHandoffSession: typeof import("../terminal-host.ts").peekAgentHandoffSession;
  readonly peekBoundAgentTerminalSession: typeof import("../terminal-host.ts").peekBoundAgentTerminalSession;
  readonly consumeAgentHandoffSession: typeof import("../terminal-host.ts").consumeAgentHandoffSession;
  readonly acknowledgeAgentHandoffSession: typeof import("../terminal-host.ts").acknowledgeAgentHandoffSession;
  readonly resolveTerminalSpawnCwd: typeof resolveTerminalSpawnCwd;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly randomBytes?: (size: number) => { toString(encoding: "hex"): string };
}

/** Fixed terminal lane; terminal-host remains the sole PTY/session owner. */
export function createTerminalDispatchHandler(dependencies: TerminalDispatchDeps): (input: {
  readonly request: RelayDispatchRequest;
  readonly guardRoots: readonly string[];
  readonly sandboxEnvelopeWorkspace: string | undefined;
  readonly sandbox: Sandbox | null;
}) => Promise<DesktopDispatchDecision> {
  const deps = {
    ...dependencies,
    now: dependencies.now ?? Date.now,
    sleep: dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    randomBytes: dependencies.randomBytes ?? randomBytes,
  };
  return async function dispatchTerminal(input): Promise<DesktopDispatchDecision> {
    if (input.request.toolName !== "terminal") return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
    // D373 P2.1b — agent drives the shared PTY pool (terminal-host, same
    // main process). Agent-spawned sessions are sandbox-wrapped via the
    // relay's per-turn Sandbox (the 0.6-verified Gap-1 path); user
    // sessions (from the renderer) stay the real shell.
    const action = typeof input.request.args["action"] === "string" ? input.request.args["action"] : "";
    const requestedSessionId =
      typeof input.request.args["session_id"] === "string" ? input.request.args["session_id"] : "";
    // Let Genie drive identifies one exact local PTY. Keep that id off
    // the relay capability wire, but let the first useful terminal
    // operation omit it so the model does not need a list round-trip.
    const acceptsDirectHandoff = action === "run" || action === "read" || action === "write";
    const directHandoff = requestedSessionId === "" && acceptsDirectHandoff
      ? deps.peekBoundAgentTerminalSession()
      : null;
    const sessionId = requestedSessionId || directHandoff?.id || "";
    const directHandoffResult = directHandoff === null
      ? {}
      : { session_id: directHandoff.id, reused_handoff: true };

    // Agent write that respects the P2.2b lock: on a locked session it
    // raises the request banner and waits (bounded) for the user's grant,
    // so "Let me drive" directly unblocks the call. Shared by write+run.
    const writeAgentWaiting = async (
      payload: string,
    ): Promise<{ ok: true; granted: boolean } | { ok: false; error: string }> => {
      const first = deps.writeSession(sessionId, payload, "agent");
      if (first.ok) {
        deps.acknowledgeAgentHandoffSession(sessionId);
        return { ok: true, granted: false };
      }
      if (first.reason === "no-session")
        return { ok: false, error: `terminal: no live session ${sessionId}` };
      // D438 — `locked` is the only remaining refusal. The host has
      // already raised at most one standing `terminal:request` for this
      // PTY; enter the single shared bounded wait. Approval arrives via
      // the user's explicit `grantAgentControl` (or a consented
      // `setController("agent")`), which flips `controller="agent"` and
      // clears the request; we then retry the EXACT pending payload once.
      // Denial (request cleared without a grant), session exit, and the
      // ~2m timeout each return their truthful result — no impossible
      // wait, because every live PTY is grantable through consent.
      const grantDeadline = deps.now() + 120_000;
      for (;;) {
        if (deps.now() >= grantDeadline)
          return {
            ok: false,
            error: `terminal: still under user control after waiting ~2m. The request is still showing to the user — ask them to approve, then try again.`,
          };
        await deps.sleep(300);
        const st = deps.getSessionControl(sessionId);
        if (!st) return { ok: false, error: `terminal: no live session ${sessionId}` };
        if (st.controller === "agent") {
          const retry = deps.writeSession(sessionId, payload, "agent");
          if (retry.ok) {
            deps.acknowledgeAgentHandoffSession(sessionId);
            return { ok: true, granted: true };
          }
          if (retry.reason === "no-session")
            return { ok: false, error: `terminal: no live session ${sessionId}` };
          continue; // user re-took control in the race window; keep waiting
        }
        if (!st.requested)
          return {
            ok: false,
            error: `terminal: the user declined the control request. Ask them before trying again.`,
          };
      }
    };

    const cleanTerminalToolOutput = (value: string): string => {
      // xterm needs raw PTY bytes, but the model-facing tool result should
      // not include readline/display control sequences such as CSI cursor
      // moves (`ESC [ A`, `ESC [ C`, `ESC [ K`) emitted while bash redraws
      // long heredoc lines. Keep printable text plus newlines/tabs.
      return value
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B[@-Z\\-_]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    };

    // Settle-read: poll new output until it quiets (2 stable polls after
    // some arrived) or a ~2.5s ceiling. Shared by read+run.
    const settleRead = async (
      startCursor: number,
    ): Promise<{ data: string; cursor: number } | null> => {
      let cursor = startCursor;
      const deadline = deps.now() + 2500;
      let acc = "";
      let lastLen = -1;
      let stable = 0;
      for (;;) {
        const r = deps.readTerminalSince(sessionId, cursor);
        if (!r.ok) return null;
        if (r.data.length > 0) {
          acc += r.data;
          cursor = r.cursor;
        }
        if (acc.length === lastLen) {
          stable += 1;
          if (acc.length > 0 && stable >= 2) break;
        } else {
          lastLen = acc.length;
          stable = 0;
        }
        if (deps.now() >= deadline) break;
        await deps.sleep(150);
      }
      return { data: cleanTerminalToolOutput(acc), cursor };
    };

    const buildTerminalRunPayload = (raw: string): string => {
      const withoutTrailingSubmit = raw.replace(/(?:\r\n|\r|\n|\\r|\\n)+$/, "");
      // Multi-line input cannot be sent to a canonical-mode PTY atomically:
      // each LF submits one prompt line. Wrap it as a visible heredoc so the
      // outer shell collects the body first, then runs it as one bash script.
      // This preserves the shared-terminal audit trail without relying on
      // bracketed paste (not safe for macOS bash 3.2).
      if (!/[\r\n]/.test(withoutTrailingSubmit)) return withoutTrailingSubmit + "\r";
      const body = withoutTrailingSubmit.replace(/\r\n?/g, "\n");
      let marker = "";
      do {
        marker = `NAUTILO_TERMINAL_${deps.randomBytes(6).toString("hex")}`;
      } while (body.split("\n").some((line) => line === marker));
      return `bash <<'${marker}'\n${body}\n${marker}\r`;
    };

    const result: RelayDispatchResult = await (async () => {
      switch (action) {
      case "spawn": {
        // A Human's explicit "Let Genie drive" handoff is stronger and
        // more specific than the model's generic request to spawn. Bind
        // the next spawn attempt to that exact existing real PTY instead
        // of opening a confusing second sandboxed terminal.
        const handedOver = deps.consumeAgentHandoffSession();
        if (handedOver !== null) {
          return {
            status: "ok",
            result: {
              session_id: handedOver.id,
              cursor: 0,
              title: handedOver.title,
              cwd: handedOver.cwd,
              sandboxed: handedOver.sandboxed,
              reused_handoff: true,
            },
          };
        }
        const cwd = deps.resolveTerminalSpawnCwd({
          requestedCwd: input.request.args["cwd"],
          sandboxWorkspace: input.sandboxEnvelopeWorkspace,
          fallbackWorkspace: input.guardRoots[0],
        });
        if (!cwd.ok) {
          return {
            status: "error",
            errorCode: "TERMINAL_CWD_OUTSIDE_SANDBOX",
            error: cwd.error,
          };
        }
        let info: TerminalSessionInfo;
        try {
          info = deps.spawnSession({
            ...(input.sandbox !== null ? { sandbox: input.sandbox } : {}),
            cwd: cwd.cwd,
          });
        } catch (err) {
          return {
            status: "error",
            errorCode: "TERMINAL_SPAWN_FAILED",
            error: `terminal spawn failed before a session was created: ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
        return {
          status: "ok",
          result: {
            session_id: info.id,
            cursor: 0,
            title: info.title,
            cwd: info.cwd,
            sandboxed: info.sandboxed,
          },
        };
      }
      case "write": {
        const data = typeof input.request.args["data"] === "string" ? input.request.args["data"] : "";
        if (!sessionId) return { status: "error", error: "terminal write: session_id required unless a handed-over terminal remains under agent control" };
        const w = await writeAgentWaiting(data);
        if (!w.ok) return { status: "error", error: w.error };
        return {
          status: "ok",
          result: { ok: true, ...directHandoffResult, ...(w.granted ? { granted: true } : {}) },
        };
      }
      case "run": {
        // Newline-safe command execution. The model passes ONLY the command
        // text; we press Enter (CR) for it and settle-read the output in one
        // call. Single-line commands get one CR. Multi-line bodies are
        // heredoc-wrapped so the visible shell collects them before executing
        // as one bash script (rather than submitting line-by-line).
        const raw = typeof input.request.args["data"] === "string" ? input.request.args["data"] : "";
        if (!sessionId) return { status: "error", error: "terminal run: session_id required unless a handed-over terminal remains under agent control" };
        const cmd = buildTerminalRunPayload(raw);
        const before = deps.readTerminalSince(sessionId, Number.MAX_SAFE_INTEGER);
        if (!before.ok) return { status: "error", error: `terminal: no live session ${sessionId}` };
        const w = await writeAgentWaiting(cmd);
        if (!w.ok) return { status: "error", error: w.error };
        const out = await settleRead(before.cursor);
        if (!out) return { status: "error", error: `terminal: no live session ${sessionId}` };
        return {
          status: "ok",
          result: {
            data: out.data,
            cursor: out.cursor,
            ...directHandoffResult,
            ...(w.granted ? { granted: true } : {}),
          },
        };
      }
      case "read": {
        if (!sessionId) return { status: "error", error: "terminal read: session_id required unless a handed-over terminal remains under agent control" };
        const startCursor = Number.isFinite(Number(input.request.args["cursor"]))
          ? Number(input.request.args["cursor"])
          : 0;
        const out = await settleRead(startCursor);
        if (!out) return { status: "error", error: `terminal: no live session ${sessionId}` };
        deps.acknowledgeAgentHandoffSession(sessionId);
        return {
          status: "ok",
          result: { data: out.data, cursor: out.cursor, ...directHandoffResult },
        };
      }
      case "kill": {
        if (!sessionId) return { status: "error", error: "terminal kill: session_id required" };
        deps.killSession(sessionId);
        return { status: "ok", result: { ok: true } };
      }
      case "list": {
        const pendingHandoff = deps.peekAgentHandoffSession();
        return {
          status: "ok",
          result: {
            sessions: deps.listSessions().map((session) => ({
              ...session,
              preferred_for_agent: session.id === pendingHandoff?.id,
            })),
          },
        };
      }
        default:
          return { status: "error", error: `terminal: unknown action "${action}"` };
      }
    })();
    return { handled: true, result };
  };
}
