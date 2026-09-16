import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { isDeepStrictEqual } from "node:util";
import { securityScanHypothesisStatusPreview, securityScanToolResultSchema, type SecurityScanCodeEvidence, type SecurityScanLedgerRecord, type SecurityScanStatus, type SecurityScanResearchProgress } from "@nautilo/types";
import type { NautiloState } from "../../agent/state";

type SavedState = Pick<NautiloState, "messages" | "currentTaskId" | "currentTaskRunId">;
export function pairedResearchReceipts(messages: readonly BaseMessage[], options: { includeErrors?: boolean } = {}) {
  const calls = new Map<string, { index: number; name: string; args: Record<string, unknown> } | null>();
  const results: Array<{ index: number; callIndex: number; args: Record<string, unknown>; value: unknown }> = [];
  for (const [index, message] of messages.entries()) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.id) calls.set(call.id, calls.has(call.id) ? null : { index, name: call.name, args: call.args });
    } else if (ToolMessage.isInstance(message)) {
      const call = calls.get(message.tool_call_id);
      calls.delete(message.tool_call_id);
      if (message.name !== "security_scan" || call?.name !== "security_scan" || typeof message.content !== "string" || (!options.includeErrors && (message.status === "error" || message.additional_kwargs["nautilo_tool_status"] === "error"))) continue;
      try { results.push({ index, callIndex: call.index, args: call.args, value: JSON.parse(message.content) }); } catch { /* Not an accepted structured receipt. */ }
    }
  }
  return results;
}
type SavedResearchRecord = { record: SecurityScanLedgerRecord; rawRecord: SecurityScanLedgerRecord; receiptIndex: number };
function progressControls(value: SecurityScanResearchProgress) {
  const { latestCheckpoint, nextResearchWork: _nextWork, ...counts } = value;
  return { ...counts, latestCheckpointId: latestCheckpoint?.id ?? null, nextResearchWorkNotPresented: true };
}
const pointer = ({ record }: SavedResearchRecord) => ({ id: record.id, revision: record.revision, kind: record.entry.kind });

/** Derive continuity only from accepted canonical receipts in this TaskRun.
 * A saved record is a locator, never proof that its claims or source were reviewed. */
export function deriveResearchSavedState(state: SavedState, throughIndex = state.messages.length - 1, historicalReceipt: (index: number) => unknown = (index) => ({ messageIndex: index })) {
  const records = new Map<string, SavedResearchRecord>();
  const evidence = new Map<string, SecurityScanCodeEvidence>();
  const rawEvidence = new Map<string, unknown>();
  const exempt = new Set<number>();
  const projections = new Map<number, unknown>();
  const inventories: Array<{ scanId: string; target: string; inventory: string; entries: unknown; receiptIndex: number }> = [];
  const coverageProseOrigins = new Map<string, number>();
  let latestStatus: { index: number; value: unknown; controls: Record<string, unknown>; progressReceiptIndex?: number; known: boolean } | undefined;
  let previousStatus: SecurityScanStatus | undefined;
  const ours = (record: SecurityScanLedgerRecord) => record.updatedBy.taskId === state.currentTaskId && record.updatedBy.taskRunId === state.currentTaskRunId;
  const save = (record: SecurityScanLedgerRecord, rawRecord: SecurityScanLedgerRecord, receiptIndex: number) => {
    if (ours(record) && (!records.has(record.id) || records.get(record.id)!.record.revision < record.revision)) records.set(record.id, { record, rawRecord, receiptIndex });
  };
  const projectStatus = (status: SecurityScanStatus, rawStatus: SecurityScanStatus, receiptIndex: number) => {
    let known = previousStatus?.scanId === status.scanId && isDeepStrictEqual(previousStatus.lanes, rawStatus.lanes)
      && previousStatus.targetFingerprint === status.targetFingerprint;
    const coverage = status.coverage.map((surface, index) => {
      const raw = rawStatus.coverage[index]!;
      // Runtime-derived coverage prose need not match an authored repository
      // map. Only a later exact raw copy may alias its first immutable receipt;
      // current coverage state remains in this receipt, and first/new prose is
      // never retroactively marked saved. No trimming or schema defaults here.
      const proseKey = JSON.stringify({ scanId: rawStatus.scanId, targetFingerprint: rawStatus.targetFingerprint,
        targetDirectory: rawStatus.targetDirectory, surfaceKey: raw.surfaceKey, label: raw.label, rationale: raw.rationale });
      const previous = coverageProseOrigins.get(proseKey);
      if (previous === undefined) coverageProseOrigins.set(proseKey, receiptIndex);
      const saved = [...records.values()].find(({ rawRecord }) => rawRecord.entry.kind === "repository_map"
        && (rawRecord.entry.surfaces ?? []).some((item) => item.key === raw.surfaceKey && item.label === raw.label && item.rationale === raw.rationale));
      if (!saved) {
        if (previous !== undefined && previous < receiptIndex) return { surfaceKey: surface.surfaceKey, state: surface.state,
          historicalProse: { exactHistoricalReceipt: historicalReceipt(previous), surfaceKey: raw.surfaceKey,
            notice: "Label and rationale exactly repeat this earlier receipt; current coverage state is retained here." } };
        known = false; return surface;
      }
      // Status state is current authority; the map's earlier coverage can differ.
      return { surfaceKey: surface.surfaceKey, state: surface.state, savedProse: pointer(saved) };
    });
    const hypotheses = status.hypotheses.map((hypothesis, index) => {
      const saved = records.get(hypothesis.id);
      if (!saved || saved.rawRecord.entry.kind !== "hypothesis"
        || securityScanHypothesisStatusPreview(saved.rawRecord.entry.summary) !== rawStatus.hypotheses[index]!.summary) { known = false; return hypothesis; }
      // Match only the producer's exact status bytes. This pointer names our
      // saved revision, not proof of the current full revision or inspection;
      // a changed tail cannot be inferred from a status preview.
      return { id: hypothesis.id, state: hypothesis.state, savedProse: pointer(saved) };
    });
    let researchProgress: unknown = status.researchProgress;
    const checkpoint = rawStatus.researchProgress?.latestCheckpoint;
    if (checkpoint) {
      const saved = records.get(checkpoint.id);
      if (saved?.rawRecord.entry.kind === "checkpoint" && saved.rawRecord.entry.summary === checkpoint.summary
        && saved.rawRecord.entry.nextWork === checkpoint.nextWork && isDeepStrictEqual(saved.rawRecord.entry.openRecordIds, checkpoint.openRecordIds)) {
        researchProgress = { ...status.researchProgress, latestCheckpoint: { id: checkpoint.id, savedProse: pointer(saved) } };
      } else known = false;
    }
    const value = { ...status, coverage, hypotheses, ...(researchProgress ? { researchProgress } : {}) };
    previousStatus = rawStatus;
    return { value, known };
  };
  for (const receipt of pairedResearchReceipts(state.messages.slice(0, throughIndex + 1))) {
    const parsed = securityScanToolResultSchema.safeParse(receipt.value);
    if (!parsed.success || !parsed.data.ok || parsed.data.operation !== receipt.args["operation"]) continue;
    const value = parsed.data;
    // Validation supplies safe defaults for access; equality uses the original
    // objects so trimming/defaults cannot turn changed input into an exact echo.
    const raw = receipt.value as typeof value;
    if (value.operation === "record") {
      if (!ours(value.result.record)) continue;
      if (raw.operation !== "record") continue;
      save(value.result.record, raw.result.record, receipt.index);
      for (const [index, item] of value.result.codeEvidence.entries()) { evidence.set(item.id, item); rawEvidence.set(item.id, raw.result.codeEvidence[index]); }
      exempt.add(receipt.index);
      if (latestStatus && value.result.researchProgress) latestStatus = { ...latestStatus,
        controls: { ...latestStatus.controls, researchProgress: progressControls(value.result.researchProgress) }, progressReceiptIndex: receipt.index };
      continue;
    }
    const status = value.operation === "results" ? value.result.status : value.result;
    if (raw.operation === "record") continue;
    const projectedStatus = projectStatus(status, raw.operation === "results" ? raw.result.status : raw.result, receipt.index);
    latestStatus = { index: receipt.index, ...(status.researchProgress ? { progressReceiptIndex: receipt.index } : {}), value: projectedStatus.value, known: projectedStatus.known,
      controls: { scanId: status.scanId, state: status.state, phase: status.phase, terminalState: status.terminalState, mode: status.mode,
        targetFingerprint: status.targetFingerprint, modelId: status.modelId, modelState: status.modelState,
        completedSteps: status.completedSteps, totalSteps: status.totalSteps,
        lanes: status.lanes.map((lane) => ({ probe: lane.probe, state: lane.state, observationCount: lane.observationCount, coverage: lane.coverage,
          error: lane.error ? { code: lane.error.code, retryable: lane.error.retryable, detailsNotPresented: true } : null })),
        ...(status.researchProgress ? { researchProgress: progressControls(status.researchProgress) } : {}),
        coverage: status.coverage.map(({ surfaceKey, state }) => ({ surfaceKey, state })), hypotheses: status.hypotheses.map(({ id, state }) => ({ id, state })),
      } };
    if (value.operation === "status") {
      projections.set(receipt.index, { savedResearchStatus: projectedStatus.value });
      if (projectedStatus.known && records.size > 0) exempt.add(receipt.index);
    }
    if (value.operation !== "results" || raw.operation !== "results") continue;
    const result = value.result;
    const researchReload = (receipt.args["category"] === "research" || receipt.args["category"] === "all")
      && receipt.args["finalize"] !== true && result.reportReady !== true && result.exportSnapshot === undefined;
    const inventoryReload = receipt.args["category"] === "inventory" && receipt.args["finalize"] !== true && result.reportReady !== true;
    if (researchReload) {
      const knownRecords = result.records.every((record, index) => ours(record) && isDeepStrictEqual(records.get(record.id)?.rawRecord, raw.result.records[index]));
      const knownEvidence = result.codeEvidence.every((item, index) => isDeepStrictEqual(rawEvidence.get(item.id), raw.result.codeEvidence[index]));
      if (knownRecords && knownEvidence && result.observations.length === 0 && (result.inventory?.length ?? 0) === 0) {
        projections.set(receipt.index, { savedResearchResults: { ...result, status: projectedStatus.value,
          records: result.records.map((record) => ({ ...pointer(records.get(record.id)!), latestRecord: { operation: "results", category: "research", recordIds: [record.id], finalize: false } })),
          // Keep provenance metadata, cursor, counts and all scanner limitations.
          notice: "Exact copies of accepted saved notes. Use the saved-record locator for the historical receipt or reload these recordIds for full latest notes; no new source inspection is implied." } });
        if (projectedStatus.known && records.size > 0) exempt.add(receipt.index);
      }
    }
    if (inventoryReload && result.status.targetFingerprint && result.status.researchProgress?.inventoryFingerprint) {
      const prior = inventories.find((item) => item.scanId === status.scanId && item.target === status.targetFingerprint
        && item.inventory === status.researchProgress!.inventoryFingerprint && isDeepStrictEqual(item.entries, raw.result.inventory));
      if (prior && result.observations.length === 0 && result.records.length === 0 && result.codeEvidence.length === 0) {
        projections.set(receipt.index, { savedResearchInventory: { ...result, status: projectedStatus.value,
          inventory: { exactHistoricalReceipt: historicalReceipt(prior.receiptIndex), entries: result.inventory?.length ?? 0 },
          notice: "Identical inventory page already exists in canonical history. This reload adds no source evidence or review coverage." } });
        if (projectedStatus.known && records.size > 0) exempt.add(receipt.index);
      } else inventories.push({ scanId: status.scanId, target: result.status.targetFingerprint, inventory: status.researchProgress!.inventoryFingerprint!, entries: raw.result.inventory, receiptIndex: receipt.index });
    }
    // Newly returned/changed records remain required input, but their accepted
    // identities are discoverable thereafter. Never use a future receipt to
    // retroactively classify a first unknown result as an old saved echo.
    for (const [index, record] of result.records.entries()) save(record, raw.result.records[index]!, receipt.index);
    if (result.records.some(ours)) for (const [index, item] of result.codeEvidence.entries()) { evidence.set(item.id, item); rawEvidence.set(item.id, raw.result.codeEvidence[index]); }
  }
  const sourcePaths = (saved: SavedResearchRecord, visiting = new Set<string>()): string[] => {
    if (visiting.has(saved.record.id)) return [];
    visiting.add(saved.record.id);
    const entry = saved.record.entry;
    const paths = new Set<string>(entry.kind === "review_unit" ? entry.paths : []);
    for (const ref of [...("evidenceRefs" in entry ? entry.evidenceRefs : []), ...("counterevidenceRefs" in entry ? entry.counterevidenceRefs : [])]) {
      if (ref.kind === "code_evidence") { const item = evidence.get(ref.id); if (item) paths.add(item.relativePath); }
      if (ref.kind === "ledger_record") { const item = records.get(ref.id); if (item) for (const path of sourcePaths(item, visiting)) paths.add(path); }
    }
    return [...paths].sort();
  };
  return { records, evidence, exempt, projections, latestStatus,
    locatorRows: [...records.values()].sort((a, b) => a.record.id.localeCompare(b.record.id)).map((saved) => ({
      ...pointer(saved), sourcePaths: sourcePaths(saved),
      ...("title" in saved.rawRecord.entry ? { title: saved.rawRecord.entry.title } : {}),
      ...("state" in saved.record.entry ? { state: saved.record.entry.state } : {}), receiptIndex: saved.receiptIndex,
    })) };
}
