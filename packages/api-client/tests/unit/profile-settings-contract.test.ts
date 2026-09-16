/**
 * D465 Phase 0.1 — canonical Settings contracts. These tests keep mobile on
 * the shared client for profile mutation, Agent avatar upload, and PIN
 * enrollment instead of reimplementing any route-local fetch behavior.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";
import type { AgentProfileResponse } from "@nautilo/types";

const BASE = "http://127.0.0.1:9";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const updatedProfile: AgentProfileResponse = {
  viewerRole: "owner",
  agent: {
    name: "Jeannie",
    language: "en",
    voices: {},
    avatar: { kind: "preset", id: "shell" },
    avatarUrl: "/api/profile/avatar",
    defaultModel: "openai:gpt-5",
    personality: { prompt: null, tone: null, motherAnswer: null },
    privacySpectrum: null,
    workLifeMode: null,
    soulFile: null,
    onboardingCompleted: true,
    welcomeMessageSent: false,
    agentIdentity: "agent-1",
    handle: "jeannie",
    publicProfile: false,
    fallback: { enabled: false, chain: [] },
  },
  ownedAgents: [{ agentId: "agent-1", handle: "jeannie", displayName: "Jeannie" }],
};

describe("D465 profile and PIN client contracts", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("getProfile can explicitly latch a fresh session bearer for Mobile", async () => {
    let authorization = "";
    globalThis.fetch = (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return jsonResponse(200, updatedProfile);
    }) as typeof fetch;

    const client = new NautiloApiClient(BASE);
    client.setToken("stale-profile-token");
    client.setTokenProvider(async () => "fresh-profile-token");

    expect(await client.getProfile({ fresh: true })).toEqual(updatedProfile);
    expect(authorization).toBe("Bearer fresh-profile-token");
  });

  test("updateProfile sends the narrow mutation and parses the canonical profile projection", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown;
    let authorization = "";
    globalThis.fetch = (async (input, init) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      if (typeof init?.body !== "string") throw new Error("Expected JSON profile body");
      seenBody = JSON.parse(init.body);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return jsonResponse(200, updatedProfile);
    }) as typeof fetch;

    const client = new NautiloApiClient(BASE);
    client.setTokenProvider(async () => "fresh-profile-token");
    const result = await client.updateProfile({
      name: "Jeannie",
      personalityPrompt: "Be warmly precise.",
      defaultModel: "openai:gpt-5",
    });

    expect(seenUrl).toBe(BASE + "/api/profile");
    expect(seenMethod).toBe("PUT");
    expect(authorization).toBe("Bearer fresh-profile-token");
    expect(seenBody).toEqual({
      name: "Jeannie",
      personalityPrompt: "Be warmly precise.",
      defaultModel: "openai:gpt-5",
    });
    expect(result).toEqual(updatedProfile);
  });

  test("uploadHumanAvatar uses the signed-in Human portrait endpoint", async () => {
    let seenUrl = "";
    let authorization = "";
    let form: FormData | undefined;
    globalThis.fetch = (async (input, init) => {
      seenUrl = requestUrl(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      form = init?.body as FormData;
      return jsonResponse(200, { avatar: { kind: "uploaded", blobId: "human-avatar-1" } });
    }) as typeof fetch;

    const client = new NautiloApiClient(BASE);
    client.setTokenProvider(async () => "fresh-human-token");
    const result = await client.uploadHumanAvatar(new Blob(["human-png"], { type: "image/png" }));

    expect(seenUrl).toBe(BASE + "/api/profile/avatar");
    expect(authorization).toBe("Bearer fresh-human-token");
    expect(form).toBeInstanceOf(FormData);
    expect((form?.get("file") as File).name).toBe("human-avatar.png");
    expect(result).toEqual({ avatar: { kind: "uploaded", blobId: "human-avatar-1" } });
  });

  test("postAuthPin preserves one-time recovery codes from first enrollment", async () => {
    let seenBody: unknown;
    globalThis.fetch = (async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON PIN body");
      seenBody = JSON.parse(init.body);
      return jsonResponse(200, {
        ok: true,
        enrolled: true,
        recoveryCodes: ["amber-lake", "violet-ridge"],
      });
    }) as typeof fetch;

    const client = new NautiloApiClient(BASE);
    const result = await client.postAuthPin({ newPin: "183746" });

    expect(seenBody).toEqual({ newPin: "183746" });
    expect(result).toEqual({
      ok: true,
      enrolled: true,
      recoveryCodes: ["amber-lake", "violet-ridge"],
    });
  });

  test("changePin reuses postAuthPin and does not manufacture recovery codes", async () => {
    let seenBody: unknown;
    globalThis.fetch = (async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON PIN body");
      seenBody = JSON.parse(init.body);
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    const client = new NautiloApiClient(BASE);
    const result = await client.changePin({ currentPin: "183746", newPin: "918273" });

    expect(seenBody).toEqual({ currentPin: "183746", newPin: "918273" });
    expect(result).toEqual({ ok: true });
    expect(result.recoveryCodes).toBeUndefined();
  });
});
