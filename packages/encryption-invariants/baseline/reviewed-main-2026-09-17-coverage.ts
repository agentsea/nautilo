import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const REVIEW_TEST = "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-17-coverage.test.ts";
const PREFERENCE_TESTS = [
  REVIEW_TEST,
  "packages/types/tests/unit/event-feed.test.ts",
  "packages/db/tests/unit/event-feed-preferences.test.ts",
  "packages/server/tests/unit-isolated/event-feed-preferences-routes.test.ts",
];

/** New observations since the September 12 review, not a new debt baseline. */
export const REVIEWED_MAIN_2026_09_17_COVERAGE: readonly EncryptionCoverageEntry[] = [
  {
    id: "wire.main-2026-09-17.media-picker-request",
    surface: "wire",
    locator: "app_bridge:app_to_host:nautilo.app.media.req#pick",
    owner: "apps/workbench",
    readers: ["apps/workbench/src/apps/app-bridge.ts"],
    writers: ["apps/workbench/src/apps/app-bridge.ts"],
    migrationState: "not_applicable",
    retention: "One app-to-host picker invocation; no selected media data is present in this request.",
    testEvidence: [REVIEW_TEST, "apps/workbench/src/apps/mini-app-surface.test.tsx"],
    classification: "bounded_metadata",
    metadataAllowlist: ["type", "op", "requestId", "purpose", "multiple"],
    plaintextReason: "The exact picker request contains only protocol and correlation coordinates, the media/references purpose enum and a multiple-selection boolean. The returned labels, paths, and media references remain separately linked to Artifact transport debt.",
  },
  ...["event_feed_quiet_mode", "event_feed_quiet_until"].map((field): EncryptionCoverageEntry => ({
    id: `db.main-2026-09-17.${field}`,
    surface: "db",
    locator: `public.user_notification_settings.${field}`,
    owner: "packages/db",
    readers: ["packages/db/src/queries/event-feed-preferences.ts"],
    writers: ["packages/db/src/queries/event-feed-preferences.ts"],
    migrationState: "not_applicable",
    retention: "Retained as the Human's notification preference until changed or the owning settings row is deleted.",
    testEvidence: PREFERENCE_TESTS,
    classification: "bounded_metadata",
    metadataAllowlist: [field],
    plaintextReason: "Migration 0293 and the strict preference schema constrain this pair to active/quiet with no deadline, or snoozed with a timestamp. These are personal attention controls, not event content, read state, credentials, or cryptographic material.",
  })),
  ...[
    "http:request_response:GET /api/event-feed/preference",
    "http:request_response:PUT /api/event-feed/preference",
    "http:request_response:PUT /api/event-feed/preference#request.body",
  ].map((locator, index): EncryptionCoverageEntry => ({
    id: `wire.main-2026-09-17.event-preference-${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: ["packages/server/src/routes/event-feed-preferences.ts", "apps/workbench/src"],
    writers: ["packages/server/src/routes/event-feed-preferences.ts", "apps/workbench/src"],
    migrationState: "not_applicable",
    retention: "Authenticated preference request/response lifetime; persistence is reviewed separately.",
    testEvidence: PREFERENCE_TESTS,
    classification: "bounded_metadata",
    metadataAllowlist: ["mode", "until", "error", "code"],
    plaintextReason: "The route consumes only the strict active/quiet/snoozed union and optional ISO timestamp, rejects extra fields and expired snoozes, and returns fixed error text. No event payload or Human-authored text is admitted.",
  })),
  ...["prepare", "revoke"].map((operation): EncryptionCoverageEntry => ({
    id: `wire.main-2026-09-17.live-session-${operation}-client-id`,
    surface: "wire",
    locator: `http:request_response:POST /api/apps/:appId/live-session/${operation}#request.body.clientSessionId`,
    owner: "packages/server",
    readers: ["packages/server/src/apps/app-routes.ts"],
    writers: ["apps/workbench/src"],
    migrationState: "not_applicable",
    retention: "One authenticated request; the registry uses this UUID only within the exact User/App namespace and expires its associated session state.",
    testEvidence: [REVIEW_TEST, "packages/server/tests/unit/app-routes.test.ts", "packages/server/tests/unit/live-mini-app-session-registry.test.ts"],
    classification: "bounded_metadata",
    metadataAllowlist: ["clientSessionId"],
    plaintextReason: "This exact leaf is validated as a UUID v4 and is a client cancellation coordinate, not a bearer token. The separate issuance/session tokens remain on explicit transport debt; knowing the UUID cannot issue a session without the one-use token and matching User/App binding.",
  })),
];

export const REVIEWED_MAIN_2026_09_17_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  ...[
    "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#VideoMediaPickResult",
    "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#VideoMediaPickResult#imports[]",
  ].map((locator, index): ReviewedDebtLink => ({
    id: `debt-link.main-2026-09-17.media-picker-${index + 1}`,
    surface: "wire",
    locator,
    owner: "apps/workbench",
    targetDebtIds: ["debt.wire.http.request.response.get.api.workspace.artifacts.id.lv68nb"],
    reason: "The picker result carries the same plaintext Artifact/media references, Human-authored labels and paths as the existing import boundary. The new aggregate and unresolved Extract leaf do not establish encryption or turn presentation strings into metadata.",
    testEvidence: [REVIEW_TEST, "apps/workbench/src/apps/mini-app-surface.test.tsx"],
  })),
  {
    id: "debt-link.main-2026-09-17.live-session-prepare",
    surface: "wire",
    locator: "http:request_response:POST /api/apps/:appId/live-session/prepare",
    owner: "packages/server",
    targetDebtIds: ["debt.wire.http.request.response.post.api.apps.appid.live.session.172tdwt"],
    reason: "The preparation response sends a one-use issuance credential over the existing authenticated live-session transport. It is scoped to User/App/client UUID and expires, but remains a plaintext secret-bearing wire contract like session issuance; it is not content-free metadata or Namespace ciphertext.",
    testEvidence: [REVIEW_TEST, "packages/server/tests/unit/app-routes.test.ts", "packages/server/tests/unit/live-mini-app-session-registry.test.ts"],
  },
];
