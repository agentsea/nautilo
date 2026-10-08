import { expect, test } from "bun:test";
import type { MessagePayloadV2 } from "@nautilo/lattice-bridge";
import { createLocalExecutionHistoryPort, type LocalExecutionHistoryAdmission } from "../../src/conversation/local-execution-history";
import type { RoomHistoryHit } from "../../src/conductor/history-search";
const content = JSON.stringify({ executionId: "execution-a", session_id: "execution-a", generation: "old-generation", state: "running" });
const row: RoomHistoryHit = { messageId: 42, ts: new Date(0), role: "tool", toolName: "exec_command", authorDisplayName: "Agent", handle: "agent", authorActorId: "actor-a", snippet: content };
function fixture(protectedMode = false) {
  let scope: Awaited<ReturnType<LocalExecutionHistoryAdmission["readScope"]>> = { agentActorId: "actor-a", graphThreadId: "room:fixture" };
  let policy = { mode: protectedMode ? "full_encryption" : "plaintext_only", revision: 1 };
  let rows = [row];
  let opened: { messageId: number; payload: MessagePayloadV2 }[] | null = [{ messageId: 42, payload: { role: "tool", toolName: "exec_command", content } }];
  let transcriptReads = 0;
  let duringRead: (() => void) | undefined;
  const port = createLocalExecutionHistoryPort({ conversationId: "room:fixture:bot:agent-a", readPolicy: async () => policy,
    readScope: async () => scope, readTranscript: async () => { transcriptReads++; duringRead?.(); return rows; }, openProtected: async () => opened });
  return { port, reads: () => transcriptReads, scope: (value: typeof scope) => { scope = value; }, policy: () => { policy = { ...policy, revision: 2 }; },
    rows: (value: typeof rows) => { rows = value; }, opened: (value: typeof opened) => { opened = value; }, duringRead: (fn: () => void) => { duringRead = fn; } };
}
async function denied(promise: Promise<unknown>) { expect(await promise.then(() => "accepted", () => "denied")).toBe("denied"); }
for (const protectedMode of [false, true]) {
  test(`fresh ${protectedMode ? "protected" : "ordinary"} transcript recovers after registry loss without changing original`, async () => {
    const f = fixture(protectedMode); let calls = 0;
    expect(await f.port.withReference("execution-a", async ref => { calls++; expect(ref).toEqual({ executionId: "execution-a", generation: "old-generation", sourceMessageId: 42 }); return "final receipt"; })).toBe("final receipt");
    expect(calls).toBe(1); expect(f.reads()).toBe(2); expect(row.snippet).toBe(content);
  });
  test(`revoked ${protectedMode ? "protected" : "ordinary"} Room during final transcript await withholds bytes`, async () => {
    const f = fixture(protectedMode);
    f.duringRead(() => { if (f.reads() === 2) f.scope(null); });
    await denied(f.port.withReference("execution-a", async () => "secret final"));
  });
}
test("foreign Agent, Room, narration and malformed refs cannot mint archive authority", async () => {
  for (const rows of [[{ ...row, authorActorId: "other" }], [{ ...row, role: "user" as const }], [{ ...row, snippet: "Narrated " + content }], [{ ...row, snippet: "{" }]]) {
    const f = fixture(); f.rows(rows); let calls = 0;
    await denied(f.port.withReference("execution-a", async () => { calls++; })); expect(calls).toBe(0);
  }
  const f = fixture(); f.scope({ agentActorId: "actor-a", graphThreadId: "room:foreign" });
  await denied(f.port.withReference("execution-a", async () => "no"));
});
test("protected proof failure or missing canonical tool identity never falls back to ordinary bytes", async () => {
  for (const opened of [null, [], [{ messageId: 42, payload: { role: "tool" as const, content } }]]) {
    const f = fixture(true); f.opened(opened); let calls = 0;
    await denied(f.port.withReference("execution-a", async () => { calls++; })); expect(calls).toBe(0);
  }
});
test("post-read crypto revocation, policy change and changed Agent identity withhold recovered bytes", async () => {
  for (const change of ["crypto", "policy", "agent"] as const) {
    const f = fixture(true);
    await denied(f.port.withReference("execution-a", async () => {
      if (change === "crypto") f.opened(null); else if (change === "policy") f.policy(); else f.scope({ graphThreadId: "room:fixture", agentActorId: "new-actor" });
      return "secret";
    }));
  }
});

test("new registry routes historical read without rebuilding any live execution owner", async () => {
  const { InMemoryRelayRegistry } = await import("../../src/relay-registry");
  const registry = new InMemoryRelayRegistry();
  const sent: import("@nautilo/relay").RelayServerMessage[] = [];
  await registry.register("relay-a", "human-a", { profile: "desktop-agent", canReadLocalExecutionHistory: true }, message => sent.push(message), 21, "new-desktop", 1, "pair-a");
  const binding: import("@nautilo/relay").RelayLocalExecutionHistoryBindingV1 = { version: 1, executionId: "execution-a", generation: "old-generation", invocationId: "read-a", sourceMessageId: 42,
    reader: { instanceId: "", humanUserId: "human-a", agentId: "agent-a", conversationId: "room:a", roomId: "a", relayId: "relay-a", desktopSessionId: "new-desktop", pairingGeneration: registry.getLocalExecutionPairingGeneration("relay-a")! } };
  const request = { toolName: "write_stdin", args: { session_id: "execution-a" }, impact: "read-only" as const, approvalObtained: true, localExecutionHistoryBinding: binding };
  try {
    const pending = registry.dispatch("relay-a", request);
    const frame = sent.at(-1); if (frame?.type !== "relay:dispatch") throw new Error("missing read frame");
    expect(frame.localExecutionHistoryBinding).toEqual(binding); expect(frame.localExecutionBinding).toBeUndefined();
    registry.resolveDispatch(frame.correlationId, { status: "ok", result: { historical: true, exitCode: 7 } });
    expect(await pending).toMatchObject({ status: "ok", result: { exitCode: 7 } });
    expect(registry.getLocalExecutionBinding("relay-a", "execution-a")).toBeNull();
    for (const change of [{ args: { session_id: "execution-a", cancel: true } }, { args: { session_id: "execution-a", chars: "run" } }, { localExecutionHistoryBinding: { ...binding, reader: { ...binding.reader, humanUserId: "foreign" } } }, { localExecutionHistoryBinding: { ...binding, reader: { ...binding.reader, desktopSessionId: "old-desktop" } } }]) await denied(registry.dispatch("relay-a", { ...request, ...change }));
    expect(sent).toHaveLength(1);
  } finally { await registry.unregister("relay-a"); }
});
