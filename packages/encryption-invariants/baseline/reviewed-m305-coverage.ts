import type { EncryptionCoverageEntry } from "../src/model";

const SOURCE_BACKLOG_ROUTE =
  "http:request_response:POST /api/live-shadow/domain-key/source/pending";
const HUMAN_PEER_RECONCILER =
  "packages/lattice-bridge/src/server/message/postgres-human-peer-live-shadow-plan.ts#reconcileExpired:update:public.conversation_human_peer_shadow_operations:1";

export const REVIEWED_M305_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  {
    id: "wire.m305.domain-key-source-backlog",
    surface: "wire",
    locator: SOURCE_BACKLOG_ROUTE,
    owner: "packages/server",
    readers: [
      "packages/lattice-bridge/src/client/message/domain-key-authority-client.ts",
    ],
    writers: ["packages/server/src/routes/domain-key-authority.ts"],
    migrationState: "not_applicable",
    retention: "Authenticated request and bounded response only; not retained.",
    testEvidence: [
      "packages/lattice-bridge/tests/unit/domain-key-authority-client.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "requestVersion",
      "responseVersion",
      "serverId",
      "clientDeviceId",
      "limit",
      "work",
      "sourceRoomId",
      "namespaceId",
      "keyClass",
      "error",
    ],
    plaintextReason:
      "The authenticated response contains only bounded Room and Namespace identifiers plus a key-class enum. It carries no message content, Domain or Namespace key bytes, recovery material, or envelope ciphertext.",
  },
  {
    id: "db.m305.human-peer-expiry-reconciliation",
    surface: "db",
    locator: HUMAN_PEER_RECONCILER,
    owner: "packages/lattice-bridge",
    readers: [
      "packages/lattice-bridge/src/server/message/postgres-human-peer-live-shadow-plan.ts",
    ],
    writers: [
      "packages/lattice-bridge/src/server/message/postgres-human-peer-live-shadow-plan.ts",
    ],
    migrationState: "not_applicable",
    retention:
      "Updates an existing bounded durable lifecycle row when its deadline expires.",
    testEvidence: [
      "packages/lattice-bridge/tests/unit/human-peer-live-shadow-message.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "state",
      "terminal_stage",
      "terminal_reason",
      "terminal_at",
      "reconciliation_attempt_count",
      "updated_at",
    ],
    plaintextReason:
      "The update writes only lifecycle enums, a bounded retry counter, and timestamps. It never reads or writes Human-authored content, keys, envelopes, or protected payload bytes.",
  },
];

export const REVIEWED_M305_DATABASE_WRITER_LOCATOR = HUMAN_PEER_RECONCILER;
