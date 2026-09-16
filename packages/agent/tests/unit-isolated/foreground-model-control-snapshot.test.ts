/** Isolated because database module mocks must not leak into other suites. */
import { beforeEach, expect, mock, test } from "bun:test";
import type { ModelControlSelection } from "@nautilo/types";

const TERRA = "openai:gpt-5.6-terra";
const LUNA = "openai:gpt-5.6-luna";
let room: ModelControlSelection | null = { modelId: TERRA, reasoningEffort: "low" };
let agent: ModelControlSelection | null = { modelId: LUNA };
const readRoom = mock(async () => room ? { selection: room } : null);
const readAgent = mock(async () => agent);
mock.module("@nautilo/db", () => ({
  getRoomAgentModelControlSelection: readRoom,
  getProfileDefaultModelControlSelection: readAgent,
  getCachedServerModelConfigRow: () => ({ reasoningPolicy: { defaultEffort: null, overrides: {} } }),
}));
mock.module("../../src/config/model-catalog/runtime-catalog", () => ({
  getActiveModelCatalogSync: () => ({ catalog: { entries: [TERRA, LUNA].map((id) => ({
    id,
    controls: { reasoning: { levels: ["low", "high"], defaultLevel: "low", canDisable: true, mandatory: false } },
  })) } }),
}));
const {
  loadForegroundModelControlSnapshot,
  foregroundModelControlPlanFromSnapshot,
} = await import("../../src/config/foreground-model-controls");

beforeEach(() => {
  room = { modelId: TERRA, reasoningEffort: "low" };
  agent = { modelId: LUNA };
  readRoom.mockClear();
  readAgent.mockClear();
});

test("history and invocation use the same preferences after live settings change and checkpoint restore", async () => {
  const snapshot = await loadForegroundModelControlSnapshot("room", "agent");
  const unavailableDefault = () => { throw new Error("Default credential missing"); };
  const historyPlan = foregroundModelControlPlanFromSnapshot(snapshot, unavailableDefault);
  room = { modelId: LUNA, reasoningEffort: "high" };
  agent = null;
  const restored = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  const invocationPlan = foregroundModelControlPlanFromSnapshot(restored, unavailableDefault);
  expect(historyPlan.initialModelId).toBe(TERRA);
  expect(invocationPlan.initialModelId).toBe(TERRA);
  expect(invocationPlan.resolveForegroundControls?.(TERRA)?.reasoningEffort).toBe("low");
  expect(readRoom).toHaveBeenCalledTimes(1);
  expect(readAgent).toHaveBeenCalledTimes(1);
});

test("explicit turn choice survives a checkpoint and outranks retained Room preferences", async () => {
  const snapshot = await loadForegroundModelControlSnapshot("room", "agent", LUNA);
  const restored = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  const plan = foregroundModelControlPlanFromSnapshot(restored, () => TERRA);
  expect(plan.initialModelId).toBe(LUNA);
  expect(readRoom).toHaveBeenCalledTimes(1);
});
