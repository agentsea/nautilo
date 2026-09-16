import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { DirectDatabase, Task } from "@nautilo/db";
import type { MemoryAccessEnvelope, PolicyResolver } from "@nautilo/trust";

// Exercise real dispatch and model selection. Only persistence, room lookup,
// profile retrieval and non-model authorization fixtures are replaced. No DB,
// network, provider execution or stored operator settings are used.
const agent = await import("@nautilo/agent");
const dbModule = await import("@nautilo/db");
const trust = await import("@nautilo/trust");
let configuredModel: string | null = "openai:gpt-5.6-sol";
const inserted: Array<{ modelId: string }> = [];
const jobs: Record<string, unknown>[] = [];
mock.module("@nautilo/db", () => ({ ...dbModule,
  getLatestResumableTaskRun: async () => undefined,
  insertTaskRun: async (_db: unknown, input: { modelId: string }) => {
    inserted.push(input);
    return { id: "run-model-fixture", ...input };
  },
  markTaskRunning: async () => {},
}));
mock.module("@nautilo/agent", () => ({ ...agent,
  getProfileByAgentId: async () => configuredModel === null ? undefined
    : { defaultModel: configuredModel, name: "Research fixture" },
  validateSubagentToolWhitelist: ({ requestedTools }: { requestedTools: string[] }) => ({ ok: true, whitelist: requestedTools }),
}));
mock.module("@nautilo/trust", () => ({ ...trust, findActorByOwnerId: async () => null }));
mock.module("../../src/tasks/resolve-target-room", () => ({
  resolveTargetRoom: async () => ({ roomId: "", graphThreadId: "subagent:model-fixture" }),
}));
const { dispatchTaskRun } = await import("../../src/tasks/dispatch-task-run");
const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY", "FIREWORKS_API_KEY", "OPENROUTER_API_KEY", "VENICE_API_KEY",
  "NAUTILO_ALLOW_CHINA_UPSTREAM", "NAUTILO_MODEL"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of keys) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env["OPENAI_API_KEY"] = "fixture";
  process.env["OPENROUTER_API_KEY"] = "fixture";
  process.env["ANTHROPIC_API_KEY"] = "fixture";
  process.env["NAUTILO_MODEL"] = "anthropic:claude-sonnet-4-6";
  configuredModel = "openai:gpt-5.6-sol";
  inserted.length = 0;
  jobs.length = 0;
});
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const envelope: MemoryAccessEnvelope = {
  memoryMode: "namespace", ownerId: "owner", actorId: "actor", agentId: "agent", roomId: "",
  readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: {},
};
async function dispatch(overrides: Partial<Task> = {}) {
  const task = { id: "task-model-fixture", ownerId: "owner", requestorId: "owner", agentId: "agent",
    targetChat: "orphan", targetRoomId: "", callingRoomId: null, targetUserIds: ["owner"],
    awaitResponse: false, useScope: false, preset: "in_background", prompt: "Audit the authorized fixture.",
    depth: 0, parentTaskId: null, toolsMode: "whitelist", toolsWhitelist: ["file", "security_scan"],
    selectionProfile: "balanced", selectionSpec: null, requestedModelId: null, metadata: {},
    ...overrides } as Task;
  const result = await dispatchTaskRun(task, {
    db: {} as DirectDatabase,
    resolver: { buildEnvelope: async () => envelope } as unknown as PolicyResolver,
    assertInvocation: async () => {},
    jobManager: { createForegroundJob: async (_owner, _requestor, _lane, input) => {
      jobs.push(input);
      return { id: "job-model-fixture", virtualJobId: "job-model-fixture" };
    } },
  });
  expect(result.kind).toBe("dispatched");
  expect(inserted).toHaveLength(1);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.["modelId"]).toBe(inserted[0]?.modelId);
  return jobs[0]!;
}

test("security dispatch retains configured Sol despite eligible preferred GLM", async () => {
  // Establish that the old automatic preference would choose a different model.
  expect(agent.resolveTaskModel({ baseModelId: configuredModel!, taskPreference: "security_research" }).modelId)
    .toBe("openrouter:z-ai/glm-5.3");
  const job = await dispatch();
  expect(job["modelId"]).toBe("openai:gpt-5.6-sol");
  expect(job["exactModelSelection"]).toBe(false);
});

test("security dispatch follows the actual configured default, including explicit GLM", async () => {
  configuredModel = "anthropic:claude-sonnet-4-6";
  expect((await dispatch())["modelId"]).toBe(configuredModel);
  inserted.length = 0; jobs.length = 0;
  configuredModel = "openrouter:z-ai/glm-5.3";
  expect((await dispatch())["modelId"]).toBe(configuredModel);
});

test("without an Agent override dispatch retains the ordinary product default", async () => {
  configuredModel = null;
  const expected = agent.getDefaultModel().id;
  expect((await dispatch())["modelId"]).toBe(expected);
  inserted.length = 0; jobs.length = 0;
  configuredModel = "   ";
  expect((await dispatch())["modelId"]).toBe(expected);
});

test("security dispatch keeps exact pins strict and fails before writes when unavailable", async () => {
  const requestedModelId = "anthropic:claude-sonnet-4-6";
  configuredModel = "venice:z-ai-glm-5-3"; // Unavailable base must not replace or block an explicit valid pin.
  const job = await dispatch({ requestedModelId });
  expect(job["modelId"]).toBe(requestedModelId);
  expect(job["exactModelSelection"]).toBe(true);
  inserted.length = 0; jobs.length = 0;
  configuredModel = null;
  process.env["NAUTILO_MODEL"] = "unavailable:configured-default";
  expect((await dispatch({ requestedModelId }))["modelId"]).toBe(requestedModelId);
  inserted.length = 0; jobs.length = 0;
  delete process.env["ANTHROPIC_API_KEY"];
  const failure = await dispatch({ requestedModelId }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toMatch(/credential/i);
  expect(inserted).toHaveLength(0);
  expect(jobs).toHaveLength(0);
});

test("security dispatch preserves explicit profiles and specifications", async () => {
  const profile = "most_private";
  const expected = agent.resolveTaskModel({ baseModelId: configuredModel!, profile }).modelId;
  expect((await dispatch({ selectionProfile: profile }))["modelId"]).toBe(expected);
  inserted.length = 0; jobs.length = 0;
  const spec = { objective: "smart" as const, absoluteFloors: { privacy: 4 } };
  const specified = agent.resolveTaskModel({ baseModelId: configuredModel!, spec }).modelId;
  expect((await dispatch({ selectionSpec: spec }))["modelId"]).toBe(specified);
});

test("balanced security dispatch respects existing operator routing consent", async () => {
  configuredModel = "venice:z-ai-glm-5-3";
  process.env["VENICE_API_KEY"] = "fixture";
  const failure = await dispatch().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toMatch(/not runnable/);
  expect(inserted).toHaveLength(0);
  expect(jobs).toHaveLength(0);
  process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "true";
  expect((await dispatch())["modelId"]).toBe(configuredModel);
});


test("exact security pin honors operator consent and revalidates its removal before writes", async () => {
  const requestedModelId = "venice:z-ai-glm-5-3";
  process.env["VENICE_API_KEY"] = "fixture";
  process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "true";
  const job = await dispatch({ requestedModelId });
  expect(job["modelId"]).toBe(requestedModelId);
  expect(job["exactModelSelection"]).toBe(true);
  inserted.length = 0; jobs.length = 0;
  delete process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
  const failure = await dispatch({ requestedModelId }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toMatch(/routing|allowChinaUpstream/);
  expect(inserted).toHaveLength(0);
  expect(jobs).toHaveLength(0);
});
