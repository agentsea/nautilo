import type { EncryptionCoverageEntry } from "../src/model";

const PAGE_ROUTE =
  "http:request_response:POST /api/rooms/:roomId/pending-attention";
const READ_ROUTE = `${PAGE_ROUTE}/read`;
const ROUTE_TEST =
  "packages/server/tests/unit/foreground-pending-attention-route.test.ts";
const AUTHORITY_TEST =
  "packages/server/tests/unit/foreground-checkpoint-read-authority.test.ts";

const protectedPendingAttentionLocators = [
  PAGE_ROUTE,
  `${PAGE_ROUTE}#response.body.events[].tools[].args`,
  READ_ROUTE,
  `${READ_ROUTE}#response.body.events[].tools[].args`,
] as const;

/** M322 owner/actor-fenced checkpoint previews and their explicit authorization read. */
export const REVIEWED_M322_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] =
  protectedPendingAttentionLocators.map((locator, index) => ({
    id: `wire.m322.pending-attention.${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: [
      "packages/api-client/src/client.ts",
      "packages/lattice-bridge/src/client/message/authorized-human-live-shadow-message-client.ts",
    ],
    writers: ["packages/server/src/routes/foreground-pending-attention.ts"],
    migrationState: "shadow",
    retention: "Authenticated request lifetime only; responses are private, no-store checkpoint previews or expiring authorization coordinates.",
    testEvidence: [ROUTE_TEST, AUTHORITY_TEST],
    classification: "protected",
    keyFamily: "namespace_ai",
    bridgeRepository:
      "packages/lattice-bridge/src/server/message/postgres-domain-key-v2-live-shadow-authority.ts",
    negativeTestEvidence: [ROUTE_TEST, AUTHORITY_TEST],
  }));
