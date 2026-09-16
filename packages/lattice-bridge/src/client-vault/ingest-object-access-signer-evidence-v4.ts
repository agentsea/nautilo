import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeAgentRuntimeSignerPublicationV1,
  decodeProcessorSignerAuthorizationV1,
} from "@nautilo/lattice-crypto/wire";

import {
  addClientSignerEvidenceV4,
  authenticateClientDeviceProfileV4,
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
  stageAndActivateClientDeviceProfileV4,
  type OpenedClientDeviceProfileV4,
} from "./profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
  PublicClientProfile,
} from "./types.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface ObjectAccessSignerEvidenceTransportV1 {
  readonly kind: "agent_runtime_publication" | "processor_authorization";
  readonly evidenceBytesBase64url: string;
}

export type ResolveTrustedObjectAccessEvidenceIssuerV4 = (
  input: Readonly<{
    deviceId: string;
    hostAuthorizationRevision: number;
    trustedDeviceRevision: number;
  }>,
) => Promise<Uint8Array | null>;

function fromBase64url(label: string, value: string): Uint8Array {
  if (
    typeof value !== "string"
    || value.length < 1
    || !BASE64URL.test(value)
    || value.length % 4 === 1
  ) throw new TypeError(`${label} is not canonical base64url`);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let canonical = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    canonical += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  canonical = btoa(canonical).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
  if (canonical !== value) {
    bytes.fill(0);
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return bytes;
}

function sameCoordinates(
  left: ClientProfileCoordinates,
  right: ClientProfileCoordinates,
): boolean {
  return left.serverScope === right.serverScope
    && left.userId === right.userId
    && left.humanActorId === right.humanActorId
    && left.profileId === right.profileId
    && left.deviceId === right.deviceId
    && left.installationLineageDigest === right.installationLineageDigest;
}

function activeProfile(
  profiles: readonly PublicClientProfile[],
  coordinates: ClientProfileCoordinates,
): PublicClientProfile {
  const matches = profiles.filter((profile) =>
    profile.lifecycle === "active"
    && sameCoordinates(profile.coordinates, coordinates)
  );
  if (matches.length !== 1) {
    throw new Error("Active client profile is unavailable or ambiguous");
  }
  return matches[0]!;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

/**
 * Authenticates public signer evidence delivered with one protected object and
 * atomically retains it before the caller attempts to verify/open that object.
 */
export async function ingestObjectAccessSignerEvidenceV4(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  evidence: readonly ObjectAccessSignerEvidenceTransportV1[];
  resolveTrustedIssuingDevicePublicKey:
    ResolveTrustedObjectAccessEvidenceIssuerV4;
  createStageId: () => string;
}>): Promise<void> {
  if (input.evidence.length === 0) return;
  const publicProfile = activeProfile(
    await input.vault.listPublicProfiles(),
    input.coordinates,
  );
  let candidate: OpenedClientDeviceProfileV4 | undefined;
  let currentBytes: Uint8Array | undefined;
  try {
    await input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
      currentBytes = profileBytes.slice();
      try {
        candidate = await authenticateClientDeviceProfileV4({
          crypto: input.crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
      } catch {
        candidate = await createClientDeviceProfileV4Candidate({
          crypto: input.crypto,
          currentProfileBytes: profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
      }
      for (const transport of input.evidence) {
        const evidenceBytes = fromBase64url(
          "Object access signer evidence",
          transport.evidenceBytesBase64url,
        );
        let issuingPublicKey: Uint8Array | null = null;
        try {
          const issuer = transport.kind === "agent_runtime_publication"
            ? (() => {
              const publication = decodeAgentRuntimeSignerPublicationV1(
                evidenceBytes,
              );
              return {
                deviceId: publication.managerDeviceId,
                hostAuthorizationRevision:
                  publication.managerAuthorizationRevision,
              };
            })()
            : (() => {
              const authorization = decodeProcessorSignerAuthorizationV1(
                evidenceBytes,
              );
              return {
                deviceId: authorization.issuingDeviceId,
                hostAuthorizationRevision:
                  authorization.issuingDeviceAuthorizationRevision,
              };
            })();
          const base = candidate.baseProfile.baseProfile;
          const resolvedIssuingPublicKey = issuer.deviceId === base.deviceId
              && issuer.hostAuthorizationRevision
                <= base.trustedHostAuthorizationRevision
            ? base.signingPublicKey.slice()
            : await input.resolveTrustedIssuingDevicePublicKey({
              ...issuer,
              trustedDeviceRevision: base.trustedDeviceRevision,
            });
          if (resolvedIssuingPublicKey === null) {
            throw new Error("Object access signer issuer is not trusted");
          }
          issuingPublicKey = resolvedIssuingPublicKey.slice();
          const next = await addClientSignerEvidenceV4({
            crypto: input.crypto,
            profile: candidate,
            evidence: {
              kind: transport.kind,
              evidenceBytes,
              issuingPublicKey,
            },
          });
          destroyOpenedClientDeviceProfileV4(candidate);
          candidate = next;
        } finally {
          evidenceBytes.fill(0);
          issuingPublicKey?.fill(0);
        }
      }
    });
    if (candidate === undefined) {
      throw new Error("Client profile v4 candidate is unavailable");
    }
    const candidateBytes = encodeClientDeviceProfileV4(candidate);
    try {
      if (currentBytes !== undefined && equalBytes(currentBytes, candidateBytes)) {
        return;
      }
    } finally {
      candidateBytes.fill(0);
    }
    await stageAndActivateClientDeviceProfileV4({
      crypto: input.crypto,
      vault: input.vault,
      coordinates: input.coordinates,
      stageId: input.createStageId(),
      generation: publicProfile.generation + 1,
      publicState: publicProfile.publicState,
      candidate,
    });
  } finally {
    currentBytes?.fill(0);
    if (candidate) destroyOpenedClientDeviceProfileV4(candidate);
  }
}
