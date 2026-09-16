import type { EncryptionCoverageEntry } from "../src/model";

const REPOSITORY =
  "packages/lattice-bridge/src/server/device/postgres-device-admission-repository.ts";
const SCHEMA_EVIDENCE =
  "packages/db/tests/unit/crypto-delivery-schema.test.ts";
const REPOSITORY_EVIDENCE =
  "packages/lattice-bridge/tests/integration/postgres-device-admission.integration.test.ts";

const TABLES = {
  human_crypto_device_admission_challenges: [
    "challenge_id",
    "challenge_hash",
    "credential_digest",
    "user_id",
    "human_actor_id",
    "device_id",
    "device_generation",
    "server_instance_id",
    "lineage_generation",
    "epoch",
    "security_revision",
    "head_digest",
    "nonce",
    "issued_at",
    "expires_at",
    "consumed_at",
    "invalidated_at",
  ],
  human_crypto_device_admissions: [
    "credential_digest",
    "user_id",
    "human_actor_id",
    "device_id",
    "device_generation",
    "server_instance_id",
    "lineage_generation",
    "epoch",
    "security_revision",
    "head_digest",
    "admitted_at",
    "expires_at",
  ],
} as const;

function stable(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "").toLowerCase();
}

function boundedDb(
  table: string,
  locator: string,
  fields: readonly string[],
): EncryptionCoverageEntry {
  return {
    id: `db.m303.${stable(table)}.${stable(locator.split(".").at(-1)!)}`,
    surface: "db",
    locator,
    owner: "packages/lattice-bridge",
    readers: [REPOSITORY],
    writers: [REPOSITORY],
    migrationState: "not_applicable",
    retention:
      "One short-lived challenge and one bounded admission per authenticated credential digest; expired and stale rows are reconciled by the admission repository.",
    testEvidence: [SCHEMA_EVIDENCE, REPOSITORY_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: fields,
    plaintextReason:
      "The exact field set contains only one-way credential/challenge digests, public device-group coordinates, a public signature nonce, lifecycle counters, identifiers, and timestamps. It contains no bearer token, private signing key, recovery phrase, Domain or Namespace key, protected object coordinate, or Human-authored content.",
  };
}

const dbEntries: readonly EncryptionCoverageEntry[] =
  Object.entries(TABLES).flatMap(([table, columns]) => {
    const tableLocator = `public.${table}`;
    return [
      boundedDb(table, tableLocator, columns),
      ...columns.map((column) =>
        boundedDb(table, `${tableLocator}.${column}`, [column])
      ),
    ];
  });

const ROUTES = [
  "http:request_response:GET /api/crypto-device-admission/status",
  "http:request_response:POST /api/crypto-device-admission/challenge",
  "http:request_response:POST /api/crypto-device-admission/proof",
] as const;

const WIRE_EVIDENCE = [
  "packages/server/tests/unit/device-admission-route.test.ts",
  "packages/lattice-bridge/src/device/device-admission.test.ts",
] as const;

export const REVIEWED_M303_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
  ...dbEntries,
  ...ROUTES.map((locator) => ({
    id: `wire.m303.${stable(locator)}`,
    surface: "wire" as const,
    locator,
    owner: "packages/server",
    readers: ["apps/workbench/src/components/crypto-device-admission-gate.tsx"],
    writers: ["packages/server/src/routes/device-admission.ts"],
    migrationState: "not_applicable" as const,
    retention:
      "Authenticated request/response only; the client retains no challenge or proof after the admission attempt.",
    testEvidence: WIRE_EVIDENCE,
    classification: "bounded_metadata" as const,
    metadataAllowlist: [
      "responseVersion",
      "requestVersion",
      "required",
      "status",
      "reason",
      "error",
      "retryable",
      "challenge",
      "proof",
      "formatVersion",
      "challengeId",
      "credentialDigestBase64url",
      "userId",
      "humanActorId",
      "deviceId",
      "deviceGeneration",
      "serverInstanceId",
      "lineageGeneration",
      "epoch",
      "securityRevision",
      "headDigestBase64url",
      "nonceBase64url",
      "signatureBase64url",
      "issuedAt",
      "expiresAt",
    ],
    plaintextReason:
      "This possession protocol transports only one-way credential digests, public device-group coordinates, a fresh public nonce, a device signature, closed outcomes, and timestamps. It transports no bearer token, private signing key, recovery phrase, content key, protected object coordinate, or Human-authored content.",
  })),
];
