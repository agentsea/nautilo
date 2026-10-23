import {
  accessRevision,
  objectId,
  type LatticeCrypto,
  type TrustedMinimumObjectAccessHead,
} from "@nautilo/lattice-crypto";
import {
  decodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";

type HumanSignerEvidence = Readonly<{
  kind: "human_device";
  subjectHumanId: string;
  committerDeviceId: string;
  hostAuthorizationRevision: number;
  signingPublicKeyBase64url: string;
}>;

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export function sameTaskAccessBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

export function taskHumanSignerCoordinate(input: Readonly<{
  subjectHumanId: string;
  committerDeviceId: string;
  hostAuthorizationRevision: number;
}>): string {
  return `${input.subjectHumanId}\0${input.committerDeviceId}\0${input.hostAuthorizationRevision}`;
}

function decodeBase64url(label: string, value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  let roundTrip = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    roundTrip += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (btoa(roundTrip).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "") !== value) {
    bytes.fill(0);
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return bytes;
}

function wipeManifest(
  manifest: ReturnType<typeof decodeObjectAccessManifestV5>,
): void {
  manifest.payloadHash.fill(0);
  manifest.previousManifestHash?.fill(0);
  manifest.envelopeHashes.forEach(hash => hash.fill(0));
  manifest.signerAuthorizationHash?.fill(0);
  manifest.signature.fill(0);
}

export function exactTaskHumanSignerKeys(input: Readonly<{
  evidence: readonly unknown[];
  chain: readonly Uint8Array[];
  expectedHumanId: string;
}>): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  try {
    for (const candidate of input.evidence) {
      if (typeof candidate !== "object" || candidate === null
        || Array.isArray(candidate)
        || (candidate as { kind?: unknown }).kind !== "human_device") continue;
      const evidence = candidate as HumanSignerEvidence;
      if (evidence.subjectHumanId !== input.expectedHumanId) {
        throw new TypeError("Protected Task Human signer subject is invalid");
      }
      const key = decodeBase64url(
        "Protected Task Human signer key",
        evidence.signingPublicKeyBase64url,
      );
      if (key.length !== 32) {
        key.fill(0);
        throw new TypeError("Protected Task Human signer key is invalid");
      }
      const coordinate = taskHumanSignerCoordinate(evidence);
      if (keys.has(coordinate)) {
        key.fill(0);
        throw new TypeError("Protected Task Human signer evidence collided");
      }
      keys.set(coordinate, key);
    }
    const required = new Set<string>();
    for (const bytes of input.chain) {
      const manifest = decodeObjectAccessManifestV5(bytes);
      try {
        if (manifest.signer.kind === "human_device") {
          if (manifest.signer.subjectHumanId !== input.expectedHumanId) {
            throw new TypeError("Protected Task Human signer subject changed");
          }
          required.add(taskHumanSignerCoordinate({
            subjectHumanId: manifest.signer.subjectHumanId,
            committerDeviceId: manifest.signer.committerDeviceId,
            hostAuthorizationRevision: manifest.hostAuthorizationRevision,
          }));
        }
      } finally {
        wipeManifest(manifest);
      }
    }
    if (required.size !== keys.size
      || [...required].some(coordinate => !keys.has(coordinate))) {
      throw new TypeError("Protected Task Human signer evidence is inexact");
    }
    return keys;
  } catch (error) {
    keys.forEach(key => key.fill(0));
    throw error;
  }
}

export function assertTaskAccessRewrapSigners(
  chain: readonly Uint8Array[],
  expectedHumanId: string,
): void {
  for (const bytes of chain.slice(1)) {
    const manifest = decodeObjectAccessManifestV5(bytes);
    try {
      if (manifest.signer.kind !== "human_device"
        || manifest.signer.subjectHumanId !== expectedHumanId) {
        throw new TypeError("Protected Task access rewrap signer is invalid");
      }
    } finally {
      wipeManifest(manifest);
    }
  }
}

export type PreparedTaskAccessManifestChain = Readonly<{
  fullChain: readonly Uint8Array[];
  proof: readonly Uint8Array[];
  trustedMinimumHead: TrustedMinimumObjectAccessHead;
  nextAnchor: TrustedMinimumObjectAccessHead;
  genesisManifestBytes: Uint8Array;
}>;

export function prepareTaskAccessManifestChain(input: Readonly<{
  crypto: LatticeCrypto;
  objectId: string;
  payloadHash: Uint8Array;
  headManifestBytes: Uint8Array;
  proofManifestBytes: readonly Uint8Array[];
  retained: TrustedMinimumObjectAccessHead | null;
}>): PreparedTaskAccessManifestChain {
  const head = decodeObjectAccessManifestV5(input.headManifestBytes);
  try {
    if (head.objectId !== input.objectId
      || !sameTaskAccessBytes(head.payloadHash, input.payloadHash)
      || input.proofManifestBytes.length !== head.accessRevision) {
      throw new TypeError("Protected Task access chain coordinates are invalid");
    }
    const fullChain = Object.freeze([
      ...input.proofManifestBytes,
      input.headManifestBytes,
    ]);
    const proof = [...input.proofManifestBytes];
    let genesisManifestBytes: Uint8Array;
    let trustedMinimumHead: TrustedMinimumObjectAccessHead;
    if (input.retained === null) {
      genesisManifestBytes = head.accessRevision === 0
        ? input.headManifestBytes
        : proof.shift()!;
      if (genesisManifestBytes === undefined) {
        throw new TypeError("Protected Task access genesis is missing");
      }
      const genesis = decodeObjectAccessManifestV5(genesisManifestBytes);
      try {
        if (genesis.accessRevision !== 0
          || genesis.previousManifestHash !== null
          || genesis.objectId !== head.objectId
          || !sameTaskAccessBytes(genesis.payloadHash, head.payloadHash)) {
          throw new TypeError("Protected Task access genesis is invalid");
        }
        trustedMinimumHead = Object.freeze({
          objectId: objectId(genesis.objectId),
          payloadHash: Uint8Array.from(genesis.payloadHash),
          accessRevision: accessRevision(0),
          manifestHash: input.crypto.hash(genesisManifestBytes),
        });
      } finally {
        wipeManifest(genesis);
      }
    } else {
      genesisManifestBytes = fullChain[0]!;
      trustedMinimumHead = input.retained;
      if (head.accessRevision < input.retained.accessRevision
        || input.retained.objectId !== head.objectId
        || !sameTaskAccessBytes(input.retained.payloadHash, head.payloadHash)) {
        throw new TypeError("Protected Task access chain rolled back");
      }
      if (head.accessRevision > input.retained.accessRevision) {
        const anchorIndex = proof.findIndex(bytes => {
          const candidate = decodeObjectAccessManifestV5(bytes);
          try {
            if (candidate.accessRevision !== input.retained!.accessRevision) {
              return false;
            }
            const digest = input.crypto.hash(bytes);
            try {
              return sameTaskAccessBytes(digest, input.retained!.manifestHash);
            } finally {
              digest.fill(0);
            }
          } finally {
            wipeManifest(candidate);
          }
        });
        if (anchorIndex < 0) {
          throw new TypeError("Protected Task trusted access anchor is missing");
        }
        proof.splice(0, anchorIndex + 1);
      } else {
        proof.length = 0;
      }
    }
    return Object.freeze({
      fullChain,
      proof: Object.freeze(proof),
      trustedMinimumHead,
      nextAnchor: Object.freeze({
        objectId: objectId(head.objectId),
        payloadHash: Uint8Array.from(head.payloadHash),
        accessRevision: accessRevision(head.accessRevision),
        manifestHash: input.crypto.hash(input.headManifestBytes),
      }),
      genesisManifestBytes,
    });
  } finally {
    wipeManifest(head);
  }
}

export function destroyPreparedTaskAccessManifestChain(
  prepared: PreparedTaskAccessManifestChain,
  retained: TrustedMinimumObjectAccessHead | null,
): void {
  if (prepared.trustedMinimumHead !== retained) {
    prepared.trustedMinimumHead.payloadHash.fill(0);
    prepared.trustedMinimumHead.manifestHash.fill(0);
  }
  prepared.nextAnchor.payloadHash.fill(0);
  prepared.nextAnchor.manifestHash.fill(0);
}
