import { describe, expect, test } from "bun:test";
import type { RelayCapabilities } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const DESKTOP_CAPABILITIES: RelayCapabilities = { profile: "desktop-agent" };

describe("InMemoryRelayRegistry authenticated desktop sessions", () => {
  test("projects a non-Codex desktop relay without making it a Codex session", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1", "owner-1", DESKTOP_CAPABILITIES, () => {}, 8, "desktop-1", 3, "pairing-1",
    );

    const session = registry.getAuthenticatedDesktopSession("relay-1", "owner-1");
    expect(session).toMatchObject({
      relayId: "relay-1",
      userId: "owner-1",
      desktopSessionId: "desktop-1",
      selectedProtocolVersion: 8,
      capabilityRevision: 3,
    });
    expect(typeof session?.relaySessionId).toBe("string");
    expect(typeof session?.pairingGenerationRef).toBe("string");
    expect(session?.pairingGenerationRef).not.toBe("pairing-1");
    expect(registry.getCodexSession("relay-1", "owner-1")).toBeNull();
  });

  test("fails closed for the wrong user and incomplete or headless topology", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("desktop", "owner-1", DESKTOP_CAPABILITIES, () => {}, 8, "desktop-1", 0, "pairing-1");
    await registry.register("no-pairing", "owner-1", DESKTOP_CAPABILITIES, () => {}, 8, "desktop-1", 0);
    await registry.register("no-desktop", "owner-1", DESKTOP_CAPABILITIES, () => {}, 8, undefined, 0, "pairing-1");
    await registry.register("headless", "owner-1", { profile: "device-relay" }, () => {}, 8, "desktop-1", 0, "pairing-1");
    await registry.register("legacy", "owner-1", DESKTOP_CAPABILITIES, () => {}, 7, "desktop-1", 0, "pairing-1");

    expect(registry.getAuthenticatedDesktopSession("desktop", "owner-2")).toBeNull();
    expect(registry.getAuthenticatedDesktopSession("no-pairing")).toBeNull();
    expect(registry.getAuthenticatedDesktopSession("no-desktop")).toBeNull();
    expect(registry.getAuthenticatedDesktopSession("headless")).toBeNull();
    expect(registry.getAuthenticatedDesktopSession("legacy")).toBeNull();
  });

  test("rotates live socket identity on re-registration and keeps pairing references opaque", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "owner-1", DESKTOP_CAPABILITIES, () => {}, 8, "desktop-1", 0, "pairing-1");
    const first = registry.getAuthenticatedDesktopSession("relay-1")!;

    await registry.register("relay-1", "owner-1", DESKTOP_CAPABILITIES, () => {}, 8, "desktop-1", 0, "pairing-2");
    const second = registry.getAuthenticatedDesktopSession("relay-1")!;

    expect(second.relaySessionId).not.toBe(first.relaySessionId);
    expect(second.pairingGenerationRef).not.toBe(first.pairingGenerationRef);
    expect(second.pairingGenerationRef).not.toBe("pairing-2");
  });
});
