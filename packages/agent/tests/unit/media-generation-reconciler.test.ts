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
  type VeniceBinaryResult,
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
    provider: "venice",
    providerAccountFingerprint: "a".repeat(64),
    fundingBinding: null,
    providerModel: "seedance-2-5-text-to-video-basic",
    providerQueueId: "provider-private-queue",
    cancellationRequestedAt: null,
    cancellationProviderAcknowledgedAt: null,
    providerExecutionSeconds: null,
    providerAverageExecutionSeconds: null,
    artifactInternalId: null,
    cleanupState: "pending",
    quotedUsdMicros: 410_000,
    actualUsdMicros: null,
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

  async acknowledgeCancellation(input: { expectedRevision: number }): Promise<ClaimedMediaGeneration | null> {
    if (!this.current || this.current.revision !== input.expectedRevision ||
        this.current.cancellationRequestedAt === null) return null;
    this.current = {
      ...this.current,
      cancellationProviderAcknowledgedAt: NOW,
      revision: input.expectedRevision + 1,
    };
    return this.current;
  }

  async transition(input: {
    expectedRevision: number;
    from: string;
    to: ClaimedMediaGeneration["state"];
    safeFailure?: MediaGenerationSafeFailure | null;
    artifactInternalId?: string;
    actualUsdMicros?: number;
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
      ...(input.actualUsdMicros === undefined ? {} : { actualUsdMicros: input.actualUsdMicros }),
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
  cancel?: (accepted: VeniceAcceptedMediaWork) => Promise<void>;
  retrieve?: (accepted: VeniceAcceptedMediaWork, attempt: number) => Promise<VeniceRetrieveResult>;
  download?: (accepted: VeniceAcceptedMediaWork, signedDeliveryUrl: string) => Promise<VeniceBinaryResult>;
  complete?: (accepted: VeniceAcceptedMediaWork, proof: VeniceArtifactCommitProof) => Promise<void>;
} = {}) {
  const calls = { cancel: 0, retrieve: 0, download: 0, complete: 0, attempts: [] as number[], accepted: [] as VeniceAcceptedMediaWork[] };
  return {
    calls,
    port: {
      async cancel(args: { accepted: VeniceAcceptedMediaWork }) {
        calls.cancel += 1;
        await input.cancel?.(args.accepted);
      },
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
      async downloadSignedDelivery(args: { accepted: VeniceAcceptedMediaWork; signedDeliveryUrl: string }) {
        calls.download += 1;
        return input.download?.(args.accepted, args.signedDeliveryUrl) ?? {
          state: "binary" as const,
          receiptId: args.accepted.receiptId,
          contentType: "audio/mpeg",
          body: mp4Stream(),
        };
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
  settleCost?: ConstructorParameters<typeof MediaGenerationReconciler>[0]["settleCost"];
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
    ...(input.settleCost === undefined ? {} : { settleCost: input.settleCost }),
    now: () => NOW,
  });
  return { worker, repository, mediaCustody, mediaLifecycle };
}

describe("D525 restart-safe media generation reconciler", () => {
  test("persists one cancellation acknowledgement and keeps polling the same accepted receipt", async () => {
    const mediaLifecycle = lifecycle({
      retrieve: async (accepted) => ({
        state: "processing",
        receiptId: accepted.receiptId,
        schedule: { delayMs: 60_000, nextAttemptAt: new Date(NOW.getTime() + 60_000) },
      }),
    });
    const h = await reconciler({
      initial: claim({ provider: "surplus", cancellationRequestedAt: NOW }),
      lifecycle: mediaLifecycle,
    });

    expect(await h.worker.runOnce({ workerId: "worker-cancel" })).toMatchObject({ rescheduled: 1 });
    expect(mediaLifecycle.calls.cancel).toBe(1);
    expect(mediaLifecycle.calls.retrieve).toBe(1);
    expect(h.repository.current).toMatchObject({
      state: "retrieving",
      cancellationRequestedAt: NOW,
      cancellationProviderAcknowledgedAt: NOW,
    });

    expect(await h.worker.runOnce({ workerId: "worker-cancel" })).toMatchObject({ rescheduled: 1 });
    expect(mediaLifecycle.calls.cancel).toBe(1);
    expect(mediaLifecycle.calls.retrieve).toBe(2);
  });

  test("a cancellation acknowledgement is not terminal and provider success still publishes", async () => {
    const settlements: Array<{ outcome: string; actualUsdMicros?: number }> = [];
    const h = await reconciler({
      initial: claim({ provider: "surplus", cancellationRequestedAt: NOW }),
      lifecycle: lifecycle({
        retrieve: async (accepted) => ({
          state: "binary",
          receiptId: accepted.receiptId,
          contentType: "video/mp4",
          body: mp4Stream(),
          actualCostUsdMicros: 25_000,
        }),
      }),
      settleCost: async (_claim, evidence) => { settlements.push(evidence); },
    });

    expect(await h.worker.runOnce({ workerId: "worker-cancel-won" })).toMatchObject({ completed: 1 });
    expect(h.mediaLifecycle.calls.cancel).toBe(1);
    expect(h.mediaCustody.commits).toBe(1);
    expect(h.repository.current).toMatchObject({ state: "ready", actualUsdMicros: 25_000 });
    expect(settlements).toEqual([{ outcome: "succeeded", actualUsdMicros: 25_000 }]);
  });

  test("retries a failing best-effort DELETE while GET still reaches paid success on the same job", async () => {
    let polls = 0;
    const settlements: Array<{ outcome: string; actualUsdMicros?: number }> = [];
    const mediaLifecycle = lifecycle({
      cancel: async (accepted) => {
        throw new VeniceMediaLifecycleError(accepted.receiptId, {
          code: "SURPLUS_CANCEL_RETRY", phase: "cancel", retrySafe: true,
          stateChanged: true, completionCertainty: "accepted", chargeCertainty: "unknown",
          recoveryActions: ["wait"], message: "Marketplace cancellation is temporarily unavailable.",
        });
      },
      retrieve: async (accepted) => {
        polls += 1;
        if (polls === 1) {
          return {
            state: "processing",
            receiptId: accepted.receiptId,
            schedule: { delayMs: 60_000, nextAttemptAt: new Date(NOW.getTime() + 60_000) },
          };
        }
        return {
          state: "binary",
          receiptId: accepted.receiptId,
          contentType: "video/mp4",
          body: mp4Stream(),
          actualCostUsdMicros: 105_600,
        };
      },
    });
    const h = await reconciler({
      initial: claim({ provider: "surplus", cancellationRequestedAt: NOW }),
      lifecycle: mediaLifecycle,
      settleCost: async (_claim, evidence) => { settlements.push(evidence); },
    });

    expect(await h.worker.runOnce({ workerId: "worker-cancel-retry" })).toMatchObject({ rescheduled: 1 });
    expect(h.repository.current).toMatchObject({
      state: "retrieving",
      cancellationRequestedAt: NOW,
      cancellationProviderAcknowledgedAt: null,
    });
    expect(await h.worker.runOnce({ workerId: "worker-cancel-retry" })).toMatchObject({ completed: 1 });
    expect(mediaLifecycle.calls.cancel).toBe(2);
    expect(mediaLifecycle.calls.retrieve).toBe(2);
    expect(mediaLifecycle.calls.accepted.map((accepted) => ({
      receiptId: accepted.receiptId,
      providerQueueId: accepted.providerQueueId,
    }))).toEqual([
      { receiptId: "mg_0123456789abcdef", providerQueueId: "provider-private-queue" },
      { receiptId: "mg_0123456789abcdef", providerQueueId: "provider-private-queue" },
    ]);
    expect(h.mediaCustody.commits).toBe(1);
    expect(h.repository.current).toMatchObject({
      state: "ready",
      actualUsdMicros: 105_600,
      cancellationProviderAcknowledgedAt: null,
    });
    expect(settlements).toEqual([{ outcome: "succeeded", actualUsdMicros: 105_600 }]);
  });

  test("does not poll under another account when the exact creating account cannot be opened for cancellation", async () => {
    const mediaLifecycle = lifecycle({
      cancel: async (accepted) => {
        throw new VeniceMediaLifecycleError(accepted.receiptId, {
          code: "SURPLUS_AUTHENTICATION", phase: "cancel", retrySafe: false,
          stateChanged: true, completionCertainty: "accepted", chargeCertainty: "unknown",
          recoveryActions: ["repair_credentials"],
          message: "The creating media account is unavailable.",
        });
      },
      retrieve: async () => {
        throw new Error("must not poll without the exact creating account");
      },
    });
    const h = await reconciler({
      initial: claim({ provider: "surplus", cancellationRequestedAt: NOW }),
      lifecycle: mediaLifecycle,
    });

    expect(await h.worker.runOnce({ workerId: "worker-cancel-account-unavailable" })).toMatchObject({ terminal: 1 });
    expect(mediaLifecycle.calls.cancel).toBe(1);
    expect(mediaLifecycle.calls.retrieve).toBe(0);
    expect(h.repository.current).toMatchObject({
      state: "needs_action",
      cancellationProviderAcknowledgedAt: null,
    });
  });

  test("a provider-cancelled receipt settles its real captured fee", async () => {
    const settlements: Array<{ outcome: string; actualUsdMicros?: number; failureCode?: string }> = [];
    const h = await reconciler({
      initial: claim({ provider: "surplus", cancellationRequestedAt: NOW }),
      lifecycle: lifecycle({
        retrieve: async (accepted) => {
          const error = new VeniceMediaLifecycleError(accepted.receiptId, {
            code: "SURPLUS_CANCELLED", phase: "retrieve", retrySafe: false,
            stateChanged: true, completionCertainty: "accepted", chargeCertainty: "charged_or_committed",
            recoveryActions: ["start_new_generation"], message: "The marketplace generation was cancelled.",
          });
          error.actualCostUsdMicros = 2_400;
          throw error;
        },
      }),
      settleCost: async (_claim, evidence) => { settlements.push(evidence); },
    });

    expect(await h.worker.runOnce({ workerId: "worker-cancelled" })).toMatchObject({ terminal: 1 });
    expect(settlements).toEqual([{
      outcome: "cancelled", actualUsdMicros: 2_400, failureCode: "surplus_cancelled",
    }]);
    expect(h.repository.current).toMatchObject({ state: "failed", actualUsdMicros: 2_400 });
  });

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

  test("keeps a durably committed result ready while cost settlement is retried", async () => {
    let settlementAttempts = 0;
    const repository = new FakeRepository(claim({ provider: "surplus" }));
    const mediaLifecycle = lifecycle({
      retrieve: async (accepted) => ({
        state: "binary",
        receiptId: accepted.receiptId,
        contentType: "video/mp4",
        body: mp4Stream(),
        actualCostUsdMicros: 105_600,
      }),
    });
    const first = await reconciler({
      repository,
      lifecycle: mediaLifecycle,
      settleCost: async () => {
        settlementAttempts += 1;
        throw new Error("recorder unavailable");
      },
    });

    expect(await first.worker.runOnce({ workerId: "worker-cost" })).toMatchObject({ rescheduled: 1 });
    expect(repository.current).toMatchObject({
      state: "ready",
      cleanupState: "pending",
      actualUsdMicros: 105_600,
      artifactInternalId: identity().artifactInternalId,
    });
    expect(first.mediaCustody.commits).toBe(1);
    expect(first.mediaLifecycle.calls.complete).toBe(0);
    expect(repository.cleanupReschedules.at(-1)?.failure.code).toBe("MEDIA_COST_SETTLEMENT_RETRY");

    let settledActual: number | undefined;
    const restarted = await reconciler({
      repository,
      custody: custody({ existing: identity() }),
      lifecycle: mediaLifecycle,
      settleCost: async (_claim, evidence) => {
        settlementAttempts += 1;
        settledActual = evidence.actualUsdMicros;
      },
    });
    expect(await restarted.worker.runOnce({ workerId: "worker-cost" })).toMatchObject({ completed: 1 });
    expect(settlementAttempts).toBe(2);
    expect(settledActual).toBe(105_600);
    expect(restarted.mediaLifecycle.calls.retrieve).toBe(1);
    expect(repository.current).toMatchObject({ state: "ready", cleanupState: "completed" });
  });

  test("retains captured Surplus cost when signed delivery is terminally unsafe", async () => {
    const settlements: Array<{ outcome: string; actualUsdMicros?: number; failureCode?: string }> = [];
    const h = await reconciler({
      initial: claim({ provider: "surplus", kind: "music", providerModel: "minimax-music-v26" }),
      lifecycle: lifecycle({
        retrieve: async (accepted) => ({
          state: "signed_delivery",
          receiptId: accepted.receiptId,
          signedDeliveryUrl: "https://api.surplusintelligence.ai/v1/media/artifacts/provider-private-queue/0",
          actualCostUsdMicros: 105_600,
        }),
        download: async (accepted) => {
          throw new VeniceMediaLifecycleError(accepted.receiptId, {
            code: "SURPLUS_DELIVERY_UNSAFE", phase: "download", retrySafe: false,
            stateChanged: true, completionCertainty: "accepted", chargeCertainty: "charged_or_committed",
            recoveryActions: ["contact_support"], message: "Unsafe delivery route.",
          });
        },
      }),
      settleCost: async (_claim, evidence) => { settlements.push(evidence); },
    });

    expect(await h.worker.runOnce({ workerId: "worker-unsafe" })).toMatchObject({ terminal: 1 });
    expect(settlements).toEqual([{
      outcome: "failed", actualUsdMicros: 105_600, failureCode: "surplus_delivery_unsafe",
    }]);
    expect(h.repository.current).toMatchObject({ state: "failed", actualUsdMicros: 105_600 });
  });

  test("retains captured Surplus cost as outcome-unknown while an interrupted download retries", async () => {
    const settlements: Array<{ outcome: string; actualUsdMicros?: number; failureCode?: string }> = [];
    const h = await reconciler({
      initial: claim({ provider: "surplus", kind: "music", providerModel: "minimax-music-v26" }),
      lifecycle: lifecycle({
        retrieve: async (accepted) => ({
          state: "signed_delivery",
          receiptId: accepted.receiptId,
          signedDeliveryUrl: "https://api.surplusintelligence.ai/v1/media/artifacts/provider-private-queue/0",
          actualCostUsdMicros: 40_000,
        }),
        download: async (accepted) => {
          throw new VeniceMediaLifecycleError(accepted.receiptId, {
            code: "SURPLUS_DOWNLOAD_RETRY", phase: "download", retrySafe: true,
            stateChanged: true, completionCertainty: "accepted", chargeCertainty: "unknown",
            recoveryActions: ["retry_download"], message: "Download interrupted.",
          });
        },
      }),
      settleCost: async (_claim, evidence) => { settlements.push(evidence); },
    });

    expect(await h.worker.runOnce({ workerId: "worker-download" })).toMatchObject({ rescheduled: 1 });
    expect(settlements).toEqual([{
      outcome: "unknown", actualUsdMicros: 40_000, failureCode: "surplus_download_retry",
    }]);
    expect(h.repository.current).toMatchObject({ state: "retrieving", actualUsdMicros: null });
    expect(h.repository.reschedules.at(-1)?.failure).toMatchObject({ chargeCertainty: "charged" });
  });

  test("does not invent cost when an interrupted Surplus download has no confirmed fee", async () => {
    let settlements = 0;
    const h = await reconciler({
      initial: claim({ provider: "surplus", kind: "music", providerModel: "minimax-music-v26" }),
      lifecycle: lifecycle({
        retrieve: async (accepted) => ({
          state: "signed_delivery",
          receiptId: accepted.receiptId,
          signedDeliveryUrl: "https://api.surplusintelligence.ai/v1/media/artifacts/provider-private-queue/0",
        }),
        download: async (accepted) => {
          throw new VeniceMediaLifecycleError(accepted.receiptId, {
            code: "SURPLUS_DOWNLOAD_RETRY", phase: "download", retrySafe: true,
            stateChanged: true, completionCertainty: "accepted", chargeCertainty: "unknown",
            recoveryActions: ["retry_download"], message: "Download interrupted.",
          });
        },
      }),
      settleCost: async () => { settlements += 1; },
    });

    expect(await h.worker.runOnce({ workerId: "worker-no-cost" })).toMatchObject({ rescheduled: 1 });
    expect(settlements).toBe(0);
    expect(h.repository.current).toMatchObject({ actualUsdMicros: null });
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

  test("retains captured cost on the saving receipt when persistence retries", async () => {
    const h = await reconciler({
      initial: claim({ provider: "surplus" }),
      maxBytes: 8,
      lifecycle: lifecycle({
        retrieve: async (accepted) => ({
          state: "binary",
          receiptId: accepted.receiptId,
          contentType: "video/mp4",
          body: mp4Stream(),
          actualCostUsdMicros: 72_500,
        }),
      }),
    });

    expect(await h.worker.runOnce({ workerId: "worker-persistence" })).toMatchObject({ rescheduled: 1 });
    expect(h.repository.current).toMatchObject({ state: "saving", actualUsdMicros: 72_500 });
    expect(h.repository.reschedules.at(-1)?.failure).toMatchObject({
      code: "MEDIA_ARTIFACT_TOO_LARGE", phase: "save",
    });
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

  test("a concurrent cancellation that wins before saving cancels the downloaded stream and publishes nothing", async () => {
    let streamCancelled = 0;
    const repository = new FakeRepository(claim({ provider: "surplus" }));
    repository.staleTransitionTo = "saving";
    const h = await reconciler({
      repository,
      lifecycle: lifecycle({
        retrieve: async (accepted) => ({
          state: "binary",
          receiptId: accepted.receiptId,
          contentType: "video/mp4",
          body: new ReadableStream<Uint8Array>({
            cancel() { streamCancelled += 1; },
          }),
        }),
      }),
    });

    expect(await h.worker.runOnce({ workerId: "worker-cancel-race" })).toMatchObject({ lostLease: 1 });
    expect(streamCancelled).toBe(1);
    expect(h.mediaCustody.commits).toBe(0);
    expect(h.repository.current).toMatchObject({ state: "retrieving", artifactInternalId: null });
  });

  test("a cancellation that wins during the provider poll cancels returned bytes before publication", async () => {
    let streamCancelled = 0;
    const repository = new FakeRepository(claim({ provider: "surplus" }));
    repository.loseOnRenewCall = 2;
    const h = await reconciler({
      repository,
      lifecycle: lifecycle({
        retrieve: async (accepted) => ({
          state: "binary",
          receiptId: accepted.receiptId,
          contentType: "video/mp4",
          body: new ReadableStream<Uint8Array>({
            cancel() { streamCancelled += 1; },
          }),
        }),
      }),
    });

    expect(await h.worker.runOnce({ workerId: "worker-cancel-poll-race" })).toMatchObject({ lostLease: 1 });
    expect(streamCancelled).toBe(1);
    expect(h.mediaCustody.commits).toBe(0);
    expect(h.repository.transitions.map(({ from, to }) => [from, to])).toEqual([["queued", "retrieving"]]);
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
      acknowledgeCancellation: (input) => healthyRepository.acknowledgeCancellation(input),
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
