import {describe, expect, test} from "bun:test";
import {PostgresAuthorityProjectionStore} from "../../src/server/postgres-authority-store";
import {verifyRecordProductPostgresHandle, type RecordProductPostgresConnection, type RecordProductPostgresExecutor, type RecordProductPostgresRow, type RecordProductPostgresScalar} from "../../src/server/product-postgres";

const commitment = new Uint8Array(32).fill(7);
const input = {recordRef: "record", expectedProjectionGeneration: 1, sourceChangeGeneration: 2,
  targetRepresentationGeneration: 5, targetCryptoObjectId: "new-object", targetAccessNamespaceIds: ["access"], targetAudienceSetCommitment: commitment};
async function fixture(options: {dirty?: boolean; ordinary?: boolean; complete?: boolean; blocked?: boolean; newer?: boolean; currentTarget?: boolean; mismatchedObject?: boolean; quarantined?: boolean; selectedRepresentation?: "ordinary" | "protected"; selectedGeneration?: number; protectedGeneration?: number} = {}) {
  const queries: {statement: string; parameters: readonly RecordProductPostgresScalar[]}[] = [];
  const receipt: RecordProductPostgresRow = {reconciliation_id: "receipt", record_id: "record", expected_projection_generation: 1,
    source_change_generation: 2, state: options.quarantined ? "quarantined" : options.ordinary || options.complete ? "complete" : "crypto_complete", completed_at: new Date(1000),
    target_representation_generation: options.ordinary ? null : 5, target_crypto_object_id: options.ordinary ? null : "new-object",
    target_access_namespace_ids: options.ordinary ? null : ["access"], target_audience_set_commitment: options.ordinary ? null : commitment,
    former_crypto_object_id: options.ordinary ? null : "old-object", former_crypto_retired_at: null, target_crypto_retired_at: null};
  const connection: RecordProductPostgresConnection = {
    async query<Row extends RecordProductPostgresRow>(statement: string, parameters: readonly RecordProductPostgresScalar[] = []): Promise<readonly Row[]> {
      if (statement.startsWith("SELECT current_user")) return [{current_role: "nautilo", session_role: "nautilo"}] as unknown as readonly Row[];
      queries.push({statement, parameters});
      let rows: readonly RecordProductPostgresRow[] = [];
      if (statement.startsWith("select")) {
        if (statement.includes('from "reflection_record_authority_reconciliations"')) rows = statement.includes('1 as "found"') ? options.newer ? [{found: 1}] : [] : [receipt];
        else if (statement.includes('from "reflection_record_authority_projections"')) rows = [{record_id: "record", lifecycle: "current", disposition: "available", selected_representation_generation: options.selectedGeneration ?? 4, current_representation_generation: options.protectedGeneration ?? options.selectedGeneration ?? 4, crypto_object_id: options.complete ? "new-object" : "old-object", projection_generation: 2, source_change_generation: 2, processing_state: options.dirty ? "dirty" : "current", audience_set_commitment: options.dirty ? null : commitment}];
        else if (statement.includes('from "reflection_record_payload_representation_heads"')) rows = statement.includes('1 as "found"')
          ? options.currentTarget ? [{found: 1}] : []
          : [{current_representation_generation: options.complete ? 5 : 4, crypto_object_id: options.mismatchedObject ? "foreign-object" : options.complete ? "new-object" : "old-object"}];
        else if (statement.includes('from "reflection_records"')) rows = [{disposition: "available"}];
        else if (statement.includes('from "reflection_record_authority_blocks"')) rows = options.blocked ? [{found: 1}] : [];
        else if (statement.includes('from "reflection_record_authority_alternatives"')) rows = [{access_namespace_id: "access", includes_public_boundary: false, alternative_commitment: commitment, alternative_ordinal: 0}];
        else if (statement.includes('from "reflection_record_authority_closure"')) rows = [{terminal_leaf_handle: "leaf"}];
      } else if (statement.startsWith('update "reflection_record_payload_representation_heads"')) rows = [{record_id: "record"}];
      return rows as readonly Row[];
    },
    transaction<Result>(callback: (tx: RecordProductPostgresExecutor) => Promise<Result>): Promise<Result> {return callback(connection);},
  };
  return {store: new PostgresAuthorityProjectionStore(
    await verifyRecordProductPostgresHandle(connection),
    {selectedRepresentation: options.selectedRepresentation ?? "protected", migrationGeneration: 1},
  ), queries};
}
const projection = {recordRef: "record", expectedProjectionGeneration: 1, sourceChangeGeneration: 2,
  terminalAuthorityLeafHandles: ["leaf"], audienceSetCommitment: commitment,
  alternatives: [{accessNamespaceId: "access", includesPublicBoundary: false, alternativeCommitment: commitment}]};

describe("Postgres protected authority receipt attachment", () => {
  test("reports the selected ordinary generation without weakening protected receipt verification", async () => {
    const {store, queries} = await fixture({
      complete: true,
      selectedRepresentation: "ordinary",
      selectedGeneration: 1,
      protectedGeneration: 5,
    });

    expect(await store.readCurrent("record")).toMatchObject({
      representationGeneration: 1,
      protectedRepresentationGeneration: 5,
      protectedCryptoObjectId: "new-object",
      protectedAuthorityCurrent: true,
    });
    const query = queries.find(({statement}) =>
      statement.includes('from "reflection_record_authority_projections"'))!;
    expect(query.parameters).toContain("ordinary");
    expect(query.parameters).toContain("protected");
  });

  test("reads an initial dirty projection before an audience commitment exists", async () => {
    const {store} = await fixture({dirty: true});
    const current = await store.readCurrent("record");
    expect(current?.processingState).toBe("dirty");
    expect(current?.audienceSetCommitment).toBeUndefined();
    expect(current?.protectedAuthorityCurrent).toBe(false);
  });
  test("claims one exact receipt and refunds a continuation-only checkpoint", async () => {
    const queries: {
      statement: string;
      parameters: readonly RecordProductPostgresScalar[];
    }[] = [];
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(
        statement: string,
        parameters: readonly RecordProductPostgresScalar[] = [],
      ): Promise<readonly Row[]> {
        if (statement.startsWith("SELECT current_user")) {
          return [{
            current_role: "nautilo",
            session_role: "nautilo",
          }] as unknown as readonly Row[];
        }
        queries.push({ statement, parameters });
        const normalized = statement.replaceAll(/\s+/g, " ").trim().toLowerCase();
        if (normalized.startsWith("with candidates as")) {
          return [{
            record_id: "record",
            expected_projection_generation: 1,
            source_change_generation: 2,
            lease_token: "lease-exact",
            attempt_count: 1,
            sealed_checkpoint: null,
          }] as unknown as readonly Row[];
        }
        if (normalized.startsWith("select state, attempt_count, lease_token")) {
          return [{
            state: "leased",
            attempt_count: 1,
            lease_token: "lease-exact",
          }] as unknown as readonly Row[];
        }
        return [];
      },
      transaction<Result>(callback: (
        tx: RecordProductPostgresExecutor,
      ) => Promise<Result>): Promise<Result> {
        return callback(connection);
      },
    };
    const store = new PostgresAuthorityProjectionStore(
      await verifyRecordProductPostgresHandle(connection),
    );

    const [claimed] = await store.claimDueReconciliations(1, {
      recordRef: "record",
      sourceChangeGeneration: 2,
    });
    expect(claimed).toMatchObject({
      recordRef: "record",
      sourceChangeGeneration: 2,
      attemptCount: 1,
    });
    const admissionQuery = queries.find(({ statement }) =>
      statement.startsWith('insert into "reflection_record_authority_reconciliations"'))!;
    expect(admissionQuery.statement).toContain(
      '"reflection_record_authority_projections"."processing_state"',
    );
    expect(admissionQuery.parameters).toContain("record");
    expect(admissionQuery.parameters).toContain("dirty");
    expect(admissionQuery.parameters).toContain("reconciling");
    const claimQuery = queries.find(({ statement }) =>
      statement.includes("WITH candidates AS"))!;
    expect(claimQuery.statement).toContain("receipt.record_id = $2");
    expect(claimQuery.statement).toContain(
      "receipt.source_change_generation = $3",
    );
    expect(claimQuery.parameters).toEqual([1, "record", 2]);

    expect(await store.deferReconciliation({
      recordRef: "record",
      sourceChangeGeneration: 2,
      leaseToken: "lease-exact",
      sealedCheckpoint: new Uint8Array([1, 2, 3]),
      nextAttemptAt: new Date(0),
      terminal: false,
    })).toBe("deferred");
    const checkpointWrite = queries.find(({ statement }) =>
      statement.startsWith(
        'update "reflection_record_authority_reconciliations"',
      ))!;
    expect(checkpointWrite.statement).toContain(
      '"attempt_count" = greatest("reflection_record_authority_reconciliations"."attempt_count" - 1, 0)',
    );
  });

  test("ordinary complete receipt receives one fixed target without clearing logical completion", async () => {
    const f = await fixture({ordinary: true});
    expect(await f.store.recordProtectedCryptoComplete(input)).toBe("recorded");
    const write = f.queries.find(entry => entry.statement.startsWith('insert into "reflection_record_authority_reconciliations"'))!;
    expect(write.parameters).toContain("crypto_complete"); expect(write.parameters).toContain("old-object");
    expect(write.statement.slice(write.statement.indexOf("do update"))).not.toContain('"completed_at"');
    const read = await f.store.readProtectedReconciliation(input);
    expect(read).toMatchObject({receiptId: "receipt", expectedProjectionGeneration: 1, sourceChangeGeneration: 2, completedAt: new Date(1000)});
  });

  test("attach-only CAS changes the protected head, never the shared logical projection", async () => {
    const f = await fixture(); let fences = 0;
    expect(await f.store.applyProjectionCas({...projection, protectedTransition: {representationGeneration: 5, cryptoObjectId: "new-object", authorizeCommit: () => {fences++; return Promise.resolve(2000);}}})).toBe("applied");
    expect(fences).toBe(1);
    expect(f.queries.some(entry => /^(?:insert into|update) "reflection_record_authority_projections"/u.test(entry.statement))).toBe(false);
    expect(f.queries.some(entry => entry.statement.startsWith('update "reflection_record_payload_representation_heads"'))).toBe(true);
    const receiptWrite = f.queries.find(entry => entry.statement.startsWith('insert into "reflection_record_authority_reconciliations"'))!;
    expect(receiptWrite.statement).toContain('coalesce("reflection_record_authority_reconciliations"."completed_at", now())');
    expect(receiptWrite.statement.slice(receiptWrite.statement.indexOf("do update"))).not.toContain('"target_crypto_object_id"');
  });

  test("lost replies require exact target object and a fresh fence, without another head mutation", async () => {
    const f = await fixture({complete: true}); let fences = 0;
    expect(await f.store.applyProjectionCas({...projection, protectedTransition: {representationGeneration: 5, cryptoObjectId: "new-object", authorizeCommit: () => {fences++; return Promise.resolve(2000);}}})).toBe("applied");
    expect(fences).toBe(1); expect(f.queries.some(entry => /^(?:insert|update)/u.test(entry.statement))).toBe(false);
    const wrong = await fixture({complete: true, mismatchedObject: true});
    expect(await wrong.store.applyProjectionCas({...projection, protectedTransition: {representationGeneration: 5, cryptoObjectId: "new-object", authorizeCommit: () => {throw new Error("no fence for substituted object");}}})).toBe("stale");
  });

  test("blockers and newer source work prevent attachment before the fence", async () => {
    for (const options of [{blocked: true}, {newer: true}, {quarantined: true}]) {
      const f = await fixture(options);
      expect(await f.store.applyProjectionCas({...projection, protectedTransition: {representationGeneration: 5, cryptoObjectId: "new-object", authorizeCommit: () => {throw new Error("must not be invoked");}}})).toBe(options.blocked ? "blocked" : "stale");
      expect(f.queries.some(entry => /^(?:insert|update)/u.test(entry.statement))).toBe(false);
    }
  });

  test("orphan ciphertext joins retirement only after source work becomes obsolete", async () => {
    const live = await fixture({ordinary: true});
    expect(await live.store.quarantineUnattachedProtectedTarget(input)).toBe("conflict");
    expect(live.queries.some(query => query.statement.startsWith("insert"))).toBe(false);
    for (const options of [{ordinary: true, newer: true}, {ordinary: true, blocked: true}]) {
      const stale = await fixture(options);
      expect(await stale.store.quarantineUnattachedProtectedTarget(input)).toBe("quarantined");
      const write = stale.queries.find(query => query.statement.startsWith('insert into "reflection_record_authority_reconciliations"'))!;
      expect(write.parameters).toContain("quarantined");
      expect(write.parameters).toContain("new-object");
      expect(write.statement.slice(write.statement.indexOf("do update"))).not.toContain('"completed_at"');
    }
    const current = await fixture({ordinary: true, newer: true, currentTarget: true});
    expect(await current.store.quarantineUnattachedProtectedTarget(input)).toBe("conflict");
    const conflict = await fixture({newer: true});
    expect(await conflict.store.quarantineUnattachedProtectedTarget({...input, targetCryptoObjectId: "another-target"})).toBe("conflict");
  });

  test("retirement fence refuses a current target before destructive crypto runs", async () => {
    const f = await fixture({quarantined: true, currentTarget: true});
    expect(await f.store.withProtectedRetirementFence({recordRef: "record", sourceChangeGeneration: 2, cryptoObjectId: "new-object", kind: "target"}, () => {throw new Error("current object must not retire");})).toBe("conflict");
    expect(f.queries.some(entry => entry.statement.startsWith("update"))).toBe(false);
  });
});

describe("native Stenographer metadata-only authority bootstrap", () => {
  async function nativeFixture(options: {missing?: boolean; duplicate?: boolean; wrongPublication?: boolean; wrongNamespace?: boolean; repaired?: boolean} = {}) {
    const queries: {statement: string; parameters: readonly RecordProductPostgresScalar[]}[] = [];
    const row = {record_id: "record", namespace_id: "namespace", source_batch_id: "batch", batch_local_ordinal: 0,
      representation: options.repaired ? "ordinary" : "protected",
      publication_id: options.wrongPublication ? "unrelated" : "journal:batch:0",
      publication_binding_ref: options.wrongNamespace ? "journal:namespace:foreign:protected:v1" : `journal:namespace:namespace:${options.repaired ? "ordinary" : "protected"}:v1`};
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string, parameters: readonly RecordProductPostgresScalar[] = []): Promise<readonly Row[]> {
        if (statement.startsWith("SELECT current_user")) return [{current_role: "nautilo", session_role: "nautilo"}] as unknown as readonly Row[];
        queries.push({statement, parameters});
        return (statement.includes('from "room_events"') ? options.missing ? [] : options.duplicate ? [row, row] : [row] : []) as unknown as readonly Row[];
      },
      transaction<Result>(callback: (tx: RecordProductPostgresExecutor) => Promise<Result>) {return callback(connection);},
    };
    return {store: new PostgresAuthorityProjectionStore(await verifyRecordProductPostgresHandle(connection)), queries};
  }
  test("installs only the canonical initial native publication Namespace from public metadata", async () => {
    const f = await nativeFixture();
    expect(await f.store.bootstrapNativeStenographerAuthority("record")).toBe("installed");
    const proof = f.queries.find(query => query.statement.includes('from "room_events"'))!;
    expect(proof.statement).toContain('"room_events"."id"::text = "room_events"."record_id"');
    expect(proof.statement).toContain('"reflection_record_publications"."crypto_object_id" = "reflection_record_payload_representations"."crypto_object_id"');
    expect(proof.statement).toContain('not exists (select 1 from "reflection_record_dependencies"');
    expect(proof.parameters).toContain("native"); expect(proof.parameters).toContain("complete");
    expect(proof.statement).toContain('"room_events"."native_attached_at" is not null');
    expect(proof.statement).toContain('"reflection_record_payload_representation_heads"."current_representation_generation" =');
    const writes = f.queries.filter(query => query.statement.startsWith("insert"));
    expect(writes).toHaveLength(2);
    expect(writes.find(query => query.statement.includes('"reflection_record_authority_closure"'))?.parameters).toContain("namespace");
    expect(f.queries.some(query => query.statement.includes('"ordinary_payload"'))).toBe(false);
  });
  test("bootstraps repaired native protected heads from canonical ordinary provenance", async () => {
    const f = await nativeFixture({repaired: true});
    expect(await f.store.bootstrapNativeStenographerAuthority("record")).toBe("installed");
  });
  test("refuses missing, ambiguous, noncanonical, and Namespace-substituted publication proofs", async () => {
    for (const options of [{missing: true}, {duplicate: true}, {wrongPublication: true}, {wrongNamespace: true}]) {
      const f = await nativeFixture(options);
      expect(await f.store.bootstrapNativeStenographerAuthority("record")).toBe("unavailable");
      expect(f.queries.some(query => query.statement.startsWith("insert"))).toBe(false);
    }
  });
});
