import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import {
  type DirectDatabase,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeRow,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { encodeBackgroundWorkDescriptorV2 } from "@nautilo/lattice-crypto/background";

import { createProductionReflectionAuthorityMaintenance } from
  "../../src/reflection/protected-authority-composition";

const RECORD = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-11T00:00:00.000Z");
const SOURCE_GENERATION = 7;
const PROJECTION_GENERATION = 12;
const REPRESENTATION_GENERATION = 4;
const NAMESPACE = "22222222-2222-4222-8222-222222222222";

function recoveryRow(descriptorBytes: Uint8Array, state = "awaiting_device") {
  return {
    request_id: "valid-recovery", format_version: 2,
    work_identity_hash: new Uint8Array(32).fill(2), idempotency_key: "valid-recovery",
    work_id: "recovery-work", work_kind: "reflection.authority_reproject", purpose: "record.reproject",
    namespace_id: NAMESPACE, domain_id: "recovery-domain", credential_subject_kind: "processor",
    processor_kind: "reflection", processor_version: 1, processor_authorization_revision: null,
    agent_id: null, agent_runtime_generation: null, agent_authorization_revision: null,
    expected_domain_epoch: null, expected_namespace_access_revision: 1, expected_policy_revision: 1,
    recipient_generation: 0, descriptor_hash: createHash("sha256").update(descriptorBytes).digest(),
    descriptor_bytes: descriptorBytes, recipient_key_id: "recovery-key",
    recipient_public_key: new Uint8Array(65).fill(3), recipient_expires_at_ms: NOW.getTime() + 60_000,
    accepted_response_kind: null, accepted_response_hash: null, accepted_response_bytes: null,
    credential_id: null, credential_hash: null, issuing_human_id: null, issuing_device_id: null,
    issuing_device_authorization_revision: null, issuer_signing_public_key_hash: null,
    accepted_at_ms: null, authorization_expires_at_ms: null, request_revision: state === "cancelled" ? 2 : 1,
    state, claim_id: null, claim_expires_at_ms: null, retry_count: 0, maximum_attempts: 8,
    last_retry_reason: null, next_attempt_at_ms: null, terminal_reason: state === "cancelled" ? "superseded" : null,
    finished_at_ms: state === "cancelled" ? NOW.getTime() : null,
    created_at_ms: NOW.getTime(), updated_at_ms: NOW.getTime(),
    transform_commit_claim_id: null, transform_commit_descriptor_hash: null,
    transform_commit_recipient_generation: null, transform_commit_output_count: null, transform_committed_at: null,
  };
}

describe("production Reflection authority composition", () => {
  test("isolates malformed recovery and keysets settlement past 256 requests", async () => {
    const digest = createHash("sha256").update(JSON.stringify([
      "reflection-authority/v2",
      RECORD,
      SOURCE_GENERATION,
      PROJECTION_GENERATION - 1,
      REPRESENTATION_GENERATION - 1,
      REPRESENTATION_GENERATION,
    ])).digest("hex");
    const workId = `reflection-authority:${digest}`;
    const objectId = `${workId}:record`;
    const calls: { role: string; sql: string; parameters: readonly unknown[] }[] = [];
    let recoverMalformedRows = false;
    let recoverQuarantinedRow = false;
    let cancelledRecovery = false;
    const recoveryDescriptor = encodeBackgroundWorkDescriptorV2({
      formatVersion: 2, requestId: "valid-recovery", recipientGeneration: 0,
      workKind: "reflection.authority_reproject", workId: "recovery-work",
      anchorNamespaceId: NAMESPACE, anchorDomainId: "recovery-domain",
      subject: { kind: "processor", processorKind: "reflection", processorVersion: 1 },
      operations: ["decrypt", "encrypt"], purpose: "record.reproject",
      source: { kind: "reflection_authority", recordRef: RECORD, sourceChangeGeneration: SOURCE_GENERATION,
        projectionGeneration: PROJECTION_GENERATION - 1, expectedRepresentationGeneration: 3,
        targetRepresentationGeneration: 4, fingerprint: new Uint8Array(32).fill(4) },
      namespaceRequirements: [{ authority: { serverId: "server-scope", roomId: RECORD,
        namespaceId: NAMESPACE, namespaceAccessRevision: 1, namespaceKeyGeneration: 1,
        namespaceHeadDigest: new Uint8Array(32).fill(5), domainId: "recovery-domain",
        domainKeyGeneration: 1, domainAuthorizationRevision: 1,
        domainHeadDigest: new Uint8Array(32).fill(6), bundleRevision: 1,
        bundleDigest: new Uint8Array(32).fill(7) }, operations: ["decrypt", "encrypt"] }],
      policyRevision: 1, inputBindings: [{ objectId: "source-output", namespaceId: NAMESPACE }],
      outputSlots: [{ objectId: "orphan-output", objectType: "nautilo.reflection.record.v1",
        createdAt: NOW.getTime(), namespaceIds: [NAMESPACE] }],
      maximumPlaintextBytes: 1024, maximumCiphertextBytes: 2048,
      recipientKeyId: "recovery-key", recipientPublicKey: new Uint8Array(65).fill(3),
      issuedAt: NOW.getTime(), notBefore: NOW.getTime(), expiresAt: NOW.getTime() + 60_000,
      idempotencyId: "valid-recovery",
    });

    const query = (role: string, statement: string, parameters: readonly unknown[] = []): readonly PostgresJsBridgeRow[] => {
      calls.push({ role, sql: statement, parameters });
      if (statement.includes("current_user AS current_role")) {
        return [{ current_role: role, session_role: role }];
      }
      if (statement.includes("current_user::text")) {
        return [{ current_user: role, session_user: role }];
      }
      if (role === "nautilo" && statement.includes('from "reflection_record_authority_projections"') && statement.includes('inner join "reflection_records"')) {
        return [{ record_id: RECORD, lifecycle: "current", disposition: "available",
          projection_generation: PROJECTION_GENERATION, source_change_generation: SOURCE_GENERATION,
          processing_state: "current", audience_set_commitment: new Uint8Array(32).fill(1),
          unavailable_reason: null,
          selected_representation_generation: REPRESENTATION_GENERATION,
          current_representation_generation: REPRESENTATION_GENERATION,
          crypto_object_id: objectId }];
      }
      if (role === "nautilo" && statement.startsWith('select "record_id", "source_change_generation"')) {
        return [];
      }
      if (role === "nautilo" && statement.includes('from "reflection_record_authority_reconciliations"')) {
        return [{ reconciliation_id: "receipt-1", record_id: RECORD,
          expected_projection_generation: PROJECTION_GENERATION - 1, source_change_generation: SOURCE_GENERATION,
          state: recoverQuarantinedRow ? "quarantined" : "complete", completed_at: NOW, target_representation_generation: REPRESENTATION_GENERATION,
          target_crypto_object_id: recoverQuarantinedRow ? "orphan-output" : objectId, target_access_namespace_ids: [],
          target_audience_set_commitment: new Uint8Array(32).fill(1), target_crypto_retired_at: null,
          former_crypto_object_id: null, former_crypto_retired_at: null }];
      }
      if (role === "nautilo_crypto" && statement.startsWith('select "request_id" from') && statement.includes('"work_id"')) {
        const cursor = parameters.find(value => typeof value === "string" && value.startsWith("settle-"));
        if (cursor === undefined) {
          return Array.from({ length: 256 }, (_, index) => ({
            request_id: `settle-${String(index).padStart(3, "0")}`,
          }));
        }
        return [{ request_id: "settle-256" }];
      }
      if (recoverMalformedRows && role === "nautilo_crypto"
        && statement.startsWith('select "request_id" from')
        && parameters.includes("reflection.authority_reproject")) {
        return [{ request_id: "bad-recovery" }, { request_id: "later-recovery" }];
      }
      if (recoverQuarantinedRow && role === "nautilo_crypto"
        && statement.startsWith('select "request_id" from')
        && parameters.includes("reflection.authority_reproject")) return [{ request_id: "valid-recovery" }];
      if (recoverQuarantinedRow && role === "nautilo_crypto"
        && statement.startsWith('update "background_crypto_authorization_requests"')) {
        cancelledRecovery = true;
        return [recoveryRow(recoveryDescriptor, "cancelled")];
      }
      if (recoverQuarantinedRow && role === "nautilo_crypto"
        && statement.includes('from "background_crypto_authorization_requests"')
        && parameters.includes("valid-recovery")) {
        return [recoveryRow(recoveryDescriptor, cancelledRecovery ? "cancelled" : "awaiting_device")];
      }
      if (recoverMalformedRows && role === "nautilo_crypto"
        && statement.includes('from "background_crypto_authorization_requests"')) {
        if (parameters.includes("bad-recovery")) return [{ request_id: "bad-recovery" }];
        if (parameters.includes("later-recovery")) return [];
      }
      return [];
    };

    const unsafe = (statement: string, parameters: readonly unknown[] = []) => {
      const result = query("nautilo", statement, parameters);
      return Object.assign(Promise.resolve(result), { values: () => {
        if (statement.startsWith('select "record_id", "source_change_generation"')) {
          return Promise.resolve([]);
        }
        if (statement.includes('from "reflection_record_authority_projections"') && statement.includes('inner join "reflection_records"')) {
          return Promise.resolve([[RECORD, "current", "available", PROJECTION_GENERATION,
            SOURCE_GENERATION, "current", new Uint8Array(32).fill(1), null,
            REPRESENTATION_GENERATION, objectId]]);
        }
        if (statement.includes('from "reflection_record_authority_reconciliations"')) {
          return Promise.resolve([["receipt-1", RECORD, SOURCE_GENERATION,
            PROJECTION_GENERATION - 1, "complete", null, REPRESENTATION_GENERATION,
            objectId, [], new Uint8Array(32).fill(1), null, null, null, NOW, NOW]]);
        }
        return Promise.resolve([]);
      } });
    };
    const transaction = Object.assign(() => undefined, { unsafe });
    const client = Object.assign(() => undefined, {
      unsafe,
      options: { parsers: {}, serializers: {} },
      begin: (callback: string | ((tx: typeof transaction) => Promise<unknown>), use?: (tx: typeof transaction) => Promise<unknown>) =>
        typeof callback === "function" ? callback(transaction) : use!(transaction),
    });
    const db = drizzle(client as unknown as Sql) as unknown as DirectDatabase;
    const executor: Pick<PostgresJsBridgeConnection, "query"> = {
      query: <Row extends PostgresJsBridgeRow>(statement: string, parameters: readonly unknown[] = []) =>
        Promise.resolve(query("nautilo_crypto", statement, parameters) as readonly Row[]),
    };
    const restricted: PostgresJsBridgeConnection = {
      ...executor,
      transaction: use => use(executor),
      transactionOnce: use => use(executor),
    };
    const maintenance = await createProductionReflectionAuthorityMaintenance({
      db,
      restricted,
      crypto: new LatticeCrypto(),
      serverScope: "server-scope",
      commitmentKey: new Uint8Array(32).fill(7),
      now: () => NOW.getTime(),
    });
    try {
      recoverMalformedRows = true;
      await maintenance.maintain({ limit: 8 });
      expect(calls.some(call => call.parameters.includes("bad-recovery"))).toBe(true);
      expect(calls.some(call => call.parameters.includes("later-recovery"))).toBe(true);
      recoverMalformedRows = false;
      recoverQuarantinedRow = true;
      await maintenance.maintain({ limit: 8 });
      expect(cancelledRecovery).toBe(true);
      expect(calls.some(call => call.parameters.includes("superseded"))).toBe(true);
      recoverQuarantinedRow = false;
      const settlementStart = calls.length;
      expect(await maintenance.ensureAuthority({
        logicalObjectRef: RECORD,
        generation: SOURCE_GENERATION,
        recordRef: RECORD,
        changeReason: "created",
        stage: "authority_projection",
        leaseToken: "lease-1",
      })).toEqual({ status: "ready" });
      const pages = calls.filter(call =>
        call.role === "nautilo_crypto"
        && call.sql.startsWith('select "request_id" from')
        && call.sql.includes('"work_id"')
      );
      expect(pages).toHaveLength(2);
      expect(pages[0]!.parameters).toContain(workId);
      expect(pages[1]!.parameters).toContain("settle-255");
      expect(pages[1]!.sql).toContain('"request_id" >');
      expect(calls.slice(settlementStart).filter(call =>
        call.role === "nautilo_crypto"
        && call.sql.includes('from "background_crypto_authorization_requests"')
        && !call.sql.startsWith('select "request_id" from')
      )).toHaveLength(257);
    } finally {
      await maintenance.dispose();
    }
  });
});
