import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { SECURITY_SCAN_INITIAL_LANES, securityScanLedgerRecordSchema, securityScanStatusSchema, securityScanToolResultSchema } from "@nautilo/types";
import { securityResearchAppendix } from "../../src/tools/security/research-appendix";

const status = {
  version: "security-scan-v1", scanId: "scan_test", state: "completed", phase: null,
  terminalState: "completed", mode: "deep_research", modelId: "openai:test", modelState: "completed",
  completedSteps: 2, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES,
  coverage: [{ surfaceKey: "auth", label: "Auth", state: "reviewed", rationale: "Traced checks." }], hypotheses: [],
  researchProgress: { inventoryState: "complete", inventoryFingerprint: "d".repeat(64), filesTotal: 1,
    filesAssigned: 1, filesUnassigned: 0, unitsTotal: 1, unitsCompleted: 1, unitsPending: 0,
    excludedEntriesTotal: 0, coverageTotal: 1, hypothesesTotal: 1, coverageOmitted: 0, hypothesesOmitted: 0, latestCheckpoint: null },
};
const author = { taskId: "00000000-0000-4000-8000-000000000001", taskRunId: "00000000-0000-4000-8000-000000000002", modelId: "openai:test" };
const record = { id: "record_note", revision: 1, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", createdBy: author, updatedBy: author,
  entry: { kind: "evidence", summary: "The worker rechecks current tenant membership before reading storage, including revocation after enqueue.", evidenceRefs: [] } };
function page(id: string, continuing: boolean, overrides: Record<string, unknown> = {}) {
  return [new AIMessage({ content: "", tool_calls: [{ id, name: "security_scan", args: { operation: "results", category: "all", finalize: true, ...(continuing ? { continueResults: true } : {}) } }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: id, content: JSON.stringify({ ok: true, operation: "results", result: {
      version: "security-scan-v1", status, observations: [], codeEvidence: [], records: [], inventory: [], nextCursor: null, reportReady: true, ...overrides,
    } }) })];
}
test("exports an early page's detailed notes even when the final model narrative omits them", () => {
  const messages = [...page("first", false, { records: [record], nextCursor: "cursor_tail", reportReady: false }),
    ...page("last", true, { inventory: [{ id: "inventory_source", relativePath: "src/worker.ts", kind: "file", sizeBytes: 2100, sourceVersion: "f".repeat(64), reason: null }] }),
    new AIMessage("The audit is complete; see findings.")];
  const appendix = securityResearchAppendix(messages);
  expect(appendix).toContain(record.entry.summary);
  expect(appendix).toContain("src/worker.ts");
  expect(appendix).toContain("1 research records");
  expect(appendix).not.toContain("The audit is complete; see findings.");
});
test("refuses an orphan tail, incomplete page chain or unpaired fabricated notes", () => {
  expect(securityResearchAppendix(page("tail", true))).toBeNull();
  expect(securityResearchAppendix(page("partial", false, { nextCursor: "cursor_tail", reportReady: false }))).toBeNull();
  const first = page("first", false, { nextCursor: "cursor_tail", reportReady: false });
  expect(securityResearchAppendix([...first, page("unpaired", true, { records: [record] })[1]!])).toBeNull();
});


test("many accepted atomic notes survive targeted recovery and final pagination without a report-wide text cutoff", () => {
  const summaries = Array.from({ length: 24 }, (_, index) => `Trace ${index}: the request principal reaches the project membership decision before document selection. The queued path rechecks authority before delivering the body; the rejected branch emits only coordination metadata and never the private result.`);
  expect(summaries.join("\n").length).toBeGreaterThan(2000);
  const sources = summaries.map((_, index) => ({ id: `evidence_note_${index}`, relativePath: "src/worker.ts", startLine: index + 1, endLine: index + 1,
    sourceVersion: "f".repeat(64), fileSha256: "a".repeat(64), rangeSha256: "b".repeat(64), rootFingerprint: "c".repeat(64), capturedAt: "2026-09-07T00:00:00.000Z", gitHead: null, gitDirty: null }));
  const notes = summaries.map((summary, index) => securityScanLedgerRecordSchema.parse({ ...record, id: `record_note_${index}`,
    entry: { kind: "evidence", summary, evidenceRefs: [{ kind: "code_evidence", id: sources[index]!.id }] },
  }));
  const acknowledgements = notes.flatMap((note, index) => {
    const id = `save_note_${index}`;
    const receipt = securityScanToolResultSchema.parse({ ok: true, operation: "record", result: { record: note, codeEvidence: [sources[index]!] } });
    return [new AIMessage({ content: "", tool_calls: [{ id, name: "security_scan", args: { version: "security-scan-v1", operation: "record", action: "append", entry: note.entry } }] }),
      new ToolMessage({ name: "security_scan", tool_call_id: id, content: JSON.stringify(receipt) })];
  });
  const selected = [notes[1]!, notes[22]!];
  const reload = [new AIMessage({ content: "", tool_calls: [{ id: "reload_selected", name: "security_scan", args: {
    operation: "results", category: "research", recordIds: selected.map((note) => note.id), finalize: false,
  } }] }), new ToolMessage({ name: "security_scan", tool_call_id: "reload_selected", content: JSON.stringify(securityScanToolResultSchema.parse({
    ok: true, operation: "results", result: { version: "security-scan-v1", status: { ...status, state: "active", terminalState: null, phase: "researching", modelState: "running" },
      observations: [], codeEvidence: [sources[1]!, sources[22]!], records: selected, inventory: [], nextCursor: null, reportReady: false },
  })) })];
  const finalPages = [];
  for (let offset = 0; offset < notes.length; offset += 4) {
    const last = offset + 4 >= notes.length;
    finalPages.push(...page(`final_notes_${offset}`, offset !== 0, {
      records: notes.slice(offset, offset + 4), codeEvidence: sources.slice(offset, offset + 4),
      inventory: last ? [{ id: "inventory_source", relativePath: "src/worker.ts", kind: "file", sizeBytes: 7000, sourceVersion: "f".repeat(64), reason: null }] : [],
      nextCursor: last ? null : `cursor_notes_${offset + 4}`, reportReady: last,
    }));
  }
  expect(securityResearchAppendix([...acknowledgements, ...reload])).toBeNull();
  const appendix = securityResearchAppendix([...acknowledgements, ...reload, ...finalPages, new AIMessage("Completed the audit.")]);
  expect(appendix).not.toBeNull();
  expect(appendix).toContain("24 research records, 24 source citations");
  for (const summary of summaries) {
    expect(appendix).toContain(summary);
    expect(appendix!.split(summary)).toHaveLength(2);
  }
  // An orphan continuation does not borrow the missing final pages from earlier save acknowledgements.
  expect(securityResearchAppendix([...acknowledgements, ...reload, ...finalPages.slice(2)])).toBeNull();
});


test("final accepted scanner limitations survive omitted model prose and earlier page status", () => {
  // Sanitized lane shapes from the ordinary small-repository qualification.
  const finalStatus = { ...status, state: "partial", terminalState: "partial", lanes: [
    { probe: "gitleaks", state: "completed", observationCount: 0, coverage: "limited", error: null },
    { probe: "osv_scanner", state: "unavailable", observationCount: 0, coverage: "limited", error: {
      code: "probe_unavailable", retryable: false,
      message: "OSV found no supported package sources in the target. Dependency vulnerability coverage is unavailable; no dependencies were verified.",
    } },
    { probe: "trivy", state: "completed", observationCount: 0, coverage: "limited", error: null },
    { probe: "semgrep", state: "completed", observationCount: 0, coverage: "limited", error: null },
  ] };
  const appendix = securityResearchAppendix([
    ...page("first", false, { records: [record], nextCursor: "cursor_private_transport", reportReady: false }),
    ...page("last", true, { status: finalStatus }),
    new AIMessage("The scanner runs completed and found zero issues. Source review is complete."),
  ]);
  expect(appendix).not.toBeNull();
  const section = appendix!.split("### Final ledger status and scanner coverage\n\n")[1]!;
  const fenced = section.match(/^(`{3,})json\n([\s\S]*?)\n\1\n/);
  expect(fenced).not.toBeNull();
  expect(JSON.parse(fenced![2]!)).toEqual(securityScanStatusSchema.parse(finalStatus));
  expect(appendix).toContain("A scanner lane marked completed can still have limited coverage");
  expect(appendix).not.toContain("cursor_private_transport");
  expect(appendix).not.toContain("The scanner runs completed and found zero issues.");
});

test("scanner error metadata cannot terminate the dynamically fenced final status", () => {
  const errorMessage = "Unavailable rule metadata contains `````json and remains scanner data.";
  const finalStatus = { ...status, state: "partial", terminalState: "partial", lanes: [
    ...SECURITY_SCAN_INITIAL_LANES.filter((lane) => lane.probe !== "semgrep"),
    { probe: "semgrep", state: "unavailable", observationCount: 0, coverage: "limited", error: {
      code: "rules_unavailable", retryable: true, message: errorMessage,
    } },
  ] };
  const appendix = securityResearchAppendix(page("final", false, { status: finalStatus }));
  const section = appendix!.split("### Final ledger status and scanner coverage\n\n")[1]!;
  const fenced = section.match(/^(`{3,})json\n([\s\S]*?)\n\1\n/);
  expect(fenced?.[1]).toBe("``````");
  expect(JSON.parse(fenced![2]!)).toEqual(securityScanStatusSchema.parse(finalStatus));
});


test("the structured record index reconstructs complete accepted metadata and its sealed digest", () => {
  const notes = [securityScanLedgerRecordSchema.parse({ ...record,
    revision: 3, updatedAt: "2026-09-07T02:00:00.000Z",
    updatedBy: { ...author, modelId: "openai:reviewer" },
    entry: { kind: "checkpoint", summary: "Keep `````json as ordinary accepted data.",
      nextWork: "Reconcile the remaining open questions.", openRecordIds: [], evidenceRefs: [] },
  }), securityScanLedgerRecordSchema.parse({ ...record, id: "record_other" })];
  const hash = (items: typeof notes) => {
    const digest = createHash("sha256");
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      digest.update(item.id).update("\0").update(JSON.stringify(item)).update("\0");
    }
    return digest.digest("hex");
  };
  const snapshot = { sha256: hash(notes), itemCount: notes.length };
  const appendix = securityResearchAppendix(page("sealed", false, { records: notes, exportSnapshot: snapshot }));
  const section = appendix!.split("### Accepted research record index\n\n")[1]!;
  const fenced = section.match(/^(`{3,})json\n([\s\S]*?)\n\1\n/);
  expect(fenced?.[1]).toBe("``````");
  const reconstructed = JSON.parse(fenced![2]!) as typeof notes;
  expect(reconstructed).toEqual(notes);
  expect(reconstructed[0]!.entry).toMatchObject({ openRecordIds: [], evidenceRefs: [] });
  expect(hash(reconstructed)).toBe(snapshot.sha256);
  expect(appendix!.split(notes[0]!.entry.kind === "checkpoint" ? notes[0]!.entry.summary : "unused")).toHaveLength(2);
});
