import type { EncryptionCoverageEntry } from "../src/model";

const DB_QUERY = "packages/db/src/queries/personal-encryption-coverage.ts";
const DB_EVIDENCE = [
  "packages/db/tests/unit/m308-personal-encryption-coverage.test.ts",
  "packages/db/tests/integration/m308-personal-encryption-coverage.integration.test.ts",
] as const;
const ROUTE = "packages/server/src/routes/personal-encryption-coverage.ts";
const ROUTE_EVIDENCE = [
  "packages/api-client/tests/unit/personal-encryption-coverage-contract.test.ts",
  "packages/server/tests/unit/personal-encryption-coverage-route.test.ts",
  "apps/workbench/src/pages/settings/sections/personal-encryption-coverage-card.test.tsx",
] as const;

export const REVIEWED_M308_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  {
    id: "db.m308.personal-encryption-coverage.aggregate-reader",
    surface: "db",
    locator:
      "packages/db/src/queries/personal-encryption-coverage.ts#readPersonalEncryptionCoverageFamily:raw_sql:unresolved:unresolved.dynamic_sql:1",
    owner: "packages/db",
    readers: [DB_QUERY],
    writers: [],
    migrationState: "not_applicable",
    retention:
      "Read-only request-scoped aggregates are returned to the caller and are not persisted.",
    testEvidence: DB_EVIDENCE,
    classification: "bounded_metadata",
    metadataAllowlist: [
      "accessible",
      "plaintext_present",
      "encrypted_counterpart",
    ],
    plaintextReason:
      "The scanner cannot reduce the family-selected static SQL fragments, but the reviewed path performs SELECT-only aggregate counts and returns no product content, exact product coordinate, ciphertext, key material, or grant data.",
  },
  {
    id: "wire.m308.personal-encryption-coverage",
    surface: "wire",
    locator: "http:request_response:GET /api/encryption/coverage/me",
    owner: "packages/server",
    readers: [
      "apps/workbench/src/pages/settings/sections/personal-encryption-coverage-card.tsx",
    ],
    writers: [ROUTE],
    migrationState: "not_applicable",
    retention:
      "Authenticated request/response only; the client retains the latest aggregate response in component memory while Settings is mounted.",
    testEvidence: ROUTE_EVIDENCE,
    classification: "bounded_metadata",
    metadataAllowlist: [
      "dtoVersion",
      "policy",
      "computedAt",
      "families",
      "family",
      "measurement",
      "accessible",
      "plaintextPresent",
      "encryptedCounterpart",
      "error",
    ],
    plaintextReason:
      "The authenticated route exposes only a policy label, timestamp, stable family labels, closed measurement states, and aggregate decimal counts. It carries no product content, exact product coordinate, ciphertext, key material, or grant data.",
  },
  ...([
    ["request.query", ["no accepted query fields"]],
    ["response.body.families[6]", ["closed family measurement"]],
    ["response.body.families[]", ["closed family measurement"]],
  ] as const satisfies ReadonlyArray<readonly [string, readonly string[]]>)
    .map(([path, metadataAllowlist], index) => ({
      id: `wire.m308.personal-encryption-coverage.closed-leaf-${index + 1}`,
      surface: "wire" as const,
      locator: `http:request_response:GET /api/encryption/coverage/me#${path}`,
      owner: "packages/server",
      readers: [
        "apps/workbench/src/pages/settings/sections/personal-encryption-coverage-card.tsx",
      ],
      writers: [ROUTE],
      migrationState: "not_applicable" as const,
      retention:
        "Authenticated request/response only; this closed DTO leaf is not persisted.",
      testEvidence: ROUTE_EVIDENCE,
      classification: "bounded_metadata" as const,
      metadataAllowlist,
      plaintextReason:
        "This scanner-open leaf is closed by the reviewed DTO declaration to either an empty query object or one family measurement containing only a static family label, closed state, and aggregate decimal counts.",
    })),
];
