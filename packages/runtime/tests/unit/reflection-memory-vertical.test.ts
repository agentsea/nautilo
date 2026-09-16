import { describe, expect, test } from "bun:test";

import {
  runDurableHierarchySleep,
  type DurableSleepClaim,
  type DurableSleepSemanticPort,
  type DurableSleepWorkPort,
  type PartitionedOrganizeProposal,
} from "@nautilo/reflection";

import { createForegroundRecordRecallPort } from "../../src/reflection/foreground-record-recall-adapter";

const CLAIM: DurableSleepClaim = Object.freeze({
  logicalObjectRef: "logical:decision",
  generation: 1,
  recordRef: "record:postgres-outcome",
  changeReason: "created",
  stage: "organization",
  leaseToken: "lease-1",
});

describe("same-Room Reflection memory vertical fixture", () => {
  test("organizes competing evidence, keeps Memory authored, then searches and expands", async () => {
    let claimed = false;
    let applied: PartitionedOrganizeProposal | undefined;
    const work: DurableSleepWorkPort = {
      claimNext: async () => {
        if (claimed) return { status: "empty" };
        claimed = true;
        return { status: "claimed", claim: CLAIM };
      },
      checkpoint: async () => ({ status: "accepted" }),
      pause: async () => ({ status: "accepted" }),
      complete: async () => ({ status: "accepted" }),
      defer: async () => ({ status: "deferred" }),
      enqueue: async () => undefined,
    };
    const snapshot = (
      recordRef: string,
      statement: string,
      posture: "authored" | "derived" = "derived",
    ) => ({
      recordRef,
      observedContentFingerprint: `fingerprint:${recordRef}`,
      posture,
      anchors: ["room:database"],
      statement,
      sourceRefs: [],
      childRecordRefs: [],
      structuralHeight: 0,
      lifecycle: "current" as const,
    });
    const semantic: DurableSleepSemanticPort = {
      resolveParentConflict: async () => ({ status: "not_applicable" }),
      ensureAuthority: async () => ({ status: "ready" }),
      ensureSearchProjection: async () => ({ status: "ready" }),
      resolveDependencyLoss: async () => ({ status: "not_applicable" }),
      loadOrganizerView: async () => ({
        status: "ready",
        view: {
          changed: {
            handle: "R1",
            snapshot: snapshot(
              "record:postgres-outcome",
              "The team finalized on PostgreSQL.",
            ),
            dependency: { kind: "record", recordRef: "record:postgres-outcome" },
          },
          candidates: [
            {
              handle: "R2",
              snapshot: snapshot(
                "record:neon-argument",
                "Casey suggested Neon for managed operations.",
              ),
              dependency: { kind: "record", recordRef: "record:neon-argument" },
            },
            {
              handle: "M1",
              snapshot: snapshot(
                "memory:portability",
                "Alex requires portable SQL and predictable transactions.",
                "authored",
              ),
              dependency: {
                kind: "source",
                dependency: {
                  sourceKind: "memory",
                  logicalSourceRef: "memory:portability",
                  observedRevision: "4",
                  observedContentFingerprint: "fingerprint:memory:portability",
                  terminalAuthorityLeafHandle: "namespace:database",
                  authorityBearing: true,
                },
              },
            },
          ],
          existingParents: [],
          maxSelectedChildren: 4,
        },
      }),
      invokeOrganizer: async () => JSON.stringify({
        operation: "create_parent",
        statement: "PostgreSQL was chosen after weighing managed operations against portable transactional behavior.",
        childRecordRefs: ["R1", "R2", "M1"],
      }),
      applyProposal: async (input) => {
        applied = input.proposal;
        return {
          status: "applied",
          operation: "create_parent",
          replayed: false,
          usage: {
            modelCalls: 0,
            visitedRecords: 2,
            createdRecords: 1,
            traversalWork: 2,
          },
        };
      },
    };

    const run = await runDurableHierarchySleep({
      work,
      semantic,
      budget: {
        maxWorkItems: 1,
        hierarchy: {
          maxModelCalls: 2,
          maxVisitedRecords: 8,
          maxCreatedRecords: 1,
          maxTraversalWork: 8,
          maxStatementCharacters: 800,
        },
      },
    });
    expect(run.operations.create_parent).toBe(1);
    expect(applied).toEqual({
      operation: "create_parent",
      statement: "PostgreSQL was chosen after weighing managed operations against portable transactional behavior.",
      childRecordRefs: ["record:postgres-outcome", "record:neon-argument"],
      sourceDependencies: [{
        sourceKind: "memory",
        logicalSourceRef: "memory:portability",
        observedRevision: "4",
        observedContentFingerprint: "fingerprint:memory:portability",
        terminalAuthorityLeafHandle: "namespace:database",
        authorityBearing: true,
      }],
    });

    const recall = createForegroundRecordRecallPort({
      bindingRef: "opaque-room-binding",
      search: {
        search: async () => ({
          status: "available",
          results: [{
            recordRef: "record:parent",
            statement: "PostgreSQL was chosen after weighing managed operations against portable transactional behavior.",
            score: 0.91,
            structuralHeight: 1,
            lifecycle: "current",
            directParentRecordRefs: [],
            backlinksTruncated: false,
          }],
        }),
      },
      evidence: {
        expand: async () => ({
          status: "available",
          nodes: [
            {
              recordRef: "record:parent",
              statement: "PostgreSQL was chosen after weighing managed operations against portable transactional behavior.",
              structuralHeight: 1,
              lifecycle: "current",
              depth: 0,
            },
            {
              recordRef: "record:neon-argument",
              statement: "Casey suggested Neon for managed operations.",
              structuralHeight: 0,
              lifecycle: "current",
              depth: 1,
            },
          ],
          edges: [{
            parentRecordRef: "record:parent",
            childRecordRef: "record:neon-argument",
            childPosition: 0,
          }],
          sources: [{
            evidenceRef: "exact-memory-evidence",
            kind: "memory",
            content: "Alex requires portable SQL and predictable transactions.",
            returnedUtf8Bytes: 58,
          }],
        }),
      },
    });
    expect(await recall.search({ query: "Why PostgreSQL?", limit: 5 })).toMatchObject({
      status: "ok",
      records: [{ recordRef: "record:parent", structuralHeight: 1 }],
    });
    expect(await recall.expand({ recordRef: "record:parent" })).toMatchObject({
      status: "ok",
      evidence: [
        { kind: "record", record: { recordRef: "record:neon-argument" } },
        { kind: "memory", availability: "current" },
      ],
    });
  });

  test("ordinary same- and cross-Room questions batch while an independent wait stays paused", async () => {
    const sameRoomClaim = {
      ...CLAIM,
      logicalObjectRef: "logical:same-room",
      recordRef: "record:same-room",
      leaseToken: "lease:same-room",
    };
    const waitingClaim = {
      ...CLAIM,
      logicalObjectRef: "logical:waiting",
      recordRef: "record:waiting",
      leaseToken: "lease:waiting",
    };
    const crossRoomClaim = {
      ...CLAIM,
      logicalObjectRef: "logical:cross-room",
      recordRef: "record:cross-room",
      leaseToken: "lease:cross-room",
    };
    const claims = [sameRoomClaim, waitingClaim, crossRoomClaim];
    let claimIndex = 0;
    const paused: string[] = [];
    const completed: string[] = [];
    const work: DurableSleepWorkPort = {
      claimNext: async () => {
        const next = claims[claimIndex++];
        return next === undefined
          ? { status: "empty" }
          : { status: "claimed", claim: next };
      },
      checkpoint: async () => ({ status: "accepted" }),
      pause: async ({ claim }) => {
        paused.push(claim.recordRef);
        return { status: "accepted" };
      },
      complete: async ({ claim }) => {
        completed.push(claim.recordRef);
        return { status: "accepted" };
      },
      defer: async () => ({ status: "deferred" }),
      enqueue: async () => undefined,
    };
    const snapshot = (recordRef: string, roomRef: string) => ({
      recordRef,
      observedContentFingerprint: `fingerprint:${recordRef}`,
      posture: "derived" as const,
      anchors: [roomRef],
      statement: `Statement for ${recordRef}.`,
      sourceRefs: [],
      childRecordRefs: [],
      structuralHeight: 0,
      lifecycle: "current" as const,
    });
    const invoked: string[][] = [];
    const applied: string[] = [];
    const semantic: DurableSleepSemanticPort = {
      resolveParentConflict: async () => ({ status: "not_applicable" }),
      ensureAuthority: async () => ({ status: "ready" }),
      ensureSearchProjection: async () => ({ status: "ready" }),
      resolveDependencyLoss: async () => ({ status: "not_applicable" }),
      loadOrganizerView: async (claim) => claim.recordRef === "record:waiting"
        ? { status: "waiting", retryAt: 2_000 }
        : {
            status: "ready",
            view: {
              changed: {
                handle: "R1",
                snapshot: snapshot(claim.recordRef, "room:origin"),
                dependency: { kind: "record", recordRef: claim.recordRef },
              },
              candidates: [{
                handle: "R2",
                snapshot: snapshot(
                  `record:candidate:${claim.recordRef}`,
                  claim.recordRef === "record:cross-room"
                    ? "room:neighbor"
                    : "room:origin",
                ),
                dependency: {
                  kind: "record",
                  recordRef: `record:candidate:${claim.recordRef}`,
                },
              }],
              existingParents: [],
              maxSelectedChildren: 4,
              ...(claim.recordRef === "record:cross-room"
                ? { applicationPlanToken: "plain-cross-room-plan" as never }
                : {}),
            },
          },
      invokeOrganizer: async () => {
        throw new Error("ordinary ready questions should use the shared batch");
      },
      invokeOrganizerBatch: async (batchClaims) => {
        invoked.push(batchClaims.map((claim) => claim.recordRef));
        return JSON.stringify({
          answers: batchClaims.map((_, index) => ({
            question: `Q${index + 1}`,
            proposal: { operation: "no_change" },
          })),
        });
      },
      applyProposal: async ({ claim }) => {
        applied.push(claim.recordRef);
        return {
          status: "applied",
          operation: "no_change",
          replayed: false,
          usage: {
            modelCalls: 0,
            visitedRecords: 0,
            createdRecords: 0,
            traversalWork: 0,
          },
        };
      },
    };

    const run = await runDurableHierarchySleep({
      work,
      semantic,
      budget: {
        maxWorkItems: 3,
        hierarchy: {
          maxModelCalls: 2,
          maxVisitedRecords: 16,
          maxCreatedRecords: 2,
          maxTraversalWork: 16,
          maxStatementCharacters: 800,
        },
      },
      now: () => 1_000,
    });

    // Omitting openOrganizationAttempt exercises the ordinary scheduler's
    // grant-free default. Plain selection is separately fixed to this ordinary
    // factory by reflection-semantic-production-policy.test.ts.
    expect(invoked).toEqual([["record:same-room", "record:cross-room"]]);
    expect(applied).toEqual(["record:same-room", "record:cross-room"]);
    expect(paused).toEqual(["record:waiting"]);
    expect(completed).toEqual(["record:same-room", "record:cross-room"]);
    expect(run).toMatchObject({
      claimed: 3,
      paused: 1,
      completed: 2,
      usage: { modelCalls: 1 },
      diagnostics: { modelBatches: 1, modelBatchItems: 2 },
      planning: { sameRoomCompletions: 1, crossRoomCompletions: 1 },
    });
  });
});
