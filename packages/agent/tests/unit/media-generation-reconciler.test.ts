import { afterEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ClaimedMediaGeneration, MediaGenerationSafeFailure } from "@nautilo/db";
import {
  MediaArtifactIndexCommitError,
  MediaGenerationReconciler,
  VeniceMediaLifecycleError,
  type CommittedMediaArtifactIdentity,
  type MediaGenerationArtifactCustody,
  type MediaGenerationReconcilerRepository,
  type VeniceAcceptedMediaWork,
  type VeniceArtifactCommitProof,
  type VeniceRetrieveResult,
} from "../../src/media-generation";
import { classifyVeniceMediaFailure } from "../../src/media-generation/errors";

const NOW = new Date("2030-02-03T04:05:06.000Z");
const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

function claim(overrides: Partial<ClaimedMediaGeneration> = {}): ClaimedMediaGeneration {
  return {
    receiptId: "mg_0123456789abcdef",
    ownerId: "11111111-1111-4111-8111-111111111111",
    roomId: "22222222-2222-4222-8222-222222222222",
    namespaceId: "33333333-3333-4333-8333-333333333333",
    state: "queued",
    revision: 1,
    kind: "video",
    providerModel: "seedance-2-5-text-to-video-basic",
    providerQueueId: "provider-private-queue",
    providerExecutionSeconds: null,
    providerAverageExecutionSeconds: null,
    artifactInternalId: null,
    cleanupState: "pending",
    ...overrides,
  };
}

class FakeRepository implements MediaGenerationReconcilerRepository {
  current: ClaimedMediaGeneration | null;
  readonly transitions: Array<{ from: string; to: string; failure?: MediaGenerationSafeFailure }> = [];
  readonly reschedules: Array<{
    state: string;
    failure: MediaGenerationSafeFailure;
    processingTiming?: { elapsedSeconds?: number; estimatedSeconds?: number };
    nextAttemptAt: Date;
  }> = [];
  readonly cleanupReschedules: Array<{ failure: MediaGenerationSafeFailure }> = [];
  renewCalls = 0;
  completeCleanupCalls = 0;
  loseOnRenewCall: number | null = null;
  staleTransitionTo: string | null = null;

  constructor(initial: ClaimedMediaGeneration) {
    this.current = initial;
  }

  async claimDue(): Promise<readonly ClaimedMediaGeneration[]> {
    return this.current === null ? [] : [this.current];
  }

  async readClaimed(): Promise<ClaimedMediaGeneration | null> {
    return this.current;
  }

  async renew(input: { expectedRevision: number }): Promise<ClaimedMediaGeneration | null> {
    this.renewCalls += 1;
    if (this.loseOnRenewCall === this.renewCalls || this.current?.revision !== input.expectedRevision) return null;
    this.current = { ...this.current, revision: input.expectedRevision + 1 };
    return this.current;
  }

  async transition(input: {
    expectedRevision: number;
    from: string;
    to: ClaimedMediaGeneration["state"];
    safeFailure?: MediaGenerationSafeFailure | null;
    artifactInternalId?: string;
  }): Promise<ClaimedMediaGeneration | null> {
    if (this.staleTransitionTo === input.to || !this.current ||
        this.current.revision !== input.expectedRevision || this.current.state !== input.from) return null;
    this.transitions.push({
      from: input.from,
      to: input.to,
      ...(input.safeFailure == null ? {} : { failure: input.safeFailure }),
    });
    this.current = {
      ...this.current,
      state: input.to,
      revision: input.expectedRevision + 1,
      ...(input.artifactInternalId === undefined ? {} : { artifactInternalId: input.artifactInternalId }),
      ...(input.to === "failed" || input.to === "needs_action" || input.to === "unknown"
        ? { cleanupState: this.current.cleanupState }
        : {}),
    };
    return this.current;
  }

  async reschedule(input: {
    expectedRevision: number;
    state: "queued" | "retrieving" | "saving";
    safeFailure: MediaGenerationSafeFailure;
    processingTiming?: { elapsedSeconds?: number; estimatedSeconds?: number };
    nextAttemptAt: Date;
  }): Promise<boolean> {
    if (!this.current || this.current.revision !== input.expectedRevision || this.current.state !== input.state) return false;
    this.reschedules.push({
      state: input.state,
      failure: input.safeFailure,
      ...(input.processingTiming === undefined ? {} : { processingTiming: input.processingTiming }),
      nextAttemptAt: input.nextAttemptAt,
    });
    this.current = {
      ...this.current,
      revision: input.expectedRevision + 1,
      ...(input.processingTiming?.elapsedSeconds === undefined
        ? {}
        : { providerExecutionSeconds: input.processingTiming.elapsedSeconds }),
      ...(input.processingTiming?.estimatedSeconds === undefined
        ? {}
        : { providerAverageExecutionSeconds: input.processingTiming.estimatedSeconds }),
    };
    return true;
  }

  async rescheduleCleanup(input: { expectedRevision: number; safeFailure: MediaGenerationSafeFailure }): Promise<boolean> {
    if (!this.current || this.current.revision !== input.expectedRevision || this.current.state !== "ready") return false;
    this.cleanupReschedules.push({ failure: input.safeFailure });
    this.current = { ...this.current, revision: input.expectedRevision + 1 };
    return true;
  }

  async completeCleanup(input: { expectedRevision: number }): Promise<boolean> {
    if (!this.current || this.current.revision !== input.expectedRevision || this.current.state !== "ready") return false;
    this.completeCleanupCalls += 1;
    this.current = { ...this.current, revision: input.expectedRevision + 1, cleanupState: "completed" };
    return true;
  }
}

function mp4Stream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4]));
      controller.close();
    },
  });
}

function identity(): CommittedMediaArtifactIdentity {
  return { artifactId: "external-artifact", artifactInternalId: "44444444-4444-4444-8444-444444444444", artifactRevision: 1 };
}

function custody(input: {
  existing?: CommittedMediaArtifactIdentity | null;
  commitError?: Error;
} = {}): MediaGenerationArtifactCustody & { commits: number; lookups: number } {
  return {
    commits: 0,
    lookups: 0,
    committerFor() {
      return {
        commit: async () => {
          this.commits += 1;
          if (input.commitError) throw input.commitError;
          return identity();
        },
      };
    },
    async findCommitted() {
      this.lookups += 1;
      return input.existing ?? null;
    },
  };
}

async function root(): Promise<string> {
  const value = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-media-reconciler-"));
  tmpRoots.push(value);
  return value;
}

function lifecycle(input: {
  retrieve?: (accepted: VeniceAcceptedMediaWork, attempt: number) => Promise<VeniceRetrieveResult>;
  complete?: (accepted: VeniceAcceptedMediaWork, proof: VeniceArtifactCommitProof) => Promise<void>;
} = {}) {
  const calls = { retrieve: 0, complete: 0, attempts: [] as number[], accepted: [] as VeniceAcceptedMediaWork[] };
  return {
    calls,
    port: {
      async retrieve(args: { accepted: VeniceAcceptedMediaWork; attempt: number }) {
        calls.retrieve += 1;
        calls.attempts.push(args.attempt);
        calls.accepted.push(args.accepted);
        return input.retrieve?.(args.accepted, args.attempt) ?? {
          state: "binary" as const,
          receiptId: args.accepted.receiptId,
          contentType: "video/mp4",
          body: mp4Stream(),
        };
      },
      async complete(args: { accepted: VeniceAcceptedMediaWork; commitProof: VeniceArtifactCommitProof }) {
        calls.complete += 1;
        await input.complete?.(args.accepted, args.commitProof);
      },
    },
  };
}

async function reconciler(input: {
  initial?: ClaimedMediaGeneration;
  repository?: FakeRepository;
  custody?: ReturnType<typeof custody>;
  lifecycle?: ReturnType<typeof lifecycle>;
  maxBytes?: number;
}) {
  const repository = input.repository ?? new FakeRepository(input.initial ?? claim());
  const mediaCustody = input.custody ?? custody();
  const mediaLifecycle = input.lifecycle ?? lifecycle();
  const worker = new MediaGenerationReconciler({
    repository,
    lifecycle: mediaLifecycle.port,
    artifacts: mediaCustody,
    serverArtifactRoot: await root(),
    maxBytesFor: () => input.maxBytes ?? 1_000_000,
    now: () => NOW,
  });
  return { worker, repository, mediaCustody, mediaLifecycle };
}

describe("D525 restart-safe media generation reconciler", () => {
  test("resumes the same durable receipt, uses a fixed honest cadence, and reschedules processing", async () => {
    const mediaLifecycle = lifecycle({
      retrieve: async (accepted) => ({
        state: "processing",
        receiptId: accepted.receiptId,
        executionDurationMs: 18_001,
        estimatedExecutionMs: 145_001,
        schedule: { delayMs: 60_000, nextAttemptAt: new Date(NOW.getTime() + 60_000) },
      }),
    });
    const h = await reconciler({ lifecycle: mediaLifecycle });

    expect(await h.worker.runOnce({ workerId: "worker-a" })).toEqual({
      claimed: 1, completed: 0, rescheduled: 1, lostLease: 0, terminal: 0,
    });
    expect(h.repository.transitions.map(({ from, to }) => [from, to])).toEqual([["queued", "retrieving"]]);
    expect(h.repository.reschedules[0]).toMatchObject({
      state: "retrieving",
      failure: { code: "VENICE_PROCESSING" },
      processingTiming: { elapsedSeconds: 18, estimatedSeconds: 145 },
    });
    expect(h.mediaLifecycle.calls.attempts).toEqual([4]);
    expect(h.mediaLifecycle.calls.accepted[0]).toEqual({
      receiptId: "mg_0123456789abcdef",
      model: "seedance-2-5-text-to-video-basic",
      kind: "video",
      providerQueueId: "provider-private-queue",
    });
    expect(h.mediaLifecycle.calls.accepted[0]).not.toHaveProperty("signedDeliveryUrl");
  });

  test("drops malformed or over-range provider timing while preserving the accepted receipt", async () => {
    const h = await reconciler({
      lifecycle: lifecycle({
        retrieve: async (accepted) => ({
          state: "processing",
          receiptId: accepted.receiptId,
          executionDurationMs: Number.POSITIVE_INFINITY,
          estimatedExecutionMs: 2_147_483_648_000,
          schedule: { delayMs: 60_000, nextAttemptAt: new Date(NOW.getTime() + 60_000) },
        }),
      }),
    });
    expect(await h.worker.runOnce({ workerId: "worker-a" })).toMatchObject({ rescheduled: 1 });
    expect(h.repository.reschedules[0]?.processingTiming).toEqual({});
    expect(h.repository.current).toMatchObject({ state: "retrieving" });
  });

  test("keeps elapsed evidence monotonic when a later provider poll regresses", async () => {
    const h = await reconciler({
      initial: claim({ state: "retrieving", providerExecutionSeconds: 31, providerAverageExecutionSeconds: 145 }),
      lifecycle: lifecycle({
        retrieve: async (accepted) => ({
          state: "processing",
          receiptId: accepted.receiptId,
          executionDurationMs: 18_001,
          estimatedExecutionMs: 120_001,
          schedule: { delayMs: 60_000, nextAttemptAt: new Date(NOW.getTime() + 60_000) },
        }),
      }),
    });
    expect(await h.worker.runOnce({ workerId: "worker-a" })).toMatchObject({ rescheduled: 1 });
    expect(h.repository.reschedules[0]?.processingTiming).toEqual({ elapsedSeconds: 31, estimatedSeconds: 120 });
    expect(h.repository.current).toMatchObject({ providerExecutionSeconds: 31, providerAverageExecutionSeconds: 120 });
  });

  test("streams binary output, commits the exact artifact before ready, then completes cleanup with proof", async () => {
    let cleanupProof: VeniceArtifactCommitProof | undefined;
    const h = await reconciler({
      lifecycle: lifecycle({ complete: async (_accepted, proof) => { cleanupProof = proof; } }),
    });

    expect(await h.worker.runOnce({ workerId: "worker-a" })).toMatchObject({ completed: 1 });
    expect(h.mediaCustody.commits).toBe(1);
    expect(h.repository.transitions.map(({ from, to }) => [from, to])).toEqual([
      ["queued", "retrieving"], ["retrieving", "saving"], ["saving", "ready"],
    ]);
    expect(cleanupProof).toEqual({
      receiptId: "mg_0123456789abcdef",
      artifactInternalId: "44444444-4444-4444-8444-444444444444",
      artifactRevision: 1,
      state: "durably_committed",
    });
    expect(h.repository.current).toMatchObject({ state: "ready", cleanupState: "completed" });
  });

  test("an over-cap accepted result stays on the same receipt and safely reschedules persistence", async () => {
    const h = await reconciler({ maxBytes: 8 });
    expect(await h.worker.runOnce({ workerId: "worker-cap" })).toMatchObject({
      completed: 0, rescheduled: 1, terminal: 0,
    });
    expect(h.repository.current).toMatchObject({ state: "saving" });
    expect(h.repository.reschedules.at(-1)).toMatchObject({
      state: "saving",
      failure: {
        code: "MEDIA_ARTIFACT_TOO_LARGE",
        phase: "save",
        retrySafe: true,
        recoveryActions: ["retry_same_receipt"],
      },
    });
    expect(h.mediaCustody.commits).toBe(0);
    expect(h.mediaLifecycle.calls.retrieve).toBe(1);
  });

  test("recovers an already-indexed saving receipt after restart without retrieving or writing again", async () => {
    const existing = custody({ existing: identity() });
    const h = await reconciler({
      initial: claim({ state: "saving", revision: 11 }),
      custody: existing,
    });

    expect(await h.worker.runOnce({ workerId: "worker-restart" })).toMatchObject({ completed: 1 });
    expect(h.mediaLifecycle.calls.retrieve).toBe(0);
    expect(existing.commits).toBe(0);
    expect(h.repository.transitions.map(({ from, to }) => [from, to])).toEqual([["saving", "ready"]]);
  });

  test("lease loss before provider I/O stops work and stale state CAS never advances", async () => {
    const repository = new FakeRepository(claim());
    repository.loseOnRenewCall = 1;
    const h = await reconciler({ repository });
    expect(await h.worker.runOnce({ workerId: "worker-a" })).toMatchObject({ lostLease: 1 });
    expect(h.mediaLifecycle.calls.retrieve).toBe(0);

    const staleRepository = new FakeRepository(claim());
    staleRepository.staleTransitionTo = "retrieving";
    const stale = await reconciler({ repository: staleRepository });
    expect(await stale.worker.runOnce({ workerId: "worker-a" })).toMatchObject({ lostLease: 1 });
    expect(stale.mediaLifecycle.calls.retrieve).toBe(0);
  });

  test("lease loss after artifact commit leaves saving custody recoverable on restart", async () => {
    const repository = new FakeRepository(claim());
    repository.loseOnRenewCall = 4;
    const first = await reconciler({ repository });
    expect(await first.worker.runOnce({ workerId: "worker-before-crash" })).toMatchObject({ lostLease: 1 });
    expect(first.mediaCustody.commits).toBe(1);
    expect(repository.current).toMatchObject({ state: "saving", artifactInternalId: null });

    repository.loseOnRenewCall = null;
    const restarted = await reconciler({ repository, custody: custody({ existing: identity() }) });
    expect(await restarted.worker.runOnce({ workerId: "worker-after-restart" })).toMatchObject({ completed: 1 });
    expect(restarted.mediaLifecycle.calls.retrieve).toBe(0);
    expect(repository.current).toMatchObject({ state: "ready", cleanupState: "completed" });
  });

  test("isolates an unexpected receipt exception so a later independent claim still completes", async () => {
    const broken = claim({ receiptId: "mg_broken0000000000" });
    const healthy = claim({ receiptId: "mg_healthy000000000" });
    const healthyRepository = new FakeRepository(healthy);
    const repository: MediaGenerationReconcilerRepository = {
      claimDue: async () => [broken, healthy],
      readClaimed: async (input) => {
        if (input.receiptId === broken.receiptId) throw new Error("private repository detail");
        return healthyRepository.readClaimed();
      },
      renew: (input) => healthyRepository.renew(input),
      transition: (input) => healthyRepository.transition(input),
      reschedule: (input) => healthyRepository.reschedule(input),
      rescheduleCleanup: (input) => healthyRepository.rescheduleCleanup(input),
      completeCleanup: (input) => healthyRepository.completeCleanup(input),
    };
    const mediaLifecycle = lifecycle();
    const worker = new MediaGenerationReconciler({
      repository,
      lifecycle: mediaLifecycle.port,
      artifacts: custody(),
      serverArtifactRoot: await root(),
      maxBytesFor: () => 1_000_000,
      now: () => NOW,
    });
    expect(await worker.runOnce({ workerId: "worker-batch" })).toEqual({
      claimed: 2, completed: 1, rescheduled: 0, lostLease: 1, terminal: 0,
    });
    expect(mediaLifecycle.calls.accepted).toHaveLength(1);
    expect(mediaLifecycle.calls.accepted[0]?.receiptId).toBe(healthy.receiptId);
  });

  test("unexpected signed delivery for a first-wave public model becomes durable needs_action without retry or download", async () => {
    const h = await reconciler({
      lifecycle: lifecycle({
        retrieve: async (accepted) => ({
          state: "signed_delivery",
          receiptId: accepted.receiptId,
          signedDeliveryUrl: "https://provider.invalid/private?secret=1",
        }),
      }),
    });
    expect(await h.worker.runOnce({ workerId: "worker-a" })).toMatchObject({ terminal: 1, rescheduled: 0 });
    expect(h.repository.current).toMatchObject({ state: "needs_action" });
    expect(h.repository.transitions.at(-1)).toMatchObject({
      to: "needs_action",
      failure: { code: "VENICE_SIGNED_DELIVERY_UNEXPECTED", retrySafe: false },
    });
    expect(h.repository.reschedules).toHaveLength(0);
  });

  test("unsupported or malformed accepted work is fenced terminally and is never sent to Venice", async () => {
    const h = await reconciler({ initial: claim({ providerModel: "not-first-wave" }) });
    expect(await h.worker.runOnce({ workerId: "worker-a" })).toMatchObject({ terminal: 1 });
    expect(h.repository.current).toMatchObject({ state: "needs_action" });
    expect(h.mediaLifecycle.calls.retrieve).toBe(0);
  });

  test("ambiguous artifact index commit preserves restart custody and reschedules the saving receipt", async () => {
    const mediaCustody = custody({ commitError: new MediaArtifactIndexCommitError("unknown") });
    const h = await reconciler({ custody: mediaCustody });
    expect(await h.worker.runOnce({ workerId: "worker-a" })).toMatchObject({ rescheduled: 1 });
    expect(h.repository.current).toMatchObject({ state: "saving" });
    expect(h.repository.reschedules.at(-1)).toMatchObject({
      state: "saving",
      failure: { code: "MEDIA_ARTIFACT_INDEX_FAILED", phase: "save" },
    });
    expect(h.mediaLifecycle.calls.complete).toBe(0);
  });

  test("cleanup failure leaves ready media playable and schedules cleanup only", async () => {
    const existing = identity();
    const cleanupFailure = new VeniceMediaLifecycleError(
      "mg_0123456789abcdef",
      classifyVeniceMediaFailure({ phase: "cleanup", transportFailure: true, acceptedReceipt: true }),
    );
    const h = await reconciler({
      initial: claim({ state: "ready", revision: 8, artifactInternalId: existing.artifactInternalId }),
      custody: custody({ existing }),
      lifecycle: lifecycle({ complete: async () => { throw cleanupFailure; } }),
    });
    expect(await h.worker.runOnce({ workerId: "worker-cleanup" })).toMatchObject({ rescheduled: 1 });
    expect(h.repository.current).toMatchObject({ state: "ready", cleanupState: "pending" });
    expect(h.repository.cleanupReschedules[0]).toMatchObject({
      failure: { phase: "cleanup", retrySafe: true, recoveryActions: ["retry_same_receipt"] },
    });
    expect(h.repository.transitions).toHaveLength(0);
  });

  test("provider expiration becomes a durable failed state instead of queueing or retrying", async () => {
    const h = await reconciler({
      lifecycle: lifecycle({
        retrieve: async (accepted) => {
          throw new VeniceMediaLifecycleError(
            accepted.receiptId,
            classifyVeniceMediaFailure({ phase: "retrieve", status: 404, acceptedReceipt: true }),
          );
        },
      }),
    });
    expect(await h.worker.runOnce({ workerId: "worker-a" })).toMatchObject({ terminal: 1 });
    expect(h.repository.current).toMatchObject({ state: "failed" });
    expect(h.repository.reschedules).toHaveLength(0);
  });
});
