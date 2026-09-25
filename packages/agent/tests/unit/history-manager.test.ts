import { describe, expect, test } from "bun:test";
import { SECURITY_SCAN_INITIAL_LANES, type SecurityScanLedgerRecord } from "@nautilo/types";
import { securityResearchAppendix } from "../../src/tools/security/research-appendix";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  processHistory,
  estimateTokenCount,
  type HistoryConfig,
} from "../../src/utils/history-manager";

const defaultConfig: HistoryConfig = {
  validationEnabled: true,
  pruningEnabled: false,
  maxMessageTokens: 200_000,
};

describe("history-manager", () => {
  test("empty messages returns empty", () => {
    const result = processHistory([], defaultConfig);
    expect(result.messages).toEqual([]);
    expect(result.validation.repairs).toEqual([]);
  });

  test("passes through clean conversation", () => {
    const messages = [
      new HumanMessage("hello"),
      new AIMessage("hi there"),
    ];
    const result = processHistory(messages, defaultConfig);
    expect(result.messages.length).toBe(2);
    expect(result.validation.repairs).toEqual([]);
  });

  test("repairs orphaned tool call at end of conversation", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc_1", name: "search_memory", args: { query: "test" } }],
    });
    const messages = [new HumanMessage("hello"), ai];
    const result = processHistory(messages, defaultConfig);
    expect(result.validation.repairs.length).toBeGreaterThan(0);
  });

  test("keeps complete tool call + result pairs", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc_1", name: "search_memory", args: { query: "test" } }],
    });
    const toolResult = new ToolMessage({
      content: "No memories found.",
      tool_call_id: "tc_1",
      name: "search_memory",
    });
    const messages = [new HumanMessage("hello"), ai, toolResult];
    const result = processHistory(messages, defaultConfig);
    expect(result.messages.length).toBe(3);
    expect(result.validation.repairs).toEqual([]);
  });

  test("removes orphaned ToolMessage", () => {
    const orphan = new ToolMessage({
      content: "result",
      tool_call_id: "nonexistent",
      name: "some_tool",
    });
    const messages = [new HumanMessage("hello"), orphan];
    const result = processHistory(messages, defaultConfig);
    expect(result.messages.length).toBe(1);
    expect(result.validation.repairs.length).toBe(1);
  });

  test("estimateTokenCount returns reasonable estimate", () => {
    const messages = [new HumanMessage("hello world")];
    const tokens = estimateTokenCount(messages);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });
});

describe("history-manager preserves complete ordinary messages", () => {
  const cfg: HistoryConfig = {
    validationEnabled: true,
    pruningEnabled: false,
    maxMessageTokens: 262_144,
  };
  const HUGE = "x".repeat(500_000);

  test("preserves oversized tool results including their middle, pairing and IDs", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc_big", name: "run_shell", args: { command: "seq 1 500000" } }],
    });
    const toolResult = new ToolMessage({ content: HUGE, tool_call_id: "tc_big", name: "run_shell" });
    const result = processHistory([new HumanMessage("go"), ai, toolResult], cfg);

    expect(result.clamping.clampedCount).toBe(0);
    expect(result.messages.length).toBe(3); // never dropped
    expect(result.validation.repairs).toEqual([]); // pairing intact

    const clampedTool = result.messages.find((m) => m instanceof ToolMessage) as ToolMessage;
    expect(clampedTool).toBeDefined();
    expect(clampedTool.tool_call_id).toBe("tc_big"); // id untouched
    const content = clampedTool.content as string;
    expect(content).toBe(HUGE);

    // AIMessage tool_calls untouched.
    const clampedAi = result.messages.find((m) => m instanceof AIMessage) as AIMessage;
    expect(clampedAi.tool_calls?.[0]?.id).toBe("tc_big");
  });

  test("does not discard older turns even when the supplied workspace is exhausted", () => {
    const messages = Array.from({ length: 40 }, (_, index) => [
      new HumanMessage(`Question ${index}: ${HUGE}`), new AIMessage(`Answer ${index}`),
    ]).flat();
    const result = processHistory(messages, { ...cfg, maxMessageTokens: 100 });
    expect(result.messages).toEqual(messages);
    expect(result.windowing.removedCount).toBe(0);
    expect(result.clamping.clampedCount).toBe(0);
  });

  test("no-op for normal-sized messages", () => {
    const result = processHistory([new HumanMessage("hello"), new AIMessage("hi")], cfg);
    expect(result.clamping.clampedCount).toBe(0);
    expect((result.messages[1] as AIMessage).content).toBe("hi");
  });

  test("preserves full raw Task results", () => {
    const taskResult = new AIMessage({ content: HUGE, id: "task-result:run-1" });
    const result = processHistory([new HumanMessage("go"), taskResult], cfg);

    expect(result.clamping.clampedCount).toBe(0);
    const projected = result.messages[1] as AIMessage;
    expect(projected.id).toBe("task-result:run-1");
    expect(projected.content).toBe(HUGE);
  });

  test("does not touch a SystemMessage even if oversized", () => {
    const result = processHistory([new SystemMessage(HUGE), new HumanMessage("hi")], cfg);
    expect(result.clamping.clampedCount).toBe(0);
  });

  test("does not re-clamp a model-budgeted transient Room context block", () => {
    const transient = new HumanMessage({
      content: HUGE,
      additional_kwargs: {
        nautilo_transient_context: true,
        nautilo_room_context_budgeted: true,
      },
    });
    const result = processHistory([transient], cfg);
    expect(result.clamping.clampedCount).toBe(0);
    expect(result.messages[0]!.content).toBe(HUGE);
  });

  test("preserves a generic transient block without a Room budget", () => {
    const transient = new HumanMessage({
      content: HUGE,
      additional_kwargs: { nautilo_transient_context: true },
    });
    const result = processHistory([transient], cfg);
    expect(result.clamping.clampedCount).toBe(0);
    expect(result.messages[0]!.content).toBe(HUGE);
  });

  test("skips multimodal (array) content — no corruption of content blocks", () => {
    const multimodal = new HumanMessage({
      content: [{ type: "text", text: HUGE }] as unknown as string,
    });
    const result = processHistory([multimodal], cfg);
    expect(result.clamping.clampedCount).toBe(0);
    expect(Array.isArray((result.messages[0] as HumanMessage).content)).toBe(true);
  });
});


describe("research Task checkpoint continuity", () => {
  const author = { taskId: "10000000-0000-4000-8000-000000000001",
    taskRunId: "10000000-0000-4000-8000-000000000002", modelId: null };
  const config: HistoryConfig = { ...defaultConfig, maxMessageTokens: 2_000, researchContinuity: true };
  function cycle(id: string, operation: string, output: unknown) {
    return [new AIMessage({ content: "", tool_calls: [{ id, name: "security_scan",
      args: { version: "security-scan-v1", operation, ...(operation === "record"
        ? { action: "append", entry: { kind: "checkpoint" } } : {}) } }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: id, content: JSON.stringify(output) })];
  }
  function checkpoint(openRecordIds = ["export-review"]) {
    return cycle("checkpoint-call", "record", { ok: true, operation: "record", result: {
      record: { id: "checkpoint-one", revision: 1, createdAt: "2026-09-07T12:00:00Z",
        updatedAt: "2026-09-07T12:00:00Z", createdBy: author, updatedBy: author,
        entry: { kind: "checkpoint", summary: "Auth flow inspected, notes saved in ledger.",
          nextWork: "Trace export ownership before any conclusion.", openRecordIds, evidenceRefs: [] } },
      codeEvidence: [],
    } });
  }
  function sourceCycle(id: string) {
    return [new AIMessage({ content: "", tool_calls: [{ id, name: "file", args: { command: "read", path: "auth.ts" } }] }),
      new ToolMessage({ name: "file", tool_call_id: id, content: JSON.stringify({ content: "source".repeat(6000), nextCursor: null }) })];
  }
  test("one long autonomous turn shrinks only at an accepted checkpoint without losing brief, notes or tool pairs", () => {
    const brief = new HumanMessage("Audit ownership, source-to-sink flows, and safe counterexamples.");
    const old = sourceCycle("old-read");
    const checkpointCycle = checkpoint();
    const recent = sourceCycle("recent-read");
    const messages = [brief, ...old, ...checkpointCycle, ...recent];
    const result = processHistory(messages, config);
    expect(result.windowing).toEqual({ removedCount: 2, researchReloadRequired: true });
    expect(result.messages).toEqual([brief, ...checkpointCycle, ...recent]);
    expect(result.validation.repairs).toEqual([]);
    expect(result.clamping.clampedCount).toBe(0);
    const retainedSource = JSON.parse((result.messages.at(-1) as ToolMessage).content as string) as Record<string, unknown>;
    expect(retainedSource["content"]).toHaveLength(36000);
    expect(messages).toHaveLength(7); // canonical source list is never mutated
    expect(messages[2]).toBe(old[1]);
  });
  test("hundreds of autonomous cycles fit again after durable checkpoint without trimming saved notes", () => {
    const previous = Array.from({ length: 120 }, (_, index) => sourceCycle(`old-${index}`)).flat();
    const saved = checkpoint();
    const result = processHistory([new HumanMessage("Full audit scope"), ...previous, ...saved,
      new AIMessage("Next inspect importer." )], config);
    expect(result.windowing.removedCount).toBe(240);
    expect(estimateTokenCount(result.messages)).toBeLessThan(2000);
    expect(result.messages).toContain(saved[1]!);
    expect(result.validation.repairs).toEqual([]);
  });
  function reload(ids: string[], nextCursor: string | null = null, callId = "reload") {
    const loaded = cycle(callId, "results", { ok: true, operation: "results", result: {
      version: "security-scan-v1", status: { version: "security-scan-v1", scanId: "scan_test", state: "active",
        phase: "researching", terminalState: null, mode: "deep_research", modelId: "openai:test",
        modelState: "running", completedSteps: 1, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES,
        coverage: [], hypotheses: [] }, observations: [], codeEvidence: [],
      records: ids.map((id) => ({ id, revision: 1, createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z",
        createdBy: author, updatedBy: author, entry: { kind: "hypothesis", summary: "Trace authorization into the deferred export.",
          state: "investigating", evidenceRefs: [], counterevidenceRefs: [] } })), nextCursor,
    } });
    (loaded[0] as AIMessage).tool_calls![0]!.args["category"] = "research";
    (loaded[0] as AIMessage).tool_calls![0]!.args["recordIds"] = ids;
    return loaded;
  }
  test("an exactly reloaded checkpoint does not request the same reload every later model turn", () => {
    const loaded = reload(["export-review"]);
    const result = processHistory([new HumanMessage("Full scope"), ...sourceCycle("old"), ...sourceCycle("old-two"), ...checkpoint(),
      ...loaded, new AIMessage("Continue importer")], config);
    expect(result.windowing.removedCount).toBe(4);
    expect(result.windowing.researchReloadRequired).toBeUndefined();
    expect(result.messages).toContain(loaded[1]!);
    expect(result.validation.repairs).toEqual([]);
  });
  test("empty, unrelated and incomplete selected results cannot close pending checkpoint reload", () => {
    for (const ids of [[], ["other-review"], ["export-review"]]) {
      const result = processHistory([new HumanMessage("Full scope"), ...sourceCycle("old"), ...sourceCycle("old-two"),
        ...checkpoint(["export-review", "upload-review"]), ...reload(ids)], config);
      expect(result.windowing.researchReloadRequired).toBe(true);
      expect(result.validation.repairs).toEqual([]);
    }
  });
  test("all named pending records must be present across the exhausted reload pages", () => {
    const beginning = [new HumanMessage("Full scope"), ...sourceCycle("old"), ...sourceCycle("old-two"),
      ...checkpoint(["export-review", "upload-review"])];
    const first = reload(["export-review"], "next", "reload-first");
    expect(processHistory([...beginning, ...first], config).windowing.researchReloadRequired).toBe(true);
    const last = reload(["upload-review"], null, "reload-last");
    const complete = processHistory([...beginning, ...first, ...last], config);
    expect(complete.windowing.researchReloadRequired).toBeUndefined();
    expect(complete.messages).toContain(first[1]!);
    expect(complete.messages).toContain(last[1]!);
  });
  test("a newer checkpoint cannot inherit the old checkpoint's reload acknowledgements", () => {
    const newer = checkpoint(["upload-review"]);
    (newer[0] as AIMessage).tool_calls![0]!.id = "new-checkpoint";
    (newer[1] as ToolMessage).tool_call_id = "new-checkpoint";
    const result = processHistory([new HumanMessage("Full scope"), ...sourceCycle("old"), ...checkpoint(),
      ...reload(["export-review"]), ...newer, ...reload(["export-review"], null, "unrelated")], config);
    expect(result.windowing.researchReloadRequired).toBe(true);
  });
  test("final report pagination can exceed context without losing canonical export pages or final proof", () => {
    const saved = checkpoint();
    const pages = Array.from({ length: 12 }, (_, index) => {
      const output = { ok: true, operation: "results", result: {
        version: "security-scan-v1", status: { version: "security-scan-v1", scanId: "scan_test", state: "completed",
          phase: null, terminalState: "completed", mode: "deep_research", modelId: "openai:test",
          modelState: "completed", completedSteps: 2, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES,
          coverage: [], hypotheses: [] }, observations: [], codeEvidence: [],
        records: Array.from({ length: 3 }, (_, note) => ({
          id: `note-${index}-${note}`, revision: 1, createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z",
          createdBy: author, updatedBy: author, entry: { kind: "evidence", summary: "Detailed source analysis. ".repeat(60), evidenceRefs: [] },
        })), nextCursor: index < 11 ? `cursor-${index + 1}` : null, reportReady: index === 11,
      } };
      const pair = cycle(`final-page-${index}`, "results", output);
      const args = (pair[0] as AIMessage).tool_calls![0]!.args;
      args["category"] = "all";
      args["finalize"] = true;
      if (index > 0) args["continueResults"] = true;
      return pair;
    });
    const brief = new HumanMessage("Report all evidence and preserve the appendix.");
    const messages = [brief, ...sourceCycle("old"), ...saved, ...pages.flat()];
    const result = processHistory(messages, config);
    expect(result.messages).toEqual([brief, ...saved, ...pages.at(-1)!]);
    expect(estimateTokenCount(result.messages)).toBeLessThan(10000);
    expect(result.validation.repairs).toEqual([]);
    expect(result.windowing.researchReloadRequired).toBeUndefined();
    expect(messages).toHaveLength(29);
    expect(JSON.parse((messages.at(-1) as ToolMessage).content as string)).toMatchObject({ result: { reportReady: true } });
    // A mixed tool batch may carry unsaved source and cannot be shed as an
    // immutable final-page-only cycle.
    (pages[0]![0] as AIMessage).tool_calls!.push({ id: "mixed-source", name: "file",
      args: { command: "read", path: "late.ts" } });
    const mixedResult = new ToolMessage({ name: "file", tool_call_id: "mixed-source", content: "unrecorded source" });
    const mixed = processHistory([brief, ...saved, ...pages[0]!, mixedResult, ...pages.slice(1).flat()], config);
    expect(mixed.messages).toContain(pages[0]![0]!);
    expect(mixed.messages).toContain(pages[0]![1]!);
    expect(mixed.messages).toContain(mixedResult);
    expect(mixed.validation.repairs).toEqual([]);
  });
  function conclusionPage(id: string, records: SecurityScanLedgerRecord[], complete: boolean, inventoryCount = 0) {
    const output = { ok: true, operation: "results", result: {
      version: "security-scan-v1", status: { version: "security-scan-v1", scanId: "scan_test", state: "completed",
        phase: null, terminalState: "completed", mode: "deep_research", modelId: "openai:test", modelState: "completed",
        completedSteps: 2, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES,
        coverage: [{ surfaceKey: "auth", label: "Auth", state: "reviewed", rationale: "Traced source." }], hypotheses: [],
        researchProgress: { inventoryState: "complete", inventoryFingerprint: "d".repeat(64), filesTotal: 1,
          filesAssigned: 1, filesUnassigned: 0, unitsTotal: 1, unitsCompleted: 1, unitsPending: 0,
          excludedEntriesTotal: 0, coverageTotal: 1, hypothesesTotal: 1, coverageOmitted: 0, hypothesesOmitted: 0, latestCheckpoint: null } },
      observations: [], codeEvidence: [], records,
      inventory: Array.from({ length: inventoryCount }, (_, index) => ({ id: `inventory-${index}`,
        relativePath: `packages/storage/source-${index}.ts`, kind: "file", sizeBytes: 2100, sourceVersion: "f".repeat(64), reason: null })),
      nextCursor: complete ? null : "next", reportReady: complete,
    } };
    const pair = cycle(id, "results", output);
    Object.assign((pair[0] as AIMessage).tool_calls![0]!.args,
      { category: "all", finalize: true, ...(complete ? { continueResults: true } : {}) });
    return pair;
  }
  function conclusion(id: string, kind: "finding" | "dismissal", detailed = false): SecurityScanLedgerRecord & { entry: { summary: string } } {
    const summary = detailed ? "The worker trusts stale project authority. ".repeat(40) : "The worker uses submission authority after revocation.";
    return { id, revision: 1, createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z",
      createdBy: author, updatedBy: author,
      entry: kind === "finding" ? { kind, title: "Export uses stale authority", summary,
        confidence: "high", impact: detailed ? "A former member can retrieve project documents. ".repeat(35) : "A former member retrieves private documents.",
        exploitPreconditions: detailed ? "An export was queued before access was revoked. ".repeat(35) : "Queue an export before membership revocation.", evidenceRefs: [{ kind: "code_evidence", id: "code-auth" }], counterevidenceRefs: [] }
        : { kind, summary: "The preview path revalidates current membership; its source does not support the same defect.", evidenceRefs: [{ kind: "code_evidence", id: "code-auth" }], counterevidenceRefs: [] } };
  }
  test("older-page findings and dismissals survive inventory compaction and the full appendix stays intact", () => {
    const finding = conclusion("early-finding", "finding");
    const dismissal = conclusion("early-dismissal", "dismissal");
    const first = conclusionPage("early-page", [finding, dismissal], false, 90);
    const last = conclusionPage("tail-page", [], true);
    const messages = [new HumanMessage("Synthesize every accepted conclusion."), ...sourceCycle("old-source"), ...checkpoint(), ...first, ...last];
    const canonicalBytes = (first[1] as ToolMessage).content;
    const appendixBefore = securityResearchAppendix(messages);
    expect(appendixBefore).toContain(finding.entry.summary);
    const result = processHistory(messages, config);
    const projected = result.messages.find((message) => ToolMessage.isInstance(message) && message.tool_call_id === "early-page") as ToolMessage;
    expect(projected).not.toBe(first[1]);
    expect(JSON.parse(projected.content as string)).toMatchObject({ contextProjection: { canonicalRetained: true }, records: [finding, dismissal] });
    expect(projected.content).not.toContain("inventory-89");
    expect(result.messages).toContain(first[0]!);
    expect(result.messages).toContain(last[1]!);
    expect(result.validation.repairs).toEqual([]);
    expect(result.windowing.researchConclusionsProjected).toBe(true);
    expect(result.windowing.researchConclusionsOverview).toBeUndefined();
    expect((first[1] as ToolMessage).content).toBe(canonicalBytes);
    expect(securityResearchAppendix(messages)).toBe(appendixBefore);
    expect(appendixBefore).toContain("packages/storage/source-89.ts");
  });
  test("conclusions above the configured model budget become an explicit recoverable index, never sliced text", () => {
    const records = Array.from({ length: 24 }, (_, index) => conclusion(`finding-${index}`, "finding", true));
    const first = conclusionPage("conclusion-page", records, false);
    const messages = [new HumanMessage("Synthesize findings."), ...checkpoint(), ...first, ...conclusionPage("tail", [], true)];
    const result = processHistory(messages, config);
    const budget = config.maxMessageTokens;
    expect(estimateTokenCount(messages)).toBeGreaterThan(budget);
    expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(budget);
    expect(result.windowing.researchConclusionsOverview).toBe(true);
    const projected = result.messages.find((message) => ToolMessage.isInstance(message)
      && typeof message.content === "string" && message.content.includes('"fullConclusionsOutsideWindow":true')) as ToolMessage;
    expect(JSON.parse(projected.content as string)).toMatchObject({ contextProjection: { fullConclusionsOutsideWindow: true,
      canonicalRetained: true, totalConclusions: 24, omittedIndexEntries: 0 }, records: [],
      recordIndex: records.map((record) => ({ id: record.id, kind: "finding", title: "Export uses stale authority" })) });
    expect(projected.content).toContain("recordIds");
    expect(projected.content).not.toContain("chars elided");
    expect(result.validation.repairs).toEqual([]);
    const appendix = securityResearchAppendix(messages);
    expect(appendix?.includes(records[0]!.entry.summary.trim())).toBe(true);
    expect(appendix).toContain("finding-23");
  });
  test("one valid maximum-size latest final page fits through recoverable projection and a one-record reload", () => {
    const actualConfig = { ...config, maxMessageTokens: 20_000 };
    const records = Array.from({ length: 100 }, (_, index) => conclusion(`latest-finding-${index}`, "finding", true));
    const final = conclusionPage("latest-full-page", records, true);
    delete (final[0] as AIMessage).tool_calls![0]!.args["continueResults"];
    const messages = [new HumanMessage("Report the complete audit."), ...final];
    const canonical = JSON.stringify(messages);
    const appendix = securityResearchAppendix(messages);
    const budget = actualConfig.maxMessageTokens;
    expect(estimateTokenCount(messages)).toBeGreaterThan(budget);
    const result = processHistory(messages, actualConfig);
    expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(budget);
    const projected = result.messages.find((message) => ToolMessage.isInstance(message)) as ToolMessage;
    const receipt = JSON.parse(projected.content as string) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      contextProjection: { canonicalRetained: true, fullConclusionsOutsideWindow: true,
        recovery: { category: "research", finalize: false, limit: 1 } },
      finalPage: { status: { scanId: "scan_test", state: "completed", modelState: "completed" },
        nextCursor: null, reportReady: true, canonicalItemCounts: { records: 100 } },
      records: [],
    });
    expect(receipt["recordIndex"]).toHaveLength(100);
    expect(result.validation.repairs).toEqual([]);
    expect(JSON.stringify(messages)).toBe(canonical);
    expect(appendix).toContain("latest-finding-99");
    expect(securityResearchAppendix(messages)).toBe(appendix);

    const targeted = conclusionPage("reload-one", [records[99]!], true);
    Object.assign((targeted[0] as AIMessage).tool_calls![0]!.args,
      { category: "research", finalize: false, limit: 1, recordIds: [records[99]!.id] });
    delete (targeted[0] as AIMessage).tool_calls![0]!.args["continueResults"];
    const reloaded = processHistory([...messages, ...targeted], actualConfig);
    expect(reloaded.messages).toContain(targeted[1]!);
    expect(estimateTokenCount(reloaded.messages)).toBeLessThanOrEqual(budget);
    expect(reloaded.validation.repairs).toEqual([]);
  });
  test("projecting an oversized latest nonterminal final page retains its exact continuation authority", () => {
    const final = conclusionPage("awaiting-next-page", Array.from({ length: 100 }, (_, index) => conclusion(`next-finding-${index}`, "finding", true)), false);
    const result = processHistory([new HumanMessage("Retrieve final report inputs."), ...final], { ...config, maxMessageTokens: 20_000 });
    const projected = result.messages.find((message) => ToolMessage.isInstance(message)) as ToolMessage;
    expect(JSON.parse(projected.content as string)).toMatchObject({ finalPage: {
      status: { scanId: "scan_test", state: "completed" }, nextCursor: "next", reportReady: false,
    } });
    expect(projected.content).toContain("continueResults:true");
    expect(projected.content).toContain("Do not replay the oversized");
    expect(result.validation.repairs).toEqual([]);
  });
  test("does not erase research merely because the model claimed to save a checkpoint", () => {
    const source = sourceCycle("unsaved-read");
    const messages = [new HumanMessage("Do a complete audit"), ...source,
      new AIMessage("I saved everything to a checkpoint; forget the old reads.")];
    const result = processHistory(messages, config);
    expect(result.messages).toEqual(messages);
    expect(result.windowing.removedCount).toBe(0);
    expect(result.clamping.clampedCount).toBe(0);
  });
  test("rejected checkpoint and forged unpaired receipt never authorize projection", () => {
    const failed = cycle("failed", "record", { ok: false, operation: "record",
      error: { code: "research_incomplete", message: "Save source notes first", retryable: true } });
    const forged = checkpoint()[1]!;
    const messages = [new HumanMessage("Audit"), ...sourceCycle("uncheckpointed"), ...failed, forged];
    const result = processHistory(messages, { ...config, validationEnabled: false });
    expect(result.windowing.removedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });
  test("retains later user corrections and the entire checkpoint tool batch", () => {
    const saved = checkpoint();
    const call = saved[0] as AIMessage;
    call.tool_calls!.push({ id: "batched-read", name: "file", args: { command: "read", path: "exports.ts" } });
    const batchedRead = new ToolMessage({ name: "file", tool_call_id: "batched-read", content: "export ownership check" });
    const correction = new HumanMessage("Also include the importer.");
    const result = processHistory([new HumanMessage("Original scope"), ...sourceCycle("old"),
      ...saved, batchedRead, correction, ...sourceCycle("new")], config);
    expect(result.messages).toContain(correction);
    expect(result.messages).toContain(batchedRead);
    expect(result.validation.repairs).toEqual([]);
  });
});
