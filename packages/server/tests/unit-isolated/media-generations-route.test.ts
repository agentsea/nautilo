import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Artifact, MediaGeneration, MediaGenerationScope } from "@nautilo/db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  mediaGenerationsRoutes,
  type MediaGenerationsRouteService,
} from "../../src/routes/media-generations";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ROOM_ID = "33333333-3333-4333-8333-333333333333";
const NAMESPACE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_NAMESPACE_ID = "55555555-5555-4555-8555-555555555555";
const RECEIPT_ID = "media-receipt-20260814";
const apps: FastifyInstance[] = [];

function envelope(overrides: Partial<MemoryAccessEnvelope> = {}): MemoryAccessEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: OWNER_ID,
    actorId: OWNER_ID,
    agentId: "workbench-agent",
    roomId: ROOM_ID,
    readableNamespaces: [NAMESPACE_ID],
    mutableNamespaces: [NAMESPACE_ID],
    writableNamespaces: [NAMESPACE_ID],
    toolPolicy: {},
    ...overrides,
  } as MemoryAccessEnvelope;
}

function surplusFundingBinding(): NonNullable<MediaGeneration["fundingBinding"]> {
  return {
    humanUserId: OWNER_ID,
    provider: "surplus",
    binding: { kind: "server", providerRoute: "surplus" },
    credentialFingerprint: "fingerprint-not-for-the-wire",
  };
}

function generation(
  state: MediaGeneration["state"],
  overrides: Partial<MediaGeneration> = {},
): MediaGeneration {
  const terminal = state === "needs_action" || state === "failed" || state === "unknown";
  return {
    id: "66666666-6666-4666-8666-666666666666",
    receiptId: RECEIPT_ID,
    ownerId: OWNER_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    kind: "video",
    provider: "venice",
    providerModel: "seeddance-2.5",
    providerAccountFingerprint: "fingerprint-not-for-the-wire",
    fundingBinding: null,
    providerQueueId: "provider-queue-secret",
    admissionToken: "77777777-7777-4777-8777-777777777777",
    admissionStartedAt: new Date(),
    approvalDigest: "a".repeat(64),
    quoteDigest: "b".repeat(64),
    safeSnapshot: {
      version: 1,
      normalizedSettings: { durationSeconds: 5, aspectRatio: "16:9" },
      inputSummary: { promptCharacters: 44 },
    },
    requestPayload: {
      version: 1,
      model: "seeddance-2.5",
      prompt: "the raw creative prompt must never leave the server",
      normalizedSettings: { durationSeconds: 5, aspectRatio: "16:9" },
    },
    quotedUsdMicros: 410_000,
    state,
    revision: 4,
    safeFailure: terminal
      ? {
          code: "PROVIDER_BODY_SHOULD_NOT_LEAK",
          phase: "queue",
          retrySafe: true,
          stateChanged: false,
          completionCertainty: "accepted",
          chargeCertainty: "unknown",
          recoveryActions: ["retry_same_receipt"],
        }
      : null,
    providerExecutionSeconds: null,
    providerAverageExecutionSeconds: null,
    cancellationRequestedAt: null,
    cancellationProviderAcknowledgedAt: null,
    artifactInternalId: state === "ready"
      ? "88888888-8888-4888-8888-888888888888"
      : null,
    cleanupState: "completed",
    cleanupCompletedAt: new Date(),
    claimOwner: null,
    claimExpiresAt: null,
    nextAttemptAt: new Date(),
    acceptedAt: new Date(),
    readyAt: state === "ready" ? new Date() : null,
    terminalAt: terminal ? new Date() : null,
    retainUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MediaGeneration;
}

function artifact(): Artifact {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    artifactId: "art-media-20260814",
    revision: 1,
    path: "media/2026-08-14/scene.mp4",
    mimeType: "video/mp4",
    size: 12_345,
    storageUri: "s3://private-bucket/secret-object",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

async function makeApp(input: {
  readonly row?: MediaGeneration | null;
  readonly artifact?: Artifact | null;
  readonly envelope?: MemoryAccessEnvelope;
  readonly sessionUserId?: string | null;
  readonly throwOnRead?: boolean;
  readonly onScope?: (scope: MediaGenerationScope) => void;
  readonly onCancel?: (input: MediaGenerationScope & { receiptId: string; expectedRevision: number }) => void;
  readonly cancelResult?: MediaGeneration | null;
  readonly getCapabilities?: () => Promise<string[]>;
} = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const currentEnvelope = input.envelope ?? envelope();
  const currentSessionUserId = input.sessionUserId === undefined ? OWNER_ID : input.sessionUserId;
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", (request, _reply, done) => {
    request.memoryEnvelope = currentEnvelope;
    request.sessionUserId = currentSessionUserId;
    done();
  });
  const service: MediaGenerationsRouteService = {
    findMediaGeneration: async (scope, receiptId) => {
      input.onScope?.(scope);
      if (input.throwOnRead) throw new Error("postgres unavailable: secret topology");
      return receiptId === RECEIPT_ID ? input.row ?? generation("queued") : null;
    },
    findArtifactByInternalIdForNamespaces: async () => input.artifact === undefined ? artifact() : input.artifact,
    requestCancellation: async (cancelInput) => {
      input.onCancel?.(cancelInput);
      return input.cancelResult ?? null;
    },
    getCapabilities: input.getCapabilities ?? (async () => ["use_media_generation"]),
  };
  mediaGenerationsRoutes(app, service);
  await app.ready();
  apps.push(app);
  return app;
}

async function read(app: FastifyInstance, receiptId = RECEIPT_ID, roomId = ROOM_ID) {
  return app.inject({
    method: "GET",
    url: `/api/media-generations/${receiptId}?roomId=${roomId}`,
  });
}

async function cancel(
  app: FastifyInstance,
  body: Record<string, unknown> = { roomId: ROOM_ID, expectedRevision: 4 },
  receiptId = RECEIPT_ID,
) {
  return app.inject({
    method: "POST",
    url: `/api/media-generations/${receiptId}/cancel`,
    payload: body,
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("media generation status route", () => {
  test("maps representative durable states to the closed card vocabulary", async () => {
    const cases = [
      ["prequeue", "queued"],
      ["admitting", "submitting"],
      ["retrieving", "downloading"],
      ["saving", "saving"],
      ["ready", "ready"],
      ["needs_action", "needs-action"],
      ["failed", "failed"],
      ["unknown", "unknown"],
    ] as const;

    for (const [durableState, cardState] of cases) {
      const app = await makeApp({ row: generation(durableState) });
      const response = await read(app);
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body["state"]).toBe(cardState);
      expect(body["mediaKind"]).toBe("video");
      if (durableState === "ready") expect(body["artifact"]).toMatchObject({ artifactId: "art-media-20260814" });
      if (durableState === "needs_action" || durableState === "failed" || durableState === "unknown") {
        expect(typeof (body["failure"] as { readonly message?: unknown } | undefined)?.message).toBe("string");
      }
    }
  });

  test("maps ready plus pending cleanup to cleanup-pending with its Workspace artifact", async () => {
    const app = await makeApp({
      row: generation("ready", {
        cleanupState: "pending",
        cleanupCompletedAt: null,
        safeFailure: {
          code: "VENICE_400_RESUME_RECEIPT",
          phase: "cleanup",
          retrySafe: true,
          stateChanged: true,
          completionCertainty: "accepted",
          chargeCertainty: "charged",
          recoveryActions: ["retry_same_receipt"],
        },
      }),
    });
    const response = await read(app);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      state: "cleanup-pending",
      artifact: {
        artifactId: "art-media-20260814",
        path: "media/2026-08-14/scene.mp4",
        mime: "video/mp4",
        bytes: 12_345,
      },
      recoveryActions: [],
    });
    expect(JSON.parse(response.body)).not.toHaveProperty("failure");
  });

  test("projects provider processing timing as active work, never as a countdown", async () => {
    const app = await makeApp({
      row: generation("retrieving", {
        safeFailure: {
          code: "VENICE_PROCESSING",
          phase: "retrieve",
          retrySafe: true,
          stateChanged: true,
          completionCertainty: "accepted",
          chargeCertainty: "charged",
          recoveryActions: ["retry_same_receipt"],
        },
        providerExecutionSeconds: 18,
        providerAverageExecutionSeconds: 145,
      }),
    });
    const response = await read(app);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      state: "generating",
      progress: { phase: "generating", elapsedSeconds: 18, estimatedSeconds: 145 },
    });
    expect(JSON.parse(response.body)).not.toHaveProperty("failure");
    expect(response.body).not.toContain("provider-queue-secret");
  });

  test("does not project saved timing after terminal receipt states", async () => {
    const app = await makeApp({
      row: generation("failed", {
        providerExecutionSeconds: 18,
        providerAverageExecutionSeconds: 145,
      }),
    });
    const response = await read(app);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).not.toHaveProperty("progress");
  });

  test("maps the durable music kind to the public audio media kind", async () => {
    const app = await makeApp({ row: generation("queued", { kind: "music" }) });
    const response = await read(app);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ mediaKind: "audio", state: "queued" });
  });

  test("offers cancellation only for an accepted Surplus job before saving", async () => {
    const fundingBinding = surplusFundingBinding();
    const cancellable = await makeApp({
      row: generation("retrieving", { provider: "surplus", fundingBinding, cancellationRequestedAt: null }),
    });
    expect(JSON.parse((await read(cancellable)).body)).toMatchObject({
      canCancel: true,
      cancellationRequested: false,
    });

    const requested = await makeApp({
      row: generation("retrieving", {
        provider: "surplus",
        fundingBinding,
        cancellationRequestedAt: new Date(),
      }),
    });
    expect(JSON.parse((await read(requested)).body)).toMatchObject({
      canCancel: false,
      cancellationRequested: true,
    });

    const saving = await makeApp({ row: generation("saving", { provider: "surplus", fundingBinding }) });
    expect(JSON.parse((await read(saving)).body)).toMatchObject({ canCancel: false });
  });

  test("cancels only the exact scoped revision and returns the updated receipt projection", async () => {
    let cancelInput: MediaGenerationScope & { receiptId: string; expectedRevision: number } | undefined;
    const cancellationRequestedAt = new Date("2026-08-14T12:00:00.000Z");
    const app = await makeApp({
      row: generation("retrieving", { provider: "surplus", fundingBinding: surplusFundingBinding() }),
      cancelResult: generation("retrieving", {
        provider: "surplus",
        revision: 5,
        cancellationRequestedAt,
      }),
      onCancel: (input) => { cancelInput = input; },
    });

    const response = await cancel(app);
    expect(response.statusCode).toBe(200);
    expect(cancelInput).toEqual({
      ownerId: OWNER_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      receiptId: RECEIPT_ID,
      expectedRevision: 4,
    });
    expect(JSON.parse(response.body)).toMatchObject({
      receiptId: RECEIPT_ID,
      revision: 5,
      canCancel: false,
      cancellationRequested: true,
    });
    expect(response.body).not.toContain("provider-queue-secret");
  });

  test("rejects stale, malformed, and out-of-scope cancellation without widening authority", async () => {
    const stale = await makeApp({ row: generation("retrieving", { provider: "surplus", revision: 6 }) });
    expect((await cancel(stale)).statusCode).toBe(409);
    expect((await cancel(stale, { roomId: ROOM_ID })).statusCode).toBe(400);
    expect((await cancel(stale, { roomId: ROOM_ID, expectedRevision: 4, extra: true })).statusCode).toBe(400);

    let calls = 0;
    const wrongHuman = await makeApp({
      sessionUserId: "99999999-9999-4999-8999-999999999999",
      onCancel: () => { calls += 1; },
    });
    expect((await cancel(wrongHuman)).statusCode).toBe(404);
    const ambiguousNamespace = await makeApp({
      envelope: envelope({ writableNamespaces: [NAMESPACE_ID, OTHER_NAMESPACE_ID] }),
      onCancel: () => { calls += 1; },
    });
    expect((await cancel(ambiguousNamespace)).statusCode).toBe(404);
    expect(calls).toBe(0);
  });

  test("replays a persisted cancellation intent after later worker revisions", async () => {
    const app = await makeApp({
      row: generation("retrieving", {
        provider: "surplus",
        revision: 9,
        cancellationRequestedAt: new Date("2026-08-14T12:00:00.000Z"),
        cancellationProviderAcknowledgedAt: new Date("2026-08-14T12:00:01.000Z"),
      }),
    });

    const response = await cancel(app, { roomId: ROOM_ID, expectedRevision: 4 });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      revision: 9,
      canCancel: false,
      cancellationRequested: true,
    });
  });

  test("removes the cancellation action and denies mutation after capability revocation", async () => {
    let granted = true;
    let cancellationCalls = 0;
    const app = await makeApp({
      row: generation("retrieving", { provider: "surplus", fundingBinding: surplusFundingBinding() }),
      getCapabilities: async () => granted ? ["use_media_generation"] : [],
      onCancel: () => { cancellationCalls += 1; },
    });

    expect(JSON.parse((await read(app)).body)).toMatchObject({ canCancel: true });
    granted = false;
    expect(JSON.parse((await read(app)).body)).toMatchObject({ canCancel: false });
    const response = await cancel(app);
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe(JSON.stringify({ error: "Media generation capability required" }));
    expect(cancellationCalls).toBe(0);
  });

  test("uses the exact owner, Room, and single writable namespace scope", async () => {
    let receivedScope: MediaGenerationScope | undefined;
    const app = await makeApp({ onScope: (scope) => { receivedScope = scope; } });
    const response = await read(app);
    expect(response.statusCode).toBe(200);
    expect(receivedScope).toEqual({ ownerId: OWNER_ID, roomId: ROOM_ID, namespaceId: NAMESPACE_ID });
  });

  test("returns indistinguishable 404s outside the Human, Room, or writable namespace", async () => {
    const variants = [
      { sessionUserId: "99999999-9999-4999-8999-999999999999" },
      { envelope: envelope({ roomId: OTHER_ROOM_ID }) },
      { envelope: envelope({ writableNamespaces: [NAMESPACE_ID, OTHER_NAMESPACE_ID] }) },
    ];
    for (const variant of variants) {
      const app = await makeApp(variant);
      const response = await read(app);
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(JSON.stringify({ error: "Not found" }));
    }
  });

  test("hides a ready receipt when its artifact is no longer readable", async () => {
    const app = await makeApp({ row: generation("ready"), artifact: null });
    const response = await read(app);
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(JSON.stringify({ error: "Not found" }));
  });

  test("does not serialize hostile internal receipt or artifact topology", async () => {
    const app = await makeApp({ row: generation("ready") });
    const response = await read(app);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("provider-queue-secret");
    expect(response.body).not.toContain("raw creative prompt");
    expect(response.body).not.toContain("s3://private-bucket");
    expect(response.body).not.toContain("providerAccountFingerprint");
    expect(response.body).not.toContain("admissionToken");
    expect(response.body).not.toContain("requestPayload");
    expect(response.body).not.toContain("safeSnapshot");
  });

  test("rejects malformed receipt and Room ids before receipt lookup", async () => {
    const app = await makeApp();
    expect((await read(app, "bad~receipt")).statusCode).toBe(400);
    expect((await read(app, RECEIPT_ID, "not-a-room")).statusCode).toBe(400);
  });

  test("returns a safe temporary-unavailable response when the DB is unavailable", async () => {
    const app = await makeApp({ throwOnRead: true });
    const response = await read(app);
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe(JSON.stringify({ error: "Media generation status is temporarily unavailable" }));
    expect(response.body).not.toContain("postgres");
  });
});
