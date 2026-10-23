import { expect, test } from "bun:test";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "@nautilo/db";
import { taskContentRevisionObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  hasHistoricalTaskDefinitionSummaryProof,
  readHistoricalTaskDefinitionSummaryProofs,
} from "../../src/routes/task-historical-definition-summary";

const taskId = "74000000-0000-4000-8000-000000000001";
const ownerId = "74000000-0000-4000-8000-000000000002";
const namespaceId = "74000000-0000-4000-8000-000000000003";
const provenance = { version: 2 as const, claimId: "74000000-0000-4000-8000-000000000004",
  publisherDeviceId: "device", signedRequestDigest: "11".repeat(32), sourceDigest: "22".repeat(32),
  sourcePayloadHash: "33".repeat(32), genesisManifestHash: "44".repeat(32), sourceRevision: 0 as const };
const objectId = taskContentRevisionObjectIdV1({ coordinate: { kind: "definition", taskId, contentRevision: 1 },
  namespaceId, historicalRepair: provenance });
const task = { id: taskId, ownerId, requestorId: ownerId, contentRepresentation: "dual" as const,
  contentNamespaceId: namespaceId, contentRevision: 1, cryptoObjectId: objectId, cryptoAccessRevision: 2,
  cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(5), cryptoMappingState: "verified" as const };
const row = { taskId, ownerId, requestorId: ownerId, representation: "dual", namespaceId, revision: 1,
  objectId, accessRevision: 2, fingerprint: task.cryptoRequiredNamespaceFingerprint, mappingState: "verified",
  ledgerRepresentation: "dual", anchorNamespaceId: namespaceId, genesisAccessRevision: 0, payloadVersion: 1,
  completion: "complete", disposition: "mapped", failureCode: null, completedAt: new Date(1),
  requestDigest: new Uint8Array(32).fill(0x11), historicalRepair: provenance };
function database(rows: readonly unknown[]) {
  let querySql = "";
  const db = { select(fields: Parameters<QueryBuilder["select"]>[0]) {
    const query = new QueryBuilder().select(fields);
    return { from(table: Parameters<typeof query.from>[0]) {
      const statement = query.from(table).$dynamic();
      const chain = {
        innerJoin: (...args: Parameters<typeof statement.innerJoin>) => { statement.innerJoin(...args); return chain; },
        where: (...args: Parameters<typeof statement.where>) => {
          statement.where(...args); querySql = statement.toSQL().sql; return Promise.resolve(rows);
        },
      };
      return chain;
    } };
  } } as unknown as Pick<DirectDatabase, "select">;
  return { db, sql: () => querySql };
}

test("historical mapped summary uses a body-free current ledger join and accepts repaired heads", async () => {
  const f = database([row]);
  const proof = (await readHistoricalTaskDefinitionSummaryProofs(f.db, ownerId, [task])).get(taskId);
  expect(proof).toBeDefined();
  expect(hasHistoricalTaskDefinitionSummaryProof(task, proof)).toBe(true);
  expect(hasHistoricalTaskDefinitionSummaryProof({ ...task, cryptoAccessRevision: 3 }, proof)).toBe(false);
  expect(hasHistoricalTaskDefinitionSummaryProof(task, { taskId })).toBe(false);
  const sql = f.sql();
  for (const field of ['"prompt"', '"expected_output"', '"last_error"', '"operational_metadata"']) expect(sql).not.toContain(field);
  for (const field of ['"crypto_object_id"', '"content_revision"', '"content_namespace_id"',
    '"required_namespace_fingerprint"', '"requester_human_id"', '"actors"."owner_id"']) expect(sql).toContain(field);
});

test.each([
  [], [row, row], [{ ...row, completion: "pending" }], [{ ...row, disposition: "active" }],
  [{ ...row, failureCode: "crypto_mismatch" }], [{ ...row, completedAt: null }],
  [{ ...row, genesisAccessRevision: 2 }], [{ ...row, ledgerRepresentation: "protected" }],
  [{ ...row, ownerId: namespaceId }], [{ ...row, requestorId: namespaceId }],
  [{ ...row, namespaceId: ownerId }], [{ ...row, revision: 2 }], [{ ...row, accessRevision: 1 }],
  [{ ...row, fingerprint: new Uint8Array(32) }], [{ ...row, anchorNamespaceId: ownerId }],
  [{ ...row, objectId: `${objectId}0` }], [{ ...row, historicalRepair: null }],
  [{ ...row, historicalRepair: { ...provenance, sourceDigest: "55".repeat(32) } }],
  [{ ...row, historicalRepair: { ...provenance, signedRequestDigest: "66".repeat(32) } }],
  [{ ...row, historicalRepair: { ...provenance, extra: "not permitted" } }],
].map(rows => ({ rows })))("missing, changed or forged historical mapping fails closed (%#)", async ({ rows }) => {
  const f = database(rows);
  expect((await readHistoricalTaskDefinitionSummaryProofs(f.db, ownerId, [task])).size).toBe(0);
});

test("ordinary rows do not invoke the historical ledger reader", async () => {
  const f = database([]);
  expect((await readHistoricalTaskDefinitionSummaryProofs(f.db, ownerId,
    [{ ...task, contentRepresentation: "ordinary" }])).size).toBe(0);
  expect(f.sql()).toBe("");
});
