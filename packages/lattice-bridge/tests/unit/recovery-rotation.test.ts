import { describe, expect, test } from "bun:test";
import {
  createRecoveryRotationFixture,
} from "../fixtures/recovery-rotation-fixture.ts";

describe("recovery-kit rotation submission", () => {
  test("authenticates one complete next-generation opaque archive", async () => {
    const setup = await createRecoveryRotationFixture();
    const verified = setup.verify();
    expect(verified.humanId).toBe(setup.human);
    expect(verified.recoveryGeneration).toBe(2);
    expect(verified.recoveryKeyId).toBe(setup.recovery.keyId);
    expect(verified.issuerDeviceId).toBe(setup.issuerDeviceId);
    expect(verified.archiveBytes).toEqual(setup.archive.archiveBytes);
    expect(verified.archiveHash).toEqual(
      setup.crypto.hash(setup.archive.archiveBytes),
    );
    expect(verified.recoveryPublicKeyDigest).toEqual(
      setup.crypto.hash(setup.recovery.publicKey),
    );
  });

  test("rejects stale generations, key substitution, and revoked issuers", async () => {
    const setup = await createRecoveryRotationFixture();
    expect(() =>
      setup.verify(setup.submission, {
        currentRecoveryGeneration: 2,
      })
    ).toThrow("generation");
    const changedKey = setup.submission.recoveryPublicKey.slice();
    changedKey[0] = changedKey[0]! ^ 0xff;
    expect(() =>
      setup.verify({
        ...setup.submission,
        recoveryPublicKey: changedKey,
      })
    ).toThrow("public key");
    expect(() =>
      setup.verify(setup.submission, {
        resolveActiveIssuer: () => null,
      })
    ).toThrow("issuer");
  });

  test("rejects unknown fields and changed signed archive bytes", async () => {
    const setup = await createRecoveryRotationFixture();
    expect(() =>
      setup.verify({
        ...setup.submission,
        trustedByServer: true,
      } as typeof setup.submission)
    ).toThrow("fields");
    const changedArchive = setup.submission.archiveBytes.slice();
    changedArchive[changedArchive.length - 1] =
      changedArchive[changedArchive.length - 1]! ^ 0xff;
    expect(() =>
      setup.verify({
        ...setup.submission,
        archiveBytes: changedArchive,
      })
    ).toThrow();
  });

  test("signs the expected custody and issuer-device revisions", async () => {
    const setup = await createRecoveryRotationFixture();
    expect(() =>
      setup.verify({
        ...setup.submission,
        expectedCustodyRevision: 8,
      }, {
        currentCustodyRevision: 8,
      })
    ).toThrow("issuer");
    expect(() =>
      setup.verify({
        ...setup.submission,
        expectedIssuerDeviceRevision: 5,
      }, {
        resolveActiveIssuer: () => ({
          state: "active",
          humanId: setup.human,
          revision: 5,
          signingPublicKey: setup.issuer.publicKey,
        }),
      })
    ).toThrow("issuer");
  });
});
