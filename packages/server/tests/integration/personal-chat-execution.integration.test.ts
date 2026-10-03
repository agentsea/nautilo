import { expect, test } from "bun:test";
import {
  and,
  desc,
  eq,
  getServerProviderPolicy,
  jobs,
  llmUsageEvents,
  sessionMessages,
  sessions,
  upsertServerProviderPolicy,
} from "@nautilo/db";
import { ToolCatalog, clearToolCatalog, getToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "@nautilo/agent";
import { setupOwnerAppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

const MODEL = "openrouter:moonshotai/kimi-k3";
const PERSONAL_KEY = "sk-synthetic-personal-chat-transport";
const SERVER_KEY = "sk-synthetic-server-chat-transport";

test.each([
  { personalKeysPresent: true, serverKeysPresent: false, preference: "personal_first" as const, expectedFunding: "personal" },
  { personalKeysPresent: true, serverKeysPresent: true, preference: "personal_first" as const, expectedFunding: "personal" },
  { personalKeysPresent: true, serverKeysPresent: true, preference: "server_first" as const, expectedFunding: "server" },
  { personalKeysPresent: true, serverKeysPresent: false, preference: "server_first" as const, expectedFunding: "personal" },
  { personalKeysPresent: false, serverKeysPresent: true, preference: "personal_first" as const, expectedFunding: "server" },
  { personalKeysPresent: false, serverKeysPresent: true, preference: "server_first" as const, expectedFunding: "server" },
])("foreground graph uses $expectedFunding funding with $preference (server: $serverKeysPresent, personal: $personalKeysPresent)", async ({ personalKeysPresent, serverKeysPresent, preference, expectedFunding }) => {
  const priorCatalog = getToolCatalog();
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
  const fx = await setupOwnerAppFixture({
    suiteName: `chat-priority-${preference}-${serverKeysPresent ? "server" : "no-server"}-${personalKeysPresent ? "personal" : "no-personal"}`,
    withDefaultAgentGraph: true,
  });
  if (!fx.defaultRoomId || !fx.defaultAgentId) throw new Error("owner Room fixture missing");
  const bearer = await fx.mintOwnerBearer();
  const priorPolicy = await getServerProviderPolicy(fx.db);
  const priorFetch = globalThis.fetch;
  const priorDirect = process.env["OPENROUTER_API_KEY"];
  const requests: Array<{ authorization: string | null; url: string; body: string }> = [];
  let credentialRevision: number | null = null;

  if (serverKeysPresent) {
    process.env["OPENROUTER_API_KEY"] = SERVER_KEY;
  } else {
    delete process.env["OPENROUTER_API_KEY"];
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://openrouter.ai/api/v1/chat/completions") {
      if (new URL(url).hostname === "127.0.0.1" || new URL(url).hostname === "localhost") {
        return priorFetch(input, init);
      }
      throw new Error("Unexpected outbound provider request in personal chat integration test");
    }
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    const body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : "";
    requests.push({ authorization: headers.get("authorization"), url, body });
    const requestPayload = JSON.parse(body) as { stream?: boolean };
    if (requestPayload.stream) {
      const chunks = [
        {
          id: "chatcmpl-personal-integration", object: "chat.completion.chunk",
          created: 1, model: "moonshotai/kimi-k3",
          choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic personal chat answer." }, finish_reason: null }],
        },
        {
          id: "chatcmpl-personal-integration", object: "chat.completion.chunk",
          created: 1, model: "moonshotai/kimi-k3",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      id: "chatcmpl-personal-integration",
      object: "chat.completion",
      created: 1,
      model: "moonshotai/kimi-k3",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Synthetic personal chat answer." },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    });
  }) as typeof fetch;

  try {
    const policySave = await authedInject(fx.app, {
      method: "POST", url: "/api/admin/server-provider-policy", bearer,
      payload: { allowPersonalProviderKeys: true, fundingPreference: preference },
    });
    expect(policySave.statusCode).toBe(200);
    expect(JSON.parse(policySave.body)).toEqual({ allowPersonalProviderKeys: true, fundingPreference: preference });
    const legacySwitch = await authedInject(fx.app, {
      method: "POST", url: "/api/admin/server-provider-policy", bearer,
      payload: { allowPersonalProviderKeys: true },
    });
    expect(legacySwitch.statusCode).toBe(200);
    expect(legacySwitch.json<{ fundingPreference: string }>().fundingPreference).toBe(preference);
    if (personalKeysPresent) {
      const saved = await authedInject(fx.app, {
        method: "PUT", url: "/api/account/provider-credentials/openrouter",
        bearer, payload: { apiKey: PERSONAL_KEY },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain(PERSONAL_KEY);
      credentialRevision = 1;
    }

    const selected = await authedInject(fx.app, {
      method: "PUT",
      url: `/api/rooms/${fx.defaultRoomId}/agents/${fx.defaultAgentId}/model-control-selection`,
      bearer,
      payload: { selection: { modelId: MODEL } },
    });
    expect(selected.statusCode, selected.body).toBe(200);

    const sent = await authedInject(fx.app, {
      method: "POST", url: "/api/chat", bearer,
      payload: { message: "Reply with one short sentence.", roomId: fx.defaultRoomId },
    });
    expect(sent.statusCode).toBe(202);
    const jobId = (JSON.parse(sent.body) as { jobId?: string }).jobId;
    expect(typeof jobId).toBe("string");

    let finalStatus = "queued";
    let finalResult: Record<string, unknown> | null = null;
    let finalInput: Record<string, unknown> | null = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const [row] = await fx.db.select({ status: jobs.status, result: jobs.result, input: jobs.input })
        .from(jobs).where(and(eq(jobs.ownerId, fx.ownerId), eq(jobs.roomId, fx.defaultRoomId)))
        .orderBy(desc(jobs.createdAt)).limit(1);
      if (row) {
        finalStatus = row.status;
        finalResult = row.result;
        finalInput = row.input;
        if (finalStatus === "completed" || finalStatus === "failed" || finalStatus === "cancelled") break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(finalStatus, JSON.stringify({
      finalResult,
      requests: requests.map((request) => ({
        url: request.url,
        personalAuthorization: request.authorization === `Bearer ${PERSONAL_KEY}`,
        stream: (JSON.parse(request.body) as { stream?: boolean }).stream,
      })),
    })).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe(`Bearer ${expectedFunding === "personal" ? PERSONAL_KEY : SERVER_KEY}`);
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requests[0]?.body).not.toContain(PERSONAL_KEY);
    expect(requests[0]?.body).not.toContain(SERVER_KEY);
    expect(JSON.stringify({ finalInput, finalResult })).not.toContain(PERSONAL_KEY);

    const transcript = await fx.db.select({ role: sessionMessages.role, content: sessionMessages.content })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .where(eq(sessions.roomId, fx.defaultRoomId));
    expect(transcript.some((message) => message.role === "assistant"
      && message.content === "Synthetic personal chat answer.")).toBe(true);

    const usage = await fx.db.select().from(llmUsageEvents)
      .where(and(eq(llmUsageEvents.userId, fx.ownerId), eq(llmUsageEvents.callType, "chat")));
    const chatUsage = usage.filter((event) => event.model === MODEL);
    expect(chatUsage.length).toBeGreaterThan(0);
    for (const event of chatUsage) {
      expect(event.fundingKind).toBe(expectedFunding);
      expect(event.providerRoute).toBe("openrouter");
      if (expectedFunding === "personal") {
        expect(event.payerHumanId).toBe(fx.ownerId);
        expect(event.credentialRevision).toBe(1);
        expect(event.credentialId).toBeTruthy();
      } else {
        expect(event.payerHumanId).toBeNull();
        expect(event.credentialId).toBeNull();
        expect(event.credentialRevision).toBeNull();
      }
    }

  } finally {
    globalThis.fetch = priorFetch;
    if (priorDirect === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = priorDirect;
    if (credentialRevision !== null) {
      await authedInject(fx.app, {
        method: "DELETE", url: "/api/account/provider-credentials/openrouter",
        bearer, payload: { expectedRevision: credentialRevision },
      });
    }
    await upsertServerProviderPolicy(fx.db, priorPolicy);
    await fx.db.delete(llmUsageEvents).where(eq(llmUsageEvents.userId, fx.ownerId));
    await fx.cleanup();
    if (priorCatalog) initToolCatalog(priorCatalog);
    else clearToolCatalog();
  }
}, 30_000);
