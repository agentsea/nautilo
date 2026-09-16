import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
  type PgPolicy,
} from "drizzle-orm/pg-core";

import { nautiloCryptoRole } from "./crypto-storage.ts";

/** M301 class-bound Human and AI Domain-key authority. */
export const DOMAIN_KEY_AUTHORITY_BYTE_LIMITS = Object.freeze({
  id: 128,
  hash: 32,
  head: 8 * 1024,
  envelope: 16 * 1024,
  authorization: 32 * 1024,
  delivery: 8 * 1024,
  namespaceBundle: 512 * 1024,
});

export const DOMAIN_KEY_AUTHORITY_COLLECTION_LIMITS = Object.freeze({
  maximumSafeCounter: Number.MAX_SAFE_INTEGER,
  operationTtlSeconds: 30,
});

export const DOMAIN_KEY_AUTHORITY_TABLE_NAMES = Object.freeze([
  "domain_key_publication_operations",
  "domain_key_heads",
  "domain_key_recipient_requests",
  "domain_key_recipient_envelopes",
  "domain_key_envelope_acknowledgements",
  "namespace_domain_key_bindings",
  "namespace_domain_key_heads",
] as const);

export type DomainKeyAuthorityTableName =
  (typeof DOMAIN_KEY_AUTHORITY_TABLE_NAMES)[number];
export type DomainKeyAuthorityTablePrivilege = "SELECT" | "INSERT" | "UPDATE";

export const DOMAIN_KEY_AUTHORITY_TABLE_PRIVILEGES = Object.freeze({
  domain_key_publication_operations: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  domain_key_heads: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  domain_key_recipient_requests: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  domain_key_recipient_envelopes: Object.freeze(["SELECT", "INSERT"]),
  domain_key_envelope_acknowledgements: Object.freeze(["SELECT", "INSERT"]),
  namespace_domain_key_bindings: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  namespace_domain_key_heads: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
} satisfies Readonly<
  Record<
    DomainKeyAuthorityTableName,
    readonly DomainKeyAuthorityTablePrivilege[]
  >
>);

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

function portableId(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`octet_length(${column}) between 1 and ${sql.raw(String(DOMAIN_KEY_AUTHORITY_BYTE_LIMITS.id))}
      and ${column} ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'`,
  );
}

function safeCounter(name: string, column: AnyPgColumn, minimum = 0) {
  return check(
    name,
    sql`${column} between ${sql.raw(String(minimum))}
      and ${sql.raw(String(DOMAIN_KEY_AUTHORITY_COLLECTION_LIMITS.maximumSafeCounter))}`,
  );
}

function exactBytes(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`octet_length(${column}) = ${sql.raw(String(DOMAIN_KEY_AUTHORITY_BYTE_LIMITS.hash))}`,
  );
}

function boundedBytes(name: string, column: AnyPgColumn, maximum: number) {
  return check(
    name,
    sql`octet_length(${column}) between 1 and ${sql.raw(String(maximum))}`,
  );
}

function keyClass(name: string, column: AnyPgColumn) {
  return check(name, sql`${column} in ('human', 'ai')`);
}

function selectPolicy(prefix: string): PgPolicy {
  return pgPolicy(`${prefix}_crypto_sel`, {
    for: "select",
    to: nautiloCryptoRole,
    using: sql`true`,
  });
}

function insertPolicy(prefix: string): PgPolicy {
  return pgPolicy(`${prefix}_crypto_ins`, {
    for: "insert",
    to: nautiloCryptoRole,
    withCheck: sql`true`,
  });
}

function updatePolicy(prefix: string): PgPolicy {
  return pgPolicy(`${prefix}_crypto_upd`, {
    for: "update",
    to: nautiloCryptoRole,
    using: sql`true`,
    withCheck: sql`true`,
  });
}

function mutablePolicies(prefix: string): PgPolicy[] {
  return [selectPolicy(prefix), insertPolicy(prefix), updatePolicy(prefix)];
}

function appendOnlyPolicies(prefix: string): PgPolicy[] {
  return [selectPolicy(prefix), insertPolicy(prefix)];
}

// V2 authority relations deliberately avoid foreign keys to one another.
// PostgreSQL's internal RI reads cannot traverse these FORCE RLS tables under
// the restricted crypto role. Field-complete migration validators and the
// repository's signed-protocol checks enforce those internal coordinates.
// Foreign keys to canonical product, identity, and older crypto tables remain.

export const domainKeyPublicationOperations = pgTable(
  "domain_key_publication_operations",
  {
    operationId: text("operation_id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    domainId: text("domain_id").notNull(),
    keyClass: text("key_class").notNull(),
    participantDigest: bytea("participant_digest").notNull(),
    participantCount: bigint("participant_count", { mode: "number" }).notNull(),
    domainKeyGeneration: bigint("domain_key_generation", { mode: "number" }).notNull(),
    authorizationRevision: bigint("authorization_revision", { mode: "number" }).notNull(),
    expectedPreviousHeadDigest: bytea("expected_previous_head_digest"),
    headDigest: bytea("head_digest").notNull(),
    headBytes: bytea("head_bytes").notNull(),
    issuerHumanId: text("issuer_human_id").notNull(),
    issuerDeviceId: text("issuer_device_id").notNull(),
    issuerDeviceSigningGeneration: bigint("issuer_device_signing_generation", { mode: "number" }).notNull(),
    state: text("state").notNull(),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    portableId("domain_key_pub_operation_portable", table.operationId),
    portableId("domain_key_pub_idempotency_portable", table.idempotencyKey),
    portableId("domain_key_pub_domain_portable", table.domainId),
    portableId("domain_key_pub_issuer_human_portable", table.issuerHumanId),
    portableId("domain_key_pub_issuer_device_portable", table.issuerDeviceId),
    keyClass("domain_key_pub_class", table.keyClass),
    exactBytes("domain_key_pub_participant_digest", table.participantDigest),
    safeCounter("domain_key_pub_participant_count", table.participantCount, 1),
    safeCounter("domain_key_pub_generation", table.domainKeyGeneration, 1),
    safeCounter("domain_key_pub_authorization_revision", table.authorizationRevision),
    exactBytes("domain_key_pub_previous_head_digest", table.expectedPreviousHeadDigest),
    exactBytes("domain_key_pub_head_digest", table.headDigest),
    boundedBytes("domain_key_pub_head_bytes", table.headBytes, DOMAIN_KEY_AUTHORITY_BYTE_LIMITS.head),
    safeCounter("domain_key_pub_issuer_signing_generation", table.issuerDeviceSigningGeneration, 1),
    check("domain_key_pub_state", sql`${table.state} in ('reserved', 'active', 'stale', 'expired', 'failed')`),
    portableId("domain_key_pub_failure_portable", table.failureCode),
    check("domain_key_pub_predecessor_shape", sql`(${table.domainKeyGeneration} = 1 and ${table.expectedPreviousHeadDigest} is null) or (${table.domainKeyGeneration} > 1 and ${table.expectedPreviousHeadDigest} is not null)`),
    unique("uq_domain_key_pub_idempotency").on(table.idempotencyKey),
    unique("uq_domain_key_pub_head_digest").on(table.headDigest),
    uniqueIndex("uq_domain_key_pub_live_head").on(table.domainId, table.keyClass).where(sql`${table.state} = 'reserved'`),
    index("idx_domain_key_pub_reconcile").on(table.state, table.deadlineAt),
    ...mutablePolicies("domain_key_pub"),
  ],
).enableRLS();

export const domainKeyHeads = pgTable(
  "domain_key_heads",
  {
    domainId: text("domain_id").notNull(),
    keyClass: text("key_class").notNull(),
    participantDigest: bytea("participant_digest").notNull(),
    participantCount: bigint("participant_count", { mode: "number" }).notNull(),
    domainKeyGeneration: bigint("domain_key_generation", { mode: "number" }).notNull(),
    authorizationRevision: bigint("authorization_revision", { mode: "number" }).notNull(),
    headDigest: bytea("head_digest").notNull(),
    previousHeadDigest: bytea("previous_head_digest"),
    headBytes: bytea("head_bytes").notNull(),
    publicationOperationId: text("publication_operation_id").notNull(),
    issuerHumanId: text("issuer_human_id").notNull(),
    issuerDeviceId: text("issuer_device_id").notNull(),
    issuerDeviceSigningGeneration: bigint("issuer_device_signing_generation", { mode: "number" }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.domainId, table.keyClass] }),
    portableId("domain_key_heads_domain_portable", table.domainId),
    keyClass("domain_key_heads_class", table.keyClass),
    exactBytes("domain_key_heads_participant_digest", table.participantDigest),
    safeCounter("domain_key_heads_participant_count", table.participantCount, 1),
    safeCounter("domain_key_heads_generation", table.domainKeyGeneration, 1),
    safeCounter("domain_key_heads_authorization_revision", table.authorizationRevision),
    exactBytes("domain_key_heads_head_digest", table.headDigest),
    exactBytes("domain_key_heads_previous_digest", table.previousHeadDigest),
    boundedBytes("domain_key_heads_head_bytes", table.headBytes, DOMAIN_KEY_AUTHORITY_BYTE_LIMITS.head),
    unique("uq_domain_key_heads_digest").on(table.headDigest),
    index("idx_domain_key_heads_participants").on(table.participantDigest, table.keyClass),
    ...mutablePolicies("domain_key_heads"),
  ],
).enableRLS();

export const domainKeyRecipientRequests = pgTable(
  "domain_key_recipient_requests",
  {
    requestId: text("request_id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    domainId: text("domain_id").notNull(),
    keyClass: text("key_class").notNull(),
    domainKeyGeneration: bigint("domain_key_generation", { mode: "number" }).notNull(),
    authorizationRevision: bigint("authorization_revision", { mode: "number" }).notNull(),
    headDigest: bytea("head_digest").notNull(),
    recipientHumanId: text("recipient_human_id").notNull(),
    recipientKind: text("recipient_kind").notNull(),
    recipientKeyId: text("recipient_key_id").notNull(),
    recipientKeyGeneration: bigint("recipient_key_generation", { mode: "number" }).notNull(),
    recipientPublicKeyDigest: bytea("recipient_public_key_digest").notNull(),
    requestDigest: bytea("request_digest").notNull(),
    requestBytes: bytea("request_bytes").notNull(),
    state: text("state").notNull(),
    fulfillmentAuthorizationDigest: bytea("fulfillment_authorization_digest"),
    fulfillmentEnvelopeDigest: bytea("fulfillment_envelope_digest"),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    portableId("domain_key_requests_request_portable", table.requestId),
    portableId("domain_key_requests_idempotency_portable", table.idempotencyKey),
    portableId("domain_key_requests_domain_portable", table.domainId),
    portableId("domain_key_requests_human_portable", table.recipientHumanId),
    portableId("domain_key_requests_key_portable", table.recipientKeyId),
    keyClass("domain_key_requests_class", table.keyClass),
    check("domain_key_requests_kind", sql`${table.recipientKind} in ('device', 'recovery')`),
    safeCounter("domain_key_requests_generation", table.domainKeyGeneration, 1),
    safeCounter("domain_key_requests_authorization_revision", table.authorizationRevision),
    safeCounter("domain_key_requests_recipient_generation", table.recipientKeyGeneration, 1),
    exactBytes("domain_key_requests_head_digest", table.headDigest),
    exactBytes("domain_key_requests_recipient_digest", table.recipientPublicKeyDigest),
    exactBytes("domain_key_requests_request_digest", table.requestDigest),
    exactBytes("domain_key_requests_fulfillment_auth_digest", table.fulfillmentAuthorizationDigest),
    exactBytes("domain_key_requests_fulfillment_envelope_digest", table.fulfillmentEnvelopeDigest),
    boundedBytes("domain_key_requests_request_bytes", table.requestBytes, DOMAIN_KEY_AUTHORITY_BYTE_LIMITS.delivery),
    check("domain_key_requests_state", sql`${table.state} in ('pending', 'fulfilled', 'stale', 'expired', 'unrecoverable')`),
    portableId("domain_key_requests_failure_portable", table.failureCode),
    unique("uq_domain_key_requests_idempotency").on(table.idempotencyKey),
    unique("uq_domain_key_requests_digest").on(table.requestDigest),
    uniqueIndex("uq_domain_key_requests_live_target").on(table.domainId, table.keyClass, table.domainKeyGeneration, table.authorizationRevision, table.recipientKind, table.recipientKeyId, table.recipientKeyGeneration).where(sql`${table.state} = 'pending'`),
    index("idx_domain_key_requests_pending").on(table.state, table.deadlineAt),
    index("idx_domain_key_requests_human").on(table.recipientHumanId, table.state),
    ...mutablePolicies("domain_key_requests"),
  ],
).enableRLS();

export const domainKeyRecipientEnvelopes = pgTable(
  "domain_key_recipient_envelopes",
  {
    domainId: text("domain_id").notNull(),
    keyClass: text("key_class").notNull(),
    domainKeyGeneration: bigint("domain_key_generation", { mode: "number" }).notNull(),
    authorizationRevision: bigint("authorization_revision", { mode: "number" }).notNull(),
    headDigest: bytea("head_digest").notNull(),
    recipientHumanId: text("recipient_human_id").notNull(),
    recipientKind: text("recipient_kind").notNull(),
    recipientKeyId: text("recipient_key_id").notNull(),
    recipientKeyGeneration: bigint("recipient_key_generation", { mode: "number" }).notNull(),
    recipientPublicKeyDigest: bytea("recipient_public_key_digest").notNull(),
    envelopeDigest: bytea("envelope_digest").notNull(),
    envelopeBytes: bytea("envelope_bytes").notNull(),
    authorizationDigest: bytea("authorization_digest").notNull(),
    authorizationBytes: bytea("authorization_bytes").notNull(),
    sourceRequestId: text("source_request_id"),
    issuerHumanId: text("issuer_human_id").notNull(),
    issuerDeviceId: text("issuer_device_id").notNull(),
    issuerDeviceSigningGeneration: bigint("issuer_device_signing_generation", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.domainId, table.keyClass, table.domainKeyGeneration, table.authorizationRevision, table.recipientKind, table.recipientKeyId, table.recipientKeyGeneration] }),
    keyClass("domain_key_envelopes_class", table.keyClass),
    check("domain_key_envelopes_kind", sql`${table.recipientKind} in ('device', 'recovery')`),
    exactBytes("domain_key_envelopes_head_digest", table.headDigest),
    exactBytes("domain_key_envelopes_recipient_digest", table.recipientPublicKeyDigest),
    exactBytes("domain_key_envelopes_digest", table.envelopeDigest),
    exactBytes("domain_key_envelopes_authorization_digest", table.authorizationDigest),
    boundedBytes("domain_key_envelopes_bytes", table.envelopeBytes, DOMAIN_KEY_AUTHORITY_BYTE_LIMITS.envelope),
    boundedBytes("domain_key_envelopes_authorization_bytes", table.authorizationBytes, DOMAIN_KEY_AUTHORITY_BYTE_LIMITS.authorization),
    unique("uq_domain_key_envelopes_digest").on(table.envelopeDigest),
    index("idx_domain_key_envelopes_device_fetch").on(table.recipientKeyId, table.domainId, table.keyClass),
    index("idx_domain_key_envelopes_human_fetch").on(table.recipientHumanId, table.domainId, table.keyClass),
    ...appendOnlyPolicies("domain_key_envelopes"),
  ],
).enableRLS();

export const domainKeyEnvelopeAcknowledgements = pgTable(
  "domain_key_envelope_acknowledgements",
  {
    acknowledgementId: text("acknowledgement_id").primaryKey(),
    domainId: text("domain_id").notNull(),
    keyClass: text("key_class").notNull(),
    domainKeyGeneration: bigint("domain_key_generation", { mode: "number" }).notNull(),
    authorizationRevision: bigint("authorization_revision", { mode: "number" }).notNull(),
    recipientKind: text("recipient_kind").notNull(),
    recipientKeyId: text("recipient_key_id").notNull(),
    recipientKeyGeneration: bigint("recipient_key_generation", { mode: "number" }).notNull(),
    recipientDeviceId: text("recipient_device_id").notNull(),
    recipientDeviceRevision: bigint("recipient_device_revision", { mode: "number" }).notNull(),
    requestDigest: bytea("request_digest"),
    envelopeDigest: bytea("envelope_digest").notNull(),
    acknowledgementDigest: bytea("acknowledgement_digest").notNull(),
    acknowledgementBytes: bytea("acknowledgement_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    keyClass("domain_key_acks_class", table.keyClass),
    exactBytes("domain_key_acks_request_digest", table.requestDigest),
    exactBytes("domain_key_acks_envelope_digest", table.envelopeDigest),
    exactBytes("domain_key_acks_digest", table.acknowledgementDigest),
    boundedBytes("domain_key_acks_bytes", table.acknowledgementBytes, DOMAIN_KEY_AUTHORITY_BYTE_LIMITS.delivery),
    unique("uq_domain_key_acks_digest").on(table.acknowledgementDigest),
    unique("uq_domain_key_acks_envelope_device_revision").on(table.envelopeDigest, table.recipientDeviceId, table.recipientDeviceRevision),
    index("idx_domain_key_acks_device").on(table.recipientDeviceId, table.createdAt),
    ...appendOnlyPolicies("domain_key_acks"),
  ],
).enableRLS();

export const namespaceDomainKeyBindings = pgTable(
  "namespace_domain_key_bindings",
  {
    operationId: text("operation_id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    namespaceId: uuid("namespace_id").notNull(),
    domainId: text("domain_id").notNull(),
    keyClass: text("key_class").notNull(),
    domainKeyGeneration: bigint("domain_key_generation", { mode: "number" }).notNull(),
    domainAuthorizationRevision: bigint("domain_authorization_revision", { mode: "number" }).notNull(),
    domainHeadDigest: bytea("domain_head_digest").notNull(),
    namespaceAccessRevision: bigint("namespace_access_revision", { mode: "number" }).notNull(),
    namespaceCurrentGeneration: bigint("namespace_current_generation", { mode: "number" }).notNull(),
    bundleRevision: bigint("bundle_revision", { mode: "number" }).notNull(),
    retainedGenerationCount: integer("retained_generation_count").notNull(),
    retainedAuthoritySetDigest: bytea("retained_authority_set_digest").notNull(),
    previousBindingDigest: bytea("previous_binding_digest"),
    bindingDigest: bytea("binding_digest").notNull(),
    plaintextDigest: bytea("plaintext_digest").notNull(),
    ciphertextDigest: bytea("ciphertext_digest").notNull(),
    bindingBytes: bytea("binding_bytes").notNull(),
    issuerHumanId: text("issuer_human_id").notNull(),
    issuerDeviceId: text("issuer_device_id").notNull(),
    issuerDeviceSigningGeneration: bigint("issuer_device_signing_generation", { mode: "number" }).notNull(),
    state: text("state").notNull(),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    keyClass("namespace_domain_key_bindings_class", table.keyClass),
    exactBytes("namespace_domain_key_bindings_head_digest", table.domainHeadDigest),
    exactBytes("namespace_domain_key_bindings_retained_digest", table.retainedAuthoritySetDigest),
    exactBytes("namespace_domain_key_bindings_previous_digest", table.previousBindingDigest),
    exactBytes("namespace_domain_key_bindings_digest", table.bindingDigest),
    exactBytes("namespace_domain_key_bindings_plaintext_digest", table.plaintextDigest),
    exactBytes("namespace_domain_key_bindings_ciphertext_digest", table.ciphertextDigest),
    boundedBytes("namespace_domain_key_bindings_bytes", table.bindingBytes, DOMAIN_KEY_AUTHORITY_BYTE_LIMITS.namespaceBundle),
    check("namespace_domain_key_bindings_state", sql`${table.state} in ('reserved', 'active', 'stale', 'expired', 'failed')`),
    unique("uq_namespace_domain_key_bindings_idempotency").on(table.idempotencyKey),
    unique("uq_namespace_domain_key_bindings_digest").on(table.bindingDigest),
    uniqueIndex("uq_namespace_domain_key_bindings_live").on(table.namespaceId, table.keyClass).where(sql`${table.state} = 'reserved'`),
    index("idx_namespace_domain_key_bindings_domain").on(table.domainId, table.keyClass, table.namespaceId),
    ...mutablePolicies("namespace_domain_key_bindings"),
  ],
).enableRLS();

export const namespaceDomainKeyHeads = pgTable(
  "namespace_domain_key_heads",
  {
    namespaceId: uuid("namespace_id").notNull(),
    keyClass: text("key_class").notNull(),
    domainId: text("domain_id").notNull(),
    domainKeyGeneration: bigint("domain_key_generation", { mode: "number" }).notNull(),
    domainAuthorizationRevision: bigint("domain_authorization_revision", { mode: "number" }).notNull(),
    domainHeadDigest: bytea("domain_head_digest").notNull(),
    namespaceAccessRevision: bigint("namespace_access_revision", { mode: "number" }).notNull(),
    namespaceCurrentGeneration: bigint("namespace_current_generation", { mode: "number" }).notNull(),
    bundleRevision: bigint("bundle_revision", { mode: "number" }).notNull(),
    retainedGenerationCount: integer("retained_generation_count").notNull(),
    retainedAuthoritySetDigest: bytea("retained_authority_set_digest").notNull(),
    bindingDigest: bytea("binding_digest").notNull(),
    bindingOperationId: text("binding_operation_id").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespaceId, table.keyClass] }),
    keyClass("namespace_domain_key_heads_class", table.keyClass),
    exactBytes("namespace_domain_key_heads_domain_digest", table.domainHeadDigest),
    exactBytes("namespace_domain_key_heads_retained_digest", table.retainedAuthoritySetDigest),
    exactBytes("namespace_domain_key_heads_binding_digest", table.bindingDigest),
    unique("uq_namespace_domain_key_heads_binding").on(table.bindingDigest),
    index("idx_namespace_domain_key_heads_domain").on(table.domainId, table.keyClass, table.namespaceId),
    ...mutablePolicies("namespace_domain_key_heads"),
  ],
).enableRLS();
