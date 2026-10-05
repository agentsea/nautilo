import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import {
  and,
  eq,
  getServerProviderPolicy,
  getTaskById,
  insertTaskRun,
  llmUsageEvents,
  tasks,
  upsertServerProviderPolicy,
} from "@nautilo/db";
import {
  invokeChatModelWithFallback,
  registerAllTools,
  runWithUsageContext,
} from "@nautilo/agent";
import { ToolCatalog, clearToolCatalog, getToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { getPolicyResolver, initPolicyResolver, PersonalPolicyResolver } from "@nautilo/trust";
import { nativeTaskFundingPort } from "../../src/lib/native-task-funding";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

const MODEL_ID = "openrouter:moonshotai/kimi-k3";
const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "XAI_API_KEY",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "VENICE_API_KEY",
  "NAUTILO_GATEWAY_API_KEY",
  "NAUTILO_GATEWAY_BASE_URL",
  "SURPLUS_API_KEY",
] as const;

function restoreEnvironment(saved: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe.serial("native Task personal Surplus execution", () => {
  test("admits a Surplus-only signed model and records its exact personal marketplace wire", async () => {
    const savedEnv = new Map(PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of PROVIDER_ENV_KEYS) delete process.env[key];

    const priorFetch = globalThis.fetch;
    const priorResolver = getPolicyResolver();
    const priorCatalog = getToolCatalog();
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);

    const personalKey = `synthetic-personal-surplus-${randomUUID()}`;
    const providerRequestId = `surplus-task-${randomUUID()}`;
    const wireRequests: Array<{ authorization: string | null; body: string }> = [];
    let fx: AppFixture | undefined;
    let bearer = "";
    let taskId: string | undefined;
    let credentialRevision: number | undefined;
    let priorPolicy: Awaited<ReturnType<typeof getServerProviderPolicy>> | undefined;
    let priorPreferSurplus: boolean | undefined;

    const testFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const request = input instanceof Request ? input : undefined;
      const headers = new Headers(init?.headers ?? request?.headers);
      if (url === "https://api.surplusintelligence.ai/v1/buyer/me"
        || url === "https://api.surplusintelligence.ai/v1/requests") {
        expect(headers.get("authorization")).toBe(`Bearer ${personalKey}`);
        return Response.json({ ok: true });
      }
      if (url === "https://api.surplusintelligence.ai/v1/chat/completions") {
        const body = typeof init?.body === "string"
          ? init.body
          : request
            ? await request.text()
            : "{}";
        wireRequests.push({ authorization: headers.get("authorization"), body });
        const chunks = [
          {
            id: "chatcmpl-personal-surplus-task",
            object: "chat.completion.chunk",
            created: 1,
            model: "moonshotai/kimi-k3",
            choices: [{
              index: 0,
              delta: { role: "assistant", content: "Synthetic Surplus Task response." },
              finish_reason: null,
            }],
          },
          {
            id: "chatcmpl-personal-surplus-task",
            object: "chat.completion.chunk",
            created: 1,
            model: "moonshotai/kimi-k3",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 9,
              completion_tokens: 4,
              total_tokens: 13,
              buyer_cost_micro: 321,
            },
          },
        ];
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-request-id": providerRequestId,
              "x-si-provider-family": "openrouter",
              "x-si-marketplace-attempts": "1",
              "x-si-buyer-cost-micro": "321",
              "x-si-truncated": "0",
            },
          },
        );
      }
      const hostname = new URL(url).hostname;
      if (hostname === "127.0.0.1" || hostname === "localhost") {
        return priorFetch(input, init);
      }
      const method = init?.method ?? request?.method ?? "GET";
      if (method === "GET" && url === "https://tiktoken.pages.dev/js/gpt2.json") {
        // Keep token-estimation fallback hermetic. An unavailable encoding
        // asset must not turn this provider-wire test into a network test.
        return Response.json({});
      }
      throw new Error(`Unexpected outbound request in personal Surplus Task test: ${url}`);
    };
    globalThis.fetch = testFetch as typeof fetch;

    try {
      fx = await setupOwnerAppFixture({
        suiteName: "taskpersonalsurplus",
        withDefaultAgentGraph: true,
      });
      if (!fx.defaultAgentId || !fx.defaultRoomId) {
        throw new Error("owner personal Surplus Task fixture is incomplete");
      }
      initPolicyResolver(new PersonalPolicyResolver(fx.ownerId, fx.defaultAgentId));
      bearer = await fx.mintOwnerBearer();
      priorPolicy = await getServerProviderPolicy(fx.db);
      await upsertServerProviderPolicy(fx.db, {
        allowPersonalProviderKeys: true,
        fundingPreference: "personal_first",
      });

      const priorModels = await authedInject(fx.app, {
        method: "GET",
        url: "/api/admin/server-models",
        bearer,
      });
      expect(priorModels.statusCode, priorModels.body).toBe(200);
      priorPreferSurplus = priorModels.json<{ preferSurplus: boolean }>().preferSurplus;
      const enabled = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/server-models",
        bearer,
        payload: { preferSurplus: true },
      });
      expect(enabled.statusCode, enabled.body).toBe(200);

      const saved = await authedInject(fx.app, {
        method: "PUT",
        url: "/api/account/provider-credentials/surplus",
        bearer,
        payload: { apiKey: personalKey },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.body).not.toContain(personalKey);
      const credential = saved.json<{
        credential: { id: string; revision: number; receiptReadStatus: string };
      }>().credential;
      credentialRevision = credential.revision;
      expect(credential.receiptReadStatus).toBe("available");

      const created = await authedInject(fx.app, {
        method: "POST",
        url: "/api/tasks",
        bearer,
        payload: {
          prompt: "Return the deterministic Surplus fixture response.",
          scheduleKind: "one_shot",
          runAt: "2035-01-01T00:00:00.000Z",
          targetChat: "last_in_namespace",
          resultDelivery: "raw",
          tools: [],
          requestedModelId: MODEL_ID,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      taskId = created.json<{ taskId: string }>().taskId;
      const task = await getTaskById(fx.db, taskId);
      if (!task) throw new Error("personal Surplus Task reload failed");

      const admitted = await nativeTaskFundingPort.admit(task);
      expect(admitted).toEqual({
        modelId: MODEL_ID,
        binding: {
          kind: "personal",
          providerRoute: "surplus",
          credentialId: credential.id,
          credentialRevision: credential.revision,
        },
      });
      const run = await insertTaskRun(fx.db, {
        taskId,
        graphThreadId: `native-task-personal-surplus:${randomUUID()}`,
        status: "running",
        modelId: admitted.modelId,
        fundingBinding: admitted.binding,
      });
      const session = await nativeTaskFundingPort.openSession(
        task,
        run,
        admitted.modelId,
        false,
      );
      const result = await runWithUsageContext({
        callType: "chat",
        userId: fx.ownerId,
        roomId: fx.defaultRoomId,
        metadata: { taskId, taskRunId: run.id },
      }, () => invokeChatModelWithFallback(
        [new HumanMessage("Return the deterministic fixture response.")],
        [],
        admitted.modelId,
        fx!.ownerId,
        fx!.defaultAgentId!,
        null,
        undefined,
        {
          fundingHumanUserId: fx!.ownerId,
          fundingSession: session,
          providerTimeoutMs: 10_000,
          firstProgressTimeoutMs: 10_000,
          modelFallbackMode: "none",
          sameModelRetryMode: "none",
        },
      ));

      expect(result.response.content).toBe("Synthetic Surplus Task response.");
      expect(wireRequests).toHaveLength(1);
      expect(wireRequests[0]?.authorization).toBe(`Bearer ${personalKey}`);
      expect(wireRequests[0]?.body).not.toContain(personalKey);
      expect(JSON.parse(wireRequests[0]?.body ?? "{}")).toMatchObject({
        model: "moonshotai/kimi-k3",
        provider: "openrouter",
        stream: true,
      });

      const [attempt] = await fx.db.select().from(llmUsageEvents).where(and(
        eq(llmUsageEvents.taskId, taskId),
        eq(llmUsageEvents.providerRequestId, providerRequestId),
      ));
      expect(attempt).toMatchObject({
        userId: fx.ownerId,
        taskId,
        model: MODEL_ID,
        provider: "openrouter",
        endpoint: "/v1/chat/completions",
        fundingKind: "personal",
        payerHumanId: fx.ownerId,
        providerRoute: "surplus",
        credentialId: credential.id,
        credentialRevision: credential.revision,
        providerRequestId,
        attemptOutcome: "succeeded",
        costState: "actual",
        actualCostUsd: "0.00032100",
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 13,
        recoveryState: null,
      });
      expect(JSON.stringify({ task, run, attempt })).not.toContain(personalKey);
    } finally {
      if (fx) {
        await fx.db.delete(llmUsageEvents).where(eq(llmUsageEvents.userId, fx.ownerId));
        if (taskId) await fx.db.delete(tasks).where(eq(tasks.id, taskId));
        if (bearer && credentialRevision !== undefined) {
          await authedInject(fx.app, {
            method: "DELETE",
            url: "/api/account/provider-credentials/surplus",
            bearer,
            payload: { expectedRevision: credentialRevision },
          });
        }
        if (bearer && priorPreferSurplus !== undefined) {
          await authedInject(fx.app, {
            method: "POST",
            url: "/api/admin/server-models",
            bearer,
            payload: { preferSurplus: priorPreferSurplus },
          });
        }
        if (priorPolicy) await upsertServerProviderPolicy(fx.db, priorPolicy);
        await fx.cleanup();
      }
      if (priorResolver) initPolicyResolver(priorResolver);
      if (priorCatalog) initToolCatalog(priorCatalog);
      else clearToolCatalog();
      globalThis.fetch = priorFetch;
      restoreEnvironment(savedEnv);
    }
  }, 30_000);
});
