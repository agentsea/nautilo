import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const WIRE_SECURITY_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-12-wire-security.test.ts";
const RECOVERY_ROUTE_EVIDENCE =
  "packages/server/tests/unit-isolated/ordinary-content-access-recovery-routes.test.ts";
const DRAFT_RECOVERY_EVIDENCE =
  "apps/desktop/tests/unit/mini-app-draft-recovery.test.ts";
const DRAFT_RECOVERY_SECURITY_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-draft-recovery-security.test.ts";
const TEMPLATE_EVIDENCE =
  "packages/server/tests/unit/slide-templates-route.test.ts";
const CONTENT_ACCESS_EVIDENCE =
  "packages/server/tests/unit-isolated/content-access-routes.test.ts";
const EVENT_FEED_EVIDENCE =
  "packages/server/tests/unit-isolated/event-feed-routes.test.ts";
const BACKGROUND_ROUTE_EVIDENCE =
  "packages/server/tests/unit/background-authorization-route.test.ts";

const WIRE_RETENTION =
  "Authenticated request, response, or notification lifetime; this review claims no durable wire copy.";

type BoundedSpec = Readonly<{
  id: string;
  locator: string;
  metadataAllowlist: readonly string[];
  plaintextReason: string;
  testEvidence: readonly string[];
}>;

function bounded(spec: BoundedSpec): EncryptionCoverageEntry {
  return {
    id: `wire.main-2026-09-12.${spec.id}`,
    surface: "wire",
    locator: spec.locator,
    owner: spec.locator.startsWith("ws:") ? "packages/types" : "packages/server",
    readers: [spec.locator.startsWith("ws:") ? "apps/workbench/src" : "apps/workbench/src"],
    writers: [spec.locator.startsWith("ws:")
      ? "packages/server/src/realtime"
      : "packages/server/src/routes"],
    migrationState: "not_applicable",
    retention: WIRE_RETENTION,
    testEvidence: spec.testEvidence,
    classification: "bounded_metadata",
    metadataAllowlist: spec.metadataAllowlist,
    plaintextReason: spec.plaintextReason,
  };
}

const RECOVERY_COORDINATE_REASON =
  "The closed contract carries only authenticated recovery coordinates, opaque cursors, fixed outcomes, capability codes, and bounded failure state; it carries no recovered content, transcript, prompt, result, credential, or key.";
const BODYLESS_GET_REASON =
  "Fastify treats GET as bodyless and leaves request.body undefined before the shared handler; the executable route test sends a synthetic JSON payload and proves it is neither parsed nor consumed.";

const boundedSpecs: readonly BoundedSpec[] = [
  {
    id: "stenographer-protection-status",
    locator: "http:request_response:GET /api/admin/stenographer-status/protection",
    metadataAllowlist: [
      "dtoVersion", "generatedAt", "window.since", "window.until",
      "authorityWait.compactionRooms", "authorityWait.extractionRooms",
      "authorityWait.oldestAt", "plaintextFallback.last24h.compaction.authority",
      "plaintextFallback.last24h.compaction.device",
      "plaintextFallback.last24h.extraction.authority",
      "plaintextFallback.last24h.extraction.device",
      "plaintextFallback.missingProtection.compactionRollups",
      "plaintextFallback.missingProtection.extractionBatches",
      "plaintextFallback.missingProtection.oldestAt", "queue.current.awaitingRecipient",
      "queue.current.claimed", "queue.current.grantReady",
      "queue.current.oldestWaitingAt", "queue.current.publicationReconciliation",
      "queue.current.running", "queue.current.waitingForDevice",
      "queue.last24h.cancelled", "queue.last24h.outputRepairCompleted",
      "queue.last24h.protectedCompleted", "queue.last24h.terminalFailures", "error",
    ],
    plaintextReason:
      "The administrator projection is a closed set of counts, fixed queue states, and timestamps. It contains no journal batch, rollup, prompt, model output, credential, or key material.",
    testEvidence: [
      "packages/server/tests/unit/stenographer-status-route.test.ts",
      WIRE_SECURITY_EVIDENCE,
    ],
  },
  {
    id: "slide-template-cursor",
    locator: "http:request_response:GET /api/apps/nautilo-presentation/slide-templates#request.query.cursor",
    metadataAllowlist: ["cursor"],
    plaintextReason:
      "The signed opaque continuation contains only the caller and private-Namespace pagination coordinate; template names and content remain on explicit Artifact transport debt.",
    testEvidence: [TEMPLATE_EVIDENCE, WIRE_SECURITY_EVIDENCE],
  },
  ...[
    "http:request_response:POST /api/content-access/commit",
    "http:request_response:POST /api/content-access/commit#request.body",
    "http:request_response:POST /api/content-access/commit#request.query",
  ].map((locator, index): BoundedSpec => ({
    id: `content-access-commit-${index + 1}`,
    locator,
    metadataAllowlist: [
      "operationId", "object.kind", "object.id", "change.kind",
      "selectedActorIds", "targetRoomId", "actorId", "previewToken", "roomId",
      "outcome", "stateChanged", "originalStateChanged", "replayed",
      "attachedCount", "detachedCount", "skippedCount", "error",
    ],
    plaintextReason:
      "The strict commit request and receipt contain only object, Room, Actor and operation coordinates, a one-use opaque preview token, fixed outcomes, booleans, and counts. Human and Room presentation strings are excluded.",
    testEvidence: [CONTENT_ACCESS_EVIDENCE, WIRE_SECURITY_EVIDENCE],
  })),
  ...[
    "http:request_response:POST /api/content-access/prepare#request.body",
    "http:request_response:POST /api/content-access/prepare#request.query",
  ].map((locator, index): BoundedSpec => ({
    id: `content-access-prepare-input-${index + 1}`,
    locator,
    metadataAllowlist: [
      "operationId", "object.kind", "object.id", "change.kind",
      "selectedUserIds", "targetRoomId", "actorId", "roomId",
    ],
    plaintextReason:
      "The strict preparation input carries only object, User, Actor, Room, and operation coordinates plus a fixed change discriminator. The response preview's names and labels are reviewed separately as identity debt.",
    testEvidence: [CONTENT_ACCESS_EVIDENCE, WIRE_SECURITY_EVIDENCE],
  })),
  {
    id: "event-feed-list-query",
    locator: "http:request_response:GET /api/event-feed#request.query",
    metadataAllowlist: ["cursor", "unreadOnly", "types", "limit"],
    plaintextReason:
      "The strict query parser accepts only an opaque cursor, one boolean, the closed event-kind enum, and a bounded page size.",
    testEvidence: [EVENT_FEED_EVIDENCE, WIRE_SECURITY_EVIDENCE],
  },
  {
    id: "event-feed-actor-id",
    locator: "http:request_response:GET /api/event-feed#response.body.events[].actorId",
    metadataAllowlist: ["actorId"],
    plaintextReason:
      "The field is a canonical opaque Actor UUID or null; the separately transported actor display name remains on identity plaintext debt.",
    testEvidence: [EVENT_FEED_EVIDENCE, "packages/types/tests/unit/event-feed.test.ts"],
  },
  {
    id: "event-feed-actor-kind",
    locator: "http:request_response:GET /api/event-feed#response.body.events[].actorKind",
    metadataAllowlist: ["actorKind"],
    plaintextReason:
      "The field is the closed human-or-agent discriminator or null; it contains no identity presentation string.",
    testEvidence: [EVENT_FEED_EVIDENCE, "packages/types/tests/unit/event-feed.test.ts"],
  },
  ...[
    "http:request_response:GET /api/event-feed/unread-count",
    "http:request_response:POST /api/event-feed/mark-all-read",
    "http:request_response:PUT /api/event-feed/:eventId/read",
    "http:request_response:PUT /api/event-feed/:eventId/read#request.body",
    "ws:server_to_client:event_feed.changed",
  ].map((locator, index): BoundedSpec => ({
    id: `event-feed-state-${index + 1}`,
    locator,
    metadataAllowlist: [
      "eventId", "read", "readAt", "changed", "unreadCount", "updatedCount",
      "type", "error", "code",
    ],
    plaintextReason:
      "The contract carries only an event UUID, read-state boolean or timestamp, bounded counters, a fixed error code, or a payload-free refresh hint; it excludes event data and actor display names.",
    testEvidence: [EVENT_FEED_EVIDENCE, WIRE_SECURITY_EVIDENCE],
  })),
  ...[
    "http:request_response:GET /api/rooms/:roomId/content-access-recovery",
    "http:request_response:GET /api/tasks/:id/content-access-recovery",
  ].map((locator, index): BoundedSpec => ({
    id: `content-access-recovery-get-${index + 1}`,
    locator,
    metadataAllowlist: index === 0
      ? [
        "roomId", "cursor", "originalJobId", "checkpointId", "turnId",
        "toolCallId", "agentId", "nextCursor", "outcome", "error",
        "restartDiscovery",
      ]
      : [
        "id", "taskId", "taskRunId", "checkpointId", "toolCallId",
        "outcome", "capability", "code", "error",
      ],
    plaintextReason: RECOVERY_COORDINATE_REASON,
    testEvidence: [RECOVERY_ROUTE_EVIDENCE, WIRE_SECURITY_EVIDENCE],
  })),
  ...[
    "http:request_response:GET /api/rooms/:roomId/content-access-recovery#request.body",
    "http:request_response:GET /api/tasks/:id/content-access-recovery#request.body",
  ].map((locator, index): BoundedSpec => ({
    id: `content-access-recovery-bodyless-get-${index + 1}`,
    locator,
    metadataAllowlist: ["request.body"],
    plaintextReason: BODYLESS_GET_REASON,
    testEvidence: [RECOVERY_ROUTE_EVIDENCE, WIRE_SECURITY_EVIDENCE],
  })),
  ...[
    "http:request_response:POST /api/rooms/:roomId/content-access-recovery",
    "http:request_response:POST /api/rooms/:roomId/content-access-recovery#request.body",
    "http:request_response:POST /api/tasks/:id/content-access-recovery",
    "http:request_response:POST /api/tasks/:id/content-access-recovery#request.body",
  ].map((locator, index): BoundedSpec => ({
    id: `content-access-recovery-post-${index + 1}`,
    locator,
    metadataAllowlist: index < 2
      ? ["roomId", "originalJobId", "checkpointId", "turnId", "toolCallId", "agentId", "outcome", "error"]
      : ["id", "taskId", "taskRunId", "checkpointId", "toolCallId", "outcome", "capability", "code", "error"],
    plaintextReason: RECOVERY_COORDINATE_REASON,
    testEvidence: [
      index < 2
        ? RECOVERY_ROUTE_EVIDENCE
        : "packages/server/tests/unit-isolated/task-content-access-recovery-routes.test.ts",
      WIRE_SECURITY_EVIDENCE,
    ],
  })),
  {
    id: "background-authorization-list",
    locator: "http:request_response:POST /api/background-authorization/requests/list",
    metadataAllowlist: [
      "requestVersion", "responseVersion", "continuation",
      "requests[].requestBytesBase64url", "status", "error",
    ],
    plaintextReason:
      "The canonical V2 processor descriptor contains bounded work, Namespace, Domain, revision and digest coordinates plus the recipient public key. It contains no Domain key, Namespace key, signing private key, prompt, or model output; the secret-bearing sealed response uses a separate protected route.",
    testEvidence: [
      BACKGROUND_ROUTE_EVIDENCE,
      "packages/lattice-crypto/tests/unit/background-work-descriptor-v2.test.ts",
      WIRE_SECURITY_EVIDENCE,
    ],
  },
  {
    id: "background-authorization-wake",
    locator: "ws:server_to_client:crypto.background_authorization_requested",
    metadataAllowlist: ["type"],
    plaintextReason:
      "The WebSocket frame is a payload-free authenticated wake hint; discovery and the sealed response occur through separately reviewed HTTP contracts.",
    testEvidence: [
      "packages/lattice-bridge/tests/unit/background-authorization-sweep-v2.test.ts",
      WIRE_SECURITY_EVIDENCE,
    ],
  },
];

const deviceLocalLocators = [
  "app_bridge:app_to_host:nautilo.app.recovery.req#read",
  "app_bridge:app_to_host:nautilo.app.recovery.req#read#input",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppRecoveryRequest",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppRecoveryRequest#input",
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions#recovery",
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest#input",
] as const;

const deviceLocalEntries: readonly EncryptionCoverageEntry[] =
  deviceLocalLocators.map((locator, index) => ({
    id: `wire.main-2026-09-12.device-local-draft-recovery-${index + 1}`,
    surface: "wire",
    locator,
    owner: "apps/workbench",
    readers: [
      "apps/workbench/src/apps/app-draft-recovery.ts",
      "apps/desktop/electron/mini-app-draft-recovery.ts",
    ],
    writers: [
      "apps/workbench/src/apps/app-draft-recovery.ts",
      "apps/desktop/electron/mini-app-draft-recovery.ts",
    ],
    migrationState: "not_applicable",
    retention:
      "The app-bridge request exists for one host call; any durable draft remains in the separately reviewed Desktop userData recovery file until tombstoned or that recovery directory is removed.",
    testEvidence: [
      DRAFT_RECOVERY_EVIDENCE,
      DRAFT_RECOVERY_SECURITY_EVIDENCE,
      WIRE_SECURITY_EVIDENCE,
    ],
    classification: "device_local",
    deviceStorage:
      "Electron host bridge to the Desktop userData mini-app-draft-recovery store, whose mode-0600 files contain Electron safeStorage ciphertext under OS-account custody.",
    cleanupContract:
      "A null draft writes an encrypted tombstone; deleting the owning Desktop userData recovery directory removes local records. No logout erasure, automatic expiry, synchronized backup, or Namespace encryption is claimed.",
  }));

const protectedEntries: readonly EncryptionCoverageEntry[] = [{
  id: "wire.main-2026-09-12.background-authorization-response",
  surface: "wire",
  locator: "http:request_response:POST /api/background-authorization/respond",
  owner: "packages/server",
  readers: [
    "packages/server/src/routes/background-authorization.ts",
    "packages/lattice-crypto/src/background/processor-authorization-v2.ts",
  ],
  writers: [
    "packages/lattice-bridge/src/client/background/device-authorization-responder-v2.ts",
  ],
  migrationState: "ciphertext_only",
  retention:
    "The authenticated response is request-scoped; decoded transport bytes and every copied Domain key and signer private key are wiped after exact decode, current-issuer verification, and use.",
  testEvidence: [
    BACKGROUND_ROUTE_EVIDENCE,
    "packages/lattice-bridge/tests/unit/background-authorization-transport.test.ts",
    "packages/lattice-crypto/tests/unit/processor-authorization-v2.test.ts",
    WIRE_SECURITY_EVIDENCE,
  ],
  classification: "protected",
  keyFamily: "namespace_ai",
  bridgeRepository:
    "packages/lattice-bridge/src/client/background/device-authorization-responder-v2.ts",
  negativeTestEvidence: [
    "packages/lattice-bridge/tests/unit/background-authorization-transport.test.ts",
    "packages/lattice-crypto/tests/unit/processor-authorization-v2.test.ts",
  ],
}];

/** Closed wire metadata, device-local draft transport, and sealed response material. */
export const REVIEWED_MAIN_2026_09_12_WIRE_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...boundedSpecs.map(bounded),
    ...deviceLocalEntries,
    ...protectedEntries,
  ];

function debtLink(
  id: string,
  locator: string,
  targetDebtIds: readonly string[],
  reason: string,
  testEvidence: readonly string[],
): ReviewedDebtLink {
  return {
    id: `debt-link.wire.main-2026-09-12.${id}`,
    surface: "wire",
    locator,
    owner: locator.startsWith("app_bridge:") ? "apps/workbench" : "packages/server",
    targetDebtIds,
    reason,
    testEvidence,
  };
}

const ARTIFACT_TRANSPORT_DEBT =
  "debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb";
const ROOM_IDENTITY_DEBT =
  "debt.wire.http.request.response.get.api.rooms.id.7993e";

const templateDebtLocators = [
  "app_bridge:app_to_host:nautilo.app.templates.req#list",
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions#templates",
  "http:request_response:DELETE /api/apps/nautilo-presentation/slide-templates/:templateId",
  "http:request_response:GET /api/apps/nautilo-presentation/slide-templates",
  "http:request_response:GET /api/apps/nautilo-presentation/slide-templates/:templateId",
  "http:request_response:POST /api/apps/nautilo-presentation/slide-templates",
] as const;

/** User-authored template bytes and identity presentation remain on exact frozen debt. */
export const REVIEWED_MAIN_2026_09_12_WIRE_DEBT_LINKS:
  readonly ReviewedDebtLink[] = [
    ...templateDebtLocators.map((locator, index) => debtLink(
      `slide-template-${index + 1}`,
      locator,
      [ARTIFACT_TRANSPORT_DEBT],
      "The boundary lists Human-authored template names or reads, writes, and deletes template Artifacts. Reusing the mini-app or route transport does not turn Artifact names or content into safe metadata.",
      [TEMPLATE_EVIDENCE, "apps/workbench/src/apps/app-slide-templates.test.ts"],
    )),
    debtLink(
      "content-access-summary",
      "http:request_response:GET /api/content-access",
      [ROOM_IDENTITY_DEBT],
      "The access summary carries current Human display names and handles plus Room labels from the same frozen authenticated Room identity boundary; object and access coordinates do not make those presentation strings metadata.",
      [CONTENT_ACCESS_EVIDENCE],
    ),
    debtLink(
      "content-access-prepare-preview",
      "http:request_response:POST /api/content-access/prepare",
      [ROOM_IDENTITY_DEBT],
      "The prepared preview carries current Human display names and handles and the target Room label from the same frozen authenticated Room identity boundary; only its strict request coordinates are classified as metadata.",
      [CONTENT_ACCESS_EVIDENCE],
    ),
    debtLink(
      "event-feed-current-actor-name",
      "http:request_response:GET /api/event-feed",
      [ROOM_IDENTITY_DEBT],
      "The feed hydrates the current authorized actor display name at read time. That identity presentation is the same frozen Human-name disclosure already returned by the authenticated Room detail boundary, even though persisted feed data contains only closed coordinates.",
      [EVENT_FEED_EVIDENCE, "packages/types/tests/unit/event-feed.test.ts"],
    ),
  ];
