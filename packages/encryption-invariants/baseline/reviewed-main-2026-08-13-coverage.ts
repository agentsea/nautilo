import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const ROLLOUT_EVIDENCE =
  "packages/server/tests/integration/admin-users-rollout-plan.integration.test.ts";
const PROVISION_EVIDENCE =
  "packages/server/tests/integration/admin-users-provision.integration.test.ts";
const MOBILE_STATIC_EVIDENCE =
  "packages/server/tests/integration/mobile-web-static-serving.integration.test.ts";
const THEME_EVIDENCE = "apps/workbench/tests/unit/app-bridge-client.test.ts";
const PATCH_EVIDENCE = "packages/api-client/tests/unit/workspace-artifacts.test.ts";

const ROLLOUT_DB_METADATA = [
  "public.member_rollout_items.credential_disposition",
  "public.member_rollout_items.error_code",
  "public.member_rollout_items.id",
  "public.member_rollout_items.member_id",
  "public.member_rollout_items.receipt_id",
  "public.member_rollout_items.role_slug",
  "public.member_rollout_items.rollout_id",
  "public.member_rollout_items.sequence",
  "public.member_rollout_items.state",
  "public.member_rollout_items.target_group_id",
  "public.member_rollout_items.updated_at",
  "public.member_rollouts.created_at",
  "public.member_rollouts.created_by",
  "public.member_rollouts.fingerprint",
  "public.member_rollouts.id",
  "public.member_rollouts.idempotency_key",
  "public.member_rollouts.server_instance_id",
  "public.member_rollouts.status",
  "public.member_rollouts.updated_at",
] as const;

const WIRE_METADATA: ReadonlyArray<{
  readonly locator: string;
  readonly owner: string;
  readonly evidence: string;
  readonly allowlist: string;
}> = [
  {
    locator: "app_bridge:host_to_app:nautilo.app.presentation.theme",
    owner: "apps/workbench",
    evidence: THEME_EVIDENCE,
    allowlist: "presentationTheme",
  },
  ...[
    "http:request_response:GET /mobile",
    "http:request_response:GET /mobile/",
    "http:request_response:GET /mobile/*",
    "http:request_response:GET /mobile/favicon.ico",
  ].map((locator) => ({
    locator,
    owner: "packages/server",
    evidence: MOBILE_STATIC_EVIDENCE,
    allowlist: "staticAssetResponse",
  })),
  ...[
    "http:request_response:POST /api/admin/users/provision#response.body.code",
    "http:request_response:POST /api/admin/users/provision#response.body.retrySafe",
    "http:request_response:POST /api/admin/users/rollout/apply#request.body.fingerprint",
    "http:request_response:POST /api/admin/users/rollout/apply#response.body.code",
    "http:request_response:POST /api/admin/users/rollout/apply#response.body.index",
    "http:request_response:POST /api/admin/users/rollout/plan#response.body.code",
    "http:request_response:POST /api/admin/users/rollout/plan#response.body.index",
    "http:request_response:POST /api/admin/users/rollout/:rolloutId/acknowledge#request.body.sequences",
  ].map((locator) => ({
    locator,
    owner: "packages/server",
    evidence: locator.includes("provision") ? PROVISION_EVIDENCE : ROLLOUT_EVIDENCE,
    allowlist: locator.split("#").at(-1) ?? "rolloutControlMetadata",
  })),
];

function boundedDb(locator: string, index: number): EncryptionCoverageEntry {
  const field = locator.split(".").at(-1)!;
  return {
    id: `db.main-2026-08-13.rollout-metadata-${index + 1}`,
    surface: "db",
    locator,
    owner: "packages/db",
    readers: ["packages/server/src/lib/rollout-operation.ts"],
    writers: ["packages/server/src/lib/rollout-operation.ts"],
    migrationState: "not_applicable",
    retention:
      "Retained only for the bounded member-rollout lifecycle and removed with the rollout record after its operator recovery window.",
    testEvidence: [ROLLOUT_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [field],
    plaintextReason:
      "This exact field is an opaque identifier, fixed lifecycle enum, bounded sequence, digest, idempotency coordinate, or timestamp; Human identity fields are linked separately to frozen plaintext debt.",
  };
}

function boundedWire(
  input: (typeof WIRE_METADATA)[number],
  index: number,
): EncryptionCoverageEntry {
  return {
    id: `wire.main-2026-08-13.control-metadata-${index + 1}`,
    surface: "wire",
    locator: input.locator,
    owner: input.owner,
    readers: [input.owner],
    writers: [input.owner],
    migrationState: "not_applicable",
    retention:
      "This closed control or presentation value is carried only for the current authenticated request, app-bridge frame, or static asset response and is not a content store.",
    testEvidence: [input.evidence],
    classification: "bounded_metadata",
    metadataAllowlist: [input.allowlist],
    plaintextReason:
      "The allowlisted value is a fixed presentation enum, static asset response, validation code, boolean, bounded index or sequence list, or SHA-256 control digest and contains no message, artifact, credential, or profile content.",
  };
}

export const REVIEWED_MAIN_2026_08_13_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...ROLLOUT_DB_METADATA.map(boundedDb),
  ...WIRE_METADATA.map(boundedWire),
];

const DB_LINKS: ReadonlyArray<{
  readonly locator: string;
  readonly fields: readonly string[];
  readonly targets: readonly string[];
}> = [
  {
    locator: "public.member_rollout_items",
    fields: ["handle"],
    targets: ["debt.db.public.users.handle"],
  },
  {
    locator: "public.member_rollout_items.handle",
    fields: ["handle"],
    targets: ["debt.db.public.users.handle"],
  },
  {
    locator: "public.member_rollouts",
    fields: ["manifest"],
    targets: [
      "debt.db.public.users.handle",
      "debt.db.public.users.name",
      "debt.db.public.users.email",
    ],
  },
  {
    locator: "public.member_rollouts.manifest",
    fields: ["manifest"],
    targets: [
      "debt.db.public.users.handle",
      "debt.db.public.users.name",
      "debt.db.public.users.email",
    ],
  },
];

const ADMIN_DIRECTORY_DEBT =
  "debt.wire.http.request.response.get.api.admin.users.12jlf0u";
const PROFILE_COMPLETION_DEBT =
  "debt.wire.http.request.response.post.api.invites.token.complete.profile.10iu4nu";

const WIRE_LINKS: ReadonlyArray<{
  readonly locator: string;
  readonly targets: readonly string[];
  readonly evidence: string;
}> = [
  ...[
    "http:request_response:POST /api/admin/users/provision",
    "http:request_response:POST /api/admin/users/provision#request.body.displayName",
    "http:request_response:POST /api/admin/users/provision#request.body.email",
    "http:request_response:POST /api/admin/users/provision#request.body.handle",
    "http:request_response:POST /api/admin/users/provision#request.body.roleSlug",
  ].map((locator) => ({
    locator,
    targets: [PROFILE_COMPLETION_DEBT],
    evidence: PROVISION_EVIDENCE,
  })),
  ...[
    "http:request_response:GET /api/admin/users/rollout/:rolloutId",
    "http:request_response:POST /api/admin/users/rollout/:rolloutId/acknowledge",
    "http:request_response:POST /api/admin/users/rollout/plan",
    "http:request_response:POST /api/admin/users/rollout/plan#request.body",
  ].map((locator) => ({
    locator,
    targets: [ADMIN_DIRECTORY_DEBT],
    evidence: ROLLOUT_EVIDENCE,
  })),
  ...[
    "http:request_response:POST /api/admin/users/rollout/apply",
    "http:request_response:POST /api/admin/users/rollout/:rolloutId/resume",
  ].map((locator) => ({
    locator,
    targets: [ADMIN_DIRECTORY_DEBT, PROFILE_COMPLETION_DEBT],
    evidence: ROLLOUT_EVIDENCE,
  })),
  {
    locator: "http:request_response:POST /api/admin/users/rollout/apply#request.body.manifest",
    targets: [ADMIN_DIRECTORY_DEBT],
    evidence: ROLLOUT_EVIDENCE,
  },
  {
    locator: "sse:produced:GET /api/workspace/artifacts/events#document.patch.applied",
    targets: [
      "debt.wire.sse.accepted.get.api.workspace.artifacts.events.document.patch.applied.12gfv07",
    ],
    evidence: PATCH_EVIDENCE,
  },
];

export const REVIEWED_MAIN_2026_08_13_DEBT_LINKS:
  readonly ReviewedDebtLink[] = [
  ...DB_LINKS.map((link, index) => ({
    id: `link.db.main-2026-08-13.rollout-identity-${index + 1}`,
    surface: "db" as const,
    locator: link.locator,
    owner: "packages/db",
    targetDebtIds: link.targets,
    reason:
      "This rollout field is a duplicate projection of the same Human directory identity already represented by the exact frozen user fields; it introduces no new content class.",
    testEvidence: [ROLLOUT_EVIDENCE],
    crossBoundaryProjection: {
      fields: link.fields,
      rationale:
        "The rollout snapshot copies only the enumerated normalized Human identity fields so an interrupted owner-managed bulk provisioning operation can resume deterministically.",
    },
  })),
  ...WIRE_LINKS.map((link, index) => ({
    id: `link.wire.main-2026-08-13.reviewed-boundary-${index + 1}`,
    surface: "wire" as const,
    locator: link.locator,
    owner: link.locator.startsWith("sse:") ? "packages/server" : "packages/server",
    targetDebtIds: link.targets,
    reason:
      "This authenticated wire call carries the same Human directory, one-time credential handoff, or artifact patch content already represented by the named exact frozen wire boundary.",
    testEvidence: [link.evidence],
  })),
];
