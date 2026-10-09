import { expect, test, spyOn } from "bun:test";
import { Job, ExternalRoomExecutionBusyError, type ExternalRoomClaimHooks, type JobExecutor } from "../../src/job";
import { eventBus } from "../../src/event-bus";
import type { ServerEvent } from "@nautilo/types";
import type { JobStatus } from "@nautilo/types";

function makeJob(executor: JobExecutor, transition: (status: JobStatus) => Promise<JobStatus>) {
  return new Job({ ownerId: "sponsor", requestorId: "sponsor", laneKey: "room:test", type: "foreground",
    input: {}, executor, persist: async () => "same-job",
    updateStatus: async () => { throw new Error("External lifecycle must use its exact transition owner"); },
    transitionExternalRoomStatus: transition });
}

test("atomic final completion wins a concurrent Stop in local lifecycle too", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let durable: JobStatus = "queued";
  const job = makeJob(async function* () { yield* []; entered.resolve(); await release.promise; }, async requested => {
    if (durable === "completed") return durable;
    durable = requested;
    return durable;
  });
  await job.persist();
  const execution = job.execute();
  await entered.promise;
  durable = "completed"; // Canonical final Message + outbox transaction committed.
  await job.cancel();
  expect(job.status).toBe("completed");
  release.resolve();
  await execution;
  expect(job.status).toBe("completed");
});

test("a terminal start never enters the model executor", async () => {
  let calls = 0;
  const job = makeJob(async function* () { yield* []; calls += 1; }, async () => "cancelled");
  await job.persist();
  await job.execute();
  expect(calls).toBe(0);
  expect(job.status).toBe("cancelled");
});

test("duplicate adopter cannot execute or settle the winning running Job", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let durable: JobStatus = "queued";
  let calls = 0;
  function adopter() {
    let ownsStart = false;
    return makeJob(async function* () { yield* []; calls += 1; entered.resolve(); await release.promise; durable = "completed"; }, async requested => {
      if (requested === "running") {
        if (durable !== "queued") throw new Error("start_not_owned");
        ownsStart = true;
        return durable = "running";
      }
      if (!ownsStart && durable === "running") throw new Error("settlement_not_owned");
      if (durable === "completed") return durable;
      return durable = requested;
    });
  }
  const winner = adopter();
  const loser = adopter();
  await winner.persist();
  await loser.persist();
  const execution = winner.execute();
  await entered.promise;
  expect(loser.execute()).rejects.toThrow("start_not_owned");
  expect(loser.fail(new Error("start rejected"))).rejects.toThrow("settlement_not_owned");
  expect(durable as JobStatus).toBe("running");
  expect(calls).toBe(1);
  release.resolve();
  await execution;
  expect(winner.status).toBe("completed");
});


test("a cancelled local turn retains its Room claim until executor unwind before external execution", async () => {
  const entered = Promise.withResolvers<void>();
  const unwind = Promise.withResolvers<void>();
  let claimOwner: string | null = null;
  let externalCalls = 0;
  const hooks: ExternalRoomClaimHooks = {
    async acquire(_userId, jobId) {
      if (claimOwner !== null) return { kind: "busy" };
      claimOwner = jobId;
      return { kind: "claimed", roomId: "room", jobId, token: `private-${jobId}` };
    },
    async release(_userId, claim) {
      if (claimOwner !== claim.jobId || claim.token !== `private-${claim.jobId}`) return false;
      claimOwner = null;
      return true;
    },
  };
  const local = new Job({ ownerId: "local-owner", requestorId: "local-owner", laneKey: "room:room",
    type: "foreground", input: {}, persist: async () => "local-job", updateStatus: async () => {},
    externalRoomClaims: hooks,
    executor: async function* () { yield* []; entered.resolve(); await unwind.promise; },
  });
  const external = new Job({ ownerId: "sponsor", requestorId: "sponsor", laneKey: "room:room",
    type: "foreground", input: {}, persist: async () => "external-job", updateStatus: async () => {},
    externalRoomClaims: hooks, transitionExternalRoomStatus: async status => status,
    executor: async function* () { yield* []; externalCalls += 1; },
  });
  await local.persist();
  await external.persist();
  const localExecution = local.execute();
  await entered.promise;
  await local.cancel();
  expect(local.status).toBe("cancelled");
  expect(claimOwner as string | null).toBe("local-job");
  expect(external.execute()).rejects.toBeInstanceOf(ExternalRoomExecutionBusyError);
  expect(external.status).toBe("queued");
  expect(externalCalls).toBe(0);
  unwind.resolve();
  await localExecution;
  expect(claimOwner).toBeNull();
  await external.execute();
  expect(externalCalls).toBe(1);
  expect(claimOwner).toBeNull();
});


test("external failure diagnostics omit provider bodies and SQL parameters", async () => {
  const logs: unknown[][] = [];
  const events: ServerEvent[] = [];
  const stderr = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args); });
  const receive = (event: ServerEvent) => { events.push(event); };
  eventBus.on(receive);
  try {
    const job = makeJob(async function* () { yield* []; }, async status => status);
    await job.persist();
    await job.fail(new Error("PRIVATE_EXTERNAL_PAYLOAD sql token=PRIVATE_CLAIM_TOKEN"));
    expect(job.status).toBe("failed");
    expect(JSON.stringify(logs)).toContain("MDL007");
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
  } finally { eventBus.off(receive); stderr.mockRestore(); }
});


test("a transient claim-release failure retains the exact quiescent token for retry without executing again", async () => {
  let acquisitions = 0;
  let releases = 0;
  let calls = 0;
  const tokens: string[] = [];
  const job = new Job({ ownerId: "sponsor", requestorId: "sponsor", laneKey: "room:room", type: "foreground", input: {},
    persist: async () => "job", updateStatus: async () => {}, transitionExternalRoomStatus: async status => status,
    externalRoomClaims: {
      async acquire() { acquisitions += 1; return { kind: "claimed", roomId: "room", jobId: "job", token: "private-exact-token" }; },
      async release(_owner, claim) { tokens.push(claim.token); if (++releases === 1) throw new Error("Synthetic transient DB failure"); return true; },
    },
    executor: async function* () { yield* []; calls += 1; },
  });
  await job.persist();
  await job.execute();
  expect(job.hasQuiescentExternalRoomClaim()).toBe(true);
  expect(await job.retryQuiescentExternalRoomClaimRelease()).toBe(true);
  expect(job.hasQuiescentExternalRoomClaim()).toBe(false);
  expect(tokens).toEqual(["private-exact-token", "private-exact-token"]);
  expect(acquisitions).toBe(1);
  expect(calls).toBe(1);
  expect(job.status).toBe("completed");
});
