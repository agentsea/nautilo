import type {
  EncryptionCoverageEntry,
  KeyFamily,
} from "../src/model";

const SCHEMA_EVIDENCE =
  "packages/db/tests/unit/domain-key-authority-schema.test.ts";
const PROTOCOL_EVIDENCE =
  "packages/lattice-bridge/tests/integration/postgres-native-v2-authority.integration.test.ts";
const CLIENT_EVIDENCE =
  "packages/lattice-bridge/tests/unit/domain-key-authority-client.test.ts";
const BRIDGE_REPOSITORY =
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts";

type TableDeclaration = Readonly<{
  columns: readonly string[];
  protectedColumns: readonly string[];
}>;

const TABLES = {
  domain_key_publication_operations: {
    columns: [
      "operation_id", "idempotency_key", "domain_id", "key_class",
      "participant_digest", "participant_count", "domain_key_generation",
      "authorization_revision", "expected_previous_head_digest", "head_digest",
      "head_bytes", "issuer_human_id", "issuer_device_id",
      "issuer_device_signing_generation", "state", "failure_code", "created_at",
      "updated_at", "deadline_at", "activated_at", "terminal_at",
    ],
    protectedColumns: ["head_bytes"],
  },
  domain_key_heads: {
    columns: [
      "domain_id", "key_class", "participant_digest", "participant_count",
      "domain_key_generation", "authorization_revision", "head_digest",
      "previous_head_digest", "head_bytes", "publication_operation_id",
      "issuer_human_id", "issuer_device_id", "issuer_device_signing_generation",
      "activated_at",
    ],
    protectedColumns: ["head_bytes"],
  },
  domain_key_recipient_requests: {
    columns: [
      "request_id", "idempotency_key", "domain_id", "key_class",
      "domain_key_generation", "authorization_revision", "head_digest",
      "recipient_human_id", "recipient_kind", "recipient_key_id",
      "recipient_key_generation", "recipient_public_key_digest", "request_digest",
      "request_bytes", "state", "fulfillment_authorization_digest",
      "fulfillment_envelope_digest", "failure_code", "created_at", "updated_at",
      "deadline_at", "fulfilled_at", "terminal_at",
    ],
    protectedColumns: ["request_bytes"],
  },
  domain_key_recipient_envelopes: {
    columns: [
      "domain_id", "key_class", "domain_key_generation", "authorization_revision",
      "head_digest", "recipient_human_id", "recipient_kind", "recipient_key_id",
      "recipient_key_generation", "recipient_public_key_digest", "envelope_digest",
      "envelope_bytes", "authorization_digest", "authorization_bytes",
      "source_request_id", "issuer_human_id", "issuer_device_id",
      "issuer_device_signing_generation", "created_at",
    ],
    protectedColumns: ["envelope_bytes", "authorization_bytes"],
  },
  domain_key_envelope_acknowledgements: {
    columns: [
      "acknowledgement_id", "domain_id", "key_class", "domain_key_generation",
      "authorization_revision", "recipient_kind", "recipient_key_id",
      "recipient_key_generation", "recipient_device_id", "recipient_device_revision",
      "request_digest", "envelope_digest", "acknowledgement_digest",
      "acknowledgement_bytes", "created_at",
    ],
    protectedColumns: ["acknowledgement_bytes"],
  },
  namespace_domain_key_bindings: {
    columns: [
      "operation_id", "idempotency_key", "namespace_id", "domain_id", "key_class",
      "domain_key_generation", "domain_authorization_revision", "domain_head_digest",
      "namespace_access_revision", "namespace_current_generation", "bundle_revision",
      "retained_generation_count", "retained_authority_set_digest",
      "previous_binding_digest", "binding_digest", "plaintext_digest",
      "ciphertext_digest", "binding_bytes", "issuer_human_id", "issuer_device_id",
      "issuer_device_signing_generation", "state", "failure_code", "created_at",
      "updated_at", "deadline_at", "activated_at", "terminal_at",
    ],
    protectedColumns: ["binding_bytes"],
  },
  namespace_domain_key_heads: {
    columns: [
      "namespace_id", "key_class", "domain_id", "domain_key_generation",
      "domain_authorization_revision", "domain_head_digest",
      "namespace_access_revision", "namespace_current_generation", "bundle_revision",
      "retained_generation_count", "retained_authority_set_digest", "binding_digest",
      "binding_operation_id", "activated_at",
    ],
    protectedColumns: [],
  },
} as const satisfies Readonly<Record<string, TableDeclaration>>;

function stable(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "").toLowerCase();
}

function boundedDb(
  table: string,
  locator: string,
  fields: readonly string[],
): EncryptionCoverageEntry {
  return {
    id: `db.m301.${stable(table)}.${stable(locator.split(".").at(-1)!)}`,
    surface: "db",
    locator,
    owner: "packages/lattice-bridge",
    readers: [BRIDGE_REPOSITORY],
    writers: [BRIDGE_REPOSITORY],
    migrationState: "not_applicable",
    retention:
      "Retained only with the authenticated V2 Domain-key authority, delivery, acknowledgement, or Namespace-binding lifecycle.",
    testEvidence: [SCHEMA_EVIDENCE, PROTOCOL_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: fields,
    plaintextReason:
      "The exact field set contains only bounded identifiers, public-key coordinates, digests, counters, enums, lifecycle timestamps, or signed public protocol metadata; it contains no Human-authored content or raw key bytes.",
  };
}

function protectedEntry(
  id: string,
  surface: "db" | "wire",
  locator: string,
  keyFamily: KeyFamily = "namespace_human",
): EncryptionCoverageEntry {
  return {
    id,
    surface,
    locator,
    owner: surface === "db" ? "packages/lattice-bridge" : "packages/server",
    readers: surface === "db"
      ? [BRIDGE_REPOSITORY]
      : ["packages/lattice-bridge/src/client/message/domain-key-authority-client.ts"],
    writers: surface === "db"
      ? [BRIDGE_REPOSITORY]
      : ["packages/server/src/routes/domain-key-authority.ts"],
    migrationState: "ciphertext_only",
    retention:
      "Retained or transported only as authenticated opaque ciphertext, a wrapped Domain key, or a signed encrypted Namespace bundle; raw Domain and Namespace keys are excluded.",
    testEvidence: [SCHEMA_EVIDENCE, PROTOCOL_EVIDENCE, CLIENT_EVIDENCE],
    classification: "protected",
    keyFamily,
    bridgeRepository: BRIDGE_REPOSITORY,
    negativeTestEvidence: [PROTOCOL_EVIDENCE, CLIENT_EVIDENCE],
  };
}

const schemaEntries: readonly EncryptionCoverageEntry[] =
  Object.entries(TABLES).flatMap(([table, declaration]) => {
    const protectedColumns = new Set<string>(declaration.protectedColumns);
    const tableLocator = `public.${table}`;
    return [
      protectedColumns.size > 0
        ? protectedEntry(`db.m301.${stable(table)}.table`, "db", tableLocator)
        : boundedDb(table, tableLocator, declaration.columns),
      ...declaration.columns.map((column) => {
        const locator = `${tableLocator}.${column}`;
        return protectedColumns.has(column)
          ? protectedEntry(`db.m301.${stable(table)}.${stable(column)}`, "db", locator)
          : boundedDb(table, locator, [column]);
      }),
    ];
  });

const WRITER_LOCATORS = [
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#acknowledgeEnvelope:insert:public.domain_key_envelope_acknowledgements:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#expirePendingRecipientRequests:update:public.domain_key_recipient_requests:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#fulfilRecipientRequest:insert:public.domain_key_recipient_envelopes:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#fulfilRecipientRequest:update:public.domain_key_recipient_requests:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#loadOrCreateDomain:insert:public.crypto_domains:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishHead:insert:public.domain_key_heads:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishHead:insert:public.domain_key_publication_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishHead:insert:public.domain_key_recipient_envelopes:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishHead:insert:public.domain_key_recipient_envelopes:2",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishHead:update:public.domain_key_heads:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishHead:update:public.domain_key_publication_operations:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishHead:update:public.domain_key_recipient_requests:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishNamespaceBundle:insert:public.namespace_domain_key_bindings:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishNamespaceBundle:insert:public.namespace_domain_key_heads:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishNamespaceBundle:update:public.namespace_domain_key_bindings:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#publishNamespaceBundle:update:public.namespace_domain_key_heads:1",
  "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts#requestRecipient:insert:public.domain_key_recipient_requests:1",
] as const;

const WIRE_LOCATORS = [
  "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/bundle/plan",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/bundle/publish",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/plan",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/publish",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/acknowledge",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/fetch",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/fulfil",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/pending",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/request",
  "ws:server_to_client:crypto.domain_key_catch_up_delivered",
  "ws:server_to_client:crypto.domain_key_catch_up_requested",
] as const;

const wireEntries: readonly EncryptionCoverageEntry[] = WIRE_LOCATORS.map(
  (locator, index) => protectedEntry(
    `wire.m301.domain-authority-${String(index + 1).padStart(2, "0")}`,
    "wire",
    locator,
  ),
);

export const REVIEWED_M301_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...schemaEntries,
  ...wireEntries,
];

/** Exact Drizzle callsites reviewed before advancing the writer fingerprint. */
export const REVIEWED_M301_DATABASE_WRITER_LOCATORS = WRITER_LOCATORS;
