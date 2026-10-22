import { expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import { taskContentRevisionObjectIdV1, parseTaskHistoricalRepairProvenanceV1 } from "@nautilo/lattice-bridge";
import type { ProtectedTaskOccurrence } from "@nautilo/runtime";
import { validateCurrentTaskDefinitionIdentity } from "../../src/routes/protected-task-runtime-definition-identity";

const provenance = parseTaskHistoricalRepairProvenanceV1({ version: 2,
  claimId: "20000000-0000-4000-8000-000000000001", publisherDeviceId: "history-device",
  signedRequestDigest: "a".repeat(64), sourceDigest: "b".repeat(64), sourcePayloadHash: "c".repeat(64),
  sourceRevision: 0, genesisManifestHash: "d".repeat(64) });
const base = { id: "10000000-0000-4000-8000-000000000001",
  contentNamespaceId: "30000000-0000-4000-8000-000000000001", contentRevision: 1 };
const task: ProtectedTaskOccurrence["task"] = { ...base,
  cryptoObjectId: taskContentRevisionObjectIdV1({ coordinate: { kind: "definition", taskId: base.id, contentRevision: 1 },
    namespaceId: base.contentNamespaceId, historicalRepair: provenance }),
  definitionHistoricalRepair: provenance, ownerId: "owner", requestorId: "requester", agentId: "agent",
  callingRoomId: null, scheduleKind: "now", contentRepresentation: "protected", cryptoAccessRevision: 1,
  cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(7) };

function fixture(retained: unknown = provenance, digest: Uint8Array = Buffer.from(provenance.signedRequestDigest, "hex"), missing = false) {
  const queries: string[] = [];
  const product: PostgresJsBridgeConnection = {
    query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
      queries.push(sql);
      expect(parameters).toContain(task.id);
      expect(parameters).toContain(task.cryptoObjectId);
      expect(parameters).toContain(task.contentNamespaceId);
      expect(parameters).toContain(task.requestorId);
      return (missing ? [] : [{ historical_repair: retained, request_digest: digest }]) as unknown as readonly Row[];
    }, transaction: use => use(product), transactionOnce: use => use(product),
  };
  return { product, queries };
}

test("historical admission requires exact mapped ledger and canonical requester before crypto authority", async () => {
  const f = fixture();
  expect(await validateCurrentTaskDefinitionIdentity({ product: f.product, task })).toBe(true);
  const query = f.queries[0]!;
  for (const field of ["content_revision", "content_namespace_id", "crypto_object_id", "crypto_access_revision",
    "representation", "required_namespace_fingerprint", "completion", "disposition", "failure_code", "requester_human_id"]) {
    expect(query).toContain(field);
  }
  expect(query).toContain('for share of "task_definition_crypto_revisions"');
});

test("absent, substituted, and malformed historical provenance never authorizes a different object", async () => {
  for (const f of [fixture(undefined, undefined, true), fixture({ ...provenance, genesisManifestHash: "e".repeat(64) }),
    fixture(provenance, new Uint8Array(32)), fixture({ ...provenance, extra: true })]) {
    expect(await validateCurrentTaskDefinitionIdentity({ product: f.product, task })).toBe(false);
  }
  const f = fixture();
  for (const changed of [ { contentNamespaceId: "40000000-0000-4000-8000-000000000001" },
    { contentRevision: 2 }, { definitionHistoricalRepair: { ...provenance, sourceDigest: "e".repeat(64) } },
    { definitionHistoricalRepair: null } ]) {
    expect(await validateCurrentTaskDefinitionIdentity({ product: f.product, task: { ...task, ...changed } })).toBe(false);
  }
  expect(f.queries).toHaveLength(0);
});
