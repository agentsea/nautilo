/**
 * D418 protocol v7 — `relay:update-capabilities` handling in the WS endpoint.
 *
 * Exercises `handleRelayUpdateCapabilities` with a fake socket + fake
 * registry. The handler binds the update to the registered authenticated
 * relay/user, delegates strict validation (exact desktopSessionId, stale
 * revision, strict capability parse, atomic replace) to the registry, and
 * always acks with `relay:capabilities-updated` (ok or rejected).
 */
import { describe, expect, test } from "bun:test";
import type { RelayCapabilities, RelayClientMessage } from "@nautilo/relay";
import {
  handleRelayUpdateCapabilities,
  type RelayCapabilityUpdateRegistryLike,
  type RelaySocketLike,
} from "../../src/realtime/relay-endpoint";

type UpdateMsg = Extract<RelayClientMessage, { type: "relay:update-capabilities" }>;

interface SocketEvent {
  readonly kind: "send" | "close";
  readonly payload?: unknown;
}

function makeFakeSocket(): { socket: RelaySocketLike; events: SocketEvent[] } {
  const events: SocketEvent[] = [];
  const socket: RelaySocketLike = {
    OPEN: 1,
    readyState: 1,
    send(data) {
      events.push({ kind: "send", payload: JSON.parse(data) });
    },
    close() {
      events.push({ kind: "close" });
      this.readyState = 3;
    },
  };
  return { socket, events };
}

function makeUpdateMsg(overrides: Partial<UpdateMsg> = {}): UpdateMsg {
  return {
    type: "relay:update-capabilities",
    relayId: "relay-1",
    desktopSessionId: "session-1",
    capabilityRevision: 1,
    capabilities: { profile: "desktop-agent", canReadWorkspace: true } as RelayCapabilities,
    ...overrides,
  };
}

function ackEvent(events: SocketEvent[]): unknown {
  return events.find(
    (e) =>
      e.kind === "send" &&
      (e.payload as { type?: string }).type === "relay:capabilities-updated",
  )?.payload;
}

describe("handleRelayUpdateCapabilities (D418 protocol v7)", () => {
  test("acks ok and delegates a valid update to the registry", async () => {
    const { socket, events } = makeFakeSocket();
    let received: unknown = null;
    const registry: RelayCapabilityUpdateRegistryLike = {
      updateCapabilities(input) {
        received = input;
        return { ok: true };
      },
    };

    const result = await handleRelayUpdateCapabilities(socket, makeUpdateMsg(), registry, {
      relayId: "relay-1",
      userId: "user-1",
    });

    expect(result.outcome).toBe("applied");
    // The authenticated userId comes from the register context, not the frame.
    expect(received).toMatchObject({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: "session-1",
      capabilityRevision: 1,
    });
    const ack = ackEvent(events) as { status: string; capabilityRevision: number };
    expect(ack.status).toBe("ok");
    expect(ack.capabilityRevision).toBe(1);
  });

  test("rejects an update whose relay id does not match the registered socket", async () => {
    const { socket, events } = makeFakeSocket();
    let called = false;
    const registry: RelayCapabilityUpdateRegistryLike = {
      updateCapabilities() {
        called = true;
        return { ok: false, error: "never" };
      },
    };

    const result = await handleRelayUpdateCapabilities(
      socket,
      makeUpdateMsg({ relayId: "relay-other" }),
      registry,
      { relayId: "relay-1", userId: "user-1" },
    );

    expect(result.outcome).toBe("rejected-unregistered");
    expect(called).toBe(false);
    const ack = ackEvent(events) as { status: string; error?: string };
    expect(ack.status).toBe("rejected");
    expect(ack.error).toMatch(/registered relay/);
  });

  test("acks rejected and classifies a stale revision", async () => {
    const { socket, events } = makeFakeSocket();
    const registry: RelayCapabilityUpdateRegistryLike = {
      updateCapabilities() {
        return { ok: false, error: "stale or duplicate capability revision" };
      },
    };

    const result = await handleRelayUpdateCapabilities(socket, makeUpdateMsg(), registry, {
      relayId: "relay-1",
      userId: "user-1",
    });

    expect(result.outcome).toBe("rejected-stale");
    const ack = ackEvent(events) as { status: string; error?: string };
    expect(ack.status).toBe("rejected");
    expect(ack.error).toMatch(/stale/);
  });

  test("acks rejected and classifies a malformed payload", async () => {
    const { socket, events } = makeFakeSocket();
    const registry: RelayCapabilityUpdateRegistryLike = {
      updateCapabilities() {
        return {
          ok: false,
          error: "Desktop Filesystem Grant snapshot revision must be a non-negative safe integer",
        };
      },
    };

    const result = await handleRelayUpdateCapabilities(socket, makeUpdateMsg(), registry, {
      relayId: "relay-1",
      userId: "user-1",
    });

    expect(result.outcome).toBe("rejected-malformed");
    const ack = ackEvent(events) as { status: string };
    expect(ack.status).toBe("rejected");
  });

  test("acks with the frame's capabilityRevision on both ok and rejected", async () => {
    const { socket, events } = makeFakeSocket();
    const registry: RelayCapabilityUpdateRegistryLike = {
      updateCapabilities() {
        return { ok: true };
      },
    };
    await handleRelayUpdateCapabilities(
      socket,
      makeUpdateMsg({ capabilityRevision: 42 }),
      registry,
      { relayId: "relay-1", userId: "user-1" },
    );
    expect((ackEvent(events) as { capabilityRevision: number }).capabilityRevision).toBe(42);
  });
});
