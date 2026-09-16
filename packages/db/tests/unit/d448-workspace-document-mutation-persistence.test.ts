/** D448 Phase 8.2 schema/query contract tests. No database is opened. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DocumentMutationCommittedEvent } from "@nautilo/types";
import {
  acquireWorkspaceDocumentMutationOperationLock,
  casWorkspaceArtifactContentPointer,
  findWorkspaceDocumentMutationForIdempotency,
  insertWorkspaceDocumentMutationReceipt,
  listStaleWorkspaceDocumentMutationOutboxBatchKeys,
  type WorkspaceDocumentMutationTx,
} from "../../src/queries/workspace-document-mutations";
import {
  workspaceDocumentMutationEntries,
  workspaceDocumentMutationEntryIdentities,
  workspaceDocumentMutationOutbox,
  workspaceDocumentMutations,
} from "../../src/schema/workspace-document-mutations";

const DB_ROOT = resolve(import.meta.dirname, "../..");
const SCHEMA = readFileSync(
  resolve(DB_ROOT, "src/schema/workspace-document-mutations.ts"),
  "utf8",
);
const QUERY = readFileSync(
  resolve(DB_ROOT, "src/queries/workspace-document-mutations.ts"),
  "utf8",
);
const SQL = readFileSync(
  resolve(DB_ROOT, "src/migrations/0110_d448_workspace_document_mutation_persistence.sql"),
  "utf8",
);

const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);
const BEFORE_SHA = "b".repeat(64);
const AFTER_SHA = "c".repeat(64);
const OPERATION_ID = "coordinator-operation-not-uuid";
const REVISION_GROUP_ID = "coordinator-group-not-uuid";

function workspaceVersion(revision: number, sha256: string) {
  const identity = {
    kind: "workspace_artifact" as const,
    artifactId: ARTIFACT_ID,
    logicalPath: "notes/a.md",
  };
  return {
    identity,
    backendVersion: { kind: "artifact_revision" as const, revision },
    sha256,
  };
}

type UpdateCommittedEvent = Extract<
  DocumentMutationCommittedEvent,
  { mutation: "update" }
>;

function committedEvent(sequence = 0, editorSave = true): UpdateCommittedEvent {
  const before = workspaceVersion(1, BEFORE_SHA);
  const after = workspaceVersion(2, AFTER_SHA);
  return {
    type: "document.mutation.committed",
    operationId: OPERATION_ID,
    revisionGroupId: REVISION_GROUP_ID,
    sequence,
    outcome: "applied",
    actor: { kind: "human", humanId: "human-1" },
    mutation: "update",
    path: {
      kind: "update",
      before: before.identity,
      after: after.identity,
    },
    before,
    after,
    ...(editorSave ? { editorSave: { checkpoint: true } } : {}),
  };
}

function receiptInput() {
  return {
    operationId: OPERATION_ID,
    requestDigest: DIGEST,
    revisionGroupId: REVISION_GROUP_ID,
    actorKind: "human" as const,
    actorId: "human-1",
    lane: "editor_save",
    editorRequestFingerprint: "d".repeat(64),
    entries: [{
      sequence: 0,
      kind: "update" as const,
      revisionIds: ["revision-source", "revision-destination"] as [string, string],
      undoRecordIds: ["undo-source", "undo-destination"] as [string, string],
      artifactInternalId: ARTIFACT_ID,
      beforeLogicalPath: "notes/a.md",
      afterLogicalPath: "notes/a.md",
      beforeRevision: 1,
      afterRevision: 2,
      beforeSha256: BEFORE_SHA,
      afterSha256: AFTER_SHA,
      beforeSize: 1,
      afterSize: 2,
      beforeStorageUri: "file:///before",
      afterStorageUri: "file:///after",
      checkpoint: true,
    }],
    eventBatch: {
      operationId: OPERATION_ID,
      revisionGroupId: REVISION_GROUP_ID,
      idempotencyKey:
        `document-mutation:v1:${JSON.stringify([OPERATION_ID, REVISION_GROUP_ID])}`,
      events: [committedEvent()],
    },
  };
}

describe("D448 Workspace document mutation persistence", () => {
  test("discovers every wholly stale batch deterministically without a result ceiling", async () => {
    const queryStart = QUERY.indexOf(
      "export async function listStaleWorkspaceDocumentMutationOutboxBatchKeys",
    );
    const queryBody = QUERY.slice(queryStart);
    expect(queryStart).toBeGreaterThan(-1);
    expect(queryBody).toContain("bool_and(");
    expect(queryBody).toContain(
      "claimedAt} <= ${claimedBefore.toISOString()}::timestamptz",
    );
    expect(queryBody).toContain(
      ".orderBy(asc(workspaceDocumentMutationOutbox.batchIdempotencyKey))",
    );
    expect(queryBody).not.toContain(".limit(");

    const tx = {
      select: () => ({
        from: () => ({
          groupBy: () => ({
            having: () => ({
              orderBy: async () => [
                { batchIdempotencyKey: "batch-a" },
                { batchIdempotencyKey: "batch-b" },
              ],
            }),
          }),
        }),
      }),
    } as unknown as WorkspaceDocumentMutationTx;
    expect(
      await listStaleWorkspaceDocumentMutationOutboxBatchKeys(
        tx,
        new Date(250),
      ),
    ).toEqual(["batch-a", "batch-b"]);
    expect(
      listStaleWorkspaceDocumentMutationOutboxBatchKeys(
        tx,
        new Date(Number.NaN),
      ),
    ).rejects.toThrow("valid date");
  });

  test("adds durable exact receipts and a committed-event outbox outside the bounded ring", () => {
    for (const table of [
      "workspace_document_mutations",
      "workspace_document_mutation_entries",
      "workspace_document_mutation_entry_identities",
      "workspace_document_mutation_outbox",
    ]) {
      expect(SQL).toContain(`CREATE TABLE "${table}"`);
    }
    expect(SQL).not.toContain('ALTER TABLE "pending_artifact_events"');
    expect(SQL).toContain('"operation_id" text NOT NULL');
    expect(SQL).toContain('"revision_group_id" text NOT NULL');
    expect(SQL).toContain('"checkpoint" boolean NOT NULL');
    expect(SQL).toContain(
      `"event_type" = 'document.mutation.committed'`,
    );
    expect(SQL).toContain(
      `"payload"->>'type' = 'document.mutation.committed'`,
    );
  });

  test("stores ordered opaque revisionIds and undoRecordIds losslessly, including multiples", async () => {
    const writes = new Map<unknown, unknown[]>();
    const tx = {
      execute: async () => [],
      insert: (table: unknown) => ({
        values: (
          raw: Record<string, unknown> | Array<Record<string, unknown>>,
        ) => {
          const values = Array.isArray(raw) ? raw : [raw];
          writes.set(table, values);
          return {
            returning: async () => {
              if (table === workspaceDocumentMutations) {
                return [{ ...values[0] as object, id: "mutation-row" }];
              }
              if (table === workspaceDocumentMutationEntries) {
                return values.map((value, index) => ({
                  ...value as object,
                  id: `entry-row-${index}`,
                }));
              }
              if (table === workspaceDocumentMutationEntryIdentities) {
                return values.map((value, index) => ({
                  ...value as object,
                  id: `identity-row-${index}`,
                }));
              }
              if (table === workspaceDocumentMutationOutbox) {
                return values.map((value, index) => ({
                  ...value as object,
                  id: `outbox-row-${index}`,
                }));
              }
              return [];
            },
          };
        },
      }),
    } as unknown as WorkspaceDocumentMutationTx;
    const lock = await acquireWorkspaceDocumentMutationOperationLock(tx, OPERATION_ID);
    await insertWorkspaceDocumentMutationReceipt(tx, lock, receiptInput());

    expect(writes.get(workspaceDocumentMutationEntryIdentities)).toEqual([
      {
        mutationEntryId: "entry-row-0",
        kind: "revision",
        sequence: 0,
        value: "revision-source",
      },
      {
        mutationEntryId: "entry-row-0",
        kind: "revision",
        sequence: 1,
        value: "revision-destination",
      },
      {
        mutationEntryId: "entry-row-0",
        kind: "undo_record",
        sequence: 0,
        value: "undo-source",
      },
      {
        mutationEntryId: "entry-row-0",
        kind: "undo_record",
        sequence: 1,
        value: "undo-destination",
      },
    ]);
    expect(writes.get(workspaceDocumentMutationEntries)).toMatchObject([{
      artifactInternalId: ARTIFACT_ID,
    }]);
    expect(writes.get(workspaceDocumentMutationOutbox)).toMatchObject([{
      batchIdempotencyKey:
        `document-mutation:v1:${JSON.stringify([OPERATION_ID, REVISION_GROUP_ID])}`,
      eventType: "document.mutation.committed",
      payload: committedEvent(),
    }]);
  });

  test("requires an operation-scoped transaction lock before lookup and insert", async () => {
    const statements: unknown[] = [];
    const tx = {
      execute: async (statement: unknown) => {
        statements.push(statement);
        return [];
      },
    } as unknown as WorkspaceDocumentMutationTx;
    const lock = await acquireWorkspaceDocumentMutationOperationLock(tx, OPERATION_ID);
    expect(lock.operationId).toBe(OPERATION_ID);
    expect(statements).toHaveLength(1);
    expect(insertWorkspaceDocumentMutationReceipt(
      { execute: async () => [] } as unknown as WorkspaceDocumentMutationTx,
      lock,
      receiptInput(),
    )).rejects.toThrow("different transaction");
    expect(QUERY).toContain("workspace-document-mutation-operation:");
    expect(QUERY).toContain("lock: WorkspaceDocumentMutationOperationLock");
  });

  test("replays exact ordered receipts, multi-id arrays, and enlisted events after digest match", async () => {
    const key =
      `document-mutation:v1:${JSON.stringify([OPERATION_ID, REVISION_GROUP_ID])}`;
    const header = {
      id: "mutation-row",
      operationId: OPERATION_ID,
      requestDigest: DIGEST,
      revisionGroupId: REVISION_GROUP_ID,
      actorKind: "human",
      actorId: "human-1",
      lane: "file_tool",
      requestId: null,
      clientMutationId: null,
      editorRequestFingerprint: null as string | null,
      outboxBatchIdempotencyKey: key,
    };
    const persistedEntries = [0, 1].map((sequence) => ({
      id: `entry-${sequence}`,
      mutationId: "mutation-row",
      sequence,
      mutationKind: "update",
      artifactInternalId: ARTIFACT_ID,
      beforeLogicalPath: "notes/a.md",
      afterLogicalPath: "notes/a.md",
      beforeRevision: 1,
      afterRevision: 2,
      beforeSha256: BEFORE_SHA,
      afterSha256: AFTER_SHA,
      beforeSize: 1,
      afterSize: 2,
      beforeStorageUri: "file:///before",
      afterStorageUri: "file:///after",
      destinationBeforeArtifactInternalId: null,
      destinationBeforeLogicalPath: null,
      destinationBeforeRevision: null,
      destinationBeforeSha256: null,
      destinationBeforeSize: null,
      destinationBeforeStorageUri: null,
      checkpoint: true,
    }));
    const persistedIdentities = [
      { mutationEntryId: "entry-0", kind: "revision", sequence: 1, value: "rev-0-b" },
      { mutationEntryId: "entry-0", kind: "revision", sequence: 0, value: "rev-0-a" },
      { mutationEntryId: "entry-0", kind: "undo_record", sequence: 1, value: "undo-0-b" },
      { mutationEntryId: "entry-0", kind: "undo_record", sequence: 0, value: "undo-0-a" },
      { mutationEntryId: "entry-1", kind: "revision", sequence: 0, value: "rev-1-a" },
      { mutationEntryId: "entry-1", kind: "undo_record", sequence: 0, value: "undo-1-a" },
    ];
    const persistedOutbox = [0, 1].map((sequence) => ({
      mutationId: "mutation-row",
      sequence,
      batchIdempotencyKey: key,
      eventType: "document.mutation.committed",
      payload: committedEvent(sequence, false),
    }));
    let childSelects = 0;
    const tx = {
      execute: async () => [],
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === workspaceDocumentMutations) {
              return { limit: async () => [header] };
            }
            childSelects += 1;
            if (table === workspaceDocumentMutationEntryIdentities) {
              return Promise.resolve(persistedIdentities);
            }
            const rows = table === workspaceDocumentMutationEntries
              ? persistedEntries
              : persistedOutbox;
            return { orderBy: async () => rows };
          },
        }),
      }),
    } as unknown as WorkspaceDocumentMutationTx;
    const lock = await acquireWorkspaceDocumentMutationOperationLock(tx, OPERATION_ID);
    const replay = await findWorkspaceDocumentMutationForIdempotency(tx, lock, DIGEST);
    expect(replay).toMatchObject({
      kind: "match",
      replay: {
        receipt: {
          backend: "workspace",
          entries: [
            {
              revisionIds: ["rev-0-a", "rev-0-b"],
              undoRecordIds: ["undo-0-a", "undo-0-b"],
            },
            {
              revisionIds: ["rev-1-a"],
              undoRecordIds: ["undo-1-a"],
            },
          ],
        },
        enlistedEventBatch: {
          idempotencyKey: key,
          events: [committedEvent(0, false), committedEvent(1, false)],
        },
      },
    });
    expect(childSelects).toBe(3);

    childSelects = 0;
    const mismatch = await findWorkspaceDocumentMutationForIdempotency(
      tx,
      lock,
      "d".repeat(64),
    );
    expect(mismatch).toMatchObject({ kind: "digest_mismatch" });
    expect(childSelects).toBe(0);

    header.actorKind = "system";
    expect(findWorkspaceDocumentMutationForIdempotency(
      tx,
      lock,
      DIGEST,
    )).rejects.toThrow("invalid persisted actor kind");
    expect(childSelects).toBe(0);

    header.actorKind = "human";
    header.lane = "editor_save";
    header.editorRequestFingerprint = "d".repeat(64);
    persistedOutbox[0]!.payload = committedEvent(0);
    persistedOutbox[1]!.payload = committedEvent(1);
    expect(findWorkspaceDocumentMutationForIdempotency(
      tx,
      lock,
      DIGEST,
    )).rejects.toThrow("one human update receipt and event");
  });

  test("rejects empty receipts, duplicate opaque ids, and legacy event shapes before writes", async () => {
    const tx = { execute: async () => [] } as unknown as WorkspaceDocumentMutationTx;
    const lock = await acquireWorkspaceDocumentMutationOperationLock(tx, OPERATION_ID);
    expect(insertWorkspaceDocumentMutationReceipt(tx, lock, {
      ...receiptInput(),
      entries: [],
      eventBatch: { ...receiptInput().eventBatch, events: [] },
    })).rejects.toThrow("at least one entry");
    expect(insertWorkspaceDocumentMutationReceipt(tx, lock, {
      ...receiptInput(),
      entries: [{
        ...receiptInput().entries[0]!,
        undoRecordIds: ["revision-source"] as [string],
      }],
    })).rejects.toThrow("globally unique nonempty opaque ids");
    expect(insertWorkspaceDocumentMutationReceipt(tx, lock, {
      ...receiptInput(),
      eventBatch: {
        ...receiptInput().eventBatch,
        events: [{
          type: "document.patch.applied",
        } as never],
      },
    })).rejects.toThrow();
    const mismatched = committedEvent();
    expect(insertWorkspaceDocumentMutationReceipt(tx, lock, {
      ...receiptInput(),
      eventBatch: {
        ...receiptInput().eventBatch,
        events: [{
          ...mismatched,
          after: workspaceVersion(3, AFTER_SHA),
        }],
      },
    })).rejects.toThrow("proof must exactly match");
    expect(insertWorkspaceDocumentMutationReceipt(tx, lock, {
      ...receiptInput(),
      eventBatch: {
        ...receiptInput().eventBatch,
        idempotencyKey: `document-mutation:${OPERATION_ID}:${REVISION_GROUP_ID}`,
      },
    })).rejects.toThrow("shared v1 contract");
    expect(insertWorkspaceDocumentMutationReceipt(tx, lock, {
      ...receiptInput(),
      actorKind: "system",
    } as never)).rejects.toThrow("human or agent");
    expect(insertWorkspaceDocumentMutationReceipt(tx, lock, {
      ...receiptInput(),
      editorRequestFingerprint: null as never,
    })).rejects.toThrow("canonical request fingerprint");
    expect(insertWorkspaceDocumentMutationReceipt(tx, lock, {
      ...receiptInput(),
      eventBatch: {
        ...receiptInput().eventBatch,
        events: [{
          ...committedEvent(),
          editorSave: {
            checkpoint: false,
            requestId: "unexpected-request",
          },
        }],
      },
    })).rejects.toThrow("header, entry, and event correlation");
  });

  test("uses committed-only headers and binds every dispatchable row atomically", () => {
    expect(SQL).toContain(
      'FOREIGN KEY ("mutation_id","batch_idempotency_key")',
    );
    expect(SQL).toContain(
      'REFERENCES "public"."workspace_document_mutations"("id","outbox_batch_idempotency_key")',
    );
    expect(SQL).toContain('"workspace_document_mutations_outbox_binding_check"');
    expect(SQL).toContain('"workspace_document_mutation_outbox_state_timestamps_check"');
    expect(SQL).toContain('"uq_workspace_document_mutations_outbox_batch_idempotency"');
    expect(SQL).toContain('"uq_workspace_document_mutation_outbox_batch_sequence"');
    expect(SQL).toContain('"workspace_document_mutation_entries_proof_shape_check"');
    expect(SQL).not.toContain('"state" text DEFAULT \'prepared\'');
    expect(SQL).not.toContain('"failed_at"');
    expect(SQL).not.toContain('"committed_at"');
    expect(SQL).not.toContain("'system'");
    expect(QUERY).not.toContain('"not_committed"');
  });

  test("keeps proof sizes exactly representable and rejects blank storage URIs", async () => {
    const tx = { execute: async () => [] } as unknown as WorkspaceDocumentMutationTx;
    const lock = await acquireWorkspaceDocumentMutationOperationLock(tx, OPERATION_ID);
    for (const invalidSize of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(insertWorkspaceDocumentMutationReceipt(tx, lock, {
        ...receiptInput(),
        entries: [{
          ...receiptInput().entries[0]!,
          afterSize: invalidSize,
        }],
      })).rejects.toThrow("proof must exactly match");
    }
    expect(insertWorkspaceDocumentMutationReceipt(tx, lock, {
      ...receiptInput(),
      entries: [{
        ...receiptInput().entries[0]!,
        afterStorageUri: "   ",
      }],
    })).rejects.toThrow("proof must exactly match");

    expect(SQL).toContain('"workspace_document_mutation_entries_storage_uri_check"');
    expect(SQL).toContain('"workspace_document_mutation_entries_nonnegative_values_check"');
    expect(SQL).toContain('"workspace_document_mutation_entries_exact_size_check"');
    expect(SQL).toContain('"before_size" <= 9007199254740991');
    expect(SQL).toContain('"after_size" <= 9007199254740991');
    expect(SQL).toContain('"destination_before_size" <= 9007199254740991');
    expect(SCHEMA).toContain("representation safety, not a product or file-size ceiling");
    expect(QUERY).toContain("not a product size ceiling");
  });

  test("finalize/fail APIs operate on an exact batch, never arbitrary row-id subsets", () => {
    expect(QUERY).toContain("batchIdempotencyKey: string; readonly now: Date");
    expect(QUERY).toContain("Workspace outbox batch is not wholly claimed by this worker");
    expect(QUERY).not.toContain("readonly ids: readonly string[]");
    expect(QUERY).toContain("Publication is at-least-once");
  });

  test("0111 snapshot remains canonical before later main, M219, D480, and D476 migrations", () => {
    const journal = JSON.parse(
      readFileSync(resolve(DB_ROOT, "src/migrations/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const snapshot = JSON.parse(
      readFileSync(resolve(DB_ROOT, "src/migrations/meta/0111_snapshot.json"), "utf8"),
    ) as { tables: Record<string, unknown> };
    expect(journal.entries.some(
      (entry) =>
        entry.idx === 111 &&
        entry.tag === "0111_d448_workspace_document_mutation_history_metadata",
    )).toBe(true);
    expect(journal.entries.some(
      (entry) =>
        entry.idx === 112 &&
        entry.tag === "0112_d448_workspace_history_agent_grants",
    )).toBe(true);
    expect(journal.entries.find((entry) => entry.idx === 113)).toMatchObject({
      idx: 113,
      tag: "0113_d462_model_control_selection",
    });
    expect(journal.entries.find((entry) => entry.idx === 119)).toMatchObject({
      idx: 119,
      tag: "0119_m219_stenographer_model_prior_context",
    });
    expect(
      journal.entries
        .filter(({ idx }) => idx >= 120 && idx <= 127)
        .map(({ idx, tag }) => ({ idx, tag })),
    )
      .toEqual([
        { idx: 120, tag: "0120_d480_relay_device_grouping" },
        { idx: 121, tag: "0121_d476_projection_creation_key" },
        { idx: 122, tag: "0122_d476_room_name_lookup_initial" },
        { idx: 123, tag: "0123_d476_room_name_lookup_indexes" },
        { idx: 124, tag: "0124_solid_chameleon" },
        { idx: 125, tag: "0125_purple_cerise" },
        { idx: 126, tag: "0126_conscious_ricochet" },
        { idx: 127, tag: "0127_notification_intelligence_facts" },
      ]);
    expect(snapshot.tables["public.workspace_document_mutation_entry_identities"])
      .toBeDefined();
  });

  test("requires exact safe CAS metadata while accepting the full safe-integer range", async () => {
    expect(casWorkspaceArtifactContentPointer(
      {} as WorkspaceDocumentMutationTx,
      {
        artifactInternalId: ARTIFACT_ID,
        expectedRevision: 1,
        expectedStorageUri: "file:///old",
        expectedSha256: "a".repeat(64),
        callerVerifiedSha256: "b".repeat(64),
        nextStorageUri: "file:///new",
        nextSize: 1,
      },
    )).rejects.toThrow("caller-verified expected SHA-256");
    for (const invalidSize of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(casWorkspaceArtifactContentPointer(
        {} as WorkspaceDocumentMutationTx,
        {
          artifactInternalId: ARTIFACT_ID,
          expectedRevision: 1,
          expectedStorageUri: "file:///old",
          expectedSha256: "a".repeat(64),
          callerVerifiedSha256: "a".repeat(64),
          nextStorageUri: "file:///new",
          nextSize: invalidSize,
        },
      )).rejects.toThrow("finite safe nonnegative integer");
    }
    expect(casWorkspaceArtifactContentPointer(
      {} as WorkspaceDocumentMutationTx,
      {
        artifactInternalId: ARTIFACT_ID,
        expectedRevision: 1,
        expectedStorageUri: " ",
        expectedSha256: "a".repeat(64),
        callerVerifiedSha256: "a".repeat(64),
        nextStorageUri: "file:///new",
        nextSize: 1,
      },
    )).rejects.toThrow("storage URIs must be nonempty");
    expect(casWorkspaceArtifactContentPointer(
      {} as WorkspaceDocumentMutationTx,
      {
        artifactInternalId: ARTIFACT_ID,
        expectedRevision: 1,
        expectedStorageUri: "file:///old",
        expectedSha256: "a".repeat(64),
        callerVerifiedSha256: "a".repeat(64),
        nextStorageUri: "\t",
        nextSize: 1,
      },
    )).rejects.toThrow("storage URIs must be nonempty");

    const casTx = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
    } as unknown as WorkspaceDocumentMutationTx;
    expect(await casWorkspaceArtifactContentPointer(casTx, {
      artifactInternalId: ARTIFACT_ID,
      expectedRevision: 1,
      expectedStorageUri: "file:///old",
      expectedSha256: "a".repeat(64),
      callerVerifiedSha256: "a".repeat(64),
      nextStorageUri: "file:///new",
      nextSize: Number.MAX_SAFE_INTEGER,
    })).toBeNull();
  });

  test("keeps an unbounded ordered retryable batch with batch-first advisory locking", () => {
    expect(QUERY).toContain("Deliberately take NO row lock before the batch advisory lock");
    expect(QUERY).toContain('dispatchAttempts: sql`${workspaceDocumentMutationOutbox.dispatchAttempts} + 1`');
    expect(QUERY).not.toContain("PENDING_ARTIFACT_EVENTS_CAP");
    expect(SCHEMA).toContain('value: text("value").notNull()');
  });
});
