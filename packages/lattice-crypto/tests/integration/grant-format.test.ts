import { describe, expect, test } from "bun:test";
import {
  GRANT_FORMAT_VERSION,
  grantSigningBytes,
  parseGrant,
  serializeGrant,
} from "../../src/format/grant-v1.ts";
import { matrix } from "../../src/testing/matrix.ts";
import { World } from "../../src/testing/world.ts";
import type { Grant } from "../../src/types/index.ts";
import { concat, fromHex, fromUtf8, toHex } from "../../src/util/bytes.ts";

const fixtureGrant: Grant = {
  formatVersion: GRANT_FORMAT_VERSION,
  id: "grant_test",
  issuingDeviceId: "dev_issuer",
  scope: ["bob", "alice", "alice"],
  operations: ["encrypt", "decrypt"],
  issuedAt: 1_000,
  expiresAt: 2_000,
  coveredEpochs: {
    ns_z: [2, 1, 2],
    ns_a: [3],
  },
  encryptedSecret: new Uint8Array([0x00, 0x01, 0xfe, 0xff]),
  scheme: "enumeration",
  signature: new Uint8Array(64).fill(0xaa),
  singleUse: true,
  consumed: false,
};

describe("grant format v1", () => {
  test("canonical signed bytes have a stable cross-runtime fixture", () => {
    expect(toHex(grantSigningBytes(fixtureGrant))).toBe(
      "000000296e617574696c6f2f6c6174746963652d63727970746f2f6772616e742d7369676e61747572652f7631000000010000000a6772616e745f746573740000000a6465765f6973737565720000000200000005616c69636500000003626f6200000002000000076465637279707400000007656e637279707400000000000003e800000000000007d000000002000000046e735f61000000010000000000000003000000046e735f7a0000000200000000000000010000000000000002000000040001feff0000000b656e756d65726174696f6e01",
    );
  });

  test("set order and map insertion order do not change signed bytes", () => {
    const reordered: Grant = {
      ...fixtureGrant,
      scope: ["alice", "bob"],
      operations: ["decrypt", "encrypt"],
      coveredEpochs: {
        ns_a: [3],
        ns_z: [1, 2],
      },
    };

    expect(grantSigningBytes(reordered)).toEqual(grantSigningBytes(fixtureGrant));
  });

  test("the wire form round-trips signed fields and excludes mutable consumption state", () => {
    const wire = serializeGrant({ ...fixtureGrant, consumed: true });
    const parsed = parseGrant(wire);

    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      ...fixtureGrant,
      scope: ["alice", "bob"],
      operations: ["decrypt", "encrypt"],
      coveredEpochs: {
        ns_a: [3],
        ns_z: [1, 2],
      },
      consumed: false,
    });
    expect(parseGrant(concat(wire, new Uint8Array([0])))).toBeNull();
  });

  test("rejects the pinned old-domain wire fixture without a fallback", () => {
    expect(parseGrant(fromHex(
      "0000002b6b656e746175726f732f6c6174746963652d63727970746f2f6772616e742d7369676e61747572652f7631000000010000000a6772616e745f746573740000000a6465765f6973737565720000000200000005616c69636500000003626f6200000002000000076465637279707400000007656e637279707400000000000003e800000000000007d000000002000000046e735f61000000010000000000000003000000046e735f7a0000000200000000000000010000000000000002000000040001feff0000000b656e756d65726174696f6e0100000040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ))).toBeNull();
  });
});

for (const config of matrix) {
  describe(`multi-epoch grants — ${config.name}`, () => {
    test("a fresh grant can explicitly authorize retained history and the current epoch", async () => {
      const w = new World(config);
      const aliceDevice = await w.device("alice");
      await w.device("bob");
      const namespaceId = await w.namespace(["alice", "bob"]);
      const historicalObject = await w.encrypt(
        namespaceId,
        "before removal",
        aliceDevice,
      );

      await w.removeMember(namespaceId, "bob");
      const currentObject = await w.encrypt(
        namespaceId,
        "after removal",
        aliceDevice,
      );
      const session = await w.engine.createDelegationSession();
      const grant = await w.engine.mintGrant({
        issuer: w.deviceCapability(aliceDevice),
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
        historicalEpochs: { [namespaceId]: [0] },
      });

      expect(grant.coveredEpochs[namespaceId]).toEqual([0, 1]);
      const results = await w.engine.decryptMany(
        [historicalObject, currentObject],
        grant,
        session,
      );
      expect(results.map((result) =>
        result.ok ? fromUtf8(result.plaintext) : result.reason
      )).toEqual(["before removal", "after removal"]);
    });
  });
}
