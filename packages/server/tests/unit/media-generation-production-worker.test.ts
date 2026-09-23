import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ClaimedMediaGeneration, ClaimedMediaGenerationCompletionWake, Artifact } from "@nautilo/db";
import { setWorkspaceArtifactCreatedSink, type WorkspaceArtifactCreatedFact } from "@nautilo/agent";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";
import {
  MEDIA_GENERATION_MAX_BYTES,
  createMediaGenerationWorkerScheduler,
  createProductionMediaArtifactCustody,
  deliverProductionMediaGenerationCompletionWakes,
  installProductionMediaGenerationWorker,
  stopProductionMediaGenerationWorker,
} from "../../src/media-generation/production-worker";

const roots: string[] = [];

afterEach(async () => {
  setWorkspaceArtifactCreatedSink(null);
  stopProductionMediaGenerationWorker();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-media-worker-"));
  roots.push(root);
  return root;
}

function claim(namespaceId = "33333333-3333-4333-8333-333333333333"): ClaimedMediaGeneration {
  return {
    receiptId: "mg_0123456789abcdef",
    ownerId: "11111111-1111-4111-8111-111111111111",
    roomId: "22222222-2222-4222-8222-222222222222",
    namespaceId,
    state: "saving",
    revision: 7,
    kind: "video",
    providerModel: "seedance-2-5-text-to-video-basic",
    providerQueueId: "private-provider-coordinate",
    providerExecutionSeconds: null,
    providerAverageExecutionSeconds: null,
    artifactInternalId: null,
    cleanupState: "pending",
  };
}

function mp4Bytes(): Uint8Array {
  return Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4]);
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error: unknown) {
    return error;
  }
}

function fakeArtifactOperations() {
  const rows = new Map<string, Artifact>();
  const namespaces = new Map<string, string[]>();
  let inserts = 0;
  let attachments = 0;
  return {
    rows,
    namespaces,
    get inserts() { return inserts; },
    get attachments() { return attachments; },
    operations: {
      async find(internalId: string, namespaceId: string) {
        const row = rows.get(internalId) ?? null;
        return row && namespaces.get(internalId)?.includes(namespaceId) ? row : null;
      },
      async namespaces(artifactInternalId: string) { return namespaces.get(artifactInternalId) ?? []; },
      async transaction<T>(run: (connection: unknown) => Promise<T>) { return run({}); },
      async insert(input: {
        internalId: string; artifactId: string; path: string; storageUri: string; mimeType: string; size: number;
      }) {
        if (rows.has(input.internalId)) throw new Error("deterministic id conflict");
        inserts += 1;
        const now = new Date("2030-01-01T00:00:00.000Z");
        const row: Artifact = {
          id: input.internalId, artifactId: input.artifactId, path: input.path,
          storageUri: input.storageUri, mimeType: input.mimeType, size: input.size,
          revision: 1, createdAt: now, updatedAt: now, deletedAt: null,
        };
        rows.set(row.id, row);
        return row;
      },
      async attach(artifactInternalId: string, namespaceId: string) {
        attachments += 1;
        namespaces.set(artifactInternalId, [namespaceId]);
      },
    },
  };
}

describe("D525 production media worker", () => {
  test("Human Video creation uses proven origin, not owner fallback, and feed failure is harmless", async () => {
    const root = await tempRoot();
    await fsp.mkdir(path.join(root, "media"));
    const bytes = mp4Bytes();
    const actorUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const observed: WorkspaceArtifactCreatedFact[] = [];
    setWorkspaceArtifactCreatedSink(fact => { observed.push(fact); throw new Error("feed unavailable"); });
    for (const origin of [actorUserId, null]) {
      const finalPath = path.join(root, "media", `${origin ?? "unknown"}.mp4`);
      await fsp.writeFile(finalPath, bytes);
      const fake = fakeArtifactOperations();
      const mediaClaim = claim();
      const custody = createProductionMediaArtifactCustody({ db: {} as never, artifactRoot: root,
        artifactOperations: fake.operations, resolveHumanCreator: async current => {
          expect(current.receiptId).toBe(mediaClaim.receiptId);
          return origin;
        } });
      const result = await custody.committerFor({ ...mediaClaim, state: "saving" }).commit({
        finalPath, receiptId: mediaClaim.receiptId, mimeType: "video/mp4", size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(result.artifactInternalId).toBeTruthy();
    }
    expect(observed).toHaveLength(1);
    expect(observed[0]?.actor).toEqual({ kind: "human", userId: actorUserId });
  });
  test("commits one deterministic exact-namespace Workspace artifact and rehydrates it after restart", async () => {
    const root = await tempRoot();
    const finalDir = path.join(root, "media");
    await fsp.mkdir(finalDir);
    const finalPath = path.join(finalDir, "result.mp4");
    const bytes = mp4Bytes();
    await fsp.writeFile(finalPath, bytes);
    const fake = fakeArtifactOperations();
    const events: Array<{ id: string; artifactId: string; path: string }> = [];
    const custody = createProductionMediaArtifactCustody({
      db: {} as never,
      artifactRoot: root,
      artifactOperations: fake.operations,
      emitArtifactChanged: (event) => events.push(event),
    });
    const mediaClaim = claim();
    const creations: WorkspaceArtifactCreatedFact[] = [];
    setWorkspaceArtifactCreatedSink((fact) => { creations.push(fact); });
    const agentClaim = { ...mediaClaim, initiatingAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const input = {
      finalPath,
      receiptId: mediaClaim.receiptId,
      mimeType: "video/mp4" as const,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };

    const first = await custody.committerFor(agentClaim as never).commit(input);
    const replay = await custody.committerFor(agentClaim as never).commit(input);
    expect(creations).toEqual([{
      artifactInternalId: first.artifactInternalId, namespaceId: mediaClaim.namespaceId,
      occurrenceKey: `media:${mediaClaim.receiptId}`,
      actor: { kind: "agent", agentId: agentClaim.initiatingAgentId },
    }]);
    expect(replay).toEqual(first);
    expect(fake.inserts).toBe(1);
    expect(fake.attachments).toBe(1);
    expect(fake.namespaces.get(first.artifactInternalId)).toEqual([mediaClaim.namespaceId]);
    expect(events).toHaveLength(2);
    expect(await custody.findCommitted(mediaClaim as never)).toEqual(first);
    expect(fake.rows.get(first.artifactInternalId)).toMatchObject({
      artifactId: first.artifactId,
      path: `generated-media/${mediaClaim.receiptId}.mp4`,
      mimeType: "video/mp4",
      size: bytes.byteLength,
    });

    const duplicatePath = path.join(finalDir, "duplicate-result.mp4");
    await fsp.writeFile(duplicatePath, bytes);
    await custody.committerFor(mediaClaim as never).commit({ ...input, finalPath: duplicatePath });
    expect(await fsp.stat(duplicatePath).catch(() => null)).toBeNull();
    expect(await fsp.stat(finalPath).then((value) => value.isFile())).toBe(true);
    expect(fake.inserts).toBe(1);
  });

  test("a deterministic-id row in another namespace fails closed without cross-binding", async () => {
    const root = await tempRoot();
    const finalDir = path.join(root, "media");
    await fsp.mkdir(finalDir);
    const finalPath = path.join(finalDir, "result.mp4");
    const bytes = mp4Bytes();
    await fsp.writeFile(finalPath, bytes);
    const fake = fakeArtifactOperations();
    const firstClaim = claim("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const first = createProductionMediaArtifactCustody({ db: {} as never, artifactRoot: root, artifactOperations: fake.operations });
    const input = {
      finalPath, receiptId: firstClaim.receiptId, mimeType: "video/mp4" as const,
      size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await first.committerFor(firstClaim as never).commit(input);

    const conflictingClaim = claim("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const error = await captureError(first.committerFor(conflictingClaim as never).commit(input));
    expect(error).toMatchObject({ name: "MediaArtifactIndexCommitError", commitCertainty: "unknown" });
    expect(fake.attachments).toBe(1);
    expect([...fake.namespaces.values()]).toEqual([[firstClaim.namespaceId]]);
  });

  test("rejects a symlinked final path that escapes the configured artifact root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const bytes = mp4Bytes();
    const outsideFile = path.join(outside, "escaped.mp4");
    await fsp.writeFile(outsideFile, bytes);
    const mediaDir = path.join(root, "media");
    await fsp.mkdir(mediaDir);
    const linked = path.join(mediaDir, "linked.mp4");
    await fsp.symlink(outsideFile, linked);
    const fake = fakeArtifactOperations();
    const custody = createProductionMediaArtifactCustody({ db: {} as never, artifactRoot: root, artifactOperations: fake.operations });
    const error = await captureError(custody.committerFor(claim() as never).commit({
      finalPath: linked, receiptId: claim().receiptId, mimeType: "video/mp4",
      size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    expect(error).toMatchObject({ name: "MediaArtifactIndexCommitError", commitCertainty: "not_committed" });
    expect(fake.inserts).toBe(0);
  });

  test("scheduler never overlaps and stop-during-flight prevents a next timer", async () => {
    const callbacks: Array<() => void> = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const scheduler = createMediaGenerationWorkerScheduler({
      runOnce: async () => { calls += 1; await pending; },
      setTimer(callback) {
        callbacks.push(callback);
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimer() {},
    });
    scheduler.start();
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    await Promise.resolve();
    expect(calls).toBe(1);
    scheduler.stop();
    release();
    await pending;
    await Promise.resolve();
    expect(callbacks).toHaveLength(0);
    expect(scheduler.running).toBe(false);
  });

  test("missing Venice credentials do not start a worker", () => {
    let schedulerCreations = 0;
    expect(installProductionMediaGenerationWorker({
      resolveKey: () => "  ",
      schedulerFactory() {
        schedulerCreations += 1;
        throw new Error("must not construct");
      },
    })).toBe(false);
    expect(schedulerCreations).toBe(0);
  });

  test("wakes the exact initiating Genie once with a bounded provider-opaque completion note", async () => {
    const claimedAt = new Date("2030-01-01T00:00:00.000Z");
    const wake: ClaimedMediaGenerationCompletionWake = {
      receiptId: "mg_0123456789abcdef",
      ownerId: "11111111-1111-4111-8111-111111111111",
      roomId: "22222222-2222-4222-8222-222222222222",
      namespaceId: "33333333-3333-4333-8333-333333333333",
      revision: 12,
      kind: "video",
      initiatingAgentId: "44444444-4444-4444-8444-444444444444",
      initiatingThreadId: "thread-exact-genie",
      claimedAt,
    };
    const acceptedInputs: Record<string, unknown>[] = [];
    let completed = 0;
    let released = 0;
    const result = await deliverProductionMediaGenerationCompletionWakes({
      assertInvocation: async () => {},
      assertServerFunding: async () => {},
      db: {} as never,
      now: () => new Date("2030-01-01T00:00:01.000Z"),
      resolveEnvelope: async () => ({ safe: "envelope" }),
      jobs: {
        async createSystemForegroundJob(_owner, _requestor, _lane, input) {
          acceptedInputs.push(input);
          return { id: "wake-job", virtualJobId: "wake-job" };
        },
      },
      operations: {
        claim: async () => [wake],
        complete: async () => { completed += 1; return true; },
        release: async () => { released += 1; return true; },
      } as never,
    });
    expect(result).toEqual({ claimed: 1, delivered: 1 });
    expect(completed).toBe(1);
    expect(released).toBe(0);
    expect(acceptedInputs).toHaveLength(1);
    expect(acceptedInputs[0]).toMatchObject({
      causalHumanUserId: wake.ownerId,
      agentId: wake.initiatingAgentId,
      roomId: wake.roomId,
      graphThreadId: wake.initiatingThreadId,
      metadata: { originatedBy: "media_generation", receiptId: wake.receiptId },
    });
    const note = String(acceptedInputs[0]?.["message"]);
    expect(note).toContain("now durably saved to Workspace");
    expect(note).not.toMatch(/prompt|lyrics|provider|queue|https?:\/\//iu);
  });

  test("does not enqueue a completion wake after server-funding authority is denied", async () => {
    const wake: ClaimedMediaGenerationCompletionWake = {
      receiptId: "mg_fedcba9876543210",
      ownerId: "11111111-1111-4111-8111-111111111111",
      roomId: "22222222-2222-4222-8222-222222222222",
      namespaceId: "33333333-3333-4333-8333-333333333333",
      revision: 4,
      kind: "music",
      initiatingAgentId: "44444444-4444-4444-8444-444444444444",
      initiatingThreadId: "thread-denied-wake",
      claimedAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    let enqueued = 0;
    let completed = 0;
    let released = 0;
    const result = await deliverProductionMediaGenerationCompletionWakes({
      assertInvocation: async () => {},
      assertServerFunding: async (humanUserId) => {
        throw new ServerProviderCredentialsDeniedError(humanUserId, "media_completion_wake");
      },
      db: {} as never,
      jobs: {
        async createSystemForegroundJob() {
          enqueued += 1;
          return { id: "must-not-enqueue", virtualJobId: "must-not-enqueue" };
        },
      },
      operations: {
        claim: async () => [wake],
        complete: async () => { completed += 1; return true; },
        release: async () => { released += 1; return true; },
      } as never,
    });

    expect(result).toEqual({ claimed: 1, delivered: 0 });
    expect(enqueued).toBe(0);
    expect(completed).toBe(1);
    expect(released).toBe(0);
  });

  test("per-model output caps are conservative for browser-backed playback", () => {
    expect(MEDIA_GENERATION_MAX_BYTES).toEqual({
      "seedance-2-5-text-to-video-basic": 512 * 1024 * 1024,
      "seedance-2-5-reference-to-video-basic": 512 * 1024 * 1024,
      "minimax-h3-enhanced-text-to-video": 512 * 1024 * 1024,
      "sonilo-v1-1-music": 128 * 1024 * 1024,
      "minimax-music-v26": 128 * 1024 * 1024,
    });
  });
});
