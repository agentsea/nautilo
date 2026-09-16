/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { AgentProfileFull, AgentProfileResponse } from "@nautilo/types";

import {
  agentProfileErrorMessage,
  createAgentProfileController,
  profileDraft,
  type AgentProfileApi,
} from "./agent-profile-controller";

const scope = { serverId: "server-a", userId: "user-a", actorId: "actor-a" };
const photoScope = {
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  viewerUserId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  selectionRevision: "1",
  libraryRevision: "1",
};
const uploadedEntryId = "44444444-4444-4444-8444-444444444444";

function profile(overrides: Partial<AgentProfileFull> = {}): AgentProfileFull {
  return {
    name: "Genie", language: "en", voices: {}, avatar: { kind: "preset", id: "avatar-01" },
    avatarUrl: "/api/profile/avatar", defaultModel: null,
    personality: { prompt: null, tone: null, motherAnswer: null }, privacySpectrum: null,
    workLifeMode: null, soulFile: "Be helpful.", onboardingCompleted: true,
    welcomeMessageSent: true, agentIdentity: "agent-a", handle: "genie", publicProfile: false,
    fallback: { enabled: false, chain: [] }, ...overrides,
  };
}

function ownerResponse(agent: AgentProfileFull): AgentProfileResponse {
  return { viewerRole: "owner", agent, ownedAgents: [{ agentId: "agent-a", handle: agent.handle, displayName: agent.name }] };
}

function createApi(initial: AgentProfileFull): { api: AgentProfileApi; calls: string[]; current: AgentProfileFull } {
  let current = initial;
  const calls: string[] = [];
  const api: AgentProfileApi = {
    getProfile: async () => { calls.push("get"); return ownerResponse(current); },
    updateProfile: async (patch) => { calls.push(`profile:${JSON.stringify(patch)}`); current = { ...current, ...patch } as AgentProfileFull; return ownerResponse(current); },
    updateAgentHandle: async (handle) => { calls.push(`handle:${handle}`); current = { ...current, handle }; return { handle }; },
    getAgentPhotoLibraryCurrent: async () => {
      calls.push("photo:current");
      return { current: { avatarRef: current.avatar, entryId: null, lastUndoableRevisionId: null, scope: photoScope }, scope: photoScope };
    },
    uploadAgentPhotoLibraryEntry: async (_file, options) => {
      calls.push(`photo:upload:${options.idempotencyKey}:${options.origin}`);
      return {
        operation: "create", entryIds: [uploadedEntryId],
        entries: [{
          id: uploadedEntryId, source: "upload", origin: "mobile",
          createdAt: "2026-08-04T10:00:00.000Z",
          media: {
            thumbnailUrl: `/api/profile/agent-photo-library/entries/${uploadedEntryId}/media?size=thumb`,
            fullUrl: `/api/profile/agent-photo-library/entries/${uploadedEntryId}/media?size=full`,
          },
        }],
        scope: { ...photoScope, libraryRevision: "2" },
      };
    },
    selectAgentPhotoLibraryEntry: async ({ target }, options) => {
      const selection = target.kind === "entry" ? target.entryId : target.presetId;
      calls.push(`photo:select:${selection}:${options.idempotencyKey}:${options.origin}`);
      current = target.kind === "entry"
        ? { ...current, avatar: { kind: "uploaded", blobId: "blob-new" } }
        : { ...current, avatar: { kind: "preset", id: target.presetId } };
      return {
        operation: "select", changed: true, currentAvatarRef: current.avatar,
        currentEntryId: target.kind === "entry" ? target.entryId : null,
        revisionId: "55555555-5555-4555-8555-555555555555",
        scope: { ...photoScope, selectionRevision: "2" },
      };
    },
    generateSoul: async () => { calls.push("soul"); current = { ...current, soulFile: "Generated Soul" }; return { soulFile: "Generated Soul" }; },
  };
  return { api, calls, get current() { return current; } };
}

describe("Agent profile controller", () => {
  const fixedUuid = () => "66666666-6666-4666-8666-666666666666";

  test("loads the self profile then saves name, handle, and Soul with canonical refresh", async () => {
    const fake = createApi(profile());
    const controller = createAgentProfileController(() => fake.api, fixedUuid);
    controller.setScope(scope);
    expect(await controller.load()).toMatchObject({ status: "applied" });
    const outcome = await controller.save({ name: "Nova", handle: "nova", soulFile: "Be concise." });
    expect(outcome).toEqual({ status: "applied" });
    expect(fake.calls).toEqual([
      "get", 'profile:{"name":"Nova","soulFile":"Be concise."}', "handle:nova", "get",
    ]);
    expect(controller.data.getState().data).toMatchObject({ name: "Nova", handle: "nova", soulFile: "Be concise." });
    expect(controller.data.getState().draft).toBeNull();
  });

  test("makes 400 and 409 handle failures actionable", () => {
    expect(agentProfileErrorMessage(Object.assign(new Error("invalid_handle"), { status: 400 }), "handle")).toContain("valid handle");
    expect(agentProfileErrorMessage(Object.assign(new Error("handle_taken"), { status: 409 }), "handle")).toContain("already in use");
  });

  test("uploads bytes and selects a preset through typed self-only client methods then refreshes", async () => {
    const fake = createApi(profile());
    let operation = 0;
    const controller = createAgentProfileController(
      () => fake.api,
      () => `${String(++operation).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    controller.setScope(scope);
    await controller.load();
    expect(await controller.uploadAvatar({ name: "avatar.png", bytes: async () => new Uint8Array([1]) })).toEqual({ status: "applied" });
    expect(controller.data.getState().data?.avatar).toEqual({ kind: "uploaded", blobId: "blob-new" });
    expect(await controller.selectPreset("avatar-07")).toEqual({ status: "applied" });
    expect(controller.data.getState().data?.avatar).toEqual({ kind: "preset", id: "avatar-07" });
    expect(fake.calls).toEqual([
      "get", "photo:current",
      "photo:upload:00000001-0000-4000-8000-000000000000:mobile",
      `photo:select:${uploadedEntryId}:00000002-0000-4000-8000-000000000000:mobile`,
      "get", "photo:current",
      "photo:select:avatar-07:00000003-0000-4000-8000-000000000000:mobile", "get",
    ]);
  });

  test("surfaces auth expiry and stops before upload or select", async () => {
    const fake = createApi(profile());
    fake.api.getAgentPhotoLibraryCurrent = async () => {
      throw Object.assign(new Error("authentication_required"), { status: 401 });
    };
    const controller = createAgentProfileController(() => fake.api, fixedUuid);
    controller.setScope(scope);
    await controller.load();
    const outcome = await controller.uploadAvatar({
      name: "avatar.png",
      bytes: async () => new Uint8Array([1]),
    });
    expect(outcome).toEqual({
      status: "failed",
      message: "Your session has expired. Sign in again before changing your Agent.",
    });
    expect(fake.calls).toEqual(["get"]);
  });

  test("passes the canonical identity and revision fence into preset selection", async () => {
    const fake = createApi(profile());
    fake.api.selectAgentPhotoLibraryEntry = async (input, options) => {
      expect(input).toEqual({
        target: { kind: "preset", presetId: "avatar-07" },
        expectedSelectionRevision: "1",
      });
      expect(options.fence).toMatchObject({
        serverInstanceId: photoScope.serverInstanceId,
        viewerUserId: photoScope.viewerUserId,
        agentId: photoScope.agentId,
        selectionRevision: "1",
        libraryRevision: "1",
      });
      throw Object.assign(new Error("stale_viewer_scope"), { status: 409 });
    };
    const controller = createAgentProfileController(() => fake.api, fixedUuid);
    controller.setScope(scope);
    await controller.load();
    expect(await controller.selectPreset("avatar-07")).toEqual({
      status: "failed",
      message: "Your Agent profile changed on the server. Review the refreshed profile and try again.",
    });
  });

  test("fences a server/viewer switch while an upload is in flight", async () => {
    const fake = createApi(profile());
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => { releaseUpload = resolve; });
    let continueUpload!: () => void;
    const uploadMayFinish = new Promise<void>((resolve) => { continueUpload = resolve; });
    fake.api.uploadAgentPhotoLibraryEntry = async (_file, options) => {
      releaseUpload();
      await uploadMayFinish;
      expect(options.fence.getCurrentGeneration()).not.toBe(options.fence.requestGeneration);
      throw Object.assign(new Error("stale_viewer_scope"), { status: 409 });
    };
    const controller = createAgentProfileController(() => fake.api, fixedUuid);
    controller.setScope(scope);
    await controller.load();
    const upload = controller.uploadAvatar({
      name: "avatar.png",
      bytes: async () => new Uint8Array([1]),
    });
    await uploadStarted;
    controller.setScope({ serverId: "server-b", userId: "user-b", actorId: "actor-b" });
    continueUpload();
    expect(await upload).toEqual({ status: "ignored" });
    expect(controller.data.getState().scope).toEqual({
      serverId: "server-b", userId: "user-b", actorId: "actor-b",
    });
  });

  test("keeps current Soul truthful when non-stream generation fails", async () => {
    const fake = createApi(profile());
    fake.api.generateSoul = async () => { throw Object.assign(new Error("generation down"), { status: 500 }); };
    const controller = createAgentProfileController(() => fake.api, fixedUuid);
    controller.setScope(scope);
    await controller.load();
    expect(await controller.generateSoul()).toEqual({ status: "failed", message: "Could not generate Soul instructions. Your current instructions were not replaced." });
    expect(controller.data.getState().data?.soulFile).toBe("Be helpful.");
  });

  test("refreshes canonical truth after a partial save when the handle conflicts", async () => {
    const fake = createApi(profile());
    fake.api.updateAgentHandle = async () => { throw Object.assign(new Error("handle_taken"), { status: 409 }); };
    const controller = createAgentProfileController(() => fake.api, fixedUuid);
    controller.setScope(scope);
    await controller.load();
    const draft = { ...profileDraft(profile()), name: "Nova", handle: "taken", soulFile: "Saved Soul" };
    controller.data.setDraft(draft);
    const outcome = await controller.save(draft);
    expect(outcome.status).toBe("partial");
    if (outcome.status !== "partial") throw new Error("The fixture must produce a partial save.");
    expect(outcome.message).toContain("Name and Soul instructions were saved");
    expect(controller.data.getState().data).toMatchObject({ name: "Nova", handle: "genie", soulFile: "Saved Soul" });
    expect(controller.data.getState().draft).toEqual(draft);
  });

  test("has no target user or avatar-generation argument in self actions", async () => {
    const fake = createApi(profile());
    const controller = createAgentProfileController(() => fake.api, fixedUuid);
    controller.setScope(scope);
    await controller.load();
    await controller.generateSoul();
    expect(fake.calls).toEqual(["get", "soul", "get"]);
  });
});
