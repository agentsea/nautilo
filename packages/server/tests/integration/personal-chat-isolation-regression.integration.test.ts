import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerAllTools } from "@nautilo/agent";
import { ToolCatalog, clearToolCatalog, getToolCatalog, initToolCatalog } from "@nautilo/catalog";
import {
  actors,
  agents,
  and,
  channelIdentities,
  credentials,
  eq,
  groupMembers,
  groups,
  inArray,
  jobs,
  llmUsageEvents,
  namespaces,
  personalProviderCredentials,
  profiles,
  roomMembers,
  rooms,
  sessionMessageRecipientState,
  sessionMessages,
  sessions,
  upsertServerProviderPolicy,
  users,
} from "@nautilo/db";
import {
  seatPeerUser,
  setupOwnerAppFixture,
  type AppFixture,
} from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

const MODEL = "openrouter:anthropic/claude-sonnet-4.6";
const FIRST_KEY = "sk-synthetic-isolation-first";
const SECOND_KEY = "sk-synthetic-isolation-second";
const SERVER_KEY = "sk-synthetic-isolation-server";

type Peer = Awaited<ReturnType<typeof seatPeerUser>>;
type DirectRoom = { roomId: string; namespaceId: string; targetAgentHandle?: string };

let fx: AppFixture;
let first: Peer;
let second: Peer;
let guest: Peer;
let firstRoom: DirectRoom;
let secondRoom: DirectRoom;
let guestRoom: DirectRoom;
let foreignRoom: DirectRoom;
let priorFetch: typeof fetch;
let priorDirectKey: string | undefined;
let priorGatewayKey: string | undefined;
let priorGatewayUrl: string | undefined;
let priorCatalog: ToolCatalog | null;

const providerCalls: Array<{ authorization: string | null; body: string }> = [];

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

async function agentActorId(agentId: string): Promise<string> {
  const [actor] = await fx.db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!actor) throw new Error(`missing Agent Actor for ${agentId}`);
  return actor.id;
}

async function createDirectRoom(
  human: Peer,
  targetAgentId: string,
  label: string,
): Promise<DirectRoom> {
  const [namespace] = await fx.db
    .insert(namespaces)
    .values({ scope: "private", label: `${label} namespace` })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("namespace fixture insert failed");
  const [room] = await fx.db
    .insert(rooms)
    .values({
      ownerId: human.userId,
      type: "private",
      label,
      graphThreadId: `personal-isolation:${randomUUID()}`,
      namespaceId: namespace.id,
      humanActorIds: [human.actorId],
      createdBy: human.actorId,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("Room fixture insert failed");
  await fx.db.insert(roomMembers).values([
    { roomId: room.id, actorId: human.actorId, roomRole: "admin" },
    { roomId: room.id, actorId: await agentActorId(targetAgentId), roomRole: "member" },
  ]);
  return { roomId: room.id, namespaceId: namespace.id };
}

async function createForeignRoom(human: Peer, target: Peer): Promise<DirectRoom> {
  const [targetAgent] = await fx.db
    .select({ handle: agents.handle })
    .from(agents)
    .where(eq(agents.id, target.agentId))
    .limit(1);
  if (!targetAgent) throw new Error("foreign target Agent missing");
  const [namespace] = await fx.db
    .insert(namespaces)
    .values({ scope: "private", label: "Foreign Genie Room namespace" })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("foreign namespace fixture insert failed");
  const [room] = await fx.db
    .insert(rooms)
    .values({
      ownerId: human.userId,
      type: "private",
      label: "Foreign Genie Room",
      graphThreadId: `personal-isolation:${randomUUID()}`,
      namespaceId: namespace.id,
      humanActorIds: [human.actorId, target.actorId],
      createdBy: human.actorId,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("foreign Room fixture insert failed");
  await fx.db.insert(roomMembers).values([
    { roomId: room.id, actorId: human.actorId, roomRole: "admin" },
    { roomId: room.id, actorId: target.actorId, roomRole: "member" },
    { roomId: room.id, actorId: await agentActorId(human.agentId), roomRole: "member" },
    { roomId: room.id, actorId: await agentActorId(target.agentId), roomRole: "member" },
  ]);
  return { roomId: room.id, namespaceId: namespace.id, targetAgentHandle: targetAgent.handle };
}

async function chooseModel(peer: Peer, room: DirectRoom): Promise<void> {
  const response = await authedInject(fx.app, {
    method: "PUT",
    url: `/api/rooms/${room.roomId}/agents/${peer.agentId}/model-control-selection`,
    bearer: peer.bearer,
    payload: { selection: { modelId: MODEL } },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function sendChat(bearer: string, roomId: string, message: string) {
  return authedInject(fx.app, {
    method: "POST",
    url: "/api/chat",
    bearer,
    payload: { message, roomId },
  });
}

async function waitForAssistant(roomId: string, expectedContent: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let observed: Array<{ role: string; content: string | null }> = [];
  while (Date.now() < deadline) {
    observed = await fx.db
      .select({ role: sessionMessages.role, content: sessionMessages.content })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .where(eq(sessions.roomId, roomId));
    if (observed.some((message) =>
      message.role === "assistant" && message.content === expectedContent)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(observed, JSON.stringify(observed)).toContainEqual({
    role: "assistant",
    content: expectedContent,
  });
}

async function removeRoom(room: DirectRoom): Promise<void> {
  const roomSessions = await fx.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.roomId, room.roomId));
  const sessionIds = roomSessions.map(({ id }) => id);
  if (sessionIds.length > 0) {
    const messages = await fx.db
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(inArray(sessionMessages.sessionId, sessionIds));
    if (messages.length > 0) {
      await fx.db.delete(sessionMessageRecipientState).where(
        inArray(sessionMessageRecipientState.messageId, messages.map(({ id }) => id)),
      );
    }
    await fx.db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    await fx.db.delete(sessions).where(inArray(sessions.id, sessionIds));
  }
  await fx.db.delete(jobs).where(eq(jobs.roomId, room.roomId));
  await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, room.roomId));
  await fx.db.delete(rooms).where(eq(rooms.id, room.roomId));
  await fx.db.delete(namespaces).where(eq(namespaces.id, room.namespaceId));
}

async function removePeer(peer: Peer): Promise<void> {
  await fx.db.delete(llmUsageEvents).where(eq(llmUsageEvents.userId, peer.userId));
  await fx.db.delete(personalProviderCredentials).where(eq(personalProviderCredentials.userId, peer.userId));
  await fx.db.delete(profiles).where(eq(profiles.userId, peer.userId));
  await fx.db.delete(groupMembers).where(eq(groupMembers.userId, peer.userId));
  await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peer.userId));
  await fx.db.delete(credentials).where(eq(credentials.userId, peer.userId));
  await fx.db.delete(actors).where(eq(actors.ownerId, peer.userId));
  await fx.db.delete(actors).where(eq(actors.agentId, peer.agentId));
  await fx.db.delete(agents).where(eq(agents.id, peer.agentId));
  await fx.db.delete(users).where(eq(users.id, peer.userId));
}

beforeAll(async () => {
  priorCatalog = getToolCatalog();
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
  priorFetch = globalThis.fetch;
  priorDirectKey = process.env["OPENROUTER_API_KEY"];
  priorGatewayKey = process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"];
  priorGatewayUrl = process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
  process.env["OPENROUTER_API_KEY"] = SERVER_KEY;
  delete process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"];
  delete process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];

  fx = await setupOwnerAppFixture({
    suiteName: "personalchatiso",
    withDefaultAgentGraph: true,
  });
  first = await seatPeerUser(fx.db, { suiteName: "personalchatisoa", groupType: "contributors" });
  second = await seatPeerUser(fx.db, { suiteName: "personalchatisob", groupType: "contributors" });
  guest = await seatPeerUser(fx.db, { suiteName: "personalchatisog", groupType: "guests" });
  await moveToCommunity(first);
  await moveToCommunity(second);
  firstRoom = await createDirectRoom(first, first.agentId, "First personal Room");
  secondRoom = await createDirectRoom(second, second.agentId, "Second personal Room");
  guestRoom = await createDirectRoom(guest, guest.agentId, "Guest Room");
  foreignRoom = await createForeignRoom(first, second);
  await upsertServerProviderPolicy(fx.db, { allowPersonalProviderKeys: true });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://openrouter.ai/api/v1/chat/completions") {
      if (["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
        return priorFetch(input, init);
      }
      throw new Error(`Unexpected outbound provider request: ${url}`);
    }
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    const authorization = headers.get("authorization");
    const body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : "";
    providerCalls.push({ authorization, body });
    const answer = authorization === `Bearer ${FIRST_KEY}`
      ? "First Human personal answer."
      : authorization === `Bearer ${SECOND_KEY}`
        ? "Second Human personal answer."
        : authorization === `Bearer ${SERVER_KEY}`
          ? "Server funded answer."
          : "Unexpected funding answer.";
    const payload = JSON.parse(body) as { stream?: boolean };
    if (payload.stream) {
      const chunks = [
        {
          id: "chatcmpl-isolation", object: "chat.completion.chunk", created: 1,
          model: "anthropic/claude-sonnet-4.6",
          choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }],
        },
        {
          id: "chatcmpl-isolation", object: "chat.completion.chunk", created: 1,
          model: "anthropic/claude-sonnet-4.6",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      id: "chatcmpl-isolation", object: "chat.completion", created: 1,
      model: "anthropic/claude-sonnet-4.6",
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    });
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = priorFetch;
  if (priorDirectKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = priorDirectKey;
  if (priorGatewayKey === undefined) delete process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"];
  else process.env["NAUTILO_MANAGED_GATEWAY_API_KEY"] = priorGatewayKey;
  if (priorGatewayUrl === undefined) delete process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
  else process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"] = priorGatewayUrl;
  if (!fx) return;
  await upsertServerProviderPolicy(fx.db, { allowPersonalProviderKeys: false });
  for (const room of [foreignRoom, guestRoom, secondRoom, firstRoom]) {
    if (room) await removeRoom(room);
  }
  for (const peer of [guest, second, first]) {
    if (peer) await removePeer(peer);
  }
  await fx.db.delete(llmUsageEvents).where(eq(llmUsageEvents.userId, fx.ownerId));
  await fx.cleanup();
  if (priorCatalog) initToolCatalog(priorCatalog);
  else clearToolCatalog();
});

describe.serial("personal chat isolation and role regressions", () => {
  test("two Humans use only their own stored key and receive separately attributed usage", async () => {
    for (const [peer, key] of [[first, FIRST_KEY], [second, SECOND_KEY]] as const) {
      const saved = await authedInject(fx.app, {
        method: "PUT",
        url: "/api/account/provider-credentials/openrouter",
        bearer: peer.bearer,
        payload: { apiKey: key },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.body).not.toContain(key);
    }

    const firstList = await authedInject(fx.app, {
      method: "GET", url: "/api/account/provider-credentials", bearer: first.bearer,
    });
    const secondList = await authedInject(fx.app, {
      method: "GET", url: "/api/account/provider-credentials", bearer: second.bearer,
    });
    expect(firstList.statusCode).toBe(200);
    expect(secondList.statusCode).toBe(200);
    const firstMetadata = JSON.parse(firstList.body) as { credentials: Array<{ id: string }> };
    const secondMetadata = JSON.parse(secondList.body) as { credentials: Array<{ id: string }> };
    expect(firstMetadata.credentials).toHaveLength(1);
    expect(secondMetadata.credentials).toHaveLength(1);
    expect(firstMetadata.credentials[0]?.id).not.toBe(secondMetadata.credentials[0]?.id);
    expect(`${firstList.body}${secondList.body}`).not.toContain(FIRST_KEY);
    expect(`${firstList.body}${secondList.body}`).not.toContain(SECOND_KEY);

    await chooseModel(first, firstRoom);
    await chooseModel(second, secondRoom);
    const callsBefore = providerCalls.length;
    const firstSent = await sendChat(first.bearer, firstRoom.roomId, "Use the first Human key.");
    expect(firstSent.statusCode, firstSent.body).toBe(202);
    expect(typeof (JSON.parse(firstSent.body) as { jobId?: unknown }).jobId).toBe("string");
    await waitForAssistant(firstRoom.roomId, "First Human personal answer.");
    const secondSent = await sendChat(second.bearer, secondRoom.roomId, "Use the second Human key.");
    expect(secondSent.statusCode, secondSent.body).toBe(202);
    expect(typeof (JSON.parse(secondSent.body) as { jobId?: unknown }).jobId).toBe("string");
    await waitForAssistant(secondRoom.roomId, "Second Human personal answer.");

    expect(providerCalls.slice(callsBefore).map(({ authorization }) => authorization)).toEqual([
      `Bearer ${FIRST_KEY}`,
      `Bearer ${SECOND_KEY}`,
    ]);
    expect(providerCalls.slice(callsBefore).every(({ body }) =>
      !body.includes(FIRST_KEY) && !body.includes(SECOND_KEY))).toBe(true);
    const usage = await fx.db.select({
      userId: llmUsageEvents.userId,
      payerHumanId: llmUsageEvents.payerHumanId,
      fundingKind: llmUsageEvents.fundingKind,
      credentialRevision: llmUsageEvents.credentialRevision,
    }).from(llmUsageEvents).where(inArray(llmUsageEvents.userId, [first.userId, second.userId]));
    expect(usage.some((event) => event.userId === first.userId
      && event.payerHumanId === first.userId
      && event.fundingKind === "personal"
      && event.credentialRevision === 1)).toBe(true);
    expect(usage.some((event) => event.userId === second.userId
      && event.payerHumanId === second.userId
      && event.fundingKind === "personal"
      && event.credentialRevision === 1)).toBe(true);
  }, 50_000);

  test("foreign Genie admission fails before provider work", async () => {
    const callsBefore = providerCalls.length;
    if (!foreignRoom.targetAgentHandle) throw new Error("foreign target handle missing");
    const response = await sendChat(
      first.bearer,
      foreignRoom.roomId,
      `@${foreignRoom.targetAgentHandle} Try another Human's Genie.`,
    );
    expect(response.statusCode, response.body).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ code: "invoke_other_agents_required" });
    expect(providerCalls).toHaveLength(callsBefore);
  });

  test("turning the switch off blocks the next turn while preserving encrypted records", async () => {
    const before = await fx.db.select({
      id: personalProviderCredentials.id,
      userId: personalProviderCredentials.userId,
      ciphertextBase64: personalProviderCredentials.ciphertextBase64,
    }).from(personalProviderCredentials).where(
      inArray(personalProviderCredentials.userId, [first.userId, second.userId]),
    );
    expect(before).toHaveLength(2);
    await upsertServerProviderPolicy(fx.db, { allowPersonalProviderKeys: false });

    const callsBefore = providerCalls.length;
    const response = await sendChat(first.bearer, firstRoom.roomId, "This turn must be blocked.");
    expect(response.statusCode, response.body).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ code: "server_provider_credentials_required" });
    expect(providerCalls).toHaveLength(callsBefore);
    const hidden = await authedInject(fx.app, {
      method: "GET", url: "/api/account/provider-credentials", bearer: first.bearer,
    });
    expect(hidden.statusCode).toBe(404);

    const after = await fx.db.select({
      id: personalProviderCredentials.id,
      userId: personalProviderCredentials.userId,
      ciphertextBase64: personalProviderCredentials.ciphertextBase64,
    }).from(personalProviderCredentials).where(
      inArray(personalProviderCredentials.userId, [first.userId, second.userId]),
    );
    expect(after).toEqual(before);
    expect(after.every(({ ciphertextBase64 }) =>
      !ciphertextBase64.includes(FIRST_KEY) && !ciphertextBase64.includes(SECOND_KEY))).toBe(true);
  });

  test("server-funded owner chat still works and Guest remains unable to invoke a Genie", async () => {
    if (!fx.defaultRoomId || !fx.defaultAgentId) throw new Error("owner graph missing");
    const ownerBearer = await fx.mintOwnerBearer();
    const selected = await authedInject(fx.app, {
      method: "PUT",
      url: `/api/rooms/${fx.defaultRoomId}/agents/${fx.defaultAgentId}/model-control-selection`,
      bearer: ownerBearer,
      payload: { selection: { modelId: MODEL } },
    });
    expect(selected.statusCode, selected.body).toBe(200);

    const callsBeforeOwner = providerCalls.length;
    const ownerSent = await sendChat(ownerBearer, fx.defaultRoomId, "Use the server-funded path.");
    expect(ownerSent.statusCode, ownerSent.body).toBe(202);
    expect(typeof (JSON.parse(ownerSent.body) as { jobId?: unknown }).jobId).toBe("string");
    await waitForAssistant(fx.defaultRoomId, "Server funded answer.");
    expect(providerCalls.slice(callsBeforeOwner).map(({ authorization }) => authorization)).toEqual([
      `Bearer ${SERVER_KEY}`,
    ]);
    const ownerUsage = await fx.db.select().from(llmUsageEvents).where(
      and(eq(llmUsageEvents.userId, fx.ownerId), eq(llmUsageEvents.callType, "chat")),
    );
    expect(ownerUsage.some((event) => event.fundingKind === "server")).toBe(true);

    const callsBeforeGuest = providerCalls.length;
    const guestResponse = await sendChat(guest.bearer, guestRoom.roomId, "Guest must remain blocked.");
    expect(guestResponse.statusCode, guestResponse.body).toBe(403);
    expect(JSON.parse(guestResponse.body)).toMatchObject({ code: "invoke_agents_required" });
    expect(providerCalls).toHaveLength(callsBeforeGuest);
  }, 30_000);
});
