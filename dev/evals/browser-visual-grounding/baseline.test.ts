import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { chooseBrowserAction } from "../../../packages/agent/src/graph/browser-choice.ts";
import {
  candidatesMatchingExpectation,
  choiceInputReceipt,
  loadBaselineTasks,
  prepareBaselineCase,
  scoreBaselineSelection,
} from "./baseline.ts";
import { parseBaselineArgs } from "./run-baseline.ts";
import { parseCorpusIndex } from "./schema.ts";

const MODEL_ID = "openrouter:typesafe/jev-1.13";
const MAX_CHOICES = 255;

describe("browser visual-grounding Jev baseline", () => {
  test("defines exactly one task for each captured case", async () => {
    const tasks = await loadBaselineTasks();
    const corpus = parseCorpusIndex(JSON.parse(await readFile(path.join(import.meta.dir, "cases", "manifest.json"), "utf8")));
    expect(tasks.map(({ caseId }) => caseId)).toEqual(corpus.cases.map(({ id }) => id));
  });

  test("deterministically generates every oracle action and exact production Choice input", async () => {
    for (const task of await loadBaselineTasks()) {
      const first = await prepareBaselineCase({ task, modelId: MODEL_ID, maxChoices: MAX_CHOICES, signal: new AbortController().signal });
      const second = await prepareBaselineCase({ task, modelId: MODEL_ID, maxChoices: MAX_CHOICES, signal: new AbortController().signal });
      expect(first.candidateDigest).toBe(second.candidateDigest);
      expect(choiceInputReceipt(first.input)).toEqual(choiceInputReceipt(second.input));
      expect(candidatesMatchingExpectation(first)).toHaveLength(1);
    }
  });

  test("scores a single production choice loop without executing browser actions", async () => {
    for (const task of await loadBaselineTasks()) {
      const prepared = await prepareBaselineCase({ task, modelId: MODEL_ID, maxChoices: MAX_CHOICES, signal: new AbortController().signal });
      const expected = candidatesMatchingExpectation(prepared)[0]!;
      const requests: unknown[] = [];
      const result = await chooseBrowserAction(prepared.input, MAX_CHOICES, async (input) => {
        requests.push(choiceInputReceipt(input));
        return {
          selectedId: expected.id,
          requestedModelId: MODEL_ID,
          resolvedModelId: MODEL_ID,
          usage: { inputTokens: 1, outputTokens: 0, actualCostUsd: 0 },
        };
      });
      expect(requests).toHaveLength(1);
      expect(scoreBaselineSelection(prepared, result.selectedId).passed).toBe(true);
      expect(result.choiceCalls).toBe(1);
      expect(result.screeningRounds).toBe(0);
    }
  });

  test("parses explicit dry-run and live CLI modes", () => {
    expect(parseBaselineArgs([])).toEqual({ live: false, caseId: null, modelId: MODEL_ID });
    expect(parseBaselineArgs(["--live", "--case", "room2-initial"])).toEqual({ live: true, caseId: "room2-initial", modelId: MODEL_ID });
    expect(() => parseBaselineArgs(["--case"])).toThrow();
    expect(() => parseBaselineArgs(["--unknown"])).toThrow();
  });
});
