import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createDirectDb,
  createPostgresJsCanonicalBridgeConnection,
  eq,
  inArray,
  reflectionRecordAuthorityDependencies,
  reflectionRecordDependencies,
  reflectionRecordDependencyChangeRepairs,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecordPublications,
  reflectionRecords,
  reflectionRecordSemanticWork,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createHmacRecordSemanticCommitmentPort,
  PostgresSemanticWorkStore,
  verifyRecordProductPostgresHandle,
} from "@nautilo/reflection-bridge/server";

let db: ReturnType<typeof createDirectDb>;
const BASE = new Date("2003-04-05T06:07:08.000Z");

beforeAll(() => {
  bootstrapTestDbInstance();
  db = createDirectDb(4);
});

afterAll(async () => {
  await db?.end();
});

test("backfills one exact missing terminal receipt and leaves canonical structural and authority propagation to the drain", async () => {
  const suffix = randomUUID();
  const rollback = new Error("rollback missing terminal dependency fixture");
  try {
    await createPostgresJsCanonicalBridgeConnection(db).transaction(
      async (tx, executor) => {
        const ids = {
          child: `terminal-child-${suffix}`,
          parent: `terminal-parent-${suffix}`,
          authority: `terminal-authority-${suffix}`,
          healthyChild: `healthy-terminal-child-${suffix}`,
          healthyParent: `healthy-terminal-parent-${suffix}`,
          protectedChild: `protected-terminal-child-${suffix}`,
          protectedParent: `protected-terminal-parent-${suffix}`,
          pendingChild: `pending-terminal-child-${suffix}`,
          pendingParent: `pending-terminal-parent-${suffix}`,
          claimedChild: `claimed-terminal-child-${suffix}`,
          claimedParent: `claimed-terminal-parent-${suffix}`,
        };
        const children = [
          ids.child,
          ids.healthyChild,
          ids.protectedChild,
          ids.pendingChild,
          ids.claimedChild,
        ];
        const parents = [
          ids.parent,
          ids.authority,
          ids.healthyParent,
          ids.protectedParent,
          ids.pendingParent,
          ids.claimedParent,
        ];
        await tx.insert(reflectionRecords).values([
          ...children.map(recordId => ({
            recordId,
            lifecycle: "sunset" as const,
            structuralHeight: 0,
            producerPolicyVersion: "stenographer-v1",
            processingGeneration: 2,
            createdAt: BASE,
            updatedAt: BASE,
          })),
          ...parents.map(recordId => ({
            recordId,
            lifecycle: "current" as const,
            structuralHeight: 1,
            producerPolicyVersion: "candidate-policy-v1",
            processingGeneration: 1,
            createdAt: BASE,
            updatedAt: BASE,
          })),
        ]);
        await tx.insert(reflectionRecordPayloadRepresentations).values(
          [...children, ...parents].map(recordId => ({
            recordId,
            representation: "ordinary" as const,
            representationGeneration: 1,
            plaintextPayloadBytes: new Uint8Array([1]),
            createdAt: BASE,
          })),
        );
        await tx.insert(reflectionRecordPayloadRepresentationHeads).values(
          [...children, ...parents].map(recordId => ({
            recordId,
            representation: "ordinary" as const,
            currentRepresentationGeneration: 1,
            updatedAt: BASE,
          })),
        );
        await tx.insert(reflectionRecordPayloadRepresentations).values({
          recordId: ids.protectedParent,
          representation: "protected",
          representationGeneration: 1,
          cryptoObjectId: `protected-terminal:${suffix}`,
          createdAt: BASE,
        });
        await tx.insert(reflectionRecordPayloadRepresentationHeads).values({
          recordId: ids.protectedParent,
          representation: "protected",
          currentRepresentationGeneration: 1,
          updatedAt: BASE,
        });
        await tx.insert(reflectionRecordDependencies).values([
          { parentRecordId: ids.parent, childRecordId: ids.child },
          { parentRecordId: ids.healthyParent, childRecordId: ids.healthyChild },
          { parentRecordId: ids.protectedParent, childRecordId: ids.protectedChild },
          { parentRecordId: ids.pendingParent, childRecordId: ids.pendingChild },
          { parentRecordId: ids.claimedParent, childRecordId: ids.claimedChild },
        ]);
        await tx.insert(reflectionRecordAuthorityDependencies).values({
          recordId: ids.authority,
          dependencyRecordId: ids.child,
        });
        const completeWork = (recordId: string) => ({
          recordId,
          generation: 1,
          completedGeneration: 1,
          changeReason: "scheduled_review" as const,
          stage: "search_projection" as const,
          state: "complete" as const,
          projectionRefreshOnly: true,
          completionOutcome: "completed" as const,
          dueSince: BASE,
          startedAt: BASE,
          completedAt: BASE,
          createdAt: BASE,
          updatedAt: BASE,
        });
        await tx.insert(reflectionRecordSemanticWork).values([
          ...parents.filter(recordId => recordId !== ids.claimedParent)
            .map(completeWork),
          {
            recordId: ids.claimedParent,
            generation: 1,
            changeReason: "scheduled_review" as const,
            stage: "authority_projection" as const,
            state: "claimed" as const,
            claimGeneration: 1,
            leaseToken: randomUUID(),
            leaseExpiresAt: new Date(BASE.getTime() + 60_000),
            dueSince: BASE,
            startedAt: BASE,
            createdAt: BASE,
            updatedAt: BASE,
          },
        ]);
        await tx.insert(reflectionRecordPublications).values({
          publicationId: `pending-terminal:${suffix}`,
          recordId: ids.pendingParent,
          representation: "protected",
          representationGeneration: 2,
          requestCommitment: new Uint8Array(32).fill(17),
          publicationBindingRef: `pending-terminal-binding:${suffix}`,
          reservedCryptoObjectId: `pending-terminal-object:${suffix}`,
          state: "reserved",
          createdAt: BASE,
          updatedAt: BASE,
        });

        const handle = await verifyRecordProductPostgresHandle({
          query: executor.query.bind(executor),
          transaction: use => use(executor),
        });
        const commitments = createHmacRecordSemanticCommitmentPort(
          new Uint8Array(32).fill(31),
        );
        const store = new PostgresSemanticWorkStore({
          handle,
          commitments,
          // Sort this rollback-only receipt before any scratch residue so the
          // one-page drain deterministically consumes the fixture itself.
          clock: () => new Date("1901-01-01T00:00:00.000Z"),
        });
        const repair = (parentRecordRef: string, childRecordRef: string) =>
          store.repairMissingTerminalStructuralDependency({
            parentRecordRef,
            parentProcessingGeneration: 1,
            childRecordRef,
            childProcessingGeneration: 2,
          });

        expect(await repair(ids.parent, ids.child)).toBe("repaired");
        expect(await repair(ids.parent, ids.child)).toBe("replayed");
        const [pendingReceipt] = await tx.select({
          completedAt: reflectionRecordDependencyChangeRepairs.completedAt,
        }).from(reflectionRecordDependencyChangeRepairs).where(eq(
          reflectionRecordDependencyChangeRepairs.changedRecordId,
          ids.child,
        ));
        expect(pendingReceipt).toEqual({ completedAt: null });

        expect(await store.repairRecordDependentsPage({ limit: 16 })).toEqual({
          consumed: 1,
          admitted: 2,
          pending: false,
        });
        const propagated = await tx.select({
          recordId: reflectionRecordSemanticWork.recordId,
          generation: reflectionRecordSemanticWork.generation,
          changeReason: reflectionRecordSemanticWork.changeReason,
          state: reflectionRecordSemanticWork.state,
        }).from(reflectionRecordSemanticWork).where(inArray(
          reflectionRecordSemanticWork.recordId,
          [ids.parent, ids.authority],
        ));
        expect(propagated).toHaveLength(2);
        expect(propagated.every(row =>
          row.generation === 2
          && row.changeReason === "dependency_lost"
          && row.state === "due"
        )).toBeTrue();
        expect(await repair(ids.parent, ids.child)).toBe("replayed");

        await store.recordChangedWithinTransaction(executor, {
          recordRef: ids.healthyChild,
          changeRef: "lifecycle:current:sunset:v2",
        }, BASE);
        expect(await repair(ids.healthyParent, ids.healthyChild)).toBe("replayed");
        expect(await repair(ids.protectedParent, ids.protectedChild))
          .toBe("unavailable");
        expect(await repair(ids.pendingParent, ids.pendingChild))
          .toBe("unavailable");
        expect(await repair(ids.claimedParent, ids.claimedChild))
          .toBe("unavailable");
        const guardedReceipts = await tx.select({
          changedRecordId: reflectionRecordDependencyChangeRepairs.changedRecordId,
        }).from(reflectionRecordDependencyChangeRepairs).where(inArray(
          reflectionRecordDependencyChangeRepairs.changedRecordId,
          [ids.protectedChild, ids.pendingChild, ids.claimedChild],
        ));
        expect(guardedReceipts).toEqual([]);
        throw rollback;
      },
      { isolationLevel: "read committed" },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
});
