import { describe, expect, it } from "bun:test";
import type { RelayCapabilities } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const ENABLED = {
  version: 1,
  state: "enabled",
  provider: "openssh",
  ssh: "observed",
  scp: "observed",
  auth: true,
  exec: true,
  upload: true,
  download: true,
} as const;

const NOT_ENABLED = {
  version: 1,
  state: "not-enabled",
  provider: "openssh",
  ssh: "observed",
  scp: "observed",
} as const;

const UNAVAILABLE = {
  version: 1,
  state: "unavailable",
  provider: "openssh",
  ssh: "unavailable",
  scp: "unavailable",
} as const;

function register(
  registry: InMemoryRelayRegistry,
  relayId: string,
  userId: string,
  capabilities: RelayCapabilities,
): void {
  void registry.register(relayId, userId, capabilities, () => undefined, 13, "desktop-session", 0);
}

describe("relay registry structured SSH readiness", () => {
  it("preserves the v16 output-continuation capability across a full capability refresh", () => {
    const registry = new InMemoryRelayRegistry();
    void registry.register(
      "relay-a",
      "user-a",
      {
        profile: "desktop-agent",
        canReadStructuredSshOutput: true,
        structuredSsh: ENABLED,
      },
      () => undefined,
      16,
      "desktop-session",
      0,
    );

    expect(registry.updateCapabilities({
      relayId: "relay-a",
      userId: "user-a",
      desktopSessionId: "desktop-session",
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        canReadStructuredSshOutput: true,
        structuredSsh: ENABLED,
      },
    })).toEqual({ ok: true });

    expect(registry.getCapabilities("relay-a")?.canReadStructuredSshOutput).toBe(true);
  });

  it("projects enabled OpenSSH auth and exec aggregates as the shared SSH token", () => {
    const registry = new InMemoryRelayRegistry();
    register(registry, "relay-a", "user-a", {
      profile: "desktop-agent",
      structuredSsh: ENABLED,
    });
    register(registry, "relay-b", "user-b", {
      profile: "desktop-agent",
      structuredSsh: ENABLED,
    });

    expect(registry.getCapabilities("relay-a")?.structuredSsh).toEqual(ENABLED);
    expect(registry.findByCapability("canUseStructuredSsh")).toEqual(["relay-a", "relay-b"]);
    expect(registry.findByCapabilityForUser("canUseStructuredSsh", "user-a")).toEqual(["relay-a"]);
    expect(registry.findByCapability("canUseStructuredSshCopy")).toEqual(["relay-a", "relay-b"]);
    expect(registry.findByCapabilityForUser("canUseStructuredSshCopy", "user-a")).toEqual(["relay-a"]);
  });

  it("fails closed for unavailable, not-enabled, and partial readiness projections", () => {
    const registry = new InMemoryRelayRegistry();
    register(registry, "unavailable", "user-a", {
      profile: "desktop-agent",
      structuredSsh: UNAVAILABLE,
    });
    register(registry, "not-enabled", "user-a", {
      profile: "desktop-agent",
      structuredSsh: NOT_ENABLED,
    });
    register(registry, "no-auth", "user-a", {
      profile: "desktop-agent",
      structuredSsh: { ...ENABLED, auth: false },
    });
    register(registry, "no-exec", "user-a", {
      profile: "desktop-agent",
      structuredSsh: { ...ENABLED, exec: false },
    });

    expect(registry.findByCapabilityForUser("canUseStructuredSsh", "user-a")).toEqual([]);
    expect(registry.findByCapabilityForUser("canUseStructuredSshCopy", "user-a")).toEqual([]);
  });

  it("advertises Human enablement without advertising runnable SSH authority", () => {
    const registry = new InMemoryRelayRegistry();
    register(registry, "ready-to-enable", "user-a", {
      profile: "desktop-agent",
      structuredSsh: NOT_ENABLED,
    });
    register(registry, "unavailable", "user-a", {
      profile: "desktop-agent",
      structuredSsh: UNAVAILABLE,
    });
    register(registry, "no-scp", "user-a", {
      profile: "desktop-agent",
      structuredSsh: { ...NOT_ENABLED, scp: "unavailable" },
    });

    expect(registry.findByCapabilityForUser("canConfigureStructuredSsh", "user-a"))
      .toEqual(["ready-to-enable", "no-scp"]);
    expect(registry.findByCapabilityForUser("canConfigureStructuredSshCopy", "user-a"))
      .toEqual(["ready-to-enable"]);
    expect(registry.findByCapabilityForUser("canUseStructuredSsh", "user-a")).toEqual([]);
    expect(registry.findByCapabilityForUser("canUseStructuredSshCopy", "user-a")).toEqual([]);
  });

  it("requires observed scp and both copy directions for the copy token", () => {
    const registry = new InMemoryRelayRegistry();
    for (const [relayId, structuredSsh] of [
      ["no-scp", { ...ENABLED, scp: "unavailable" }],
      ["no-upload", { ...ENABLED, upload: false }],
      ["no-download", { ...ENABLED, download: false }],
    ] as const) {
      register(registry, relayId, "user-a", { profile: "desktop-agent", structuredSsh });
    }

    expect(registry.findByCapabilityForUser("canUseStructuredSsh", "user-a"))
      .toEqual(["no-scp", "no-upload", "no-download"]);
    expect(registry.findByCapabilityForUser("canUseStructuredSshCopy", "user-a")).toEqual([]);
  });

  it("drops malformed readiness at registration while retaining the relay", () => {
    const registry = new InMemoryRelayRegistry();
    register(registry, "relay-a", "user-a", {
      profile: "desktop-agent",
      structuredSsh: { ...ENABLED, privateKey: "forbidden" },
    } as unknown as RelayCapabilities);

    expect(registry.getCapabilities("relay-a")).toEqual({ profile: "desktop-agent" });
    expect(registry.findByCapabilityForUser("canUseStructuredSsh", "user-a")).toEqual([]);
  });

  it("withdraws routing when a readiness update or reconnect removes eligibility", async () => {
    const registry = new InMemoryRelayRegistry();
    register(registry, "relay-a", "user-a", { profile: "desktop-agent", structuredSsh: ENABLED });
    expect(registry.findByCapabilityForUser("canUseStructuredSsh", "user-a")).toEqual(["relay-a"]);

    expect(registry.updateCapabilities({
      relayId: "relay-a",
      userId: "user-a",
      desktopSessionId: "desktop-session",
      capabilityRevision: 1,
      capabilities: { profile: "desktop-agent", structuredSsh: { ...ENABLED, exec: false } },
    })).toEqual({ ok: true });
    expect(registry.findByCapabilityForUser("canUseStructuredSsh", "user-a")).toEqual([]);

    await registry.register(
      "relay-a", "user-a", { profile: "desktop-agent", structuredSsh: ENABLED },
      () => undefined, 13, "desktop-session", 2,
    );
    expect(registry.findByCapabilityForUser("canUseStructuredSsh", "user-a")).toEqual(["relay-a"]);

    await registry.register(
      "relay-a", "user-a", { profile: "desktop-agent", structuredSsh: NOT_ENABLED },
      () => undefined, 13, "desktop-session", 3,
    );
    expect(registry.findByCapabilityForUser("canUseStructuredSsh", "user-a")).toEqual([]);
  });
});
