import {createHash} from "node:crypto";
import {describe, expect, test} from "bun:test";
import {encodeBackgroundWorkDescriptorV2, type BackgroundReflectionSemanticWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {verifyCryptoPostgresHandle} from "@nautilo/lattice-bridge/server";
import {verifyRecordProductPostgresHandle} from "@nautilo/reflection-bridge/server";
import {settleUnusedReflectionSemanticRequest, retireObsoleteReflectionSemanticHint, retireReflectionProductReceipt} from "../../src/reflection/protected-authority-composition";

const START = 1_700_000_000_000, NOW = START + 600_000;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
function descriptor(): BackgroundReflectionSemanticWorkDescriptorV2 {
  const workId = `reflection-semantic:${createHash("sha256").update(JSON.stringify(["reflection-semantic/v2", "reflection.organization", "source:record", 7])).digest("hex")}`;
  const authority = {serverId: "server:one", roomId: "room:one", namespaceId: "namespace:one", namespaceAccessRevision: 1,
    namespaceKeyGeneration: 1, namespaceHeadDigest: new Uint8Array(32).fill(1), domainId: "domain:one", domainKeyGeneration: 1,
    domainAuthorizationRevision: 1, domainHeadDigest: new Uint8Array(32).fill(2), bundleRevision: 1, bundleDigest: new Uint8Array(32).fill(3)};
  return {formatVersion: 2, requestId: "request:one", workId, recipientGeneration: 0, workKind: "reflection.organization", purpose: "record.organize",
    anchorNamespaceId: authority.namespaceId, anchorDomainId: authority.domainId, subject: {kind: "processor", processorKind: "reflection", processorVersion: 1},
    namespaceRequirements: [{authority, operations: ["decrypt", "encrypt"]}], operations: ["decrypt", "encrypt"], policyRevision: 1,
    source: {kind: "reflection_semantic", recordRef: "source:record", claimGeneration: 7, fingerprint: new Uint8Array(32).fill(4)},
    inputBindings: [{objectId: "input:one", namespaceId: authority.namespaceId, objectType: "nautilo.reflection.record.v1"}],
    outputSlots: [{objectId: `${workId}:record`, objectType: "nautilo.reflection.record.v1", createdAt: START, namespaceIds: [authority.namespaceId]}],
    maximumPlaintextBytes: 1_048_576, maximumCiphertextBytes: 1_048_576, recipientKeyId: "key:one", recipientPublicKey: new Uint8Array(65).fill(3),
    issuedAt: START, notBefore: START, expiresAt: START + 300_000, idempotencyId: "request:one"};
}
function requestRow(d = descriptor()) {
  const bytes = encodeBackgroundWorkDescriptorV2(d), response = new Uint8Array([1, 2, 3]);
  return {request_id: d.requestId, format_version: 2, work_identity_hash: new Uint8Array(32).fill(1), idempotency_key: d.idempotencyId,
    work_id: d.workId, work_kind: d.workKind, purpose: d.purpose, namespace_id: d.anchorNamespaceId, domain_id: d.anchorDomainId,
    credential_subject_kind: "processor", processor_kind: "reflection", processor_version: 1, processor_authorization_revision: null,
    agent_id: null, agent_runtime_generation: null, agent_authorization_revision: null, expected_domain_epoch: null,
    expected_namespace_access_revision: 1, expected_policy_revision: 1, recipient_generation: 0, descriptor_hash: sha(bytes), descriptor_bytes: bytes,
    recipient_key_id: d.recipientKeyId as string | null, recipient_public_key: d.recipientPublicKey as Uint8Array | null, recipient_expires_at_ms: d.expiresAt as number | null,
    accepted_response_kind: "processor", accepted_response_hash: sha(response), accepted_response_bytes: response,
    credential_id: "credential:one", credential_hash: new Uint8Array(32).fill(5), issuing_human_id: "human:one", issuing_device_id: "device:one",
    issuing_device_authorization_revision: 1, issuer_signing_public_key_hash: new Uint8Array(32).fill(6), accepted_at_ms: START + 1,
    authorization_expires_at_ms: START + 300_000, request_revision: 4, state: "running", claim_id: "claim:one" as string | null,
    claim_expires_at_ms: START + 120_000 as number | null, retry_count: 0, maximum_attempts: 8, last_retry_reason: null,
    next_attempt_at_ms: null, terminal_reason: null as string | null, finished_at_ms: null as number | null, created_at_ms: START, updated_at_ms: START + 3,
    transform_commit_claim_id: null, transform_commit_descriptor_hash: null, transform_commit_recipient_generation: null,
    transform_commit_output_count: null, transform_committed_at: null};
}
class Connection {
  active = false;
  constructor(readonly role: "nautilo" | "nautilo_crypto", readonly events: string[], readonly result: (sql: string) => readonly unknown[]) {}
  query<Row>(sql: string): Promise<readonly Row[]> {
    this.events.push(`${this.role}:${sql}`);
    if (sql.includes("current_user AS current_role")) return Promise.resolve([{current_role: this.role, session_role: this.role}] as Row[]);
    if (sql.includes("current_user::text")) return Promise.resolve([{current_user: this.role, session_user: this.role}] as Row[]);
    return Promise.resolve(this.result(sql) as Row[]);
  }
  async transaction<Result>(use: (tx: this) => Promise<Result>): Promise<Result> {
    this.active = true;
    try {const value = await use(this); this.events.push(`${this.role}:commit`); return value;}
    catch (error) {this.events.push(`${this.role}:rollback`); throw error;}
    finally {this.active = false;}
  }
}
async function settlementFixture() {
  const events: string[] = [], row = requestRow();
  let work = {generation: 7, completed_generation: 7, state: "complete"};
  let marker: Record<string, unknown> = {transform_commit_claim_id: null, transform_commit_descriptor_hash: null,
    transform_commit_recipient_generation: null, transform_commit_output_count: null, transform_committed_at: null};
  const product = new Connection("nautilo", events, statement => statement.includes('from "reflection_record_semantic_work"') ? [work] : []);
  const crypto = new Connection("nautilo_crypto", events, statement => {
    if (statement.includes('from "background_crypto_authorization_requests"') && statement.includes("for update")) return [marker];
    if (statement.startsWith('update "background_crypto_authorization_requests"')) {
      Object.assign(row, {state: "cancelled", terminal_reason: "superseded", finished_at_ms: NOW, updated_at_ms: NOW,
        recipient_key_id: null, recipient_public_key: null, recipient_expires_at_ms: null, claim_id: null, claim_expires_at_ms: null,
        request_revision: row.request_revision + 1}); return [row];
    }
    if (statement.includes('from "background_crypto_authorization_requests"')) return [row];
    return [];
  });
  return {events, row, input: {product: await verifyRecordProductPostgresHandle(product), restricted: await verifyCryptoPostgresHandle(crypto), requestId: row.request_id, now: NOW},
    work: (value: typeof work) => {work = value;}, marker: (value: typeof marker) => {marker = value;}};
}

describe("obsolete semantic authorization settlement", () => {
  test("completed no-change work retires its running request only under product and transform-marker locks", async () => {
    const f = await settlementFixture();
    expect(await settleUnusedReflectionSemanticRequest(f.input)).toBe(true);
    expect(f.row.state).toBe("cancelled"); expect(f.row.finished_at_ms).toBe(NOW);
    const workLock = f.events.findIndex(value => value.includes('from "reflection_record_semantic_work"') && value.includes("for update"));
    const requestLock = f.events.findIndex(value => value.includes('from "background_crypto_authorization_requests"') && value.includes("for update"));
    expect(workLock).toBeGreaterThan(-1); expect(requestLock).toBeGreaterThan(workLock);
  });
  test("expired grant with still-current work is preserved for the canonical retry", async () => {
    const f = await settlementFixture(); f.work({generation: 7, completed_generation: 6, state: "pending"});
    expect(await settleUnusedReflectionSemanticRequest(f.input)).toBe(false); expect(f.row.state).toBe("running");
  });
  test("each partial or complete transform marker retains uncertain saved output authority", async () => {
    for (const column of ["transform_commit_claim_id", "transform_commit_descriptor_hash", "transform_commit_recipient_generation", "transform_commit_output_count", "transform_committed_at"]) {
      const f = await settlementFixture(); f.marker({[column]: 1});
      expect(await settleUnusedReflectionSemanticRequest(f.input)).toBe(false); expect(f.row.state).toBe("running");
    }
  });
});

async function retirementFixture() {
  const events: string[] = [], d = descriptor(), objectId = d.outputSlots[0]!.objectId;
  let work = {generation: 8, completed_generation: 7, state: "pending"}, attached = false, owner = false;
  const receipt = {publicationId: "publication:hint", recordId: "generated:record", objectId, requestCommitment: new Uint8Array(32).fill(9)};
  const row = {record_id: receipt.recordId, reserved_crypto_object_id: objectId, crypto_object_id: null, state: "quarantined", request_commitment: receipt.requestCommitment, crypto_retired_at: null};
  const connection = new Connection("nautilo", events, statement => {
    if (statement.includes('from "reflection_record_semantic_work"')) return [work];
    if (statement.includes('from "reflection_record_payload_representations"')) return attached ? [{record_id: "other:record"}] : [];
    if (statement.includes('from "reflection_record_publications"') && statement.includes("for update")) return [row];
    if (statement.includes('from "reflection_record_publications"')) return owner ? [{publication_id: "other:publication"}] : [];
    return [];
  });
  const input = {product: await verifyRecordProductPostgresHandle(connection), receipt, now: NOW,
    verifySavedOutput: async () => {events.push("verified"); return {originalDescriptor: structuredClone(d), binding: {objectId}};},
    settleRetiredRequest: async (requestId: string) => {expect(connection.active).toBe(true); expect(requestId).toBe(d.requestId); events.push("settled");},
    retire: async (object: string) => {expect(connection.active).toBe(true); expect(object).toBe(objectId); events.push("retired");}};
  return {events, input, work: (value: typeof work) => {work = value;}, attached: () => {attached = true;}, owned: () => {owner = true;}};
}
describe("hint-only semantic output retirement", () => {
  test("an authenticated obsolete output is retired without a fresh plaintext grant", async () => {
    const f = await retirementFixture(); expect(await retireObsoleteReflectionSemanticHint(f.input)).toBe("request:one");
    expect(f.events.indexOf("retired")).toBeGreaterThan(f.events.indexOf("verified"));
    expect(f.events.indexOf("settled")).toBeGreaterThan(f.events.indexOf("retired"));
    expect(f.events.some(value => value.startsWith('nautilo:update "reflection_record_publications"'))).toBe(true);
  });
  test("a forged hint cannot retire a live generation, attached object, or another receipt's output", async () => {
    for (const reason of ["current", "attached", "owned", "unverified"] as const) {
      const f = await retirementFixture();
      if (reason === "current") f.work({generation: 7, completed_generation: 6, state: "pending"});
      if (reason === "attached") f.attached(); if (reason === "owned") f.owned();
      expect(await retireObsoleteReflectionSemanticHint({...f.input,
        ...(reason === "unverified" ? {verifySavedOutput: async () => null} : {})})).toBeNull();
      expect(f.events).not.toContain("retired");
    }
  });
  test("request settlement failure keeps a tombstoned output receipt retryable", async () => {
    const f = await retirementFixture();
    expect(await retireObsoleteReflectionSemanticHint({...f.input, settleRetiredRequest: () => Promise.reject(new Error("request changed"))})
      .then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
    expect(f.events).toContain("retired"); expect(f.events).toContain("nautilo:rollback");
    expect(f.events.some(value => value.startsWith('nautilo:update "reflection_record_publications"'))).toBe(false);
    expect(await retireObsoleteReflectionSemanticHint(f.input)).toBe("request:one");
  });
  test("failed crypto cleanup rolls back the acknowledgement and a verified retry completes", async () => {
    const f = await retirementFixture();
    expect(await retireObsoleteReflectionSemanticHint({...f.input, retire: () => Promise.reject(new Error("offline"))})
      .then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
    expect(f.events).toContain("nautilo:rollback");
    expect(f.events.some(value => value.startsWith('nautilo:update "reflection_record_publications"'))).toBe(false);
    expect(await retireObsoleteReflectionSemanticHint(f.input)).toBe("request:one");
  });
});

test("canonical product receipt fence remains held across crypto retirement", async () => {
  const events: string[] = [], retirement = {idempotencyKey: "publication:one", recordId: "record:one", representationGeneration: 1, cryptoObjectId: "object:one"};
  const connection = new Connection("nautilo", events, statement => {
    if (statement.includes('from "reflection_record_publications"') && statement.includes('left join "reflection_records"')) return [{state: "quarantined", disposition: null}];
    if (statement.includes("SELECT publication.record_id")) return [{record_id: retirement.recordId, representation_generation: 1, crypto_object_id: retirement.cryptoObjectId, crypto_retired_at: null, disposition: null}];
    return [];
  });
  expect(await retireReflectionProductReceipt({product: await verifyRecordProductPostgresHandle(connection), retirement, retire: async () => {
    expect(connection.active).toBe(true); events.push("crypto");
  }})).toBe(true);
  expect(events.findIndex(value => value.includes("pg_advisory_xact_lock"))).toBeLessThan(events.findIndex(value => value.includes("SELECT publication.record_id")));
  expect(events.findIndex(value => value.startsWith('nautilo:update "reflection_record_publications"'))).toBeLessThan(events.indexOf("crypto"));
  expect(events.at(-1)).toBe("nautilo:commit");
});

test("a receipt that became active rolls back the staged acknowledgement without touching crypto", async () => {
  const events: string[] = [], retirement = {idempotencyKey: "publication:one", recordId: "record:one", representationGeneration: 1, cryptoObjectId: "object:one"};
  const connection = new Connection("nautilo", events, statement => {
    if (statement.includes('from "reflection_record_publications"') && statement.includes('left join "reflection_records"')) return [{state: "reserved", disposition: null}];
    if (statement.includes("SELECT publication.record_id")) return [{record_id: retirement.recordId, representation_generation: 1, crypto_object_id: retirement.cryptoObjectId, crypto_retired_at: null, disposition: null}];
    return [];
  });
  expect(await retireReflectionProductReceipt({product: await verifyRecordProductPostgresHandle(connection), retirement,
    retire: async () => {events.push("crypto");}})).toBe(false);
  expect(events).not.toContain("crypto"); expect(events.at(-1)).toBe("nautilo:rollback");
});
