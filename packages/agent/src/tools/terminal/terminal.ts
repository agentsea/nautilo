import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * D373 / Stack 137 — agent `terminal` tool (P2.1b).
 *
 * An interactive, persistent PTY the agent shares with the user (same
 * main-process session pool as the workbench terminal surface). Unlike
 * `run_shell` (one-shot, observable, prove_it-gated), `terminal` is a
 * stream driven by discrete actions over the one-shot relay protocol via
 * a POLL read model ("read bytes"):
 *
 *   spawn → returns a session_id (+ cursor 0). Agent sessions are
 *           sandbox-wrapped on the relay (contained shell).
 *   run   → execute command text: single-line commands get one Enter (CR);
 *           multi-line bodies are visibly heredoc-wrapped by the relay so they
 *           execute as one bash script in the shared terminal. RECOMMENDED for
 *           running commands — the model never encodes a submit newline.
 *   write → send RAW keystrokes/bytes, no Enter added (control chars like
 *           Ctrl-C, answering a prompt, feeding a TUI, partial input).
 *   read  → return new output since `cursor` (+ next cursor). The relay
 *           settles briefly so a command's output is captured.
 *   list  → live sessions (id/title/cwd/sandboxed).
 *   kill  → end a session.
 *
 * Trust (D373 operator decision): capability-gated **allow**, NOT
 * prove_it/PIN — gated on the `use_workstation` capability and only offered
 * when a PTY-capable desktop relay is
 * connected. Executes on the desktop relay; the func here rejects
 * because relay tools never run in the cloud graph.
 */
export function createTerminalTool() {
  return new DynamicStructuredTool({
    name: "terminal",
    description:
      "Drive a persistent, interactive terminal shared with the user — a SEPARATE PTY " +
      "path from run_shell; a working terminal session is NOT evidence that the " +
      "profile-bound run_shell mount/binding works. Actions: " +
      "When the user explicitly selects 'Let Genie drive', every `run`, `read`, or `write` may " +
      "omit session_id while agent control remains active: Desktop binds it to that exact terminal and " +
      "returns session_id for follow-up calls, making list/discover/activate/spawn unnecessary. " +
      "Use `list` only when the user refers ambiguously to an existing terminal without an active handoff. " +
      "`spawn` (start a shell, returns session_id + cursor; pass `cwd` to start in the " +
      "selected Current Folder — a spawned session otherwise defaults to the dispatch " +
      "sandbox workspace; if an exact Human handoff is pending, spawn safely reuses that " +
      "existing session and returns `reused_handoff:true` instead of creating another PTY; " +
      "known host paths outside the Current Folder are not automatically visible), " +
      "`run` (execute command text and return its output — RECOMMENDED for running commands: pass ONLY " +
      "the command/script text, e.g. data:\"ls -la\", and do NOT add a submit newline. Single-line " +
      "commands get one Enter; multi-line bodies are visibly heredoc-wrapped and run as one bash script " +
      "in the shared terminal, so script-local cd/export state does not persist after the body), " +
      "`write` (send RAW keystrokes/bytes as-is, WITHOUT pressing Enter — for control chars like Ctrl-C, " +
      "answering a prompt, or feeding a TUI), " +
      "`read` (get new output since the cursor returned by the previous spawn/read/run), " +
      "`list` (live sessions, including `preferred_for_agent` for the exact pending Human handoff — " +
      "also use after spawn to confirm the session is still alive; a spawned PTY " +
      "may exit immediately, so do not assume the returned session_id remains live), `kill` (end a session). " +
      "Prefer `run` for one-shot commands; use write+read for interactive/streaming. " +
      "Prefer this over run_shell for long-running or interactive processes (dev servers, REPLs, TUIs). " +
      "Typical new-session loop: spawn → run \"cmd\" → run \"next cmd\". " +
      "Explicit handoff loop: run/read/write without session_id → reuse returned session_id.",
    schema: z.object({
      action: z
        .enum(["spawn", "run", "write", "read", "list", "kill"])
        .describe("The terminal operation to perform."),
      session_id: z
        .string()
        .optional()
        .describe(
          "Target session id. May be omitted for run/write/read while an explicit Let Genie drive " +
            "binding remains under agent control. Required for kill and otherwise.",
        ),
      data: z
        .string()
        .optional()
        .describe(
          "For `run`: command/script text ONLY — do NOT add a trailing submit newline. " +
            "Single-line runs get Enter; multi-line runs are heredoc-wrapped and execute as one bash script. " +
            "For `write`: raw bytes sent as-is, no Enter added.",
        ),
      cursor: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("For `read`: the cursor from the previous spawn/read (0 to read from the start)."),
      cwd: z
        .string()
        .optional()
        .describe("For `spawn`: working directory (defaults to the workspace / home)."),
    }),
    func: () => {
      return Promise.reject(
        new Error(
          "terminal is a relay tool — execution goes through the relay protocol, not direct invocation. " +
            "If you see this error, the tool routing in toolsNode is broken.",
        ),
      );
    },
  });
}
