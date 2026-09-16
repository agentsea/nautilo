/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
  AGENT_AVATAR_MAX_BYTES,
  AGENT_AVATAR_PRESET_IDS,
  agentAvatarPresetSource,
  authenticatedAgentAvatarSource,
  loadAuthenticatedAgentAvatarSource,
  prepareAgentAvatarUpload,
} from "./agent-avatar-source";

const bytes = async () => new Uint8Array([1, 2, 3]);

describe("Agent avatar upload source", () => {
  test("accepts only the server's MIME and size policy before multipart upload", () => {
    expect(prepareAgentAvatarUpload(
      { uri: "file:///avatar.webp", type: "image", mimeType: "image/webp", fileSize: 30 },
      { name: "avatar.webp", size: 30, type: "image/webp", bytes },
    )).toMatchObject({ ok: true, mimeType: "image/webp" });
    expect(prepareAgentAvatarUpload(
      { uri: "file:///avatar.heic", type: "image", mimeType: "image/heic", fileSize: 30 },
      { name: "avatar.heic", size: 30, type: "image/heic", bytes },
    )).toEqual({ ok: false, message: "Choose a PNG, JPEG, or WebP image." });
    expect(prepareAgentAvatarUpload(
      { uri: "file:///large.png", type: "image", mimeType: "image/png", fileSize: AGENT_AVATAR_MAX_BYTES + 1 },
      { name: "large.png", size: AGENT_AVATAR_MAX_BYTES + 1, type: "image/png", bytes },
    )).toEqual({ ok: false, message: "Choose an image smaller than 5 MiB." });
  });

  test("uses the authenticated self avatar route with a content version", () => {
    expect(authenticatedAgentAvatarSource({
      serverUrl: "https://nautilo.example/",
      accessToken: "bearer-token",
      avatar: { kind: "uploaded", blobId: "blob-a" },
    })).toEqual({
      uri: "https://nautilo.example/api/profile/avatar?v=blob-a",
      headers: { Authorization: "Bearer bearer-token" },
    });
    expect(authenticatedAgentAvatarSource({
      serverUrl: "https://nautilo.example",
      accessToken: null,
      avatar: { kind: "preset", id: "avatar-01" },
    })).toBeNull();
  });

  test("lists every shipped preset and resolves image headers through the fresh-token seam", async () => {
    expect(AGENT_AVATAR_PRESET_IDS).toHaveLength(40);
    expect(AGENT_AVATAR_PRESET_IDS).toEqual([
      ...Array.from({ length: 7 }, (_, index) => `avatar-0${index + 1}`),
      ...Array.from({ length: 33 }, (_, index) => `avatar-${String(index + 9).padStart(2, "0")}`),
    ]);
    const calls: string[][] = [];
    const source = await loadAuthenticatedAgentAvatarSource({
      serverId: "server-a",
      serverUrl: "https://nautilo.example",
      avatar: { kind: "preset", id: "avatar-41" },
      getToken: async (...args) => { calls.push(args); return "fresh-token"; },
    });
    expect(calls).toEqual([["server-a", "https://nautilo.example"]]);
    expect(source?.headers).toEqual({ Authorization: "Bearer fresh-token" });
  });

  test("reuses the server's public onboarding asset path for preset previews", () => {
    expect(agentAvatarPresetSource("https://nautilo.example/", "avatar-41")).toEqual({
      uri: "https://nautilo.example/api/onboarding/images/avatars/avatar-41.webp",
    });
  });
});
