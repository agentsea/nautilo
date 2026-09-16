import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createObjectAccessManifestV2,
} from "../../src/format/object-access-manifest-v2.ts";
import {
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  assertEnvelopeAuthorizedV2,
  prepareObjectAccessManifestUpdateV2,
  verifyObjectAccessManifestChainV2,
} from "../../src/object/access-manifest.ts";
import {
  wrapObjectDekForNamespaceV2,
} from "../../src/object/namespace-envelope.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  namespaceGeneration,
  namespaceId,
  objectId,
} from "../../src/v2-types/ids.ts";

function nextRandom(state: { value: number }): number {
  let value = state.value >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0;
  return state.value;
}

function hex(value: Uint8Array): string {
  return Array.from(
    value,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("v2 recorded-seed object attachment properties", () => {
  test("arbitrary attach/detach sequences preserve the exact canonical set", () => {
    for (let seed = 1; seed <= 32; seed++) {
      try {
        const crypto = new LatticeCrypto(seededRng(seed ^ 0x225a));
        const random = { value: seed };
        const signing = crypto.generateSigningKeyPair();
        const committerDeviceId = cryptoDeviceId("device_alice");
        const targetObjectId = objectId("object_property");
        const payloadHash = crypto.hash(
          new TextEncoder().encode("stable-payload"),
        );
        const pool = Array.from({ length: 16 }, (_, index) =>
          encodeNamespaceObjectEnvelopeV2(
            wrapObjectDekForNamespaceV2(
              crypto,
              new Uint8Array(32).fill(index + 1),
              {
                objectId: targetObjectId,
                namespaceId: namespaceId(`namespace_${index}`),
                keyClass: "human",
                keyGeneration: namespaceGeneration(0),
                bindingRevisionAtWrap: accessRevision(0),
              },
              new Uint8Array(32).fill(index + 33),
            ),
          )
        );
        const genesis = createObjectAccessManifestV2(
          crypto,
          {
            objectId: targetObjectId,
            payloadHash,
            accessRevision: accessRevision(0),
            previousManifestHash: null,
            envelopeHashes: [],
            committerDeviceId,
            hostAuthorizationRevision: authorizationRevision(0),
          },
          signing.privateKey,
        );
        const attached = new Set<number>();
        let manifestBytes = genesis.bytes;
        let manifestHash = genesis.hash;
        let envelopeBytes: readonly Uint8Array[] = [];

        for (let step = 1; step <= 32; step++) {
          const available = pool
            .map((_, index) => index)
            .filter((index) => !attached.has(index));
          const present = [...attached];
          const attach = present.length === 0
            || (available.length > 0 && (nextRandom(random) & 1) === 1);
          const candidates = attach ? available : present;
          const selected = candidates[nextRandom(random) % candidates.length]!;
          const previousManifestBytes = manifestBytes.slice();
          const previousEnvelopes = envelopeBytes.map((value) => value.slice());
          const prepared = prepareObjectAccessManifestUpdateV2(crypto, {
            currentManifestBytes: manifestBytes,
            currentEnvelopeBytes: envelopeBytes,
            trustedMinimumHead: {
              objectId: targetObjectId,
              payloadHash,
              accessRevision: accessRevision(step - 1),
              manifestHash,
            },
            proof: [],
            resolveSigningPublicKey: (deviceId) =>
              deviceId === committerDeviceId ? signing.publicKey : null,
            operation: {
              type: attach ? "attach" : "detach",
              envelopeBytes: pool[selected]!,
            },
            sourceAuthorized: true,
            targetAuthorized: true,
            committerDeviceId,
            hostAuthorizationRevision: authorizationRevision(step),
            signingPrivateKey: signing.privateKey,
          });
          if (attach) attached.add(selected);
          else attached.delete(selected);

          manifestBytes = prepared.manifestBytes;
          manifestHash = prepared.manifestHash;
          envelopeBytes = prepared.envelopeBytes;
          const verified = verifyObjectAccessManifestChainV2(crypto, {
            manifestBytes,
            proof: [],
            trustedMinimumHead: {
              objectId: targetObjectId,
              payloadHash,
              accessRevision: accessRevision(step),
              manifestHash,
            },
            resolveSigningPublicKey: (deviceId) =>
              deviceId === committerDeviceId ? signing.publicKey : null,
          });
          expect(Number(verified.manifest.accessRevision)).toBe(step);
          expect(
            new Set(envelopeBytes.map((value) => hex(crypto.hash(value)))),
          ).toEqual(
            new Set([...attached].map((index) => hex(crypto.hash(pool[index]!)))),
          );
          for (let index = 0; index < pool.length; index++) {
            const authorize = () =>
              assertEnvelopeAuthorizedV2(crypto, verified, pool[index]!);
            if (attached.has(index)) expect(authorize).not.toThrow();
            else expect(authorize).toThrow("detached");
          }
          expect(previousManifestBytes).not.toEqual(manifestBytes);
          expect(previousEnvelopes).not.toBe(envelopeBytes);
        }
      } catch (error) {
        throw new Error(
          `object attachment property failed; replay seed ${seed}`,
          { cause: error },
        );
      }
    }
  });
});
