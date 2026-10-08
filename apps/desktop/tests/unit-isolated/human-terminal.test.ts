import { afterEach, describe, expect, mock, test } from "bun:test";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { Sandbox } from "@nautilo/sandbox";
import type { HumanTerminalOwner } from "../../../../packages/types/src/human-terminal";

class Pty {
  writes: string[] = [];
  kills = 0;
  data: (chunk: string) => void = () => {};
  exit: (event: { exitCode: number }) => void = () => {};
  onData(listener: typeof this.data) { this.data = listener; return { dispose() {} }; }
  onExit(listener: typeof this.exit) { this.exit = listener; return { dispose() {} }; }
  write(data: string) { this.writes.push(data); }
  kill() { this.kills++; }
  resize() {}
}
let pty: Pty;
mock.module("node:module", () => ({ createRequire: () => () => ({ spawn: () => (pty = new Pty()) }) }));
const host = await import("../../electron/terminal-host");
const { dispatchHumanTerminal: rawDispatchHumanTerminal } = await import("../../electron/relay-dispatch/human-terminal");

let nextInvocation = 0;
function dispatchHumanTerminal(...args: Parameters<typeof rawDispatchHumanTerminal>) {
  return rawDispatchHumanTerminal(args[0], args[1], args[2], args[3], args[4],
    args[5] ?? { generation: host.peekHumanTerminalConsent()?.generation ?? "absent", invocationId: `call-${++nextInvocation}` });
}
function executeHumanTerminal(...args: Parameters<typeof host.executeHumanTerminal>) {
  return host.executeHumanTerminal(args[0], args[1], args[2], args[3], args[4], args[5] ?? `call-${++nextInvocation}`);
}

const owner: HumanTerminalOwner = { humanUserId: "human-a", agentId: "agent-a", roomId: "room-a", conversationId: "conversation-a",
  relayId: "relay-a", desktopSessionId: "desktop-a", pairingGeneration: "pairing-a", serverOrigin: "https://server.example", serverFingerprint: "fingerprint-a" };
const handlers = new Map<string, (...args: unknown[]) => unknown>();
function register() {
  handlers.clear();
  host.registerTerminalHost({ ipcMain: { handle(name: string, callback: (...args: unknown[]) => unknown) { handlers.set(name, callback); } } as unknown as IpcMain,
    humanTerminalInputCapacity: 4, assertSender() {}, getWebContents: () => ({ send() {} }) as unknown as WebContents });
}
function takeControl(id: string) {
  return handlers.get("terminal:set-controller")!({} as IpcMainInvokeEvent, { sessionId: id, controller: "user" });
}
function fixture() {
  register();
  const session = host.spawnSession({ shell: "/usr/bin/test-program", cwd: "/tmp" });
  const terminal = pty;
  const grant = host.grantHumanTerminalControl(session.id, owner)!;
  expect(grant).not.toBeNull();
  return { session, terminal, grant };
}
function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => host.disposeAllTerminals());

describe("scoped Human terminal authority", () => {
  test("pending Human consent cannot read until a matching admitted foreground call binds it", async () => {
    register();
    const session = host.spawnSession({ cwd: "/tmp" });
    const terminal = pty;
    const { conversationId: _conversationId, ...selection } = owner;
    const consent = host.grantHumanTerminalConsent(session.id, selection)!;
    terminal.data("private");
    expect(host.peekHumanTerminalGrant(owner)).toBeNull();
    expect(await executeHumanTerminal(owner, consent.generation, { action: "read" }, () => true))
      .toMatchObject({ code: "grant_required" });
    expect(await dispatchHumanTerminal("human_terminal", { action: "read" }, owner, () => false))
      .toMatchObject({ code: "authority_changed" });
    expect(host.peekHumanTerminalGrant(owner)).toBeNull();
    expect(await dispatchHumanTerminal("human_terminal", { action: "read" }, { ...owner, agentId: "other" }, () => true))
      .toMatchObject({ code: "grant_required" });
    expect(await dispatchHumanTerminal("human_terminal", { action: "read" }, owner, () => true))
      .toMatchObject({ ok: true, data: "private" });
    expect(host.peekHumanTerminalGrant(owner)?.generation).toBe(consent.generation);
    expect(await dispatchHumanTerminal("human_terminal", { action: "read" }, { ...owner, conversationId: "another" }, () => true))
      .toMatchObject({ code: "grant_required" });
  });
  test("pending consent replacement during admission cannot bind a stale request", async () => {
    register();
    const session = host.spawnSession({ cwd: "/tmp" });
    const terminal = pty;
    const { conversationId: _conversationId, ...selection } = owner;
    const first = host.grantHumanTerminalConsent(session.id, selection)!;
    const barrier = deferred();
    const result = dispatchHumanTerminal("human_terminal", { action: "write", data: "stale" }, owner, () => barrier.promise);
    const second = host.grantHumanTerminalConsent(session.id, selection)!;
    expect(host.revokeHumanTerminalConsent(first.generation)).toBeFalse();
    barrier.resolve(true);
    expect(await result).toMatchObject({ code: "grant_required" });
    expect(terminal.writes).toEqual([]);
    expect(host.peekHumanTerminalGrant(owner)).toBeNull();
    expect(host.revokeHumanTerminalConsent(second.generation)).toBeTrue();
    expect(host.peekHumanTerminalConsent()).toBeNull();
    expect(terminal.kills).toBe(0);
  });
  test("requires explicit grant of an existing Human PTY; cannot spawn through dispatch", async () => {
    expect(host.grantHumanTerminalControl("missing", owner)).toBeNull();
    const result = await dispatchHumanTerminal("human_terminal", { action: "read" }, owner, () => true);
    expect(result).toMatchObject({ ok: false, code: "grant_required", inputWritten: false });
    expect(await dispatchHumanTerminal("human_terminal", { action: "spawn" }, owner, () => true)).toMatchObject({ code: "invalid_request" });
    expect(host.listSessions()).toEqual([]);
    const sandboxed = host.spawnSession({ cwd: "/tmp", sandbox: { wrap: () => ({ program: "/bin/test", args: [], env: {} }) } as unknown as Sandbox });
    expect(host.grantHumanTerminalControl(sandboxed.id, owner)).toBeNull();
  });
  test("read/run/write share exact PTY with truthful immediate output and no exit claim", async () => {
    const { terminal } = fixture();
    terminal.data("Python prompt 😀");
    const read = await dispatchHumanTerminal("human_terminal", { action: "read" }, owner, () => true);
    expect(read).toMatchObject({ ok: true, data: "Python prompt 😀", cursor: 16, produced: 16,
      availableFrom: 0, truncated: false, cursorUnit: "utf16_code_units", inputWritten: false, commandOutcome: "not_observed" });
    expect(await dispatchHumanTerminal("human_terminal", { action: "run", command: "print(1)" }, owner, () => true)).toMatchObject({
      ok: true, data: "", inputWritten: true, commandOutcome: "not_observed" });
    expect(await dispatchHumanTerminal("human_terminal", { action: "write", data: "\x03" }, owner, () => true)).toMatchObject({ ok: true, inputWritten: true });
    expect(terminal.writes).toEqual(["print(1)\r", "\x03"]);
    expect(read).not.toHaveProperty("exitCode");
    expect(read).not.toHaveProperty("session_id");
  });
  test("every owner dimension denies foreign reads and writes", async () => {
    const { terminal, grant } = fixture();
    terminal.data("private terminal output");
    for (const key of Object.keys(owner) as (keyof HumanTerminalOwner)[]) {
      const changed = { ...owner, [key]: key === "serverOrigin" ? "https://other.example" : "other" };
      expect(host.peekHumanTerminalGrant(changed)).toBeNull();
      for (const operation of [{ action: "read" }, { action: "write", data: "evil" }] as const) {
        const result = await executeHumanTerminal(changed, grant.generation, operation, () => true);
        expect(result).toMatchObject({ ok: false, code: "grant_required", inputWritten: operation.action === "read" ? false : "unknown" });
        expect(result).not.toHaveProperty("data");
      }
    }
    expect(terminal.writes).toEqual([]);
  });
  test("legacy Agent read/input/routing cannot borrow scoped consent; Human IPC remains usable", async () => {
    const { session, terminal } = fixture();
    terminal.data("Human output");
    expect(host.readTerminalSince(session.id, 0)).toEqual({ ok: false });
    expect(host.writeSession(session.id, "legacy", "agent")).toEqual({ ok: false, reason: "locked" });
    expect(host.peekAgentHandoffSession()).toBeNull();
    expect(host.peekBoundAgentTerminalSession()).toBeNull();
    expect(host.readHumanTerminalSince(session.id, 0)).toMatchObject({ data: "Human output" });
    await takeControl(session.id);
    expect(host.readTerminalSince(session.id, 0)).toEqual({ ok: false });
    expect(host.writeSession(session.id, "legacy after retake", "agent")).toEqual({ ok: false, reason: "locked" });
    expect(await handlers.get("terminal:grant-agent-control")!({}, { sessionId: session.id })).toBeFalse();
    expect(host.writeSession(session.id, "Human", "user")).toEqual({ ok: true });
    expect(terminal.writes).toEqual(["Human"]);
  });
  test("take control revokes consent/grant/request/routing without killing the job", async () => {
    const { session, terminal, grant } = fixture();
    await takeControl(session.id);
    expect(host.peekHumanTerminalGrant(owner)).toBeNull();
    expect(host.getSessionControl(session.id)).toEqual({ controller: "user", requested: false });
    expect(host.listSessions()[0]?.agentControlConsented).toBeFalse();
    expect(await handlers.get("terminal:set-controller")!({}, { sessionId: session.id, controller: "agent" })).toBeFalse();
    expect(await executeHumanTerminal(owner, grant.generation, { action: "read" }, () => true)).toMatchObject({ code: "grant_required" });
    expect(terminal.kills).toBe(0);
  });
  test("fresh explicit handoff changes generation and stale cleanup cannot revoke it", async () => {
    const { session, grant, terminal } = fixture();
    await takeControl(session.id);
    const fresh = host.grantHumanTerminalControl(session.id, owner)!;
    expect(fresh.generation).not.toBe(grant.generation);
    expect(host.revokeHumanTerminalGrant(owner, grant.generation)).toBeFalse();
    expect(await executeHumanTerminal(owner, grant.generation, { action: "write", data: "old" }, () => true)).toMatchObject({ code: "grant_required" });
    expect(await executeHumanTerminal(owner, fresh.generation, { action: "write", data: "new" }, () => true)).toMatchObject({ ok: true });
    expect(terminal.writes).toEqual(["new"]);
  });
  test("retake during pre-effect authority await prevents input", async () => {
    const { session, grant, terminal } = fixture();
    const barrier = deferred();
    const result = executeHumanTerminal(owner, grant.generation, { action: "run", command: "danger" }, () => barrier.promise);
    await takeControl(session.id);
    barrier.resolve(true);
    expect(await result).toMatchObject({ code: "authority_changed", inputWritten: false });
    expect(terminal.writes).toEqual([]);
  });
  test("same-owner fresh grant during await cannot revive stale request", async () => {
    const { session, grant, terminal } = fixture();
    const barrier = deferred();
    const result = executeHumanTerminal(owner, grant.generation, { action: "write", data: "old" }, () => barrier.promise);
    host.grantHumanTerminalControl(session.id, owner);
    barrier.resolve(true);
    expect(await result).toMatchObject({ code: "authority_changed", inputWritten: false });
    expect(terminal.writes).toEqual([]);
  });
  test("post-read authority loss suppresses already captured private output", async () => {
    const { session, grant, terminal } = fixture();
    terminal.data("private");
    const barrier = deferred();
    const entered = deferred();
    let calls = 0;
    const result = executeHumanTerminal(owner, grant.generation, { action: "read" }, () => {
      if (++calls === 1) return true;
      entered.resolve(true);
      return barrier.promise;
    });
    await entered.promise;
    expect(calls).toBe(2);
    await takeControl(session.id);
    barrier.resolve(true);
    const receipt = await result;
    expect(receipt).toMatchObject({ code: "authority_changed", inputWritten: false });
    expect(receipt).not.toHaveProperty("data");
  });
  test("post-input authority loss is uncertain and must not be retried", async () => {
    const { grant, terminal } = fixture();
    let calls = 0;
    const result = await executeHumanTerminal(owner, grant.generation, { action: "write", data: "submitted" }, () => ++calls === 1);
    expect(result).toMatchObject({ code: "outcome_unknown", inputWritten: true, retrySafe: false });
    expect(terminal.writes).toEqual(["submitted"]);
    expect(result).not.toHaveProperty("data");
  });
  test("aborted/throwing authority checks fail closed", async () => {
    const { grant, terminal } = fixture();
    const controller = new AbortController(); controller.abort();
    expect(await executeHumanTerminal(owner, grant.generation, { action: "write", data: "x" }, () => true, controller.signal)).toMatchObject({ ok: false });
    expect(await executeHumanTerminal(owner, grant.generation, { action: "read" }, () => { throw new Error("private diagnostic"); })).toMatchObject({ code: "authority_changed" });
    expect(terminal.writes).toEqual([]);
  });
  test("rejected authority never submits and native input errors are not retry-safe", async () => {
    const { grant, terminal } = fixture();
    expect(await executeHumanTerminal(owner, grant.generation, { action: "run", command: "x" }, () => false)).toMatchObject({ code: "authority_changed", inputWritten: false });
    terminal.write = () => { throw new Error("sensitive native diagnostic"); };
    const result = await executeHumanTerminal(owner, grant.generation, { action: "write", data: "x" }, () => true);
    expect(result).toMatchObject({ ok: false, code: "input_failed", inputWritten: "unknown", retrySafe: false });
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
  test("the final authority-check microtask cannot publish output after retake", async () => {
    const { session, grant, terminal } = fixture();
    terminal.data("private");
    let calls = 0;
    const result = await executeHumanTerminal(owner, grant.generation, { action: "read" }, () => {
      if (++calls === 2) queueMicrotask(() => queueMicrotask(() => { void takeControl(session.id); }));
      return true;
    });
    expect(result).toMatchObject({ code: "authority_changed" });
    expect(result).not.toHaveProperty("data");
  });
  test("grant snapshots cannot mutate retained owner authority", () => {
    const { grant } = fixture();
    (grant.owner as { humanUserId: string }).humanUserId = "foreign";
    expect(host.peekHumanTerminalGrant(owner)?.owner.humanUserId).toBe(owner.humanUserId);
    expect(host.peekHumanTerminalGrant(grant.owner)).toBeNull();
  });
  test("scrollback eviction discloses exact retained head and gap in existing cursor space", async () => {
    const { terminal } = fixture();
    const text = "a".repeat(256 * 1024) + "😀";
    terminal.data(text);
    const result = await dispatchHumanTerminal("human_terminal", { action: "read", cursor: 0 }, owner, () => true);
    expect(result).toMatchObject({ ok: true, truncated: true, availableFrom: 2, cursor: text.length, produced: text.length });
    if (result.ok) expect(result.data).toBe(text.slice(2));
    expect(await dispatchHumanTerminal("human_terminal", { action: "read", cursor: text.length }, owner, () => true)).toMatchObject({ data: "", truncated: false });
  });
  test("PTY exit revokes reference and never routes to another terminal", async () => {
    const { terminal, grant } = fixture();
    terminal.exit({ exitCode: 0 });
    host.spawnSession({ shell: "/usr/bin/other-program", cwd: "/tmp" });
    expect(host.peekHumanTerminalGrant(owner)).toBeNull();
    expect(await executeHumanTerminal(owner, grant.generation, { action: "read" }, () => true)).toMatchObject({ code: "grant_required" });
    expect(pty.writes).toEqual([]);
  });
  test("replacement chooses one PTY and revokes previous terminal without killing it", async () => {
    const { session, terminal, grant } = fixture();
    const next = host.spawnSession({ cwd: "/tmp" });
    host.grantHumanTerminalControl(next.id, owner);
    expect(host.getSessionControl(session.id)?.controller).toBe("user");
    expect(host.listSessions().find(value => value.id === session.id)?.agentControlConsented).toBeFalse();
    expect(await executeHumanTerminal(owner, grant.generation, { action: "read" }, () => true)).toMatchObject({ code: "grant_required" });
    expect(terminal.kills).toBe(0);
  });
});


test("exact concurrent input repeats share one submission, conflict and capacity fail closed", async () => {
  const { grant, terminal } = fixture(); const barrier = deferred();
  const invoke = (id: string, data = "once") => host.executeHumanTerminal(owner, grant.generation, { action: "write", data }, () => barrier.promise, undefined, id);
  const first = invoke("same"); const repeated = invoke("same");
  barrier.resolve(true);
  expect(await first).toEqual(await repeated); expect(terminal.writes).toEqual(["once"]);
  expect(await invoke("same", "different")).toMatchObject({ code: "invocation_conflict" });
  for (const id of ["second", "third", "fourth"]) expect(await invoke(id)).toMatchObject({ ok: true });
  expect(await invoke("fifth")).toMatchObject({ code: "capacity_reached" });
  expect(await invoke("same")).toMatchObject({ ok: true }); expect(terminal.writes).toHaveLength(4);
});
test("retired consent cannot replay the same input under a new grant", async () => {
  const { grant, terminal, session } = fixture();
  const identity = { generation: grant.generation, invocationId: "same" };
  expect(await rawDispatchHumanTerminal("human_terminal", { action: "run", command: "once" }, owner, () => true, undefined, identity)).toMatchObject({ ok: true });
  await takeControl(session.id); host.grantHumanTerminalControl(session.id, owner);
  expect(await rawDispatchHumanTerminal("human_terminal", { action: "run", command: "once" }, owner, () => true, undefined, identity)).toMatchObject({ code: "grant_required", inputWritten: "unknown", retrySafe: false });
  expect(terminal.writes).toEqual(["once\r"]);
});
test("input receipts retain the pre-input cursor without duplicating scrollback", async () => {
  const { grant, terminal } = fixture(); terminal.data("before");
  const write = terminal.write.bind(terminal); terminal.write = data => { write(data); terminal.data("after"); };
  const receipt = await host.executeHumanTerminal(owner, grant.generation, { action: "write", data: "once" }, () => true, undefined, "once");
  expect(receipt).toMatchObject({ ok: true, inputWritten: true, data: "", cursor: 6, produced: 6 });
  expect(await host.executeHumanTerminal(owner, grant.generation, { action: "read", cursor: 6 }, () => true)).toMatchObject({ data: "after", cursor: 11 });
});


test("legacy dispatcher cannot list, kill, read, write or reuse a scoped Human PTY", async () => {
  const { session, terminal } = fixture();
  const { createTerminalDispatchHandler } = await import("../../electron/relay-dispatch/terminal");
  const dispatch = createTerminalDispatchHandler({ ...host,
    resolveTerminalSpawnCwd: () => ({ ok: false, error: "No test sandbox" }),
  });
  const request = (args: Record<string, unknown>) => dispatch({ request: { toolName: "terminal", args, impact: "high", approvalObtained: true }, guardRoots: [], sandboxEnvelopeWorkspace: undefined, sandbox: null });
  for (const action of ["kill", "read", "write", "run"]) {
    const result = await request({ action, session_id: session.id, data: "evil", command: "evil" });
    expect(result).toMatchObject({ handled: true, result: { status: "error", errorCode: "HUMAN_TERMINAL_SCOPED" } });
  }
  expect(await request({ action: "list" })).toMatchObject({ handled: true, result: { result: { sessions: [] } } });
  expect(await request({ action: "spawn" })).toMatchObject({ handled: true, result: { status: "error" } });
  expect(terminal.kills).toBe(0); expect(terminal.writes).toEqual([]);
});
