import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type {
  StenographerDataOperationPort,
  StenographerOperationOutcome,
} from "@nautilo/lattice-bridge/server";
import {
  createOrdinaryStenographerIntentAdapter,
  StenographerWorker,
  type CompactionClaim,
  type ExtractionClaim,
  type StenographerCandidatePort,
  type StenographerWorkerDeps,
} from "@nautilo/runtime";

import { BackgroundAttemptCancelledError } from "../../src/background-processing/attempt";

const NOW = new Date("2026-07-27T10:00:00.000Z");
const unavailable = (): StenographerOperationOutcome => ({
  status: "unavailable",
  processed: false,
});
const completed = (): StenographerOperationOutcome => ({
  status: "completed",
  processed: true,
});

function claim(
  trigger: ExtractionClaim["plan"]["trigger"] = "silence",
): ExtractionClaim {
  const source = {
    id: 1,
    createdAt: NOW,
    role: "user" as const,
    text: "We decided to ship.",
    fingerprint: null,
  };
  return {
    batchId: "batch-1",
    roomId: "room-1",
    ownerId: "owner-1",
    leaseToken: "lease-1",
    attemptCount: 1,
    lane: "live",
    plan: {
      fromMessageIdExclusive: 0,
      throughMessageIdInclusive: 1,
      trigger,
      sourceRows: trigger === "skip_excluded"
        ? []
        : [{ ...source, conversationalBoundary: true }],
      coveredMessageIds: [1],
      conversationalMessageCount: trigger === "skip_excluded" ? 0 : 1,
      newestEligibleSourceAt: trigger === "skip_excluded" ? null : NOW,
    },
    sourceRows: trigger === "skip_excluded"
      ? []
      : [{ ...source, displayLabel: "Alice (@alice)", editRevision: 0 }],
    priorContextRows: [],
    latestRollup: null,
    visibleEvents: [],
    namespaceId: "namespace-1",
  };
}

function silentLogger(): NonNullable<StenographerWorkerDeps["logger"]> {
  return { info() {}, warn() {}, error() {} };
}

async function letPollFinish(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function candidates(input: Readonly<{
  live?: readonly string[];
  historical?: readonly string[];
  compaction?: readonly string[];
}> = {}): StenographerCandidatePort {
  return {
    extraction: async ({ lane }) => lane === "live"
      ? input.live ?? []
      : input.historical ?? [],
    initializeHistorical: async () => {},
    compaction: async () => input.compaction ?? [],
  };
}

function operations(
  overrides: Partial<StenographerDataOperationPort> = {},
): StenographerDataOperationPort {
  return {
    runExtraction: async () => unavailable(),
    runCompaction: async () => unavailable(),
    runNextRebuild: async () => unavailable(),
    runLegacyConversion: async () => unavailable(),
    ...overrides,
  };
}

describe("StenographerWorker intent scheduling", () => {
  test("worker source contains no body claim, model or publication owner", async () => {
    const source = await readFile(
      new URL("../../src/stenographer/worker.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "ExtractionClaim",
      "CompactionClaim",
      "tryClaimRoom",
      "tryClaimCompactionRoom",
      "claimJournalRebuildExtraction",
      "runExtractionModel",
      "runCompactionModel",
      "publishCompaction",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("maintenance denial invokes no intent operation", async () => {
    let calls = 0;
    const worker = new StenographerWorker({
      maintenanceGate: { isAcceptingWork: async () => false },
      resolveModelId: () => "model",
      operations: operations({
        runNextRebuild: async () => {
          calls += 1;
          return unavailable();
        },
      }),
      candidates: candidates(),
      logger: silentLogger(),
    }, { scanIntervalMs: 60_000 });
    worker.start();
    await letPollFinish();
    await worker.stop();
    expect(calls).toBe(0);
  });

  test("ordinary scheduling runs without a device access hook", async () => {
    const events: string[] = [];
    const worker = new StenographerWorker({
      maintenanceGate: { isAcceptingWork: async () => true },
      resolveModelId: () => "model",
      candidates: candidates({ live: ["plain-room"] }),
      operations: operations({
        runNextRebuild: async () => {
          events.push("rebuild");
          return unavailable();
        },
        runExtraction: async ({ roomId, attempt }) => {
          events.push(`extract:${roomId}`);
          await attempt.assertCurrent();
          return completed();
        },
      }),
      logger: silentLogger(),
    }, { scanIntervalMs: 60_000 });

    worker.start();
    await letPollFinish();
    await worker.stop();

    expect(events).toEqual(["rebuild", "extract:plain-room"]);
  });

  test("passes only exact coordinates after access opens", async () => {
    const events: string[] = [];
    const worker = new StenographerWorker({
      maintenanceGate: { isAcceptingWork: async () => true },
      resolveModelId: () => "model-1",
      openAccess: async () => {
        events.push("open");
        return { assertCurrent: async () => {}, close: async () => {
          events.push("close");
        } };
      },
      candidates: candidates({ live: ["room-1"] }),
      operations: operations({
        runNextRebuild: async () => unavailable(),
        runExtraction: async (input) => {
          events.push("operation");
          expect(input).toMatchObject({
            roomId: "room-1",
            lane: "live",
            modelId: "model-1",
            now: NOW,
          });
          expect(Object.keys(input).sort()).toEqual([
            "attempt",
            "lane",
            "modelId",
            "now",
            "roomId",
          ]);
          return completed();
        },
      }),
      now: () => NOW,
      logger: silentLogger(),
    }, { scanIntervalMs: 60_000 });
    worker.start();
    await letPollFinish();
    await worker.stop();
    expect(events).toEqual([
      "open", "close",
      "open", "operation", "close",
    ]);
  });

  test("denied access never enters the body-owning operation", async () => {
    let operationsCalled = 0;
    const worker = new StenographerWorker({
      maintenanceGate: { isAcceptingWork: async () => true },
      resolveModelId: () => "model",
      openAccess: async () => { throw new Error("denied"); },
      candidates: candidates({ live: ["room-1"] }),
      operations: operations({
        runNextRebuild: async () => {
          operationsCalled += 1;
          return unavailable();
        },
        runExtraction: async () => {
          operationsCalled += 1;
          return completed();
        },
      }),
      logger: silentLogger(),
    }, { scanIntervalMs: 60_000 });
    worker.start();
    await letPollFinish();
    await worker.stop();
    expect(operationsCalled).toBe(0);
  });

  test("prepared rebuild runs rebuild extraction and stops the tick", async () => {
    const calls: string[] = [];
    const worker = new StenographerWorker({
      maintenanceGate: { isAcceptingWork: async () => true },
      resolveModelId: () => "model",
      candidates: candidates({ live: ["ordinary"], compaction: ["compact"] }),
      operations: operations({
        runNextRebuild: async () => ({
          status: "prepared_rebuild",
          processed: true,
          roomId: "rebuilt",
        }),
        runExtraction: async ({ roomId, lane }) => {
          calls.push(`${lane}:${roomId}`);
          return completed();
        },
        runCompaction: async () => {
          calls.push("compaction");
          return completed();
        },
      }),
      logger: silentLogger(),
    }, { scanIntervalMs: 60_000 });
    worker.start();
    await letPollFinish();
    await worker.stop();
    expect(calls).toEqual(["rebuild:rebuilt"]);
  });

  test("live, historical, conversion and compaction retain priority", async () => {
    const calls: string[] = [];
    const worker = new StenographerWorker({
      maintenanceGate: { isAcceptingWork: async () => true },
      resolveModelId: () => "model",
      candidates: candidates({
        live: ["live"],
        historical: ["historical"],
        compaction: ["compaction"],
      }),
      operations: operations({
        runExtraction: async ({ lane }) => {
          calls.push(lane);
          return lane === "live" ? completed() : unavailable();
        },
        runLegacyConversion: async () => {
          calls.push("conversion");
          return completed();
        },
        runCompaction: async () => {
          calls.push("compaction");
          return completed();
        },
      }),
      logger: silentLogger(),
    }, { scanIntervalMs: 60_000 });
    worker.start();
    await letPollFinish();
    await worker.stop();
    expect(calls).toEqual(["live"]);
  });

  test("a claimed conversion prevents compaction in the same tick", async () => {
    let compactions = 0;
    const worker = new StenographerWorker({
      maintenanceGate: { isAcceptingWork: async () => true },
      resolveModelId: () => "model",
      candidates: candidates({ compaction: ["room-1"] }),
      operations: operations({
        runLegacyConversion: async () => completed(),
        runCompaction: async () => {
          compactions += 1;
          return completed();
        },
      }),
      logger: silentLogger(),
    }, { scanIntervalMs: 60_000 });
    worker.start();
    await letPollFinish();
    await worker.stop();
    expect(compactions).toBe(0);
  });

  test("stop is bounded and prevents new polls", async () => {
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<StenographerOperationOutcome>((resolve) => {
      release = () => resolve(unavailable());
    });
    const worker = new StenographerWorker({
      maintenanceGate: { isAcceptingWork: async () => true },
      resolveModelId: () => "model",
      operations: operations({
        runNextRebuild: async () => {
          calls += 1;
          return blocked;
        },
      }),
      candidates: candidates(),
      logger: silentLogger(),
    }, { scanIntervalMs: 60_000, shutdownWaitMs: 1 });
    worker.start();
    await letPollFinish();
    await worker.stop();
    worker.poll();
    expect(calls).toBe(1);
    release();
    await letPollFinish();
  });
});

describe("ordinary Stenographer intent adapter", () => {
  test("claims, opens the complete claim, invokes and publishes once", async () => {
    let invocations = 0;
    let publications = 0;
    const fallbackReasons: Array<"device" | "authority" | undefined> = [];
    const exposures: unknown[] = [];
    const adapter = createOrdinaryStenographerIntentAdapter({
      claimExtraction: async () => claim(),
      claimCompaction: async () => null,
      prepareNextRebuild: async () => null,
      createInvoker: () => async () => {
        invocations += 1;
        return '{"operations":[]}';
      },
      publishExtraction: async (input) => {
        publications += 1;
        fallbackReasons.push(input.ordinaryFallbackReason);
        exposures.push(input.modelExposureDependencies);
        return { published: true, eventsWritten: 0 };
      },
      logger: silentLogger(),
    });
    const prepared = await adapter.prepareExtraction({
      roomId: "room-1",
      lane: "live",
      modelId: "model",
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(invocations).toBe(1);
    expect(publications).toBe(0);
    expect(await prepared.publish({ revalidationToken: 1 })).toMatchObject({
      status: "completed",
      processed: true,
    });
    expect(publications).toBe(1);
    expect(fallbackReasons[0]).toBeUndefined();
    expect(exposures[0]).toEqual([{
      kind: "source",
      sourceKind: "message",
      logicalSourceRef: "message:1",
      observedRevision: "0",
      observedContentFingerprint:
        "sha256:f77ca43ff9b7ddb3d343bdb65325b0fb64f6b99696dcdbe74726ca0bde51c97f",
      terminalAuthorityLeafHandle: "namespace-1",
    }]);
    const fallbackPrepared = await adapter.prepareExtraction({
      roomId: "room-1",
      lane: "live",
      modelId: "model",
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(await fallbackPrepared.publish({
      revalidationToken: 2,
      ordinaryFallbackReason: "authority",
    })).toMatchObject({ status: "completed", processed: true });
    expect(fallbackReasons).toEqual([undefined, "authority"]);
  });

  test("retains uncited transcript, prior, rollup, and journal prompt exposure", async () => {
    const base = claim();
    const fullClaim: ExtractionClaim = {
      ...base,
      plan: {
        ...base.plan,
        fromMessageIdExclusive: 9,
        throughMessageIdInclusive: 11,
        sourceRows: [
          {
            ...base.plan.sourceRows[0]!,
            id: 10,
          },
          {
            id: 11,
            createdAt: NOW,
            role: "assistant",
            text: "Uncited but disclosed.",
            fingerprint: null,
            conversationalBoundary: false,
          },
        ],
        coveredMessageIds: [10, 11],
      },
      sourceRows: [
        {
          ...base.sourceRows[0]!,
          id: 10,
        },
        {
          id: 11,
          createdAt: NOW,
          role: "assistant",
          text: "Uncited but disclosed.",
          fingerprint: null,
          displayLabel: "Genie",
          editRevision: 1,
        },
      ],
      priorContextRows: [{
        id: 3,
        createdAt: NOW,
        role: "tool",
        text: "Prior disclosed context.",
        fingerprint: null,
        displayLabel: "Tool",
        editRevision: 2,
      }],
      latestRollup: {
        throughEventSequence: 4,
        content: "Prior cumulative rollup.",
        modelExposureDependency: {
          kind: "source",
          sourceKind: "journal_rollup",
          logicalSourceRef: "journal-rollup:rollup-1",
          observedRevision: "through:4:version:v1",
          observedContentFingerprint: "sha256:rollup",
          terminalAuthorityLeafHandle: "namespace-1",
        },
      },
      visibleEvents: [{
        id: "event-5",
        roomId: "room-1",
        sequence: 5,
        kind: "decision",
        statement: "Existing journal decision.",
        status: "active",
        modelExposureDependency: {
          kind: "record",
          recordRef: "event-5",
          observedProcessingGeneration: 3,
          terminalAuthorityLeafHandles: ["namespace-1"],
        },
      }],
    };
    let publishedExposure: readonly unknown[] | undefined;
    const adapter = createOrdinaryStenographerIntentAdapter({
      claimExtraction: async () => fullClaim,
      createInvoker: () => async () => JSON.stringify({
        operations: [{
          op: "append",
          kind: "decision",
          statement: "Ship it.",
          sourceMessageIds: ["M1"],
        }],
      }),
      publishExtraction: async (input) => {
        publishedExposure = input.modelExposureDependencies;
        return { published: true, eventsWritten: 1 };
      },
      logger: silentLogger(),
    });
    const prepared = await adapter.prepareExtraction({
      roomId: "room-1",
      lane: "live",
      modelId: "model",
      now: NOW,
      signal: new AbortController().signal,
    });
    expect((await prepared.publish({ revalidationToken: 1 })).status)
      .toBe("completed");
    expect(publishedExposure?.map((dependency) =>
      (dependency as { kind: string; logicalSourceRef?: string; recordRef?: string })
        .logicalSourceRef
        ?? (dependency as { recordRef?: string }).recordRef
    )).toEqual([
      "message:10",
      "message:11",
      "message:3",
      "journal-rollup:rollup-1",
      "event-5",
    ]);
  });

  test("retains previous rollup, selected events, and protected tail for compaction", async () => {
    const dependency = (recordRef: string) => ({
      kind: "record" as const,
      recordRef,
      observedProcessingGeneration: 1,
      terminalAuthorityLeafHandles: ["namespace-1"],
    });
    const selected = {
      id: "event-1",
      roomId: "room-1",
      sequence: 1,
      kind: "decision" as const,
      statement: "Selected event.",
      status: "active" as const,
      modelExposureDependency: dependency("event-1"),
    };
    const tail = {
      ...selected,
      id: "event-2",
      sequence: 2,
      statement: "Protected tail.",
      modelExposureDependency: dependency("event-2"),
    };
    const compactionClaim = {
      roomId: "room-1",
      ownerId: "owner-1",
      leaseToken: "lease-1",
      attemptCount: 1,
      modelOperationId: "operation-1",
      acceptedPlan: {
        version: 1,
        owner: "ordinary",
        operationId: "operation-1",
        rebuildGeneration: 0,
        previousRollupId: "rollup-1",
        selectedEventIds: [selected.id],
        protectedTailEventIds: [tail.id],
      },
      namespaceId: "namespace-1",
      previousRollup: {
        throughEventSequence: 0,
        content: "Previous rollup.",
        modelExposureDependency: {
          kind: "source",
          sourceKind: "journal_rollup",
          logicalSourceRef: "journal-rollup:rollup-1",
          observedRevision: "through:0:version:v1",
          observedContentFingerprint: "sha256:rollup",
          terminalAuthorityLeafHandle: "namespace-1",
        },
      },
      plan: {
        trigger: {
          due: true,
          byCount: true,
          byCodePoints: false,
          effectiveEventCount: 2,
          statementCodePoints: 32,
        },
        prompt: "Compaction evidence.",
        previousRollup: {
          throughEventSequence: 0,
          content: "Previous rollup.",
        },
        selectedEvents: [selected],
        protectedTail: [tail],
        throughEventSequence: 1,
        inputCodePoints: 128,
        hasMoreEligiblePrefix: false,
        scheduleAnotherPassAfterPublish: false,
        modelExposure: {
          previousRollupThroughEventSequence: 0,
          selectedEventSequences: [1],
          protectedTailEventSequences: [2],
        },
      },
    } as CompactionClaim;
    let publishedExposure: readonly unknown[] | undefined;
    const adapter = createOrdinaryStenographerIntentAdapter({
      publishExtraction: async () => ({ published: true, eventsWritten: 0 }),
      claimExtraction: async () => null,
      claimCompaction: async () => compactionClaim,
      createInvoker: () => async () => '{"content":"New cumulative rollup."}',
      publishCompaction: async (input) => {
        publishedExposure = input.modelExposureDependencies;
        return true;
      },
      logger: silentLogger(),
    });
    const prepared = await adapter.prepareCompaction({
      roomId: "room-1",
      modelId: "model",
      now: NOW,
      signal: new AbortController().signal,
    });
    expect((await prepared.publish({ revalidationToken: 1 })).status)
      .toBe("completed");
    expect(publishedExposure).toEqual([
      compactionClaim.previousRollup!.modelExposureDependency,
      dependency("event-1"),
      dependency("event-2"),
    ]);
  });

  test("excluded ranges publish no model output and provider failures persist", async () => {
    let invocations = 0;
    let publishedModel: string | null | undefined;
    const excluded = createOrdinaryStenographerIntentAdapter({
      claimExtraction: async () => claim("skip_excluded"),
      createInvoker: () => async () => {
        invocations += 1;
        return '{"operations":[]}';
      },
      publishExtraction: async (input) => {
        publishedModel = input.modelId;
        return { published: true, eventsWritten: 0 };
      },
      logger: silentLogger(),
    });
    const prepared = await excluded.prepareExtraction({
      roomId: "room-1",
      lane: "live",
      modelId: "model",
      now: NOW,
      signal: new AbortController().signal,
    });
    await prepared.publish({ revalidationToken: 1 });
    expect(invocations).toBe(0);
    expect(publishedModel).toBeNull();

    const failures: string[] = [];
    const failed = createOrdinaryStenographerIntentAdapter({
      claimExtraction: async () => claim(),
      createInvoker: () => async () => {
        throw new Error("provider failed");
      },
      publishExtraction: async () => ({ published: true, eventsWritten: 0 }),
      failExtraction: async (input) => {
        failures.push(input.errorCode);
      },
      logger: silentLogger(),
    });
    const failedPreparation = await failed.prepareExtraction({
      roomId: "room-1",
      lane: "live",
      modelId: "model",
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(await failedPreparation.publish({ revalidationToken: 1 }))
      .toMatchObject({ status: "failed" });
    expect(failures).toEqual(["provider"]);
  });

  test("publication errors retain typed persistence failure diagnostics", async () => {
    const failures: string[] = [];
    const warnings: Array<Record<string, unknown>> = [];
    const adapter = createOrdinaryStenographerIntentAdapter({
      claimExtraction: async () => claim(),
      createInvoker: () => async () => '{"operations":[]}',
      publishExtraction: async () => {
        throw new Error("journal transition rejected: target_not_active");
      },
      failExtraction: async (input) => {
        failures.push(input.errorCode);
      },
      logger: {
        ...silentLogger(),
        warn(message, fields) {
          warnings.push({ message, ...fields });
        },
      },
    });
    const prepared = await adapter.prepareExtraction({
      roomId: "room-1",
      lane: "live",
      modelId: "model",
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(await prepared.publish({ revalidationToken: 1 }))
      .toMatchObject({ status: "failed" });
    expect(failures).toEqual(["persistence"]);
    expect(warnings).toEqual([{
      message: "[stenographer] extraction publication failed",
      stage: "extraction",
      failureDetail: "journal_transition_target_not_active",
      failureOrigin: "other",
      databaseCode: null,
      operationCounts: { append: 0, supersede: 0, resolve: 0 },
    }]);
  });
});


test("waiting rebuild and Room grants cannot starve another eligible Room", async () => {
  const visited: string[] = [];
  const worker = new StenographerWorker({
    maintenanceGate: {isAcceptingWork: async () => true},
    resolveModelId: () => "model",
    candidates: candidates({live: ["waiting-room", "ready-room"]}),
    operations: operations({
      runNextRebuild: async () => ({status: "prepared_rebuild", processed: true, roomId: "rebuilding-room"}),
      runExtraction: async ({roomId}) => {
        visited.push(roomId);
        return roomId === "ready-room" ? completed() : {status: "waiting", processed: true, reason: "authority"};
      },
    }),
    now: () => NOW,
    logger: silentLogger(),
  }, {scanIntervalMs: 60_000});
  worker.start();
  await letPollFinish();
  await worker.stop();
  expect(visited).toEqual(["rebuilding-room", "waiting-room", "ready-room"]);
});

for (const stage of ["live", "historical", "compaction", "output-repair"] as const) {
  test(`${stage} exception closes the failed attempt and lets another room run`, async () => {
    const events: string[] = [];
    const visit = async (roomId: string) => {
      events.push(`run:${roomId}`);
      if (roomId === "broken") throw new Error("selected representation unavailable");
      return completed();
    };
    const worker = new StenographerWorker({
      maintenanceGate: { isAcceptingWork: async () => true },
      resolveModelId: () => "model",
      candidates: candidates(stage === "output-repair"
        ? { live: ["ready"] }
        : { [stage]: ["broken", "ready"] }),
      openAccess: async ({ workId }) => ({
        assertCurrent: async () => {},
        close: async () => { events.push(`close:${workId}`); },
      }),
      operations: operations({
        ...(stage === "output-repair" ? { runNextOutputRepair: () => visit("broken") } : {}),
        runExtraction: ({ roomId }) => visit(roomId),
        runCompaction: ({ roomId }) => visit(roomId),
      }),
      logger: {
        ...silentLogger(),
        info: (_message, fields) => {
          events.push(`observed:${String(fields?.["workId"])}:${String(fields?.["outcome"])}`);
        },
      },
    }, { scanIntervalMs: 60_000 });
    worker.start();
    await letPollFinish();
    await worker.stop();
    const failedId = stage === "output-repair" ? "next-output-repair" : "broken";
    expect(events.filter(event => event.startsWith("run:"))).toEqual(["run:broken", "run:ready"]);
    expect(events).toContain(`observed:${failedId}:failed`);
    expect(events).toContain("observed:ready:completed");
    expect(events.indexOf(`close:${failedId}`)).toBeLessThan(events.indexOf("run:ready"));
  });
}

test("cancelled intent stops the poll before another room is opened", async () => {
  const visited: string[] = [];
  const worker = new StenographerWorker({
    maintenanceGate: { isAcceptingWork: async () => true },
    resolveModelId: () => "model",
    candidates: candidates({ live: ["cancelled", "ready"] }),
    operations: operations({
      runExtraction: async ({ roomId }) => {
        visited.push(roomId);
        throw new BackgroundAttemptCancelledError();
      },
    }),
    logger: silentLogger(),
  }, { scanIntervalMs: 60_000 });
  worker.start();
  await letPollFinish();
  await worker.stop();
  expect(visited).toEqual(["cancelled"]);
});
