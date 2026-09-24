import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  channelIdentities,
  credentials,
  eq,
  groupMembers,
  groups,
  profiles,
  users,
} from "@nautilo/db";
import { getServerSpeechModel } from "@nautilo/agent";
import { assertCanUseServerProviderCredentials } from "@nautilo/trust";
import { voicePreviewPathForCustomText } from "@nautilo/voice";
import {
  seatPeerUser,
  setupOwnerAppFixture,
  type AppFixture,
} from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

type TestedRole = "member" | "contributor" | "community" | "guest";

type SeatedPeer = Awaited<ReturnType<typeof seatPeerUser>>;

const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1,
};

let fx: AppFixture;
let previousApiKey: string | undefined;
let realFetch: typeof fetch;
const peers = new Map<TestedRole, SeatedPeer>();
const fundingChecks: string[] = [];
const generatedPreviewPaths: string[] = [];

async function seatCommunityPeer(): Promise<SeatedPeer> {
  const peer = await seatPeerUser(fx.db, {
    suiteName: "paidaux",
    groupType: "contributors",
  });
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
  return peer;
}

function previewPath(voiceId: string, text: string): string {
  const model = getServerSpeechModel();
  return voicePreviewPathForCustomText(
    voiceId,
    JSON.stringify([
      "speech-preview-v1",
      model.id,
      model.providerModelId,
      model.speech.transport,
      "mp3_44100_128",
      VOICE_SETTINGS,
      text,
    ]),
  );
}

async function removePeer(peer: SeatedPeer): Promise<void> {
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
  previousApiKey = process.env["ELEVENLABS_API_KEY"];
  realFetch = globalThis.fetch;
  fx = await setupOwnerAppFixture({
    suiteName: "paidaux",
    createAppExtras: {
      voiceRoutesDeps: {
        catalogCache: null,
        assertCanUseServerProviderCredentials: async (humanUserId, origin) => {
          fundingChecks.push(humanUserId);
          await assertCanUseServerProviderCredentials(humanUserId, origin);
        },
      },
    },
  });

  peers.set("member", await seatPeerUser(fx.db, {
    suiteName: "paidaux",
    groupType: "members",
  }));
  peers.set("contributor", await seatPeerUser(fx.db, {
    suiteName: "paidaux",
    groupType: "contributors",
  }));
  peers.set("community", await seatCommunityPeer());
  peers.set("guest", await seatPeerUser(fx.db, {
    suiteName: "paidaux",
    groupType: "guests",
  }));
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (previousApiKey === undefined) delete process.env["ELEVENLABS_API_KEY"];
  else process.env["ELEVENLABS_API_KEY"] = previousApiKey;

  await Promise.all(generatedPreviewPaths.map(async (path) => {
    if (existsSync(path)) await unlink(path);
  }));
  if (!fx) return;
  for (const peer of peers.values()) await removePeer(peer);
  await fx.cleanup();
});

describe.serial("direct paid auxiliary role admission", () => {
  test("Member and Contributor reach voice dispatch while Community and Guest stop before it", async () => {
    process.env["ELEVENLABS_API_KEY"] = "integration-fake-provider-key";
    const providerCalls: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string" ? input
        : input instanceof URL ? input.toString()
        : input.url;
      const headers = new Headers(init?.headers);
      providerCalls.push({
        url,
        authorization: headers.get("xi-api-key"),
      });
      return new Response(Buffer.from("fake-mp3-audio"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }) as typeof fetch;

    for (const role of ["member", "contributor"] as const) {
      const peer = peers.get(role);
      if (!peer) throw new Error(`missing ${role} peer`);
      const voiceId = `PaidAux${role}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      const text = `Paid auxiliary role proof for ${role} ${randomUUID()}`;
      generatedPreviewPaths.push(previewPath(voiceId, text));
      const callsBefore = providerCalls.length;

      const response = await authedInject(fx.app, {
        method: "POST",
        url: `/api/voices/${voiceId}/preview`,
        bearer: peer.bearer,
        payload: { text },
      });

      expect(response.statusCode, role).toBe(200);
      expect(response.headers["content-type"]).toContain("audio/mpeg");
      expect(providerCalls, role).toHaveLength(callsBefore + 1);
      expect(providerCalls.at(-1)).toEqual({
        url: "https://api.elevenlabs.io/v1/text-to-dialogue/stream?output_format=mp3_44100_128",
        authorization: "integration-fake-provider-key",
      });
      expect(fundingChecks.at(-1), role).toBe(peer.userId);
    }

    const community = peers.get("community");
    if (!community) throw new Error("missing community peer");
    const beforeCommunity = providerCalls.length;
    const communityResponse = await authedInject(fx.app, {
      method: "POST",
      url: "/api/voices/PaidAuxCommunity/preview",
      bearer: community.bearer,
      payload: { text: `community denial ${randomUUID()}` },
    });
    expect(communityResponse.statusCode).toBe(403);
    expect(JSON.parse(communityResponse.body)).toEqual({
      error: "server_provider_credentials_required",
      code: "server_provider_credentials_required",
      capability: "use_server_provider_credentials",
    });
    expect(providerCalls).toHaveLength(beforeCommunity);
    expect(fundingChecks.at(-1)).toBe(community.userId);

    const guest = peers.get("guest");
    if (!guest) throw new Error("missing guest peer");
    const beforeGuest = providerCalls.length;
    const fundingBeforeGuest = fundingChecks.length;
    const guestResponse = await authedInject(fx.app, {
      method: "POST",
      url: "/api/voices/PaidAuxGuest/preview",
      bearer: guest.bearer,
      payload: { text: `guest denial ${randomUUID()}` },
    });
    expect(guestResponse.statusCode).toBe(403);
    expect(JSON.parse(guestResponse.body)).toEqual({ error: "Forbidden" });
    expect(providerCalls).toHaveLength(beforeGuest);
    expect(fundingChecks).toHaveLength(fundingBeforeGuest);
  });
});
