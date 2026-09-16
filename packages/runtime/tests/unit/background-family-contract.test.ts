import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { MemoryReviewWorker, type MemoryReviewRepository } from "../../src/memory-review/worker";
import { StenographerWorker } from "../../src/stenographer/worker";
import type { StenographerOperationOutcome } from "@nautilo/lattice-bridge/server";
import { runDurableHierarchySleep, type DurableSleepClaim, type DurableSleepSemanticPort, type DurableSleepWorkPort } from "@nautilo/reflection";
import { createReflectionOrganizationAttemptOpener } from "../../src/reflection/organization-attempt";

const envelope = { ownerId: "owner", actorId: "actor", agentId: "agent", roomId: "room", toolPolicy: {}, readableNamespaces: ["namespace"], mutableNamespaces: ["namespace"], writableNamespaces: ["namespace"] };
const memoryClaim = { workId: "work", attemptId: "attempt", ownerId: "owner", actorId: "actor", agentId: "agent", roomId: "room", threadId: "thread", scopeId: null, turnIds: ["turn"], sourceIds: [1], leaseUntil: new Date("2099-01-01") };
const reflectionClaim: DurableSleepClaim = { logicalObjectRef: "logical", recordRef: "record", generation: 1, stage: "organization", changeReason: "created", leaseToken: "lease" };

type Scenario = "success" | "denied" | "revoked" | "provider" | "uncertain" | "cancelled";
function state(scenario: Scenario) {
  const events: string[] = [];
  const observedFamilies: string[] = [];
  const outcomes: string[] = [];
  let current = true;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  return {
    events, release, observedFamilies, outcomes,
    checkAvailable: async () => scenario !== "denied",
    assertCurrent: async () => { if (!current) throw new Error("authority_or_lease_revoked"); },
    openAccess: async () => { events.push("open"); return { assertCurrent: async () => { if (!current) throw new Error("authority_or_lease_revoked"); }, close: async () => { events.push("close"); throw new Error("cleanup diagnostic failure"); } }; },
    model: async () => { events.push("model"); if (scenario === "revoked") current = false; if (scenario === "provider") throw new Error("provider failed"); if (scenario === "cancelled") await blocked; },
    publish: async () => { events.push("publish"); if (scenario === "uncertain") throw new Error("commit acknowledgement lost"); },
    observer: (...values: unknown[]) => {
      events.push("observe");
      for (const value of values) if (value && typeof value === "object" && "family" in value && typeof value.family === "string") { observedFamilies.push(value.family); if ("outcome" in value && typeof value.outcome === "string") outcomes.push(value.outcome); }
      throw new Error("observer failed");
    },
  };
}
type State = ReturnType<typeof state>;
async function settleUntil(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !check(); turn++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(check()).toBe(true);
}

function memory(s: State) {
  let availableClaim = true;
  let reconciliation: Awaited<ReturnType<MemoryReviewRepository["reconcile"]>> = "not_published";
  const repository: MemoryReviewRepository = {
    claimNext: async () => { if (!availableClaim) return null; availableClaim = false; return memoryClaim; },
    assertCurrent: s.assertCurrent,
    reconcile: async () => reconciliation,
    load: async () => { s.events.push("load"); return { messages: [new HumanMessage("evidence")], memoryAccessEnvelope: envelope }; },
    publish: async () => { await s.publish(); return "published"; },
    fail: async ({ reason }) => { s.events.push(`fail:${reason}`); },
    drainEffects: async () => { throw new Error("effect transport unavailable"); },
  };
  const worker = new MemoryReviewWorker({ repository, checkAvailable: s.checkAvailable, openAccess: s.openAccess, observeAttempt: s.observer, resolveModelId: () => "model", prepare: async () => { await s.model(); return { status: "prepared", turns: 1, modelId: "model", proposal: { envelope, speakerUserId: "owner", operations: [], snapshots: [] } }; }, onError: s.observer }, { scanIntervalMs: 60_000, shutdownWaitMs: 1 });
  return { start: () => worker.start(), stop: () => worker.stop(), restart: () => { availableClaim = true; worker.start(); }, receipt: (value: typeof reconciliation) => { reconciliation = value; } };
}
function stenographer(s: State) {
  let availableClaim = true;
  const unavailable = (): StenographerOperationOutcome => ({ status: "unavailable", processed: false });
  const worker = new StenographerWorker({
    maintenanceGate: { isAcceptingWork: s.checkAvailable },
    openAccess: async (identity) => identity.stage === "extraction"
      ? s.openAccess()
      : { assertCurrent: async () => {}, close: async () => {} },
    resolveModelId: () => "model",
    candidates: {
      extraction: async ({ lane }) => {
        if (lane !== "live" || !availableClaim) return [];
        availableClaim = false;
        return ["room"];
      },
      initializeHistorical: async () => {},
      compaction: async () => [],
    },
    operations: {
      runNextRebuild: async () => unavailable(),
      runLegacyConversion: async () => unavailable(),
      runCompaction: async () => unavailable(),
      runExtraction: async ({ attempt }) => {
        s.events.push("load");
        try {
          await s.model();
        } catch {
          s.events.push("fail");
          return { status: "failed", processed: true };
        }
        await attempt.publish(async () => {
          await s.publish();
        });
        return { status: "completed", processed: true };
      },
    },
    logger: { info: s.observer, warn: s.observer, error: s.observer },
  }, { scanIntervalMs: 60_000, shutdownWaitMs: 1 });
  return { start: () => worker.start(), stop: () => worker.stop(), restart: () => { availableClaim = true; worker.start(); } };
}
function reflection(s: State) {
  let availableClaim = true;
  let controller = new AbortController();
  let running: Promise<unknown> = Promise.resolve();
  const work: DurableSleepWorkPort = {
    claimNext: async () => { if (!availableClaim) return { status: "empty" }; availableClaim = false; return { status: "claimed", claim: reflectionClaim }; },
    checkpoint: async () => ({ status: "accepted" }), pause: async () => ({ status: "accepted" }),
    complete: async () => { s.events.push("complete"); return { status: "accepted" }; },
    defer: async () => { s.events.push("fail"); return { status: "deferred" }; }, enqueue: async () => {},
  };
  const snapshot = (recordRef: string) => ({ recordRef, observedContentFingerprint: `fp:${recordRef}`, posture: "derived" as const, anchors: ["room"], statement: "evidence", sourceRefs: [], childRecordRefs: [], structuralHeight: 0, lifecycle: "current" as const });
  const semantic: DurableSleepSemanticPort = {
    openOrganizationAttempt: createReflectionOrganizationAttemptOpener({ checkAvailable: s.checkAvailable, assertClaimCurrent: async () => { await s.assertCurrent(); return true; }, openAccess: s.openAccess, observe: s.observer }),
    ensureAuthority: async () => ({ status: "ready" }), ensureSearchProjection: async () => ({ status: "ready" }),
    resolveParentConflict: async () => ({ status: "not_applicable" }), resolveDependencyLoss: async () => ({ status: "not_applicable" }),
    loadOrganizerView: async () => { s.events.push("load"); return { status: "ready", view: { changed: { handle: "R1", snapshot: snapshot("record"), dependency: { kind: "record", recordRef: "record" } }, candidates: [{ handle: "R2", snapshot: snapshot("neighbor"), dependency: { kind: "record", recordRef: "neighbor" } }], existingParents: [], maxSelectedChildren: 2 } }; },
    invokeOrganizer: async () => { await s.model(); return '{"operation":"no_change"}'; },
    applyProposal: async () => { await s.publish(); return { status: "applied", operation: "no_change", replayed: false, usage: { modelCalls: 0, visitedRecords: 0, createdRecords: 0, traversalWork: 0 } }; },
  };
  const start = () => { running = runDurableHierarchySleep({ work, semantic, signal: controller.signal, budget: { maxWorkItems: 1, hierarchy: { maxModelCalls: 2, maxVisitedRecords: 20, maxCreatedRecords: 2, maxTraversalWork: 20, maxStatementCharacters: 800 } } }).catch(() => { s.events.push("fail"); }); };
  return { start, stop: async () => { controller.abort(); s.release(); await running; }, restart: () => { availableClaim = true; controller = new AbortController(); start(); } };
}

// Each factory drives its real family orchestrator; only external ports are synthetic.
for (const [family, create] of Object.entries({ memory, stenographer, reflection })) {
  describe(`${family}: shared processing boundary`, () => {
    test("unavailable admission opens no payload", async () => {
      const s = state("denied"); const run = create(s); run.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 0)); await run.stop();
      expect(s.events).not.toContain("load"); expect(s.events).not.toContain("model"); expect(s.events).not.toContain("publish");
    });
    for (const scenario of ["success", "revoked", "provider", "uncertain"] as const) {
      test(`${scenario} closes access despite throwing cleanup and diagnostics`, async () => {
        const s = state(scenario); const run = create(s); run.start();
        await settleUntil(() => s.events.includes("close")); await run.stop();
        expect(s.events.indexOf("open")).toBeLessThan(s.events.indexOf("load"));
        expect(s.events.filter((event) => event === "close")).toHaveLength(1);
        expect(s.events.filter((event) => event === "model")).toHaveLength(1);
        expect(s.events.filter((event) => event === "publish")).toHaveLength(scenario === "success" || scenario === "uncertain" ? 1 : 0);
        expect(s.observedFamilies).toContain(family);
        if (scenario !== "success") expect(s.outcomes).not.toContain("completed");
        else expect(s.outcomes).toContain("completed");
        if (scenario === "success") expect(s.events.some((event) => event.startsWith("fail"))).toBe(false);
      });
    }
    test("shutdown rejects late model completion and another start remains usable", async () => {
      const s = state("cancelled"); const run = create(s); run.start();
      await settleUntil(() => s.events.includes("model"));
      await run.stop(); s.release(); await settleUntil(() => s.events.includes("close"));
      expect(s.events).not.toContain("publish");
      run.restart(); await settleUntil(() => s.events.filter((event) => event === "close").length === 2); await run.stop();
      expect(s.events.filter((event) => event === "publish")).toHaveLength(1);
    });
  });
}

test("Memory unknown receipt reconciliation survives restart without loading or invoking", async () => {
  const s = state("success"); const run = memory(s); run.receipt("unknown"); run.start();
  await settleUntil(() => s.events.includes("fail:publication_uncertain")); await run.stop();
  run.receipt("published"); run.restart(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); await run.stop();
  expect(s.events).not.toContain("load"); expect(s.events).not.toContain("model"); expect(s.events).not.toContain("publish");
});
