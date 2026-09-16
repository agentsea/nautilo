/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { AssistantModelSummary } from "@nautilo/api-client/browser";

import { modelDefaultDisplay, modelPickerGroups } from "./model-default-presentation";

function model(overrides: Partial<AssistantModelSummary>): AssistantModelSummary {
  return {
    id: "openai:gpt-5", displayName: "GPT-5", priority: 1, enabled: true, costCoefficient: 1,
    provider: "OpenAI", ...overrides,
  };
}

describe("model-default presentation", () => {
  test("searches and groups the shared catalogue while retaining unavailable rows", () => {
    const models = [
      model({ id: "openai:gpt-5", displayName: "GPT-5", provider: "OpenAI" }),
      model({ id: "anthropic:sonnet", displayName: "Sonnet", provider: "Anthropic" }),
      model({ id: "openai:missing", displayName: "Missing key", availability: "missing-key", unavailableReason: "Add an OpenAI key." }),
    ];
    expect(modelPickerGroups(models, "", null).map((group) => group.label)).toEqual(["Anthropic", "OpenAI"]);
    const unavailable = modelPickerGroups(models, "missing", null)[0]?.rows[0];
    expect(unavailable?.id).toBe("openai:missing");
    expect(unavailable?.selectable).toBe(false);
    expect(unavailable?.description).toContain("Add an OpenAI key.");
    expect(modelPickerGroups(models, "gpt", "openai:gpt-5")[0]?.rows[0]).toMatchObject({ selected: true, selectable: true });
  });

  test("shows stale and unavailable saved IDs truthfully without treating either as selectable", () => {
    const stale = modelDefaultDisplay("retired:model", []);
    expect(stale.label).toBe("retired:model");
    expect(stale.selectable).toBe(false);
    expect(stale.detail).toContain("no longer");
    expect(modelDefaultDisplay("openai:missing", [model({ id: "openai:missing", availability: "missing-key" })])).toMatchObject({ selectable: false });
  });
});
