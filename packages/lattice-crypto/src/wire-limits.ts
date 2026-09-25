/**
 * Wire bounds for data-only client schemas. Do not re-export the full wire
 * barrel here: Metro traverses unused exports and would load MLS providers.
 * Values remain owned by their codecs; this entry point adds no policy.
 */
export { MAX_RETAINED_NAMESPACE_GENERATIONS_V2 } from "./v2-types/limits.ts";
export { MAX_AGENT_GRANT_DOMAINS_V2, MAX_AGENT_GRANT_NAMESPACES_V2 } from
  "./v2-types/limits.ts";
export { DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2 } from
  "./format/domain-foreground-authorization-v2.ts";
export {
  HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2,
  MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2,
} from "./memory/exact-access-request-v1.ts";
export { MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2 } from
  "./memory/content-embedding-request-v1.ts";
export { MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5 } from
  "./format/object-access-manifest-v5.ts";
export { MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1 } from
  "./message/history-read-acknowledgement-v1.ts";
export { MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1 } from
  "./message/existing-representation-publication-request-v1.ts";
export { MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2, MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2 } from
  "./format/object-v2.ts";
export { LATTICE_LIMITS } from "./limits.ts";
