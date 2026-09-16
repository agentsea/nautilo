import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import type { PreparedMemoryReview } from "@nautilo/agent";
import {
  MemoryReviewWorker,
  type MemoryReviewClaim,
  type MemoryReviewRepository,
  type MemoryReviewWorkerDeps,
} from "../../src/memory-review/worker";

const claim: MemoryReviewClaim = {
  workId: "work", attemptId: "attempt", ownerId: "owner", actorId: "actor", agentId: "agent",
  roomId: "room", threadId: "thread", scopeId: null, turnIds: ["turn"], sourceIds: [1], leaseUntil: new Date("2099-01-01"),
};
const envelope = {
  ownerId: "owner", actorId: "actor", agentId: "agent", roomId: "room",
  readableNamespaces: ["namespace"], mutableNamespaces: ["namespace"], writableNamespaces: ["namespace"], toolPolicy: {},
};
const proposal: PreparedMemoryReview = { operations: [], snapshots: [], envelope, speakerUserId: "owner" };
function fixture() {
  const events: string[] = [];
  const failures: Parameters<MemoryReviewRepository["fail"]>[0][] = [];
  let claimed = false;
  const repository: MemoryReviewRepository = {
    claimNext: async () => { events.push("claim"); if (claimed) return null; claimed = true; return claim; },
    assertCurrent: async () => { events.push("fence"); },
    load: async () => { events.push("load"); return { messages: [new HumanMessage("remember")], memoryAccessEnvelope: envelope }; },
    reconcile: async () => { events.push("reconcile"); return "not_published"; },
    publish: async () => { events.push("publish"); return "published"; },
    fail: async (failure) => { events.push("fail"); failures.push(failure); },
    drainEffects: async () => { events.push("effects"); },
  };
  const deps: MemoryReviewWorkerDeps = {
    repository,
    checkAvailable: async () => true,
    resolveModelId: () => "model",
    prepare: async () => { events.push("model"); return { status: "prepared", turns: 1, modelId: "model", proposal }; },
  };
  return { deps, events, failures };
}
async function tick(): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
async function run(deps: MemoryReviewWorkerDeps): Promise<void> {
  const worker = new MemoryReviewWorker(deps, { scanIntervalMs: 60_000, shutdownWaitMs: 100 });
  worker.start();
  await tick();
  await worker.stop();
}

describe("durable Memory review worker", () => {
  test("ordinary review completes without a device access hook", async () => {
    const { deps, events, failures } = fixture();
    const outcomes: string[] = [];
    deps.observeAttempt = (observation) => {
      outcomes.push(observation.outcome);
    };

    await run(deps);

    expect(events).toEqual([
      "effects", "claim", "reconcile", "fence", "load", "fence", "model",
      "fence", "publish", "effects",
    ]);
    expect(outcomes).toEqual(["completed"]);
    expect(failures).toEqual([]);
  });

  test("reconciles first and opens access before any transcript read", async () => {
    const { deps, events } = fixture();
    deps.openAccess = async () => {
      events.push("open");
      return { assertCurrent: async () => { events.push("authority"); }, close: async () => { events.push("close"); } };
    };
    await run(deps);
    expect(events.indexOf("reconcile")).toBeLessThan(events.indexOf("open"));
    expect(events.indexOf("open")).toBeLessThan(events.indexOf("load"));
    expect(events.indexOf("model")).toBeLessThan(events.indexOf("publish"));
    expect(events.indexOf("publish")).toBeLessThan(events.indexOf("close"));
  });

  test("unknown commit never loads content or reruns the model", async () => {
    const { deps, events, failures } = fixture();
    deps.repository.reconcile = async () => "unknown";
    await run(deps);
    expect(events).not.toContain("load");
    expect(events).not.toContain("model");
    expect(failures[0]).toMatchObject({ reason: "publication_uncertain", retryable: false });
  });

  test("a failed receipt read blocks transformation until a later reconciliation proves absence", async () => {
    const { deps, events, failures } = fixture();
    deps.repository.claimNext = async () => claim;
    let reads = 0;
    deps.repository.reconcile = async () => {
      events.push("reconcile");
      if (++reads === 1) throw new Error("receipt read unavailable");
      return "not_published";
    };
    await run(deps);
    expect(events).not.toContain("model");
    expect(failures[0]).toMatchObject({ phase: "reconciliation", reason: "publication_uncertain", retryable: false });
    await run(deps);
    expect(reads).toBe(2);
    expect(events.filter((event) => event === "model")).toHaveLength(1);
    expect(events).toContain("publish");
  });

  test("a committed receipt skips transformation and publication", async () => {
    const { deps, events } = fixture();
    deps.repository.reconcile = async () => "published";
    await run(deps);
    expect(events).not.toContain("load");
    expect(events).not.toContain("publish");
    expect(events).toContain("effects");
  });

  test("paused review still drains committed effects without claiming", async () => {
    const { deps, events } = fixture();
    deps.checkAvailable = async () => false;
    await run(deps);
    expect(events).toEqual(["effects"]);
  });

  test("exhaustion is a model failure, never successful no-change", async () => {
    const { deps, events, failures } = fixture();
    deps.prepare = async () => ({ status: "failed", reason: "iteration_exhausted", turns: 1 });
    await run(deps);
    expect(events).not.toContain("publish");
    expect(failures[0]).toMatchObject({ phase: "model", reason: "iteration_exhausted" });
  });

  test("uncertain publication is not transformed into an automatic model retry", async () => {
    const { deps, events, failures } = fixture();
    deps.repository.publish = async () => { throw new Error("connection lost"); };
    await run(deps);
    expect(events.filter((event) => event === "model")).toHaveLength(1);
    expect(failures[0]).toMatchObject({ phase: "publication", reason: "publication_uncertain", retryable: false });
  });

  test("effect delivery failure does not fail an already committed review", async () => {
    const { deps, events, failures } = fixture();
    deps.repository.drainEffects = async () => { throw new Error("delivery pending"); };
    deps.onError = () => { throw new Error("diagnostics unavailable"); };
    await run(deps);
    expect(events).toContain("publish");
    expect(failures).toEqual([]);
  });

  test("wake coalesces and shutdown fences a model that ignores cancellation", async () => {
    const { deps, events } = fixture();
    let finish: (() => void) | undefined;
    deps.prepare = async () => {
      events.push("model");
      await new Promise<void>((resolve) => { finish = resolve; });
      return { status: "prepared", turns: 1, modelId: "model", proposal };
    };
    const worker = new MemoryReviewWorker(deps, { scanIntervalMs: 60_000, shutdownWaitMs: 1 });
    worker.start();
    await tick();
    worker.wake(); worker.wake();
    await worker.stop();
    finish!();
    await tick();
    expect(events.filter((event) => event === "claim")).toHaveLength(1);
    expect(events).not.toContain("publish");
  });
});


describe("Memory typed results retain their actual attempt outcome", () => {
  for (const result of ["iteration_exhausted", "unknown", "not_published"] as const) {
    test(`${result} is never observed as completed and fails once`, async () => {
      const { deps, failures } = fixture();
      const outcomes: string[] = [];
      deps.observeAttempt = (observation) => { outcomes.push(observation.outcome); throw new Error("observer failed"); };
      if (result === "iteration_exhausted") deps.prepare = async () => ({ status: "failed", reason: result, turns: 1, modelId: "model" });
      else deps.repository.publish = async () => result;
      await run(deps);
      expect(failures).toHaveLength(1);
      expect(outcomes).toEqual([result === "not_published" ? "unavailable" : "failed"]);
    });
  }
});
