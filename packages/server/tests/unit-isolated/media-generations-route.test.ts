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
