import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  artifactNamespaces,
  contentAccessOperations,
  memoryNamespaces,
  type ContentAccessOperation,
  type InviteSeedTx,
} from "@nautilo/db";

import {
  planContentAccessChange,
  type AuthorizedContentAttachmentSnapshot,
  type ContentAccessPlanInput,
} from "../../src/content-access-plan";

const resolveNamespace = mock(async () => ({
  namespaceId: "ns-rehomed",
  roomId: "room-rehomed",
  minted: true,
}));
mock.module("../../src/content-access-namespace", () => ({
  resolveContentAccessNamespaceInTx: resolveNamespace,
}));
const {
  findContentAccessReplayInTx,
  publishContentAccessPlanDetailedInTx,
  publishContentAccessPlanInTx,
} = await import("../../src/content-access-publication");

afterAll(() => mock.restore());
beforeEach(() => resolveNamespace.mockClear());

const operationId = "10000000-0000-4000-8000-000000000001";
const requesterUserId = "20000000-0000-4000-8000-000000000001";
const requesterActorId = "30000000-0000-4000-8000-000000000001";
const requestDigest = "a".repeat(64);
const object = Object.freeze({
  kind: "artifact" as const,
  id: "40000000-0000-4000-8000-000000000001",
  revision: "revision-7",
});
const sourceContext = Object.freeze({
  roomId: "50000000-0000-4000-8000-000000000001",
  humanActorIds: [requesterActorId, "30000000-0000-4000-8000-000000000002"],
});

function attachment(
  namespaceId: string,
  roomId: string,
  kind: "access" | "dynamic",
  humanActorIds: readonly string[],
  mutable = true,
): AuthorizedContentAttachmentSnapshot {
  return { namespaceId, roomId, kind, humanActorIds, mutable };
}

function plan(
  change: ContentAccessPlanInput["change"],
  attachments: readonly AuthorizedContentAttachmentSnapshot[],
  privateDestination?: ContentAccessPlanInput["privateDestination"],
) {
  return planContentAccessChange({
    object,
    requesterActorId,
    sourceContext,
    attachments,
    ...(privateDestination === undefined ? {} : { privateDestination }),
    change,
  });
}

type TransactionOptions = Readonly<{
  attachmentInsertRows?: readonly { id: string }[];
  deletedRows?: readonly { id: string }[];
  remainingRows?: readonly { id: string }[];
  replayRows?: readonly ContentAccessOperation[];
}>;

function operationRow(
  values: Partial<ContentAccessOperation> = {},
): ContentAccessOperation {
  return {
    operationId,
    requestDigest,
    requesterUserId,
    requesterActorId,
    memoryId: null,
    artifactId: object.id,
    outcome: "applied",
    changed: true,
    attachedCount: 1,
    detachedCount: 0,
    skippedCount: 0,
    createdAt: new Date("2026-09-10T10:00:00.000Z"),
    ...values,
  };
}

function transaction(options: TransactionOptions = {}) {
  const events: string[] = [];
  const insertedValues: unknown[] = [];
  const tx = {
    execute: mock(async () => { events.push("lock-operation"); }),
    select: mock(() => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === contentAccessOperations) {
            events.push("select-receipt");
            return [...(options.replayRows ?? [])];
          }
          events.push("select-remaining");
          return [...(options.remainingRows ?? [])];
        },
      }),
    })),
    insert: mock((table: unknown) => {
      const isReceipt = table === contentAccessOperations;
      events.push(isReceipt ? "insert-receipt" : "insert-attachment");
      let values: Record<string, unknown> = {};
      const chain = {
        values(next: Record<string, unknown>) {
          values = next;
          insertedValues.push(next);
          return chain;
        },
        onConflictDoNothing() {
          return chain;
        },
        async returning() {
          if (!isReceipt) return [...(options.attachmentInsertRows ?? [])];
          return [operationRow(values as Partial<ContentAccessOperation>)];
        },
      };
      return chain;
    }),
    delete: mock((table: unknown) => {
      if (table !== artifactNamespaces && table !== memoryNamespaces) {
        throw new Error("Unexpected delete table");
      }
      events.push("delete-attachment");
      const chain = {
        where() { return chain; },
        async returning() { return [...(options.deletedRows ?? [])]; },
      };
      return chain;
    }),
  };
  return { tx: tx as unknown as InviteSeedTx, events, insertedValues };
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  const error = await operation.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

describe("content access publication persistence", () => {
  test("attaches before detaching and persists the terminal receipt after verifying an attachment remains", async () => {
    const mutationPlan = plan(
      { kind: "remove_person", targetActorId: "30000000-0000-4000-8000-000000000003" },
      [attachment(
        "60000000-0000-4000-8000-000000000001",
        "70000000-0000-4000-8000-000000000001",
        "access",
        [requesterActorId, "30000000-0000-4000-8000-000000000003"],
      )],
    );
    const state = transaction({
      attachmentInsertRows: [{ id: "ns-rehomed" }],
      deletedRows: [{ id: "60000000-0000-4000-8000-000000000001" }],
      remainingRows: [{ id: "ns-rehomed" }],
    });
    resolveNamespace.mockImplementationOnce(async () => {
      state.events.push("resolve-destination");
      return { namespaceId: "ns-rehomed", roomId: "room-rehomed", minted: true };
    });

    const publication = await publishContentAccessPlanDetailedInTx(state.tx, {
      operationId, requestDigest, requesterUserId, plan: mutationPlan,
    });

    expect(state.events).toEqual([
      "resolve-destination",
      "insert-attachment",
      "delete-attachment",
      "select-remaining",
      "insert-receipt",
    ]);
    expect(publication.receipt).toMatchObject({
      outcome: "applied",
      stateChanged: true,
      originalStateChanged: true,
      replayed: false,
      attachedCount: 1,
      detachedCount: 1,
    });
    expect(publication.destinations).toEqual([{
      namespaceId: "ns-rehomed",
      roomId: "room-rehomed",
      minted: true,
    }]);
    expect(publication.freshDestinations).toEqual([{
      namespaceId: "ns-rehomed",
      roomId: "room-rehomed",
      minted: true,
    }]);
    expect(publication.accounting).toEqual(mutationPlan.accounting);
  });

  test("throws before writing a receipt when the mutation leaves no attachment", async () => {
    const mutationPlan = plan(
      { kind: "grant_room", targetRoom: {
        namespaceId: "60000000-0000-4000-8000-000000000002",
        roomId: "70000000-0000-4000-8000-000000000002",
        humanActorIds: [requesterActorId],
      } },
      [attachment(
        "60000000-0000-4000-8000-000000000001",
        "70000000-0000-4000-8000-000000000001",
        "dynamic",
        [requesterActorId],
      )],
    );
    const state = transaction({ attachmentInsertRows: [], remainingRows: [] });

    await expectFailure(publishContentAccessPlanInTx(state.tx, {
      operationId, requestDigest, requesterUserId, plan: mutationPlan,
    }), "leave no attachment");

    expect(state.events).toEqual(["insert-attachment", "select-remaining"]);
    expect(state.events).not.toContain("insert-receipt");
  });

  test("reuses an exact attached immutable destination without resolving or adding another grant", async () => {
    const exactNamespaceId = "60000000-0000-4000-8000-000000000003";
    const mutationPlan = plan(
      { kind: "grant_people", selectedActorIds: ["30000000-0000-4000-8000-000000000003"] },
      [
        attachment(
          "60000000-0000-4000-8000-000000000001",
          sourceContext.roomId,
          "dynamic",
          sourceContext.humanActorIds,
        ),
        attachment(
          exactNamespaceId,
          "70000000-0000-4000-8000-000000000003",
          "access",
          [...sourceContext.humanActorIds, "30000000-0000-4000-8000-000000000003"],
        ),
      ],
    );
    const state = transaction({
      attachmentInsertRows: [],
      remainingRows: [{ id: exactNamespaceId }],
    });

    const publication = await publishContentAccessPlanDetailedInTx(state.tx, {
      operationId, requestDigest, requesterUserId, plan: mutationPlan,
    });

    expect(resolveNamespace).not.toHaveBeenCalled();
    expect(state.insertedValues[0]).toEqual({ artifactId: object.id, namespaceId: exactNamespaceId });
    expect(publication.receipt).toMatchObject({ outcome: "already_applied", stateChanged: false });
    expect(publication.destinations).toEqual([{
      namespaceId: exactNamespaceId,
      roomId: "70000000-0000-4000-8000-000000000003",
      minted: false,
    }]);
    expect(publication.freshDestinations).toEqual([]);
  });

  test("returns an authorized Room destination as an existing transient fact", async () => {
    const namespaceId = "60000000-0000-4000-8000-000000000004";
    const roomId = "70000000-0000-4000-8000-000000000004";
    const mutationPlan = plan(
      { kind: "grant_room", targetRoom: {
        namespaceId,
        roomId,
        humanActorIds: [requesterActorId],
      } },
      [attachment("ns-source", sourceContext.roomId, "dynamic", sourceContext.humanActorIds)],
    );
    const state = transaction({
      attachmentInsertRows: [{ id: namespaceId }],
      remainingRows: [{ id: "ns-source" }, { id: namespaceId }],
    });

    const publication = await publishContentAccessPlanDetailedInTx(state.tx, {
      operationId, requestDigest, requesterUserId, plan: mutationPlan,
    });

    expect(resolveNamespace).not.toHaveBeenCalled();
    expect(publication.destinations).toEqual([{ namespaceId, roomId, minted: false }]);
    expect(publication.freshDestinations).toEqual([{ namespaceId, roomId, minted: false }]);
  });

  test("records partial removal when immutable and dynamic access remains", async () => {
    const targetActorId = "30000000-0000-4000-8000-000000000003";
    const mutationPlan = plan(
      { kind: "remove_person", targetActorId },
      [
        attachment("ns-mutable", "access-mutable", "access", [requesterActorId, targetActorId]),
        attachment("ns-locked", "access-locked", "access", [requesterActorId, targetActorId], false),
        attachment("ns-dynamic", "room-dynamic", "dynamic", [requesterActorId, targetActorId]),
      ],
    );
    const state = transaction({
      attachmentInsertRows: [{ id: "ns-rehomed" }],
      deletedRows: [{ id: "ns-mutable" }],
      remainingRows: [{ id: "ns-rehomed" }, { id: "ns-locked" }, { id: "ns-dynamic" }],
    });

    const publication = await publishContentAccessPlanDetailedInTx(state.tx, {
      operationId, requestDigest, requesterUserId, plan: mutationPlan,
    });

    expect(mutationPlan.accounting).toMatchObject({
      skippedAttachmentCount: 1,
      residualAccessNamespaceIds: ["ns-locked"],
      residualDynamicRoomIds: ["room-dynamic"],
    });
    expect(publication.receipt).toMatchObject({
      outcome: "partial",
      stateChanged: true,
      attachedCount: 1,
      detachedCount: 1,
      skippedCount: 1,
    });
    expect(publication.accounting).toEqual(mutationPlan.accounting);
  });

  test("keeps the established coordinator wrapper receipt-only", async () => {
    const namespaceId = "60000000-0000-4000-8000-000000000005";
    const mutationPlan = plan(
      { kind: "grant_room", targetRoom: {
        namespaceId,
        roomId: "70000000-0000-4000-8000-000000000005",
        humanActorIds: [requesterActorId],
      } },
      [attachment("ns-source", sourceContext.roomId, "dynamic", sourceContext.humanActorIds)],
    );
    const state = transaction({
      attachmentInsertRows: [{ id: namespaceId }],
      remainingRows: [{ id: "ns-source" }, { id: namespaceId }],
    });

    const receipt = await publishContentAccessPlanInTx(state.tx, {
      operationId, requestDigest, requesterUserId, plan: mutationPlan,
    });

    expect(Object.keys(receipt).sort()).toEqual([
      "attachedCount",
      "detachedCount",
      "operationId",
      "originalStateChanged",
      "outcome",
      "replayed",
      "skippedCount",
      "stateChanged",
    ]);
  });
});

describe("content access operation replay", () => {
  test("returns the historical receipt after a later revoke without mutating or granting again", async () => {
    const historical = operationRow({ attachedCount: 1, detachedCount: 0 });
    const state = transaction({ replayRows: [historical], remainingRows: [] });

    const receipt = await findContentAccessReplayInTx(state.tx, {
      operationId, requestDigest, requesterUserId, requesterActorId,
    });

    expect(receipt).toEqual({
      operationId,
      outcome: "applied",
      stateChanged: false,
      originalStateChanged: true,
      replayed: true,
      attachedCount: 1,
      detachedCount: 0,
      skippedCount: 0,
    });
    expect(state.events).toEqual(["lock-operation", "select-receipt"]);
    expect(resolveNamespace).not.toHaveBeenCalled();
    expect(state.insertedValues).toEqual([]);
  });

  test("rejects a receipt bound to a different principal or request digest", async () => {
    const mismatches = [
      { requestDigest: "b".repeat(64) },
      { requesterUserId: "20000000-0000-4000-8000-000000000002" },
      { requesterActorId: "30000000-0000-4000-8000-000000000002" },
    ];
    for (const mismatch of mismatches) {
      const state = transaction({ replayRows: [operationRow()] });
      await expectFailure(findContentAccessReplayInTx(state.tx, {
        operationId,
        requestDigest,
        requesterUserId,
        requesterActorId,
        ...mismatch,
      }), "binding does not match");
      expect(state.events).toEqual(["lock-operation", "select-receipt"]);
      expect(state.insertedValues).toEqual([]);
    }
  });
});
