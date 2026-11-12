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
  installPersonalLlmAttemptOwner,
  invokeChatModelWithFallback,
  runWithUsageContext,
} from "@nautilo/agent";
import { getPolicyResolver, initPolicyResolver, PersonalPolicyResolver } from "@nautilo/trust";
import { taskFundingFailureCode } from "@nautilo/runtime";
import { nativeTaskFundingPort } from "../../src/lib/native-task-funding";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

const MODEL_ID = "mindswapper:maker/integration-chat";
const UPSTREAM_ID = "maker/integration-chat";
const DESTINATION = "https://mindswapper-integration.example.test/v1";
const PERSONAL_KEY = `ngw_${"a".repeat(43)}`;
const REPLACEMENT_PERSONAL_KEY = `ngw_${"b".repeat(43)}`;
const SERVER_KEY = `ngw_${"c".repeat(43)}`;
const REPLACEMENT_SERVER_KEY = `ngw_${"d".repeat(43)}`;
const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
  "XAI_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "VENICE_API_KEY",
  "NAUTILO_GATEWAY_API_KEY", "NAUTILO_GATEWAY_BASE_URL", "SURPLUS_API_KEY",
  "MINDSWAPPER_API_KEY", "MINDSWAPPER_BASE_URL", "MINDSWAPPER_APPROVED_BASE_URLS",
] as const;

describe.serial("MindSwapper native Task integration", () => {
  test("executes personal and server funding and blocks old bindings after rotation", async () => {
    const savedEnv = new Map(PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
    process.env["MINDSWAPPER_APPROVED_BASE_URLS"] = DESTINATION;

    const previousFetch = globalThis.fetch;
    const previousResolver = getPolicyResolver();
    const uninstallPersonalAttemptOwner = installPersonalLlmAttemptOwner({ ownerToken: randomUUID() });
    const taskIds: string[] = [];
    const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];
    const receiptId = randomUUID();
    const serverReceiptId = randomUUID();
    let fx: AppFixture | undefined;
    let bearer = "";
    let credentialRevision: number | undefined;
    let priorPolicy: Awaited<ReturnType<typeof getServerProviderPolicy>> | undefined;

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const request = input instanceof Request ? input : undefined;
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const authorization = new Headers(init?.headers ?? request?.headers).get("authorization");
      if (url === `${DESTINATION}/key` && method === "GET") {
        expect([PERSONAL_KEY, REPLACEMENT_PERSONAL_KEY]
          .some((key) => authorization === `Bearer ${key}`)).toBe(true);
        return Response.json({ data: { label: "Synthetic integration key" } });
      }
      if (url === `${DESTINATION}/models` && method === "GET") {
        expect([PERSONAL_KEY, REPLACEMENT_PERSONAL_KEY, SERVER_KEY, REPLACEMENT_SERVER_KEY]
          .some((key) => authorization === `Bearer ${key}`)).toBe(true);
        return Response.json({
          object: "list",
          data: [{
            id: UPSTREAM_ID, object: "model", owned_by: "maker",
            gateway: {
              name: "Integration chat", available: true, endpoints: ["chat/completions"],
              chatCompletions: [{
                inputModalities: ["text"], supportedParameters: [],
                maxInputTokens: 8_192, maxOutputTokens: 128,
              }],
              cheapestInputPrice: { usdPerMillion: "1", outputUsdPerMillion: "2" },
            },
          }],
        });
      }
      if (url === `${DESTINATION}/chat/completions` && method === "POST") {
        const body = typeof init?.body === "string" ? init.body : request ? await request.text() : "{}";
        const wire = JSON.parse(body) as Record<string, unknown>;
        requests.push({ authorization, body: wire });
        const responseReceiptId = [receiptId, serverReceiptId][requests.length - 1] ?? randomUUID();
        expect(wire["model"]).toBe(UPSTREAM_ID);
        expect(body).not.toContain(PERSONAL_KEY);
        const usage = { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 };
        if (wire["stream"] === true) {
          const frames = [
            { id: responseReceiptId, object: "chat.completion.chunk", created: 1, model: UPSTREAM_ID,
              choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic MindSwapper Task response." }, finish_reason: null }] },
            { id: responseReceiptId, object: "chat.completion.chunk", created: 1, model: UPSTREAM_ID,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
          ];
          return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream", "x-request-id": responseReceiptId },
          });
        }
        return Response.json({
          id: responseReceiptId, object: "chat.completion", created: 1, model: UPSTREAM_ID,
          choices: [{ index: 0, message: { role: "assistant", content: "Synthetic MindSwapper Task response." }, finish_reason: "stop" }],
          usage,
        }, { headers: { "x-request-id": responseReceiptId } });
      }
      if (method === "GET" && url === "https://tiktoken.pages.dev/js/gpt2.json") return Response.json({});
      if (["127.0.0.1", "localhost"].includes(new URL(url).hostname)) return previousFetch(input, init);
      throw new Error("Unexpected external request in MindSwapper integration fixture");
    }) as typeof fetch;

    try {
      fx = await setupOwnerAppFixture({ suiteName: "taskmindswapper", withDefaultAgentGraph: true });
      if (!fx.defaultAgentId || !fx.defaultRoomId) throw new Error("MindSwapper Task fixture is incomplete");
      const fixture = fx;
      const roomId = fx.defaultRoomId;
      initPolicyResolver(new PersonalPolicyResolver(fixture.ownerId, fixture.defaultAgentId));
      bearer = await fixture.mintOwnerBearer();
      priorPolicy = await getServerProviderPolicy(fixture.db);
      await upsertServerProviderPolicy(fixture.db, { allowPersonalProviderKeys: true, fundingPreference: "personal_first" });
      const saved = await authedInject(fixture.app, {
        method: "PUT", url: "/api/account/provider-credentials/mindswapper", bearer,
        payload: { apiKey: PERSONAL_KEY, destination: DESTINATION },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const credential = saved.json<{ credential: { id: string; revision: number } }>().credential;
      credentialRevision = credential.revision;
      expect(saved.body).not.toContain(PERSONAL_KEY);

      const createTask = async () => {
        const created = await authedInject(fixture.app, {
          method: "POST", url: "/api/tasks", bearer,
          payload: {
            prompt: "Return the deterministic MindSwapper fixture response.",
            scheduleKind: "one_shot", runAt: "2035-01-01T00:00:00.000Z",
            targetChat: "last_in_namespace", resultDelivery: "raw", tools: [], requestedModelId: MODEL_ID,
          },
        });
        expect(created.statusCode, created.body).toBe(201);
        const taskId = created.json<{ taskId: string }>().taskId;
        taskIds.push(taskId);
        const task = await getTaskById(fixture.db, taskId);
        if (!task) throw new Error("MindSwapper Task was not persisted");
        return task;
      };

      const task = await createTask();
      const admitted = await nativeTaskFundingPort.admit(task);
      expect(admitted).toEqual({
        modelId: MODEL_ID,
        binding: {
          kind: "personal", providerRoute: "mindswapper",
          credentialId: credential.id, credentialRevision: credential.revision,
        },
      });
      const run = await insertTaskRun(fixture.db, {
        taskId: task.id, graphThreadId: `task-mindswapper:${randomUUID()}`,
        status: "running", modelId: admitted.modelId, fundingBinding: admitted.binding,
      });
      const session = await nativeTaskFundingPort.openSession(task, run, MODEL_ID, false);
      const result = await runWithUsageContext({
        callType: "chat", userId: fixture.ownerId, roomId,
        metadata: { taskId: task.id, taskRunId: run.id },
      }, () => invokeChatModelWithFallback(
        [new HumanMessage("Return the deterministic fixture response.")], [], MODEL_ID,
        fixture.ownerId, fixture.defaultAgentId!, null, undefined,
        {
          fundingHumanUserId: fixture.ownerId, fundingSession: session,
          providerTimeoutMs: 10_000, firstProgressTimeoutMs: 10_000,
          modelFallbackMode: "none", sameModelRetryMode: "none",
        },
      ));
      expect(result.response.content).toBe("Synthetic MindSwapper Task response.");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.authorization).toBe(`Bearer ${PERSONAL_KEY}`);

      const [attempt] = await fixture.db.select().from(llmUsageEvents).where(and(
        eq(llmUsageEvents.taskId, task.id), eq(llmUsageEvents.providerRequestId, receiptId),
      ));
      expect(attempt).toMatchObject({
        taskId: task.id, userId: fixture.ownerId, model: MODEL_ID, provider: "mindswapper",
        fundingKind: "personal", payerHumanId: fixture.ownerId, providerRoute: "mindswapper",
        credentialId: credential.id, credentialRevision: credential.revision,
        endpoint: "/v1/chat/completions", providerRequestId: receiptId,
        attemptOutcome: "succeeded", costState: "estimated", actualCostUsd: null,
        estimatedCostUsd: "0.00001700", inputTokens: 9, outputTokens: 4, totalTokens: 13,
      });
      expect(JSON.stringify({ task, run, attempt })).not.toContain(PERSONAL_KEY);

      const replaced = await authedInject(fixture.app, {
        method: "PUT", url: "/api/account/provider-credentials/mindswapper", bearer,
        payload: { apiKey: REPLACEMENT_PERSONAL_KEY, destination: DESTINATION, expectedRevision: credential.revision },
      });
      expect(replaced.statusCode, replaced.body).toBe(200);
      credentialRevision = replaced.json<{ credential: { revision: number } }>().credential.revision;
      expect(credentialRevision).toBe(credential.revision + 1);
      process.env["MINDSWAPPER_BASE_URL"] = DESTINATION;
      process.env["MINDSWAPPER_API_KEY"] = SERVER_KEY;
      await upsertServerProviderPolicy(fixture.db, { allowPersonalProviderKeys: true, fundingPreference: "server_first" });

      const staleSession = await session.runAttempt(MODEL_ID, async () => {
        throw new Error("A stale personal Task reached its provider callback");
      }).then(() => null, (error: unknown) => error);
      expect(taskFundingFailureCode(staleSession)).toBe("personal_credential_stale");
      const staleResume = await nativeTaskFundingPort.openSession(task, run, MODEL_ID, false)
        .then(() => null, (error: unknown) => error);
      expect(taskFundingFailureCode(staleResume)).toBe("personal_credential_stale");
      expect(requests).toHaveLength(1);

      const serverTask = await createTask();
      const serverAdmitted = await nativeTaskFundingPort.admit(serverTask);
      expect(serverAdmitted.binding).toMatchObject({ kind: "server", providerRoute: "mindswapper" });
      const serverRun = await insertTaskRun(fixture.db, {
        taskId: serverTask.id, graphThreadId: `task-mindswapper-server:${randomUUID()}`,
        status: "running", modelId: serverAdmitted.modelId, fundingBinding: serverAdmitted.binding,
      });
      const serverSession = await nativeTaskFundingPort.openSession(serverTask, serverRun, MODEL_ID, false);
      const serverResult = await runWithUsageContext({
        callType: "chat", userId: fixture.ownerId, roomId,
        metadata: { taskId: serverTask.id, taskRunId: serverRun.id },
      }, () => invokeChatModelWithFallback(
        [new HumanMessage("Return the deterministic server-funded fixture response.")], [], MODEL_ID,
        fixture.ownerId, fixture.defaultAgentId!, null, undefined,
        {
          fundingHumanUserId: fixture.ownerId, fundingSession: serverSession,
          providerTimeoutMs: 10_000, firstProgressTimeoutMs: 10_000,
          modelFallbackMode: "none", sameModelRetryMode: "none",
        },
      ));
      expect(serverResult.response.content).toBe("Synthetic MindSwapper Task response.");
      expect(requests).toHaveLength(2);
      expect(requests[1]?.authorization).toBe(`Bearer ${SERVER_KEY}`);
      const [serverAttempt] = await fixture.db.select().from(llmUsageEvents).where(and(
        eq(llmUsageEvents.taskId, serverTask.id),
        eq(llmUsageEvents.providerRequestId, serverReceiptId),
      ));
      expect(serverAttempt).toMatchObject({
        taskId: serverTask.id, userId: fixture.ownerId, model: MODEL_ID, provider: "mindswapper",
        fundingKind: "server", payerHumanId: null, providerRoute: "mindswapper",
        credentialId: null, credentialRevision: null,
        endpoint: "/v1/chat/completions", providerRequestId: serverReceiptId,
        attemptOutcome: "succeeded", costState: "estimated", actualCostUsd: null,
        estimatedCostUsd: "0.00001700", inputTokens: 9, outputTokens: 4, totalTokens: 13,
      });
      expect(serverReceiptId).not.toBe(receiptId);
      expect(JSON.stringify({ task: serverTask, run: serverRun, attempt: serverAttempt })).not.toContain(SERVER_KEY);

      process.env["MINDSWAPPER_API_KEY"] = REPLACEMENT_SERVER_KEY;
      const staleServerSession = await serverSession.runAttempt(MODEL_ID, async () => {
        throw new Error("A stale server Task reached its provider callback");
      }).then(() => null, (error: unknown) => error);
      expect(taskFundingFailureCode(staleServerSession)).toBe("funding_source_changed");
      const changedConnection = await nativeTaskFundingPort.openSession(serverTask, serverRun, MODEL_ID, false)
        .then(() => null, (error: unknown) => error);
      expect(taskFundingFailureCode(changedConnection)).toBe("funding_source_changed");
      expect(requests).toHaveLength(2);
    } finally {
      uninstallPersonalAttemptOwner();
      if (fx) {
        await fx.db.delete(llmUsageEvents).where(eq(llmUsageEvents.userId, fx.ownerId));
        for (const taskId of taskIds) await fx.db.delete(tasks).where(eq(tasks.id, taskId));
        if (bearer && credentialRevision !== undefined) {
          await authedInject(fx.app, {
            method: "DELETE", url: "/api/account/provider-credentials/mindswapper", bearer,
            payload: { expectedRevision: credentialRevision },
          });
        }
        if (priorPolicy) await upsertServerProviderPolicy(fx.db, priorPolicy);
        await fx.cleanup();
      }
      if (previousResolver) initPolicyResolver(previousResolver);
      globalThis.fetch = previousFetch;
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);
});
