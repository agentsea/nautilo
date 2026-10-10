import type { EncryptionCoverageEntry } from "../src/model";

const REVIEW_TEST =
  "packages/encryption-invariants/tests/integration/reviewed-paid-service-funding-security.test.ts";

export const CONVERSION_OPERATION_METADATA_FIELDS = [
  "id",
  "operation_key",
  "recovery_handle",
  "causal_human_user_id",
  "room_id",
  "agent_id",
  "task_id",
  "run_id",
  "job_id",
  "funding_kind",
  "provider_route",
  "provider_sandbox",
  "provider_region",
  "credential_id",
  "credential_revision",
  "credential_fingerprint",
  "source_kind",
  "source_artifact_id",
  "source_artifact_revision",
  "source_sha256",
  "source_authority_digest",
  "destination_artifact_id",
  "destination_artifact_revision",
  "destination_namespace_id",
  "destination_path_digest",
  "destination_authority_digest",
  "input_format",
  "output_format",
  "max_output_bytes",
  "provider_tag",
  "provider_job_id",
  "submission_lease_id",
  "submission_lease_expires_at",
  "cancellation_requested_at",
  "status",
  "provider_credits",
  "output_sha256",
  "output_bytes",
  "publication_revision_id",
  "publication_artifact_id",
  "failure_code",
  "version",
  "created_at",
  "updated_at",
  "submitted_at",
  "terminal_at",
  "published_at",
] as const;

export const CONVERSION_OPERATION_METADATA_LOCATORS = [
  "public.conversion_operations",
  ...CONVERSION_OPERATION_METADATA_FIELDS.map(
    (field) => `public.conversion_operations.${field}`,
  ),
] as const;

const CONVERSION_OPERATION_EVIDENCE = [
  REVIEW_TEST,
  "packages/db/tests/integration/conversion-operations.integration.test.ts",
  "packages/server/tests/unit/cloud-conversion-runtime.test.ts",
  "packages/agent/src/tools/convert/convert-tool.test.ts",
] as const;

const DURABLE_FUNDING_BINDING_FIELDS = [
  "humanUserId",
  "provider",
  "binding.kind",
  "binding.providerRoute",
  "binding.credentialId",
  "binding.credentialRevision",
  "credentialFingerprint",
] as const;

export const DURABLE_SERVICE_FUNDING_BINDING_LOCATORS = [
  "public.connected_web_accounts.profile_funding_binding",
  "public.connected_web_action_operations.funding_binding",
  "public.connected_web_operations.funding_binding",
] as const;

const DURABLE_FUNDING_BINDING_EVIDENCE = [
  REVIEW_TEST,
  "packages/types/tests/unit/service-funding.test.ts",
  "packages/server/tests/unit/service-funding.test.ts",
  "packages/server/tests/unit/connected-web-account-operation-store.test.ts",
] as const;

export const CONNECTED_WEB_ACTION_RUN_COST_CUSTODY_LOCATOR =
  "public.connected_web_action_operations.run_cost_custody";

const RUN_COST_CUSTODY_FIELDS = [
  "version",
  "phase",
  "hostedRun.identity",
  "hostedRun.workload",
  "browserSession.identity",
  "browserSession.workload",
  "attribution.humanUserId",
  "attribution.roomId",
  "attribution.agentId",
] as const;

/** New paid-service observations are explicit metadata, not new baseline debt. */
export const REVIEWED_PAID_SERVICE_FUNDING_COVERAGE:
  readonly EncryptionCoverageEntry[] = [
  ...CONVERSION_OPERATION_METADATA_LOCATORS.map((locator, index) => ({
    id: `db.paid-service-funding.conversion-operation.${index + 1}`,
    surface: "db" as const,
    locator,
    owner: "packages/server",
    readers: [
      "packages/db/src/queries/conversion-operations.ts",
      "packages/server/src/conversions/cloud-conversion-runtime.ts",
    ],
    writers: [
      "packages/db/src/queries/conversion-operations.ts",
      "packages/server/src/conversions/cloud-conversion-runtime.ts",
      "packages/agent/src/tools/convert/convert-tool.ts",
    ],
    migrationState: "not_applicable" as const,
    retention:
      "Retained as the exact paid conversion lifecycle receipt until the owning Human is deleted after terminal-state eligibility checks.",
    testEvidence: CONVERSION_OPERATION_EVIDENCE,
    classification: "bounded_metadata" as const,
    metadataAllowlist: CONVERSION_OPERATION_METADATA_FIELDS,
    plaintextReason:
      "This content-free receipt contains identifiers, revisions, fixed formats and states, timestamps, sizes, measured provider credits, opaque provider coordinates, and SHA-256 digests. It never stores source or output bytes, logical paths, prompts, export URLs, credentials, or provider error text. The deterministic source, path, and authority digests can reveal equality or confirm a guessed value, so product-role-only database privileges and exact Human/Room authority checks are required controls rather than an encryption claim. failure_code is restricted by the only runtime writers to fixed content-free lifecycle codes.",
  })),
  ...DURABLE_SERVICE_FUNDING_BINDING_LOCATORS.map((locator, index) => ({
    id: `db.paid-service-funding.durable-binding.${index + 1}`,
    surface: "db" as const,
    locator,
    owner: "packages/server",
    readers: [
      "packages/server/src/connected-web-accounts/store.ts",
      "packages/server/src/lib/service-funding.ts",
    ],
    writers: [
      "packages/server/src/connected-web-accounts/store.ts",
      "packages/server/src/lib/service-funding.ts",
    ],
    migrationState: "not_applicable" as const,
    retention:
      "Retained with the exact account, action, or browser-operation resource and deleted with that owning lifecycle row.",
    testEvidence: DURABLE_FUNDING_BINDING_EVIDENCE,
    classification: "bounded_metadata" as const,
    metadataAllowlist: DURABLE_FUNDING_BINDING_FIELDS,
    plaintextReason:
      "The strict durable binding stores only the causal Human, paid provider, server or personal funding route, optional personal credential id and revision, and a domain-separated SHA-256 fingerprint. It contains no raw API key or decrypted credential; exact parsing and account-bound recovery reject malformed shapes and alternate credentials.",
  })),
  {
    id: "db.paid-service-funding.connected-web-action-run-cost-custody",
    surface: "db",
    locator: CONNECTED_WEB_ACTION_RUN_COST_CUSTODY_LOCATOR,
    owner: "packages/server",
    readers: [
      "packages/server/src/connected-web-accounts/store.ts",
      "packages/server/src/connected-web-accounts/action-tool-runtime.ts",
    ],
    writers: [
      "packages/server/src/connected-web-accounts/store.ts",
      "packages/server/src/connected-web-accounts/action-tool-runtime.ts",
    ],
    migrationState: "not_applicable",
    retention:
      "Retained only while the action row holds its opaque provider run reference, then cleared atomically when that external run is settled or released.",
    testEvidence: [
      REVIEW_TEST,
      "packages/server/tests/unit/connected-web-account-operation-store.test.ts",
      "packages/server/tests/unit/connected-web-account-action-runtime.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: RUN_COST_CUSTODY_FIELDS,
    plaintextReason:
      "The strict version-one custody object contains fixed phase and workload enums, deterministic cost-ledger identities, and causal Human, Room, and Agent ids. It carries no browser content, target, provider response, raw credential, API key, URL, or error text, and it is valid only beside the separately guarded opaque run reference.",
  },
];
