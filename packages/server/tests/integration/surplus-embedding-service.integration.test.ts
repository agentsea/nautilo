import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, type Mock, spyOn, test } from "bun:test";
import {
  embedTextWithProvenance,
  getMemoryEmbeddingDisclosure,
} from "@nautilo/agent";
import { setConfigOverrides } from "@nautilo/config";
import * as dbModule from "@nautilo/db";
import {
  __setLlmUsageDbForTests,
  createDirectDb,
  ensureDatabase,
  eq,
  inArray,
  listPendingSurplusAttempts,
  llmUsageEvents,
  type DirectDatabase,
  type SurplusPendingAttempt,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createSurplusCostRecovery } from "../../src/lib/surplus-cost-reconciliation";

const MODEL_ID = "venice:text-embedding-3-large";
const MODEL = "text-embedding-3-large";
const DIMENSIONS = 1_536;
const SURPLUS_KEY = "synthetic-surplus-embedding-service-key";
const SURPLUS_EMBEDDINGS_URL = "https://api.surplusintelligence.ai/v1/embeddings";
const SURPLUS_REQUESTS_URL = "https://api.surplusintelligence.ai/v1/requests/";

let db: DirectDatabase;
let originalFetch: typeof fetch;
let priorSurplusKey: string | undefined;
let serverConfigSpy: Mock<typeof dbModule.getCachedServerModelConfigRow>;
const attemptIds: string[] = [];
let fetchHandler: typeof fetch;

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestBody(body: unknown): unknown {
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(body) as unknown;
}

function response(input: {
  requestId: string;
  status?: number;
  costMicro?: number;
  model?: string;
  dimensions?: number;
}): Response {
  const headers = new Headers({
    "x-request-id": input.requestId,
    "x-si-provider-family": "Mordiem",
    "x-si-adapted-params": "safe_mode",
  });
  if (input.costMicro !== undefined) {
    headers.set("x-si-buyer-cost-micro", String(input.costMicro));
  }
  const dimensions = input.dimensions ?? DIMENSIONS;
  return Response.json({
    model: input.model ?? MODEL,
    data: [{ index: 0, embedding: Array.from({ length: dimensions }, (_, index) => index / dimensions) }],
    usage: { prompt_tokens: 3, total_tokens: 3 },
  }, { status: input.status ?? 200, headers });
}

async function rowForRequest(requestId: string) {
  const [row] = await db.select().from(llmUsageEvents)
    .where(eq(llmUsageEvents.providerRequestId, requestId));
  if (!row) throw new Error(`Missing synthetic embedding attempt ${requestId}`);
  if (!attemptIds.includes(row.id)) attemptIds.push(row.id);
  return row;
}

async function until(assertion: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
  __setLlmUsageDbForTests(db);

  originalFetch = globalThis.fetch;
  priorSurplusKey = process.env["SURPLUS_API_KEY"];
  process.env["SURPLUS_API_KEY"] = SURPLUS_KEY;
  setConfigOverrides({
    nautilo_embedding_model: MODEL_ID,
    nautilo_embedding_dims: DIMENSIONS,
  });
  serverConfigSpy = spyOn(dbModule, "getCachedServerModelConfigRow").mockReturnValue({
    embeddingModel: MODEL_ID,
    preferSurplus: true,
  } as NonNullable<ReturnType<typeof dbModule.getCachedServerModelConfigRow>>);
  globalThis.fetch = ((input, init) => fetchHandler(input, init)) as typeof fetch;
}, 120_000);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (priorSurplusKey === undefined) delete process.env["SURPLUS_API_KEY"];
  else process.env["SURPLUS_API_KEY"] = priorSurplusKey;
  setConfigOverrides({});
  serverConfigSpy?.mockRestore();
  __setLlmUsageDbForTests(null);
  if (db) {
    if (attemptIds.length > 0) {
      await db.delete(llmUsageEvents).where(inArray(llmUsageEvents.id, attemptIds));
    }
    await db.end();
  }
});

describe.serial("service-funded Surplus embeddings", () => {
  test("persists the qualified canonical space, serving provider, and zero actual cost", async () => {
    const requestId = `embedding-zero-${randomUUID()}`;
    let wires = 0;
    fetchHandler = (async (input, init) => {
      wires++;
      expect(requestUrl(input)).toBe(SURPLUS_EMBEDDINGS_URL);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SURPLUS_KEY}`);
      expect(requestBody(init?.body)).toEqual({
        model: MODEL,
        input: ["durable private memory"],
        dimensions: DIMENSIONS,
      });
      return response({ requestId, costMicro: 0 });
    }) as typeof fetch;

    const disclosure = getMemoryEmbeddingDisclosure();
    const result = await embedTextWithProvenance("durable private memory", undefined, {
      provider: "venice",
      model: MODEL,
      dimensions: DIMENSIONS,
      disclosure,
    });
    expect(result).toMatchObject({
      provider: "venice",
      canonicalModel: MODEL,
      dimensions: DIMENSIONS,
    });
    expect(result.vector).toHaveLength(DIMENSIONS);
    expect(wires).toBe(1);

    expect(await rowForRequest(requestId)).toMatchObject({
      callType: "embedding",
      provider: "venice",
      model: MODEL_ID,
      fundingKind: "service",
      providerRoute: "surplus",
      endpoint: "/v1/embeddings",
      servingProvider: "mordiem",
      attemptOutcome: "succeeded",
      costState: "actual",
      actualCostUsd: "0.00000000",
      inputTokens: 3,
      totalTokens: 3,
    });
  });

  test("reconciles one pending embedding through the exact qualified receipt", async () => {
    const requestId = `embedding-pending-${randomUUID()}`;
    let posts = 0;
    let receiptReads = 0;
    fetchHandler = (async (input, init) => {
      const url = requestUrl(input);
      if (url === SURPLUS_EMBEDDINGS_URL) {
        posts++;
        return response({ requestId });
      }
      if (url === `${SURPLUS_REQUESTS_URL}${requestId}`) {
        receiptReads++;
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SURPLUS_KEY}`);
        return Response.json({
          request_id: requestId,
          model: "venice-embed-1",
          provider: "mordiem",
          settlement_status: "accrued",
          settlement_type: "credit",
          settlement_error: null,
          confirmed_at: "2026-10-21T10:00:00.000Z",
          buyer_cost_micro: 283,
        });
      }
      throw new Error(`Unexpected synthetic request: ${url}`);
    }) as typeof fetch;

    const disclosure = getMemoryEmbeddingDisclosure();
    const result = await embedTextWithProvenance("pending private memory", undefined, {
      provider: "venice", model: MODEL, dimensions: DIMENSIONS, disclosure,
    });
    expect(result.vector).toHaveLength(DIMENSIONS);
    const pending = await rowForRequest(requestId);
    expect(pending).toMatchObject({
      attemptOutcome: "succeeded",
      costState: "pending",
      actualCostUsd: null,
      servingProvider: "mordiem",
    });

    const recovery = createSurplusCostRecovery({
      now: () => Date.now() + 120_000,
      list: async (input) => (await listPendingSurplusAttempts(input))
        .filter((row) => row.id === pending.id),
      resolveServerCredential: () => SURPLUS_KEY,
      resolveCredential: (row: SurplusPendingAttempt) => {
        if (row.id !== pending.id) throw new Error("Recovery escaped the synthetic embedding attempt");
        return { status: "available", apiKey: SURPLUS_KEY, receiptReadStatus: "unknown" };
      },
      requeueBlockedServer: async () => 0,
      requeueBlockedDecisions: async () => 0,
    });
    try {
      recovery.wake();
      await until(async () => {
        expect(await rowForRequest(requestId)).toMatchObject({
          attemptOutcome: "succeeded",
          costState: "actual",
          actualCostUsd: "0.00028300",
          recoveryState: null,
        });
      });
    } finally {
      await recovery.stop();
    }
    expect(posts).toBe(1);
    expect(receiptReads).toBe(1);
  });

  test("does not fall back or replay a transient marketplace failure", async () => {
    const requestId = `embedding-unavailable-${randomUUID()}`;
    let wires = 0;
    fetchHandler = (async (input) => {
      expect(requestUrl(input)).toBe(SURPLUS_EMBEDDINGS_URL);
      wires++;
      return response({ requestId, status: 503, costMicro: 0 });
    }) as typeof fetch;

    const error = await embedTextWithProvenance("unavailable private memory", undefined, {
      provider: "venice", model: MODEL, dimensions: DIMENSIONS,
      disclosure: getMemoryEmbeddingDisclosure(),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "request_failed",
      provider: "venice",
      status: 503,
      retryable: true,
    });
    expect(wires).toBe(1);
    expect(await rowForRequest(requestId)).toMatchObject({
      attemptOutcome: "failed",
      costState: "actual",
      actualCostUsd: "0.00000000",
      failureCode: "provider_unavailable",
    });
  });

  test("rejects wrong model and dimension responses without returning their vectors", async () => {
    for (const invalid of [
      { model: "text-embedding-3-small", dimensions: DIMENSIONS },
      { model: MODEL, dimensions: DIMENSIONS - 1 },
    ]) {
      const requestId = `embedding-invalid-${randomUUID()}`;
      let wires = 0;
      fetchHandler = (async () => {
        wires++;
        return response({ requestId, costMicro: 0, ...invalid });
      }) as unknown as typeof fetch;
      const error = await embedTextWithProvenance("invalid private memory", undefined, {
        provider: "venice", model: MODEL, dimensions: DIMENSIONS,
        disclosure: getMemoryEmbeddingDisclosure(),
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "invalid_response", provider: "venice" });
      expect(error).not.toHaveProperty("vector");
      expect(wires).toBe(1);
      expect(await rowForRequest(requestId)).toMatchObject({
        attemptOutcome: "failed",
        costState: "actual",
        actualCostUsd: "0.00000000",
        failureCode: "invalid_response",
      });
    }
  });
});
