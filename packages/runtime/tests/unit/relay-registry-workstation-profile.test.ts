import { describe, expect, it } from "bun:test";
import type { RelayCapabilities, RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const CAPS: RelayCapabilities = { profile: "desktop-agent" } as RelayCapabilities;

const VALID_PROFILE_SNAPSHOT = {
  profileId: "profile-developer-workstation",
  profileRevision: 3,
  grantIds: ["grant-1", "grant-2"],
  protectedPolicyVersion: 2,
  networkMode: "isolated" as const,
  capabilities: [
    { id: "cap-bun", backend: "sandboxed" as const },
    { id: "cap-docker-compose", backend: "brokered_host_service" as const },
  ],
};

const VALID_GRANT_SNAPSHOT = {
  revision: 7,
  instanceId: "instance-1",
  agentScope: "all_owned_agents" as const,
  grants: [
    {
      id: "grant-1",
      canonicalRoot: "/path/to/project",
      access: ["read", "create_modify"] as const,
      policyVersion: 2,
      lifetime: "durable" as const,
    },
  ],
};

describe("InMemoryRelayRegistry advisory Workstation Profile snapshot retention (D418)", () => {
  it("retains a valid advisory profile snapshot under the relay association", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-1",
      {
        profile: "desktop-agent",
        workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      } as RelayCapabilities,
      () => {},
      6,
    );

    expect(registry.getWorkstationProfileSnapshot("relay-1")).toEqual(VALID_PROFILE_SNAPSHOT);
    expect(
      registry.getCapabilities("relay-1")?.workstationProfileSnapshot,
    ).toEqual(VALID_PROFILE_SNAPSHOT);
  });

  it("ignores a malformed profile snapshot safely while keeping the relay registered", async () => {
    const registry = new InMemoryRelayRegistry();
    const malformed = { ...VALID_PROFILE_SNAPSHOT, networkMode: "open" };
    await registry.register(
      "relay-1",
      "user-1",
      {
        profile: "desktop-agent",
        canReadWorkspace: true,
        workstationProfileSnapshot: malformed,
      } as unknown as RelayCapabilities,
      () => {},
      6,
    );

    // Fail closed for discovery: the malformed profile snapshot is dropped, but
    // the relay stays registered and its other capabilities survive intact.
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toBeNull();
    expect(
      registry.getCapabilities("relay-1")?.workstationProfileSnapshot,
    ).toBeUndefined();
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(true);
    expect(await registry.listConnected()).toEqual(["relay-1"]);
  });

  it("drops a malformed profile snapshot but keeps a valid grant snapshot intact", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-1",
      {
        profile: "desktop-agent",
        desktopFilesystemGrantSnapshot: VALID_GRANT_SNAPSHOT,
        workstationProfileSnapshot: { ...VALID_PROFILE_SNAPSHOT, profileRevision: 0 },
      } as unknown as RelayCapabilities,
      () => {},
      9,
    );

    // The two advisory snapshots are sanitized independently: a malformed
    // profile snapshot never strips a valid grant snapshot (no partial
    // authority loss in the discovery hint).
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toBeNull();
    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")).toEqual(VALID_GRANT_SNAPSHOT);
    expect(
      registry.getCapabilities("relay-1")?.desktopFilesystemGrantSnapshot,
    ).toEqual(VALID_GRANT_SNAPSHOT);
    expect(
      registry.getCapabilities("relay-1")?.workstationProfileSnapshot,
    ).toBeUndefined();
  });

  it("leaves the profile snapshot absent when none is advertised", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "user-1", CAPS, () => {}, 6);
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toBeNull();
  });
});

describe("InMemoryRelayRegistry onUnregister hook (D418 disconnect invalidation)", () => {
  it("invokes onUnregister with the relay binding on explicit unregister", async () => {
    const calls: { relayId: string; userId: string; desktopSessionId: string | null }[] = [];
    const registry = new InMemoryRelayRegistry({
      onUnregister: (input) => calls.push(input),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent", workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-1",
      0,
    );
    await registry.unregister("relay-1");
    expect(calls).toEqual([
      { relayId: "relay-1", userId: "user-1", desktopSessionId: "desktop-session-1" },
    ]);
    // The entry is gone after unregister.
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toBeNull();
  });

  it("reports a null desktopSessionId for a headless relay unregister", async () => {
    const calls: { relayId: string; userId: string; desktopSessionId: string | null }[] = [];
    const registry = new InMemoryRelayRegistry({
      onUnregister: (input) => calls.push(input),
    });
    await registry.register("relay-1", "user-1", CAPS, () => {}, 6);
    await registry.unregister("relay-1");
    expect(calls).toEqual([
      { relayId: "relay-1", userId: "user-1", desktopSessionId: null },
    ]);
  });

  it("does not invoke onUnregister when an unknown relay unregisters", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onUnregister: () => {
        calls.push(true);
      },
    });
    await registry.unregister("never-registered");
    expect(calls).toEqual([]);
  });

  it("swallows a throwing callback so unregister + pending cleanup proceed", async () => {
    const registry = new InMemoryRelayRegistry({
      onUnregister: () => {
        throw new Error("boom");
      },
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-1",
      0,
    );
    // Must not throw — the hook error is swallowed inline.
    expect(() => registry.unregister("relay-1")).not.toThrow();
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toBeNull();
  });
});

describe("InMemoryRelayRegistry onDesktopSessionReplaced hook (D418 app-restart invalidation)", () => {
  it("fires on re-register with a DIFFERENT non-empty desktopSessionId, before the entry is replaced", async () => {
    const calls: {
      relayId: string;
      userId: string;
      previousDesktopSessionId: string;
      nextDesktopSessionId: string;
    }[] = [];
    const registry = new InMemoryRelayRegistry({
      onDesktopSessionReplaced: (input) => calls.push(input),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
    );
    // App restart: same relay/user, NEW desktop session id.
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-B",
      1,
    );
    expect(calls).toEqual([
      {
        relayId: "relay-1",
        userId: "user-1",
        previousDesktopSessionId: "desktop-session-A",
        nextDesktopSessionId: "desktop-session-B",
      },
    ]);
    // The entry is replaced with the new desktop session id.
    expect(registry.getDesktopSessionId("relay-1")).toBe("desktop-session-B");
  });

  it("does NOT fire on a reconnect that re-uses the same desktopSessionId (transient resume)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onDesktopSessionReplaced: () => calls.push(true),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
    );
    // Transient socket reconnect: same desktopSessionId — no replacement hook.
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
    );
    expect(calls).toEqual([]);
  });

  it("does NOT fire when the new register is headless (empty/undefined desktopSessionId)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onDesktopSessionReplaced: () => calls.push(true),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
    );
    // Re-register as headless (no desktopSessionId) — must not invalidate.
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "device-relay" } as RelayCapabilities,
      () => {},
      6,
    );
    expect(calls).toEqual([]);
  });

  it("does NOT fire on an explicit unregister (transient disconnect must not invalidate)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onDesktopSessionReplaced: () => calls.push(true),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
    );
    await registry.unregister("relay-1");
    expect(calls).toEqual([]);
  });

  it("does NOT fire when a different user takes the relayId (foreign binding)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onDesktopSessionReplaced: () => calls.push(true),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
    );
    // A different user registering the same relayId with a different
    // desktop session is a foreign binding, not an app-restart of the same
    // relay/user.
    await registry.register(
      "relay-1",
      "user-2",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-B",
      1,
    );
    expect(calls).toEqual([]);
  });

  it("swallows a throwing callback so registration proceeds", () => {
    const registry = new InMemoryRelayRegistry({
      onDesktopSessionReplaced: () => {
        throw new Error("boom");
      },
    });
    registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
    );
    // Must not throw — the hook error is swallowed inline and the entry is
    // still replaced.
    expect(
      registry.register(
        "relay-1",
        "user-1",
        { profile: "desktop-agent" } as RelayCapabilities,
        () => {},
        7,
        "desktop-session-B",
        1,
      ),
    ).resolves.toBeUndefined();
    expect(registry.getDesktopSessionId("relay-1")).toBe("desktop-session-B");
  });
});

describe("InMemoryRelayRegistry updateCapabilities profile snapshot (D418 protocol v7)", () => {
  const SESSION = "session-1";

  async function registeredRegistry(): Promise<InMemoryRelayRegistry> {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent", canReadWorkspace: true } as RelayCapabilities,
      () => {},
      7,
      SESSION,
      0,
    );
    return registry;
  }

  it("atomically replaces capabilities and profile snapshot on a valid update", async () => {
    const registry = await registeredRegistry();
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: false,
        workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      } as RelayCapabilities,
    });
    expect(result).toEqual({ ok: true });
    expect(registry.getCapabilityRevision("relay-1")).toBe(1);
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(false);
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toEqual(VALID_PROFILE_SNAPSHOT);
  });

  it("applies a narrower/empty grantIds + capabilities profile snapshot immediately", async () => {
    const registry = await registeredRegistry();
    // First advertise a profile binding.
    registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      } as RelayCapabilities,
    });
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toEqual(VALID_PROFILE_SNAPSHOT);
    // Then narrow to no grants / no capabilities (revoked binding) — applies immediately.
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 2,
      capabilities: {
        profile: "desktop-agent",
        workstationProfileSnapshot: {
          ...VALID_PROFILE_SNAPSHOT,
          grantIds: [],
          capabilities: [],
        },
      } as RelayCapabilities,
    });
    expect(result).toEqual({ ok: true });
    expect(registry.getWorkstationProfileSnapshot("relay-1")?.grantIds).toEqual([]);
    expect(registry.getWorkstationProfileSnapshot("relay-1")?.capabilities).toEqual([]);
  });

  it("clears the profile snapshot immediately when an update omits it", async () => {
    const registry = await registeredRegistry();
    registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      } as RelayCapabilities,
    });
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toEqual(VALID_PROFILE_SNAPSHOT);
    // An update that carries no profile snapshot clears the advisory binding.
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 2,
      capabilities: { profile: "desktop-agent", canReadWorkspace: false } as RelayCapabilities,
    });
    expect(result).toEqual({ ok: true });
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toBeNull();
  });

  it("leaves the old state intact on a malformed profile snapshot", async () => {
    const registry = await registeredRegistry();
    // Establish a known good state with a profile binding.
    registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: true,
        workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      } as RelayCapabilities,
    });
    // Malformed profile snapshot (unsupported network mode) → whole update rejected.
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 2,
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: false,
        workstationProfileSnapshot: { ...VALID_PROFILE_SNAPSHOT, networkMode: "open" },
      } as unknown as RelayCapabilities,
    });
    expect(result.ok).toBe(false);
    // Prior state intact: revision 1, canReadWorkspace true, profile snapshot preserved.
    expect(registry.getCapabilityRevision("relay-1")).toBe(1);
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(true);
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toEqual(VALID_PROFILE_SNAPSHOT);
  });

  it("leaves both prior snapshots intact when a malformed profile snapshot rejects an update", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent", canReadWorkspace: true } as RelayCapabilities,
      () => {},
      9,
      SESSION,
      0,
    );
    registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: true,
        desktopFilesystemGrantSnapshot: VALID_GRANT_SNAPSHOT,
        workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      } as RelayCapabilities,
    });
    // A malformed profile snapshot rejects the whole update; the prior grant
    // snapshot and profile snapshot both remain intact (atomic replacement).
    const result = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 2,
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: false,
        desktopFilesystemGrantSnapshot: { ...VALID_GRANT_SNAPSHOT, grants: [] },
        workstationProfileSnapshot: { ...VALID_PROFILE_SNAPSHOT, profileId: "" },
      } as unknown as RelayCapabilities,
    });
    expect(result.ok).toBe(false);
    expect(registry.getCapabilityRevision("relay-1")).toBe(1);
    expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(true);
    expect(registry.getDesktopFilesystemGrantSnapshot("relay-1")).toEqual(VALID_GRANT_SNAPSHOT);
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toEqual(VALID_PROFILE_SNAPSHOT);
  });

  it("forwards an unrelated dispatch without touching the profile snapshot", async () => {
    const registry = await registeredRegistry();
    const sent: RelayServerMessage[] = [];
    // Re-register with a profile snapshot and a capturing send fn.
    await registry.register(
      "relay-1",
      "user-1",
      {
        profile: "desktop-agent",
        workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      } as RelayCapabilities,
      (message) => sent.push(message),
      7,
      SESSION,
      0,
    );
    const pending = registry.dispatch("relay-1", {
      toolName: "run_shell",
      args: {},
      impact: "low",
      approvalObtained: true,
    });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    registry.resolveDispatch(dispatch.correlationId, { status: "ok" });
    await pending;
    // Dispatch is independent of the advisory profile binding snapshot.
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toEqual(VALID_PROFILE_SNAPSHOT);
  });
});

describe("InMemoryRelayRegistry onPairingGenerationChanged hook (D418 Commit 2 re-pair invalidation)", () => {
  it("fires on re-register with the SAME desktopSessionId but a DIFFERENT pairingGeneration", async () => {
    const calls: {
      relayId: string;
      userId: string;
      desktopSessionId: string;
      previousPairingGeneration: string;
      nextPairingGeneration: string;
    }[] = [];
    const registry = new InMemoryRelayRegistry({
      onPairingGenerationChanged: (input) => calls.push(input),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
      "pairing-A",
    );
    // Re-pair: same relay/user/desktop session, NEW server-derived pairing generation.
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
      "pairing-B",
    );
    expect(calls).toEqual([
      {
        relayId: "relay-1",
        userId: "user-1",
        desktopSessionId: "desktop-session-A",
        previousPairingGeneration: "pairing-A",
        nextPairingGeneration: "pairing-B",
      },
    ]);
    expect(registry.getPairingGeneration("relay-1")).toBe("pairing-B");
  });

  it("does NOT fire on a reconnect that re-uses both desktopSessionId and pairingGeneration", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onPairingGenerationChanged: () => calls.push(true),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
      "pairing-A",
    );
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
      "pairing-A",
    );
    expect(calls).toEqual([]);
  });

  it("does NOT fire when the desktopSessionId also differs (onDesktopSessionReplaced owns that path)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onPairingGenerationChanged: () => calls.push(true),
      onDesktopSessionReplaced: () => calls.push("desktop-replaced"),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
      "pairing-A",
    );
    // Both desktop session AND pairing generation change — only the desktop-
    // session replacement hook fires (it invalidates by the dead desktop id).
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-B",
      1,
      "pairing-B",
    );
    expect(calls).toEqual(["desktop-replaced"]);
  });

  it("does NOT fire when the new register is headless (no desktopSessionId)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onPairingGenerationChanged: () => calls.push(true),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
      "pairing-A",
    );
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "device-relay" } as RelayCapabilities,
      () => {},
      6,
    );
    expect(calls).toEqual([]);
  });

  it("does NOT fire when a different user takes the relayId (foreign binding)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onPairingGenerationChanged: () => calls.push(true),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
      "pairing-A",
    );
    await registry.register(
      "relay-1",
      "user-2",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
      "pairing-B",
    );
    expect(calls).toEqual([]);
  });

  it("swallows a throwing callback so registration proceeds", async () => {
    const registry = new InMemoryRelayRegistry({
      onPairingGenerationChanged: () => {
        throw new Error("boom");
      },
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
      "pairing-A",
    );
    expect(() =>
      registry.register(
        "relay-1",
        "user-1",
        { profile: "desktop-agent" } as RelayCapabilities,
        () => {},
        7,
        "desktop-session-A",
        1,
        "pairing-B",
      ),
    ).not.toThrow();
    expect(registry.getPairingGeneration("relay-1")).toBe("pairing-B");
  });
});

describe("InMemoryRelayRegistry getPairingGeneration (D418 Commit 2)", () => {
  it("returns the server-derived pairing generation stamped at register", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-1",
      1,
      "tok-42",
    );
    expect(registry.getPairingGeneration("relay-1")).toBe("tok-42");
  });

  it("returns null for an unknown relay or a relay that carried no pairing generation", async () => {
    const registry = new InMemoryRelayRegistry();
    expect(registry.getPairingGeneration("never-registered")).toBeNull();
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      6,
    );
    expect(registry.getPairingGeneration("relay-1")).toBeNull();
  });
});

describe("InMemoryRelayRegistry onWorkstationProfileSnapshotCleared hook (D418 reconnect/session split-brain fix)", () => {
  const SESSION = "desktop-session-A";
  const PAIRING = "pairing-A";

  async function registerWithProfile(
    registry: InMemoryRelayRegistry,
    overrides: { desktopSessionId?: string; pairingGeneration?: string } = {},
  ): Promise<void> {
    await registry.register(
      "relay-1",
      "user-1",
      {
        profile: "desktop-agent",
        workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      } as RelayCapabilities,
      () => {},
      7,
      overrides.desktopSessionId ?? SESSION,
      1,
      overrides.pairingGeneration ?? PAIRING,
    );
  }

  it("fires on re-register present→absent with the EXISTING binding identity", async () => {
    const calls: {
      relayId: string;
      userId: string;
      desktopSessionId: string;
      pairingGeneration?: string;
    }[] = [];
    const registry = new InMemoryRelayRegistry({
      onWorkstationProfileSnapshotCleared: (input) => calls.push(input),
    });
    await registerWithProfile(registry);
    // Re-register (e.g. reconnect with frozen pre-activation caps) with NO
    // profile snapshot, SAME desktopSessionId + pairingGeneration.
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      SESSION,
      1,
      PAIRING,
    );
    expect(calls).toEqual([
      {
        relayId: "relay-1",
        userId: "user-1",
        desktopSessionId: SESSION,
        pairingGeneration: PAIRING,
      },
    ]);
    // The entry is replaced with no profile snapshot.
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toBeNull();
  });

  it("does NOT fire on a reconnect that re-advertises the profile snapshot (present→present)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onWorkstationProfileSnapshotCleared: () => calls.push(true),
    });
    await registerWithProfile(registry);
    await registerWithProfile(registry);
    expect(calls).toEqual([]);
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toEqual(VALID_PROFILE_SNAPSHOT);
  });

  it("does NOT fire on absent→absent (no prior snapshot) for an initial register", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onWorkstationProfileSnapshotCleared: () => calls.push(true),
    });
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      SESSION,
      1,
      PAIRING,
    );
    expect(calls).toEqual([]);
  });

  it("does NOT fire on absent→present (a profile binding is being added)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onWorkstationProfileSnapshotCleared: () => calls.push(true),
    });
    // First register: no profile snapshot.
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      SESSION,
      1,
      PAIRING,
    );
    // Re-register now advertising a profile snapshot — absent→present, no fire.
    await registerWithProfile(registry);
    expect(calls).toEqual([]);
  });

  it("does NOT fire when the existing entry had no desktopSessionId (headless)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onWorkstationProfileSnapshotCleared: () => calls.push(true),
    });
    // A headless relay somehow carried a profile snapshot but no desktop
    // session — it can never host a Full Workstation session, so the hook
    // must not fire (no session to invalidate).
    await registry.register(
      "relay-1",
      "user-1",
      {
        profile: "desktop-agent",
        workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      } as RelayCapabilities,
      () => {},
      7,
      undefined,
      1,
    );
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      undefined,
      1,
    );
    expect(calls).toEqual([]);
  });

  it("does NOT fire when a different user takes the relayId (foreign binding)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onWorkstationProfileSnapshotCleared: () => calls.push(true),
    });
    await registerWithProfile(registry);
    await registry.register(
      "relay-1",
      "user-2",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      SESSION,
      1,
      PAIRING,
    );
    expect(calls).toEqual([]);
  });

  it("swallows a throwing callback so registration proceeds", async () => {
    const registry = new InMemoryRelayRegistry({
      onWorkstationProfileSnapshotCleared: () => {
        throw new Error("boom");
      },
    });
    await registerWithProfile(registry);
    expect(() =>
      registry.register(
        "relay-1",
        "user-1",
        { profile: "desktop-agent" } as RelayCapabilities,
        () => {},
        7,
        SESSION,
        1,
        PAIRING,
      ),
    ).not.toThrow();
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toBeNull();
  });

  it("fires on updateCapabilities present→absent (profile deactivation / refresh clears snapshot)", async () => {
    const calls: {
      relayId: string;
      userId: string;
      desktopSessionId: string;
      pairingGeneration?: string;
    }[] = [];
    const registry = new InMemoryRelayRegistry({
      onWorkstationProfileSnapshotCleared: (input) => calls.push(input),
    });
    await registerWithProfile(registry);
    // Advertise the profile binding via an update at revision 2.
    registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 2,
      capabilities: {
        profile: "desktop-agent",
        workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      } as RelayCapabilities,
    });
    expect(calls).toEqual([]);
    // Now an update that OMITS the profile snapshot (deactivation / refresh
    // while the controller is unavailable) → present→absent → fires.
    registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 3,
      capabilities: { profile: "desktop-agent", canReadWorkspace: false } as RelayCapabilities,
    });
    expect(calls).toEqual([
      {
        relayId: "relay-1",
        userId: "user-1",
        desktopSessionId: SESSION,
        pairingGeneration: PAIRING,
      },
    ]);
    expect(registry.getWorkstationProfileSnapshot("relay-1")).toBeNull();
  });

  it("does NOT fire on updateCapabilities present→present (revision/profile drift)", async () => {
    const calls: unknown[] = [];
    const registry = new InMemoryRelayRegistry({
      onWorkstationProfileSnapshotCleared: () => calls.push(true),
    });
    await registerWithProfile(registry);
    registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 2,
      capabilities: {
        profile: "desktop-agent",
        workstationProfileSnapshot: { ...VALID_PROFILE_SNAPSHOT, profileRevision: 4 },
      } as RelayCapabilities,
    });
    expect(calls).toEqual([]);
  });
});

describe("InMemoryRelayRegistry getActiveWorkstationSession (D418 reconnect/session split-brain fix)", () => {
  it("delegates to the injected lookup and returns null when none is wired", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent" } as RelayCapabilities,
      () => {},
      7,
      "desktop-session-A",
      1,
    );
    expect(registry.getActiveWorkstationSession("user-1")).toBeNull();
  });

  it("returns the injected lookup's active session view", async () => {
    const registry = new InMemoryRelayRegistry({
      getActiveWorkstationSession: (userId) =>
        userId === "user-1"
          ? {
              userId: "user-1",
              relayId: "relay-1",
              desktopSessionId: "desktop-session-A",
              capabilityRevision: 5,
            }
          : null,
    });
    expect(registry.getActiveWorkstationSession("user-1")).toEqual({
      userId: "user-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-session-A",
      capabilityRevision: 5,
    });
    expect(registry.getActiveWorkstationSession("user-2")).toBeNull();
  });
});

describe("InMemoryRelayRegistry updateCapabilities anti-smuggling (D418 protocol v7)", () => {
  const SESSION = "session-1";

  async function registeredRegistry(): Promise<InMemoryRelayRegistry> {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-1",
      { profile: "desktop-agent", canReadWorkspace: true } as RelayCapabilities,
      () => {},
      7,
      SESSION,
      0,
    );
    return registry;
  }

  it("drops unknown top-level capability keys from an update (no smuggling)", () => {
    // Static analysis: the registry's parseCapabilityUpdate is private, so
    // exercise it via updateCapabilities. A frame carrying an unknown
    // `smuggledField` must be accepted (the unknown key is dropped) and the
    // stored capabilities must NOT retain the unknown key.
    return (async () => {
      const registry = await registeredRegistry();
      const result = registry.updateCapabilities({
        relayId: "relay-1",
        userId: "user-1",
        desktopSessionId: SESSION,
        capabilityRevision: 1,
        capabilities: {
          profile: "desktop-agent",
          canReadWorkspace: false,
          // Unknown non-capability key — must be dropped, not stored.
          smuggledField: "evil",
          anotherUnknown: 42,
        } as unknown as RelayCapabilities,
      });
      expect(result).toEqual({ ok: true });
      const caps = registry.getCapabilities("relay-1") as Record<string, unknown>;
      expect(caps["canReadWorkspace"]).toBe(false);
      expect(caps["smuggledField"]).toBeUndefined();
      expect(caps["anotherUnknown"]).toBeUndefined();
      // The known-key surface is the only thing retained.
      expect(Object.keys(caps).sort()).toEqual(["canReadWorkspace", "profile"]);
    })();
  });

  it("rejects an update whose known boolean key carries a non-boolean value", () => {
    return (async () => {
      const registry = await registeredRegistry();
      const result = registry.updateCapabilities({
        relayId: "relay-1",
        userId: "user-1",
        desktopSessionId: SESSION,
        capabilityRevision: 1,
        capabilities: {
          profile: "desktop-agent",
          canReadWorkspace: "yes",
        } as unknown as RelayCapabilities,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("canReadWorkspace");
      // Prior state intact.
      expect(registry.getCapabilityRevision("relay-1")).toBe(0);
      expect(registry.getCapabilities("relay-1")?.canReadWorkspace).toBe(true);
    })();
  });

  it("preserves and clears the transient terminal handoff capability", async () => {
    const registry = await registeredRegistry();

    expect(registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        canUseTerminal: true,
        hasPendingTerminalHandoff: true,
      },
    })).toEqual({ ok: true });
    expect(registry.getCapabilities("relay-1")).toMatchObject({
      canUseTerminal: true,
      hasPendingTerminalHandoff: true,
    });

    expect(registry.updateCapabilities({
      relayId: "relay-1",
      userId: "user-1",
      desktopSessionId: SESSION,
      capabilityRevision: 2,
      capabilities: {
        profile: "desktop-agent",
        canUseTerminal: true,
      },
    })).toEqual({ ok: true });
    expect(registry.getCapabilities("relay-1")?.hasPendingTerminalHandoff).toBeUndefined();
  });

  it("rejects an update whose known string key carries a non-string value", () => {
    return (async () => {
      const registry = await registeredRegistry();
      const result = registry.updateCapabilities({
        relayId: "relay-1",
        userId: "user-1",
        desktopSessionId: SESSION,
        capabilityRevision: 1,
        capabilities: {
          profile: "desktop-agent",
          dataDir: 12345,
        } as unknown as RelayCapabilities,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("dataDir");
    })();
  });

  it("rejects an update whose securityLevel is not a known level", () => {
    return (async () => {
      const registry = await registeredRegistry();
      const result = registry.updateCapabilities({
        relayId: "relay-1",
        userId: "user-1",
        desktopSessionId: SESSION,
        capabilityRevision: 1,
        capabilities: {
          profile: "desktop-agent",
          securityLevel: "yolo",
        } as unknown as RelayCapabilities,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("securityLevel");
    })();
  });

  it("accepts and preserves a valid full known-key capability update", () => {
    return (async () => {
      const registry = await registeredRegistry();
      const result = registry.updateCapabilities({
        relayId: "relay-1",
        userId: "user-1",
        desktopSessionId: SESSION,
        capabilityRevision: 1,
        capabilities: {
          profile: "desktop-agent",
          canReadWorkspace: true,
          canRunShell: true,
          allowedRoots: ["/path/to/project"],
          securityLevel: "standard",
          dataDir: "/tmp/sandbox",
          browserSessionId: "nautilo-browser-a1b2c3d4",
          workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
        } as RelayCapabilities,
      });
      expect(result).toEqual({ ok: true });
      const caps = registry.getCapabilities("relay-1") as Record<string, unknown>;
      expect(caps["canReadWorkspace"]).toBe(true);
      expect(caps["canRunShell"]).toBe(true);
      expect(caps["allowedRoots"]).toEqual(["/path/to/project"]);
      expect(caps["securityLevel"]).toBe("standard");
      expect(caps["dataDir"]).toBe("/tmp/sandbox");
      expect(caps["browserSessionId"]).toBe("nautilo-browser-a1b2c3d4");
      expect(registry.getWorkstationProfileSnapshot("relay-1")).toEqual(VALID_PROFILE_SNAPSHOT);
    })();
  });
});


describe("Relay connection cleanup", () => {
  it("late cleanup from a replaced socket cannot unregister the current socket", async () => {
    const registry = new InMemoryRelayRegistry();
    const previous = () => {};
    const current = () => {};
    await registry.register("relay-replacement", "human", CAPS, previous, 6);
    await registry.register("relay-replacement", "human", CAPS, current, 6);
    await registry.unregisterConnection("relay-replacement", previous);
    expect(await registry.listConnected()).toEqual(["relay-replacement"]);
    expect(registry.getUserId("relay-replacement")).toBe("human");
    await registry.unregisterConnection("relay-replacement", current);
    expect(await registry.listConnected()).toEqual([]);
  });
});
