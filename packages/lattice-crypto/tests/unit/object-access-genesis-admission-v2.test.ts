import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  assertAuthenticPreparedObjectAccessManifestGenesisV2,
  authenticateObjectAccessManifestGenesisV2,
  prepareObjectAccessManifestGenesisV2,
} from "../../src/object/access-manifest.ts";
import { wrapObjectDekForNamespaceV2 } from
  "../../src/object/namespace-envelope.ts";
import { encodeNamespaceObjectEnvelopeV2 } from
  "../../src/format/object-v2.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  namespaceGeneration,
  namespaceId,
  objectId,
} from "../../src/v2-types/ids.ts";

describe("HTTP-structural object access genesis admission", () => {
  test("authenticates canonical signed wire bytes into a local prepared handle", async () => {
    const crypto = new LatticeCrypto(seededRng(0x274_30), { now: () => 1 });
    const device = crypto.generateSigningKeyPair();
    const payloadBytes = new Uint8Array([2, 7, 4, 2]);
    const namespaceKey = new Uint8Array(32).fill(0x44);
    const dek = new Uint8Array(32).fill(0x55);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespaceV2(crypto, namespaceKey, {
        objectId: objectId("object-admission"),
        namespaceId: namespaceId("namespace-admission"),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(3),
        bindingRevisionAtWrap: accessRevision(4),
      }, dek),
    );
    const client = prepareObjectAccessManifestGenesisV2(crypto, {
      objectId: objectId("object-admission"),
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes: [envelopeBytes],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-admission"),
      hostAuthorizationRevision: authorizationRevision(9),
      signingPrivateKey: device.privateKey,
    });

    const authenticated = await authenticateObjectAccessManifestGenesisV2({
      crypto,
      payloadBytes,
      manifestBytes: client.manifestBytes,
      envelopeBytes: client.envelopeBytes,
      resolveCurrentAuthorization: (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: 9,
        committerSigningPublicKey: device.publicKey,
      }),
    });

    expect(() => assertAuthenticPreparedObjectAccessManifestGenesisV2(
      authenticated,
    )).not.toThrow();
    expect(authenticated).not.toBe(client);
    expect(authenticated.manifest).toMatchObject({
      objectId: "object-admission",
      accessRevision: 0,
      previousManifestHash: null,
      committerDeviceId: "device-admission",
      hostAuthorizationRevision: 9,
    });
  });

  test("rejects tampering and stale or substituted current authority", async () => {
    const crypto = new LatticeCrypto(seededRng(0x274_31), { now: () => 1 });
    const device = crypto.generateSigningKeyPair();
    const otherDevice = crypto.generateSigningKeyPair();
    const payloadBytes = new Uint8Array([1, 2, 3]);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespaceV2(
        crypto,
        new Uint8Array(32).fill(1),
        {
          objectId: objectId("object-reject"),
          namespaceId: namespaceId("namespace-reject"),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(0),
          bindingRevisionAtWrap: accessRevision(0),
        },
        new Uint8Array(32).fill(2),
      ),
    );
    const client = prepareObjectAccessManifestGenesisV2(crypto, {
      objectId: objectId("object-reject"),
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes: [envelopeBytes],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-reject"),
      hostAuthorizationRevision: authorizationRevision(2),
      signingPrivateKey: device.privateKey,
    });
    const authenticate = (overrides: Readonly<{
      payloadBytes?: Uint8Array;
      publicKey?: Uint8Array;
      currentHostAuthorizationRevision?: number;
    }> = {}) => authenticateObjectAccessManifestGenesisV2({
      crypto,
      payloadBytes: overrides.payloadBytes ?? payloadBytes,
      manifestBytes: client.manifestBytes,
      envelopeBytes: client.envelopeBytes,
      resolveCurrentAuthorization: (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision:
          overrides.currentHostAuthorizationRevision ?? 2,
        committerSigningPublicKey: overrides.publicKey ?? device.publicKey,
      }),
    });

    expect(authenticate({ payloadBytes: new Uint8Array([9]) }))
      .rejects.toThrow("payload hash");
    expect(authenticate({ publicKey: otherDevice.publicKey }))
      .rejects.toThrow("signature");
    expect(authenticate({ currentHostAuthorizationRevision: 3 }))
      .rejects.toThrow("host authorization");
  });
});
