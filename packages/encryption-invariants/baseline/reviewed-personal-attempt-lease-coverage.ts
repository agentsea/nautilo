import type { EncryptionCoverageEntry } from "../src/model";

const REVIEW_TEST =
  "packages/encryption-invariants/tests/integration/reviewed-personal-attempt-lease-security.test.ts";

export const PERSONAL_ATTEMPT_LEASE_METADATA_FIELDS = [
  "attempt_owner_token",
  "attempt_lease_expires_at",
] as const;

export const PERSONAL_ATTEMPT_LEASE_METADATA_LOCATORS =
  PERSONAL_ATTEMPT_LEASE_METADATA_FIELDS.map(
    (field) => `public.llm_usage_events.${field}`,
  );

const LEASE_EVIDENCE = [
  REVIEW_TEST,
  "packages/db/tests/integration/personal-attempt-leases.integration.test.ts",
  "packages/server/tests/unit/personal-llm-attempt-owner.test.ts",
] as const;

/** Process-local attempt ownership is bounded operational metadata, not baseline debt. */
export const REVIEWED_PERSONAL_ATTEMPT_LEASE_COVERAGE:
  readonly EncryptionCoverageEntry[] =
  PERSONAL_ATTEMPT_LEASE_METADATA_LOCATORS.map((locator, index) => ({
    id: `db.personal-attempt-lease.${index + 1}`,
    surface: "db" as const,
    locator,
    owner: "packages/server",
    readers: [
      "packages/db/src/queries/llm-usage.ts",
      "packages/server/src/lib/personal-llm-attempt-owner.ts",
    ],
    writers: [
      "packages/db/src/queries/llm-usage.ts",
      "packages/server/src/lib/personal-llm-attempt-owner.ts",
    ],
    migrationState: "not_applicable" as const,
    retention:
      "Retained with the exact usage-attempt accounting row. The lease grants authority only while the attempt remains in progress and the timestamp is live; terminal settlement or interruption ends that authority even though the receipt remains retained.",
    testEvidence: LEASE_EVIDENCE,
    classification: "bounded_metadata" as const,
    metadataAllowlist: PERSONAL_ATTEMPT_LEASE_METADATA_FIELDS,
    plaintextReason:
      "The fields contain only a server-generated process-local UUID fencing identifier and its operational expiry timestamp. The UUID is not a provider credential, API secret, bearer token, prompt, provider response, or error. A database constraint requires the fields as a pair and limits them to direct personal attempts with explicit attempt and cost state. Server-side compare-and-set writers use them for renewal, shutdown, expiry, and exact-token settlement; personal and administrative Costs responses never project either field.",
  }));
