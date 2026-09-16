import { expect, spyOn, test } from "bun:test";
import { runWithTurn, setLogOutput } from "@nautilo/logger";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { NautiloStateAnnotation, type NautiloState } from "../../src/agent/state";
import { createResearchNoteDraft, resolveResearchNoteControls } from "../../src/tools/security/research-note-draft";
import { localModelCatalog } from "../../src/config/model-catalog/catalog";
import { researchNoteDraftNodes } from "../../src/tools/security/research-note-draft-nodes";

const fw = "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731";
const or = "openrouter:deepseek/deepseek-v4-flash-0731";
function fixture(): NautiloState {
  const messages = [new AIMessage({ content: "Observed access guard", tool_calls: [{ id: "read", name: "file", args: { command: "read", path: "access.js" } }],
    additional_kwargs: { reasoning_content: "PRIVATE_REASONING" } }),
  new ToolMessage({ tool_call_id: "read", name: "file", status: "error", content: "Access denied", additional_kwargs: { sidecar: "PRIVATE_SIDECAR" } })];
  return { userId: "owner", agentId: "agent", roomId: "", currentTaskId: "task", currentTaskRunId: "run", taskRun: true,
    subagentRun: true, researchWorkEnabled: true, model: "fireworks:accounts/fireworks/models/glm-5p3", toolWhitelist: ["security_scan", "file"],
    messages, preparedMessages: [new SystemMessage("PRIVATE_SYSTEM"), new HumanMessage("PRIVATE_HUMAN"), ...messages], memoryAccessEnvelope: null,
    taskReportBackContinuation: { status: "available", relayId: "relay", relaySessionId: "session", desktopSessionId: "desktop",
      pairingGeneration: "generation", currentFolder: "/source", workspacePath: "/source" },
  } as NautiloState;
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: (value: BaseMessage) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<BaseMessage>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("one asynchronous draft sees only prepared visible AI/tool inputs and prefers the configured provider", async () => {
  const state = fixture();
  const original = JSON.stringify(state);
  const work = deferred();
  const requests: string[] = [];
  const helper = createResearchNoteDraft(undefined, { eligibleIds: () => [fw, or], invoke: (request) => {
    expect(request.modelId).toBe(fw);
    expect(request.controls).toEqual({ canonicalModelId: fw, reasoningEffort: "off" });
    expect(request.messages).toHaveLength(2);
    expect(SystemMessage.isInstance(request.messages[0])).toBe(true);
    expect(HumanMessage.isInstance(request.messages[1])).toBe(true);
    expect(request.messages[0]!.content).not.toContain("Access denied");
    expect(() => { JSON.parse(request.messages[1]!.content as string); }).not.toThrow();
    requests.push(JSON.stringify(request.messages));
    return work.promise;
  } });
  helper.observePrepared(state);
  expect(helper.takePrepared(state)).toBeUndefined();
  await turn();
  helper.observePrepared(state);
  helper.observePrepared({ ...state, preparedMessages: [...state.preparedMessages, new AIMessage("More notes")] });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("Access denied");
  expect(requests[0]).toContain('error');
  for (const privateText of ["PRIVATE_REASONING", "PRIVATE_SIDECAR", "PRIVATE_SYSTEM", "PRIVATE_HUMAN"]) expect(requests[0]).not.toContain(privateText);
  work.resolve(new AIMessage({ content: "Preserve uncertainty: read failed.", additional_kwargs: { reasoning_content: "PRIVATE_HELPER_REASONING" } }));
  await turn();
  // Completion alone is not injection: a later preparation must poll it.
  expect(helper.takePrepared(state)).toBeUndefined();
  helper.observePrepared(state);
  const draft = helper.takePrepared(state);
  expect(draft?.content).toContain("Preserve uncertainty");
  expect(JSON.stringify(draft)).not.toContain("PRIVATE_HELPER_REASONING");
  expect(helper.takePrepared(state)).toBeUndefined();
  helper.observePrepared(state);
  await turn();
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(state)).toBe(original);
  helper.dispose();
});

test("helper purpose controls honor canonical capabilities and explicit server choices without changing catalog defaults", () => {
  const entries = localModelCatalog.entries;
  const original = JSON.stringify(entries);
  const glm = "openrouter:z-ai/glm-5.3";
  for (const id of [or, fw]) expect(resolveResearchNoteControls(id, entries, null)).toEqual({ canonicalModelId: id, reasoningEffort: "off" });
  expect(resolveResearchNoteControls(glm, entries, null)).toEqual({ canonicalModelId: glm, reasoningEffort: "low" });
  expect(resolveResearchNoteControls(glm, entries, { reasoningPolicy: { defaultEffort: "high", overrides: {} } })?.reasoningEffort).toBe("low");
  expect(resolveResearchNoteControls(or, entries, { reasoningPolicy: { defaultEffort: "low", overrides: { [or]: "max" } } })?.reasoningEffort).toBe("max");
  expect(resolveResearchNoteControls(or, entries, { reasoningOutput: { [or]: false }, reasoningPolicy: { defaultEffort: "high", overrides: { [or]: "max" } } })?.reasoningEffort).toBe("off");
  expect(() => resolveResearchNoteControls(glm, entries, { reasoningOutput: { [glm]: false } })).toThrow("unsupported-reasoning-effort");
  expect(() => resolveResearchNoteControls(fw, entries, { reasoningPolicy: { defaultEffort: null, overrides: { [fw]: "low" } } })).toThrow("unsupported-reasoning-effort");
  expect(resolveResearchNoteControls(or, [{ id: or }], null)).toBeUndefined();
  expect(() => resolveResearchNoteControls(or, [{ id: or }], { reasoningOutput: { [or]: false } })).toThrow("reasoning-not-supported");
  expect(JSON.stringify(entries)).toBe(original);
});

test("helper disposition logs distinguish cancellation, stale and empty results, and each failed fallback without content", async () => {
  setLogOutput("stderr");
  const output = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const outcome of ["aborted", "stale", "empty", "nonassistant", "failed-fallback"] as const) {
      output.mockClear();
      const state = { ...fixture(), model: "openrouter:z-ai/glm-5.3" };
      const parent = new AbortController();
      const work = deferred();
      const helper = createResearchNoteDraft(parent.signal, { eligibleIds: () => [or, state.model], invoke: async () => {
        if (outcome === "failed-fallback") throw new Error("SECRET_PROVIDER_ERROR");
        return work.promise;
      } });
      try {
        runWithTurn("diagnostic-turn", () => helper.observePrepared(state));
        await turn();
        if (outcome === "aborted") parent.abort(new Error("SECRET_ABORT_REASON"));
        if (outcome === "stale") helper.observePrepared({ ...state, currentTaskRunId: "another-run" });
        if (outcome === "aborted") work.reject(new Error("SECRET_PROVIDER_ERROR"));
        else work.resolve(outcome === "empty" ? new AIMessage(" \n ") : outcome === "nonassistant" ? new HumanMessage("SECRET_RESULT") : new AIMessage("SECRET_RESULT"));
        await turn();
        const lines = output.mock.calls.map((args) => args.join(" ")).filter((line) => line.includes("[research-note-draft]"));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line).toContain("[turn=diagnostic-turn]");
          expect(line).toContain("task=task task_run=run");
          expect(line).not.toMatch(/SECRET|PRIVATE|Access denied|\/source|pairing|desktop/);
        }
        if (outcome === "failed-fallback") {
          expect(lines).toHaveLength(2);
          expect(lines[0]).toContain(`event=attempt_failed task=task task_run=run model=${or} elapsed_ms=`);
          expect(lines[1]).toContain(`event=attempt_failed task=task task_run=run model=${state.model} elapsed_ms=`);
        } else if (outcome === "aborted") {
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain("event=attempt_aborted");
        } else {
          expect(lines[0]).toContain("event=attempt_succeeded");
          expect(lines[1]).toContain(`event=discarded task=task task_run=run model=${or} reason=${outcome}`);
        }
        expect(helper.takePrepared(state)).toBeUndefined();
      } finally { helper.dispose(); }
    }
  } finally { output.mockRestore(); }
});

test("append-only source continuation accepts advice while changed source, authority, role or run refuses it", async () => {
  for (const change of ["append", "source", "owner", "run", "binding", "role", "pairing", "grant", "folder", "workspace", "relay", "model"] as const) {
    const state = fixture();
    const helper = createResearchNoteDraft(undefined, { eligibleIds: () => [fw], invoke: async () => new AIMessage("AS_OF_DRAFT") });
    helper.observePrepared(state);
    await turn();
    const later = { ...state, messages: [...state.messages, new AIMessage("Later work")] };
    if (change === "source") later.messages[0] = new AIMessage("Changed original source");
    if (change === "owner") later.userId = "another-owner";
    if (change === "run") later.currentTaskRunId = "another-run";
    if (change === "binding") later.taskReportBackContinuation = { status: "capability_revoked" };
    if (change === "pairing") later.taskReportBackContinuation = { ...state.taskReportBackContinuation!, pairingGeneration: "different-pairing" };
    if (change === "grant") later.taskReportBackContinuation = { ...state.taskReportBackContinuation!, bindingCapturedAt: 123456 };
    if (change === "folder") later.currentFolder = "/different-folder";
    if (change === "workspace") later.workspacePath = "/different-workspace";
    if (change === "relay") later.currentFolderRelayId = "different-relay";
    if (change === "model") later.model = "openrouter:z-ai/glm-5.3";
    if (change === "role") {
      const args = { version: "security-scan-v1", operation: "handoff", role: "investigator", handoffRecordId: "checkpoint_unit" };
      later.messages.push(new AIMessage({ content: "", tool_calls: [{ id: "handoff", name: "security_scan", args }] }),
        new ToolMessage({ name: "security_scan", tool_call_id: "handoff", status: "success", content: JSON.stringify({ ok: true, operation: "handoff",
          work: { taskId: state.currentTaskId, taskRunId: state.currentTaskRunId, role: "investigator", handoffRecordId: "checkpoint_unit", unitRecordId: "unit_identity", seedRecordIds: [] } }) }));
    }
    helper.observePrepared(later);
    expect(Boolean(helper.takePrepared(later))).toBe(change === "append");
    helper.dispose();
  }
});

test("without an eligible Flash route the helper uses only the exact eligible scan model/provider", async () => {
  for (const model of ["fireworks:accounts/fireworks/models/glm-5p3", "openrouter:z-ai/glm-5.3"]) {
    const state = { ...fixture(), model };
    const models: string[] = [];
    const helper = createResearchNoteDraft(undefined, { eligibleIds: () => [model], invoke: async (request) => {
      models.push(request.modelId); return new AIMessage("Same-model optional advice");
    } });
    helper.observePrepared(state);
    await turn();
    helper.observePrepared(state);
    expect(models).toEqual([model]);
    expect(helper.takePrepared(state)?.content).toContain("Same-model optional advice");
    expect(state.model).toBe(model);
    helper.dispose();
  }
});

test("failed Flash falls back sequentially to the exact scan route and later snapshots avoid the failed preference", async () => {
  const state = { ...fixture(), model: "openrouter:z-ai/glm-5.3" };
  const requests: Array<{ model: string; input: string }> = [];
  const fallback = deferred();
  let active = 0;
  let peak = 0;
  const helper = createResearchNoteDraft(undefined, { eligibleIds: () => [or, fw, state.model], invoke: async (request) => {
    expect(request.controls?.reasoningEffort).toBe(request.modelId === or ? "off" : "low");
    active++; peak = Math.max(peak, active);
    requests.push({ model: request.modelId, input: JSON.stringify(request.messages) });
    try {
      if (request.modelId === or) throw new Error("Provider timeout");
      return await fallback.promise;
    } finally { active--; }
  } });
  helper.observePrepared(state);
  await turn();
  expect(requests.map((request) => request.model)).toEqual([or, state.model]);
  expect(requests[0]!.input).toBe(requests[1]!.input);
  const added = new AIMessage("New visible source observation");
  const later = { ...state, messages: [...state.messages, added], preparedMessages: [...state.preparedMessages, added] };
  helper.observePrepared(later);
  expect(requests).toHaveLength(2);
  fallback.resolve(new AIMessage("Usable exact scan-model draft"));
  await turn();
  helper.observePrepared(later);
  expect(helper.takePrepared(later)?.content).toContain("Usable exact scan-model draft");
  helper.observePrepared(later);
  await turn();
  expect(requests.map((request) => request.model)).toEqual([or, state.model, state.model]);
  expect(peak).toBe(1);
  helper.dispose();
});

test("failed Flash cannot start fallback after abort, disposal, stale source/run binding, or lost scan eligibility", async () => {
  for (const invalidation of ["abort", "dispose", "run", "source", "folder", "pairing", "credentials"] as const) {
    const state = { ...fixture(), model: "openrouter:z-ai/glm-5.3" };
    const parent = new AbortController();
    const flash = deferred();
    let eligible = [or, state.model];
    const requests: string[] = [];
    const helper = createResearchNoteDraft(parent.signal, { eligibleIds: () => eligible, invoke: (request) => {
      requests.push(request.modelId); return flash.promise;
    } });
    helper.observePrepared(state);
    await turn();
    if (invalidation === "abort") parent.abort();
    else if (invalidation === "dispose") helper.dispose();
    else if (invalidation === "credentials") eligible = [or];
    else {
      const later = { ...state, messages: [...state.messages] };
      if (invalidation === "run") later.currentTaskRunId = "another-run";
      if (invalidation === "source") later.messages[0] = new AIMessage("Changed earlier source bytes");
      if (invalidation === "folder") later.currentFolder = "/new-root";
      if (invalidation === "pairing") later.taskReportBackContinuation = { ...state.taskReportBackContinuation!, pairingGeneration: "new-pairing" };
      helper.observePrepared(later);
    }
    flash.reject(new Error("Provider failed"));
    await turn();
    expect(requests).toEqual([or]);
    expect(helper.takePrepared(state)).toBeUndefined();
    helper.dispose();
  }
});

test("a failed exact scan fallback is nonfatal and a Flash scan model is never retried against itself", async () => {
  for (const sameModel of [false, true]) {
    const state = { ...fixture(), model: sameModel ? or : "openrouter:z-ai/glm-5.3" };
    const original = JSON.stringify(state);
    const requests: string[] = [];
    const helper = createResearchNoteDraft(undefined, { eligibleIds: () => [or, state.model], invoke: async (request) => {
      requests.push(request.modelId); throw new Error("Model unavailable");
    } });
    helper.observePrepared(state);
    await turn();
    helper.observePrepared(state);
    expect(helper.takePrepared(state)).toBeUndefined();
    expect(requests).toEqual(sameModel ? [or] : [or, state.model]);
    expect(JSON.stringify(state)).toBe(original);
    helper.dispose();
  }
});

test("unavailable exact Flash models, rejected calls, and ordinary Tasks do not change the auditor", async () => {
  for (const mode of ["none", "wrong-model", "failure", "not-task", "not-security"] as const) {
    const state = fixture();
    if (mode === "not-task") state.taskRun = false;
    if (mode === "not-security") state.toolWhitelist = ["file"];
    let calls = 0;
    const helper = createResearchNoteDraft(undefined, { eligibleIds: () => mode === "none" ? [] : mode === "wrong-model" ? ["openrouter:z-ai/glm-5.3"] : [or],
      invoke: async () => { calls++; throw new Error("Credential/provider unavailable"); } });
    const original = JSON.stringify(state);
    helper.observePrepared(state);
    await turn();
    helper.observePrepared(state);
    expect(helper.takePrepared(state)).toBeUndefined();
    expect(calls).toBe(mode === "failure" ? 1 : 0);
    expect(JSON.stringify(state)).toBe(original);
    helper.dispose();
  }
});

test("parent abort and disposal abort pending work and fence noncooperative late completions", async () => {
  for (const parentAbort of [true, false]) {
    const parent = new AbortController();
    const work = deferred();
    let signal: AbortSignal | undefined;
    const helper = createResearchNoteDraft(parent.signal, { eligibleIds: () => [fw], invoke: (request) => { signal = request.signal; return work.promise; } });
    const state = fixture();
    helper.observePrepared(state);
    await turn();
    if (parentAbort) parent.abort(); else helper.dispose();
    expect(signal?.aborted).toBe(true);
    work.resolve(new AIMessage("LATE_DRAFT"));
    await turn();
    helper.observePrepared(state);
    expect(helper.takePrepared(state)).toBeUndefined();
    helper.dispose();
  }
});

test("production node wrappers run the auditor concurrently and never checkpoint raw helper advice", async () => {
  const work = deferred();
  const helper = createResearchNoteDraft(undefined, { eligibleIds: () => [fw], invoke: () => work.promise });
  const advisories: string[] = [];
  let turns = 0;
  const nodes = researchNoteDraftNodes({ helper,
    prepare: async (state) => ({ preparedMessages: [new SystemMessage("SYSTEM_ONLY"), ...state.messages] }),
    agent: async (state, _config, draft) => {
      turns++;
      if (draft) advisories.push(typeof draft.content === "string" ? draft.content : JSON.stringify(draft.content));
      return { messages: [...state.messages, new AIMessage(`Auditor turn ${turns}`)] };
    },
  });
  const graph = new StateGraph(NautiloStateAnnotation).addNode("pre_model", nodes.prepare).addNode("agent", nodes.agent)
    .addEdge(START, "pre_model").addEdge("pre_model", "agent").addEdge("agent", END).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: "optional-draft-graph" } };
  await graph.invoke(fixture(), config);
  expect(turns).toBe(1);
  expect(advisories).toHaveLength(0);
  work.resolve(new AIMessage("RAW_OPTIONAL_ADVICE"));
  await turn();
  await graph.invoke({}, config);
  expect(turns).toBe(2);
  expect(advisories).toHaveLength(1);
  for await (const checkpoint of graph.getStateHistory(config)) expect(JSON.stringify(checkpoint.values)).not.toContain("RAW_OPTIONAL_ADVICE");
  const current = await graph.getState(config);
  expect(JSON.stringify((current.values as NautiloState).messages)).toContain("Auditor turn 2");
  helper.dispose();
});
