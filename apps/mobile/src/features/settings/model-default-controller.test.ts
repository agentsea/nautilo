/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { AssistantModelSummary } from "@nautilo/api-client/browser";
import type { AgentProfileFull, AgentProfileResponse } from "@nautilo/types";

import { createModelDefaultController, modelDefaultErrorMessage, type ModelDefaultApi } from "./model-default-controller";

const scope = { serverId: "server-a", userId: "user-a", actorId: "actor-a" };

function profile(defaultModel: string | null): AgentProfileFull {
  return {
    name: "Genie", language: "en", voices: {}, avatar: { kind: "preset", id: "avatar-01" }, avatarUrl: "/api/profile/avatar",
    defaultModel, personality: { prompt: null, tone: null, motherAnswer: null }, privacySpectrum: null, workLifeMode: null,
    soulFile: null, onboardingCompleted: true, welcomeMessageSent: true, agentIdentity: "agent-a", handle: "genie",
    publicProfile: false, fallback: { enabled: false, chain: [] },
  };
}

function owner(defaultModel: string | null): AgentProfileResponse {
  const agent = profile(defaultModel);
  return { viewerRole: "owner", agent, ownedAgents: [{ agentId: "agent-a", handle: "genie", displayName: "Genie" }] };
}

function catalog(): AssistantModelSummary[] {
  return [
    { id: "openai:gpt-5", displayName: "GPT-5", priority: 1, enabled: true, costCoefficient: 1, provider: "OpenAI" },
    { id: "fireworks:kimi-k3", displayName: "Kimi K3", priority: 2, enabled: true, costCoefficient: 1, provider: "Fireworks" },
    { id: "openai:missing", displayName: "Missing", priority: 2, enabled: true, costCoefficient: 1, provider: "OpenAI", availability: "missing-key" },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function fake(initial = "openai:gpt-5") {
  let current: string | null = initial;
  const calls: string[] = [];
  const api: ModelDefaultApi = {
    getProfile: async () => { calls.push("profile:get"); return owner(current); },
    getModels: async (query) => { calls.push(`models:${query?.includeUnavailable}`); return catalog(); },
    resolveRetainedModels: async (ids) => {
      calls.push(`models:resolve:${ids.join(",")}`);
      return ids.map((id) => catalog().find((model) => model.id === id) ?? {
        id,
        displayName: id,
        priority: Number.MAX_SAFE_INTEGER,
        enabled: false,
        costCoefficient: 1,
        provider: "unknown",
        availability: "unknown-model" as const,
      });
    },
    updateProfile: async ({ defaultModel }) => { calls.push(`profile:put:${String(defaultModel)}`); current = defaultModel ?? null; return owner(current); },
  };
  return { api, calls, get current() { return current; } };
}

describe("Agent model default controller", () => {
  test("loads shared catalogue and profile, saves a selectable ID, then refreshes canonical state", async () => {
    const source = fake();
    const controller = createModelDefaultController(() => source.api);
    controller.setScope(scope);
    await controller.load();
    expect(await controller.apply("fireworks:kimi-k3")).toMatchObject({ status: "applied" });
    expect(source.calls).toEqual([
      "profile:get", "models:undefined", "models:resolve:openai:gpt-5",
      "profile:put:fireworks:kimi-k3", "profile:get", "models:undefined",
      "models:resolve:fireworks:kimi-k3",
    ]);
    expect(controller.data.getState().data?.defaultModel).toBe("fireworks:kimi-k3");
    expect(controller.data.getState().draft).toBeNull();
  });

  test("prevents unavailable, unknown, and stale IDs from producing profile writes", async () => {
    const source = fake("retired:model");
    const controller = createModelDefaultController(() => source.api);
    controller.setScope(scope);
    await controller.load();
    for (const modelId of ["openai:missing", "not:a-model"]) {
      let rejection: unknown = null;
      try {
        await controller.apply(modelId);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({ status: 400 });
    }
    expect(source.calls).toEqual([
      "profile:get", "models:undefined", "models:resolve:retired:model",
    ]);
  });

  test("resets through typed profile mutation and reloads canonical state", async () => {
    const source = fake();
    const controller = createModelDefaultController(() => source.api);
    controller.setScope(scope);
    await controller.load();
    expect(await controller.reset()).toMatchObject({ status: "applied" });
    expect(source.calls).toEqual([
      "profile:get", "models:undefined", "models:resolve:openai:gpt-5",
      "profile:put:null", "profile:get", "models:undefined",
    ]);
    expect(controller.data.getState().data?.defaultModel).toBeNull();
  });

  test("restores the canonical radio selection on mutation failure and gives it an actionable message", async () => {
    const source = fake();
    source.api.updateProfile = async () => { throw Object.assign(new Error("server rejected the selection"), { status: 400 }); };
    const controller = createModelDefaultController(() => source.api);
    controller.setScope(scope);
    await controller.load();
    const result = await controller.apply("fireworks:kimi-k3");
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("The fixture must produce a failed save.");
    expect(controller.data.getState().data?.defaultModel).toBe("openai:gpt-5");
    expect(controller.data.getState().draft).toBeNull();
    expect(modelDefaultErrorMessage(result.error)).toContain("no longer accepted");
  });

  test("allows only one immediate model write while a selection is pending", async () => {
    const source = fake();
    const write = deferred<AgentProfileResponse>();
    source.api.updateProfile = async ({ defaultModel }) => {
      source.calls.push(`profile:put:${String(defaultModel)}`);
      return write.promise;
    };
    const controller = createModelDefaultController(() => source.api);
    controller.setScope(scope);
    await controller.load();

    const first = controller.apply("fireworks:kimi-k3");
    expect(controller.data.getState()).toMatchObject({
      mutating: true,
      draft: { modelId: "fireworks:kimi-k3" },
    });
    expect(await controller.apply("openai:gpt-5")).toEqual({ status: "ignored" });
    write.resolve(owner("fireworks:kimi-k3"));
    expect(await first).toMatchObject({ status: "applied" });
    expect(source.calls.filter((call) => call.startsWith("profile:put:"))).toEqual([
      "profile:put:fireworks:kimi-k3",
    ]);
  });

  test("never calls Room override or Admin server-model controls for an Agent default", async () => {
    const source = fake();
    let roomCalls = 0;
    let adminCalls = 0;
    const api = Object.assign(source.api, {
      getRoomModelControlSelection: () => { roomCalls += 1; },
      updateRoomModelControlSelection: () => { roomCalls += 1; },
      serverModels: { get: () => { adminCalls += 1; }, update: () => { adminCalls += 1; } },
    });
    const controller = createModelDefaultController(() => api);
    controller.setScope(scope);
    await controller.load();
    await controller.reset();
    expect(roomCalls).toBe(0);
    expect(adminCalls).toBe(0);
  });
});
