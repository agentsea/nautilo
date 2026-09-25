#!/usr/bin/env bun

/** Live, synthetic Choice probe for a screenshot-derived keyboard grid. No browser is mutated. */
import { configureRuntimeModelCatalog } from "../../../packages/agent/src/config/model-catalog/runtime-catalog.ts";
import { resolveCatalogModel } from "../../../packages/agent/src/config/resolved-catalog.ts";
import {
  browserDecisionCandidates,
  browserDecisionAdditionalInstructions,
  browserDecisionChoiceInput,
  browserDecisionPlanSchema,
  type BrowserDecisionObservation,
} from "../../../packages/agent/src/graph/browser-decision.ts";
import { runCapturedJevChoice } from "./jev-evaluation.ts";

const modelId = "openrouter:typesafe/jev-1.13";
const focus = process.argv[2] ?? "page";
const compact = process.argv[3] === "compact";
const labelledBlanks = process.argv[4] === "blanks";
if (!["page", "canvas", "editable", "other", "unknown"].includes(focus)) {
  throw new Error("Usage: bun run-keyboard-choice.ts [page|canvas|editable|other|unknown]");
}

configureRuntimeModelCatalog({ catalogPointerUrl: null });
const maxChoices = resolveCatalogModel(modelId).decision?.maxChoices;
if (maxChoices === undefined) throw new Error("Decision model has no Choice capacity");

const plan = browserDecisionPlanSchema.parse({
  goal: "Read the current 4×4 keyboard-controlled grid and make exactly one best strategic move with an arrow key. Verify after the move that the score or board changed.",
  constraints: [
    "Two equal 4 values are visible; determine occupied cells before acting.",
    "Prefer a move that merges equal values or sets up a merge while keeping values near an edge.",
    "Do not start a new game; make no move if the grid is not confidently readable.",
  ],
  allowedOrigins: ["https://example.test"],
  actions: [{ kind: "click_observed" }, ...["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
    .map((key) => ({ kind: "press" as const, key }))],
});

const cells = Array.from({ length: 16 }, (_, index) => ({
  visualRef: `v${index + 1}`,
  role: "grid item",
  name: index === 7 || index === 10 ? "4" : labelledBlanks ? "visually blank" : "unlabelled visual region",
  interaction: "unknown" as const,
  x: 120 + index % 4 * 120,
  y: 120 + Math.floor(index / 4) * 120,
  context: `grid-1; row ${Math.floor(index / 4) + 1} of 4; column ${index % 4 + 1} of 4`,
  layout: { groupId: "grid-1", kind: "grid" as const, ordinal: index + 1, itemCount: 16,
    row: Math.floor(index / 4) + 1, column: index % 4 + 1, rows: 4, columns: 4 },
}));
const surroundingRegions = Array.from({ length: compact ? 0 : 40 }, (_, index) => ({
  visualRef: `v${index + 17}`,
  role: "visual region",
  name: "unlabelled visual region",
  interaction: "unknown" as const,
  x: 10 + index % 20 * 35,
  y: index < 20 ? 20 : 690,
  context: "unlabelled visual region outside the grid",
}));
const observation: BrowserDecisionObservation = {
  version: 1,
  pageUrl: "https://example.test/board",
  browserSessionId: "synthetic-session",
  observationId: "synthetic-observation",
  snapshot: "- visual viewport",
  refs: {},
  visual: {
    viewport: { imageWidth: 800, imageHeight: 800, cssWidth: 800, cssHeight: 800, dpr: 1 },
    keyboardFocus: focus as "page" | "canvas" | "editable" | "other" | "unknown",
    targets: [...cells, ...surroundingRegions],
  },
};
const built = browserDecisionCandidates(plan, observation, maxChoices);
if (built.reason !== null) throw new Error(built.reason);
const input = browserDecisionChoiceInput({
  modelId, signal: new AbortController().signal, plan, observation, candidates: built.candidates,
  additionalInstructions: browserDecisionAdditionalInstructions(observation),
});
const started = performance.now();
const { result } = await runCapturedJevChoice(input, maxChoices);
const selected = built.candidates.find((candidate) => candidate.id === result.selectedId);
const selectedKey: unknown = selected?.call?.args["key"];
console.log(JSON.stringify({
  keyboardFocus: focus,
  compact,
  labelledBlanks,
  candidateCount: built.candidates.length,
  selectedId: result.selectedId,
  selectedAction: selected?.call?.name === "browser_press"
    ? typeof selectedKey === "string" ? selectedKey : null
    : selected?.call?.name ?? null,
  choiceCalls: result.choiceCalls,
  screeningRounds: result.screeningRounds,
  elapsedMs: Math.round(performance.now() - started),
}, null, 2));
