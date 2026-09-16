import { describe, expect, test } from "bun:test";
import { matrix } from "../../src/testing/matrix.ts";
import { World } from "../../src/testing/world.ts";

async function expectRejection(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  const outcome = await promise.then(
    () => "resolved",
    (error: unknown) => String(error),
  );
  expect(outcome).toContain(message);
}

function observeExporterCalls(world: World): () => number {
  const original = world.group.exporterSecret.bind(world.group);
  let calls = 0;
  world.group.exporterSecret = async (
    namespaceId,
    epoch,
    label,
    deviceId,
  ) => {
    calls += 1;
    return await original(namespaceId, epoch, label, deviceId);
  };
  return () => calls;
}

for (const config of matrix) {
  describe(`authenticated grant mint capability (H4): ${config.name}`, () => {
    test("an authenticated current member can mint for a non-empty owned scope", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.namespace(["alice", "bob"]);
      const session = await w.engine.createDelegationSession();

      const grant = await w.engine.mintGrant({
        issuer: w.deviceCapability(alice),
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
      });

      expect(await w.engine.verifyGrant(grant)).toEqual({ ok: true });
      expect(grant.issuingDeviceId).toBe(alice);
    });

    test("a nonexistent device is rejected before namespace key derivation", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.namespace(["alice"]);
      const session = await w.engine.createDelegationSession();
      const capability = w.deviceCapability(alice);
      capability.deviceId = "dev_does_not_exist";
      const exporterCalls = observeExporterCalls(w);

      await expectRejection(
        w.engine.mintGrant({
          issuer: capability,
          scope: ["alice"],
          recipientPublicKey: session.keyPair.publicKey,
          ttlMs: 60_000,
        }),
        "unknown device",
      );
      expect(exporterCalls()).toBe(0);
    });

    test("a private key from another device cannot authenticate the claimed issuer", async () => {
      const w = new World(config);
      const alicePhone = await w.device("alice");
      const aliceLaptop = await w.device("alice");
      await w.namespace(["alice"]);
      const session = await w.engine.createDelegationSession();
      const mismatched = w.deviceCapability(aliceLaptop);
      mismatched.deviceId = alicePhone;
      const exporterCalls = observeExporterCalls(w);

      await expectRejection(
        w.engine.mintGrant({
          issuer: mismatched,
          scope: ["alice"],
          recipientPublicKey: session.keyPair.publicKey,
          ttlMs: 60_000,
        }),
        "does not match",
      );
      expect(exporterCalls()).toBe(0);
    });

    test("a revoked device cannot mint", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.device("bob");
      await w.namespace(["alice", "bob"]);
      const session = await w.engine.createDelegationSession();
      const capability = w.deviceCapability(alice);
      await w.engine.revokeDevice(alice);
      const exporterCalls = observeExporterCalls(w);

      await expectRejection(
        w.engine.mintGrant({
          issuer: capability,
          scope: ["alice"],
          recipientPublicKey: session.keyPair.publicKey,
          ttlMs: 60_000,
        }),
        "revoked",
      );
      expect(exporterCalls()).toBe(0);
    });

    test("empty scope is rejected instead of becoming a universal subset", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.namespace(["alice"]);
      const session = await w.engine.createDelegationSession();
      const exporterCalls = observeExporterCalls(w);

      await expectRejection(
        w.engine.mintGrant({
          issuer: w.deviceCapability(alice),
          scope: [],
          recipientPublicKey: session.keyPair.publicKey,
          ttlMs: 60_000,
        }),
        "must not be empty",
      );
      expect(exporterCalls()).toBe(0);
    });

    test("an issuer outside the requested scope cannot mint another user's grant", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.namespace(["bob"]);
      const session = await w.engine.createDelegationSession();
      const exporterCalls = observeExporterCalls(w);

      await expectRejection(
        w.engine.mintGrant({
          issuer: w.deviceCapability(alice),
          scope: ["bob"],
          recipientPublicKey: session.keyPair.publicKey,
          ttlMs: 60_000,
        }),
        "must include the issuing device owner",
      );
      expect(exporterCalls()).toBe(0);
    });
  });
}
