import type { EncryptionCoverageEntry } from "../src/model";

const MESSAGE_REPAIR_COLUMNS = [
  "repair_attestation_digest",
  "repair_identity_digest",
  "repair_publisher_id",
  "repair_publisher_kind",
] as const;

const MESSAGE_REPAIR_EVIDENCE = [
  "packages/db/tests/unit/migration-0233-m311-message-repair-provenance.test.ts",
  "packages/lattice-bridge/tests/integration/postgres-conversation-product-store.integration.test.ts",
] as const;

export const REVIEWED_M311_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = MESSAGE_REPAIR_COLUMNS.map((column) => ({
    id: `db.m311.session-message-repair.${column.replaceAll("_", "-")}`,
    surface: "db" as const,
    locator: `public.session_message_crypto_revisions.${column}`,
    owner: "packages/lattice-bridge",
    readers: [
      "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts",
    ],
    writers: [
      "packages/lattice-bridge/src/server/message/postgres-conversation-product-store.ts",
    ],
    migrationState: "not_applicable" as const,
    retention:
      "Retained with the owning Message crypto-revision receipt so a verified foreground repair is attributable and replay-safe.",
    testEvidence: MESSAGE_REPAIR_EVIDENCE,
    classification: "bounded_metadata" as const,
    metadataAllowlist: [column],
    plaintextReason:
      "The field is a closed publisher kind, opaque stable publisher identifier, or SHA-256 digest over canonical repair identity or attestation bytes. It contains no Message content, decrypted product bytes, key material, grant payload, or free-form error.",
  }));
