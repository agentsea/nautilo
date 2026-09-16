import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  InvalidModelControlSelectionError,
  parseModelControlSelection,
} from "../model-control-selection";

describe("parseModelControlSelection", () => {
  test("round-trips the provider-neutral persisted bundle", () => {
    expect(
      parseModelControlSelection({
        modelId: "fireworks:accounts/fireworks/models/kimi-k3",
        reasoningEffort: "high",
        servingProfileId: "fast",
      }),
    ).toEqual({
      modelId: "fireworks:accounts/fireworks/models/kimi-k3",
      reasoningEffort: "high",
      servingProfileId: "fast",
    });
  });

  test("rejects provider request fields and malformed safe IDs", () => {
    expect(() =>
      parseModelControlSelection({
        modelId: "fireworks:accounts/fireworks/models/kimi-k3",
        service_tier: "priority",
      }),
    ).toThrow(InvalidModelControlSelectionError);
    expect(() => parseModelControlSelection({ modelId: "not a model id" })).toThrow(
      InvalidModelControlSelectionError,
    );
  });
});

describe("D462 migration", () => {
  test("adds an optional profile bundle and Room+Agent-isolated override table", () => {
    const migrationPath = fileURLToPath(
      new URL("../../migrations/0113_d462_model_control_selection.sql", import.meta.url),
    );
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain('ADD COLUMN "default_model_control_selection" jsonb');
    expect(sql).toContain('CREATE TABLE "room_agent_model_control_selections"');
    expect(sql).toContain('PRIMARY KEY("room_id","agent_id")');
    expect(sql).toContain('ON DELETE cascade');
  });
});
