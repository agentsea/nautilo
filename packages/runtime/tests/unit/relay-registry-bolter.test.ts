import { expect, test } from "bun:test";
import type { RelayCapabilities, RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

test("Bolter registration, revision and replacement use only the acknowledged owner socket", async () => {
  const registry = new InMemoryRelayRegistry();
  const sent: RelayServerMessage[] = [];
  const capability: RelayCapabilities = { profile: "desktop-agent", bolter: { version: 1, hostKind: "electron" } };
  const contexts: Array<string | null> = [];
  registry.onBolterContext((_relayId, _userId, context) => contexts.push(context?.relaySessionId ?? null));
  await registry.register("relay-1", "human-1", capability, message => sent.push(message), 30, "desktop-1", 0, "pair-1");
  expect(registry.listBolterSessions("human-1")).toEqual([]);
  expect(registry.publishBolterContext("relay-1", "foreign")).toBe(false);
  expect(registry.publishBolterContext("relay-1", "human-1")).toBe(true);
  expect(registry.listBolterSessions("human-1")).toHaveLength(1);
  const pending = registry.requestBolterCommand({ relayId: "relay-1", userId: "human-1", signal: new AbortController().signal,
    command: { action: "check", connectionId: "719f18c6-a3a9-4b8e-994a-9fa36136552e", generation: 1 } }).catch((error: unknown) => error instanceof Error ? error.message : "unexpected error");
  expect(registry.updateCapabilities({ relayId: "relay-1", userId: "human-1", desktopSessionId: "desktop-1", capabilityRevision: 1, capabilities: capability })).toEqual({ ok: true });
  expect(await pending).toBe("BOLTER_CONTEXT_STALE");
  expect(contexts.at(-1)).toBeNull();
  expect(registry.listBolterSessions("human-1")).toEqual([]);
  registry.publishBolterContext("relay-1", "human-1");
  expect(registry.getBolterSession("relay-1", "human-1")?.capabilityRevision).toBe(1);
  await registry.register("relay-1", "human-1", capability, message => sent.push(message), 30, "desktop-2", 0, "pair-2");
  expect(registry.listBolterSessions("human-1")).toEqual([]);
  registry.publishBolterContext("relay-1", "human-1");
  await registry.unregister("relay-1");
  expect(contexts.at(-1)).toBeNull();
  expect(sent.filter(message => message.type === "relay:bolter-command")).toHaveLength(1);
});

test("older peers and unqualified capability shapes cannot open the adapter lane", async () => {
  for (const [version, bolter] of [[29, { version: 1, hostKind: "electron" }], [30, { version: 1, hostKind: "electron", shell: true }]] as const) {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "human-1", { profile: "desktop-agent", bolter } as RelayCapabilities, () => {}, version, "desktop-1", 0, "pair-1");
    expect(registry.publishBolterContext("relay-1", "human-1")).toBe(false);
  }
});
