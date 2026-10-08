import { sameComputerUseRuntimeIdentity } from "../../electron/computer-use/semantic-contracts";
import { runInNewContext } from "node:vm";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sameHumanTerminalConsentOwner, type HumanTerminalConsentOwner, type HumanTerminalOwner } from "../../../../packages/types/src/human-terminal";

// Execute the production IPC handlers with controlled existing owners. No
// Electron process, network service, credentials or terminal are required.
const source = readFileSync(new URL("../../electron/main.ts", import.meta.url), "utf8");
const start = source.indexOf("function clearHumanTerminalHandoff(): void");
const end = source.indexOf("registerTerminalHost({", start);
if (start < 0 || end < start) throw new Error("Human terminal IPC composition missing");
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(`
let humanTerminalSelection = null;
let humanTerminalLocalFence = null;
let miniAppRecoveryAuthGeneration = 0;
${source.slice(start, end)}
return { verifyHumanTerminalForRelay, invalidate: () => { miniAppRecoveryAuthGeneration++; clearHumanTerminalHandoff(); } };
`);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const handlers = new Map<string, (event: unknown, value: unknown) => unknown>();
  const session = {};
  const renderer = { isDestroyed: () => false, once: () => {} };
  const event = { sender: renderer };
  const selection = { roomId: "room-a", agentId: "agent-a" };
  const authority = { scope: "https://server.example", serverFingerprint: "fingerprint-a", revision: 1, connectionAttemptId: "connection-a" };
  const runtime = { instanceId: "", serverBindingId: "server-binding-a", humanUserId: "human-a", relayId: "relay-a", desktopSessionId: "desktop-a", pairingGeneration: "pairing-a" };
  let connected = true;
  let activeRuntime: typeof runtime | null = runtime;
  let room = { id: selection.roomId, members: [{ kind: "agent", agentId: selection.agentId }] };
  let beforeRoomRead = async () => {};
  let pending: { owner: HumanTerminalConsentOwner; generation: string } | null = null;
  let grants = 0;
  let publish = async () => true;
  const client = { setToken() {}, async getRoom() { await beforeRoomRead(); return room; } };
  const deps = {
    ipcMain: { handle: (name: string, handler: (event: unknown, value: unknown) => unknown) => handlers.set(name, handler) },
    assertMainWindowSender: (candidate: typeof event) => { if (candidate.sender !== renderer) throw new Error("foreign sender"); },
    resolveSessionFromSender: () => session, activeRenderer: () => renderer, serverSessions: { active: session },
    getActiveComputerUseRuntime: () => activeRuntime, sameComputerUseRuntimeIdentity,
    resolveReadyToWorkBindingForSession: async () => ({ humanId: "human-a", authority: { ...authority } }),
    getRelayStatus: () => connected ? "connected" : "disconnected",
    authoritativeConnectionSnapshot: () => authority,
    remoteControlClientForSender: async () => client,
    grantHumanTerminalConsent: (_id: string, owner: HumanTerminalConsentOwner) => (pending = { owner, generation: String(++grants) }),
    peekHumanTerminalConsent: () => pending,
    revokeHumanTerminalConsent: (generation: string) => { if (pending?.generation === generation) pending = null; },
    refreshDesktopRelayCapabilities: () => publish(), sameHumanTerminalConsentOwner,
    getValidAccessToken: async () => "synthetic-token", refreshTokens: () => {}, onLogtoRefreshFailed: () => {},
    NautiloApiClient: class { setToken() {} getRoom() { return client.getRoom(); } },
  };
  const factory = runInNewContext(`(function(${Object.keys(deps).join(",")}) {${javascript}})`) as (...args: unknown[]) => {
    verifyHumanTerminalForRelay(owner: HumanTerminalOwner): Promise<boolean>; invalidate(): void;
  };
  const loaded = factory(...Object.values(deps));
  const select = (value: unknown = selection) => handlers.get("terminal:set-handoff-context")!(event, value);
  const grant = (value: unknown = { sessionId: "terminal-a", ...selection }) =>
    handlers.get("terminal:grant-human-control")!(event, value) as Promise<boolean>;
  return { ...loaded, select, grant, authority, runtime, deps, handlers, event,
    pending: () => pending, grants: () => grants,
    setPublication: (callback: () => Promise<boolean>) => { publish = callback; },
    setConnected: (value: boolean) => { connected = value; },
    setRuntime: (value: typeof runtime | null) => { activeRuntime = value; },
    setRoom: (value: typeof room) => { room = value; },
    waitForRoom: (wait: () => Promise<void>) => { beforeRoomRead = wait; },
  };
}

test("grant records only a verified current Human selection, not a conversation or executable authority", async () => {
  const f = fixture();
  expect(await f.grant()).toBeFalse();
  f.select();
  expect(await f.grant({ sessionId: "terminal-a", roomId: "other", agentId: "agent-a" })).toBeFalse();
  expect(await f.grant()).toBeTrue();
  expect(f.pending()?.owner).toMatchObject({ humanUserId: "human-a", roomId: "room-a", agentId: "agent-a",
    relayId: "relay-a", desktopSessionId: "desktop-a", pairingGeneration: "pairing-a", serverOrigin: "https://server.example" });
  expect(f.pending()?.owner).not.toHaveProperty("conversationId");
  expect(await f.verifyHumanTerminalForRelay({ ...f.pending()!.owner, conversationId: "canonical-conversation" })).toBeTrue();
});

test("selection changes during member validation fence consent before it is created", async () => {
  const f = fixture(); const barrier = deferred(); const entered = deferred();
  f.select(); f.waitForRoom(async () => { entered.resolve(); await barrier.promise; });
  const granting = f.grant(); await entered.promise;
  f.select({ roomId: "other", agentId: "agent-a" }); barrier.resolve();
  expect(await granting).toBeFalse(); expect(f.grants()).toBe(0);
});

test("auth invalidation, another Human, disconnected Relay and replaced topology cannot preserve handoff", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.invalidate(),
    (f: ReturnType<typeof fixture>) => f.setConnected(false),
    (f: ReturnType<typeof fixture>) => f.setRuntime({ ...f.runtime, pairingGeneration: "new-pairing" }),
    (f: ReturnType<typeof fixture>) => { f.authority.revision++; },
    (f: ReturnType<typeof fixture>) => { f.authority.serverFingerprint = "different"; },
  ]) {
    const f = fixture(); f.select(); expect(await f.grant()).toBeTrue();
    const owner = { ...f.pending()!.owner, conversationId: "canonical-conversation" };
    mutate(f);
    expect(await f.verifyHumanTerminalForRelay(owner)).toBeFalse();
  }
  const f = fixture(); f.select(); f.runtime.humanUserId = "other";
  expect(await f.grant()).toBeFalse(); expect(f.grants()).toBe(0);
});

test("member removal and a change during revalidation deny further operations", async () => {
  const f = fixture(); f.select(); expect(await f.grant()).toBeTrue();
  const owner = { ...f.pending()!.owner, conversationId: "canonical-conversation" };
  f.setRoom({ id: "room-a", members: [] });
  expect(await f.verifyHumanTerminalForRelay(owner)).toBeFalse();
  const barrier = deferred(); const entered = deferred();
  f.setRoom({ id: "room-a", members: [{ kind: "agent", agentId: "agent-a" }] });
  f.waitForRoom(async () => { entered.resolve(); await barrier.promise; });
  const validating = f.verifyHumanTerminalForRelay(owner); await entered.promise;
  f.select(null); barrier.resolve();
  expect(await validating).toBeFalse(); expect(f.pending()).toBeNull();
});

test("foreign renderers and extra selector authority are rejected", async () => {
  const f = fixture();
  expect(() => f.handlers.get("terminal:set-handoff-context")!({ sender: {} }, null)).toThrow("foreign sender");
  expect(() => f.select({ roomId: "room-a", agentId: "agent-a", humanUserId: "other" })).toThrow("invalid");
  f.select();
  expect(await f.grant({ sessionId: "terminal-a", roomId: "room-a", agentId: "agent-a", generation: "chosen" })).toBeFalse();
  expect(f.grants()).toBe(0);
});

test("failed availability publication revokes only its exact consent generation", async () => {
  const f = fixture(); f.select();
  f.setPublication(async () => { throw new Error("unavailable"); });
  expect(await f.grant()).toBeFalse(); expect(f.pending()).toBeNull();
  const barrier = deferred(); const entered = deferred();
  f.setPublication(async () => { entered.resolve(); await barrier.promise; throw new Error("old publication failed"); });
  const old = f.grant(); await entered.promise;
  f.setPublication(async () => true);
  expect(await f.grant()).toBeTrue();
  const current = f.pending()!.generation;
  barrier.resolve(); expect(await old).toBeFalse(); expect(f.pending()?.generation).toBe(current);
});

test("Relay disconnect revokes only its current candidate consent before asynchronous cleanup", () => {
  const relaySource = readFileSync(new URL("../../electron/relay.ts", import.meta.url), "utf8");
  const begin = relaySource.indexOf("revokeCandidateHumanConsent = () => {\n");
  const finish = relaySource.indexOf("\n  };", begin) + "\n  };".length;
  expect(begin).toBeGreaterThan(0);
  const candidate = {}; let active: object | null = candidate; let consent = { owner: { desktopSessionId: "desktop", relayId: "relay" }, generation: "grant" };
  const revoked: string[] = [];
  const make = runInNewContext(`(function(deps) { let revokeCandidateHumanConsent; const candidateSession = deps.candidate; const desktopSessionId = 'desktop'; const relayId = 'relay'; const pendingRelayCandidate = null; const peekHumanTerminalConsent = deps.peek; const revokeHumanTerminalConsent = deps.revoke; ${relaySource.slice(begin, finish).replaceAll("activeRelaySession", "deps.active()")}; return revokeCandidateHumanConsent; })`) as (deps: { candidate: object; active(): object | null; peek(): typeof consent; revoke(generation: string): void }) => () => void;
  const revoke = make({ candidate, active: () => active, peek: () => consent, revoke: generation => { revoked.push(generation); } });
  revoke(); expect(revoked).toEqual(["grant"]);
  active = {}; consent = { ...consent, generation: "new-grant" }; revoke(); expect(revoked).toEqual(["grant"]);
  active = candidate; consent = { ...consent, owner: { ...consent.owner, desktopSessionId: "other" } }; revoke(); expect(revoked).toEqual(["grant"]);
  expect(relaySource.slice(relaySource.indexOf("  } catch (error) {\n    revokeCandidateHumanConsent();"))).toContain("await retired.client?.disconnect()");
});


test("handoff publication acknowledgement may replace the runtime object without changing authority", async () => {
  const f = fixture(); f.select();
  f.setPublication(async () => { f.setRuntime({ ...f.runtime }); return true; });
  expect(await f.grant()).toBeTrue();
  const owner = { ...f.pending()!.owner, conversationId: "canonical-conversation" };
  expect(await f.verifyHumanTerminalForRelay(owner)).toBeTrue();
  f.setRuntime({ ...f.runtime });
  expect(await f.verifyHumanTerminalForRelay(owner)).toBeTrue();
});
test("every actual runtime identity change during publication revokes only the pending handoff", async () => {
  for (const key of ["instanceId", "humanUserId", "serverBindingId", "relayId", "desktopSessionId", "pairingGeneration"] as const) {
    const f = fixture(); f.select();
    f.setPublication(async () => { f.setRuntime({ ...f.runtime, [key]: "changed" }); return true; });
    expect(await f.grant()).toBeFalse(); expect(f.pending()).toBeNull();
  }
});


test("retake while publication is pending cannot report a successful handoff", async () => {
  const f = fixture(); f.select(); const entered = deferred(); const finish = deferred();
  f.setPublication(async () => { entered.resolve(); await finish.promise; return true; });
  const granting = f.grant(); await entered.promise;
  f.deps.revokeHumanTerminalConsent(f.pending()!.generation);
  finish.resolve(); expect(await granting).toBeFalse(); expect(f.pending()).toBeNull();
});
test("a newer handoff survives the stale successful publication response", async () => {
  const f = fixture(); f.select(); const entered = deferred(); const finish = deferred();
  f.setPublication(async () => { entered.resolve(); await finish.promise; return true; });
  const old = f.grant(); await entered.promise;
  f.setPublication(async () => true); expect(await f.grant()).toBeTrue();
  const current = f.pending()!.generation;
  finish.resolve(); expect(await old).toBeFalse(); expect(f.pending()?.generation).toBe(current);
});
