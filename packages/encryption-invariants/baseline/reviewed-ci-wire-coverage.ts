import type {
  AuthorizedPlaintextCoverageEntry,
  EncryptionCoverageEntry,
} from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const REVIEW =
  "packages/encryption-invariants/tests/integration/reviewed-ci-wire-coverage.test.ts";
const MAGENT_ROUTE = "packages/server/src/messaging/magent-unix.ts";
const MAGENT_SERVICE = "packages/server/src/messaging/magent-operator.ts";
const MAGENT_TEST = "packages/server/tests/unit/magent-unix.test.ts";
const MESSAGE_DTO_TEST =
  "packages/encryption-invariants/tests/integration/reviewed-message-model-input-exposure-dto.test.ts";

const MAGENT_AUTHORIZED_PLAINTEXT_LOCATORS = [
  "http:request_response:GET /v1/avatar",
  "http:request_response:POST /v1/publications/:id/claim",
  "http:request_response:POST /v1/turns",
] as const;

const MAGENT_OPERATOR_SECRET_LOCATORS = [
  "http:request_response:POST /v1/publications/:id/authorize",
  "http:request_response:POST /v1/publications/:id/settle",
] as const;

const MAGENT_METADATA_ROUTES = [
  {
    locator: "http:request_response:DELETE /v1/turns/:id",
    metadataAllowlist: ["id", "receiptId", "state", "outboxId", "publicationState", "error"],
  },
  {
    locator: "http:request_response:GET /v1/status",
    metadataAllowlist: ["status", "operatorBindingId", "providerAgentId", "chatId", "senderId", "error"],
  },
  {
    locator: "http:request_response:GET /v1/turns/:id",
    metadataAllowlist: ["id", "receiptId", "state", "outboxId", "publicationState", "error"],
  },
  {
    locator: "http:request_response:POST /v1/binding/pause",
    metadataAllowlist: ["state", "error"],
  },
  {
    locator: "http:request_response:POST /v1/binding/revoke",
    metadataAllowlist: ["state", "error"],
  },
] as const;

const MODEL_INPUT_EXPOSURE_LOCATORS = [
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessageDto#modelInputExposure",
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessagesAroundPage#messages[].modelInputExposure",
] as const;

const magentAuthority =
  "The server creates this listener only on its operator-owned Unix socket. Every request must present the exact binding capability before route dispatch; the service fixes the sponsor, Genie, Room, chat and sender outside the request. Current binding, invocation, causal-publication and plaintext-only mode checks remain authoritative. This entry grants no protected-mode disclosure.";
const magentCleanup =
  "The private HTTP adapter disables logging, discards caught exception details and creates no body archive. Request and response buffers are transient to the exact operation. Canonical operator-control rows and legacy audit storage are classified separately; process-memory zeroization and remote erasure are not claimed.";

export const REVIEWED_CI_WIRE_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...MAGENT_AUTHORIZED_PLAINTEXT_LOCATORS.map((locator, index): AuthorizedPlaintextCoverageEntry => ({
    id: `ci.wire.magent-authorized-plaintext.${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: [MAGENT_ROUTE, MAGENT_SERVICE],
    writers: [MAGENT_ROUTE],
    migrationState: "not_applicable",
    retention: "Transient request or response lifetime on the exact private operator socket. Any canonical control text retained after admission is covered by its database classification rather than this wire entry.",
    testEvidence: [REVIEW, MAGENT_TEST],
    classification: "authorized_plaintext",
    mode: "plaintext_only",
    transientOnly: true,
    modeGate: "mAgent service creation rejects every mode other than plaintext_only; canonical intake and publication repeat current authority and plaintext-mode admission before accepting or releasing content.",
    recipientAuthority: magentAuthority,
    cleanupContract: magentCleanup,
    noRetentionTestEvidence: [REVIEW, MAGENT_TEST],
    releaseImpact: "blocks_whole_product_claim",
  })),
  ...MAGENT_OPERATOR_SECRET_LOCATORS.map((locator, index): EncryptionCoverageEntry => ({
    id: `ci.wire.magent-publication-authority.${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: [MAGENT_ROUTE, MAGENT_SERVICE],
    writers: [MAGENT_ROUTE],
    migrationState: "not_applicable",
    retention: "The claim capability exists only in the authenticated private request and is discarded after the exact authorization or settlement operation.",
    testEvidence: [REVIEW, MAGENT_TEST],
    classification: "operator_secret",
    secretStoreLocation: "Transient request memory on the mode-0600 operator-owned Unix socket. Durable outbox custody stores only the separately classified claim token needed to fence one publication.",
    backupProcedure: "No wire-request backup exists. Database backup and restore of the independently classified outbox authority does not create another HTTP request copy.",
    excludedFromAgentGrants: true,
  })),
  ...MAGENT_METADATA_ROUTES.map(({ locator, metadataAllowlist }, index): EncryptionCoverageEntry => ({
    id: `ci.wire.magent-metadata.${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: [MAGENT_ROUTE, MAGENT_SERVICE],
    writers: [MAGENT_ROUTE],
    migrationState: "not_applicable",
    retention: "Authenticated private-request lifetime; durable receipt and binding state remain separately classified in the database.",
    testEvidence: [REVIEW, MAGENT_TEST],
    classification: "bounded_metadata",
    metadataAllowlist,
    plaintextReason: "The exact route carries only opaque binding, sender or receipt coordinates and closed lifecycle states. It carries no control text, avatar bytes, publication body, provider credential, secret key or protected payload.",
  })),
  ...MODEL_INPUT_EXPOSURE_LOCATORS.map((locator, index): EncryptionCoverageEntry => ({
    id: `ci.wire.model-input-exposure.${index + 1}`,
    surface: "wire",
    locator,
    owner: locator.includes("packages/types/") ? "packages/types" : "packages/server",
    readers: ["packages/server/src/routes/sessions.ts"],
    writers: ["packages/agent/src/memory/model-input-exposure.ts"],
    migrationState: "shadow",
    retention: "The ordinary Message sibling retains only the exact versioned exposure lineage needed to explain model-input authority; protected-only responses omit ordinary parity metadata.",
    testEvidence: [REVIEW, MESSAGE_DTO_TEST, "packages/reflection/tests/unit/model-input-exposure-metadata-v1.test.ts"],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "version", "status", "dependencies", "kind", "recordId",
      "observedProcessingGeneration", "terminalAuthorityLeafHandles",
      "sourceKind", "logicalObjectRef", "observedRevision",
      "observedContentFingerprint", "terminalAuthorityLeafHandle",
    ],
    plaintextReason: "The shared exact-key parser accepts only a byte-bounded versioned lineage union of opaque record/source references, revisions, fingerprints and authority handles. It excludes Memory statements, Message bodies, prompts, credentials, keys, envelopes and ciphertext payloads.",
  })),
  {
    id: "ci.wire.memory-processor-recipient-v2",
    surface: "wire",
    locator: "http:request_response:GET /api/memory/processor-recipient/v2",
    owner: "packages/server",
    readers: ["packages/lattice-bridge/src/client/memory/vault-human-memory-device-content.ts"],
    writers: ["packages/server/src/routes/memory.ts"],
    migrationState: "not_applicable",
    retention: "Authenticated no-store response lifetime.",
    testEvidence: [REVIEW, "packages/server/tests/unit-isolated/memory-routes.test.ts"],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "formatVersion", "recipientId", "publicKeyBase64url", "purpose", "error",
      "embedding.dimensions", "embedding.model", "embedding.provider",
      "embedding.contractVersion", "embedding.canonicalSpace.dimensions",
      "embedding.canonicalSpace.model", "embedding.canonicalSpace.provider",
      "embedding.processingRoute.transport",
      "embedding.processingRoute.dataRecipientClasses[]",
      "embedding.processingRoute.marketplacePolicyVersion",
    ],
    plaintextReason: "The v2 response carries only public processor-recipient key coordinates and the closed embedding-space/processing-route disclosure. It contains no Memory body, embedding vector, provider credential or private key.",
  },
  {
    id: "ci.wire.bolter-state-changed",
    surface: "wire",
    locator: "ws:server_to_client:bolter.state.changed",
    owner: "packages/realtime-client",
    readers: ["packages/realtime-client"],
    writers: ["packages/server/src/realtime/ws-publisher.ts"],
    migrationState: "not_applicable",
    retention: "Ephemeral authenticated WebSocket hint lifetime.",
    testEvidence: [REVIEW, "packages/realtime-client/tests/unit/server-event-shape.test.ts"],
    classification: "bounded_metadata",
    metadataAllowlist: ["type"],
    plaintextReason: "The owner-private frame contains only the fixed event type and no Human, Room, connection, binding, Message, credential or content identifier. The client must refetch authoritative state.",
  },
] as const;

export const REVIEWED_CI_WIRE_DEBT_LINKS: readonly ReviewedDebtLink[] = [{
  id: "ci.wire.message-attachment-purpose",
  surface: "wire",
  locator: "http:request_response:POST /api/message-attachments#request.query.purpose",
  owner: "packages/server",
  targetDebtIds: [
    "debt.wire.http.request.response.post.api.message.attachments.1gvp9l8",
  ],
  reason: "The optional purpose discriminator is part of the exact already-frozen attachment-upload request. Only the literal bolter value changes document validation; all other values follow the existing upload boundary. This link adds no new content class or debt row.",
  testEvidence: [REVIEW, "packages/server/tests/integration/message-attachments-route.test.ts"],
}, ...[
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessageDto",
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessagesAroundPage",
].map((locator, index): ReviewedDebtLink => ({
  id: `ci.wire.room-message-dto.${index + 1}`,
  surface: "wire",
  locator,
  owner: "packages/types",
  targetDebtIds: [
    "debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n",
  ],
  reason: "The named DTO root includes the same ordinary Room-message content already frozen at the authenticated transcript reader. Only its exact model-input-exposure leaf is separately classified as bounded lineage metadata; this link does not relabel the Message body as metadata.",
  testEvidence: [REVIEW, MESSAGE_DTO_TEST],
}))] as const;
