import type { EncryptionCoverageEntry } from "../src/model";

const DB_EVIDENCE =
  "packages/db/tests/integration/m302-strict-shadow-policy-health.integration.test.ts";
const SCHEMA_EVIDENCE =
  "packages/db/tests/unit/m274-encryption-transition-schema.test.ts";
const POLICY_QUERY =
  "packages/db/src/utils/encryption-transition-queries.ts";
const HEALTH_QUERY =
  "packages/db/src/utils/strict-shadow-boundary-health.ts";

const TABLES = {
  encryption_transition_boundary_health: [
    "policy_revision",
    "boundary_id",
    "family",
    "operation",
    "actor_class",
    "state",
    "reason",
    "retryable",
    "occurrence_count",
    "first_observed_at",
    "last_observed_at",
  ],
} as const;

function stable(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "").toLowerCase();
}

function boundedDb(
  id: string,
  locator: string,
  fields: readonly string[],
  queryPath: string,
): EncryptionCoverageEntry {
  return {
    id,
    surface: "db",
    locator,
    owner: "packages/db",
    readers: [queryPath],
    writers: [queryPath],
    migrationState: "not_applicable",
    retention:
      "One content-free current Strict Shadow signal per reviewed boundary and policy revision; older revisions are pruned by the bounded writer.",
    testEvidence: [SCHEMA_EVIDENCE, DB_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: fields,
    plaintextReason:
      "The reviewed field set contains only policy revisions, static boundary taxonomy, closed state/reason codes, retryability, bounded counters, and timestamps. Product coordinates, content, ciphertext, keys, grants, envelopes, prompts, and digests are prohibited.",
  };
}

const healthEntries: readonly EncryptionCoverageEntry[] =
  Object.entries(TABLES).flatMap(([table, columns]) => {
    const tableLocator = `public.${table}`;
    return [
      boundedDb(
        `db.m302.${stable(table)}.table`,
        tableLocator,
        columns,
        HEALTH_QUERY,
      ),
      ...columns.map((column) => boundedDb(
        `db.m302.${stable(table)}.${stable(column)}`,
        `${tableLocator}.${column}`,
        [column],
        HEALTH_QUERY,
      )),
    ];
  });

export const REVIEWED_M302_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...healthEntries,
  boundedDb(
    "db.m302.encryption-transition-policy.shadow-behavior",
    "public.encryption_transition_policy.shadow_behavior",
    ["shadow_behavior"],
    POLICY_QUERY,
  ),
  {
    id: "wire.m302.strict-shadow-policy-status",
    surface: "wire",
    locator: "http:request_response:GET /api/encryption-transition/policy",
    owner: "packages/server",
    readers: ["apps/workbench/src/components/crypto-device-admission-gate.tsx"],
    writers: ["packages/server/src/routes/encryption-transition.ts"],
    migrationState: "not_applicable",
    retention: "Authenticated request/response only; the response is not persisted by the client.",
    testEvidence: [
      "packages/api-client/tests/unit/encryption-transition-contract.test.ts",
      "packages/server/tests/unit/encryption-transition-route.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "responseVersion",
      "mode",
      "shadowBehavior",
      "revision",
      "updatedAt",
      "canManage",
      "protected",
      "unsupported",
      "unexercised",
      "error",
    ],
    plaintextReason:
      "The authenticated status route exposes only the server-wide transition mode/revision, owner capability, static content-free boundary counts, timestamps, and a closed error string. It carries no product content or exact product coordinate.",
  },
];
