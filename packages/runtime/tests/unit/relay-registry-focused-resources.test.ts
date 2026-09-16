/**
 * D423 4.1.3 — `InMemoryRelayRegistry.snapshotForFocusedResource` unit tests.
 *
 * Pins the server-private snapshot the focused-local-file resolver consumes:
 * a connected relay's owner-match + protocol version + capability profile.
 * The snapshot must carry ONLY the fields the resolver needs (no send
 * callback, no byte transport) and return `null` when the relay is not
 * connected, so the resolver fails closed without a byte read or upload.
 */
import { describe, expect, it } from "bun:test";
import type { RelayCapabilities, RelayServerMessage } from "@nautilo/relay";
import { canDispatchApplyPatchToFocusedRelay, InMemoryRelayRegistry } from "../../src/relay-registry";

const DESKTOP_CAPS: RelayCapabilities = {
  profile: "desktop-agent",
  localFileExecution: true,
  applyPatchExecution: true,
  canRunOffice: true,
  allowedRoots: ["/Users/alice/demo"],
};

function noopSend(): (msg: RelayServerMessage) => void {
  return () => {};
}

describe("InMemoryRelayRegistry.snapshotForFocusedResource (D423 4.1.3)", () => {
  it("returns null when the relay is not connected", () => {
    const reg = new InMemoryRelayRegistry();
    expect(reg.snapshotForFocusedResource("relay-1", "user-1")).toBeNull();
  });

  it("snapshots a connected, owner-paired desktop-agent relay at v4+", () => {
    const reg = new InMemoryRelayRegistry();
    reg.register("relay-1", "user-1", DESKTOP_CAPS, noopSend(), 4);
    const snap = reg.snapshotForFocusedResource("relay-1", "user-1");
    expect(snap).not.toBeNull();
    expect(snap!.ownedByActor).toBe(true);
    expect(snap!.protocolVersion).toBe(4);
    expect(snap!.profile).toBe("desktop-agent");
    expect(snap!.localFileExecution).toBe(true);
    expect(snap!.applyPatchExecution).toBe(true);
    expect(snap!.canRunOffice).toBe(true);
    expect(snap!.allowedRoots).toEqual(["/Users/alice/demo"]);
  });

  it("marks ownedByActor=false when the relay belongs to a different user", () => {
    const reg = new InMemoryRelayRegistry();
    reg.register("relay-1", "user-1", DESKTOP_CAPS, noopSend(), 4);
    const snap = reg.snapshotForFocusedResource("relay-1", "user-2");
    expect(snap).not.toBeNull();
    expect(snap!.ownedByActor).toBe(false);
  });

  it("reports localFileExecution=false when the relay omits the capability", () => {
    const reg = new InMemoryRelayRegistry();
    const caps: RelayCapabilities = {
      profile: "desktop-agent",
      allowedRoots: [],
    };
    reg.register("relay-2", "user-1", caps, noopSend(), 4);
    const snap = reg.snapshotForFocusedResource("relay-2", "user-1");
    expect(snap!.localFileExecution).toBe(false);
    expect(snap!.applyPatchExecution).toBe(false);
    expect(snap!.canRunOffice).toBe(false);
  });

  it("reports the headless device-relay profile (resolver must reject it)", () => {
    const reg = new InMemoryRelayRegistry();
    const caps: RelayCapabilities = {
      profile: "device-relay",
      allowedRoots: [],
    };
    reg.register("relay-3", "user-1", caps, noopSend(), 4);
    const snap = reg.snapshotForFocusedResource("relay-3", "user-1");
    expect(snap!.profile).toBe("device-relay");
  });

  it("reports protocol version <4 (resolver must reject it)", () => {
    const reg = new InMemoryRelayRegistry();
    reg.register("relay-4", "user-1", DESKTOP_CAPS, noopSend(), 3);
    const snap = reg.snapshotForFocusedResource("relay-4", "user-1");
    expect(snap!.protocolVersion).toBe(3);
  });

  it("returns null after the relay unregisters (disconnect)", () => {
    const reg = new InMemoryRelayRegistry();
    reg.register("relay-5", "user-1", DESKTOP_CAPS, noopSend(), 4);
    expect(reg.snapshotForFocusedResource("relay-5", "user-1")).not.toBeNull();
    void reg.unregister("relay-5");
    expect(reg.snapshotForFocusedResource("relay-5", "user-1")).toBeNull();
  });

  it("never exposes the send callback or byte transport in the snapshot", () => {
    const reg = new InMemoryRelayRegistry();
    reg.register("relay-6", "user-1", DESKTOP_CAPS, noopSend(), 4);
    const snap = reg.snapshotForFocusedResource("relay-6", "user-1");
    expect(snap).not.toBeNull();
    expect(typeof (snap as unknown as Record<string, unknown>)["send"]).not.toBe("function");
  });

  it("gates the exact focused relay's apply-patch capability without selecting a fallback", () => {
    const reg = new InMemoryRelayRegistry();
    reg.register("pinned", "user-1", { profile: "desktop-agent" }, noopSend(), 9);
    reg.register("other", "user-1", DESKTOP_CAPS, noopSend(), 9);

    expect(canDispatchApplyPatchToFocusedRelay(reg.snapshotForFocusedResource("pinned", "user-1"))).toBe(false);
    expect(canDispatchApplyPatchToFocusedRelay(reg.snapshotForFocusedResource("other", "user-1"))).toBe(true);
  });
});
