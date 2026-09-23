import { describe, expect, test } from "bun:test";
import type { RecordSnapshot } from "../../src/contracts/hierarchy";
import {
  DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1,
  DurableSleepModelLaneUnavailableError,
  DurableSleepProviderOutcomeUnknownError,
  durableSleepQuarantineRecoveryDelayMilliseconds,
  runDurableHierarchySleep,
  type DurableSleepApplyResult,
  type DurableSleepClaim,
  type DurableSleepLeaseResult,
  type DurableSleepOrganizerView,
  type DurableSleepSemanticPort,
  type DurableSleepWorkPort,
} from "../../src/sleep/durable-executor";

const hierarchyBudget = {
  maxModelCalls: 20,
  maxVisitedRecords: 100,
  maxCreatedRecords: 10,
  maxTraversalWork: 100,
  maxStatementCharacters: 800,
};

function snapshot(recordRef: string, posture: "authored" | "derived" = "derived"):
RecordSnapshot {
  return {
    recordRef,
    observedContentFingerprint: `fingerprint:${recordRef}`,
    posture,
    anchors: ["room:opaque"],
    statement: `Evidence ${recordRef}`,
    sourceRefs: [],
    childRecordRefs: [],
    structuralHeight: 0,
    lifecycle: "current",
  };
}

function claim(
  recordRef: string,
  stage: DurableSleepClaim["stage"] = "authority_projection",
  generation = 1,
  changeReason: DurableSleepClaim["changeReason"] = "created",
): DurableSleepClaim {
  return {
    logicalObjectRef: `logical:${recordRef}`,
    generation,
    recordRef,
    changeReason,
    stage,
    leaseToken: `lease:${recordRef}:${generation}:${stage}`,
  };
}

function mixedView(): DurableSleepOrganizerView {
  return {
    changed: {
      handle: "C0",
      snapshot: snapshot("payload-id-never-used"),
      dependency: { kind: "record", recordRef: "record:changed" },
    },
    candidates: [{
      handle: "M1",
      snapshot: snapshot("memory-id-never-a-child", "authored"),
      dependency: {
        kind: "source",
        dependency: {
          sourceKind: "memory/v1",
          logicalSourceRef: "memory:logical",
          observedRevision: "revision:2",
          observedContentFingerprint: "fingerprint:2",
          terminalAuthorityLeafHandle: "authority:room",
          authorityBearing: true,
        },
      },
    }],
    existingParents: [],
    maxSelectedChildren: 2,
  };
}

function workHarness(claims: DurableSleepClaim[], events: string[]) {
  const enqueued: unknown[] = [];
  const port: DurableSleepWorkPort = {
    claimNext: () => {
      const next = claims.shift();
      if (!next) return Promise.resolve({ status: "empty" });
      events.push(`claim:${next.recordRef}`);
      return Promise.resolve({ status: "claimed", claim: next });
    },
    checkpoint: ({ completedStage }) => {
      events.push(`checkpoint:${completedStage}`);
      return Promise.resolve({ status: "accepted" });
    },
    pause: () => {
      events.push("pause");
      return Promise.resolve({ status: "accepted" });
    },
    complete: () => {
      events.push("complete");
      return Promise.resolve({ status: "accepted" });
    },
    defer: ({ failureCode }) => {
      events.push(`defer:${failureCode}`);
      return Promise.resolve({ status: "deferred" });
    },
    enqueue: (input) => {
      events.push("enqueue");
      enqueued.push(input);
      return Promise.resolve();
    },
  };
  return { port, enqueued };
}

function semanticHarness(
  events: string[],
  view: DurableSleepOrganizerView = mixedView(),
  apply?: DurableSleepSemanticPort["applyProposal"],
  invoke: DurableSleepSemanticPort["invokeOrganizer"] = () =>
    Promise.resolve('{"operation":"no_change"}'),
): DurableSleepSemanticPort {
  return {
    resolveParentConflict: async () => ({ status: "not_applicable" }),
    ensureAuthority: () => {
      events.push("authority");
      return Promise.resolve({ status: "ready" });
    },
    ensureSearchProjection: () => {
      events.push("projection");
      return Promise.resolve({ status: "ready" });
    },
    loadOrganizerView: () => {
      events.push("view");
      return Promise.resolve({ status: "ready", view });
    },
    resolveDependencyLoss: () => Promise.resolve({ status: "not_applicable" }),
    invokeOrganizer: invoke,
    applyProposal: apply ?? (() => Promise.resolve({
      status: "applied",
      operation: "no_change",
      replayed: false,
      usage: {
        modelCalls: 0,
        visitedRecords: 0,
        createdRecords: 0,
        traversalWork: 0,
      },
    })),
  };
}

describe("durable hierarchy Sleep state machine", () => {
  test("waiting readiness refunds repeated claims and lets independent work progress", async () => {
    let currentTime = 1_000;
    const waitingClaim = claim("record:waiting");
    const healthyClaim = claim("record:healthy");
    const rows = [waitingClaim, healthyClaim].map((value) => ({
      claim: value,
      attemptCount: 0,
      nextAttemptAt: 0,
      claimed: false,
      checkpointed: false,
    }));
    const pauses: number[] = [];
    const work: DurableSleepWorkPort = {
      claimNext: () => {
        const row = rows.find((candidate) =>
          !candidate.claimed
          && !candidate.checkpointed
          && candidate.nextAttemptAt <= currentTime
        );
        if (row === undefined) return Promise.resolve({ status: "empty" });
        row.claimed = true;
        row.attemptCount += 1;
        return Promise.resolve({ status: "claimed", claim: row.claim });
      },
      checkpoint: ({ claim: current }) => {
        const row = rows.find((candidate) => candidate.claim === current)!;
        row.claimed = false;
        row.checkpointed = true;
        return Promise.resolve({ status: "accepted" });
      },
      pause: ({ claim: current, nextAttemptAt }) => {
        const row = rows.find((candidate) => candidate.claim === current)!;
        row.claimed = false;
        row.attemptCount = Math.max(0, row.attemptCount - 1);
        row.nextAttemptAt = nextAttemptAt ?? currentTime;
        pauses.push(row.nextAttemptAt);
        return Promise.resolve({ status: "accepted" });
      },
      complete: () => Promise.resolve({ status: "accepted" }),
      defer: () => Promise.resolve({ status: "deferred" }),
      enqueue: () => Promise.resolve(),
    };
    const semantic = semanticHarness([]);
    semantic.ensureAuthority = (current) => Promise.resolve(
      current.recordRef === waitingClaim.recordRef
        ? { status: "waiting", retryAt: currentTime + 100 }
        : { status: "ready" },
    );

    const first = await runDurableHierarchySleep({
      work,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 },
      now: () => currentTime,
    });
    expect(first).toMatchObject({
      claimed: 2,
      paused: 1,
      checkpointed: 1,
      deferred: 0,
      quarantined: 0,
      failures: {},
    });
    expect(rows[1]?.checkpointed).toBeTrue();

    currentTime = 1_099;
    expect(await runDurableHierarchySleep({
      work,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
      now: () => currentTime,
    })).toMatchObject({ claimed: 0, paused: 0 });

    for (let cycle = 1; cycle < 9; cycle += 1) {
      currentTime = 1_000 + cycle * 100;
      const result = await runDurableHierarchySleep({
        work,
        semantic,
        budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
        now: () => currentTime,
      });
      expect(result).toMatchObject({
        claimed: 1,
        paused: 1,
        deferred: 0,
        quarantined: 0,
        failures: {},
      });
    }
    expect(rows[0]).toMatchObject({
      attemptCount: 0,
      checkpointed: false,
      claimed: false,
      nextAttemptAt: 1_900,
    });
    expect(pauses).toEqual(Array.from(
      { length: 9 },
      (_, index) => 1_100 + index * 100,
    ));
  });

  test("does not treat unknown or malformed waiting readiness as ready", async () => {
    for (const readiness of [
      { status: "waiting", retryAt: Number.NaN },
      { status: "waiting", retryAt: 1_000 },
      { status: "waiting", retryAt: 8_640_000_000_000_001 },
      { status: "unknown", retryAt: 1_100 },
    ]) {
      const events: string[] = [];
      const work = workHarness([claim("record:invalid-wait")], events);
      const semantic = semanticHarness(events);
      semantic.ensureAuthority = () => Promise.resolve(readiness as never);
      const result = await runDurableHierarchySleep({
        work: work.port,
        semantic,
        budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
        now: () => 1_000,
      });
      expect(events).toEqual([
        "claim:record:invalid-wait",
        "defer:unexpected_failure",
      ]);
      expect(result).toMatchObject({
        checkpointed: 0,
        paused: 0,
        deferred: 1,
        failures: { unexpected_failure: 1 },
      });
    }
  });

  test("invokes one model batch and applies independent answers in claim order", async () => {
    const events: string[] = [];
    const claims = [
      claim("record:a", "organization"),
      claim("record:b", "organization"),
    ];
    const viewFor = (recordRef: string): DurableSleepOrganizerView => ({
      changed: {
        handle: "R1",
        snapshot: snapshot(recordRef),
        dependency: { kind: "record", recordRef },
      },
      candidates: [{
        handle: "R2",
        snapshot: snapshot(`neighbor:${recordRef}`),
        dependency: { kind: "record", recordRef: `neighbor:${recordRef}` },
      }],
      existingParents: [],
      maxSelectedChildren: 2,
    });
    const semantic = semanticHarness(events);
    semantic.loadOrganizerView = (loadedClaim) => Promise.resolve({
      status: "ready",
      view: viewFor(loadedClaim.recordRef),
    });
    semantic.invokeOrganizerBatch = (batchClaims) => {
      events.push(`batch:${batchClaims.length}`);
      return Promise.resolve(JSON.stringify({
        answers: batchClaims.map((_, index) => ({
          question: `Q${index + 1}`,
          proposal: { operation: "no_change" },
        })),
      }));
    };
    semantic.applyProposal = ({ claim: appliedClaim }) => {
      events.push(`apply:${appliedClaim.recordRef}`);
      return Promise.resolve({
        status: "applied",
        operation: "no_change",
        replayed: false,
        usage: { modelCalls: 0, visitedRecords: 0, createdRecords: 0, traversalWork: 0 },
      });
    };

    const result = await runDurableHierarchySleep({
      work: workHarness(claims, events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 },
    });

    expect(events).toContain("batch:2");
    expect(events.filter((event) => event.startsWith("apply:"))).toEqual([
      "apply:record:a",
      "apply:record:b",
    ]);
    expect(result).toMatchObject({
      completed: 2,
      usage: { modelCalls: 1 },
      diagnostics: { modelBatches: 1, modelBatchItems: 2, batchStaleRescheduled: 0 },
    });
  });

  test("pauses a waiting Organizer grant while ready siblings share one model batch", async () => {
    const currentTime = 1_000;
    const retryAt = 1_500;
    const events: string[] = [];
    const claims = [
      claim("record:waiting", "organization"),
      claim("record:ready-a", "organization"),
      claim("record:ready-b", "organization"),
    ];
    const work = workHarness(claims, events).port;
    const pause = work.pause.bind(work);
    let scheduledRetryAt: number | undefined;
    work.pause = (input) => {
      scheduledRetryAt = input.nextAttemptAt;
      return pause(input);
    };
    const semantic = semanticHarness(events);
    semantic.openOrganizationAttempt = async (current) => ({
      async assertCurrent() {},
      async publish(publish) { return publish(); },
      async close(outcome) { events.push(`close:${current.recordRef}:${outcome}`); },
    });
    semantic.loadOrganizerView = (current) => current.recordRef === "record:waiting"
      ? Promise.resolve({ status: "waiting", retryAt })
      : Promise.resolve({
          status: "ready",
          view: {
            changed: {
              handle: "R1",
              snapshot: snapshot(current.recordRef),
              dependency: { kind: "record", recordRef: current.recordRef },
            },
            candidates: [{
              handle: "R2",
              snapshot: snapshot(`neighbor:${current.recordRef}`),
              dependency: {
                kind: "record",
                recordRef: `neighbor:${current.recordRef}`,
              },
            }],
            existingParents: [],
            maxSelectedChildren: 2,
          },
        });
    semantic.invokeOrganizerBatch = async (batchClaims) => {
      events.push(`batch:${batchClaims.map((current) => current.recordRef).join(",")}`);
      return JSON.stringify({ answers: batchClaims.map((_, index) => ({
        question: `Q${index + 1}`,
        proposal: { operation: "no_change" },
      })) });
    };

    const result = await runDurableHierarchySleep({
      work,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 3 },
      now: () => currentTime,
    });

    expect(scheduledRetryAt).toBe(retryAt);
    expect(events).toContain("batch:record:ready-a,record:ready-b");
    expect(events).toContain("close:record:waiting:unavailable");
    expect(result).toMatchObject({
      claimed: 3,
      paused: 1,
      completed: 2,
      deferred: 0,
      usage: { modelCalls: 1 },
      diagnostics: { modelBatches: 1, modelBatchItems: 2 },
    });
  });

  test("rejects a malformed Organizer grant retry timestamp", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.loadOrganizerView = async () => ({ status: "waiting", retryAt: 1_000 });

    const result = await runDurableHierarchySleep({
      work: workHarness([claim("record:waiting", "organization")], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
      now: () => 1_000,
    });

    expect(events).toContain("defer:unexpected_failure");
    expect(result).toMatchObject({
      paused: 0,
      deferred: 1,
      failures: { unexpected_failure: 1 },
    });
  });

  test("reschedules a later answer whose inspected topology changed earlier in the batch", async () => {
    const events: string[] = [];
    const claims = [
      claim("record:a", "organization"),
      claim("record:b", "organization"),
    ];
    const viewFor = (recordRef: string): DurableSleepOrganizerView => ({
      changed: {
        handle: "R1",
        snapshot: snapshot(recordRef),
        dependency: { kind: "record", recordRef },
      },
      candidates: [{
        handle: "R2",
        snapshot: snapshot("record:shared-neighbor"),
        dependency: { kind: "record", recordRef: "record:shared-neighbor" },
      }],
      existingParents: [],
      maxSelectedChildren: 2,
    });
    const semantic = semanticHarness(events);
    semantic.loadOrganizerView = (loadedClaim) => Promise.resolve({
      status: "ready",
      view: viewFor(loadedClaim.recordRef),
    });
    semantic.invokeOrganizerBatch = () => Promise.resolve(JSON.stringify({
      answers: ["Q1", "Q2"].map((question) => ({
        question,
        proposal: {
          operation: "create_parent",
          statement: "Shared evidence forms a useful parent.",
          childRecordRefs: ["R1", "R2"],
        },
      })),
    }));
    semantic.applyProposal = ({ claim: appliedClaim }) => {
      events.push(`apply:${appliedClaim.recordRef}`);
      return Promise.resolve({
        status: "applied",
        operation: "create_parent",
        replayed: false,
        usage: { modelCalls: 0, visitedRecords: 2, createdRecords: 1, traversalWork: 2 },
        changedRecord: {
          logicalObjectRef: "logical:parent",
          generation: 1,
          recordRef: "record:parent",
        },
      });
    };

    const result = await runDurableHierarchySleep({
      work: workHarness(claims, events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 },
    });

    expect(events.filter((event) => event.startsWith("apply:"))).toEqual([
      "apply:record:a",
    ]);
    expect(events).toContain("pause");
    expect(result).toMatchObject({
      completed: 1,
      paused: 1,
      diagnostics: { modelBatches: 1, modelBatchItems: 2, batchStaleRescheduled: 1 },
    });
  });

  test("isolates a still-invalid repaired answer from its valid batch sibling", async () => {
    const events: string[] = [];
    const claims = [
      claim("record:valid", "organization"),
      claim("record:invalid", "organization"),
    ];
    const semantic = semanticHarness(events);
    semantic.loadOrganizerView = (loadedClaim) => Promise.resolve({
      status: "ready",
      view: {
        changed: {
          handle: "R1",
          snapshot: snapshot(loadedClaim.recordRef),
          dependency: { kind: "record", recordRef: loadedClaim.recordRef },
        },
        candidates: [{
          handle: "R2",
          snapshot: snapshot(`neighbor:${loadedClaim.recordRef}`),
          dependency: {
            kind: "record",
            recordRef: `neighbor:${loadedClaim.recordRef}`,
          },
        }],
        existingParents: [],
        maxSelectedChildren: 2,
      },
    });
    let calls = 0;
    semantic.invokeOrganizerBatch = () => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? JSON.stringify({
            answers: [
              { question: "Q1", proposal: { operation: "no_change" } },
              {
                question: "Q2",
                proposal: {
                  operation: "create_parent",
                  statement: "Invalid hidden dependency.",
                  childRecordRefs: ["R1", "HIDDEN"],
                },
              },
            ],
          })
        : JSON.stringify({
            answers: [{
              question: "Q1",
              proposal: {
                operation: "create_parent",
                statement: "Still invalid.",
                childRecordRefs: ["R1", "HIDDEN"],
              },
            }],
          }));
    };
    semantic.applyProposal = ({ claim: appliedClaim }) => {
      events.push(`apply:${appliedClaim.recordRef}`);
      return Promise.resolve({
        status: "applied",
        operation: "no_change",
        replayed: false,
        usage: { modelCalls: 0, visitedRecords: 0, createdRecords: 0, traversalWork: 0 },
      });
    };

    const result = await runDurableHierarchySleep({
      work: workHarness(claims, events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 },
    });

    expect(calls).toBe(2);
    expect(events.filter((event) => event.startsWith("apply:"))).toEqual([
      "apply:record:valid",
    ]);
    expect(events).toContain("defer:invalid_model_output");
    expect(result).toMatchObject({
      completed: 1,
      deferred: 1,
      usage: { modelCalls: 2 },
      failures: { invalid_model_output: 1 },
    });
  });

  test("repairs parent conflicts before authority, projection, or model work", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.resolveParentConflict = () => {
      events.push("repair-parent-conflict");
      return Promise.resolve({
        status: "applied",
        retiredParents: 2,
        requeuedRecords: 3,
      });
    };
    const result = await runDurableHierarchySleep({
      work: workHarness([
        claim("record:conflicted", "authority_projection", 4, "parent_conflict"),
      ], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual([
      "claim:record:conflicted",
      "repair-parent-conflict",
    ]);
    expect(result).toMatchObject({
      claimed: 1,
      completed: 0,
      superseded: 1,
      operations: { resolve_parent: 1 },
      usage: { modelCalls: 0 },
    });
  });

  test("defers a bounded parent-conflict repair without entering the model", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.resolveParentConflict = () => Promise.resolve({
      status: "unavailable",
      failureCode: "candidate_unavailable",
      failureDetail: "parent_conflict_capacity_exceeded",
    });
    const result = await runDurableHierarchySleep({
      work: workHarness([
        claim("record:oversized", "organization", 2, "parent_conflict"),
      ], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual([
      "claim:record:oversized",
      "defer:candidate_unavailable",
    ]);
    expect(result.failureDetails).toEqual({
      parent_conflict_capacity_exceeded: 1,
    });
    expect(result.usage.modelCalls).toBe(0);
  });

  test("completes an obsolete parent conflict without semantic latency attribution", async () => {
    const events: string[] = [];
    const result = await runDurableHierarchySleep({
      work: workHarness([
        claim("record:obsolete-conflict", "authority_projection", 3, "parent_conflict"),
      ], events).port,
      semantic: semanticHarness(events),
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual([
      "claim:record:obsolete-conflict",
      "complete",
    ]);
    expect(result).toMatchObject({
      claimed: 1,
      completed: 1,
      operations: { no_change: 1 },
      usage: { modelCalls: 0 },
      completedItemLatencies: [],
    });
  });

  test("uses one bounded exponential quarantine recovery policy", () => {
    expect(durableSleepQuarantineRecoveryDelayMilliseconds(1)).toBe(
      DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.initialDelayMilliseconds,
    );
    expect(durableSleepQuarantineRecoveryDelayMilliseconds(2)).toBe(
      DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.initialDelayMilliseconds * 4,
    );
    expect(durableSleepQuarantineRecoveryDelayMilliseconds(20)).toBe(
      DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.maximumDelayMilliseconds,
    );
    expect(() => durableSleepQuarantineRecoveryDelayMilliseconds(0)).toThrow();
  });

  test("reports same-generation quarantine recovery without changing semantics", async () => {
    const events: string[] = [];
    const recovered = {
      ...claim("record:recovered"),
      recoveredFromQuarantine: true,
    };
    const result = await runDurableHierarchySleep({
      work: workHarness([recovered], events).port,
      semantic: semanticHarness(events),
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });
    expect(result).toMatchObject({ claimed: 1, recovered: 1, checkpointed: 1 });
  });

  test("orders authority before payload projection and partitions Memory provenance", async () => {
    const events: string[] = [];
    const work = workHarness([
      claim("record:changed"),
      claim("record:changed", "search_projection"),
      claim("record:changed", "organization"),
    ], events);
    let applied: Parameters<DurableSleepSemanticPort["applyProposal"]>[0] | undefined;
    const semantic = semanticHarness(events, mixedView(), (input) => {
      events.push("apply");
      applied = input;
      const result: DurableSleepApplyResult = {
        status: "applied",
        operation: "create_parent",
        replayed: false,
        usage: {
          modelCalls: 0,
          visitedRecords: 2,
          createdRecords: 1,
          traversalWork: 2,
        },
        changedRecord: {
          logicalObjectRef: "logical:parent",
          generation: 0,
          recordRef: "record:parent",
        },
      };
      return Promise.resolve(result);
    }, () => {
      events.push("model");
      return Promise.resolve(JSON.stringify({
        operation: "create_parent",
        statement: "The observation and authored preference support the decision.",
        childRecordRefs: ["C0", "M1"],
      }));
    });
    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 4 },
    });

    expect(events).toEqual([
      "claim:record:changed",
      "authority",
      "checkpoint:authority_projection",
      "claim:record:changed",
      "projection",
      "checkpoint:search_projection",
      "claim:record:changed",
      "view",
      "model",
      "apply",
      "complete",
    ]);
    expect(applied?.proposal).toEqual({
      operation: "create_parent",
      statement: "The observation and authored preference support the decision.",
      childRecordRefs: ["record:changed"],
      sourceDependencies: [{
        sourceKind: "memory/v1",
        logicalSourceRef: "memory:logical",
        observedRevision: "revision:2",
        observedContentFingerprint: "fingerprint:2",
        terminalAuthorityLeafHandle: "authority:room",
        authorityBearing: true,
      }],
    });
    expect(JSON.stringify(applied?.proposal)).not.toContain("memory-id-never-a-child");
    expect(work.enqueued).toEqual([]);
    expect(result).toMatchObject({
      claimed: 3,
      checkpointed: 2,
      completed: 1,
      deferred: 0,
      operations: { create_parent: 1 },
    });
  });

  test("rebuilds a publication-stale view without charging a failed attempt", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events, mixedView(), () =>
      Promise.resolve({
        status: "stale",
        failureDetail: "publication_child_parent_changed",
      }), () => Promise.resolve(JSON.stringify({
        operation: "create_parent",
        statement: "The changed evidence belongs with this preference.",
        childRecordRefs: ["C0", "M1"],
      })));
    const result = await runDurableHierarchySleep({
      work: workHarness([
        claim("record:changed", "organization"),
      ], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual([
      "claim:record:changed",
      "view",
      "pause",
    ]);
    expect(result).toMatchObject({
      claimed: 1,
      paused: 1,
      completed: 0,
      deferred: 0,
      failures: {},
      failureDetails: { publication_child_parent_changed: 1 },
      diagnostics: { batchStaleRescheduled: 1 },
    });
  });

  test("decomposes one completed generation across its three durable claims", async () => {
    const events: string[] = [];
    const timedClaim = (
      stage: DurableSleepClaim["stage"],
      claimedAtEpochMs: number,
    ): DurableSleepClaim => ({
      ...claim("record:timed", stage),
      timing: {
        admittedAtEpochMs: 0,
        firstClaimedAtEpochMs: 50,
        claimedAtEpochMs,
        claimStoreElapsedMs: 2,
      },
    });
    const work = workHarness([
      timedClaim("authority_projection", 50),
      timedClaim("search_projection", 150),
      timedClaim("organization", 250),
    ], events);
    work.port.checkpoint = () => Promise.resolve({
      status: "accepted",
      timing: { completedAtEpochMs: 0, mutationElapsedMs: 3 },
    });
    work.port.complete = () => Promise.resolve({
      status: "accepted",
      timing: { completedAtEpochMs: 520, mutationElapsedMs: 4 },
    });
    const moments = [
      100, 110, 200, 220, 300, 330, 400, 405, 455, 460, 465, 470, 480, 510,
    ];

    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic: semanticHarness(events),
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 3 },
      now: () => moments.shift() ?? 500,
    });

    const completedSample = result.completedItemLatencies[0]!;
    expect(completedSample.promptCodePoints).toBeGreaterThan(0);
    expect({ ...completedSample, promptCodePoints: 0 }).toEqual({
      lane: "same_room",
      queueElapsedMs: 50,
      claimStoreElapsedMs: 12,
      authorityElapsedMs: 10,
      searchProjectionElapsedMs: 20,
      sameRoomCandidateElapsedMs: 30,
      crossRoomCandidateElapsedMs: 0,
      selectedOpenElapsedMs: 0,
      promptConstructionElapsedMs: 5,
      promptInputCount: 2,
      promptCodePoints: 0,
      modelElapsedMs: 50,
      modelAttempts: 1,
      modelRepairs: 0,
      modelFailures: 0,
      proposalValidationElapsedMs: 10,
      publicationPlanningElapsedMs: 0,
      finalAuthorityElapsedMs: 0,
      productPublicationElapsedMs: 30,
      completionElapsedMs: 4,
      recursiveAdmissionElapsedMs: 0,
      endToEndElapsedMs: 520,
    });
  });

  test("keeps exact end-to-end timing after restart without inventing prior stage timings", async () => {
    const events: string[] = [];
    const restartedClaim: DurableSleepClaim = {
      ...claim("record:restarted", "organization"),
      timing: {
        admittedAtEpochMs: 100,
        firstClaimedAtEpochMs: 150,
        claimedAtEpochMs: 400,
        claimStoreElapsedMs: 3,
      },
    };
    const work = workHarness([restartedClaim], events);
    work.port.complete = () => Promise.resolve({
      status: "accepted",
      timing: { completedAtEpochMs: 600, mutationElapsedMs: 4 },
    });

    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic: semanticHarness(events),
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(result.completedItemLatencies).toMatchObject([{
      lane: "same_room",
      queueElapsedMs: 50,
      authorityElapsedMs: null,
      searchProjectionElapsedMs: null,
      endToEndElapsedMs: 500,
    }]);
  });

  test("round-trips the bridge-owned application plan token into publication", async () => {
    const events: string[] = [];
    let applied: Parameters<DurableSleepSemanticPort["applyProposal"]>[0] | undefined;
    const semantic = semanticHarness(
      events,
      { ...mixedView(), applicationPlanToken: "opaque-plan-v1" },
      (input) => {
        applied = input;
        return Promise.resolve({
          status: "applied",
          operation: "no_change",
          replayed: false,
          usage: {
            modelCalls: 0,
            visitedRecords: 0,
            createdRecords: 0,
            traversalWork: 0,
          },
        });
      },
      () => Promise.resolve(JSON.stringify({
        operation: "create_parent",
        statement: "The selected evidence supports one useful parent.",
        childRecordRefs: ["C0", "M1"],
      })),
    );

    await runDurableHierarchySleep({
      work: workHarness([claim("record:planned", "organization")], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(applied?.applicationPlanToken).toBe("opaque-plan-v1");
  });

  test("resumes from an organization checkpoint without repeating projections", async () => {
    const events: string[] = [];
    const work = workHarness([claim("record:resume", "organization")], events);
    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic: semanticHarness(events),
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });
    expect(events).toEqual(["claim:record:resume", "view", "complete"]);
    expect(result.completed).toBe(1);
    expect(result.operations.no_change).toBe(1);
  });

  test("completes an already-covered Record without invoking or publishing", async () => {
    const events: string[] = [];
    const view = mixedView();
    const coveredView: DurableSleepOrganizerView = {
      ...view,
      existingParents: [{
        handle: "P1",
        snapshot: {
          ...snapshot("record:parent"),
          childRecordRefs: [view.changed.snapshot.recordRef],
          structuralHeight: 1,
        },
        dependency: { kind: "record", recordRef: "record:parent" },
      }],
    };
    const semantic = semanticHarness(events, coveredView);
    semantic.invokeOrganizer = () => {
      throw new Error("covered evidence must not invoke the model");
    };
    semantic.applyProposal = () => {
      throw new Error("covered evidence must not enter publication");
    };
    const result = await runDurableHierarchySleep({
      work: workHarness([claim("record:changed", "organization")], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual(["claim:record:changed", "view", "complete"]);
    expect(result).toMatchObject({
      completed: 1,
      operations: { no_change: 1 },
      usage: { modelCalls: 0 },
      diagnostics: { deterministicNoChanges: 1, modelAttempts: 0 },
    });
  });

  test("does not invoke the model when filtering leaves no legal operation", async () => {
    const events: string[] = [];
    const emptyView: DurableSleepOrganizerView = {
      ...mixedView(),
      candidates: [],
      existingParents: [],
    };
    const semantic = semanticHarness(events, emptyView);
    semantic.invokeOrganizer = () => {
      throw new Error("an impossible view must not invoke the model");
    };
    semantic.applyProposal = () => {
      throw new Error("an impossible view must not publish");
    };

    const result = await runDurableHierarchySleep({
      work: workHarness([claim("record:isolated", "organization")], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual([
      "claim:record:isolated",
      "view",
      "complete",
    ]);
    expect(result).toMatchObject({
      completed: 1,
      operations: { no_change: 1 },
      diagnostics: { modelAttempts: 0, deterministicNoChanges: 1 },
    });
  });

  test("fails open to the model when an existing parent can accept the changed Record", async () => {
    const events: string[] = [];
    const parent = {
      handle: "P1",
      snapshot: snapshot("record:parent"),
      dependency: { kind: "record" as const, recordRef: "record:parent" },
    };
    const extendableView: DurableSleepOrganizerView = {
      ...mixedView(),
      candidates: [],
      existingParents: [parent],
    };
    const result = await runDurableHierarchySleep({
      work: workHarness([claim("record:extension", "organization")], events).port,
      semantic: semanticHarness(events, extendableView),
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual([
      "claim:record:extension",
      "view",
      "complete",
    ]);
    expect(result).toMatchObject({
      completed: 1,
      diagnostics: { modelAttempts: 1, deterministicNoChanges: 0 },
    });
  });

  test("accepts a deterministic publication contraction as no-change", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(
      events,
      mixedView(),
      () => Promise.resolve({
        status: "applied",
        operation: "no_change",
        replayed: false,
        usage: {
          modelCalls: 0,
          visitedRecords: 2,
          createdRecords: 0,
          traversalWork: 2,
        },
      }),
      () => Promise.resolve(JSON.stringify({
        operation: "create_parent",
        statement: "The evidence appears related but has an overlapping closure.",
        childRecordRefs: ["C0", "M1"],
      })),
    );
    const result = await runDurableHierarchySleep({
      work: workHarness([
        claim("record:overlap", "organization", 1, "scheduled_review"),
      ], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual(["claim:record:overlap", "view", "complete"]);
    expect(result).toMatchObject({
      completed: 1,
      deferred: 0,
      operations: { no_change: 1, create_parent: 0 },
      failures: {},
      diagnostics: { deterministicNoChanges: 1 },
    });
  });

  test("reports a post-model empty-audience contraction without retry", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(
      events,
      mixedView(),
      () => Promise.resolve({
        status: "applied",
        operation: "no_change",
        replayed: false,
        terminalOutcome: "no_effective_audience",
        usage: {
          modelCalls: 0,
          visitedRecords: 2,
          createdRecords: 0,
          traversalWork: 2,
        },
      }),
      () => Promise.resolve(JSON.stringify({
        operation: "create_parent",
        statement: "The selected evidence no longer has a shared audience.",
        childRecordRefs: ["C0", "M1"],
      })),
    );
    const result = await runDurableHierarchySleep({
      work: workHarness([claim("record:empty-audience", "organization")], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(result).toMatchObject({
      completed: 1,
      deferred: 0,
      quarantined: 0,
      operations: { no_change: 1 },
      terminalOutcomes: { no_effective_audience: 1 },
    });
  });

  test("completes obsolete organization work without invoking the model", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.loadOrganizerView = () => {
      events.push("view:obsolete");
      return Promise.resolve({
        status: "no_change",
        reason: "record_lifecycle_obsolete",
      });
    };
    semantic.invokeOrganizer = () => {
      throw new Error("obsolete work must not invoke the model");
    };
    semantic.applyProposal = () => {
      throw new Error("obsolete work must not publish");
    };

    const result = await runDurableHierarchySleep({
      work: workHarness([claim("record:obsolete", "organization")], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual(["claim:record:obsolete", "view:obsolete", "complete"]);
    expect(result).toMatchObject({
      completed: 1,
      deferred: 0,
      operations: { no_change: 1 },
      terminalOutcomes: { record_lifecycle_obsolete: 1 },
      diagnostics: { deterministicNoChanges: 1, modelAttempts: 0 },
    });
  });

  for (const reason of [
    "unsupported_authority_shape",
    "no_effective_audience",
    "protected_execution_unavailable",
  ] as const) {
    test(`completes terminal ${reason} without model, publication, or retry`, async () => {
      const events: string[] = [];
      const semantic = semanticHarness(events);
      semantic.loadOrganizerView = () => {
        events.push(`view:${reason}`);
        return Promise.resolve({ status: "no_change", reason });
      };
      semantic.invokeOrganizer = () => {
        throw new Error("terminal work must not invoke the model");
      };
      semantic.applyProposal = () => {
        throw new Error("terminal work must not publish");
      };

      const result = await runDurableHierarchySleep({
        work: workHarness([claim(`record:${reason}`, "organization")], events).port,
        semantic,
        budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
      });

      expect(events).toEqual([
        `claim:record:${reason}`,
        `view:${reason}`,
        "complete",
      ]);
      expect(result).toMatchObject({
        completed: 1,
        deferred: 0,
        quarantined: 0,
        terminalOutcomes: { [reason]: 1 },
        diagnostics: { modelAttempts: 0 },
      });
    });
  }

  test("retains only a fixed content-free detail for retry diagnostics", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.loadOrganizerView = () => {
      events.push("view:stale-projection");
      return Promise.resolve({
        status: "unavailable",
        failureCode: "projection_unavailable",
        failureDetail: "candidate_projection_stale",
      });
    };

    const result = await runDurableHierarchySleep({
      work: workHarness([claim("record:stale", "organization")], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual([
      "claim:record:stale",
      "view:stale-projection",
      "defer:projection_unavailable",
    ]);
    expect(result.failures).toEqual({ projection_unavailable: 1 });
    expect(result.failureDetails).toEqual({ candidate_projection_stale: 1 });
  });

  test("charges a provider attempt without poisoning the Record and continues cheap work", async () => {
    const events: string[] = [];
    const work = workHarness([
      claim("record:timeout", "organization"),
      claim("record:prepared", "authority_projection"),
    ], events);
    const maximumStages: DurableSleepClaim["stage"][] = [];
    const originalClaimNext = work.port.claimNext;
    work.port.claimNext = (signal, options) => {
      maximumStages.push(options?.maximumStage ?? "organization");
      return originalClaimNext(signal, options);
    };
    const moments = [0, 7, 7, 27, 27, 32];
    const semantic = semanticHarness(events, mixedView(), undefined, () =>
      Promise.reject(new DurableSleepModelLaneUnavailableError(90_000)));
    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic,
      budget: {
        hierarchy: { ...hierarchyBudget, maxModelCalls: 2 },
        maxWorkItems: 2,
      },
      now: () => moments.shift() ?? 32,
    });

    expect(maximumStages).toEqual(["organization", "search_projection"]);
    expect(events).toEqual([
      "claim:record:timeout",
      "view",
      "pause",
      "claim:record:prepared",
      "authority",
      "checkpoint:authority_projection",
    ]);
    expect(result).toMatchObject({
      completed: 0,
      checkpointed: 1,
      deferred: 0,
      paused: 1,
      modelRetryAfterMilliseconds: 90_000,
      usage: { modelCalls: 1 },
      diagnostics: {
        candidateElapsedMs: 7,
        modelElapsedMs: 20,
        authorityElapsedMs: 5,
        modelAttempts: 1,
        modelFailures: 1,
      },
      failures: {},
    });
  });

  test("completes an outcome-unknown provider attempt without replaying its generation", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events, mixedView(), undefined, () =>
      Promise.reject(new DurableSleepProviderOutcomeUnknownError()));

    const result = await runDurableHierarchySleep({
      work: workHarness([claim("record:outcome-unknown", "organization")], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual([
      "claim:record:outcome-unknown",
      "view",
      "complete",
    ]);
    expect(result).toMatchObject({
      completed: 1,
      deferred: 0,
      paused: 0,
      quarantined: 0,
      terminalOutcomes: { provider_outcome_unknown: 1 },
      usage: { modelCalls: 1 },
      diagnostics: { modelAttempts: 1, modelFailures: 1 },
    });
  });

  test("excludes model-bearing claims throughout an active lane cooldown", async () => {
    const events: string[] = [];
    const work = workHarness([
      claim("record:prepared", "authority_projection"),
    ], events);
    const maximumStages: DurableSleepClaim["stage"][] = [];
    const originalClaimNext = work.port.claimNext;
    work.port.claimNext = (signal, options) => {
      maximumStages.push(options?.maximumStage ?? "organization");
      return originalClaimNext(signal, options);
    };
    const semantic = semanticHarness(events);
    semantic.modelLaneReadiness = () => Promise.resolve({
      status: "cooldown",
      retryAfterMilliseconds: 45_000,
    });

    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 },
    });

    expect(maximumStages).toEqual(["search_projection", "search_projection"]);
    expect(events).toEqual([
      "claim:record:prepared",
      "authority",
      "checkpoint:authority_projection",
    ]);
    expect(result).toMatchObject({
      claimed: 1,
      checkpointed: 1,
      modelRetryAfterMilliseconds: 45_000,
      usage: { modelCalls: 0 },
    });
  });

  test("authority-only admission skips model readiness and fences a buggy higher-stage claim", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.modelLaneReadiness = () => {
      events.push("model-lane");
      return Promise.resolve({ status: "ready" });
    };
    semantic.resolveDependencyLoss = () => {
      events.push("dependency-loss");
      return Promise.resolve({ status: "not_applicable" });
    };
    semantic.invokeOrganizer = () => {
      events.push("model");
      return Promise.resolve('{"operation":"no_change"}');
    };
    semantic.applyProposal = () => {
      events.push("publication");
      return Promise.resolve({
        status: "unavailable",
        failureCode: "publication_unavailable",
      });
    };
    const requestedStages: DurableSleepClaim["stage"][] = [];
    const work = workHarness([
      claim("record:authority", "authority_projection"),
      claim("record:buggy", "search_projection"),
    ], events);
    const originalClaimNext = work.port.claimNext;
    work.port.claimNext = (signal, options) => {
      requestedStages.push(options?.maximumStage ?? "organization");
      return originalClaimNext(signal, options);
    };

    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 },
      stageAdmission: { maximumStage: "authority_projection" },
    });

    expect(requestedStages).toEqual([
      "authority_projection",
      "authority_projection",
    ]);
    expect(events).toEqual([
      "claim:record:authority",
      "authority",
      "checkpoint:authority_projection",
      "claim:record:buggy",
      "pause",
    ]);
    expect(result).toMatchObject({
      claimed: 2,
      checkpointed: 1,
      paused: 1,
      failures: {},
      usage: { modelCalls: 0 },
    });
  });

  test("honors each claimed cohort ceiling before any later semantic stage", async () => {
    const events: string[] = [];
    const claims = [
      {
        claim: claim("record:protected", "authority_projection"),
        executionRepresentation: "protected" as const,
        maximumStage: "authority_projection" as const,
      },
      {
        claim: claim("record:ordinary", "search_projection"),
        executionRepresentation: "ordinary" as const,
        maximumStage: "search_projection" as const,
      },
    ];
    const work = workHarness([], events).port;
    work.claimNext = () => {
      const next = claims.shift();
      return Promise.resolve(next === undefined
        ? { status: "empty" as const }
        : { status: "claimed" as const, ...next });
    };
    const semantic = semanticHarness(events);
    semantic.invokeOrganizer = () => {
      events.push("model");
      return Promise.resolve('{"operation":"no_change"}');
    };

    const result = await runDurableHierarchySleep({
      work,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 },
    });

    expect(events).toEqual([
      "authority",
      "checkpoint:authority_projection",
      "projection",
      "checkpoint:search_projection",
    ]);
    expect(events).not.toContain("model");
    expect(result).toMatchObject({ claimed: 2, checkpointed: 2 });
  });

  test("fails closed when a claimed protected cohort is already past authority", async () => {
    const events: string[] = [];
    const work = workHarness([], events).port;
    let returned = false;
    work.claimNext = () => {
      if (returned) return Promise.resolve({ status: "empty" as const });
      returned = true;
      return Promise.resolve({
        status: "claimed" as const,
        claim: claim("record:protected", "search_projection"),
        executionRepresentation: "protected" as const,
        maximumStage: "authority_projection" as const,
      });
    };

    const result = await runDurableHierarchySleep({
      work,
      semantic: semanticHarness(events),
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual(["pause"]);
    expect(result).toMatchObject({ claimed: 1, paused: 1, checkpointed: 0 });
  });

  test("does not run parent lifecycle repair for a protected authority cohort", async () => {
    const events: string[] = [];
    const work = workHarness([], events).port;
    let returned = false;
    work.claimNext = () => {
      if (returned) return Promise.resolve({ status: "empty" as const });
      returned = true;
      return Promise.resolve({
        status: "claimed" as const,
        claim: claim(
          "record:protected-conflict",
          "authority_projection",
          2,
          "parent_conflict",
        ),
        executionRepresentation: "protected" as const,
        maximumStage: "authority_projection" as const,
      });
    };
    const semantic = semanticHarness(events);
    semantic.resolveParentConflict = () => {
      events.push("repair-parent-conflict");
      return Promise.resolve({ status: "not_applicable" });
    };

    const result = await runDurableHierarchySleep({
      work,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(events).toEqual(["pause"]);
    expect(result).toMatchObject({ claimed: 1, paused: 1, completed: 0 });
  });

  test("completes a fixed-corpus scheduled review without creating more work", async () => {
    const events: string[] = [];
    const work = workHarness([
      claim("record:stable-parent", "organization", 1, "scheduled_review"),
    ], events);
    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic: semanticHarness(events),
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });
    expect(events).toEqual([
      "claim:record:stable-parent",
      "view",
      "complete",
    ]);
    expect(work.enqueued).toEqual([]);
    expect(result).toMatchObject({
      completed: 1,
      operations: { no_change: 1 },
    });
  });

  test("isolates one failed claim and continues with later due work", async () => {
    const events: string[] = [];
    const work = workHarness([
      claim("record:broken"),
      claim("record:healthy", "organization"),
    ], events);
    const semantic = semanticHarness(events);
    semantic.ensureAuthority = () => {
      events.push("authority:throw");
      throw new Error("provider body that must never be surfaced");
    };
    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 },
    });
    expect(events).toEqual([
      "claim:record:broken",
      "authority:throw",
      "defer:unexpected_failure",
      "claim:record:healthy",
      "view",
      "complete",
    ]);
    expect(result).toMatchObject({ claimed: 2, completed: 1, deferred: 1 });
    expect(result.failures).toEqual({ unexpected_failure: 1 });
    expect(result.failureDetails).toEqual({
      unexpected_authority_stage_failure: 1,
    });
    expect(JSON.stringify(result)).not.toContain("provider body");
  });

  test("attributes a thrown application to publication without exposing its error", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events, mixedView(), () => {
      throw new Error("sensitive publication detail");
    });
    const result = await runDurableHierarchySleep({
      work: workHarness([claim("record:publication", "organization")], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });

    expect(result.failures).toEqual({ unexpected_failure: 1 });
    expect(result.failureDetails).toEqual({
      unexpected_publication_stage_failure: 1,
    });
    expect(JSON.stringify(result)).not.toContain("sensitive publication detail");
  });

  test("never retries the same Record twice inside one external poll", async () => {
    const events: string[] = [];
    const repeated = claim("record:slow", "organization");
    const work = workHarness([repeated, repeated], events);
    let modelCalls = 0;
    const semantic = semanticHarness(events, mixedView(), undefined, () => {
      modelCalls += 1;
      return Promise.resolve("not-json");
    });

    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 4 },
    });

    expect(modelCalls).toBe(2);
    expect(events).toEqual([
      "claim:record:slow",
      "view",
      "defer:invalid_model_output",
      "claim:record:slow",
      "pause",
    ]);
    expect(result).toMatchObject({
      claimed: 2,
      deferred: 1,
      paused: 1,
      budgetExhausted: true,
    });
  });

  test("continues cheap projection work after the model-call reserve is exhausted", async () => {
    const events: string[] = [];
    const work = workHarness([
      claim("record:organized", "organization"),
      claim("record:prepared", "authority_projection"),
    ], events);
    const maximumStages: DurableSleepClaim["stage"][] = [];
    const originalClaimNext = work.port.claimNext;
    work.port.claimNext = (signal, options) => {
      maximumStages.push(options?.maximumStage ?? "organization");
      return originalClaimNext(signal, options);
    };

    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic: semanticHarness(events),
      budget: {
        hierarchy: { ...hierarchyBudget, maxModelCalls: 2 },
        maxWorkItems: 2,
      },
    });

    expect(maximumStages).toEqual(["organization", "search_projection"]);
    expect(events).toEqual([
      "claim:record:organized",
      "view",
      "complete",
      "claim:record:prepared",
      "authority",
      "checkpoint:authority_projection",
    ]);
    expect(result).toMatchObject({ claimed: 2, completed: 1, checkpointed: 1 });
  });

  test("pauses a claim without charging failure when remaining work budget is too small", async () => {
    const events: string[] = [];
    const work = workHarness([claim("record:large", "organization")], events);
    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic: semanticHarness(events),
      budget: {
        hierarchy: { ...hierarchyBudget, maxVisitedRecords: 2 },
        maxWorkItems: 2,
      },
    });
    expect(events).toEqual(["claim:record:large", "view", "pause"]);
    expect(result).toMatchObject({
      completed: 0,
      deferred: 0,
      paused: 1,
      budgetExhausted: true,
      failures: {},
    });
  });

  test("preserves recursive work when completion loses to a newer generation", async () => {
    const events: string[] = [];
    const work = workHarness([claim("record:changed", "organization")], events);
    work.port.complete = (): Promise<DurableSleepLeaseResult> => {
      events.push("complete:superseded");
      return Promise.resolve({ status: "superseded" });
    };
    const semantic = semanticHarness(events, mixedView(), () => Promise.resolve({
      status: "applied",
      operation: "create_parent",
      replayed: true,
      usage: {
        modelCalls: 0,
        visitedRecords: 2,
        createdRecords: 0,
        traversalWork: 2,
      },
      changedRecord: {
        logicalObjectRef: "logical:parent",
        generation: 0,
        recordRef: "record:parent",
      },
    }), () => Promise.resolve(JSON.stringify({
      operation: "create_parent",
      statement: "Supported parent.",
      childRecordRefs: ["C0", "M1"],
    })));
    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });
    expect(events).toEqual([
      "claim:record:changed",
      "view",
      "complete:superseded",
    ]);
    expect(work.enqueued).toEqual([]);
    expect(result).toMatchObject({ completed: 0, superseded: 1 });
  });

  test("pauses a waiting dependency-loss grant and permits a ready sibling", async () => {
    const currentTime = 1_000;
    const retryAt = 1_500;
    const events: string[] = [];
    const waiting = claim(
      "record:waiting-loss",
      "organization",
      4,
      "dependency_lost",
    );
    const ready = claim(
      "record:ready-loss",
      "organization",
      5,
      "dependency_lost",
    );
    const work = workHarness([waiting, ready], events);
    const pause = work.port.pause.bind(work.port);
    let pausedClaim: DurableSleepClaim | undefined;
    let scheduledRetryAt: number | undefined;
    work.port.pause = (input) => {
      pausedClaim = input.claim;
      scheduledRetryAt = input.nextAttemptAt;
      return pause(input);
    };
    const semantic = semanticHarness(events);
    semantic.openOrganizationAttempt = async (current) => ({
      async assertCurrent() {},
      async publish(publish) { return publish(); },
      async close(outcome) { events.push(`close:${current.recordRef}:${outcome}`); },
    });
    semantic.resolveDependencyLoss = ({ claim: current }) => {
      events.push(`dependency-loss:${current.recordRef}`);
      return Promise.resolve(current.recordRef === waiting.recordRef
        ? { status: "waiting", retryAt }
        : { status: "not_applicable" });
    };

    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 },
      now: () => currentTime,
    });

    expect(pausedClaim).toBe(waiting);
    expect(scheduledRetryAt).toBe(retryAt);
    expect(events).toContain("dependency-loss:record:ready-loss");
    expect(events).toContain("close:record:waiting-loss:unavailable");
    expect(result).toMatchObject({
      claimed: 2,
      paused: 1,
      completed: 1,
      deferred: 0,
      failures: {},
    });
  });

  test("rejects a malformed dependency-loss grant retry timestamp", async () => {
    const currentTime = 1_000;
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.resolveDependencyLoss = async () => ({
      status: "waiting",
      retryAt: currentTime,
    });

    const result = await runDurableHierarchySleep({
      work: workHarness([
        claim("record:waiting-loss", "organization", 4, "dependency_lost"),
      ], events).port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
      now: () => currentTime,
    });

    expect(events).not.toContain("pause");
    expect(events).toContain("defer:unexpected_failure");
    expect(result).toMatchObject({
      paused: 0,
      deferred: 1,
      failures: { unexpected_failure: 1 },
    });
  });

  for (const [outcome, operation, createdRecords] of [
    ["partial_replacement", "supersede_parent", 1],
    ["total_sunset", "dissolve_parent", 0],
  ] as const) {
    test(`short-circuits ordinary Organizer work for ${outcome}`, async () => {
      const events: string[] = [];
      const dirty = claim("record:dirty-parent", "organization", 7, "dependency_lost");
      const work = workHarness([dirty], events);
      const semantic = semanticHarness(events);
      let resolutionInput:
        | Parameters<DurableSleepSemanticPort["resolveDependencyLoss"]>[0]
        | undefined;
      semantic.resolveDependencyLoss = (input) => {
        events.push("dependency-loss");
        resolutionInput = input;
        return Promise.resolve({
          status: "applied",
          outcome,
          replayed: false,
          usage: {
            modelCalls: outcome === "partial_replacement" ? 1 : 0,
            visitedRecords: 3,
            createdRecords,
            traversalWork: 3,
          },
          changedRecord: {
            logicalObjectRef: "record:replacement",
            generation: 1,
            recordRef: "record:replacement",
          },
        });
      };
      semantic.loadOrganizerView = () => {
        throw new Error("stale parent must not enter the ordinary Organizer view");
      };
      semantic.invokeOrganizer = () => {
        throw new Error("stale parent must not enter the ordinary Organizer model");
      };

      const result = await runDurableHierarchySleep({
        work: work.port,
        semantic,
        budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
      });
      expect(events).toEqual([
        "claim:record:dirty-parent",
        "dependency-loss",
        "complete",
      ]);
      expect(resolutionInput).toMatchObject({
        claim: dirty,
        idempotencyKey: "sleep-dependency-loss:logical:record:dirty-parent:7",
        budget: hierarchyBudget,
      });
      expect(work.enqueued).toEqual([]);
      expect(result).toMatchObject({
        completed: 1,
        operations: { [operation]: 1 },
        usage: { createdRecords },
      });
    });
  }

  test("completes a no-longer-applicable dependency loss without stale prompting", async () => {
    const events: string[] = [];
    const work = workHarness([
      claim("record:already-current", "organization", 2, "dependency_lost"),
    ], events);
    const semantic = semanticHarness(events);
    semantic.resolveDependencyLoss = () => {
      events.push("dependency-loss:not-applicable");
      return Promise.resolve({ status: "not_applicable" });
    };
    semantic.loadOrganizerView = () => {
      throw new Error("not-applicable dependency loss must not use ordinary Organizer");
    };
    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });
    expect(events).toEqual([
      "claim:record:already-current",
      "dependency-loss:not-applicable",
      "complete",
    ]);
    expect(result).toMatchObject({
      completed: 1,
      operations: { no_change: 1 },
      usage: {
        modelCalls: 0,
        visitedRecords: 0,
        createdRecords: 0,
        traversalWork: 0,
      },
    });
  });

  test("defers typed dependency-loss unavailability without ordinary fallback", async () => {
    const events: string[] = [];
    const work = workHarness([
      claim("record:unavailable", "organization", 3, "dependency_lost"),
    ], events);
    const semantic = semanticHarness(events);
    semantic.resolveDependencyLoss = () => {
      events.push("dependency-loss:unavailable");
      return Promise.resolve({
        status: "unavailable",
        failureCode: "record_unavailable",
      });
    };
    semantic.loadOrganizerView = () => {
      throw new Error("unavailable dependency loss must not use ordinary Organizer");
    };
    const result = await runDurableHierarchySleep({
      work: work.port,
      semantic,
      budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 },
    });
    expect(events).toEqual([
      "claim:record:unavailable",
      "dependency-loss:unavailable",
      "defer:record_unavailable",
    ]);
    expect(result).toMatchObject({
      completed: 0,
      deferred: 1,
      failures: { record_unavailable: 1 },
    });
  });
});

describe("organization access lifetime", () => {
  test("admission precedes confidential views, publication is fenced and observation cleanup is isolated", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.openOrganizationAttempt = async () => {
      events.push("open");
      return {
        async assertCurrent() { events.push("current"); },
        async publish(publish) { events.push("publish-gate"); return publish(); },
        async close(outcome) { events.push(`close:${outcome}`); throw new Error("observation_failed"); },
      };
    };
    const result = await runDurableHierarchySleep({ work: workHarness([claim("a", "organization")], events).port,
      semantic, budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 } });
    expect(events.indexOf("open")).toBeLessThan(events.indexOf("view"));
    expect(events).toContain("publish-gate");
    expect(events.filter(event => event.startsWith("close:"))).toEqual(["close:completed"]);
    expect(result.completed).toBe(1);
  });

  test("denial never opens a view or invokes a provider", async () => {
    const { DurableSleepOrganizationUnavailableError } = await import("../../src/sleep/durable-executor");
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.openOrganizationAttempt = async () => { throw new DurableSleepOrganizationUnavailableError(); };
    const result = await runDurableHierarchySleep({ work: workHarness([claim("a", "organization")], events).port,
      semantic, budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 } });
    expect(events).not.toContain("view");
    expect(events).toContain("defer:authority_unavailable");
    expect(result.usage.modelCalls).toBe(0);
  });

  test("an unavailable batch sibling closes independently and never enters the surviving prompt", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    let opened = 0;
    semantic.openOrganizationAttempt = async current => {
      opened++;
      return {
        async assertCurrent() { if (current.recordRef === "a" && opened === 2) throw new Error("revoked"); },
        async publish(publish) { return publish(); },
        async close(outcome) { events.push(`close:${current.recordRef}:${outcome}`); },
      };
    };
    semantic.invokeOrganizerBatch = async claims => {
      expect(claims.map(item => item.recordRef)).toEqual(["b"]);
      return JSON.stringify({ answers: [{ question: "Q1", proposal: { operation: "no_change" } }] });
    };
    const result = await runDurableHierarchySleep({ work: workHarness([claim("a", "organization"), claim("b", "organization")], events).port,
      semantic, budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 } });
    expect(result.completed).toBe(1);
    expect(events.filter(event => event.startsWith("close:"))).toEqual(["close:a:unavailable", "close:b:completed"]);
  });

  test("queued lifetime closes even when discovery throws before batch flush", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.openOrganizationAttempt = async () => ({ async assertCurrent() {}, async publish(publish) { return publish(); }, async close(outcome) { events.push(`close:${outcome}`); } });
    semantic.invokeOrganizerBatch = async () => "unreachable";
    const work = workHarness([claim("a", "organization")], events).port;
    const next = work.claimNext;
    let calls = 0;
    work.claimNext = (...args) => { if (calls++ > 0) throw new Error("discovery_failed"); return next(...args); };
    expect(runDurableHierarchySleep({ work, semantic, budget: { hierarchy: hierarchyBudget, maxWorkItems: 2 } })).rejects.toThrow("discovery_failed");
    expect(events).toContain("close:failed");
  });

  test("dependency loss receives the same pre-read lifetime and canonical publication fence", async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    semantic.openOrganizationAttempt = async () => ({
      async assertCurrent() { events.push("current"); },
      async publish(publish) { events.push("dependency-publish"); return publish(); },
      async close(outcome) { events.push(`close:${outcome}`); },
    });
    semantic.resolveDependencyLoss = async input => {
      expect(events).toContain("current");
      await input.publication!.publish(async () => {});
      return { status: "not_applicable" };
    };
    await runDurableHierarchySleep({ work: workHarness([claim("a", "organization", 1, "dependency_lost")], events).port,
      semantic, budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 } });
    expect(events).toContain("dependency-publish");
    expect(events).toContain("close:completed");
  });

  for (const cancelled of [false, true]) test(`failed model closes its lifetime (${cancelled ? "cancelled" : "failed"})`, async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const semantic = semanticHarness(events, mixedView(), undefined, async () => {
      if (cancelled) controller.abort();
      throw new Error("provider_failed");
    });
    semantic.openOrganizationAttempt = async () => ({ async assertCurrent() {}, async publish(publish) { return publish(); }, async close(outcome) { events.push(`close:${outcome}`); } });
    await runDurableHierarchySleep({ work: workHarness([claim("a", "organization")], events).port,
      semantic, signal: controller.signal, budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 } });
    expect(events.filter(event => event.startsWith("close:"))).toEqual([`close:${cancelled ? "cancelled" : "failed"}`]);
  });
});

test("only a committed mutation survives a lost completion lease", async () => {
  for (const mode of ["mutation", "model_no_change", "deterministic_no_change"] as const) {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    if (mode === "deterministic_no_change") semantic.loadOrganizerView = async () => ({ status: "no_change", reason: "record_lifecycle_obsolete" });
    if (mode === "mutation") {
      semantic.invokeOrganizer = async () => JSON.stringify({ operation: "create_parent", statement: "Grounded decision", childRecordRefs: ["C0", "M1"] });
      semantic.applyProposal = async () => ({ status: "applied", operation: "create_parent", replayed: false,
        usage: { modelCalls: 0, visitedRecords: 2, createdRecords: 1, traversalWork: 2 },
        changedRecord: { logicalObjectRef: "parent", generation: 0, recordRef: "parent" } });
    }
    semantic.openOrganizationAttempt = async () => ({
      async assertCurrent() {}, async publish(publish) { return publish(); },
      async close(outcome) { events.push(`close:${outcome}`); },
    });
    const work = workHarness([claim("a", "organization")], events).port;
    work.complete = async () => ({ status: "lease_lost" });
    const result = await runDurableHierarchySleep({ work, semantic, budget: { hierarchy: hierarchyBudget, maxWorkItems: 1 } });
    expect(result.completed).toBe(0);
    expect(result.leaseLost).toBe(1);
    expect(events).toContain(`close:${mode === "mutation" ? "completed" : "unavailable"}`);
  }
});

for (const mode of ["revoked_invalid", "revoked_only_repair", "revoked_valid", "repair_provider_failure"] as const) {
  test(`batch repair preserves independent valid results: ${mode}`, async () => {
    const events: string[] = [];
    const semantic = semanticHarness(events);
    let firstCallFinished = false;
    const assertCurrent = async (id: string) => {
      if (firstCallFinished && id === "a" && mode !== "repair_provider_failure") {
        const { DurableSleepOrganizationUnavailableError } = await import("../../src/sleep/durable-executor");
        throw new DurableSleepOrganizationUnavailableError();
      }
    };
    semantic.openOrganizationAttempt = async current => ({
      assertCurrent: () => assertCurrent(current.recordRef),
      async publish(publish) { await assertCurrent(current.recordRef); return publish(); },
      async close(outcome) { events.push(`close:${current.recordRef}:${outcome}`); },
    });
    const applied: string[] = [];
    semantic.applyProposal = async ({ claim: current }) => {
      applied.push(current.recordRef);
      return { status: "applied", operation: "no_change", replayed: false,
        usage: { modelCalls: 0, visitedRecords: 0, createdRecords: 0, traversalWork: 0 } };
    };
    const calls: string[][] = [];
    semantic.invokeOrganizerBatch = async claims => {
      calls.push(claims.map(current => current.recordRef));
      if (!firstCallFinished) {
        firstCallFinished = true;
        return JSON.stringify({ answers: claims.map((current, index) => ({ question: `Q${index + 1}`,
          proposal: { operation: ((mode === "revoked_invalid" || mode === "revoked_only_repair") ? current.recordRef === "b" : current.recordRef === "a") ? "no_change" : "invalid" } })) });
      }
      if (mode === "repair_provider_failure") throw new Error("provider failed");
      return JSON.stringify({ answers: claims.map((_, index) => ({ question: `Q${index + 1}`, proposal: { operation: "no_change" } })) });
    };
    const ids = mode === "revoked_invalid" ? ["a", "b", "c"] : ["a", "b"];
    const result = await runDurableHierarchySleep({ work: workHarness(ids.map(id => claim(id, "organization")), events).port,
      semantic, budget: { hierarchy: hierarchyBudget, maxWorkItems: ids.length } });
    expect(calls).toEqual(mode === "revoked_only_repair" ? [ids] : [ids, mode === "revoked_invalid" ? ["c"] : ["b"]]);
    expect(applied).toEqual(mode === "revoked_invalid" ? ["b", "c"] : mode === "revoked_valid" || mode === "revoked_only_repair" ? ["b"] : ["a"]);
    expect(result.completed).toBe(mode === "revoked_invalid" ? 2 : 1);
    expect(result.deferred).toBe(1);
    expect(events.filter(event => event.startsWith("close:"))).toHaveLength(ids.length);
    expect(events).toContain(mode === "repair_provider_failure" ? "close:b:failed" : "close:a:unavailable");
  });
}
