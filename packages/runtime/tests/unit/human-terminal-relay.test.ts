import { expect, test } from "bun:test";
import type { RelayCapabilities, RelayHumanTerminalBinding, RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";
async function fixture(protocol = 24) {
  const registry = new InMemoryRelayRegistry(); const sent: RelayServerMessage[] = [];
  const owner = { humanUserId: "human", agentId: "agent", roomId: "room", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "pending", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" };
  const caps: RelayCapabilities = { profile: "desktop-agent", canUseHumanTerminal: true, humanTerminal: { version: 1, generation: "consent", owner } };
  await registry.register("relay", "human", caps, message => { sent.push(message); if (message.type === "relay:dispatch") registry.resolveDispatch(message.correlationId, { status: "ok", result: { ok: true } }); }, protocol, "desktop", 1, "raw-pair");
  owner.pairingGeneration = registry.getLocalExecutionPairingGeneration("relay")!;
  if (protocol >= 24) registry.updateCapabilities({ relayId: "relay", userId: "human", desktopSessionId: "desktop", capabilityRevision: 2, capabilities: caps });
  const binding: RelayHumanTerminalBinding = { version: 1, generation: "consent", invocationId: "call", owner: { ...owner, conversationId: "thread" } };
  return { registry, sent, caps, binding, request: { toolName: "human_terminal", args: { action: "write", data: "once" }, impact: "high" as const, approvalObtained: true, humanTerminalBinding: binding } };
}
async function rejected(work: Promise<unknown>) { expect(await work.then(() => false, () => true)).toBeTrue(); }
test("exact scoped Human binding is forwarded without a PTY selector", async () => {
  const f = await fixture(); await f.registry.dispatch("relay", f.request);
  expect(f.sent).toHaveLength(1); expect(f.sent[0]).toMatchObject({ type: "relay:dispatch", humanTerminalBinding: f.binding });
});
test("old peers, foreign owners, malformed operations and replaced consent cannot send", async () => {
  const old = await fixture(23); await rejected(old.registry.dispatch("relay", old.request)); expect(old.sent).toHaveLength(0);
  const f = await fixture();
  for (const binding of [{ ...f.binding, generation: "other" }, { ...f.binding, owner: { ...f.binding.owner, roomId: "other" } }, { ...f.binding, owner: { ...f.binding.owner, pairingGeneration: "raw-pair" } }]) await rejected(f.registry.dispatch("relay", { ...f.request, humanTerminalBinding: binding }));
  await rejected(f.registry.dispatch("relay", { ...f.request, args: { action: "kill" } }));
  expect(f.sent).toHaveLength(0);
  expect(f.registry.updateCapabilities({ relayId: "relay", userId: "human", desktopSessionId: "desktop", capabilityRevision: 3, capabilities: { ...f.caps, humanTerminal: { ...f.caps.humanTerminal!, generation: "new" } } })).toEqual({ ok: true });
  await rejected(f.registry.dispatch("relay", f.request)); expect(f.sent).toHaveLength(0);
});
