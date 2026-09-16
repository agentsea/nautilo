import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readTaskPreparation } from "@nautilo/types";
import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { D581_TASK_RESPONSE_SIGNATURES, reviewedD581TaskDtoReplacements } from "../../baseline/reviewed-d581-task-dto";
import { REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS } from "../../baseline/reviewed-main-2026-09-12-dto";
import { auditDtoDeclarations, discoverHttpDtoInventory } from "../../src/node/dto-inventory";

const root = resolve(import.meta.dir, "../../../..");
const locators = Object.keys(D581_TASK_RESPONSE_SIGNATURES);

test("D581 Task DTO snapshots match current producers and preserve existing plaintext/arbitrary-argument debt", async () => {
  expect(locators).toHaveLength(4);
  const observed = (await discoverHttpDtoInventory(root)).filter((entry) => locators.includes(entry.locator));
  const declarations = DTO_BASELINE_DECLARATIONS.filter((entry) => locators.includes(entry.locator));
  const reviewedCurrentReplacements = REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS.filter((entry) => locators.includes(entry.locator));
  expect(observed).toHaveLength(4);
  expect(reviewedCurrentReplacements.map((entry) => entry.locator)).toEqual([
    "http:request_response:GET /api/tasks/pending-attention",
  ]);
  expect(auditDtoDeclarations({ observations: observed, declarations }).ok).toBe(true);
  for (const declaration of declarations) {
    const reviewedCurrent = reviewedCurrentReplacements.find((entry) => entry.locator === declaration.locator);
    if (reviewedCurrent) {
      expect(declaration).toEqual(reviewedCurrent);
      expect(declaration.structuralSignatures).not.toContain(D581_TASK_RESPONSE_SIGNATURES[declaration.locator]);
    } else {
      expect(declaration.structuralSignatures).toContain(D581_TASK_RESPONSE_SIGNATURES[declaration.locator]);
    }
    expect(BASELINE_REGISTRY.debt.some((debt) => debt.locator === declaration.locator)
      || BASELINE_REGISTRY.reviewedDebtLinks?.some((link) => link.locator === declaration.locator)).toBe(true);
    expect(BASELINE_REGISTRY.entries.some((entry) => entry.locator === declaration.locator && entry.classification === "protected")).toBe(false);
  }
  const detail = declarations.find((entry) => entry.locator === "http:request_response:GET /api/tasks/:id")!;
  expect(detail.arbitraryPayloads).toEqual([{ path: "response.body.runs[].transcript[].toolCalls[].args", debtId: "debt.wire.arbitrary.19ijf0o" }]);
  const pending = declarations.find((entry) => entry.locator.endsWith("/pending-attention"))!;
  expect(pending.arbitraryPayloads).toEqual([
    { path: "response.body[].activity.args", schema: "TaskAttentionToolArgumentsV1" },
    { path: "response.body[].tools[].args", schema: "TaskAttentionToolArgumentsV1" },
  ]);
}, 120_000);

test("D581 replacement preserves unrelated request/error signatures and rejects ambiguous predecessors", () => {
  const prior = DTO_BASELINE_DECLARATIONS.filter((entry) => locators.includes(entry.locator));
  const amended = prior.map((entry) => ({ ...entry, structuralSignatures: [...entry.structuralSignatures!, "request.query:{unrelated:string}"] }));
  for (const entry of reviewedD581TaskDtoReplacements(amended)) {
    expect(entry.structuralSignatures).toContain("request.query:{unrelated:string}");
    expect(entry.arbitraryPayloads).toBe(amended.find((item) => item.locator === entry.locator)!.arbitraryPayloads);
  }
  expect(() => reviewedD581TaskDtoReplacements([])).toThrow("predecessor missing");
  const duplicated = amended.map((entry) => ({ ...entry,
    structuralSignatures: [...entry.structuralSignatures, D581_TASK_RESPONSE_SIGNATURES[entry.locator]!],
  }));
  expect(() => reviewedD581TaskDtoReplacements(duplicated)).toThrow("absent or ambiguous");
});

test("Task preparation projects only validated recovery facts and the explicitly accepted research subject", () => {
  const input = {
    stage: "using_tools", activity: "recovering_context", taskRunId: "run", updatedAt: "2026-09-08T00:00:00Z",
    contextRecovery: { pendingInputs: 2, phase: "reading", recoveredInputBytes: 100, retainedUnconsolidatedPages: 1, rawText: "must not project" },
    contextPage: { startByte: 0, endByte: 100, totalBytes: 500, content: "must not project" },
    researchWork: { role: "investigator", subject: "Check tenant isolation", source: "must not project" },
    rawArgs: { credential: "must not project" },
  };
  const projection = readTaskPreparation(input)!;
  expect(projection.contextRecovery).toEqual({ pendingInputs: 2, phase: "reading", recoveredInputBytes: 100, retainedUnconsolidatedPages: 1 });
  expect(projection.contextPage).toEqual({ startByte: 0, endByte: 100, totalBytes: 500 });
  // This text stays Task content under existing owner-private debt, rather
  // than being mislabeled as content-free telemetry or stripped silently.
  expect(projection.researchWork).toEqual({ role: "investigator", subject: "Check tenant isolation" });
  expect(JSON.stringify(projection)).not.toContain("must not project");
  expect(readTaskPreparation({ ...input, contextPage: { startByte: 50, endByte: 10, totalBytes: 500 } })).toBeNull();
  expect(readTaskPreparation({ ...input, researchWork: { role: "unknown", subject: "Scope" } })).toBeNull();
});

test("all four response entrances retain owner fencing and transcript presentation remains an explicit owner read", async () => {
  const source = await readFile(resolve(root, "packages/server/src/routes/tasks.ts"), "utf8");
  expect(source).toContain("listTasksForOwner(db, ownerId, opts)");
  expect(source).toContain("listAwaitingTaskRunsForOwner(getServerDirectDb(), ownerId)");
  const detail = source.slice(source.indexOf('const runSummaries: TaskRunSummary[]'), source.indexOf('const detail: TaskDetail'));
  expect(detail).toContain("includeToolPresentation: true,");
  expect(detail).toContain("ownerId,");
  expect(detail).toContain("...(m.toolCallId ? { toolCallId: m.toolCallId } : {})");
  expect(detail).toContain("...(m.toolStatus ? { toolStatus: m.toolStatus } : {})");
  const patch = source.slice(source.indexOf('app.patch<{ Params: { id: string }; Body: TaskUpdatePayload }>'));
  expect(patch).toContain("if (!task || task.ownerId !== ownerId)");
  const beforeDetail = source.slice(0, source.indexOf('const runSummaries: TaskRunSummary[]'));
  expect(beforeDetail).toContain("if (!task || task.ownerId !== ownerId)");
  expect(source).toContain('readTaskPreparation(task.metadata?.["preparation"])');
});
