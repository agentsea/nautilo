import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { securityScanLedgerRecordSchema, type SecurityScanCodeEvidence, type SecurityScanInventoryEntry, type SecurityScanRecordInput, type SecurityScanObservation } from "@nautilo/types";
import { DesktopSecurityScanLedger } from "../../electron/security-scan/ledger";
import { captureSecurityInventory, securityInventoryFingerprint } from "../../electron/security-scan/inventory";
import { unfinishedReviewWork, researchProgress, unfinishedScannerTriage } from "../../electron/security-scan/review-work";

const author = { taskId: "00000000-0000-4000-8000-000000000001", taskRunId: "00000000-0000-4000-8000-000000000002", modelId: "openrouter:test/model" };
function record(id: string, entry: SecurityScanRecordInput) {
  return securityScanLedgerRecordSchema.parse({ id, entry, revision: 1, createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z", createdBy: author, updatedBy: author });
}
const ref = (id: string) => ({ kind: "ledger_record" as const, id });
const codeRef = (id: string) => ({ kind: "code_evidence" as const, id });
const inventory: SecurityScanInventoryEntry[] = ["api.ts", "worker.ts"].map((relativePath, index) => ({
  id: `inventory_${index}`, relativePath, kind: "file", sizeBytes: 128, sourceVersion: "a".repeat(64), reason: null,
}));
const code = [{ id: "code_api", relativePath: "api.ts", sourceVersion: "a".repeat(64) }, { id: "code_worker", relativePath: "worker.ts", sourceVersion: "a".repeat(64) }] as SecurityScanCodeEvidence[];
const hypothesis = (key: string) => record(`hypothesis_${key}`, { kind: "hypothesis", summary: `Trace ${key} input, guard and output`, state: "rejected", evidenceRefs: [codeRef(`code_${key}`)], counterevidenceRefs: [codeRef(`code_${key}`)] });
const unit = (key: string) => record(`unit_${key}`, { kind: "review_unit", summary: `Inspect ${key} behavior`, surfaceKey: key, paths: [`${key}.ts`], state: "reviewed", trace: "Identity flows through membership guard before private output.", notes: "Compared the safe refusal with the permitted owner branch.", evidenceRefs: [ref(`hypothesis_${key}`)], counterevidenceRefs: [codeRef(`code_${key}`)], openRecordIds: [] });
const completed = [hypothesis("api"), hypothesis("worker"), unit("api"), unit("worker")];

describe("accountable source review", () => {
  test("inventory is required but unassigned files do not reopen a completed review plan", () => {
    expect(unfinishedReviewWork(completed, code, null)).toContain("legacy");
    expect(unfinishedReviewWork([hypothesis("api"), unit("api")], code, inventory)).toBeNull();
    expect(researchProgress([hypothesis("api"), unit("api")], code, inventory, 1, 1, 1, 1))
      .toMatchObject({ filesTotal: 2, filesAssigned: 1, filesUnassigned: 1, unitsTotal: 1, unitsCompleted: 1, unitsPending: 0 });
    expect(unfinishedReviewWork(completed, code, inventory)).toBeNull();
  });
  test("old source evidence cannot be relinked after the inventory version changes", () => {
    const changed = [{ ...inventory[0]!, sourceVersion: "b".repeat(64) }, inventory[1]!];
    expect(unfinishedReviewWork(completed, code, changed)).toContain("cite current inspected source");
    const fresh = [{ ...code[0]!, sourceVersion: "b".repeat(64) }, code[1]!];
    expect(unfinishedReviewWork(completed, fresh, changed)).toBeNull();
  });
  test("reusing a valid hypothesis cannot close unrelated source", () => {
    const borrowed = record("unit_worker", { ...unit("worker").entry, evidenceRefs: [ref("hypothesis_api")] } as SecurityScanRecordInput);
    expect(unfinishedReviewWork([...completed.slice(0, -1), borrowed], code, inventory)).toContain("cite current inspected source");
    expect(researchProgress([...completed.slice(0, -1), borrowed], code, inventory, 2, 2, 2, 2)).toMatchObject({ unitsCompleted: 1, unitsPending: 1 });
  });
  test("unresolved followups, limited work and unavailable inventory stay pending", () => {
    const question = record("question_queue", { kind: "open_question", question: "Does revocation reach queued jobs?", evidenceRefs: [] });
    const pending = record("unit_worker", { ...unit("worker").entry, openRecordIds: [question.id] } as SecurityScanRecordInput);
    expect(unfinishedReviewWork([...completed.slice(0, -1), question, pending], code, inventory)).toContain("question_queue remains open");
    const limited = record("unit_worker", { ...unit("worker").entry, state: "limited", blocker: "Queue driver unavailable" } as SecurityScanRecordInput);
    expect(unfinishedReviewWork([...completed.slice(0, -1), limited], code, inventory)).toContain("accessible review work remains");
    expect(unfinishedReviewWork(completed, code, [...inventory, { id: "inventory_denied", relativePath: "private", kind: "unavailable", sizeBytes: 0, sourceVersion: null, reason: "Permission denied" }])).toContain("private is unavailable");
  });
  test("closed cross-unit followups remain complete and cycles cannot certify each other", () => {
    const linked = record("unit_api", { ...unit("api").entry, openRecordIds: ["unit_worker"] } as SecurityScanRecordInput);
    const records = [hypothesis("api"), hypothesis("worker"), linked, unit("worker")];
    expect(unfinishedReviewWork(records, code, inventory)).toBeNull();
    expect(researchProgress(records, code, inventory, 2, 2, 2, 2).unitsCompleted).toBe(2);
    const cycle = record("unit_worker", { ...unit("worker").entry, openRecordIds: ["unit_api"] } as SecurityScanRecordInput);
    expect(unfinishedReviewWork([...records.slice(0, -1), cycle], code, inventory)).toContain("remains open");
  });
  test("explicit exclusions remain visible without pretending to inspect generated bytes", () => {
    const excluded = record("unit_worker", { ...unit("worker").entry, state: "not_applicable", notes: "The inspected generated fixture declaration shows it is outside runtime scope.", evidenceRefs: [codeRef("code_worker")], counterevidenceRefs: [] } as SecurityScanRecordInput);
    const unsupported = record(excluded.id, { ...excluded.entry, evidenceRefs: [] } as SecurityScanRecordInput);
    expect(unfinishedReviewWork([...completed.slice(0, -1), unsupported], code, inventory)).toBeNull();
    const records = [...completed.slice(0, -1), excluded];
    expect(unfinishedReviewWork(records, code, inventory)).toBeNull();
    expect(researchProgress(records, code, inventory, 35, 25, 32, 20)).toMatchObject({ excludedEntriesTotal: 1, coverageOmitted: 3, hypothesesOmitted: 5, filesTotal: 2 });
  });
  test("scanner triage accounts for exact members rather than family prose", () => {
    const observations = [{ id: "observation_first" }, { id: "observation_second" }] as SecurityScanObservation[];
    const dismissal = record("dismissal_family", { kind: "dismissal", summary: "Family lead checked against protected paths", evidenceRefs: [{ kind: "scanner_observation", id: "observation_first" }], counterevidenceRefs: [] });
    expect(unfinishedScannerTriage([dismissal], observations)).toContain("observation_second");
    const both = record(dismissal.id, { ...dismissal.entry, evidenceRefs: observations.map((item) => ({ kind: "scanner_observation", id: item.id })) } as SecurityScanRecordInput);
    expect(unfinishedScannerTriage([both], observations)).toBeNull();
  });
});

test("inventory traverses nested packages and discloses symlink, Git metadata and authority exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-review-inventory-"));
  try {
    await mkdir(join(root, "packages", "worker"), { recursive: true });
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "blocked"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "dependency.ts"), "export const dependency = true;\n");
    await writeFile(join(root, "asset.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await writeFile(join(root, "unknown.png"), "export const actualSource = true;\n");
    await writeFile(join(root, ".git", "config"), "not source");
    await writeFile(join(root, "packages", "worker", "entry.ts"), "export const task = true;\n");
    await symlink(join(root, "packages"), join(root, "linked"));
    const progress: { filesObserved: number; directoriesObserved: number }[] = [];
    const capture = () => captureSecurityInventory({ currentFolder: root, target: root, allowed: (path) => !path.endsWith("blocked"), assertLive: async () => {}, onProgress: (counts) => progress.push(counts) });
    const entries = await capture();
    expect(entries.map((entry) => entry.relativePath).sort()).toEqual([".git", "asset.png", "blocked", "linked", "node_modules", "packages/worker/entry.ts", "unknown.png"]);
    expect(entries.find((entry) => entry.relativePath === "linked")?.kind).toBe("excluded");
    expect(entries.find((entry) => entry.relativePath === "linked")?.reason).toContain("Symbolic links");
    expect(entries.find((entry) => entry.relativePath === "blocked")).toMatchObject({ kind: "unavailable" });
    expect(entries.find((entry) => entry.relativePath === "asset.png")?.kind).toBe("excluded");
    expect(entries.find((entry) => entry.relativePath === "unknown.png")?.kind).toBe("file");
    expect(entries.find((entry) => entry.relativePath === "node_modules")?.reason).toContain("not dependency security clearance");
    expect(progress.at(-1)?.filesObserved).toBe(3);
    const dependencyTarget = await captureSecurityInventory({ currentFolder: root, target: join(root, "node_modules"), allowed: () => true, assertLive: async () => {} });
    expect(dependencyTarget.map((entry) => entry.relativePath)).toEqual(["node_modules/dependency.ts"]);
    const fingerprint = securityInventoryFingerprint(entries);
    const repeated = await capture();
    expect(repeated).toEqual(entries);
    expect(securityInventoryFingerprint(repeated)).toBe(fingerprint);
    await writeFile(join(root, "packages", "worker", "new.ts"), "export const next = true;\n");
    expect(securityInventoryFingerprint(await capture())).not.toBe(fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("more scanner members than one reference frame remain individually accountable through evidence chunks", () => {
  const observations = Array.from({ length: 27 }, (_, index) => ({ id: `observation_member_${index}` })) as SecurityScanObservation[];
  const chunks = [observations.slice(0, 9), observations.slice(9, 18), observations.slice(18)].map((members, index) => record(`evidence_chunk_${index}`, {
    kind: "evidence", summary: `Retained exact members of the inspected scanner lead, group ${index}.`,
    evidenceRefs: members.map((member) => ({ kind: "scanner_observation", id: member.id })),
  }));
  const disposition = record("dismissal_all_members", { kind: "dismissal", summary: "The grouped observations were individually checked against their protected call paths.",
    evidenceRefs: chunks.map((chunk) => ref(chunk.id)), counterevidenceRefs: [] });
  expect(unfinishedScannerTriage([...chunks, disposition], observations)).toBeNull();
  const missingLast = record(chunks[2]!.id, { ...chunks[2]!.entry, evidenceRefs: chunks[2]!.entry.evidenceRefs.slice(0, -1) } as SecurityScanRecordInput);
  expect(unfinishedScannerTriage([chunks[0]!, chunks[1]!, missingLast, disposition], observations)).toContain("observation_member_26");
});

test("checkpoint and review-unit followups preserve obligations beyond the former twenty-record ceiling", () => {
  const questions = Array.from({ length: 27 }, (_, index) => record(`question_followup_${index}`, {
    kind: "open_question", question: `Does behavior ${index} retain the current actor's access?`,
    resolution: "The inspected guard checks current membership before output.", evidenceRefs: [codeRef("code_api")],
  }));
  const openRecordIds = questions.map((question) => question.id);
  const checkpoint = record("checkpoint_full_frontier", { kind: "checkpoint", summary: "Saved the complete outstanding review frontier.", nextWork: "Recheck each linked answer before finalizing.", openRecordIds, evidenceRefs: [] });
  const linkedUnit = record("unit_api", { ...unit("api").entry, openRecordIds } as SecurityScanRecordInput);
  expect(checkpoint.entry.kind === "checkpoint" && checkpoint.entry.openRecordIds).toEqual(openRecordIds);
  expect(linkedUnit.entry.kind === "review_unit" && linkedUnit.entry.openRecordIds).toEqual(openRecordIds);
  expect(unfinishedReviewWork([...completed.filter((entry) => entry.id !== "unit_api"), linkedUnit, checkpoint, ...questions], code, inventory)).toBeNull();
  const unanswered = record(questions[26]!.id, { kind: "open_question", question: "Does the final queued path recheck revocation?", evidenceRefs: [] });
  expect(unfinishedReviewWork([...completed.filter((entry) => entry.id !== "unit_api"), linkedUnit, checkpoint, ...questions.slice(0, -1), unanswered], code, inventory)).toContain("question_followup_26 remains open");
});

test("accepted notes longer than one text frame can be reloaded exactly by record IDs across result pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-security-note-reload-"));
  const rootIdentity = { fingerprint: "a".repeat(64) };
  const access = { scanId: "scan_note_reload", localOwnerId: "owner_notes", rootIdentity };
  const trusted = (toolCallId: string) => ({ ...author, toolCallId });
  const ledger = new DesktopSecurityScanLedger({ userDataRoot: root,
    rootIdentityReader: { async revalidate() { return rootIdentity; } },
    citationReader: { async revalidateAndHash(citation) { return { ...citation, rootFingerprint: rootIdentity.fingerprint,
      fileSha256: "b".repeat(64), rangeSha256: "c".repeat(64), sourceVersion: "d".repeat(64), gitHead: null, gitDirty: null }; } },
  });
  try {
    await ledger.create({ ...access, trusted: trusted("start"), mode: "deep_research" });
    const summaries = Array.from({ length: 24 }, (_, index) => `Behavior ${index}: request identity enters the project guard, remains bound through storage selection, and is checked again before delivery. The denied branch returns no document body; the permitted branch returns only the selected project output.`);
    expect(summaries.join("\n").length).toBeGreaterThan(2000);
    const accepted = [];
    for (const [index, summary] of summaries.entries()) {
      const receipt = await ledger.appendOrUpdate({ ...access, trusted: trusted(`note_${index}`), operation: {
        version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append",
        entry: { kind: "evidence", summary, evidenceRefs: [] }, fileCitations: [{ relativePath: "src/authority.ts", startLine: index + 1, endLine: index + 1 }],
      } });
      accepted.push(receipt.record);
    }
    const recovered = new Map<string, string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await ledger.results({ ...access, trusted: trusted(`reload_${pages}`), operation: {
        version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "research", recordIds: accepted.map((entry) => entry.id), limit: 5,
        ...(cursor === undefined ? {} : { cursor }),
      } });
      for (const entry of page.records) if (entry.entry.kind === "evidence") recovered.set(entry.id, entry.entry.summary);
      expect(page.reportReady).toBe(false);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThan(1);
    expect(accepted.map((entry) => recovered.get(entry.id))).toEqual(summaries);
    const selection = [accepted[1]!, accepted[22]!];
    const targeted = await ledger.results({ ...access, trusted: trusted("reload_selected"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "research", recordIds: selection.map((entry) => entry.id), limit: 100,
    } });
    expect(new Set(targeted.records.map((entry) => entry.id))).toEqual(new Set(selection.map((entry) => entry.id)));
    expect(targeted.records.map((entry) => entry.entry.kind === "evidence" ? entry.entry.summary : null).sort()).toEqual([summaries[1]!, summaries[22]!].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
