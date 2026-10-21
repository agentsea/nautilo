import {
  readTaskRuntimeSignerAuthorizationIssuer,
  type LatticeCrypto,
  type ResolveHistoricalTaskRuntimeSignerAuthorizationIssuer,
} from "@nautilo/lattice-crypto";
import {
  MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
} from "@nautilo/lattice-crypto/background";
import type { ResolveTaskRuntimeSignerAuthorizationBytesV5 } from
  "@nautilo/lattice-crypto/wire";

import type { OpenedClientDeviceProfileV4 } from
  "../client-vault/profile-v4.ts";

export type TaskRuntimeSignerCertificateEvidenceTransportV1 = Readonly<{
  kind: "task_runtime_signer_certificate";
  evidenceBytesBase64url: string;
}>;

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function fromBase64url(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new TypeError("Task Runtime signer evidence is not canonical base64url");
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length < 1
    || bytes.length > MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1) {
    bytes.fill(0);
    throw new RangeError("Task Runtime signer evidence exceeds its wire bound");
  }
  let canonical = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    canonical += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  canonical = btoa(canonical).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
  if (canonical !== value) {
    bytes.fill(0);
    throw new TypeError("Task Runtime signer evidence is not canonical base64url");
  }
  return bytes;
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function hex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Supplies Task certificate evidence only for one authenticated object read.
 * Evidence and trusted keys are wiped after the synchronous verification
 * callback and are never retained in the device profile.
 */
export function withTaskRuntimeSignerEvidenceResolversV1<Value>(input: Readonly<{
  crypto: LatticeCrypto;
  profile: OpenedClientDeviceProfileV4;
  subjectHumanId: string;
  ownDeviceGeneration?: number;
  expectedWork?: Readonly<{ taskId: string; taskRunId: string }>;
  evidence: readonly TaskRuntimeSignerCertificateEvidenceTransportV1[];
  operation(resolvers: Readonly<{
    resolveTaskRuntimeSignerAuthorizationBytes:
      ResolveTaskRuntimeSignerAuthorizationBytesV5;
    resolveHistoricalTaskRuntimeIssuer:
      ResolveHistoricalTaskRuntimeSignerAuthorizationIssuer;
  }>): Value;
}>): Value {
  const certificates = new Map<string, Uint8Array>();
  const keys: Uint8Array[] = [];
  try {
    for (const entry of input.evidence) {
      const bytes = fromBase64url(entry.evidenceBytesBase64url);
      let hash: Uint8Array | undefined;
      try {
        const issuer = readTaskRuntimeSignerAuthorizationIssuer(
          input.crypto,
          bytes,
        );
        issuer.headDigest.fill(0);
        issuer.signingPublicKeyHash.fill(0);
        hash = input.crypto.hash(bytes);
        const coordinate = hex(hash);
        if (certificates.has(coordinate)) {
          throw new TypeError("Task Runtime signer evidence collided");
        }
        certificates.set(coordinate, bytes);
      } catch (error) {
        bytes.fill(0);
        throw error;
      } finally { hash?.fill(0); }
    }
    const resolveHistoricalTaskRuntimeIssuer:
      ResolveHistoricalTaskRuntimeSignerAuthorizationIssuer = context => {
        const issuer = context.issuer;
        if (input.expectedWork !== undefined
          && (context.projection.work.taskId !== input.expectedWork.taskId
            || context.projection.work.taskRunId
              !== input.expectedWork.taskRunId)) return null;
        const candidates: Uint8Array[] = [];
        const base = input.profile.baseProfile.baseProfile;
        if (input.ownDeviceGeneration !== undefined
          && issuer.humanId === input.subjectHumanId
          && issuer.deviceId === base.deviceId
          && issuer.deviceGeneration === input.ownDeviceGeneration) {
          candidates.push(base.signingPublicKey);
        }
        for (const evidence of input.profile.signerEvidence) {
          if (evidence.kind !== "shared_human_domain_trust") continue;
          for (const device of evidence.devices) {
            if (device.humanId === issuer.humanId
              && device.deviceId === issuer.deviceId
              && device.deviceGeneration === issuer.deviceGeneration) {
              candidates.push(device.signingPublicKey);
            }
          }
        }
        const trusted = candidates.filter(candidate => {
          const digest = input.crypto.hash(candidate);
          try { return same(digest, issuer.signingPublicKeyHash); }
          finally { digest.fill(0); }
        });
        if (trusted.length < 1
          || trusted.some(candidate => !same(candidate, trusted[0]!))) return null;
        const owned = trusted[0]!.slice();
        keys.push(owned);
        return owned;
      };
    return input.operation(Object.freeze({
      resolveTaskRuntimeSignerAuthorizationBytes: evidence =>
        certificates.get(hex(evidence.authorizationHash)) ?? null,
      resolveHistoricalTaskRuntimeIssuer,
    }));
  } finally {
    certificates.forEach(bytes => bytes.fill(0));
    keys.forEach(key => key.fill(0));
  }
}
