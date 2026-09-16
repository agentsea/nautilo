import { unfinishedReviewWork, reviewUnits, researchSectionCoverage } from "./review-work";
import type { SecurityScanCodeEvidence, SecurityScanLedgerRecord, SecurityScanInventoryEntry } from "@nautilo/types";

/** Mechanical evidence closure, never a verdict about the quality of an LLM's reasoning. */
export function unfinishedResearch(
  records: readonly SecurityScanLedgerRecord[],
  codeEvidence: readonly SecurityScanCodeEvidence[],
  inventory?: readonly SecurityScanInventoryEntry[] | null,
): string | null {
  if (inventory !== undefined) {
    const remaining = unfinishedReviewWork(records, codeEvidence, inventory);
    if (remaining) return remaining;
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  const codeIds = new Set(codeEvidence.map((item) => item.id));
  const hasCode = (refs: SecurityScanLedgerRecord["entry"]["evidenceRefs"], seen = new Set<string>()): boolean =>
    refs.some((ref) => {
      if (ref.kind === "code_evidence") return codeIds.has(ref.id);
      if (ref.kind !== "ledger_record" || seen.has(ref.id)) return false;
      seen.add(ref.id);
      const record = byId.get(ref.id);
      return record ? hasCode(record.entry.evidenceRefs, seen) : false;
    });
  const missingHypothesisEvidence = (record: SecurityScanLedgerRecord): string | null => {
    if (record.entry.kind !== "hypothesis") return null;
    if (hasCode(record.entry.evidenceRefs)) return null;
    return `Hypothesis ${record.id} (revision ${record.revision}): evidenceRefs must link inspected source evidence. `
      + `Inspect the missing evidence, then update this exact hypothesis with recordId:${record.id}, expectedRevision:${record.revision}, entry.kind:hypothesis and the repaired reference fields. Other linked hypotheses do not repair this record.`;
  };
  const mapped = new Set(records.flatMap((record) => record.entry.kind === "repository_map"
    ? record.entry.surfaces.map((surface) => surface.key) : []));
  for (const unit of reviewUnits(records)) mapped.add(unit.entry.surfaceKey);
  if (mapped.size === 0) return "Record the requested repository sections and trust boundaries before narrowing the investigation.";
  const coverage = researchSectionCoverage(records, codeEvidence, inventory);
  for (const surfaceKey of coverage.keys()) mapped.add(surfaceKey);
  for (const surfaceKey of mapped) {
    const section = coverage.get(surfaceKey);
    const prefix = `Section ${surfaceKey}: `;
    if (!section && reviewUnits(records).some((unit) => ["reviewed", "not_applicable"].includes(unit.entry.state))) {
      return prefix + "reconcile this map section with saved work: link existing completed review units in a coverage record's evidenceRefs and explain the scope they cover. Map coverage labels and prose do not establish that link. Reuse their inspected evidence; investigate only a specific uncovered behavior, not the already completed units.";
    }
    if (!section || section.state === "unreviewed" || section.state === "in_progress") {
      return prefix + "requested research remains. Investigate its entry points, callers, authority checks and outputs; save the investigation conclusion, relevant evidence and scope decisions.";
    }
    if (section.state === "not_applicable") continue;
    if (!hasCode(section.evidenceRefs)) return prefix + "cite inspected source supporting the coverage decision; scanner observations alone do not qualify.";
    const linkedUnitIds = new Set(section.evidenceRefs.filter((ref) => ref.kind === "ledger_record").map((ref) => ref.id));
    const scopedUnits = reviewUnits(records).filter((unit) => unit.entry.surfaceKey === surfaceKey || linkedUnitIds.has(unit.id));
    if (inventory !== undefined && section.state === "reviewed" && !scopedUnits.some((unit) => unit.entry.state === "reviewed")) {
      return prefix + "complete concrete review units for this section before marking its coverage reviewed.";
    }
    const hypotheses = [...section.evidenceRefs, ...scopedUnits.flatMap((unit) => unit.entry.evidenceRefs)].flatMap((ref) => {
      const record = ref.kind === "ledger_record" ? byId.get(ref.id) : undefined;
      return record?.entry.kind === "hypothesis" ? [record] : [];
    });
    if (hypotheses.length === 0 && scopedUnits.length === 0) return prefix + "link the investigated hypothesis ledger records in the section review units or coverage evidenceRefs.";
    if (section.state === "limited" && !section.blocker?.trim()) {
      return prefix + "continue accessible work. Limited coverage requires a concrete source/dependency blocker, not a voluntary stopping point.";
    }
    for (const hypothesis of hypotheses) {
      if (hypothesis.entry.kind !== "hypothesis") continue;
      if (hypothesis.entry.state === "planned" || hypothesis.entry.state === "investigating"
        || (hypothesis.entry.state === "unresolved" && section.state !== "limited")) {
        return prefix + `finish the linked hypothesis ${hypothesis.id} (revision ${hypothesis.revision}), or record a corroborated blocker for an unresolved one.`;
      }
      const missing = missingHypothesisEvidence(hypothesis);
      if (missing) return prefix + missing;
    }
  }
  for (const record of records) {
    if (record.entry.kind !== "open_question") continue;
    if (record.entry.resolution) {
      if (!hasCode(record.entry.evidenceRefs)) return `Question ${record.id}: cite source supporting its resolution.`;
    } else if (![...coverage.values()].some((section) => section.state === "limited" && section.blocker?.trim()
      && section.evidenceRefs.some((ref) => ref.kind === "ledger_record" && ref.id === record.id))) {
      return `Resolve question ${record.id}, or link it from limited coverage with a concrete corroborated blocker.`;
    }
  }
  const hypotheses = records.filter((record) => record.entry.kind === "hypothesis");
  if (hypotheses.length === 0 && reviewUnits(records).length === 0) return "Save source-backed review units or investigate material hypotheses; a map and source reads alone are not completed research.";
  for (const hypothesis of hypotheses) {
    if (hypothesis.entry.kind !== "hypothesis") continue;
    if (hypothesis.entry.state === "planned" || hypothesis.entry.state === "investigating") return `Finish hypothesis ${hypothesis.id} before finalizing.`;
    const missing = missingHypothesisEvidence(hypothesis);
    if (missing) return missing;
    if (hypothesis.entry.kind === "hypothesis" && hypothesis.entry.state === "unresolved"
      && ![...coverage.values()].some((section) => section.state === "limited" && section.blocker?.trim()
        && section.evidenceRefs.some((ref) => ref.kind === "ledger_record" && ref.id === hypothesis.id))) {
      return `Resolve hypothesis ${hypothesis.id}, or link it from limited coverage with a concrete corroborated blocker.`;
    }
  }
  return null;
}
