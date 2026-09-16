import { describe, expect, test } from "bun:test";

import {
  createShadowTransitionCoordinator,
  type ShadowTransitionCandidate,
  type ShadowTransitionTask,
} from "../../src/transition/shadow-transition-coordinator.ts";

type Item = Readonly<{ id: string; complete: boolean }>;

function candidate(
  id: string,
  overrides: Partial<ShadowTransitionCandidate<Item>> = {},
): ShadowTransitionCandidate<Item> {
  return Object.freeze({
    family: "memory",
    operation: "update",
    productRevision: 3,
    audienceFingerprint: new Uint8Array(32).fill(0x33),
    audienceMappingInvalidated: false,
    opaque: Object.freeze({ id, complete: true }),
    ...overrides,
  });
}

function scheduler() {
  const tasks: ShadowTransitionTask[] = [];
  return {
    tasks,
    schedule(task: ShadowTransitionTask) {
      tasks.push(task);
    },
  };
}

describe("live Shadow shadow transition coordinator", () => {
  test("plaintext-only returns ordinary behavior with zero shadow callback", async () => {
    const scheduled = scheduler();
    let selectCalls = 0;
    let verifyCalls = 0;
    let publishCalls = 0;
    let observeCalls = 0;
    const coordinator = createShadowTransitionCoordinator({
      policy: { mode: "plaintext_only" },
      schedule: scheduled.schedule,
      observe: () => {
        observeCalls += 1;
      },
    });

    const result = await coordinator.runOrdinaryWrite({
      family: "memory",
      operation: "update",
      ordinary: () => Promise.resolve({ id: "ordinary", complete: true }),
      selectCandidate: () => {
        selectCalls += 1;
        return candidate("ordinary");
      },
      verifyCurrent: () => {
        verifyCalls += 1;
        return Promise.resolve("current");
      },
      publishExisting: () => {
        publishCalls += 1;
        return Promise.resolve("verified");
      },
    });

    expect(result).toEqual({ id: "ordinary", complete: true });
    expect(scheduled.tasks).toHaveLength(0);
    expect({ selectCalls, verifyCalls, publishCalls, observeCalls }).toEqual({
      selectCalls: 0,
      verifyCalls: 0,
      publishCalls: 0,
      observeCalls: 0,
    });
  });

  test("returns the ordinary write before exact verification and publication", async () => {
    const scheduled = scheduler();
    const events: string[] = [];
    const observations: unknown[] = [];
    const coordinator = createShadowTransitionCoordinator({
      policy: { mode: "shadow_encryption" },
      schedule: scheduled.schedule,
      observe: (observation) => {
        events.push("observed");
        observations.push(observation);
      },
    });
    const result = await coordinator.runOrdinaryWrite({
      family: "memory",
      operation: "update",
      ordinary: () => {
        events.push("ordinary");
        return Promise.resolve({ id: "current", complete: true });
      },
      selectCandidate: (ordinary) => candidate(ordinary.id),
      verifyCurrent: (selected) => {
        events.push("verified-current");
        expect(selected.productRevision).toBe(3);
        expect(selected.audienceFingerprint).toEqual(
          new Uint8Array(32).fill(0x33),
        );
        return Promise.resolve("current");
      },
      publishExisting: () => {
        events.push("published");
        return Promise.resolve("verified");
      },
    });
    events.push("ordinary-returned");

    expect(result.id).toBe("current");
    expect(events).toEqual(["ordinary", "ordinary-returned"]);
    expect(scheduled.tasks).toHaveLength(1);
    await scheduled.tasks[0]!();
    expect(events).toEqual([
      "ordinary",
      "ordinary-returned",
      "verified-current",
      "published",
      "observed",
    ]);
    expect(observations).toEqual([{
      family: "memory",
      trigger: "ordinary_write",
      operation: "update",
      outcome: "verified",
    }]);
  });

  test("invalidates stale mappings and never publishes stale product or audience", async () => {
    const scheduled = scheduler();
    const observations: unknown[] = [];
    let publishCalls = 0;
    let invalidationCalls = 0;
    const coordinator = createShadowTransitionCoordinator({
      policy: { mode: "shadow_encryption" },
      schedule: scheduled.schedule,
      observe: (value) => observations.push(value),
    });
    await coordinator.runOrdinaryWrite({
      family: "memory",
      operation: "update",
      ordinary: () => Promise.resolve({ id: "stale", complete: true }),
      selectCandidate: () => candidate("stale"),
      verifyCurrent: () => Promise.resolve("stale_product"),
      publishExisting: () => {
        publishCalls += 1;
        return Promise.resolve("verified");
      },
      invalidateMapping: (selected) => {
        invalidationCalls += 1;
        expect(selected.opaque.id).toBe("stale");
        return Promise.resolve("invalidated");
      },
    });
    await scheduled.tasks[0]!();
    expect(publishCalls).toBe(0);
    expect(invalidationCalls).toBe(1);
    expect(observations).toEqual([{
      family: "memory",
      trigger: "ordinary_write",
      operation: "update",
      outcome: "stale_product",
    }]);
  });

  test("repairs only complete objects already returned within the ordinary bound", async () => {
    const scheduled = scheduler();
    const opened = [
      Object.freeze({ id: "a", complete: true }),
      Object.freeze({ id: "b", complete: false }),
      Object.freeze({ id: "c", complete: true }),
    ];
    const published: string[] = [];
    let ordinaryReads = 0;
    const coordinator = createShadowTransitionCoordinator({
      policy: { mode: "shadow_encryption" },
      schedule: scheduled.schedule,
      observe: () => undefined,
    });
    const result = await coordinator.runOrdinaryReadRepair({
      family: "memory",
      ordinaryBound: 3,
      ordinary: () => {
        ordinaryReads += 1;
        return Promise.resolve(opened);
      },
      selectCompleteCandidates: (returned) => returned
        .filter((item) => item.complete)
        .map((item) => candidate(item.id, {
          operation: "read_repair",
          opaque: item,
        })),
      verifyCurrent: () => Promise.resolve("current"),
      publishExisting: (selected) => {
        published.push(selected.opaque.id);
        return Promise.resolve("verified");
      },
    });
    expect(result).toBe(opened);
    expect(ordinaryReads).toBe(1);
    expect(published).toEqual([]);
    await scheduled.tasks[0]!();
    expect(published).toEqual(["a", "c"]);
    expect(ordinaryReads).toBe(1);
  });

  test("keeps unsupported operations visible and reuses reconciliation once", async () => {
    const scheduled = scheduler();
    const observations: unknown[] = [];
    let publishCalls = 0;
    let reconcileCalls = 0;
    const coordinator = createShadowTransitionCoordinator({
      policy: { mode: "shadow_encryption" },
      schedule: scheduled.schedule,
      observe: (value) => observations.push(value),
    });
    await coordinator.runOrdinaryWrite({
      family: "artifact",
      operation: "unsupported_operation",
      ordinary: () => Promise.resolve({ id: "agent-artifact", complete: true }),
      selectCandidate: () => candidate("agent-artifact", {
        family: "artifact",
        operation: "unsupported_operation",
      }),
      verifyCurrent: () => Promise.resolve("current"),
      publishExisting: () => {
        publishCalls += 1;
        return Promise.resolve("unsupported_operation");
      },
    });
    await coordinator.runOrdinaryWrite({
      family: "memory",
      operation: "update",
      ordinary: () => Promise.resolve({ id: "response-lost", complete: true }),
      selectCandidate: () => candidate("response-lost"),
      verifyCurrent: () => Promise.resolve("current"),
      publishExisting: () => {
        publishCalls += 1;
        return Promise.resolve("response_lost_reconciling");
      },
      reconcileExisting: () => {
        reconcileCalls += 1;
        return Promise.resolve();
      },
    });
    await scheduled.tasks[0]!();
    await scheduled.tasks[1]!();
    expect(publishCalls).toBe(2);
    expect(reconcileCalls).toBe(1);
    expect(observations.map((value) =>
      (value as { outcome: string }).outcome
    )).toEqual(["unsupported_operation", "response_lost_reconciling"]);
  });

  test("requires authoritative invalidation before an access-change shadow", async () => {
    const scheduled = scheduler();
    const outcomes: string[] = [];
    let verifyCalls = 0;
    let publishCalls = 0;
    const coordinator = createShadowTransitionCoordinator({
      policy: { mode: "shadow_encryption" },
      schedule: scheduled.schedule,
      observe: (value) => outcomes.push(value.outcome),
    });
    await coordinator.runOrdinaryWrite({
      family: "memory",
      operation: "access_change",
      ordinary: () => Promise.resolve({ id: "access", complete: true }),
      selectCandidate: () => candidate("access", {
        operation: "access_change",
        audienceMappingInvalidated: false,
      }),
      verifyCurrent: () => {
        verifyCalls += 1;
        return Promise.resolve("current");
      },
      publishExisting: () => {
        publishCalls += 1;
        return Promise.resolve("verified");
      },
    });
    await scheduled.tasks[0]!();
    expect({ verifyCalls, publishCalls, outcomes }).toEqual({
      verifyCalls: 0,
      publishCalls: 0,
      outcomes: ["integrity_failure"],
    });
  });

  test("does not let selector or scheduler failure replace the ordinary result", async () => {
    const observations: unknown[] = [];
    const coordinator = createShadowTransitionCoordinator({
      policy: { mode: "shadow_encryption" },
      schedule: () => {
        throw new Error("queue unavailable");
      },
      observe: (value) => observations.push(value),
    });

    expect(coordinator.runOrdinaryWrite({
      family: "memory",
      operation: "update",
      ordinary: () => Promise.resolve("ordinary-result"),
      selectCandidate: () => {
        throw new Error("must remain deferred");
      },
      verifyCurrent: () => Promise.resolve("current"),
      publishExisting: () => Promise.resolve("verified"),
    })).resolves.toBe("ordinary-result");
    expect(observations).toEqual([{
      family: "memory",
      trigger: "ordinary_write",
      operation: "update",
      outcome: "publication_failure",
    }]);
  });

  test("counts a read-repair scheduler failure without selecting candidates", async () => {
    const observations: unknown[] = [];
    let selectCalls = 0;
    const coordinator = createShadowTransitionCoordinator({
      policy: { mode: "shadow_encryption" },
      schedule: () => {
        throw new Error("queue unavailable");
      },
      observe: (value) => observations.push(value),
    });

    const result = await coordinator.runOrdinaryReadRepair({
      family: "artifact",
      ordinaryBound: 1,
      ordinary: () => Promise.resolve("ordinary-result"),
      selectCompleteCandidates: () => {
        selectCalls += 1;
        return [];
      },
      verifyCurrent: () => Promise.resolve("current"),
      publishExisting: () => Promise.resolve("verified"),
    });
    expect(result).toBe("ordinary-result");
    expect(selectCalls).toBe(0);
    expect(observations).toEqual([{
      family: "artifact",
      trigger: "read_repair",
      operation: "read_repair",
      outcome: "publication_failure",
    }]);
  });

  test("rejects a substituted candidate shape before repository callbacks", async () => {
    const scheduled = scheduler();
    const outcomes: string[] = [];
    let verifyCalls = 0;
    const coordinator = createShadowTransitionCoordinator({
      policy: { mode: "shadow_encryption" },
      schedule: scheduled.schedule,
      observe: (value) => outcomes.push(value.outcome),
    });
    await coordinator.runOrdinaryWrite({
      family: "memory",
      operation: "update",
      ordinary: () => Promise.resolve("ordinary-result"),
      selectCandidate: () => ({
        ...candidate("substituted"),
        family: "artifact",
        extraAuthority: "not permitted",
      } as ShadowTransitionCandidate<Item>),
      verifyCurrent: () => {
        verifyCalls += 1;
        return Promise.resolve("current");
      },
      publishExisting: () => Promise.resolve("verified"),
    });
    await scheduled.tasks[0]!();
    expect({ verifyCalls, outcomes }).toEqual({
      verifyCalls: 0,
      outcomes: ["integrity_failure"],
    });
  });

  test("invalidates a mapping when publication detects a current-head race", async () => {
    const scheduled = scheduler();
    const outcomes: string[] = [];
    let invalidationCalls = 0;
    const coordinator = createShadowTransitionCoordinator({
      policy: { mode: "shadow_encryption" },
      schedule: scheduled.schedule,
      observe: (value) => outcomes.push(value.outcome),
    });
    await coordinator.runOrdinaryWrite({
      family: "memory",
      operation: "update",
      ordinary: () => Promise.resolve("ordinary-result"),
      selectCandidate: () => candidate("raced"),
      verifyCurrent: () => Promise.resolve("current"),
      publishExisting: () => Promise.resolve("stale_authority"),
      invalidateMapping: () => {
        invalidationCalls += 1;
        return Promise.resolve("invalidated");
      },
    });
    await scheduled.tasks[0]!();
    expect({ invalidationCalls, outcomes }).toEqual({
      invalidationCalls: 1,
      outcomes: ["stale_authority"],
    });
  });
});
