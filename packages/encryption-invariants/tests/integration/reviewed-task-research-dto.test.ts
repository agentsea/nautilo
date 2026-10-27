import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readTaskPreparation } from "@nautilo/types";
import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { TASK_RESEARCH_RESPONSE_SIGNATURES, reviewedTaskResearchDtoReplacements } from "../../baseline/reviewed-task-research-dto";
import { REVIEWED_TASK_PROTECTION_DTO_DECLARATIONS } from "../../baseline/reviewed-task-protection-dto";
import { auditDtoDeclarations, discoverHttpDtoInventory } from "../../src/node/dto-inventory";

const root = resolve(import.meta.dir, "../../../..");
const locators = Object.keys(TASK_RESEARCH_RESPONSE_SIGNATURES);

test("Task research continuity Task DTO snapshots match current producers and preserve existing plaintext/arbitrary-argument debt", async () => {
  expect(locators).toHaveLength(4);
  const observed = (await discoverHttpDtoInventory(root)).filter((entry) => locators.includes(entry.locator));
  const declarations = DTO_BASELINE_DECLARATIONS.filter((entry) => locators.includes(entry.locator));
  const currentReviewed = REVIEWED_TASK_PROTECTION_DTO_DECLARATIONS.filter((entry) => locators.includes(entry.locator));
  expect(observed).toHaveLength(4);
  expect(currentReviewed).toHaveLength(4);
  expect(auditDtoDeclarations({ observations: observed, declarations }).ok).toBe(true);
  for (const declaration of declarations) {
    const reviewed = currentReviewed.find((entry) => entry.locator === declaration.locator);
    if (reviewed === undefined) throw new Error("Missing current Task DTO review");
    expect(declaration).toMatchObject({
      observationId: reviewed.observationId,
      locator: reviewed.locator,
    });
    expect(declaration.structuralSignatures?.some((signature) =>
      signature.includes("catch:function"))).toBe(false);
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

test("Task research continuity replacement preserves unrelated request/error signatures and rejects ambiguous predecessors", () => {
  // Exercise the historical replacement against its historical contract family,
  // rather than applying it backwards to the later protected-route successor.
  const amended = locators.map((locator) => ({
    observationId: locator,
    locator,
    structuralSignatures: [
      "request.query:{unrelated:string}",
      "response.body:{error:string}",
      locator.endsWith("GET /api/tasks/:id")
        ? "response.body:{runs:{id:string}[];task:{id:string}}"
        : locator.endsWith("/pending-attention")
          ? "response.body:{activity?:{id:string}}[]"
          : "response.body:{agentId?:string;prompt:string}",
    ],
    arbitraryPayloads: DTO_BASELINE_DECLARATIONS.find((entry) =>
      entry.locator === locator)!.arbitraryPayloads,
  }));
  for (const entry of reviewedTaskResearchDtoReplacements(amended)) {
    expect(entry.structuralSignatures).toContain("request.query:{unrelated:string}");
    expect(entry.structuralSignatures).toContain("response.body:{error:string}");
    expect(entry.structuralSignatures).toContain(
      TASK_RESEARCH_RESPONSE_SIGNATURES[entry.locator],
    );
    expect(entry.arbitraryPayloads).toBe(amended.find((item) => item.locator === entry.locator)!.arbitraryPayloads);
  }
  expect(() => reviewedTaskResearchDtoReplacements([])).toThrow("predecessor missing");
  const duplicated = amended.map((entry) => ({ ...entry,
    structuralSignatures: [...entry.structuralSignatures, TASK_RESEARCH_RESPONSE_SIGNATURES[entry.locator]!],
  }));
  expect(() => reviewedTaskResearchDtoReplacements(duplicated)).toThrow("absent or ambiguous");
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
  expect(source).toContain("listAwaitingTaskRunsForOwner(getServerDirectDb(), ownerId, { approvalRecipient: true })");
  expect(source).toContain("taskApprovalRecipient(task) !== ownerId");
  expect(source).toContain("taskApprovalRecipient(authorized.task) !== ownerId");
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
