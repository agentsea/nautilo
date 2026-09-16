import { describe, expect, test } from "bun:test";
import type { RelayDispatchRequest } from "@nautilo/relay";

import { createTerminalDispatchHandler } from "../../electron/relay-dispatch/terminal.ts";
import { FIXED_DESKTOP_DISPATCH_NOT_HANDLED } from "../../electron/relay-dispatch/router.ts";

function request(args: Record<string, unknown>, toolName = "terminal"): RelayDispatchRequest {
  return { correlationId: "terminal", toolName, args, impact: "read-only", approvalObtained: true };
}

function handler(overrides: Partial<Parameters<typeof createTerminalDispatchHandler>[0]> = {}) {
  return createTerminalDispatchHandler({
    spawnSession: () => ({ id: "new", title: "shell", cwd: "/tmp", sandboxed: false, controller: "agent", requested: false, agentControlConsented: false }),
    writeSession: () => ({ ok: true }),
    readTerminalSince: () => ({ ok: true, data: "", cursor: 1, truncated: false }),
    getSessionControl: () => ({ controller: "agent", requested: false }),
    killSession: () => undefined,
    listSessions: () => [],
    peekAgentHandoffSession: () => null,
    peekBoundAgentTerminalSession: () => null,
    consumeAgentHandoffSession: () => null,
    acknowledgeAgentHandoffSession: () => undefined,
    resolveTerminalSpawnCwd: () => ({ ok: true, cwd: "/tmp" }),
    now: () => 0,
    sleep: async () => undefined,
    randomBytes: () => ({ toString: () => "fixed" }),
    ...overrides,
  });
}

describe("createTerminalDispatchHandler", () => {
  test("returns the canonical singleton for non-terminal requests", async () => {
    expect(await handler()({ request: request({}, "other"), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null }))
      .toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
  });

  test("reuses the exact handed-over PTY before spawning", async () => {
    let spawns = 0;
    const dispatch = handler({
      consumeAgentHandoffSession: () => ({ id: "handoff", title: "Human shell", cwd: "/tmp/h", sandboxed: false, controller: "agent", requested: false, agentControlConsented: true }),
      spawnSession: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
    });
    expect(await dispatch({ request: request({ action: "spawn" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null }))
      .toEqual({ handled: true, result: { status: "ok", result: { session_id: "handoff", cursor: 0, title: "Human shell", cwd: "/tmp/h", sandboxed: false, reused_handoff: true } } });
    expect(spawns).toBe(0);
  });

  test("uses a bound handoff for run and keeps multiline input in one heredoc payload", async () => {
    const writes: string[] = [];
    let reads = 0;
    const dispatch = handler({
      peekBoundAgentTerminalSession: () => ({ id: "bound", title: "shell", cwd: "/tmp", sandboxed: false, controller: "agent", requested: false, agentControlConsented: true }),
      writeSession: (_id, data) => {
        writes.push(data);
        return { ok: true };
      },
      readTerminalSince: () => ({ ok: true, data: reads++ === 1 ? "done\r\n" : "", cursor: reads, truncated: false }),
    });
    const result = await dispatch({ request: request({ action: "run", data: "echo one\necho two" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null });
    expect(result).toMatchObject({ handled: true, result: { status: "ok", result: { reused_handoff: true, data: "done\n" } } });
    expect(writes[0]).toContain("bash <<'NAUTILO_TERMINAL_fixed'");
  });

  test("preserves spawn, lock denial, read, kill, list, and unknown-action results", async () => {
    const killed: string[] = [];
    const dispatch = handler({
      killSession: (id) => { killed.push(id); },
      listSessions: () => [{ id: "one", title: "shell", cwd: "/tmp", sandboxed: true, controller: "agent", requested: false, agentControlConsented: false }],
    });
    expect(await dispatch({ request: request({ action: "spawn" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: "/tmp", sandbox: null })).toMatchObject({ handled: true, result: { status: "ok", result: { session_id: "new" } } });
    expect(await dispatch({ request: request({ action: "kill", session_id: "one" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null })).toEqual({ handled: true, result: { status: "ok", result: { ok: true } } });
    expect(killed).toEqual(["one"]);
    expect(await dispatch({ request: request({ action: "list" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null })).toMatchObject({ handled: true, result: { result: { sessions: [{ preferred_for_agent: false }] } } });
    expect(await dispatch({ request: request({ action: "bad" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null })).toEqual({ handled: true, result: { status: "error", error: 'terminal: unknown action "bad"' } });
  });

  test("retries the exact locked write/run payload after one 300ms grant poll", async () => {
    const writes: string[] = [];
    const sleeps: number[] = [];
    let controls = 0;
    const dispatch = handler({
      writeSession: (_id, data) => {
        writes.push(data);
        return writes.length === 1 ? { ok: false as const, reason: "locked" as const } : { ok: true as const };
      },
      getSessionControl: () => controls++ === 0 ? { controller: "agent" as const, requested: false } : null,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      readTerminalSince: () => ({ ok: true as const, data: "", cursor: 1, truncated: false }),
    });
    const write = await dispatch({ request: request({ action: "write", session_id: "locked", data: "exact payload" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null });
    expect(write).toEqual({ handled: true, result: { status: "ok", result: { ok: true, granted: true } } });
    expect(writes).toEqual(["exact payload", "exact payload"]);
    expect(sleeps).toEqual([300]);

    const runWrites: string[] = [];
    let runReads = 0;
    const run = handler({
      writeSession: (_id, data) => {
        runWrites.push(data);
        return runWrites.length === 1 ? { ok: false as const, reason: "locked" as const } : { ok: true as const };
      },
      getSessionControl: () => ({ controller: "agent", requested: false }),
      sleep: async () => undefined,
      readTerminalSince: () => ({
        ok: true as const,
        data: runReads++ === 1 ? "done\n" : "",
        cursor: runReads,
        truncated: false,
      }),
    });
    expect(await run({ request: request({ action: "run", session_id: "locked", data: "echo exact" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null }))
      .toMatchObject({ handled: true, result: { status: "ok", result: { granted: true } } });
    expect(runWrites).toEqual(["echo exact\r", "echo exact\r"]);
  });

  test("returns truthful declined, no-session, and timeout lock outcomes", async () => {
    const declined = handler({
      writeSession: () => ({ ok: false as const, reason: "locked" as const }),
      getSessionControl: () => ({ controller: "user", requested: false }),
      sleep: async () => undefined,
    });
    expect(await declined({ request: request({ action: "write", session_id: "one", data: "x" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null }))
      .toEqual({ handled: true, result: { status: "error", error: "terminal: the user declined the control request. Ask them before trying again." } });

    const missing = handler({ writeSession: () => ({ ok: false as const, reason: "no-session" as const }) });
    expect(await missing({ request: request({ action: "write", session_id: "gone", data: "x" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null }))
      .toEqual({ handled: true, result: { status: "error", error: "terminal: no live session gone" } });

    let nowCalls = 0;
    const timeout = handler({
      writeSession: () => ({ ok: false as const, reason: "locked" as const }),
      now: () => nowCalls++ === 0 ? 0 : 120_000,
      sleep: async () => { throw new Error("timeout must not poll"); },
    });
    expect(await timeout({ request: request({ action: "write", session_id: "locked", data: "x" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null }))
      .toEqual({
        handled: true,
        result: {
          status: "error",
          error: "terminal: still under user control after waiting ~2m. The request is still showing to the user — ask them to approve, then try again.",
        },
      });
  });

  test("settles output with cursor progress, sanitization, and read acknowledgement", async () => {
    const cursors: number[] = [];
    let reads = 0;
    const acknowledged: string[] = [];
    const dispatch = handler({
      readTerminalSince: (_id, cursor) => {
        cursors.push(cursor);
        reads += 1;
        return reads === 1
          ? { ok: true as const, data: "\u001b[31mhello\r\n\u0001", cursor: 9, truncated: false }
          : { ok: true as const, data: "", cursor: 9, truncated: false };
      },
      acknowledgeAgentHandoffSession: (id) => { acknowledged.push(id); },
      sleep: async () => undefined,
    });
    expect(await dispatch({ request: request({ action: "read", session_id: "pty", cursor: 4 }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null }))
      .toEqual({ handled: true, result: { status: "ok", result: { data: "hello\n", cursor: 9 } } });
    expect(cursors).toEqual([4, 9, 9]);
    expect(acknowledged).toEqual(["pty"]);

    let deadlineNowCalls = 0;
    const deadline = handler({
      now: () => deadlineNowCalls++ === 0 ? 0 : 2_500,
      readTerminalSince: () => ({ ok: true as const, data: "", cursor: 12, truncated: false }),
      sleep: async () => { throw new Error("deadline must not sleep"); },
    });
    expect(await deadline({ request: request({ action: "read", session_id: "pty", cursor: 7 }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null }))
      .toEqual({ handled: true, result: { status: "ok", result: { data: "", cursor: 7 } } });
  });

  test("uses exact spawn resolver inputs, preserves spawn failure, and never closes a borrowed Sandbox", async () => {
    const resolverInputs: unknown[] = [];
    const borrowed = { close: async () => { throw new Error("terminal must not close borrowed sandbox"); } } as unknown as import("@nautilo/sandbox").Sandbox;
    let spawnedSandbox: unknown;
    const dispatch = handler({
      resolveTerminalSpawnCwd: (input) => {
        resolverInputs.push(input);
        return { ok: true, cwd: "/sandbox/cwd" };
      },
      spawnSession: (input) => {
        spawnedSandbox = input.sandbox;
        return { id: "spawned", title: "shell", cwd: "/sandbox/cwd", sandboxed: true, controller: "agent", requested: false, agentControlConsented: false };
      },
    });
    expect(await dispatch({ request: request({ action: "spawn", cwd: "/sandbox/cwd" }), guardRoots: ["/fallback"], sandboxEnvelopeWorkspace: "/sandbox", sandbox: borrowed }))
      .toMatchObject({ handled: true, result: { status: "ok", result: { session_id: "spawned" } } });
    expect(resolverInputs).toEqual([{ requestedCwd: "/sandbox/cwd", sandboxWorkspace: "/sandbox", fallbackWorkspace: "/fallback" }]);
    expect(spawnedSandbox).toBe(borrowed);

    const refused = handler({ resolveTerminalSpawnCwd: () => ({ ok: false, error: "outside" }) });
    expect(await refused({ request: request({ action: "spawn" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null }))
      .toEqual({ handled: true, result: { status: "error", errorCode: "TERMINAL_CWD_OUTSIDE_SANDBOX", error: "outside" } });
    const throwing = handler({ spawnSession: () => { throw new Error("pty unavailable"); } });
    expect(await throwing({ request: request({ action: "spawn" }), guardRoots: ["/tmp"], sandboxEnvelopeWorkspace: undefined, sandbox: null }))
      .toEqual({
        handled: true,
        result: {
          status: "error",
          errorCode: "TERMINAL_SPAWN_FAILED",
          error: "terminal spawn failed before a session was created: pty unavailable",
        },
      });
  });
});
