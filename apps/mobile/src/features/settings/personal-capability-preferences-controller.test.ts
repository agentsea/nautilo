/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { PersonalCapabilityPreferencesResponse } from "@nautilo/api-client/browser";
import { createPersonalCapabilityPreferencesController } from "./personal-capability-preferences-controller";

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
});
