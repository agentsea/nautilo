import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installPersonalLlmAttemptOwner } from "@nautilo/agent";
import {
  actors,
  agents,
  beginSurplusLlmAttempt,
  channelIdentities,
  classifySurplusLlmAttemptRecovery,
  consumePersonalSoulAttempt,
  credentials,
  eq,
  groupMembers,
  groups,
  llmUsageEvents,
  PERSONAL_SOUL_WINDOW_MS,
  profiles,
  soulGenerationAttempts,
  settleSurplusLlmAttempt,
  SoulGenerationRateLimitError,
  upsertServerProviderPolicy,
  users,
} from "@nautilo/db";
import { invalidateRuntimeConfigCache } from "@nautilo/config";
import {
  assertCanUseServerFundedOwnSoul,
  ServerProviderCredentialsDeniedError,
} from "@nautilo/trust";
import {
  seatPeerUser,
  setupOwnerAppFixture,
  type AppFixture,
} from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

const SOUL_MODEL = "openrouter:minimax/minimax-m3";
const SERVER_KEY = "sk-synthetic-soul-setup-service";
const SURPLUS_KEY = "sk-synthetic-surplus-soul-setup-service";
const SURPLUS_CHAT_URL = "https://api.surplusintelligence.ai/v1/chat/completions";
const REQUEST_RUN_ID = randomUUID();
const TIKTOKEN_GPT2_URL = "https://tiktoken.pages.dev/js/gpt2.json";
const GENERATED_SOUL = [
  "# Vela — Soul File",
  "",
  "## Essence",
  "Vela is observant, practical, and quietly funny. She notices the useful detail before reaching for a grand explanation.",
  "",
  "## Tone",
  "She writes with warmth and precision, keeps promises concrete, and lets a small dry joke through when it helps.",
].join("\n");
const SURPLUS_SAVED_SOUL = [
  "# Sable — Soul File",
  "",
  "## Essence",
  "Sable notices the useful edge of a problem and answers with patient precision.",
  "",
  "## Tone",
  "Calm, exact, and lightly playful.",
].join("\n");
const SURPLUS_PREVIEW_SOUL = [
  "# Sable — Preview Soul File",
  "",
  "## Essence",
  "This second generated Soul is returned as a preview and is not saved by the stream route.",
  "",
  "## Tone",
  "Direct and observant.",
].join("\n");

type Peer = Awaited<ReturnType<typeof seatPeerUser>>;

let fx: AppFixture;
let community: Peer;
let surplusCommunity: Peer;
let surplusRecoveryCommunity: Peer;
let guest: Peer;
let originalFetch: typeof fetch;
let priorOpenRouterKey: string | undefined;
let priorGatewayKey: string | undefined;
let priorGatewayUrl: string | undefined;
let priorSoulModel: string | undefined;
let uninstallPersonalAttemptOwner: (() => void) | undefined;
const providerRequests: Array<{ authorization: string | null; stream: boolean }> = [];
const surplusProviderRequests: Array<{
  authorization: string | null;
  body: Record<string, unknown>;
  requestId: string;
}> = [];
let surplusRecoveryStart: number | undefined;

async function moveToCommunity(peer: Peer): Promise<void> {
  const [communityGroup] = await fx.db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "communities"))
    .limit(1);
  if (!communityGroup) throw new Error("canonical Communities Group missing");

  await fx.db.delete(groupMembers).where(eq(groupMembers.userId, peer.userId));
  await fx.db.insert(groupMembers).values({
    groupId: communityGroup.id,
    userId: peer.userId,
    grantedBy: peer.actorId,
  });
}

async function removePeer(peer: Peer): Promise<void> {
  await fx.db.delete(llmUsageEvents).where(eq(llmUsageEvents.userId, peer.userId));
  await fx.db.delete(profiles).where(eq(profiles.userId, peer.userId));
  await fx.db.delete(groupMembers).where(eq(groupMembers.userId, peer.userId));
  await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peer.userId));
  await fx.db.delete(credentials).where(eq(credentials.userId, peer.userId));
  await fx.db.delete(actors).where(eq(actors.ownerId, peer.userId));
  await fx.db.delete(agents).where(eq(agents.id, peer.agentId));
  await fx.db.delete(users).where(eq(users.id, peer.userId));
}

function restoreEnvironment(): void {
  if (priorOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = priorOpenRouterKey;
  if (priorGatewayKey === undefined) delete process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"];
  else process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"] = priorGatewayKey;
  if (priorGatewayUrl === undefined) delete process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
  else process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"] = priorGatewayUrl;
  if (priorSoulModel === undefined) delete process.env["NAUTILO_SOUL_GENERATOR_MODEL"];
  else process.env["NAUTILO_SOUL_GENERATOR_MODEL"] = priorSoulModel;
  invalidateRuntimeConfigCache();
}

beforeAll(async () => {
  uninstallPersonalAttemptOwner = installPersonalLlmAttemptOwner({
    ownerToken: randomUUID(),
  });
  originalFetch = globalThis.fetch;
  priorOpenRouterKey = process.env["OPENROUTER_API_KEY"];
  priorGatewayKey = process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"];
  priorGatewayUrl = process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
  priorSoulModel = process.env["NAUTILO_SOUL_GENERATOR_MODEL"];

  process.env["OPENROUTER_API_KEY"] = SERVER_KEY;
  delete process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"];
  delete process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
  process.env["NAUTILO_SOUL_GENERATOR_MODEL"] = SOUL_MODEL;
  invalidateRuntimeConfigCache();

  fx = await setupOwnerAppFixture({ suiteName: "personalsoul" });
  community = await seatPeerUser(fx.db, {
    suiteName: "personalsoul",
    groupType: "contributors",
  });
  await moveToCommunity(community);
  surplusCommunity = await seatPeerUser(fx.db, {
    suiteName: "personalsoulsurplus",
    groupType: "contributors",
  });
  await moveToCommunity(surplusCommunity);
  surplusRecoveryCommunity = await seatPeerUser(fx.db, {
    suiteName: "soulrecovery",
    groupType: "contributors",
  });
  await moveToCommunity(surplusRecoveryCommunity);
  guest = await seatPeerUser(fx.db, {
    suiteName: "personalsoul",
    groupType: "guests",
  });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request = input instanceof Request ? input : undefined;
    const method = init?.method ?? request?.method ?? "GET";
    if (method === "GET" && url === TIKTOKEN_GPT2_URL) {
      // Keep token-estimation fallback hermetic. This provider/persistence
      // fixture deliberately uses LangChain's approximate count rather than
      // turning the test into a tokenizer-asset network request.
      return Response.json({});
    }
    const headers = new Headers(init?.headers ?? request?.headers);
    const rawBody = typeof init?.body === "string"
      ? init.body
      : request
        ? await request.clone().text()
        : "{}";
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    if (url === SURPLUS_CHAT_URL) {
      const requestIndex = surplusProviderRequests.length;
      const requestId = `surplus-soul-${REQUEST_RUN_ID}-${requestIndex + 1}`;
      const soulFile = requestIndex === 0 ? SURPLUS_SAVED_SOUL : SURPLUS_PREVIEW_SOUL;
      surplusProviderRequests.push({
        authorization: headers.get("authorization"),
        body,
        requestId,
      });
      if (surplusRecoveryStart !== undefined && requestIndex - surplusRecoveryStart < 2) {
        const unavailable = requestIndex === surplusRecoveryStart;
        return Response.json({
          error: {
            code: unavailable ? "no_healthy_sellers" : "no_sellers_for_model",
            message: "Synthetic model supply refusal.",
          },
        }, {
          status: unavailable ? 503 : 404,
          headers: {
            "x-request-id": requestId,
            "x-si-provider-family": "unknown",
            "x-si-marketplace-attempts": "0",
            "x-si-truncated": "0",
          },
        });
      }
      const midpoint = Math.floor(soulFile.length / 2);
      const buyerCostMicro = 321 + requestIndex;
      const chunks = [
        {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body["model"],
          choices: [{ index: 0, delta: { role: "assistant", content: soulFile.slice(0, midpoint) }, finish_reason: null }],
        },
        {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body["model"],
          choices: [{ index: 0, delta: { content: soulFile.slice(midpoint) }, finish_reason: null }],
        },
        {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body["model"],
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 18,
            completion_tokens: 42,
            total_tokens: 60,
            buyer_cost_micro: buyerCostMicro,
          },
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": requestId,
            "x-si-provider-family": typeof body["provider"] === "string" ? body["provider"] : "openrouter",
            "x-si-marketplace-attempts": "1",
            "x-si-buyer-cost-micro": String(buyerCostMicro),
            "x-si-truncated": "0",
          },
        },
      );
    }
    if (url !== "https://openrouter.ai/api/v1/chat/completions") {
      throw new Error(`Unexpected outbound request in Soul setup integration test: ${url}`);
    }
    const stream = body["stream"] === true;
    providerRequests.push({ authorization: headers.get("authorization"), stream });
    const requestId = `direct-soul-${REQUEST_RUN_ID}-${providerRequests.length}`;

    if (stream) {
      const midpoint = Math.floor(GENERATED_SOUL.length / 2);
      const chunks = [
        {
          id: requestId,
          object: "chat.completion.chunk",
          created: 1,
          model: "minimax/minimax-m3",
          choices: [{ index: 0, delta: { role: "assistant", content: GENERATED_SOUL.slice(0, midpoint) }, finish_reason: null }],
        },
        {
          id: requestId,
          object: "chat.completion.chunk",
          created: 1,
          model: "minimax/minimax-m3",
          choices: [{ index: 0, delta: { content: GENERATED_SOUL.slice(midpoint) }, finish_reason: null }],
        },
        {
          id: requestId,
          object: "chat.completion.chunk",
          created: 1,
          model: "minimax/minimax-m3",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 18, completion_tokens: 42, total_tokens: 60 },
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }

    return Response.json({
      id: requestId,
      object: "chat.completion",
      created: 1,
      model: "minimax/minimax-m3",
      choices: [{
        index: 0,
        message: { role: "assistant", content: GENERATED_SOUL },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 18, completion_tokens: 42, total_tokens: 60 },
    });
  }) as typeof fetch;
});

afterAll(async () => {
  uninstallPersonalAttemptOwner?.();
  uninstallPersonalAttemptOwner = undefined;
  globalThis.fetch = originalFetch;
  restoreEnvironment();
  if (!fx) return;
  await upsertServerProviderPolicy(fx.db, { allowPersonalProviderKeys: false });
  if (community) await removePeer(community);
  if (surplusCommunity) await removePeer(surplusCommunity);
  if (surplusRecoveryCommunity) await removePeer(surplusRecoveryCommunity);
  if (guest) await removePeer(guest);
  await fx.cleanup();
});

describe.serial("personal-key own-Genie Soul setup service", () => {
  test("receipt recovery preserves inference diagnostics in the durable attempt", async () => {
    const attemptId = randomUUID();
    try {
      await beginSurplusLlmAttempt({
        id: attemptId, userId: fx.ownerId, callType: "soul", provider: "openrouter",
        model: SOUL_MODEL, endpoint: "/v1/chat/completions", fundingKind: "service",
        metadata: { syntheticReceiptRecovery: true },
      });
      await settleSurplusLlmAttempt({
        attemptId, outcome: "unknown", costState: "pending",
        providerRequestId: `synthetic-receipt-${attemptId}`, failureCode: "outcome_unknown",
        metadata: { surplusErrorCode: "upstream_unavailable", surplusResponseStatus: 503 },
      });
      const [before] = await fx.db.select().from(llmUsageEvents).where(eq(llmUsageEvents.id, attemptId));
      expect(before).toBeDefined();
      expect(await classifySurplusLlmAttemptRecovery({
        attemptId, expectedUpdatedAt: before!.updatedAt,
        recoveryState: "retryable", failureCode: "receipt_not_found",
      })).toBe(true);
      const [after] = await fx.db.select().from(llmUsageEvents).where(eq(llmUsageEvents.id, attemptId));
      expect(after).toMatchObject({
        attemptOutcome: "unknown", costState: "pending", actualCostUsd: null,
        failureCode: "outcome_unknown", recoveryState: "retryable",
        metadata: { syntheticReceiptRecovery: true, surplusErrorCode: "upstream_unavailable",
          surplusResponseStatus: 503, surplusReceiptRecoveryFailureCode: "receipt_not_found" },
      });
      await settleSurplusLlmAttempt({ attemptId, outcome: "unknown", costState: "actual", actualCostUsd: 0.0001,
        failureCode: "outcome_unknown" });
      expect(await classifySurplusLlmAttemptRecovery({
        attemptId, expectedUpdatedAt: after!.updatedAt,
        recoveryState: "blocked_repair", failureCode: "receipt_binding_invalid",
      })).toBe(false);
      const [settled] = await fx.db.select().from(llmUsageEvents).where(eq(llmUsageEvents.id, attemptId));
      expect(settled?.failureCode).toBe("outcome_unknown");
      expect(settled?.actualCostUsd).toBe("0.00010000");
      expect(settled?.recoveryState).toBeNull();
    } finally {
      await fx.db.delete(llmUsageEvents).where(eq(llmUsageEvents.id, attemptId));
    }
  });

  test("admits a personal-only Community Human through both endpoints and records server-funded Soul usage", async () => {
    await upsertServerProviderPolicy(fx.db, { allowPersonalProviderKeys: true });
    const requestsBefore = providerRequests.length;

    const generated = await authedInject(fx.app, {
      method: "POST",
      url: "/api/profile/generate-soul",
      bearer: community.bearer,
      payload: { name: "Vela", personalityPrompt: "Dry, observant, and kind." },
    });
    expect(generated.statusCode).toBe(200);
    expect(JSON.parse(generated.body)).toEqual({ soulFile: GENERATED_SOUL });

    const [persisted] = await fx.db
      .select({ soulFile: profiles.soulFile })
      .from(profiles)
      .where(eq(profiles.userId, community.userId))
      .limit(1);
    expect(persisted?.soulFile).toBe(GENERATED_SOUL);

    const streamed = await authedInject(fx.app, {
      method: "POST",
      url: "/api/profile/generate-soul/stream",
      bearer: community.bearer,
      payload: { name: "Vela", personalityPrompt: "Dry, observant, and kind." },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain("event: soul.started");
    expect(streamed.body).toContain("event: soul.completed");
    expect(streamed.body).toContain("Vela");

    expect(providerRequests.slice(requestsBefore)).toEqual([
      { authorization: `Bearer ${SERVER_KEY}`, stream: false },
      { authorization: `Bearer ${SERVER_KEY}`, stream: true },
    ]);

    let usage: Array<typeof llmUsageEvents.$inferSelect> = [];
    const usageDeadline = Date.now() + 5_000;
    while (Date.now() < usageDeadline) {
      usage = await fx.db
        .select()
        .from(llmUsageEvents)
        .where(eq(llmUsageEvents.userId, community.userId));
      if (usage.some((event) => event.callType === "soul")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(usage.some((event) =>
      event.callType === "soul"
      && event.fundingKind === "service"
      && event.payerHumanId === null
      && event.providerRoute === "openrouter"
      && event.metadata?.["agentId"] === community.agentId
      && event.metadata?.["service"] === "soul_generation"
    )).toBe(true);
  });

  test("uses Surplus for both real-generator endpoints while only the non-stream route persists", async () => {
    const priorOpenRouter = process.env["OPENROUTER_API_KEY"];
    const priorSurplus = process.env["SURPLUS_API_KEY"];
    const ownerBearer = await fx.mintOwnerBearer();
    const priorModelsResponse = await authedInject(fx.app, {
      method: "GET",
      url: "/api/admin/server-models",
      bearer: ownerBearer,
    });
    expect(priorModelsResponse.statusCode, priorModelsResponse.body).toBe(200);
    const priorPreferSurplus = priorModelsResponse.json<{ preferSurplus: boolean }>().preferSurplus;
    const requestsBefore = surplusProviderRequests.length;

    try {
      delete process.env["OPENROUTER_API_KEY"];
      process.env["SURPLUS_API_KEY"] = SURPLUS_KEY;
      invalidateRuntimeConfigCache();
      expect(process.env["OPENROUTER_API_KEY"]).toBeUndefined();

      const enabled = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/server-models",
        bearer: ownerBearer,
        payload: { preferSurplus: true },
      });
      expect(enabled.statusCode, enabled.body).toBe(200);

      const generated = await authedInject(fx.app, {
        method: "POST",
        url: "/api/profile/generate-soul",
        bearer: surplusCommunity.bearer,
        payload: { name: "Sable", personalityPrompt: "Patient, exact, and lightly playful." },
      });
      expect(generated.statusCode, generated.body).toBe(200);
      expect(JSON.parse(generated.body)).toEqual({ soulFile: SURPLUS_SAVED_SOUL });

      const [savedAfterGenerate] = await fx.db
        .select({ soulFile: profiles.soulFile })
        .from(profiles)
        .where(eq(profiles.userId, surplusCommunity.userId))
        .limit(1);
      expect(savedAfterGenerate?.soulFile).toBe(SURPLUS_SAVED_SOUL);

      const streamed = await authedInject(fx.app, {
        method: "POST",
        url: "/api/profile/generate-soul/stream",
        bearer: surplusCommunity.bearer,
        payload: { name: "Sable", personalityPrompt: "Direct, observant, and patient." },
      });
      expect(streamed.statusCode, streamed.body).toBe(200);
      expect(streamed.body).toContain("event: soul.started");
      expect(streamed.body).toContain("event: soul.completed");
      expect(streamed.body).toContain("Preview Soul File");

      const [savedAfterPreview] = await fx.db
        .select({ soulFile: profiles.soulFile })
        .from(profiles)
        .where(eq(profiles.userId, surplusCommunity.userId))
        .limit(1);
      expect(savedAfterPreview?.soulFile).toBe(SURPLUS_SAVED_SOUL);

      const requests = surplusProviderRequests.slice(requestsBefore);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.authorization).toBe(`Bearer ${SURPLUS_KEY}`);
        expect(request.body).toMatchObject({
          model: "minimax/minimax-m3",
          stream: true,
        });
        expect(request.body["provider"]).toBeUndefined();
      }

      const usage = await fx.db
        .select()
        .from(llmUsageEvents)
        .where(eq(llmUsageEvents.userId, surplusCommunity.userId));
      const soulUsage = usage.filter((event) => event.callType === "soul");
      expect(soulUsage).toHaveLength(2);
      expect(soulUsage.map((event) => event.providerRequestId).sort()).toEqual(
        requests.map((request) => request.requestId).sort(),
      );
      expect(soulUsage.map((event) => event.actualCostUsd).sort()).toEqual([
        "0.00032100",
        "0.00032200",
      ]);
      for (const event of soulUsage) {
        expect(event).toMatchObject({
          callType: "soul",
          fundingKind: "service",
          payerHumanId: null,
          providerRoute: "surplus",
          attemptOutcome: "succeeded",
          costState: "actual",
          servingProvider: "openrouter",
        });
        expect(event.metadata?.["agentId"]).toBe(surplusCommunity.agentId);
      }
    } finally {
      if (priorOpenRouter === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = priorOpenRouter;
      if (priorSurplus === undefined) delete process.env["SURPLUS_API_KEY"];
      else process.env["SURPLUS_API_KEY"] = priorSurplus;
      invalidateRuntimeConfigCache();
      const restored = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/server-models",
        bearer: ownerBearer,
        payload: { preferSurplus: priorPreferSurplus },
      });
      expect(restored.statusCode, restored.body).toBe(200);
    }
  });

  test("recovers both Soul endpoints using marketplace selection and later models without direct keys", async () => {
    const directKeyNames = [
      "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      "VENICE_API_KEY", "GOOGLE_API_KEY", "TYPESAFE_API_KEY",
    ] as const;
    const priorDirectKeys = directKeyNames.map((key) => [key, process.env[key]] as const);
    const priorSurplus = process.env["SURPLUS_API_KEY"];
    const ownerBearer = await fx.mintOwnerBearer();
    const priorModels = await authedInject(fx.app, {
      method: "GET", url: "/api/admin/server-models", bearer: ownerBearer,
    });
    expect(priorModels.statusCode, priorModels.body).toBe(200);
    const priorPreferSurplus = priorModels.json<{ preferSurplus: boolean }>().preferSurplus;
    const directBefore = providerRequests.length;
    const requestsBefore = surplusProviderRequests.length;

    try {
      for (const key of directKeyNames) delete process.env[key];
      process.env["SURPLUS_API_KEY"] = SURPLUS_KEY;
      invalidateRuntimeConfigCache();
      const enabled = await authedInject(fx.app, {
        method: "POST", url: "/api/admin/server-models", bearer: ownerBearer,
        payload: { preferSurplus: true },
      });
      expect(enabled.statusCode, enabled.body).toBe(200);

      for (const stream of [false, true]) {
        surplusRecoveryStart = surplusProviderRequests.length;
        const response = await authedInject(fx.app, {
          method: "POST",
          url: stream ? "/api/profile/generate-soul/stream" : "/api/profile/generate-soul",
          bearer: surplusRecoveryCommunity.bearer,
          payload: { name: "Sable", personalityPrompt: "Patient, exact, and lightly playful." },
        });
        expect(response.statusCode, response.body).toBe(200);
        if (stream) {
          expect(response.body).toContain("event: soul.completed");
          expect(response.body).not.toContain("event: soul.error");
        } else {
          expect(response.json<{ soulFile: string }>()).toEqual({ soulFile: SURPLUS_PREVIEW_SOUL });
        }
        const attempts = surplusProviderRequests.slice(surplusRecoveryStart);
        expect(attempts).toHaveLength(3);
        expect(attempts[0]?.body["model"]).toBe("minimax/minimax-m3");
        expect(attempts[0]?.body["provider"]).toBeUndefined();
        expect(attempts[1]?.body["model"]).toBe("minimax-m3-preview");
        expect(attempts[1]?.body["provider"]).toBe("venice");
        expect(attempts[2]?.body["model"]).not.toBe("minimax/minimax-m3");
        expect(attempts[2]?.body["model"]).not.toBe(attempts[1]?.body["model"]);
        expect(attempts[2]?.body["provider"]).toBeUndefined();
        expect(attempts.every((attempt) => attempt.authorization === `Bearer ${SURPLUS_KEY}`)).toBe(true);
      }

      expect(providerRequests).toHaveLength(directBefore);
      const requests = surplusProviderRequests.slice(requestsBefore);
      const usage = await fx.db.select().from(llmUsageEvents)
        .where(eq(llmUsageEvents.userId, surplusRecoveryCommunity.userId));
      expect(usage).toHaveLength(6);
      expect(new Set(usage.map((row) => row.id)).size).toBe(6);
      expect(usage.map((row) => row.providerRequestId ?? row.metadata?.["surplusTraceId"]).sort()).toEqual(
        requests.map((request) => request.requestId).sort(),
      );
      expect(usage.filter((row) => row.attemptOutcome === "failed")).toHaveLength(4);
      expect(usage.filter((row) => row.attemptOutcome === "succeeded")).toHaveLength(2);
      for (const row of usage) {
        expect(row).toMatchObject({ callType: "soul", fundingKind: "service", providerRoute: "surplus", payerHumanId: null });
        expect(row.metadata?.["agentId"]).toBe(surplusRecoveryCommunity.agentId);
        if (row.attemptOutcome === "failed") {
          expect(row.providerRequestId).toBeNull();
          expect(row.metadata?.["surplusTraceId"]).toBeString();
          expect(["no_healthy_sellers", "no_sellers_for_model"]
            .some((code) => code === row.metadata?.["surplusErrorCode"])).toBe(true);
          expect(row.costState).toBe("actual");
          expect(row.actualCostUsd).toBe("0.00000000");
          expect(row.recoveryState).toBeNull();
        } else {
          expect(row.costState).toBe("actual");
          expect(row.actualCostUsd).not.toBeNull();
          expect(row.model).not.toBe(SOUL_MODEL);
        }
      }
      const admissions = await fx.db.select({ id: soulGenerationAttempts.id }).from(soulGenerationAttempts)
        .where(eq(soulGenerationAttempts.humanUserId, surplusRecoveryCommunity.userId));
      expect(admissions).toHaveLength(2);
    } finally {
      surplusRecoveryStart = undefined;
      for (const [key, value] of priorDirectKeys) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (priorSurplus === undefined) delete process.env["SURPLUS_API_KEY"];
      else process.env["SURPLUS_API_KEY"] = priorSurplus;
      invalidateRuntimeConfigCache();
      const restored = await authedInject(fx.app, {
        method: "POST", url: "/api/admin/server-models", bearer: ownerBearer,
        payload: { preferSurplus: priorPreferSurplus },
      });
      expect(restored.statusCode, restored.body).toBe(200);
    }
  });

  test("a shared rolling limit counts sequential attempts across both routes but leaves server-authorized Humans unchanged", async () => {
    const third = await authedInject(fx.app, {
      method: "POST", url: "/api/profile/generate-soul", bearer: community.bearer,
      payload: { name: "Vela" },
    });
    expect(third.statusCode).toBe(200);
    const beforeRejection = providerRequests.length;
    const fourth = await authedInject(fx.app, {
      method: "POST", url: "/api/profile/generate-soul/stream", bearer: community.bearer,
      payload: { name: "Vela" },
    });
    expect(fourth.statusCode).toBe(429);
    expect(JSON.parse(fourth.body)).toMatchObject({ error: "soul_generation_limit_reached" });
    expect(providerRequests).toHaveLength(beforeRejection);
    const attempts = await fx.db.select({ id: soulGenerationAttempts.id })
      .from(soulGenerationAttempts)
      .where(eq(soulGenerationAttempts.humanUserId, community.userId));
    expect(attempts).toHaveLength(3);

    const ownerBearer = await fx.mintOwnerBearer();
    for (let index = 0; index < 4; index++) {
      const response = await authedInject(fx.app, {
        method: "POST", url: "/api/profile/generate-soul", bearer: ownerBearer,
        payload: { name: "Owner Genie" },
      });
      expect(response.statusCode).toBe(200);
    }
    const ownerAttempts = await fx.db.select({ id: soulGenerationAttempts.id })
      .from(soulGenerationAttempts)
      .where(eq(soulGenerationAttempts.humanUserId, fx.ownerId));
    expect(ownerAttempts).toHaveLength(0);
  });

  test("parallel reservations on separate database transactions cannot exceed the limit", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
      consumePersonalSoulAttempt(guest.userId, fx.db)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected").every((result) =>
      result.status === "rejected" && result.reason instanceof SoulGenerationRateLimitError)).toBe(true);
    const attempts = await fx.db.select({ id: soulGenerationAttempts.id })
      .from(soulGenerationAttempts)
      .where(eq(soulGenerationAttempts.humanUserId, guest.userId));
    expect(attempts).toHaveLength(3);

    await consumePersonalSoulAttempt(
      guest.userId,
      fx.db,
      new Date(Date.now() + PERSONAL_SOUL_WINDOW_MS + 1_000),
    );
    const afterWindow = await fx.db.select({ id: soulGenerationAttempts.id })
      .from(soulGenerationAttempts)
      .where(eq(soulGenerationAttempts.humanUserId, guest.userId));
    expect(afterWindow).toHaveLength(1);
  });

  test("fresh switch, capability, and exact ownership checks stop provider work", async () => {
    const beforeDenials = providerRequests.length;

    await upsertServerProviderPolicy(fx.db, { allowPersonalProviderKeys: false });
    for (const url of ["/api/profile/generate-soul", "/api/profile/generate-soul/stream"]) {
      const response = await authedInject(fx.app, {
        method: "POST",
        url,
        bearer: community.bearer,
        payload: { name: "Vela" },
      });
      expect(response.statusCode, url).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        code: "server_provider_credentials_required",
        capability: "use_server_provider_credentials",
      });
    }

    await upsertServerProviderPolicy(fx.db, { allowPersonalProviderKeys: true });
    for (const url of ["/api/profile/generate-soul", "/api/profile/generate-soul/stream"]) {
      const response = await authedInject(fx.app, {
        method: "POST",
        url,
        bearer: guest.bearer,
        payload: { name: "Guest Genie" },
      });
      expect(response.statusCode, url).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        code: "server_provider_credentials_required",
        capability: "use_server_provider_credentials",
      });
    }

    const foreignDenial = await assertCanUseServerFundedOwnSoul({
      humanUserId: community.userId,
      agentId: guest.agentId,
      origin: "integration_foreign_soul",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(foreignDenial).toBeInstanceOf(ServerProviderCredentialsDeniedError);

    expect(providerRequests).toHaveLength(beforeDenials);
    await upsertServerProviderPolicy(fx.db, { allowPersonalProviderKeys: false });
  });
});
