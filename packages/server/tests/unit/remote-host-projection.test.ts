import { describe, expect, test } from "bun:test";
import { RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import {
  projectRemoteHosts,
  type PairedHostRow,
  type RemoteHostPresence,
} from "../../src/remote-control/host-projection";

const USER = "00000000-0000-4000-8000-000000000001";
const GENERATION = "00000000-0000-4000-8000-000000000031";
const NOW = 1_800_000_000_000;

function row(overrides: Partial<PairedHostRow> = {}): PairedHostRow {
  return {
    remoteHostId: "00000000-0000-4000-8000-000000000061",
    label: "Writer Mac",
    pairingGeneration: GENERATION,
    durableLastSeenAt: new Date(NOW - 1000),
    ...overrides,
  };
}

function live(overrides: Partial<RemoteHostPresence> = {}): RemoteHostPresence {
  return {
    userId: USER,
    pairingGeneration: GENERATION,
    desktopSessionId: "desktop-session",
    protocolVersion: RELAY_PROTOCOL_VERSION,
    lastSeenAt: NOW - 500,
    capabilities: {
      profile: "desktop-agent",
      canControlDesktop: true,
      canSeeDesktop: true,
      rawPath: "/never/projected",
    },
    ...overrides,
  };
}

function project(rows: readonly PairedHostRow[], presence: readonly RemoteHostPresence[]) {
  return projectRemoteHosts({ userId: USER, rows, presence, nowMs: NOW });
}

describe("D458 remote host projection", () => {
  test("projects only an exact current owner/generation match and omits private fields", () => {
    const host = project([row()], [live()])[0]!;
    expect(host).toEqual({
      remoteHostId: row().remoteHostId,
      label: "Writer Mac",
      connected: true,
      readiness: "compatible_online",
      lastSeenAt: new Date(NOW - 500).toISOString(),
    });
    expect(JSON.stringify(host)).not.toContain("desktop-session");
    expect(JSON.stringify(host)).not.toContain("never/projected");
    expect(JSON.stringify(host)).not.toContain(GENERATION);
  });

  test("fails closed on duplicate exact live generations", () => {
    const host = project([row()], [live(), live({ desktopSessionId: "other-session" })])[0]!;
    expect(host.connected).toBe(false);
    expect(host.readiness).toBe("identity_conflict");
  });

  test("separates incompatible transport, Tool capabilities, and stale heartbeat", () => {
    expect(project([row()], [live({ protocolVersion: 6 })])[0]?.readiness).toBe("incompatible_online");
    expect(project([row()], [live({ desktopSessionId: null })])[0]?.readiness).toBe("incompatible_online");
    expect(project([row()], [live({ capabilities: { profile: "desktop-agent" } })])[0]?.readiness).toBe("compatible_online");
    const stale = project([row()], [live({ lastSeenAt: NOW - 45_001 })])[0]!;
    expect(stale).toMatchObject({ connected: false, readiness: "stale" });
    expect(stale.lastSeenAt).toBe(new Date(NOW - 45_001).toISOString());
  });

  test("does not use a previous desktop session or wrong owner as a live match", () => {
    expect(project([row()], [live({ userId: "other-user" })])[0]).toMatchObject({
      connected: false,
      readiness: "offline",
    });
    expect(project([row()], [live({ desktopSessionId: "" })])[0]).toMatchObject({
      connected: false,
      readiness: "incompatible_online",
    });
  });

  test("sorts deterministically by display label then opaque binding id", () => {
    const hosts = project([
      row({ remoteHostId: "b", label: "Alpha" }),
      row({ remoteHostId: "a", label: "Alpha" }),
      row({ remoteHostId: "c", label: "Zulu" }),
    ], []);
    expect(hosts.map((host) => host.remoteHostId)).toEqual(["a", "b", "c"]);
  });
});
