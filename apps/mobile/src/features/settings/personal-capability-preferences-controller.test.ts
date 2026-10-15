/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { PersonalCapabilityPreferencesResponse } from "@nautilo/api-client/browser";
import {
  createPersonalCapabilityPreferencesController,
  personalCapabilityDescription,
  personalCapabilityPickerOptions,
  personalCapabilityReadinessLabel,
  personalCapabilitySelectionDisplayName,
} from "./personal-capability-preferences-controller";

const scope = { serverId: "server-a", userId: "user-a", actorId: "actor-a" };

function snapshot(revision = 0): PersonalCapabilityPreferencesResponse {
  return {
    revision,
    overrides: {},
    fundingPreference: "personal_first",
    capabilities: [{
      role: "webSearchSynthesis",
      label: "Search synthesis",
      description: "Writes the answer from gathered sources.",
      selection: { source: "inherited", modelId: "openrouter:model-a", displayName: "Model A" },
      readiness: { status: "missing-credentials", reason: "Add a key.", fundingSource: null, providerRoute: null },
      options: [{
        modelId: "openrouter:model-a",
        displayName: "Model A",
        provider: "openrouter",
        readiness: { status: "missing-credentials", reason: "Add a key.", fundingSource: null, providerRoute: null },
      }],
    }],
  };
}

describe("personal capability preferences controller", () => {
  test("saves a missing-credential option and refreshes canonical state", async () => {
    let current = snapshot();
    const writes: unknown[] = [];
    const controller = createPersonalCapabilityPreferencesController(() => ({
      getPersonalCapabilityPreferences: async () => current,
      replacePersonalCapabilityPreferences: async (input) => {
        writes.push(input);
        current = { ...current, revision: 1, overrides: input.overrides };
        return current;
      },
    }));
    controller.setScope(scope);
    await controller.load();
    expect(await controller.apply("webSearchSynthesis", "openrouter:model-a")).toMatchObject({ status: "applied" });
    expect(writes).toEqual([{ expectedRevision: 0, overrides: { webSearchSynthesis: "openrouter:model-a" } }]);
    expect(controller.data.getState().data?.overrides).toEqual({ webSearchSynthesis: "openrouter:model-a" });
  });

  test("reset omits the role and a conflict reloads current server state", async () => {
    let reads = 0;
    const saved = { ...snapshot(2), overrides: { webSearchSynthesis: "openrouter:model-a" } };
    const replacement = snapshot(3);
    const controller = createPersonalCapabilityPreferencesController(() => ({
      getPersonalCapabilityPreferences: async () => (++reads === 1 ? saved : replacement),
      replacePersonalCapabilityPreferences: async () => {
        throw Object.assign(new Error("conflict"), { status: 409 });
      },
    }));
    controller.setScope(scope);
    await controller.load();
    expect((await controller.apply("webSearchSynthesis", null)).status).toBe("failed");
    expect(controller.data.getState().data).toEqual(replacement);
  });

  test("rejects models absent from the server-projected role options", async () => {
    let writes = 0;
    const controller = createPersonalCapabilityPreferencesController(() => ({
      getPersonalCapabilityPreferences: async () => snapshot(),
      replacePersonalCapabilityPreferences: async () => { writes += 1; return snapshot(1); },
    }));
    controller.setScope(scope);
    await controller.load();
    expect(controller.apply("webSearchSynthesis", "openai:unknown")).rejects.toThrow();
    expect(writes).toBe(0);
  });

  test("retains a saved model missing from current options and still resets to inherit", async () => {
    let current: PersonalCapabilityPreferencesResponse = {
      ...snapshot(),
      overrides: { webSearchSynthesis: "openrouter:retired-model" },
      capabilities: [{
        ...snapshot().capabilities[0],
        selection: {
          source: "personal",
          modelId: "openrouter:retired-model",
          displayName: "Retired Model",
        },
      }],
    };
    const writes: unknown[] = [];
    const controller = createPersonalCapabilityPreferencesController(() => ({
      getPersonalCapabilityPreferences: async () => current,
      replacePersonalCapabilityPreferences: async (input) => {
        writes.push(input);
        current = { ...current, revision: 1, overrides: input.overrides };
        return current;
      },
    }));
    controller.setScope(scope);
    await controller.load();

    expect(personalCapabilityPickerOptions(
      current.capabilities[0],
      "",
      "openrouter:retired-model",
    )[1]).toEqual({
      id: "openrouter:retired-model",
      label: "Retired Model",
      description: "openrouter:retired-model · Retained unavailable choice",
      disabled: true,
    });
    expect((await controller.apply("webSearchSynthesis", null)).status).toBe("applied");
    expect(writes).toEqual([{ expectedRevision: 0, overrides: {} }]);
  });

  test("applies and independently resets the projected image understanding role", async () => {
    let current = {
      ...snapshot(),
      capabilities: [{
        role: "imageUnderstanding" as const,
        label: "Image understanding",
        description: "Reads and reasons about attached images without generating them.",
        selection: { source: "inherited" as const, modelId: "openai:gpt-5.4-mini", displayName: "GPT-5.4 mini" },
        readiness: { status: "ready" as const, reason: null, fundingSource: "server" as const, providerRoute: "openai" },
        options: [{
          modelId: "openai:gpt-5.4-mini",
          displayName: "GPT-5.4 mini",
          provider: "openai",
          readiness: { status: "ready" as const, reason: null, fundingSource: "server" as const, providerRoute: "openai" },
        }],
      }],
    } satisfies PersonalCapabilityPreferencesResponse;
    const writes: unknown[] = [];
    const controller = createPersonalCapabilityPreferencesController(() => ({
      getPersonalCapabilityPreferences: async () => current,
      replacePersonalCapabilityPreferences: async (input) => {
        writes.push(input);
        current = { ...current, revision: current.revision + 1, overrides: input.overrides };
        return current;
      },
    }));
    controller.setScope(scope);
    await controller.load();

    expect((await controller.apply("imageUnderstanding", "openai:gpt-5.4-mini")).status).toBe("applied");
    expect((await controller.apply("imageUnderstanding", null)).status).toBe("applied");
    expect(writes).toEqual([
      { expectedRevision: 0, overrides: { imageUnderstanding: "openai:gpt-5.4-mini" } },
      { expectedRevision: 1, overrides: {} },
    ]);
  });

  test("presents inherited, explicit, and unavailable image understanding choices", () => {
    const capability = {
      role: "imageUnderstanding" as const,
      label: "Image understanding",
      description: "Reads images.",
      selection: { source: "inherited" as const, modelId: "openai:gpt-5.4-mini", displayName: "GPT-5.4 mini" },
      readiness: { status: "ready" as const, reason: null, fundingSource: "server" as const, providerRoute: "openai" },
      options: [{
        modelId: "openrouter:qwen/qwen3-vl",
        displayName: "Qwen3 VL",
        provider: "openrouter",
        readiness: { status: "missing-credentials" as const, reason: "Add an OpenRouter key.", fundingSource: null, providerRoute: null },
      }],
    };

    expect(personalCapabilityPickerOptions(capability, "qwen")).toEqual([
      {
        id: "__inherit__",
        label: "Inherit · GPT-5.4 mini",
        description: "Follow the current workflow default.",
      },
      {
        id: "openrouter:qwen/qwen3-vl",
        label: "Qwen3 VL",
        description: "openrouter:qwen/qwen3-vl · openrouter · Add an OpenRouter key.",
      },
    ]);
  });

  test("explains image funding per chat and preserves readiness reasons", () => {
    const capability = {
      role: "imageUnderstanding" as const,
      label: "Image understanding",
      description: "Reads images.",
      selection: { source: "inherited" as const, modelId: null, displayName: "Automatic" },
      readiness: {
        status: "ready" as const,
        reason: "Server uses Vision A; personal chats use Vision B.",
        fundingSource: null,
        providerRoute: null,
      },
      options: [{
        modelId: "openai:vision-a",
        displayName: "Vision A",
        provider: "openai",
        readiness: {
          status: "ready" as const,
          reason: "Available only when the chat uses server funding.",
          fundingSource: "server" as const,
          providerRoute: "openai",
        },
      }],
    };

    expect(personalCapabilitySelectionDisplayName(capability)).toBe("Automatic — depends on chat funding");
    expect(personalCapabilityDescription(capability)).toContain("follows the current chat funding");
    expect(personalCapabilityReadinessLabel(capability)).toBe(
      "Both funding sources · Server uses Vision A; personal chats use Vision B.",
    );
    expect(personalCapabilityPickerOptions(capability, "")).toEqual([
      {
        id: "__inherit__",
        label: "Inherit · Automatic — depends on chat funding",
        description: "Follow the current workflow default. Server uses Vision A; personal chats use Vision B.",
      },
      {
        id: "openai:vision-a",
        label: "Vision A",
        description: "openai:vision-a · openai · Server-funded chats only · Available only when the chat uses server funding.",
      },
    ]);
  });
});
