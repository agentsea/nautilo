import { describe, expect, mock, test } from "bun:test";
import type { AssistantModelSummary } from "@nautilo/api-client/browser";
import { loadCallerModelRows } from "./caller-model-availability";

function row(
  id: string,
  availability: AssistantModelSummary["availability"],
): AssistantModelSummary {
  return {
    id,
    displayName: id,
    priority: 1,
    enabled: availability === "selectable",
    costCoefficient: 1,
    availability,
    capabilities: {
      tools: false,
      vision: false,
      reasoning: false,
      e2ee: false,
      webSearch: false,
    },
  };
}

describe("loadCallerModelRows", () => {
  test("supplements an existing caller snapshot without reloading its eligibility", async () => {
    const getCallerModels = mock(async () => []);
    const resolveRetainedModels = mock(async () => [row("legacy:model", "selectable")]);
    const rows = await loadCallerModelRows({ getCallerModels, resolveRetainedModels },
      ["legacy:model"], [row("personal:model", "selectable")]);
    expect(getCallerModels).not.toHaveBeenCalled();
    expect(rows.find((model) => model.id === "personal:model")?.availability).toBe("selectable");
    expect(rows.find((model) => model.id === "legacy:model")?.availability).toBe("filtered");
  });

  test("keeps caller availability authoritative and resolves only missing saved IDs", async () => {
    const resolveRetainedModels = mock(async () => [
      row("legacy:model", "selectable"),
    ]);
    const rows = await loadCallerModelRows({
      getCallerModels: mock(async () => [
        row("personal:model", "selectable"),
        row("server:model", "missing-key"),
      ]),
      resolveRetainedModels,
    }, ["personal:model", "server:model", "legacy:model"]);

    expect(resolveRetainedModels).toHaveBeenCalledWith(["legacy:model"]);
    expect(rows.find((model) => model.id === "personal:model")?.availability).toBe("selectable");
    expect(rows.find((model) => model.id === "server:model")?.availability).toBe("missing-key");
    expect(rows.find((model) => model.id === "legacy:model")).toMatchObject({
      availability: "filtered",
      unavailableReason: "This saved model is not available for your account.",
    });
  });
});
