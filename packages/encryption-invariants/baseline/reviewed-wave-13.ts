import type { EncryptionCoverageEntry } from "../src/model";

const ROUTE_EVIDENCE =
  "packages/server/tests/unit-isolated/protected-memory-routes.test.ts";
const CLIENT_EVIDENCE =
  "packages/api-client/tests/unit/protected-memory-methods-contract.test.ts";

const WIRE_LOCATORS = [
  "http:request_response:POST /api/protected/memories/:id/archive",
  "http:request_response:POST /api/protected/memories/:id/restore",
  "http:request_response:POST /api/protected/memories/:id/tier",
] as const;

function boundedEntry(input: Readonly<{
  id: string;
  locator: string;
  owner: string;
  readers: readonly string[];
  writers: readonly string[];
  evidence: readonly string[];
  metadata: readonly string[];
  reason: string;
}>): EncryptionCoverageEntry {
  return {
    id: input.id,
    surface: input.locator.startsWith("http:") ? "wire" : "db",
    locator: input.locator,
    owner: input.owner,
    readers: input.readers,
    writers: input.writers,
    migrationState: "not_applicable",
    retention:
      "Retained only for the bounded protected Memory operation or its exact replay receipt; transient HTTP values are not persisted by the transport.",
    testEvidence: input.evidence,
    classification: "bounded_metadata",
    metadataAllowlist: input.metadata,
    plaintextReason: input.reason,
  };
}

const wireEntries: readonly EncryptionCoverageEntry[] =
  WIRE_LOCATORS.map((locator, index) => boundedEntry({
    id: `wire.wave13.protected-tier-mutation-${String(index + 1).padStart(2, "0")}`,
    locator,
    owner: "packages/server",
    readers: ["packages/api-client/src/client.ts"],
    writers: [
      "packages/server/src/routes/protected-memory-routes.ts",
    ],
    evidence: [ROUTE_EVIDENCE, CLIENT_EVIDENCE],
    metadata: [
      "operation and Memory identifiers",
      "content, crypto-access, and tier revision expectations",
      "typed unavailable or exact replay response",
    ],
    reason:
      "The dormant mutation transport carries only exact identifiers, revision and tier expectations, and typed status. It carries no Memory content, query text, plaintext embedding, key, root, or decrypted payload.",
  }));

/** Reviewed dormant Human Memory tier transport. */
export const REVIEWED_WAVE_13_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...wireEntries,
  ];
