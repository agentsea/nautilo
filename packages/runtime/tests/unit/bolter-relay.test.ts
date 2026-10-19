import { describe, expect, test } from "bun:test";
import { BolterRelayTransport, type BolterRelaySession } from "../../src/bolter-relay";
import { BOLTER_RELAY_MAX_FRAME_BYTES, type RelayBolterBatch, type RelayBolterCommand, type RelayBolterServerMessage } from "@nautilo/relay";

const connectionId = "719f18c6-a3a9-4b8e-994a-9fa36136552e";
const scope = { relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1",
  pairingGenerationRef: "pair-1", selectedProtocolVersion: 30, capabilityRevision: 0 };
function fixture() {
  const live = { value: { ...scope, userId: "human-1" } as BolterRelaySession | null };
  const sent: RelayBolterServerMessage[] = [];
  const bridge = new BolterRelayTransport((relay, user) => live.value?.relayId === relay && live.value.userId === user ? live.value : null,
    (_session, message) => { sent.push(message); return true; });
  return { live, sent, bridge };
}
function batch(): RelayBolterBatch {
  return { type: "relay:bolter-batch", version: 30, scope: { ...scope }, connectionId, generation: 1, batchId: "batch-1",
    messages: [{ type: "message", messageId: "message-1", chatId: "chat-1", threadRootId: null,
      senderId: "peer-1", senderType: "anima", content: "Synthetic bridge test", createdAt: "2026-10-12T10:00:00Z",
      addressed: true, truncated: false, redelivered: false }] };
}

describe("owned Bolter relay transport", () => {
  test("releases reviewed content only once at the ready native boundary and fences mid-await abort", async () => {
    for (const abortDuringAuthorization of [false, true]) {
      const { bridge, sent } = fixture();
      bridge.publish("relay-1", "human-1");
      const abort = new AbortController();
      let calls = 0;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      const pending = bridge.request({ relayId: "relay-1", userId: "human-1", signal: abort.signal,
        command: { action: "send", connectionId, generation: 1, outboxId: connectionId, bindingId: connectionId, bindingRevision: 0 },
        authorize: async () => { calls++; await ready; return { chatId: "chat-1", threadRootId: null, content: "Reviewed synthetic message" }; },
      }).catch(() => null);
      expect(calls).toBe(0);
      expect(JSON.stringify(sent)).not.toContain("Reviewed synthetic message");
      const command = sent[0] as RelayBolterCommand;
      const message = { type: "relay:bolter-authorize" as const, version: 30 as const, scope: command.scope,
        correlationId: command.correlationId, outboxId: connectionId };
      expect(await bridge.accept({ relayId: "relay-1", userId: "human-1", message: { ...message, outboxId: "a51f18c6-a3a9-4b8e-994a-9fa36136552e" } })).toMatchObject({ ok: false });
      expect(calls).toBe(0);
      const authorizing = bridge.accept({ relayId: "relay-1", userId: "human-1", message });
      expect(calls).toBe(1);
      expect(await bridge.accept({ relayId: "relay-1", userId: "human-1", message })).toMatchObject({ ok: false });
      if (abortDuringAuthorization) abort.abort();
      release(); await authorizing;
      expect(sent).toHaveLength(abortDuringAuthorization ? 1 : 2);
      if (!abortDuringAuthorization) expect(sent[1]).toMatchObject({ type: "relay:bolter-authorized", content: { content: "Reviewed synthetic message" } });
      abort.abort(); await pending;
    }
  });
  test("retires pending sends when authorization response is oversized, refused or throws", async () => {
    for (const failure of ["oversized", "refused", "throws"] as const) {
      const sent: RelayBolterServerMessage[] = [];
      const bridge = new BolterRelayTransport(() => ({ ...scope, userId: "human-1" }), (_session, message) => {
        if (message.type === "relay:bolter-authorized") {
          if (failure === "throws") throw new Error("socket closed");
          if (failure === "refused") return false;
        }
        sent.push(message); return true;
      });
      bridge.publish("relay-1", "human-1");
      const pending = bridge.request({ relayId: "relay-1", userId: "human-1", signal: new AbortController().signal,
        command: { action: "send", connectionId, generation: 1, outboxId: connectionId, bindingId: connectionId, bindingRevision: 0 },
        authorize: async () => ({ chatId: "chat-1", threadRootId: null,
          content: failure === "oversized" ? "x".repeat(BOLTER_RELAY_MAX_FRAME_BYTES) : "Synthetic test" }),
      }).then(() => "unexpected success", (error: unknown) => error instanceof Error ? error.message : "unknown");
      const command = sent[0] as RelayBolterCommand;
      const message = { type: "relay:bolter-authorize" as const, version: 30 as const, scope: command.scope,
        correlationId: command.correlationId, outboxId: connectionId };
      expect(await bridge.accept({ relayId: "relay-1", userId: "human-1", message })).toEqual({ ok: false, error: "BOLTER_UNAVAILABLE" });
      expect(await pending).toBe("BOLTER_COMMAND_INTERRUPTED");
      expect(await bridge.accept({ relayId: "relay-1", userId: "human-1", message })).toEqual({ ok: false, error: "BOLTER_AUTHORIZATION_STALE" });
      expect(sent).toHaveLength(failure === "oversized" ? 2 : 1);
      if (failure === "oversized") expect(sent[1]).toMatchObject({ type: "relay:bolter-authorized", content: null });
    }
  });
  test("requires acknowledged current scope and correlates exactly one result", async () => {
    const { bridge, sent } = fixture();
    const input = { relayId: "relay-1", userId: "human-1", command: { action: "check" as const, connectionId, generation: 1 }, signal: new AbortController().signal };
    expect(await bridge.request(input).catch((error: unknown) => error instanceof Error ? error.message : "unexpected error")).toBe("BOLTER_UNAVAILABLE");
    expect(bridge.publish("relay-1", "foreign")).toBe(false);
    expect(bridge.publish("relay-1", "human-1")).toBe(true);
    const pending = bridge.request(input);
    const command = sent[0] as RelayBolterCommand;
    const result = { type: "relay:bolter-result" as const, version: 30 as const, scope: command.scope,
      correlationId: command.correlationId, result: { kind: "unavailable" as const, reason: "qualification_required" as const } };
    expect(await bridge.accept({ relayId: "relay-1", userId: "foreign", message: result })).toMatchObject({ ok: false });
    expect(await bridge.accept({ relayId: "relay-1", userId: "human-1", message: { ...result, scope: { ...scope, capabilityRevision: 1 } } })).toMatchObject({ ok: false });
    expect(await bridge.accept({ relayId: "relay-1", userId: "human-1", message: result })).toEqual({ ok: true });
    expect(await pending).toEqual(result.result);
    expect(await bridge.accept({ relayId: "relay-1", userId: "human-1", message: result })).toMatchObject({ ok: false });
    expect(sent).toHaveLength(1);
  });
  test("abort, disconnect and session replacement never replay a send", async () => {
    for (const scenario of ["abort", "disconnect", "replace"] as const) {
      const { bridge, sent, live } = fixture();
      bridge.publish("relay-1", "human-1");
      const abort = new AbortController();
      const request = bridge.request({ relayId: "relay-1", userId: "human-1", signal: abort.signal,
        command: { action: "send", connectionId, generation: 1, outboxId: connectionId, bindingId: connectionId, bindingRevision: 0 } });
      const rejected = request.then(() => false, () => true);
      if (scenario === "abort") abort.abort();
      else if (scenario === "disconnect") { live.value = null; bridge.invalidate("relay-1"); }
      else { live.value = { ...scope, userId: "human-1", relaySessionId: "session-2" }; bridge.publish("relay-1", "human-1"); }
      expect(await rejected).toBe(true);
      expect(sent).toHaveLength(1);
    }
  });
  test("ACK follows durable acceptance; disconnect during acceptance fences the old receipt", async () => {
    for (const disconnect of [false, true]) {
      const { bridge, sent, live } = fixture();
      bridge.publish("relay-1", "human-1");
      let complete!: (status: "accepted") => void;
      bridge.onBatch(() => new Promise(resolve => { complete = resolve; }));
      const receiving = bridge.accept({ relayId: "relay-1", userId: "human-1", message: batch() });
      expect(sent).toEqual([]);
      if (disconnect) { live.value = null; bridge.invalidate("relay-1"); }
      complete("accepted");
      await receiving;
      expect(sent).toHaveLength(disconnect ? 0 : 1);
      if (!disconnect) expect(sent[0]).toMatchObject({ type: "relay:bolter-batch-ack", batchId: "batch-1", status: "accepted" });
    }
  });
  test("missing consumer, failed persistence and concurrent handover never receive accepted", async () => {
    const { bridge, sent } = fixture();
    bridge.publish("relay-1", "human-1");
    await bridge.accept({ relayId: "relay-1", userId: "human-1", message: batch() });
    expect(sent.pop()).toMatchObject({ status: "blocked" });
    const stop = bridge.onBatch(async () => { throw new Error("storage unavailable"); });
    await bridge.accept({ relayId: "relay-1", userId: "human-1", message: batch() });
    expect(sent.pop()).toMatchObject({ status: "blocked" });
    stop();
    let complete!: (status: "accepted") => void;
    bridge.onBatch(() => new Promise(resolve => { complete = resolve; }));
    expect(() => bridge.onBatch(async () => "accepted")).toThrow();
    const first = bridge.accept({ relayId: "relay-1", userId: "human-1", message: batch() });
    await bridge.accept({ relayId: "relay-1", userId: "human-1", message: { ...batch(), batchId: "batch-2" } });
    expect(sent.pop()).toMatchObject({ status: "blocked", batchId: "batch-2" });
    complete("accepted"); await first;
  });
});

test("file peers can sequentially revalidate one pending send while old peers keep one-shot release", async () => {
  const { bridge, live, sent } = fixture();
  live.value = { ...live.value!, selectedProtocolVersion: 31 };
  bridge.publish("relay-1", "human-1");
  const abort = new AbortController(); let calls = 0;
  const pending = bridge.request({ relayId: "relay-1", userId: "human-1", signal: abort.signal,
    command: { action: "send", connectionId, generation: 1, outboxId: connectionId, bindingId: connectionId, bindingRevision: 0 },
    authorize: async () => { calls++; return { chatId: "fixture-chat", threadRootId: null, content: "Fixture text" }; },
  }).catch(() => null);
  const command = sent[0] as RelayBolterCommand;
  const message = { type: "relay:bolter-authorize" as const, version: 30 as const, scope: command.scope, correlationId: command.correlationId, outboxId: connectionId };
  expect(await bridge.accept({ relayId: "relay-1", userId: "human-1", message })).toEqual({ ok: true });
  expect(await bridge.accept({ relayId: "relay-1", userId: "human-1", message })).toEqual({ ok: true });
  expect(calls).toBe(2);
  abort.abort(); await pending;
  expect(await bridge.accept({ relayId: "relay-1", userId: "human-1", message })).toMatchObject({ ok: false });
});
