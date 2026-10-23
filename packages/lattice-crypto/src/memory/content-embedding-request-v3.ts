import type { LatticeCrypto } from "../crypto/index.ts";
import type { UnixTimestamp } from "../v2-types/ids.ts";
import type { MemoryEmbeddingDisclosureV2 } from "./embedding-disclosure-v2.ts";
import {
  humanMemoryContentEmbeddingRequestSigningBytesForVersion,
  encodeHumanMemoryContentEmbeddingRequestForVersion,
  decodeHumanMemoryContentEmbeddingRequestForVersion,
  prepareHumanMemoryContentEmbeddingRequestForVersion,
  verifyHumanMemoryContentEmbeddingRequestForVersion,
  type HumanMemoryContentEmbeddingRequestUnsignedV2,
} from "./content-embedding-request-v1.ts";

export const HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V3 = 3 as const;
export const HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DOMAIN_V3 =
  "nautilo/lattice-crypto/human-memory-content-embedding-request/v3";
export const HUMAN_MEMORY_CONTENT_EMBEDDING_PROCESSOR_CONTRACT_VERSION_V3 = 2 as const;

export interface HumanMemoryContentEmbeddingRequestUnsignedV3 extends Omit<
  HumanMemoryContentEmbeddingRequestUnsignedV2,
  "formatVersion" | "requestedProvider" | "requestedModel" | "dimensions" | "processorContractVersion"
> {
  readonly formatVersion: 3;
  readonly requestedEmbedding: MemoryEmbeddingDisclosureV2;
  readonly processorContractVersion: 2;
}
export interface HumanMemoryContentEmbeddingRequestV3 extends HumanMemoryContentEmbeddingRequestUnsignedV3 {
  readonly signature: Uint8Array;
}
export interface PrepareHumanMemoryContentEmbeddingRequestInputV3 extends Omit<HumanMemoryContentEmbeddingRequestUnsignedV3, "formatVersion" | "purpose"> {
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}
export interface CreatedHumanMemoryContentEmbeddingRequestV3 {
  readonly request: HumanMemoryContentEmbeddingRequestV3;
  readonly bytes: Uint8Array;
}
export function humanMemoryContentEmbeddingRequestSigningBytesV3(value: HumanMemoryContentEmbeddingRequestUnsignedV3): Uint8Array {
  return humanMemoryContentEmbeddingRequestSigningBytesForVersion(value, 3);
}
export function encodeHumanMemoryContentEmbeddingRequestV3(value: HumanMemoryContentEmbeddingRequestV3): Uint8Array {
  return encodeHumanMemoryContentEmbeddingRequestForVersion(value, 3);
}
export function decodeHumanMemoryContentEmbeddingRequestV3(bytes: Uint8Array): HumanMemoryContentEmbeddingRequestV3 {
  return decodeHumanMemoryContentEmbeddingRequestForVersion(bytes, 3) as HumanMemoryContentEmbeddingRequestV3;
}
export function prepareHumanMemoryContentEmbeddingRequestV3(crypto: LatticeCrypto, input: PrepareHumanMemoryContentEmbeddingRequestInputV3): CreatedHumanMemoryContentEmbeddingRequestV3 {
  return prepareHumanMemoryContentEmbeddingRequestForVersion(crypto, input, 3) as CreatedHumanMemoryContentEmbeddingRequestV3;
}
export function verifyHumanMemoryContentEmbeddingRequestV3(crypto: LatticeCrypto, input: Readonly<{
  requestBytes: Uint8Array; committerSigningPublicKey: Uint8Array; now: UnixTimestamp;
}>): HumanMemoryContentEmbeddingRequestV3 {
  return verifyHumanMemoryContentEmbeddingRequestForVersion(crypto, input, 3) as HumanMemoryContentEmbeddingRequestV3;
}
