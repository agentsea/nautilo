import { describe, expect, test } from "bun:test";
import { loadBaselineTasks, loadCapture } from "./baseline.ts";
import { parseVisualBaselineArgs, parseVisualGroundingText } from "./run-visual-baseline.ts";
import {
  loadVisualOracles,
  normalized1000ToImagePixels,
  prepareVisualDecision,
  renderVisualSnapshot,
  scoreVisualSelection,
  visualDecisionCandidates,
  type VisualGrounding,
} from "./visual-grounding.ts";

const MODEL_ID = "openrouter:typesafe/jev-1.13";

describe("Sol screenshot visual grounding baseline", () => {
  test("keeps one reviewed coordinate oracle for every captured task", async () => {
    const tasks = await loadBaselineTasks();
    const oracles = await loadVisualOracles();
    expect(oracles.map(({ caseId }) => caseId)).toEqual(tasks.map(({ caseId }) => caseId));
    for (const oracle of oracles) {
      const capture = await loadCapture(oracle.caseId);
      expect(oracle.expectedTarget.region.xMax).toBeLessThanOrEqual(capture.viewport.image.width);
      expect(oracle.expectedTarget.region.yMax).toBeLessThanOrEqual(capture.viewport.image.height);
    }
  });

  test("parses strict JSON or one JSON fence and rejects out-of-image coordinates", () => {
    const json = JSON.stringify({
      summary: "Form",
      visibleText: ["Name"],
      targets: [{ role: "textbox", name: "Name", interaction: "focus", x: 500, y: 300, context: "Simple form" }],
    });
    expect(parseVisualGroundingText(json, { width: 1000, height: 800 }).targets).toHaveLength(1);
    expect(parseVisualGroundingText(`\`\`\`json\n${json}\n\`\`\``, { width: 1000, height: 800 }).summary).toBe("Form");
    expect(parseVisualGroundingText(json.replace('"x":500,"y":300', '"x":[500,300]'), { width: 1000, height: 800 }).targets[0])
      .toMatchObject({ x: 500, y: 300 });
    expect(() => parseVisualGroundingText(json.replace('"x":500', '"x":1000'), { width: 1000, height: 800 })).toThrow(/outside/);
  });

  test("renders task-independent visual state and exposes mouse plus vertical scroll operations", async () => {
    const task = (await loadBaselineTasks()).find(({ caseId }) => caseId === "room3-initial")!;
    const grounding: VisualGrounding = {
      summary: "A simple form",
      visibleText: ["Room #3: Simple form"],
      targets: [
        { role: "textbox", name: "Name", interaction: "focus", x: 1080, y: 290, context: "Name field" },
        { role: "button", name: "SUBMIT", interaction: "click", x: 1080, y: 790, context: "Form submit" },
      ],
    };
    const snapshot = renderVisualSnapshot(grounding, { width: 2168, height: 1404 });
    expect(snapshot).toContain("visual_ref=v1");
    expect(snapshot).toContain("image_x=1080");
    const candidates = visualDecisionCandidates(task, grounding);
    expect(candidates.find(({ id }) => id === "scroll_up")?.call).toEqual({ name: "browser_scroll", args: { direction: "up" } });
    expect(candidates.find(({ id }) => id === "scroll_down")?.call).toEqual({ name: "browser_scroll", args: { direction: "down" } });
    expect(candidates.find(({ id }) => id === "reobserve")?.call).toEqual({ name: "browser_screenshot", args: {} });
    const focus = candidates.find(({ id }) => id === "visual_v1_value_1")!;
    expect(focus.call).toEqual({ name: "browser_mouse", args: { x: 1080, y: 290, space: "image" } });
    expect(focus.description).toContain('"value":"Robbie"');
  });

  test("scores Jev's selected visual target by reviewed screenshot region", async () => {
    const task = (await loadBaselineTasks()).find(({ caseId }) => caseId === "room15-second-row")!;
    const capture = await loadCapture(task.caseId);
    const oracle = (await loadVisualOracles()).find(({ caseId }) => caseId === task.caseId)!;
    const grounding: VisualGrounding = {
      summary: "Puzzle with pieces 1 through 7 placed",
      visibleText: ["Pieces must be placed in numerical order"],
      targets: [{ role: "puzzle piece", name: "8", interaction: "click", x: 1140, y: 1060, context: "Unplaced pieces" }],
    };
    const prepared = prepareVisualDecision({ task, capture, grounding, modelId: MODEL_ID, signal: new AbortController().signal });
    expect(scoreVisualSelection(prepared, oracle, "visual_v1").passed).toBe(true);
    expect(scoreVisualSelection(prepared, oracle, "scroll_down").passed).toBe(false);
  });

  test("converts Qwen3-VL normalized points into executable image pixels", () => {
    const grounding: VisualGrounding = {
      summary: "Centered button",
      visibleText: ["CLICK ON ME!"],
      targets: [{ role: "button", name: "CLICK ON ME!", interaction: "click", x: 500, y: 500, context: "center" }],
    };
    expect(normalized1000ToImagePixels(grounding, { width: 2168, height: 1404 }).targets[0])
      .toMatchObject({ x: 1084, y: 702 });
  });

  test("parses visual baseline CLI modes", () => {
    expect(parseVisualBaselineArgs([])).toEqual({
      live: false,
      caseId: null,
      visionModelId: "openai:gpt-5.6-sol",
      directOpenRouterModel: null,
      decisionModelId: MODEL_ID,
    });
    expect(parseVisualBaselineArgs(["--live", "--case", "room15-second-row"])).toMatchObject({
      live: true,
      caseId: "room15-second-row",
    });
    expect(() => parseVisualBaselineArgs(["--vision-model"])).toThrow();
    expect(parseVisualBaselineArgs(["--direct-openrouter-model", "qwen/qwen3.8-max-0902"]))
      .toMatchObject({ directOpenRouterModel: "qwen/qwen3.8-max-0902" });
    expect(() => parseVisualBaselineArgs(["--direct-openrouter-model", "openrouter:qwen/model"]))
      .toThrow(/without a Nautilo prefix/);
  });
});
