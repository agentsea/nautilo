import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { encodeNamespaceObjectEnvelopeV2 } from "../../src/format/object-v2.ts";
import {
  prepareObjectAccessManifestGenesisWithTombstoneV2,
} from "../../src/object/access-manifest.ts";
import { wrapObjectDekForNamespaceV2 } from "../../src/object/namespace-envelope.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  namespaceGeneration,
  namespaceId,
  objectId,
} from "../../src/v2-types/ids.ts";

describe("genesis tombstone inventory properties", () => {
  test("is permutation-stable for bounded multi-Namespace Human sets", () => {
    for (const count of [1, 2, 8, 32]) {
      const crypto = new LatticeCrypto(seededRng(0x243_50 + count));
      const signing = crypto.generateSigningKeyPair();
      const targetObjectId = objectId(`object-property-${count}`);
      const envelopes = Array.from({ length: count }, (_, index) =>
        encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespaceV2(
          crypto,
          new Uint8Array(32).fill(index + 1),
          {
            objectId: targetObjectId,
            namespaceId: namespaceId(`namespace-${index}`),
            keyClass: "human",
            keyGeneration: namespaceGeneration(index),
            bindingRevisionAtWrap: accessRevision(index),
          },
          new Uint8Array(32).fill(index + 33),
        ))
      );
      const input = {
        objectId: targetObjectId,
        payloadHash: new Uint8Array(32).fill(0x71),
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: cryptoDeviceId("device-property"),
        hostAuthorizationRevision: authorizationRevision(9),
        signingPrivateKey: signing.privateKey,
      } as const;
      const forward = prepareObjectAccessManifestGenesisWithTombstoneV2(
        crypto,
        { ...input, envelopeBytes: envelopes },
      );
      const reverse = prepareObjectAccessManifestGenesisWithTombstoneV2(
        crypto,
        { ...input, envelopeBytes: [...envelopes].reverse() },
      );

      expect(forward.genesis.manifestBytes).toEqual(
        reverse.genesis.manifestBytes,
      );
      expect(forward.preauthorizedTombstone.manifestBytes).toEqual(
        reverse.preauthorizedTombstone.manifestBytes,
      );
      expect(forward.genesis.envelopeBytes).toHaveLength(count);
      expect(forward.preauthorizedTombstone.manifest.envelopeHashes)
        .toEqual([]);
    }
  });
});
