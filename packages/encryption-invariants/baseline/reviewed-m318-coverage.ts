import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const PRODUCT = "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts";
const PRODUCT_TEST = "packages/lattice-bridge/tests/unit/postgres-conversation-product-store.test.ts";
const EDIT_TEST = "packages/lattice-bridge/tests/unit/human-ai-readable-live-shadow-message.test.ts";
const HISTORY_TEST = "packages/lattice-bridge/tests/unit/foreground-message-history-repair.test.ts";

const receiptColumns = [
  "session_id", "message_id", "edit_revision", "crypto_object_id",
  "expected_key_class", "authority_actor_id", "repair_identity_digest",
  "attestation_digest", "publisher_kind", "publisher_id", "policy_revision",
  "created_at",
] as const;

function boundedDb(id: string, locator: string, fields: readonly string[]): EncryptionCoverageEntry {
  return {
    id, surface: "db", locator, owner: "packages/lattice-bridge",
    readers: [PRODUCT], writers: [PRODUCT], migrationState: "not_applicable",
    retention: "Bounded content-free Message publication or repair authority metadata.",
    testEvidence: [PRODUCT_TEST, HISTORY_TEST], classification: "bounded_metadata",
    metadataAllowlist: fields,
    plaintextReason: "Stores only Message coordinates, policy and authority identifiers, enums, timestamps, and fixed-size verification digests; ordinary Message content, keys, envelopes, and encrypted payload bytes are excluded.",
  };
}

const receiptEntries: readonly EncryptionCoverageEntry[] = [
  boundedDb("db.m318.message-ordinary-repair.table", "public.session_message_ordinary_repairs", receiptColumns),
  ...receiptColumns.map((column) => boundedDb(
    `db.m318.message-ordinary-repair.${column.replaceAll("_", "-")}`,
    `public.session_message_ordinary_repairs.${column}`,
    [column],
  )),
];

const protectedEditRoute = "http:request_response:PATCH /api/rooms/:roomId/messages/:messageId/protected";
const planRoute = "http:request_response:POST /api/rooms/:roomId/messages/:messageId/edit-plan";
const shadowReadRoute = "http:request_response:POST /api/rooms/:id/messages/shadow-read";
const shadowReadAckRoute = "http:request_response:POST /api/rooms/:id/messages/shadow-read/:operationId/ack";

const routeEntries: readonly EncryptionCoverageEntry[] = [
  protectedEditRoute,
  `${protectedEditRoute}#request.body`,
].map((locator, index) => ({
  id: `wire.m318.protected-human-message-edit.${index + 1}`,
  surface: "wire" as const, locator, owner: "packages/server",
  readers: ["packages/lattice-bridge/src/client/message/vault-human-message-edit.ts"],
  writers: ["packages/server/src/routes/live-shadow-message-composition.ts"],
  migrationState: "ciphertext_only" as const,
  retention: "Request-scoped signed Human edit coordinates and authenticated Object-v2 protected storage bytes.",
  testEvidence: [EDIT_TEST], classification: "protected" as const,
  keyFamily: "namespace_ai_or_human" as const,
  bridgeRepository: "packages/lattice-bridge/src/client/message/vault-human-message-edit.ts",
  negativeTestEvidence: [EDIT_TEST],
}));

const boundedWireEntries: readonly EncryptionCoverageEntry[] = [
  planRoute, `${planRoute}#request.body`, `${shadowReadRoute}#request.body`,
].map((locator, index) => ({
  id: `wire.m318.message-authority-coordinates.${index + 1}`,
  surface: "wire", locator, owner: "packages/server",
  readers: ["packages/lattice-bridge/src/server/message/postgres-human-message-edit-plan.ts"],
  writers: ["packages/server/src/routes/live-shadow-message-composition.ts"],
  migrationState: "not_applicable", retention: "Request-scoped; not retained as an ordinary content representation.",
  testEvidence: [EDIT_TEST, HISTORY_TEST], classification: "bounded_metadata",
  metadataAllowlist: ["version", "operationId", "roomId", "messageId", "revision", "namespaceId", "keyClass", "digest", "signature", "deviceId", "policyRevision", "status", "reason"],
  plaintextReason: "Carries only structural authority, selection, status, and digest fields. Message content and raw key material are excluded.",
}));

export const SUPERSEDED_M318_COVERAGE_LOCATORS = new Set<string>([
  `${shadowReadAckRoute}#request.body`,
]);

export const REVIEWED_M318_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  {
    id: "link.wire.m318.shadow-read-existing-ordinary-message",
    surface: "wire",
    locator: shadowReadRoute,
    owner: "packages/server",
    targetDebtIds: ["debt.wire.http.accepted.arbitrary.packages.server.src.messaging.dispatch.ts.roompostmessagebody.cpix9d"],
    reason: "In Shadow, the ready response may carry the independently existing ordinary Message sibling as ordinaryPayloadBytesBase64url beside its protected representation. Full selects protected-only records and cannot emit that field. This is the same frozen ordinary Message content class, not metadata and not a new plaintext representation.",
    testEvidence: [HISTORY_TEST],
  },
  {
    id: "link.wire.m318.shadow-read-ack-ordinary-repair",
    surface: "wire",
    locator: `${shadowReadAckRoute}#request.body`,
    owner: "packages/server",
    targetDebtIds: ["debt.wire.http.accepted.arbitrary.packages.server.src.messaging.dispatch.ts.roompostmessagebody.cpix9d"],
    reason: "Only the signed_with_ordinary_repairs Shadow acknowledgement carries payloadBytesBase64url for an authenticated ordinary Message sibling repair. Full never issues or accepts that repair shape. The surrounding coordinates, signatures, and receipt digests are bounded metadata, but the payload itself remains the existing frozen ordinary Message content class.",
    testEvidence: [HISTORY_TEST],
  },
];

export const RETIRED_M318_DATABASE_WRITER_LOCATORS = new Set<string>([
  "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts##persistStaleMapping:raw_sql:update:public.session_message_crypto_revisions:1",
]);

export const REVIEWED_M318_COVERAGE_ENTRIES: readonly EncryptionCoverageEntry[] = [
  boundedDb("db.m318.message-lifecycle.representation-mode", "public.session_message_crypto_revisions.representation_mode", ["representation_mode"]),
  boundedDb("db.m318.message-lifecycle.publication-policy-revision", "public.session_message_crypto_revisions.publication_policy_revision", ["publication_policy_revision"]),
  ...receiptEntries,
  ...routeEntries,
  ...boundedWireEntries,
  {
    id: "db.m318.encryption-policy-advisory-lock", surface: "db",
    locator: "packages/db/src/utils/encryption-transition-queries.ts#lockEncryptionPolicy:raw_sql:unresolved:unresolved.dynamic_sql:1",
    owner: "packages/db", readers: ["packages/db/src/utils/encryption-transition-queries.ts"],
    writers: ["packages/db/src/utils/encryption-transition-queries.ts"],
    migrationState: "not_applicable", retention: "Transaction-scoped advisory lock only; no row or payload is retained.",
    testEvidence: ["packages/db/tests/unit/m274-encryption-transition-policy.test.ts"],
    classification: "bounded_metadata", metadataAllowlist: ["advisory_lock_key", "shared_or_exclusive"],
    plaintextReason: "The two closed SELECT statements acquire a fixed transaction advisory lock and neither read nor write product content.",
  },
];
