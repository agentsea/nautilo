import { describe, expect, it } from "bun:test";
import {
  RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION,
  type RelayCapabilities,
} from "@nautilo/relay";
import {
  InMemoryRelayRegistry,
  type InMemoryRelayRegistryRemotePresenceChangedInput,
} from "../../src/relay-registry";

const noop = () => {};

function desktopCapabilities(overrides: Partial<RelayCapabilities> = {}): RelayCapabilities {
  return {
    profile: "desktop-agent",
    allowedRoots: ["/Users/test/project"],
    mcpTools: [{ serverName: "local", toolNames: ["read"] }],
    ...overrides,
  };
}

const FORBIDDEN_REMOTE_PRESENCE_CAPABILITY_KEYS = [
  "dataDir",
  "toolsBin",
  "userHome",
  "workspaceRoot",
  "currentFolderRoot",
  "allowedRoots",
  "allowedHosts",
  "securityLevel",
  "mcpTools",
  "workstationGrantSnapshot",
  "workstationProfileSnapshot",
] as const;

function expectRemotePresenceCapabilitiesToBeSafe(
  capabilities: object | undefined,
): void {
  expect(capabilities).toBeDefined();
  expect(capabilities).toHaveProperty("profile", "desktop-agent");
  for (const key of FORBIDDEN_REMOTE_PRESENCE_CAPABILITY_KEYS) {
    expect(capabilities).not.toHaveProperty(key);
  }
}

describe("InMemoryRelayRegistry remote presence snapshots (D458)", () => {
  it("filters to the requested owner, requires a server-derived generation, and returns sanitized copies", async () => {
    const registry = new InMemoryRelayRegistry();
    const source = {
      ...desktopCapabilities(),
      canControlDesktop: true,
      canControlBrowser: true,
      canUseTerminal: true,
      canSeeDesktop: true,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
      dataDir: "/private/data",
      toolsBin: "/private/bin",
      userHome: "/Users/test",
      workspaceRoot: "/Users/test/Documents/Nautilo",
      currentFolderRoot: "/Users/test/Projects/private-project",
      allowedHosts: ["private.example"],
      securityLevel: "permissive",
      workstationGrantSnapshot: { grantId: "must-not-leak" },
      workstationProfileSnapshot: { profileId: "must-not-leak" },
      unknownTransportField: "must not cross the registry seam",
    } as unknown as RelayCapabilities;
    await registry.register(
      "relay-alice",
      "alice",
      source,
      noop,
      RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION,
      "desktop-alice",
      4,
      "generation-alice",
    );
    await registry.register(
      "relay-bob",
      "bob",
      desktopCapabilities(),
      noop,
      7,
      "desktop-bob",
      1,
      "generation-bob",
    );
    // A live connection with no server-derived generation is deliberately not
    // eligible for remote-host projection.
    await registry.register("relay-unpaired", "alice", desktopCapabilities(), noop, 7);

    const alice = registry.snapshotForUser("alice");
    expect(alice).toHaveLength(1);
    expect(alice[0]).toMatchObject({
      relayId: "relay-alice",
      userId: "alice",
      pairingGeneration: "generation-alice",
      desktopSessionId: "desktop-alice",
      protocolVersion: RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION,
      capabilityRevision: 4,
    });
    expect(alice[0]?.capabilities).toEqual({
      profile: "desktop-agent",
      canControlDesktop: true,
      canControlBrowser: true,
      canUseTerminal: true,
      canSeeDesktop: true,
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
    });
    expectRemotePresenceCapabilitiesToBeSafe(alice[0]?.capabilities);
    expect(alice[0]?.capabilities).not.toHaveProperty("unknownTransportField");

    // Root metadata remains available only through the authenticated registry
    // capability seam for exact-host binding. Remote presence deliberately
    // carries readiness booleans, never raw local paths.
    expect(registry.getCapabilities("relay-alice")).toMatchObject({
      workspaceRoot: "/Users/test/Documents/Nautilo",
      currentFolderRoot: "/Users/test/Projects/private-project",
    });

    // Neither a caller's registration object nor a returned snapshot can
    // mutate registry-owned state.
    source.canControlDesktop = false;
    source.allowedRoots?.push("/should-not-leak");
    (alice[0]?.capabilities as { canControlDesktop?: boolean } | undefined)!
      .canControlDesktop = false;
    const fresh = registry.snapshotForUser("alice")[0];
    expect(fresh?.capabilities.canControlDesktop).toBe(true);
    expectRemotePresenceCapabilitiesToBeSafe(fresh?.capabilities);
    expect(registry.snapshotForUser("bob")).toHaveLength(1);
  });

  it("publishes register, accepted replacement, and unregister only after their mutation", async () => {
    const calls: Array<
      InMemoryRelayRegistryRemotePresenceChangedInput & { visibleRelayCount: number }
    > = [];
    const registry = new InMemoryRelayRegistry({
      onRemotePresenceChanged: (input) => {
        calls.push({
          ...input,
          visibleRelayCount: registry.snapshotForUser("alice").length,
        });
      },
    });

    await registry.register(
      "relay-1",
      "alice",
      desktopCapabilities({ canControlDesktop: false }),
      noop,
      RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION,
      "desktop-1",
      1,
      "generation-1",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      relayId: "relay-1",
      previous: null,
      visibleRelayCount: 1,
    });
    expect(calls[0]?.current?.capabilities.canControlDesktop).toBe(false);
    expectRemotePresenceCapabilitiesToBeSafe(calls[0]?.current?.capabilities);

    expect(
      registry.updateCapabilities({
        relayId: "relay-1",
        userId: "alice",
        desktopSessionId: "desktop-1",
        capabilityRevision: 2,
        capabilities: desktopCapabilities({ canControlDesktop: true }),
      }),
    ).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.previous?.capabilities.canControlDesktop).toBe(false);
    expect(calls[1]?.current?.capabilities.canControlDesktop).toBe(true);
    expect(calls[1]?.current?.capabilityRevision).toBe(2);
    expect(calls[1]?.visibleRelayCount).toBe(1);
    expectRemotePresenceCapabilitiesToBeSafe(calls[1]?.previous?.capabilities);
    expectRemotePresenceCapabilitiesToBeSafe(calls[1]?.current?.capabilities);

    // Callback snapshots are independently copied too; a subscriber cannot
    // mutate future registry reads or a later callback's view.
    (calls[1]?.current?.capabilities as { canControlDesktop?: boolean } | undefined)!
      .canControlDesktop = false;
    expect(registry.snapshotForUser("alice")[0]?.capabilities.canControlDesktop).toBe(true);

    await registry.unregister("relay-1");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({
      relayId: "relay-1",
      current: null,
      visibleRelayCount: 0,
    });
    expect(calls[2]?.previous?.pairingGeneration).toBe("generation-1");
  });

  it("keeps named desktop roots private across accepted capability updates", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "alice",
      desktopCapabilities({
        workspaceRoot: "/Users/alice/Documents/Nautilo",
        currentFolderRoot: "/Users/alice/Projects/one",
      }),
      noop,
      9,
      "desktop-1",
      1,
      "generation-1",
    );

    expect(
      registry.updateCapabilities({
        relayId: "relay-1",
        userId: "alice",
        desktopSessionId: "desktop-1",
        capabilityRevision: 2,
        capabilities: desktopCapabilities({
          workspaceRoot: "/Users/alice/Documents/Nautilo",
          currentFolderRoot: "/Users/alice/Projects/two",
        }),
      }),
    ).toEqual({ ok: true });

    expect(registry.getCapabilities("relay-1")).toMatchObject({
      workspaceRoot: "/Users/alice/Documents/Nautilo",
      currentFolderRoot: "/Users/alice/Projects/two",
    });
    const presence = registry.snapshotForUser("alice")[0];
    expectRemotePresenceCapabilitiesToBeSafe(presence?.capabilities);
  });

  it("does not publish heartbeats, but does publish heartbeat-timeout removal after deletion", async () => {
    const calls: InMemoryRelayRegistryRemotePresenceChangedInput[] = [];
    const registry = new InMemoryRelayRegistry({
      onRemotePresenceChanged: (input) => calls.push(input),
    });
    const realNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    try {
      await registry.register(
        "relay-1",
        "alice",
        desktopCapabilities(),
        noop,
        7,
        "desktop-1",
        0,
        "generation-1",
      );
      calls.length = 0;

      now += 1;
      registry.updatePresence("relay-1");
      expect(calls).toEqual([]);

      now += 120_001;
      (registry as unknown as { sweepStale(): void }).sweepStale();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ relayId: "relay-1", current: null });
      expect(calls[0]?.previous?.pairingGeneration).toBe("generation-1");
      expect(registry.snapshotForUser("alice")).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  });

  it("exposes every duplicate live pairing generation so projection can fail closed", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "alice",
      desktopCapabilities(),
      noop,
      7,
      "desktop-1",
      0,
      "duplicated-generation",
    );
    await registry.register(
      "relay-2",
      "alice",
      desktopCapabilities(),
      noop,
      7,
      "desktop-2",
      0,
      "duplicated-generation",
    );

    expect(
      registry
        .snapshotForUser("alice")
        .filter((snapshot) => snapshot.pairingGeneration === "duplicated-generation")
        .map((snapshot) => snapshot.relayId)
        .sort(),
    ).toEqual(["relay-1", "relay-2"]);
  });
});
