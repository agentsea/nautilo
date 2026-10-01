import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  channelIdentities,
  credentials,
  eq,
  groupMembers,
  groups,
  llmUsageEvents,
  profiles,
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
const GENERATED_SOUL = [
  "# Vela — Soul File",
  "",
  "## Essence",
  "Vela is observant, practical, and quietly funny. She notices the useful detail before reaching for a grand explanation.",
  "",
  "## Tone",
  "She writes with warmth and precision, keeps promises concrete, and lets a small dry joke through when it helps.",
].join("\n");

type Peer = Awaited<ReturnType<typeof seatPeerUser>>;

let fx: AppFixture;
let community: Peer;
let guest: Peer;
let originalFetch: typeof fetch;
let priorOpenRouterKey: string | undefined;
let priorGatewayKey: string | undefined;
let priorGatewayUrl: string | undefined;
let priorSoulModel: string | undefined;
const providerRequests: Array<{ authorization: string | null; stream: boolean }> = [];

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
  guest = await seatPeerUser(fx.db, {
    suiteName: "personalsoul",
    groupType: "guests",
  });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://openrouter.ai/api/v1/chat/completions") {
      throw new Error(`Unexpected outbound request in Soul setup integration test: ${url}`);
    }
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    const rawBody = typeof init?.body === "string"
      ? init.body
      : request
        ? await request.clone().text()
        : "{}";
    const body = JSON.parse(rawBody) as { stream?: boolean };
    const stream = body.stream === true;
    providerRequests.push({ authorization: headers.get("authorization"), stream });

    if (stream) {
      const midpoint = Math.floor(GENERATED_SOUL.length / 2);
      const chunks = [
        {
          id: "chatcmpl-soul-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: "minimax/minimax-m3",
          choices: [{ index: 0, delta: { role: "assistant", content: GENERATED_SOUL.slice(0, midpoint) }, finish_reason: null }],
        },
        {
          id: "chatcmpl-soul-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: "minimax/minimax-m3",
          choices: [{ index: 0, delta: { content: GENERATED_SOUL.slice(midpoint) }, finish_reason: null }],
        },
        {
          id: "chatcmpl-soul-stream",
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
      id: "chatcmpl-soul-nonstream",
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
  globalThis.fetch = originalFetch;
  restoreEnvironment();
  if (!fx) return;
  await upsertServerProviderPolicy(fx.db, { allowPersonalProviderKeys: false });
  if (community) await removePeer(community);
  if (guest) await removePeer(guest);
  await fx.cleanup();
});

describe.serial("personal-key own-Genie Soul setup service", () => {
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
