import { describe, expect, test } from "bun:test";
import type { RelayCapabilities } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const CAPS: RelayCapabilities = { profile: "desktop-agent" } as RelayCapabilities;

describe("InMemoryRelayRegistry pairing-generation lifecycle snapshots (D480)", () => {
  test("returns only the caller-owned relays at the exact revoked generations", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-matching-desktop",
      "user-a",
      CAPS,
      () => {},
      7,
      "desktop-session-a",
      1,
      "token-row-revoked",
    );
    await registry.register(
      "relay-matching-headless",
      "user-a",
      CAPS,
      () => {},
      7,
      undefined,
      0,
      "token-row-revoked",
    );
    await registry.register(
      "relay-same-user-other-generation",
      "user-a",
      CAPS,
      () => {},
      7,
      "desktop-session-other",
      1,
      "token-row-live",
    );
    await registry.register(
      "relay-foreign-user-same-generation",
      "user-b",
      CAPS,
      () => {},
      7,
      "desktop-session-foreign",
      1,
      "token-row-revoked",
    );

    expect(
      registry.snapshotLiveRelaysForPairingGenerations({
        userId: "user-a",
        pairingGenerations: ["token-row-revoked", "token-row-revoked", ""],
      }),
    ).toEqual([
      {
        relayId: "relay-matching-desktop",
        userId: "user-a",
        desktopSessionId: "desktop-session-a",
        pairingGeneration: "token-row-revoked",
      },
      {
        relayId: "relay-matching-headless",
        userId: "user-a",
        desktopSessionId: null,
        pairingGeneration: "token-row-revoked",
      },
    ]);
  });

  test("returns no snapshots for an empty or unmatched revoked generation set", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "relay-1",
      "user-a",
      CAPS,
      () => {},
      7,
      "desktop-session-a",
      1,
      "token-row-live",
    );

    expect(
      registry.snapshotLiveRelaysForPairingGenerations({
        userId: "user-a",
        pairingGenerations: [],
      }),
    ).toEqual([]);
    expect(
      registry.snapshotLiveRelaysForPairingGenerations({
        userId: "user-a",
        pairingGenerations: ["token-row-other"],
      }),
    ).toEqual([]);
  });
});
