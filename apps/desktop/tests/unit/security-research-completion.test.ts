import { describe, expect, test } from "bun:test";
import { securityScanLedgerRecordSchema, type SecurityScanCodeEvidence, type SecurityScanRecordInput } from "@nautilo/types";
import { unfinishedResearch } from "../../electron/security-scan/research-completion";

const author = { taskId: "00000000-0000-4000-8000-000000000001", taskRunId: "00000000-0000-4000-8000-000000000002", modelId: "openrouter:test/model" };
const code = [{ id: "evidence_source" }, { id: "evidence_guard" }] as SecurityScanCodeEvidence[];
const ref = (id: string) => ({ kind: "ledger_record" as const, id });
function record(id: string, entry: SecurityScanRecordInput) {
  return securityScanLedgerRecordSchema.parse({ id, entry, revision: 1, createdAt: "2026-09-06T12:00:00Z", updatedAt: "2026-09-06T12:00:00Z", createdBy: author, updatedBy: author });
}
const plan = record("map_repo", { kind: "repository_map", summary: "API and worker cross-user data flows", surfaces: [
  { key: "api", label: "API", coverage: "reviewed", rationale: "Map labels do not qualify." },
  { key: "worker", label: "Worker", coverage: "unreviewed", rationale: "Queued disclosure" },
], evidenceRefs: [] });
const hypothesis = record("hypothesis_api", { kind: "hypothesis", summary: "Identity reaches owner-scoped storage", state: "rejected",
  evidenceRefs: [{ kind: "code_evidence", id: "evidence_source" }], counterevidenceRefs: [{ kind: "code_evidence", id: "evidence_guard" }] });
const coverage = (key: string) => record(`coverage_${key}`, { kind: "coverage", surfaceKey: key, state: "reviewed", rationale: "Traced request, guard and output; rejected the cross-user hypothesis.", evidenceRefs: [ref(hypothesis.id)] });

describe("requested research completion", () => {
  test("map labels and scanner-only summaries cannot finish a section", () => {
    expect(unfinishedResearch([plan], code)).toContain("Section api");
    const empty = record("coverage_api", { ...coverage("api").entry, evidenceRefs: [] });
    expect(unfinishedResearch([plan, empty], code)).toContain("cite inspected source");
  });
  test("completing one section returns the next unfinished section", () => {
    expect(unfinishedResearch([plan, hypothesis, coverage("api")], code)).toContain("Section worker");
    expect(unfinishedResearch([plan, hypothesis, coverage("api"), coverage("worker")], code)).toBeNull();
  });
  test("legacy hypotheses still need resolution and source evidence; separate counterevidence is optional", () => {
    const noCounter = record(hypothesis.id, { ...hypothesis.entry, counterevidenceRefs: [] } as SecurityScanRecordInput);
    expect(unfinishedResearch([plan, noCounter, coverage("api"), coverage("worker")], code)).toBeNull();
    const pending = record(hypothesis.id, { ...hypothesis.entry, state: "investigating" } as SecurityScanRecordInput);
    expect(unfinishedResearch([plan, pending, coverage("api")], code)).toContain("finish the linked hypothesis");
  });
  test("a limited section needs a concrete corroborated blocker", () => {
    const limited = record("coverage_worker", { kind: "coverage", surfaceKey: "worker", state: "limited", rationale: "Dependency absent", evidenceRefs: [ref(hypothesis.id)] });
    expect(unfinishedResearch([plan, hypothesis, coverage("api"), limited], code)).toContain("concrete source/dependency blocker");
    const blocked = record(limited.id, { ...limited.entry, blocker: "The queue adapter implementation belongs to an external service." } as SecurityScanRecordInput);
    expect(unfinishedResearch([plan, hypothesis, coverage("api"), blocked], code)).toBeNull();
  });
  test("dangling or cyclic evidence cannot qualify a section", () => {
    const cycle = record("hypothesis_api", { ...hypothesis.entry, evidenceRefs: [ref("hypothesis_api")] } as SecurityScanRecordInput);
    expect(unfinishedResearch([plan, cycle, coverage("api")], code)).toContain("cite inspected source");
  });
});

test("an open question needs a cited resolution or an explicit linked blocker", () => {
  const done = [plan, hypothesis, coverage("api"), coverage("worker")];
  const question = record("question_worker", { kind: "open_question", question: "Does the queue recheck membership?", evidenceRefs: [] });
  expect(unfinishedResearch([...done, question], code)).toContain("Resolve question");
  const unsupported = record(question.id, { ...question.entry, resolution: "Yes" } as SecurityScanRecordInput);
  expect(unfinishedResearch([...done, unsupported], code)).toContain("cite source");
  const resolved = record(question.id, { ...question.entry, resolution: "The worker explicitly checks current membership.", evidenceRefs: [{ kind: "code_evidence", id: "evidence_guard" }] } as SecurityScanRecordInput);
  expect(unfinishedResearch([...done, resolved], code)).toBeNull();
});

test("every declared section and unresolved hypothesis remains work until decided or concretely blocked", () => {
  const done = [plan, hypothesis, coverage("api"), coverage("worker")];
  const extra = record("hypothesis_extra", { kind: "hypothesis", summary: "Cross-boundary access may be missing.", state: "unresolved", evidenceRefs: [{ kind: "code_evidence", id: "evidence_source" }], counterevidenceRefs: [{ kind: "code_evidence", id: "evidence_guard" }] });
  expect(unfinishedResearch([...done, extra], code)).toContain("Resolve hypothesis hypothesis_extra");
  const newSection = record("coverage_new", { kind: "coverage", surfaceKey: "new", state: "in_progress", rationale: "Discovered another caller", evidenceRefs: [] });
  expect(unfinishedResearch([...done, newSection], code)).toContain("Section new");
  const notApplicable = (key: string) => record(`coverage_${key}`, { kind: "coverage", surfaceKey: key, state: "not_applicable", rationale: "No runtime entry point in this surface", evidenceRefs: [{ kind: "code_evidence", id: "evidence_source" }] });
  expect(unfinishedResearch([plan, notApplicable("api"), notApplicable("worker")], code)).toContain("investigate material hypotheses");
});

test("finalization identifies the exact failing hypothesis when a section links multiple investigations", () => {
  const other = record("hypothesis_second", { ...hypothesis.entry, summary: "A separate output path lacks a fresh guard.",
    state: "supported", evidenceRefs: [] } as SecurityScanRecordInput);
  const both = record("coverage_api", { ...coverage("api").entry, evidenceRefs: [ref(hypothesis.id), ref(other.id)] });
  const records = [plan, hypothesis, other, both, coverage("worker")];
  const feedback = unfinishedResearch(records, code)!;
  expect(feedback).toContain("Section api");
  expect(feedback).toContain("Hypothesis hypothesis_second (revision 1)");
  expect(feedback).toContain("evidenceRefs");
  expect(feedback).not.toContain("Hypothesis hypothesis_api");

  // Repeatedly improving the already-valid first hypothesis cannot repair the second.
  const unrelatedRepair = { ...hypothesis, revision: 4 };
  expect(unfinishedResearch([plan, unrelatedRepair, other, both, coverage("worker")], code)).toBe(feedback);
  const repaired = { ...other, revision: 2, entry: { ...other.entry,
    evidenceRefs: [{ kind: "code_evidence" as const, id: "evidence_guard" }] } };
  expect(unfinishedResearch([plan, unrelatedRepair, repaired, both, coverage("worker")], code)).toBeNull();
});

test("unlinked hypothesis feedback identifies the missing source-reference field and current revision", () => {
  const extra = { ...record("hypothesis_extra", { ...hypothesis.entry, evidenceRefs: [] } as SecurityScanRecordInput), revision: 3 };
  const feedback = unfinishedResearch([plan, hypothesis, coverage("api"), coverage("worker"), extra], code)!;
  expect(feedback).toContain("Hypothesis hypothesis_extra (revision 3): evidenceRefs");
  expect(feedback).toContain("expectedRevision:3");
  expect(feedback).not.toContain("counterevidenceRefs");
});
