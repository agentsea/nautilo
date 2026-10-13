import { deriveTaskHistoricalContentCryptoObjectIdV1 } from "./task-historical-content-identity.ts";
import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";
import { encodeHumanExistingTaskRepresentationPublicationRequestV1 } from
  "@nautilo/lattice-crypto/wire";
import { sha256 } from "@noble/hashes/sha2.js";

import { readPreparedHistoricalTaskContentRequestV1 } from
  "./task-content-prepared-revision.ts";
import type { PreparedTaskContentCryptoRevisionV1 } from
  "./task-content-repository.ts";

type TaskHistoricalRepairProvenanceCommon = Readonly<{
  claimId: string;
  publisherDeviceId: string;
  signedRequestDigest: string;
  sourceDigest: string;
  sourcePayloadHash: string;
  sourceRevision: 0;
}>;

export type TaskHistoricalRepairProvenanceV1 = TaskHistoricalRepairProvenanceCommon & (
  | Readonly<{ version: 1 }>
  | Readonly<{ version: 2; genesisManifestHash: string }>
);

const FIELDS = ["version", "claimId", "publisherDeviceId", "signedRequestDigest",
  "sourceDigest", "sourcePayloadHash", "sourceRevision"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const encoder = new TextEncoder();

/** Immutable, content-free facts; parsing does not confer publication authority. */
export function parseTaskHistoricalRepairProvenanceV1(
  value: unknown,
): TaskHistoricalRepairProvenanceV1 {
  const prototype: unknown = value === null || typeof value !== "object"
    ? undefined : Object.getPrototypeOf(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || prototype !== Object.prototype && prototype !== null
    ) {
    throw new TypeError("Historical Task repair provenance has invalid fields");
  }
  const version = Object.getOwnPropertyDescriptor(value, "version");
  const names = version !== undefined && "value" in version && version.value === 2
    ? [...FIELDS, "genesisManifestHash"] : [...FIELDS];
  if (Reflect.ownKeys(value).length !== names.length
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !names.includes(key))) {
    throw new TypeError("Historical Task repair provenance has invalid fields");
  }
  const fields: Record<string, unknown> = {};
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Historical Task repair provenance contains a non-data field");
    }
    fields[key] = descriptor.value;
  }
  if ((fields["version"] !== 1 && fields["version"] !== 2) || fields["sourceRevision"] !== 0
    || typeof fields["claimId"] !== "string" || !UUID.test(fields["claimId"])
    || typeof fields["publisherDeviceId"] !== "string"
    || !PORTABLE.test(fields["publisherDeviceId"])
    || encoder.encode(fields["publisherDeviceId"]).length > LATTICE_LIMITS.idBytes
    || ["signedRequestDigest", "sourceDigest", "sourcePayloadHash",
      ...(fields["version"] === 2 ? ["genesisManifestHash"] : [])].some(key =>
      typeof fields[key] !== "string" || !DIGEST.test(fields[key]))) {
    throw new TypeError("Historical Task repair provenance coordinates are invalid");
  }
  return Object.freeze(fields) as TaskHistoricalRepairProvenanceV1;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Only the source-bound, authenticated prepared revision admits historical mapping. */
export function preparedTaskHistoricalRepairProvenanceV1(
  prepared: PreparedTaskContentCryptoRevisionV1,
): TaskHistoricalRepairProvenanceV1 {
  const request = readPreparedHistoricalTaskContentRequestV1(prepared);
  const bytes = encodeHumanExistingTaskRepresentationPublicationRequestV1(request);
  try {
    return parseTaskHistoricalRepairProvenanceV1({
      ...(prepared.objectId === deriveTaskHistoricalContentCryptoObjectIdV1({
        coordinate: prepared.coordinate, sourceDigest: request.sourceDigest, namespaceId: request.namespaceId,
      }) ? { version: 2, genesisManifestHash: hex(request.manifestHash) } : { version: 1 }),
      claimId: request.claimId,
      publisherDeviceId: request.committerDeviceId,
      signedRequestDigest: hex(sha256(bytes)),
      sourceDigest: hex(request.sourceDigest),
      sourcePayloadHash: hex(request.sourcePayloadHash), sourceRevision: 0,
    });
  } finally { bytes.fill(0); }
}
