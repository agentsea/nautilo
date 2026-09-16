import { describe, expect, test } from "bun:test";
import {
  createMemoryClientProfileVault,
  runClientProfileVaultConformance,
} from "../../src/testing/client-profile-vault.ts";

const ALICE = {
  serverScope: "https://one.example.test",
  userId: "10000000-0000-4000-8000-000000000001",
  humanActorId: "20000000-0000-4000-8000-000000000001",
  profileId: "profile_alice_browser",
  deviceId: "device_alice_browser",
  installationLineageDigest:
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
} as const;

describe("shared client profile vault", () => {
  test("passes the complete in-memory conformance contract", async () => {
    const report = await runClientProfileVaultConformance(
      createMemoryClientProfileVault,
    );

    expect(report.checks).toEqual([
      "availability",
      "stage-is-not-active",
      "activate-and-open",
      "opened-bytes-are-wiped",
      "coordinates-isolate",
      "public-enumeration",
      "abort-preserves-active",
      "interrupted-activation",
      "wrapping-key-rotation",
      "lock-and-unlock",
      "forget",
    ]);
  });

  test("never exposes profile bytes through status or public enumeration", async () => {
    const vault = createMemoryClientProfileVault();
    const canary = new TextEncoder().encode("private-canary-material");

    await vault.unlock();
    await vault.stageProfile({
      coordinates: ALICE,
      stageId: "stage_1",
      generation: 1,
      profileBytes: canary,
      publicState: {
        clientKind: "browser",
        publicFingerprint:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });

    expect(JSON.stringify(await vault.availability())).not.toContain(
      "private-canary-material",
    );
    expect(JSON.stringify(await vault.listPublicProfiles())).not.toContain(
      "private-canary-material",
    );
    expect(canary).toEqual(
      new TextEncoder().encode("private-canary-material"),
    );
  });

  test("rejects malformed coordinates before touching storage", async () => {
    const vault = createMemoryClientProfileVault();
    await vault.unlock();

    let rejected = false;
    try {
      await vault.stageProfile({
        coordinates: {
          ...ALICE,
          serverScope: "https://one.example.test/",
        },
        stageId: "stage_1",
        generation: 1,
        profileBytes: new Uint8Array([1]),
        publicState: {
          clientKind: "browser",
          publicFingerprint:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      });
    } catch (error) {
      rejected = true;
      expect(String(error)).toContain("vault coordinates are invalid");
    }
    expect(rejected).toBe(true);
  });
});
