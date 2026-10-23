import { describe, expect, test } from "bun:test";
import { getCapabilityFundingSession, type CapabilityFundingSession } from "@nautilo/agent";
import type { DirectDatabase } from "@nautilo/db";
import type { ProtectedTaskRunningOccurrence, ProtectedTaskPredispatchPlan, ProtectedTaskJobReferenceV1, streamDeepResearchReport } from "@nautilo/runtime";
import { createProtectedTaskDeepResearchProvider } from "../../src/routes/protected-task-deep-research-execution";
import { parseProtectedTaskDeepResearchSelection } from "../../src/routes/protected-task-deep-research-selection";

const TASK = "50000000-0000-4000-8000-000000000005";
const RUN = "60000000-0000-4000-8000-000000000006";
const JOB = "job-research";
const reference: ProtectedTaskJobReferenceV1 = {
  kind: "protected_task_run_v1", taskId: TASK, taskRunId: RUN,
  inputObjectId: `task-definition:v1:${"a".repeat(64)}`, resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
  authorizationRequestId: `task-run-authorization:${RUN}`, policyRevision: 7, executionSegment: 1,
};
const occurrence: ProtectedTaskRunningOccurrence = {
  task: { id: TASK, ownerId: "owner", requestorId: "requester", agentId: "agent", callingRoomId: "source-room",
    scheduleKind: "now", contentRepresentation: "protected", contentNamespaceId: "private-namespace",
    contentRevision: 1, cryptoObjectId: reference.inputObjectId, cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32) },
  run: { id: RUN, taskId: TASK, jobId: JOB, graphThreadId: "graph", status: "running", startedAt: new Date(0) },
};
const predispatch: ProtectedTaskPredispatchPlan = {
  occurrence: { task: occurrence.task, run: { ...occurrence.run, status: "awaiting", jobId: null } },
  scheduling: { ownerId: "owner", requestorId: "requester", agentId: "agent", roomId: "execution-room",
    callingRoomId: "source-room", graphThreadId: "graph" },
  target: { roomId: "execution-room", targetUserIds: ["requester"] },
  memory: { mode: "namespace", authorityStatus: "exact", provenance: "target_users_namespace",
    envelope: { memoryMode: "namespace", ownerId: "owner", actorId: "human", agentId: "agent", roomId: "execution-room",
      readableNamespaces: ["memory"], mutableNamespaces: ["memory"], writableNamespaces: ["memory"], toolPolicy: {} } },
};
const modelPlan = { version: 1, supervisorModel: "model-supervisor", researchModel: "model-research",
  summarizationModel: "model-summary", compressionModel: "model-compression", finalReportModel: "model-report" };
const binding = { kind: "server" as const, providerRoute: "openrouter" };
const funding = {
  preferenceRevisions: { supervisor: 1, research: 2, summarization: 3, compression: 4, finalReport: 5 },
  modelFunding: { supervisor: binding, research: binding, summarization: binding, compression: binding, finalReport: binding },
  tavilyFunding: { kind: "server" as const, providerRoute: "tavily" },
};
const capability: CapabilityFundingSession = {
  humanUserId: "requester", resolveModel: async () => { throw new Error("unexpected funding selection"); },
  openModel: async () => { throw new Error("unexpected model"); }, openService: async () => { throw new Error("unexpected service"); },
};
function fixture(version: 1 | 2 = 2) {
  const selection = parseProtectedTaskDeepResearchSelection({ deepResearch: {
    version, modelPlan, invokingModelId: null, ...(version === 2 ? funding : {}),
  } });
  if (selection === null) throw new Error("selection fixture rejected");
  const control = { current: true, failContext: false, stall: false, failStream: false, revokeOnNext: false };
  const counts = { context: 0, constructed: 0, next: 0, returned: 0 };
  const fundingScopes: Array<CapabilityFundingSession | undefined> = [];
  let actualStreamArgs: Parameters<typeof streamDeepResearchReport> | undefined;
  let resolveStalled: ((value: IteratorResult<{ phase: string }, string>) => void) | undefined;
  const abort = new AbortController();
  const payload = { formatVersion: 1 as const, prompt: "PRIVATE RESEARCH BRIEF", expectedOutput: null,
    protectedMetadata: { deepResearch: { reportLanguage: "Portuguese" } } };
  const assertCurrent = async () => { if (!control.current) throw new Error("current authority lost"); };
  // Inert DB handle: the injected context is the only product boundary in this provider test.
  const db = new Proxy({} as DirectDatabase, { get() { throw new Error("unexpected DB access"); } });
  const provider = createProtectedTaskDeepResearchProvider({ db,
    executionContext: async input => {
      counts.context += 1;
      expect(input.occurrence).toBe(occurrence);
      expect(input.predispatch).toBe(predispatch);
      expect(input.signal).toBe(abort.signal);
      expect(input.assertCurrentTaskAuthority).toBe(assertCurrent);
      expect(input.protectedMetadata).toEqual({ deepResearch: { ...selection.deepResearch, reportLanguage: "Portuguese" } });
      await input.assertCurrentTaskAuthority();
      if (control.failContext) throw new Error("funding unavailable");
      return { assistantName: "Researcher", soulFile: "", modelId: "model", currentFolder: "", workspacePath: "",
        subagentDepth: 1, subagentMaxDepth: 2, roomRoster: [], modelFallbackMode: "none",
        foregroundChatFundingSession: { kind: "server", capabilityFunding: capability,
          runAttempt: async () => { throw new Error("unexpected direct model"); }, recheckAttempt: async () => {} } };
    },
    stream: (...args) => {
      counts.constructed += 1;
      actualStreamArgs = args;
      fundingScopes.push(getCapabilityFundingSession());
      const report = {
        async next(): Promise<IteratorResult<{ phase: string }, string>> {
          counts.next += 1;
          fundingScopes.push(getCapabilityFundingSession());
          if (control.stall) return new Promise(resolve => { resolveStalled = resolve; });
          if (control.failStream) throw new Error("stream lost");
          if (control.revokeOnNext) control.current = false;
          return counts.next === 1 ? { done: false, value: { phase: "PRIVATE PROVIDER PROGRESS" } }
            : { done: true, value: "PRIVATE FINAL REPORT" };
        },
        async return(): Promise<IteratorResult<{ phase: string }, string>> {
          counts.returned += 1;
          fundingScopes.push(getCapabilityFundingSession());
          return { done: true, value: "" };
        },
        async throw(error: unknown): Promise<IteratorResult<{ phase: string }, string>> { throw error; },
        [Symbol.asyncIterator]() { return report; },
        async [Symbol.asyncDispose]() { await report.return(); },
      };
      return report;
    },
  });
  const args = { occurrence, predispatch, reference, jobId: JOB, signal: abort.signal, assertCurrent, admission: selection, payload };
  return { provider, args, selection, counts, control, abort, fundingScopes,
    streamArgs: () => actualStreamArgs, resolveStalled: () => resolveStalled?.({ done: true, value: "LATE REPORT" }) };
}
async function collect(outputs: AsyncIterable<unknown>) { const values: unknown[] = []; for await (const value of outputs) values.push(value); return values; }
async function failure(work: () => unknown) { try { await work(); } catch (error) { expect(error).toBeInstanceOf(Error); return error; } throw new Error("Expected refusal"); }

describe("protected Deep Research provider", () => {
  test.each([1 as const, 2 as const])("reconstructs v%s only in current execution and emits one candidate plus terminal", async version => {
    const f = fixture(version);
    const admission = await f.provider.admit("owner", f.selection);
    expect(admission).toEqual(f.selection);
    expect(f.provider.sameAdmission(f.selection, f.selection)).toBe(true);
    expect(JSON.stringify(admission)).not.toContain("Portuguese");
    const session = await f.provider.start(f.args);
    expect(f.counts.constructed).toBe(0);
    const outputs = await collect(session.outputs);
    expect(outputs).toEqual([
      { kind: "assistant_completed", attribution: session.attribution, text: "PRIVATE FINAL REPORT" },
      { kind: "terminal", attribution: session.attribution, status: "completed" },
    ]);
    expect(session.attribution).toMatchObject({ taskId: TASK, roomId: "source-room", bindingId: RUN, bindingGeneration: JOB });
    expect(f.streamArgs()).toEqual([
      { research_brief: f.args.payload.prompt, report_language: "Portuguese", deep_research_model_plan: modelPlan,
        ...(version === 2 ? { deep_research_funding: { ...f.selection.deepResearch, reportLanguage: "Portuguese" } } : {}) },
      RUN, f.abort.signal, "requester", { roomId: "execution-room", taskId: TASK, taskRunId: RUN, agentId: "agent" },
      { confidential: true },
    ]);
    expect(f.fundingScopes).toHaveLength(3);
    expect(f.fundingScopes.every(scope => scope === capability)).toBe(true);
    expect(f.counts).toEqual({ context: 1, constructed: 1, next: 2, returned: 0 });
    expect(session.hasLiveRequest("arbitrary", "owner")).toBe(false);
  });

  test("rejects reused output custody without starting a second research stream", async () => {
    const f = fixture(); const session = await f.provider.start(f.args);
    await collect(session.outputs);
    await failure(() => collect(session.outputs));
    expect(f.counts.constructed).toBe(1);
  });

  test("authority loss between preparation and iteration discloses no prompt to stream", async () => {
    const f = fixture(); const session = await f.provider.start(f.args);
    f.control.current = false;
    await failure(() => collect(session.outputs));
    expect(f.counts.constructed).toBe(0);
  });

  test.each(["before_start", "context", "after_next", "stream"])("refuses %s failure without result or replay", async point => {
    const f = fixture();
    if (point === "before_start") f.control.current = false;
    if (point === "context") f.control.failContext = true;
    if (point === "after_next") f.control.revokeOnNext = true;
    if (point === "stream") f.control.failStream = true;
    const seen: unknown[] = [];
    await failure(async () => { const session = await f.provider.start(f.args); for await (const value of session.outputs) seen.push(value); });
    expect(seen).toEqual([]);
    expect(f.counts.constructed).toBe(point === "after_next" || point === "stream" ? 1 : 0);
    expect(f.counts.returned).toBe(f.counts.constructed);
    expect(f.fundingScopes.every(scope => scope === capability)).toBe(true);
  });

  test("aborts a stalled stream promptly, returns custody once and ignores late completion", async () => {
    const f = fixture(); f.control.stall = true;
    const session = await f.provider.start(f.args);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const pending = iterator.next().catch((error: unknown) => error);
    while (f.counts.next === 0) await Promise.resolve();
    const reason = new Error("grant expired"); f.abort.abort(reason);
    expect(await pending).toBe(reason);
    expect(f.counts.returned).toBe(1);
    f.resolveStalled(); await Promise.resolve();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(f.counts.constructed).toBe(1);
    expect(f.fundingScopes.every(scope => scope === capability)).toBe(true);
  });

  test("already-cancelled custody never opens context or stream", async () => {
    const f = fixture(); f.abort.abort(new Error("cancelled"));
    await failure(() => f.provider.start(f.args));
    expect(f.counts.context).toBe(0); expect(f.counts.constructed).toBe(0);
  });

  test("authority loss after candidate suppresses terminal completion", async () => {
    const f = fixture(); const session = await f.provider.start(f.args);
    const iterator = session.outputs[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ done: false, value: { kind: "assistant_completed" } });
    f.control.current = false;
    await failure(() => iterator.next());
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(f.counts.constructed).toBe(1);
  });

  test("admission rejects widened metadata and detects a changed model plan", async () => {
    const f = fixture();
    const widened = { ...f.selection, prompt: "PRIVATE" };
    expect(await f.provider.admit("owner", widened)).toBeNull();
    const changed = parseProtectedTaskDeepResearchSelection({ deepResearch: { ...f.selection.deepResearch,
      modelPlan: { ...modelPlan, researchModel: "different-model" } } });
    if (changed === null) throw new Error("changed closed selection rejected");
    expect(f.provider.sameAdmission(f.selection, changed)).toBe(false);
    expect(f.counts.context).toBe(0); expect(f.counts.constructed).toBe(0);
  });

  test("denies substituted or unsupported protected metadata before context or stream", async () => {
    const invalidMetadata: Array<Parameters<ReturnType<typeof createProtectedTaskDeepResearchProvider>["start"]>[0]["payload"]["protectedMetadata"]> = [{}, { deepResearch: { reportLanguage: "Portuguese", modelFunding: funding.modelFunding } },
      { deepResearch: { reportLanguage: "Portuguese" }, execution: { workingDirectory: "/private" } }];
    for (const protectedMetadata of invalidMetadata) {
      const f = fixture();
      await failure(() => f.provider.start({ ...f.args, payload: { ...f.args.payload, protectedMetadata } }));
      expect(f.counts.context).toBe(0); expect(f.counts.constructed).toBe(0);
    }
    const f = fixture();
    await failure(() => f.provider.start({ occurrence, reference, jobId: JOB, signal: f.abort.signal,
      assertCurrent: f.args.assertCurrent, admission: f.selection, payload: f.args.payload }));
    expect(f.counts.context).toBe(0);
  });
});
