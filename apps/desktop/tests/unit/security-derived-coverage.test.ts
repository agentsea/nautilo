import { expect, test } from "bun:test";
import { securityScanLedgerRecordSchema, type SecurityScanCodeEvidence, type SecurityScanInventoryEntry, type SecurityScanRecordInput } from "@nautilo/types";
import { researchSectionCoverage, researchProgress } from "../../electron/security-scan/review-work";
import { unfinishedResearch } from "../../electron/security-scan/research-completion";
const author = { taskId: "00000000-0000-4000-8000-000000000001", taskRunId: "00000000-0000-4000-8000-000000000002", modelId: "openrouter:test/model" };
function record(id: string, entry: SecurityScanRecordInput) {
  return securityScanLedgerRecordSchema.parse({ id, entry, revision: 1, createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z", createdBy: author, updatedBy: author });
}
const ref = (id: string) => ({ kind: "ledger_record" as const, id });
const codeRef = (id: string) => ({ kind: "code_evidence" as const, id });
const inventory: SecurityScanInventoryEntry[] = ["api.ts", "worker.ts"].map((relativePath, index) => ({ id: `inventory_${index}`, relativePath, kind: "file", sizeBytes: 128, sourceVersion: "a".repeat(64), reason: null }));
const code = inventory.map((entry) => ({ id: `code_${entry.relativePath.replace(".", "_")}`, relativePath: entry.relativePath, sourceVersion: entry.sourceVersion })) as SecurityScanCodeEvidence[];
const hypotheses = inventory.map((entry) => record(`hyp_${entry.relativePath.replace(".", "_")}`, { kind: "hypothesis", summary: "Trace identity to protected output", state: "rejected", evidenceRefs: [codeRef(`code_${entry.relativePath.replace(".", "_")}`)], counterevidenceRefs: [codeRef(`code_${entry.relativePath.replace(".", "_")}`)] }));
const units = inventory.map((entry) => record(`unit_${entry.relativePath.replace(".", "_")}`, { kind: "review_unit", surfaceKey: "identity", summary: "Trace membership behavior", paths: [entry.relativePath], state: "reviewed", trace: "Identity reaches membership guard before output.", notes: "The outsider branch rejects access.", evidenceRefs: [ref(`hyp_${entry.relativePath.replace(".", "_")}`)], counterevidenceRefs: [codeRef(`code_${entry.relativePath.replace(".", "_")}`)], openRecordIds: [] }));
const completed = [...hypotheses, ...units];

test("completed source-backed units derive one section without another authored coverage record", () => {
  const before = JSON.stringify(completed);
  expect(researchSectionCoverage(completed, code, inventory).get("identity")).toMatchObject({ state: "reviewed", evidenceRefs: hypotheses.map((entry) => ref(entry.id)) });
  expect(unfinishedResearch(completed, code, inventory)).toBeNull();
  expect(researchProgress(completed, code, inventory, 1, 2, 1, 2)).toMatchObject({ unitsCompleted: 2, unitsPending: 0 });
  expect(JSON.stringify(completed)).toBe(before);
});

test("every unit and mapped section still matters and explicit coverage retains precedence", () => {
  const pending = record(units[1]!.id, { ...units[1]!.entry, state: "in_progress" } as SecurityScanRecordInput);
  expect(researchSectionCoverage([...hypotheses, units[0]!, pending], code, inventory).get("identity")?.state).toBe("in_progress");
  expect(unfinishedResearch([...hypotheses, units[0]!, pending], code, inventory)).toContain("accessible review work remains");
  const map = record("map", { kind: "repository_map", summary: "Two requested surfaces", surfaces: [{ key: "other", label: "Other", rationale: "Another requested boundary", coverage: "unreviewed" }], evidenceRefs: [] });
  expect(unfinishedResearch([...completed, map], code, inventory)).toContain("Section other");
  const explicit = record("coverage", { kind: "coverage", surfaceKey: "identity", state: "in_progress", rationale: "A further boundary remains", evidenceRefs: [] });
  expect(researchSectionCoverage([...completed, explicit], code, inventory).get("identity")).toEqual(explicit.entry);
  expect(unfinishedResearch([...completed, explicit], code, inventory)).toContain("requested research remains");
});

test("derived coverage requires current evidence and resolved obligations without mandatory hypothesis or counterevidence paperwork", () => {
  const stale = [{ ...inventory[0]!, sourceVersion: "b".repeat(64) }, inventory[1]!];
  expect(researchSectionCoverage(completed, code, stale).get("identity")?.state).toBe("in_progress");
  expect(unfinishedResearch(completed, code, stale)).toContain("cite current inspected source");
  const noCounter = record(hypotheses[0]!.id, { ...hypotheses[0]!.entry, counterevidenceRefs: [] } as SecurityScanRecordInput);
  expect(unfinishedResearch([noCounter, hypotheses[1]!, ...units], code, inventory)).toBeNull();
  const noHypothesis = record(units[0]!.id, { ...units[0]!.entry, evidenceRefs: [codeRef("code_api_ts")] } as SecurityScanRecordInput);
  expect(unfinishedResearch([...hypotheses, noHypothesis, units[1]!], code, inventory)).toBeNull();
  expect(unfinishedResearch(completed, code, null)).toContain("legacy");
  expect(researchSectionCoverage(completed, code, null).get("identity")?.state).toBe("in_progress");
  const unavailable: SecurityScanInventoryEntry = { id: "denied", relativePath: "private", kind: "unavailable", sizeBytes: 0, sourceVersion: null, reason: "Permission denied" };
  expect(unfinishedResearch(completed, code, [...inventory, unavailable])).toContain("private is unavailable");
  const question = record("question", { kind: "open_question", question: "Does revocation reach queued output?", evidenceRefs: [] });
  const open = record(units[0]!.id, { ...units[0]!.entry, openRecordIds: [question.id] } as SecurityScanRecordInput);
  expect(unfinishedResearch([...hypotheses, open, units[1]!, question], code, inventory)).toContain("question remains open");
});

test("source-backed exclusions remain not_applicable and mixed reviewed/excluded units remain reviewed", () => {
  const exclusions = units.map((unit, index) => record(unit.id, { ...unit.entry, state: "not_applicable", notes: "Inspected fixture is outside runtime behavior.", evidenceRefs: [codeRef(`code_${inventory[index]!.relativePath.replace(".", "_")}`)], counterevidenceRefs: [] } as SecurityScanRecordInput));
  expect(researchSectionCoverage([...hypotheses, ...exclusions], code, inventory).get("identity")?.state).toBe("not_applicable");
  expect(unfinishedResearch([...hypotheses, ...exclusions], code, inventory)).toBeNull();
  expect(researchSectionCoverage([...hypotheses, units[0]!, exclusions[1]!], code, inventory).get("identity")?.state).toBe("reviewed");
});


test("a mapped section reuses explicitly linked completed units without another investigation", () => {
  const map = record("map", { kind: "repository_map", summary: "Original broad section", surfaces: [{ key: "original_section", label: "Original section", rationale: "Covered by the focused identity investigations", coverage: "reviewed" }], evidenceRefs: [] });
  const beforeLink = [...completed, map];
  expect(unfinishedResearch(beforeLink, code, inventory)).toContain("link existing completed review units");
  const link = record("coverage_original", { kind: "coverage", surfaceKey: "original_section", state: "reviewed", rationale: "These two behavior investigations cover the original section.", evidenceRefs: units.map((unit) => ref(unit.id)) });
  const linked = [...beforeLink, link];
  expect(researchSectionCoverage(linked, code, inventory).get("original_section")?.state).toBe("reviewed");
  expect(unfinishedResearch(linked, code, inventory)).toBeNull();
  const stale = [{ ...inventory[0]!, sourceVersion: "b".repeat(64) }, inventory[1]!];
  expect(researchSectionCoverage(linked, code, stale).get("original_section")?.state).toBe("in_progress");
  expect(unfinishedResearch(linked, code, stale)).toContain("cite current inspected source");
  const pending = record(units[1]!.id, { ...units[1]!.entry, state: "in_progress" } as SecurityScanRecordInput);
  expect(researchSectionCoverage([...hypotheses, units[0]!, pending, map, link], code, inventory).get("original_section")?.state).toBe("in_progress");
  expect(unfinishedResearch([...hypotheses, units[0]!, pending, map, link], code, inventory)).toContain("accessible review work remains");
  // Prose and arbitrary evidence cannot substitute for concrete unit linkage.
  const proseOnly = record(link.id, { kind: "coverage", surfaceKey: "original_section", state: "reviewed", rationale: "Everything is covered", evidenceRefs: hypotheses.map((hypothesis) => ref(hypothesis.id)) });
  expect(unfinishedResearch([...beforeLink, proseOnly], code, inventory)).toContain("concrete review units");
});
