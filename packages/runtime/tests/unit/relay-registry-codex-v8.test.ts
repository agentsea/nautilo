import { describe, expect, test } from "bun:test";
import {
  CODEX_RELAY_MAX_REPLAY_ENTRIES,
  CODEX_RELAY_REPLAY_CACHE_TTL_MS,
} from "@nautilo/relay";
import type {
  RelayCapabilities,
  RelayCodexCommandMessage,
  RelayCodexStatusMessage,
  RelayCodexCommandResponseMessage,
  RelayCodexEventMessage,
  RelayCodexRequestMessage,
  RelayServerMessage,
} from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const CAPS: RelayCapabilities = {
  profile: "desktop-agent",
  codex: { version: 1, hostKind: "electron", maxProfiles: 4, maxActiveTurns: 4 },
};

describe("D453 InMemoryRelayRegistry Codex v8 route", () => {
  test("pairing references are namespaced, stable across reconnects, and change on re-pair", async () => {
    const registry = new InMemoryRelayRegistry();
    const register = async (pairing: string) => {
      await registry.register("relay-1", "owner-1", CAPS, () => {}, 9, "desktop-1", 0, pairing);
      return registry.getV8Acknowledgement("relay-1")!;
    };
    const first = await register("synthetic-pairing-33");
    expect(first.pairingGenerationRef).toMatch(/^pairing-[A-Za-z0-9_-]{43}$/);
    const reconnected = await register("synthetic-pairing-33");
    expect(reconnected.pairingGenerationRef).toBe(first.pairingGenerationRef);
    expect(reconnected.relaySessionId).not.toBe(first.relaySessionId);
    const repaired = await register("synthetic-pairing-36");
    expect(repaired.pairingGenerationRef).not.toBe(first.pairingGenerationRef);
    expect(registry.sendCodex("relay-1", {
      type: "relay:codex-command",
      commandId: "stale-pairing",
      scope: {
        relayId: "relay-1", relaySessionId: repaired.relaySessionId,
        desktopSessionId: "desktop-1", pairingGenerationRef: first.pairingGenerationRef,
        selectedProtocolVersion: 9, capabilityRevision: 0,
      },
      command: { kind: "runtime_inspect" },
    })).toEqual({ ok: false, error: "CODEX_CONTEXT_STALE" });
  });

  test("tracks authenticated session scope and sends Codex directly, never via dispatch", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", CAPS, (message) => sent.push(message), 9, "desktop-1", 3, "token-row-1");
    const ack = registry.getV8Acknowledgement("relay-1");
    expect(ack).not.toBeNull();
    expect(ack!.pairingGenerationRef).not.toBe("token-row-1");
    const scope = {
      relayId: "relay-1", relaySessionId: ack!.relaySessionId,
      desktopSessionId: "desktop-1", pairingGenerationRef: ack!.pairingGenerationRef,
      selectedProtocolVersion: 9, capabilityRevision: 3,
    };
    const command: RelayCodexCommandMessage = {
      type: "relay:codex-command", commandId: "inspect-1", scope,
      command: { kind: "runtime_inspect" },
    };
    expect(registry.sendCodex("relay-1", command)).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("relay:codex-command");
    expect((sent[0] as { type: string }).type).not.toBe("relay:dispatch");
  });

  test("rejects a stale pairing/session scope before a status can mutate the entry", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "owner-1", CAPS, () => {}, 8, "desktop-1", 0, "token-row-1");
    const ack = registry.getV8Acknowledgement("relay-1")!;
    const message: RelayCodexStatusMessage = {
      type: "relay:codex-status",
      socket: {
        relayId: "relay-1", relaySessionId: ack.relaySessionId,
        desktopSessionId: "desktop-1", pairingGenerationRef: "old-pairing-ref",
        selectedProtocolVersion: 8,
      },
      capabilityRevision: 0,
      status: { state: "workspace_unavailable", workspace: { state: "unavailable" } },
    };
    expect(registry.acceptCodexMessage({ relayId: "relay-1", userId: "owner-1", message })).toEqual({
      ok: false,
      error: "CODEX_CONTEXT_STALE",
    });
    expect(registry.getCodexSession("relay-1", "owner-1")!.status).toBeNull();
  });

  test("correlates one exact command response and retains identical retry outcome", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", CAPS, (message) => sent.push(message), 8, "desktop-1", 3, "token-row-1");
    const ack = registry.getV8Acknowledgement("relay-1")!;
    const scope = {
      relayId: "relay-1", relaySessionId: ack.relaySessionId,
      desktopSessionId: "desktop-1", pairingGenerationRef: ack.pairingGenerationRef,
      selectedProtocolVersion: 8 as const, capabilityRevision: 3,
    };
    const command: RelayCodexCommandMessage = {
      type: "relay:codex-command", commandId: "inspect-1", scope,
      command: { kind: "runtime_inspect" },
    };
    const first = registry.sendCodexCommand("relay-1", command);
    const duplicate = registry.sendCodexCommand("relay-1", command);
    expect(first).toBe(duplicate);
    expect(sent).toHaveLength(1);

    const response: RelayCodexCommandResponseMessage = {
      type: "relay:codex-command-response", commandId: "inspect-1", scope,
      result: { kind: "runtime_status", state: "ready", runtimeGeneration: 5 },
    };
    expect(registry.acceptCodexMessage({
      relayId: "relay-1", userId: "owner-1", message: response,
    })).toEqual({ ok: true });
    expect(await first).toEqual(response);
    expect(await registry.sendCodexCommand("relay-1", command)).toEqual(response);
    expect(sent).toHaveLength(1);
    expect(registry.acceptCodexMessage({
      relayId: "relay-1", userId: "owner-1", message: response,
    })).toEqual({ ok: true });
  });

  test("bounds pending commands with a stable timeout", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "owner-1", CAPS, () => {}, 8, "desktop-1", 0, "token-row-1");
    const ack = registry.getV8Acknowledgement("relay-1")!;
    const promise = registry.sendCodexCommand("relay-1", {
      type: "relay:codex-command",
      commandId: "timeout-1",
      scope: {
        relayId: "relay-1", relaySessionId: ack.relaySessionId,
        desktopSessionId: "desktop-1", pairingGenerationRef: ack.pairingGenerationRef,
        selectedProtocolVersion: 8, capabilityRevision: 0,
      },
      command: { kind: "runtime_inspect" },
    }, { timeoutMs: 1 });
    let timeoutError: unknown;
    try {
      await promise;
    } catch (error) {
      timeoutError = error;
    }
    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toBe("CODEX_TIMEOUT");
  });

  test("checks cross-event sequence and terminal conflicts before cache mutation", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "owner-1", CAPS, () => {}, 8, "desktop-1", 0, "token-row-1");
    const ack = registry.getV8Acknowledgement("relay-1")!;
    const base = {
      relayId: "relay-1", relaySessionId: ack.relaySessionId,
      desktopSessionId: "desktop-1", pairingGenerationRef: ack.pairingGenerationRef,
      selectedProtocolVersion: 8 as const, capabilityRevision: 0,
      profileHandle: "profile", profileGeneration: 1, accountGeneration: 2,
      runtimeGeneration: 3, childGeneration: 4,
      bindingId: "binding", bindingGeneration: 5, taskId: "task", jobId: "job",
      threadId: "thread",
      workspace: {
        workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
        issuedAt: "2026-07-26T10:00:00.000Z", expiresAt: "2026-07-26T11:00:00.000Z",
      },
      turnId: "turn",
    };
    const event = (
      eventId: string,
      eventSequence: number,
      payload: RelayCodexEventMessage["event"],
    ): RelayCodexEventMessage => ({
      type: "relay:codex-event",
      scope: { ...base, eventId },
      eventSequence,
      event: payload,
    } as RelayCodexEventMessage);
    const accept = (message: RelayCodexEventMessage) =>
      registry.acceptCodexMessage({ relayId: "relay-1", userId: "owner-1", message });

    expect(accept(event("event-1", 2, { kind: "progress", phase: "thinking", sequence: 2 }))).toEqual({ ok: true });
    const stale = event("event-2", 1, { kind: "progress", phase: "tool", sequence: 1 });
    expect(accept(stale)).toEqual({ ok: false, error: "CODEX_CORRELATION_REPLAY" });
    expect(accept(stale)).toEqual({ ok: false, error: "CODEX_CORRELATION_REPLAY" });

    expect(accept(event("event-3", 3, {
      kind: "turn_completed", status: "completed",
      itemsView: "full", assistantItems: [],
    }))).toEqual({ ok: true });
    const conflict = event("event-4", 4, {
      kind: "turn_completed", status: "failed",
      itemsView: "full", assistantItems: [], code: "CODEX_CHILD_CRASHED",
    });
    expect(accept(conflict)).toEqual({ ok: false, error: "CODEX_CORRELATION_REPLAY" });
    expect(accept(conflict)).toEqual({ ok: false, error: "CODEX_CORRELATION_REPLAY" });
    expect(accept(event("event-5", 4, { kind: "progress", phase: "finalizing", sequence: 4 }))).toEqual({ ok: true });
  });

  test("invalidates Codex status on every accepted capability revision", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "owner-1", CAPS, () => {}, 8, "desktop-1", 3, "token-row-1");
    const ack = registry.getV8Acknowledgement("relay-1")!;
    const status = (revision: number): RelayCodexStatusMessage => ({
      type: "relay:codex-status",
      socket: {
        relayId: "relay-1", relaySessionId: ack.relaySessionId,
        desktopSessionId: "desktop-1", pairingGenerationRef: ack.pairingGenerationRef,
        selectedProtocolVersion: 8,
      },
      capabilityRevision: revision,
      status: { state: "workspace_unavailable", workspace: { state: "unavailable" } },
    });
    expect(registry.acceptCodexMessage({
      relayId: "relay-1", userId: "owner-1", message: status(3),
    })).toEqual({ ok: true });
    expect(registry.getCodexSession("relay-1")?.status).not.toBeNull();
    expect(registry.updateCapabilities({
      relayId: "relay-1", userId: "owner-1", desktopSessionId: "desktop-1",
      capabilityRevision: 4, capabilities: CAPS,
    })).toEqual({ ok: true });
    expect(registry.getCodexSession("relay-1")?.status).toBeNull();
    expect(registry.acceptCodexMessage({
      relayId: "relay-1", userId: "owner-1", message: status(3),
    })).toEqual({ ok: false, error: "CODEX_CONTEXT_STALE" });
    expect(registry.acceptCodexMessage({
      relayId: "relay-1", userId: "owner-1", message: status(4),
    })).toEqual({ ok: true });
  });

  test("notifies private Codex-context observers when a relay unregisters", async () => {
    const registry = new InMemoryRelayRegistry();
    const invalidations: Array<{ relayId: string; errorCode: string }> = [];
    registry.onCodexContextInvalidated((relayId, errorCode) => {
      invalidations.push({ relayId, errorCode });
    });
    await registry.register("relay-1", "owner-1", CAPS, () => {}, 8, "desktop-1", 0, "token-row-1");

    await registry.unregister("relay-1");

    expect(invalidations).toEqual([
      { relayId: "relay-1", errorCode: "CODEX_RELAY_UNAVAILABLE" },
    ]);
  });

  test("notifies private Codex-context observers for registration replacement and capability updates", async () => {
    const registry = new InMemoryRelayRegistry();
    const invalidations: Array<{ relayId: string; errorCode: string }> = [];
    registry.onCodexContextInvalidated((relayId, errorCode) => {
      invalidations.push({ relayId, errorCode });
    });
    await registry.register("relay-1", "owner-1", CAPS, () => {}, 8, "desktop-1", 0, "token-row-1");
    await registry.register("relay-1", "owner-1", CAPS, () => {}, 8, "desktop-2", 1, "token-row-2");
    expect(registry.updateCapabilities({
      relayId: "relay-1", userId: "owner-1", desktopSessionId: "desktop-2",
      capabilityRevision: 2, capabilities: CAPS,
    })).toEqual({ ok: true });

    expect(invalidations).toEqual([
      { relayId: "relay-1", errorCode: "CODEX_CONTEXT_STALE" },
      { relayId: "relay-1", errorCode: "CODEX_CONTEXT_STALE" },
    ]);
  });

  test("stops notifying an unsubscribed Codex-context observer", async () => {
    const registry = new InMemoryRelayRegistry();
    let notifications = 0;
    const unsubscribe = registry.onCodexContextInvalidated(() => {
      notifications++;
    });
    await registry.register("relay-1", "owner-1", CAPS, () => {}, 8, "desktop-1", 0, "token-row-1");

    unsubscribe();
    await registry.unregister("relay-1");

    expect(notifications).toBe(0);
  });

  test("isolates throwing Codex-context observers so later observers still run", async () => {
    const registry = new InMemoryRelayRegistry();
    const invalidations: Array<{ relayId: string; errorCode: string }> = [];
    registry.onCodexContextInvalidated(() => {
      throw new Error("observer failed");
    });
    registry.onCodexContextInvalidated((relayId, errorCode) => {
      invalidations.push({ relayId, errorCode });
    });
    await registry.register("relay-1", "owner-1", CAPS, () => {}, 8, "desktop-1", 0, "token-row-1");

    await registry.unregister("relay-1");

    expect(invalidations).toEqual([
      { relayId: "relay-1", errorCode: "CODEX_RELAY_UNAVAILABLE" },
    ]);
  });

  test("bounds replay cache capacity and expires retained entries by TTL", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "owner-1", CAPS, () => {}, 8, "desktop-1", 0, "token-row-1");
    const ack = registry.getV8Acknowledgement("relay-1")!;
    let deliveries = 0;
    registry.onCodexMessage(() => { deliveries++; });
    const request = (index: number): RelayCodexRequestMessage => ({
      type: "relay:codex-request",
      scope: {
        relayId: "relay-1", relaySessionId: ack.relaySessionId,
        desktopSessionId: "desktop-1", pairingGenerationRef: ack.pairingGenerationRef,
        selectedProtocolVersion: 8, capabilityRevision: 0,
        profileHandle: "profile", profileGeneration: 1, accountGeneration: 2,
        runtimeGeneration: 3, childGeneration: 4,
        bindingId: "binding", bindingGeneration: 5, taskId: "task", jobId: "job",
        threadId: "thread",
        workspace: {
          workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
          issuedAt: "2026-07-26T10:00:00.000Z", expiresAt: "2026-07-26T11:00:00.000Z",
        },
        turnId: "turn",
        eventId: `event-${index}`, itemId: `item-${index}`, requestRef: `request-${index}`,
      },
      request: {
        kind: "command_approval",
        reason: "not_provided",
        command: { detail: "not_provided", actionKinds: [] },
        choices: ["accept", "decline"],
        expiresAt: "2026-07-26T10:30:00.000Z",
      },
    });
    for (let index = 0; index <= CODEX_RELAY_MAX_REPLAY_ENTRIES; index++) {
      expect(registry.acceptCodexMessage({
        relayId: "relay-1", userId: "owner-1", message: request(index),
      }).ok).toBe(true);
    }
    expect(deliveries).toBe(CODEX_RELAY_MAX_REPLAY_ENTRIES + 1);
    expect(registry.acceptCodexMessage({
      relayId: "relay-1", userId: "owner-1", message: request(0),
    })).toEqual({ ok: true });
    expect(deliveries).toBe(CODEX_RELAY_MAX_REPLAY_ENTRIES + 2);

    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      const ttlRequest = request(20_000);
      expect(registry.acceptCodexMessage({
        relayId: "relay-1", userId: "owner-1", message: ttlRequest,
      })).toEqual({ ok: true });
      const deliveredAtInsert = deliveries;
      expect(registry.acceptCodexMessage({
        relayId: "relay-1", userId: "owner-1", message: ttlRequest,
      })).toEqual({ ok: true });
      expect(deliveries).toBe(deliveredAtInsert);
      now += CODEX_RELAY_REPLAY_CACHE_TTL_MS + 1;
      expect(registry.acceptCodexMessage({
        relayId: "relay-1", userId: "owner-1", message: ttlRequest,
      })).toEqual({ ok: true });
      expect(deliveries).toBe(deliveredAtInsert + 1);
    } finally {
      Date.now = originalNow;
    }
  });
});
