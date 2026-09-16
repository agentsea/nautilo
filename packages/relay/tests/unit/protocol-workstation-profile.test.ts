import { describe, expect, test } from "bun:test";
import {
  RELAY_PROTOCOL_VERSION,
  CAPABILITY_UPDATE_PROTOCOL_VERSION,
  parseRelayWorkstationProfileSnapshot,
  type RelayRegisterMessage,
  type RelayUpdateCapabilitiesMessage,
} from "../../src/protocol";
import type {
  RelayCapabilities,
  RelayWorkstationProfileSnapshot,
} from "../../src/types";

const SNAPSHOT: RelayWorkstationProfileSnapshot = {
  profileId: "profile-developer-workstation",
  profileRevision: 3,
  grantIds: ["grant-1", "grant-2"],
  protectedPolicyVersion: 2,
  networkMode: "isolated",
  capabilities: [
    { id: "cap-bun", backend: "sandboxed" },
    { id: "cap-docker-compose", backend: "brokered_host_service" },
  ],
};

describe("D418 advisory Workstation Profile binding snapshot protocol", () => {
  test("parses a strict snapshot and carries only redacted binding fields", () => {
    const parsed = parseRelayWorkstationProfileSnapshot(SNAPSHOT);
    expect(parsed).toEqual({ ok: true, snapshot: SNAPSHOT });
    expect(Object.keys(SNAPSHOT).sort()).toEqual([
      "capabilities",
      "grantIds",
      "networkMode",
      "profileId",
      "profileRevision",
      "protectedPolicyVersion",
    ]);
    expect(Object.keys(SNAPSHOT.capabilities[0]!).sort()).toEqual(["backend", "id"]);
  });

  test("admits an empty grantIds set and an empty capabilities set", () => {
    const empty = { ...SNAPSHOT, grantIds: [], capabilities: [] };
    expect(parseRelayWorkstationProfileSnapshot(empty)).toEqual({ ok: true, snapshot: empty });
  });

  test("fails closed for unknown fields (no roots/env/exec/path/identity smuggle)", () => {
    for (const forbidden of [
      "roots",
      "environmentKeys",
      "executableRules",
      "discoveryProviders",
      "toolchainCapabilities",
      "name",
      "createdAt",
      "updatedAt",
      "schemaVersion",
      "version",
      "platformAuthorization",
      "filesystemIdentity",
      "subject",
    ]) {
      expect(
        parseRelayWorkstationProfileSnapshot({ ...SNAPSHOT, [forbidden]: "must-never-cross" }),
      ).toMatchObject({ ok: false });
    }
  });

  test("fails closed for empty/blank ids, duplicates, and invalid revisions or backends", () => {
    expect(
      parseRelayWorkstationProfileSnapshot({ ...SNAPSHOT, profileId: "" }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationProfileSnapshot({ ...SNAPSHOT, profileRevision: 0 }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationProfileSnapshot({ ...SNAPSHOT, profileRevision: -1 }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationProfileSnapshot({ ...SNAPSHOT, profileRevision: 1.5 }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationProfileSnapshot({ ...SNAPSHOT, grantIds: ["grant-1", ""] }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationProfileSnapshot({ ...SNAPSHOT, grantIds: ["grant-1", "grant-1"] }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationProfileSnapshot({ ...SNAPSHOT, protectedPolicyVersion: 0 }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationProfileSnapshot({ ...SNAPSHOT, networkMode: "open" }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationProfileSnapshot({
        ...SNAPSHOT,
        capabilities: [...SNAPSHOT.capabilities, { id: "cap-bun", backend: "sandboxed" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationProfileSnapshot({
        ...SNAPSHOT,
        capabilities: [{ id: "", backend: "sandboxed" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayWorkstationProfileSnapshot({
        ...SNAPSHOT,
        capabilities: [{ id: "cap-x", backend: "unsandboxed" as unknown as never }],
      }),
    ).toMatchObject({ ok: false });
    // A capability entry that smuggles an executable path is rejected.
    expect(
      parseRelayWorkstationProfileSnapshot({
        ...SNAPSHOT,
        capabilities: [
          { id: "cap-bun", backend: "sandboxed", executable: "/Users/alice/.bun/bin/bun" },
        ],
      }),
    ).toMatchObject({ ok: false });
  });

  test("accepts all supported network modes and backends", () => {
    for (const mode of ["host", "isolated", "proxy_allowlist"] as const) {
      expect(
        parseRelayWorkstationProfileSnapshot({ ...SNAPSHOT, networkMode: mode }),
      ).toMatchObject({ ok: true });
    }
    for (const backend of ["sandboxed", "brokered_host_service"] as const) {
      expect(
        parseRelayWorkstationProfileSnapshot({
          ...SNAPSHOT,
          capabilities: [{ id: "cap-x", backend }],
        }),
      ).toMatchObject({ ok: true });
    }
  });

  test("rejects a non-object payload", () => {
    expect(parseRelayWorkstationProfileSnapshot(null)).toMatchObject({ ok: false });
    expect(parseRelayWorkstationProfileSnapshot([])).toMatchObject({ ok: false });
    expect(parseRelayWorkstationProfileSnapshot("snapshot")).toMatchObject({ ok: false });
  });
});

describe("D418 protocol v7 profile snapshot wire compatibility", () => {
  const CAPS: RelayCapabilities = {
    profile: "desktop-agent",
    workstationProfileSnapshot: SNAPSHOT,
  } as RelayCapabilities;

  test("register and update-capabilities carry the optional profile snapshot", () => {
    const register: RelayRegisterMessage = {
      type: "relay:register",
      relayId: "relay-1",
      userId: "user-1",
      capabilities: CAPS,
      protocolVersion: RELAY_PROTOCOL_VERSION,
      desktopSessionId: "session-1",
      capabilityRevision: 0,
    };
    expect(register.capabilities.workstationProfileSnapshot).toEqual(SNAPSHOT);
    // Pre-v7 / no-profile relays omit the field and still type-check.
    const legacy: RelayRegisterMessage = {
      type: "relay:register",
      relayId: "relay-1",
      userId: "user-1",
      capabilities: { profile: "desktop-agent" } as RelayCapabilities,
      protocolVersion: 6,
    };
    expect(legacy.capabilities.workstationProfileSnapshot).toBeUndefined();
    expect(legacy.desktopSessionId).toBeUndefined();
  });

  test("relay:update-capabilities is a full-replacement frame carrying the profile snapshot", () => {
    const update: RelayUpdateCapabilitiesMessage = {
      type: "relay:update-capabilities",
      relayId: "relay-1",
      desktopSessionId: "session-1",
      capabilityRevision: 5,
      capabilities: CAPS,
    };
    expect(update.type).toBe("relay:update-capabilities");
    expect(update.capabilities.workstationProfileSnapshot).toEqual(SNAPSHOT);
    expect(update.capabilityRevision).toBe(5);
  });

  test("server-side and client-side import the same strict snapshot wire type", () => {
    // The runtime imports the snapshot type + parser from @nautilo/relay; this
    // test guards the shared wire type by round-tripping the typed snapshot
    // through the strict parser that both sides use.
    const wire = CAPS.workstationProfileSnapshot as unknown;
    expect(parseRelayWorkstationProfileSnapshot(wire)).toEqual({ ok: true, snapshot: SNAPSHOT });
  });

  test("capability updates remain v7 while the additive relay protocol is v18", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(20);
    expect(CAPABILITY_UPDATE_PROTOCOL_VERSION).toBe(7);
  });
});
