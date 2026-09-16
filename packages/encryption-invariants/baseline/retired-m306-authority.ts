const RETIRED_ROUTE_PREFIXES = [
  "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/",
] as const;

const RETIRED_SOURCE_PREFIXES = [
  "packages/db/scripts/finalize-m290-namespace-key-authority.ts#",
  "packages/db/scripts/finalize-m291-grant-domain-authority.ts#",
  "packages/lattice-bridge/src/server/delivery/postgres-namespace-bootstrap-repository.ts#",
  "packages/lattice-bridge/src/server/delivery/postgres-namespace-key-authority.ts#",
  "packages/lattice-bridge/src/server/delivery/postgres-grant-domain-authority.ts#",
  "packages/server/src/routes/device-wrapped-namespace-authority.ts#",
  "packages/server/src/routes/grant-domain-authority.ts#",
] as const;

const RETIRED_TABLE_PATTERN = /^public\.(?:namespace_key_(?:envelope_acknowledgements|generation_heads|publication_operations|recipient_authorization_operations|recipient_envelopes|recipient_sync_campaigns)|grant_domain_(?:envelope_acknowledgements|heads|publication_operations|recipient_authorization_operations|recipient_envelopes|recipient_sync_campaigns)|namespace_grant_domain_(?:bindings|heads))(?:\.|$)/u;

/** Current inventory filter for authority surfaces physically retired by M306. */
export function isRetiredM306AuthorityLocator(locator: string): boolean {
  return RETIRED_ROUTE_PREFIXES.some((prefix) => locator.startsWith(prefix))
    || RETIRED_SOURCE_PREFIXES.some((prefix) => locator.startsWith(prefix))
    || RETIRED_TABLE_PATTERN.test(locator);
}
