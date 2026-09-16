import type { SecurityScanCodeEvidence, SecurityScanInventoryEntry, SecurityScanLedgerRecord, SecurityScanResearchProgress, SecurityScanObservation } from "@nautilo/types";
import { securityInventoryFingerprint } from "./inventory";

type ReviewUnit = SecurityScanLedgerRecord & { entry: Extract<SecurityScanLedgerRecord["entry"], { kind: "review_unit" }> };
export function reviewUnits(records: readonly SecurityScanLedgerRecord[]): ReviewUnit[] {
  return records.filter((record): record is ReviewUnit => record.entry.kind === "review_unit");
}

/** Updates retain their timestamp; persisted acceptance order breaks timestamp ties. */
export function latestResearchCheckpoint(records: readonly SecurityScanLedgerRecord[]): SecurityScanLedgerRecord | undefined {
  let latest: SecurityScanLedgerRecord | undefined;
  for (const record of records) {
    if (record.entry.kind === "checkpoint" && (!latest || record.updatedAt >= latest.updatedAt)) latest = record;
  }
  return latest;
}

/** Historical notes remain retained; references used by current conclusions must stay current. */
export function terminalEvidenceOwners(records: readonly SecurityScanLedgerRecord[]): Map<string, string> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const coverage = new Map(records.filter((record) => record.entry.kind === "coverage")
    .map((record) => [record.entry.kind === "coverage" ? record.entry.surfaceKey : "", record.id]));
  const owners = new Map<string, string>();
  function collect(record: SecurityScanLedgerRecord, owner: string, seen: Set<string>): void {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    const refs = [...record.entry.evidenceRefs, ...("counterevidenceRefs" in record.entry ? record.entry.counterevidenceRefs : [])];
    for (const ref of refs) {
      if (ref.kind === "code_evidence") owners.set(ref.id, owners.get(ref.id) ?? owner);
      if (ref.kind === "ledger_record") {
        const linked = byId.get(ref.id);
        if (linked) collect(linked, owner, seen);
      }
    }
  }
  for (const record of records) {
    const entry = record.entry;
    if (entry.kind === "finding" || entry.kind === "dismissal"
      || entry.kind === "hypothesis" && ["supported", "rejected"].includes(entry.state)
      || entry.kind === "coverage" && coverage.get(entry.surfaceKey) === record.id && ["reviewed", "not_applicable", "limited"].includes(entry.state)
      || entry.kind === "review_unit" && ["reviewed", "not_applicable", "limited"].includes(entry.state)
      || entry.kind === "open_question" && entry.resolution) collect(record, record.id, new Set());
  }
  return owners;
}

function reviewWorkChecks(records: readonly SecurityScanLedgerRecord[], code: readonly SecurityScanCodeEvidence[], inventory: readonly SecurityScanInventoryEntry[] | null) {
  const files = new Set((inventory ?? []).filter((entry) => entry.kind === "file").map((entry) => entry.relativePath));
  const units = reviewUnits(records);

  const byId = new Map(records.map((record) => [record.id, record]));
  const inventoryByPath = new Map(inventory?.map((entry) => [entry.relativePath, entry]) ?? []);
  const codeById = new Map(code.map((entry) => [entry.id, entry]));
  const sourcePaths = (refs: SecurityScanLedgerRecord["entry"]["evidenceRefs"], seen = new Set<string>()): Set<string> => {
    const paths = new Set<string>();
    for (const ref of refs) {
      if (ref.kind === "code_evidence") {
        const source = codeById.get(ref.id);
        if (source?.sourceVersion && source.sourceVersion === inventoryByPath.get(source.relativePath)?.sourceVersion) paths.add(source.relativePath);
      } else if (ref.kind === "ledger_record" && !seen.has(ref.id)) {
        seen.add(ref.id);
        const linked = byId.get(ref.id);
        // Another completed review unit or broad map is never primary evidence for this work.
        if (linked && ["hypothesis", "evidence", "counterevidence", "finding", "dismissal"].includes(linked.entry.kind)) {
          for (const path of sourcePaths(linked.entry.evidenceRefs, seen)) paths.add(path);
        }
      }
    }
    return paths;
  };
  const isOpen = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    const linked = byId.get(id);
    if (!linked) return true;
    if (linked.entry.kind === "hypothesis") return !["supported", "rejected"].includes(linked.entry.state);
    if (linked.entry.kind === "open_question") return !linked.entry.resolution;
    if (linked.entry.kind === "review_unit") return !["reviewed", "not_applicable"].includes(linked.entry.state)
      || linked.entry.openRecordIds.some((next) => isOpen(next, new Set(seen)));
    return true;
  };
  const checkUnit = (unit: ReviewUnit): string | null => {
    const prefix = `Review unit ${unit.id} (revision ${unit.revision}): `;
    const missing = unit.entry.paths.find((path) => !files.has(path));
    if (missing) return prefix + `assigned path ${missing} is absent from the current target inventory; repair this exact unit's scope.`;
    if (!["reviewed", "not_applicable"].includes(unit.entry.state)) return prefix + `accessible review work remains (${unit.entry.state}). Continue its behavior trace and notes; a blocker does not certify completed requested scope.`;
    const open = unit.entry.openRecordIds.find((id) => isOpen(id));
    if (open) return prefix + `follow-up ${open} remains open. Resolve its evidence before completing this unit.`;
    // Assignment accounts for scope, not a requirement to read every support file.
    // The model records selection, depth, conclusions and limitations in trace/notes.
    if (unit.entry.state === "not_applicable") return null;
    const inspected = sourcePaths(unit.entry.evidenceRefs);
    if (!unit.entry.paths.some((path) => inspected.has(path))) return prefix + "cite current inspected source relevant to this unit's assigned paths; unrelated or stale evidence cannot close this behavior.";
    for (const ref of unit.entry.evidenceRefs) {
      const linked = ref.kind === "ledger_record" ? byId.get(ref.id) : undefined;
      if (linked?.entry.kind === "hypothesis" && !["supported", "rejected"].includes(linked.entry.state)) return prefix + `resolve linked hypothesis ${linked.id}.`;
    }
    return null;
  };
  const unavailable = inventory?.find((entry) => entry.kind === "unavailable");
  const scopeIssue = inventory === null
    ? "This legacy ledger has no accountable source inventory. Reopen it in a current Desktop continuation before claiming completed repository research."
    : unavailable ? `Inventory entry ${unavailable.relativePath} is unavailable: ${unavailable.reason}. Requested scope remains incomplete; preserve this actual blocker.`
    : null;
  return { scopeIssue, unitIssues: new Map(units.map((unit) => [unit.id, checkUnit(unit)])) };
}

/** Use the same completion decision for atomic record acceptance and progress. */
export function reviewUnitCompletionIssue(id: string, records: readonly SecurityScanLedgerRecord[], code: readonly SecurityScanCodeEvidence[], inventory: readonly SecurityScanInventoryEntry[] | null): string | null {
  return reviewWorkChecks(records, code, inventory).unitIssues.get(id) ?? null;
}

/** Section decisions reuse completed semantic review work when no explicit
 * coverage record exists. This is a derived view, never an authored ledger
 * record or a relaxation of inventory, source freshness or evidence closure. */
export function researchSectionCoverage(
  records: readonly SecurityScanLedgerRecord[],
  code: readonly SecurityScanCodeEvidence[],
  inventory?: readonly SecurityScanInventoryEntry[] | null,
): Map<string, Extract<SecurityScanLedgerRecord["entry"], { kind: "coverage" }>> {
  const coverage = new Map(records.flatMap((record) => record.entry.kind === "coverage"
    ? [[record.entry.surfaceKey, record.entry] as const] : []));
  const unitsBySurface = new Map<string, ReviewUnit[]>();
  for (const unit of reviewUnits(records)) {
    const scoped = unitsBySurface.get(unit.entry.surfaceKey) ?? [];
    scoped.push(unit); unitsBySurface.set(unit.entry.surfaceKey, scoped);
  }
  const checks = inventory == null ? null : reviewWorkChecks(records, code, inventory);
  const unitsById = new Map(reviewUnits(records).map((unit) => [unit.id, unit]));
  // A model may relate an original section to differently named behavior
  // units through ordinary coverage evidenceRefs. Prose is not a linkage.
  // Preserve explicit unfinished decisions and recheck linked source versions.
  for (const [surfaceKey, section] of coverage) {
    if (!["reviewed", "not_applicable"].includes(section.state)) continue;
    const linked = section.evidenceRefs.flatMap((ref) => {
      const unit = ref.kind === "ledger_record" ? unitsById.get(ref.id) : undefined;
      return unit ? [unit] : [];
    });
    if (linked.length && (checks === null || linked.some((unit) => checks.unitIssues.get(unit.id) !== null))) {
      coverage.set(surfaceKey, { ...section, state: "in_progress", rationale: "A linked review unit requires current source evidence or resolution of its outstanding work." });
    }
  }
  for (const [surfaceKey, units] of unitsBySurface) {
    if (coverage.has(surfaceKey)) continue; // Existing explicit decisions remain authoritative.
    const complete = checks !== null && units.every((unit) => checks.unitIssues.get(unit.id) === null);
    const state = !complete ? "in_progress" : units.every((unit) => unit.entry.state === "not_applicable") ? "not_applicable" : "reviewed";
    const refs = new Map(units.flatMap((unit) => unit.entry.evidenceRefs).map((ref) => [`${ref.kind}:${ref.id}`, ref]));
    coverage.set(surfaceKey, { kind: "coverage", surfaceKey, state, evidenceRefs: [...refs.values()],
      rationale: complete ? `Derived from ${units.length} completed review unit(s) with documented scope decisions, relevant current evidence and resolved follow-ups. Completion does not mean every assigned file was read.`
        : "Assigned review units still require source-backed investigation or current inventory verification.",
    });
  }
  return coverage;
}

/** Close the model-authored review plan. Inventory membership alone creates no review obligation. */
export function unfinishedReviewWork(records: readonly SecurityScanLedgerRecord[], code: readonly SecurityScanCodeEvidence[], inventory: readonly SecurityScanInventoryEntry[] | null): string | null {
  const checks = reviewWorkChecks(records, code, inventory);
  return checks.scopeIssue ?? [...checks.unitIssues.values()].find((issue) => issue !== null) ?? null;
}

export function researchProgress(records: readonly SecurityScanLedgerRecord[], code: readonly SecurityScanCodeEvidence[], inventory: readonly SecurityScanInventoryEntry[] | null, coverageTotal: number, hypothesesTotal: number, coverageShown: number, hypothesesShown: number): SecurityScanResearchProgress {
  const units = reviewUnits(records);
  const files = inventory?.filter((entry) => entry.kind === "file") ?? [];
  const assigned = new Set(units.flatMap((unit) => unit.entry.paths));
  const filesAssigned = files.filter((entry) => assigned.has(entry.relativePath)).length;
  const checks = reviewWorkChecks(records, code, inventory);
  const completed = [...checks.unitIssues.values()].filter((issue) => issue === null).length;
  const latest = latestResearchCheckpoint(records);
  return {
    inventoryState: inventory === null ? "legacy" : "complete",
    inventoryFingerprint: inventory === null ? null : securityInventoryFingerprint(inventory),
    filesTotal: files.length, filesAssigned, filesUnassigned: files.length - filesAssigned,
    unitsTotal: units.length, unitsCompleted: completed, unitsPending: units.length - completed,
    excludedEntriesTotal: (inventory?.filter((entry) => entry.kind === "excluded").length ?? 0)
      + new Set(units.filter((unit) => unit.entry.state === "not_applicable").flatMap((unit) => unit.entry.paths)
        .filter((path) => !units.some((unit) => unit.entry.state !== "not_applicable" && unit.entry.paths.includes(path)))).size,
    unavailableEntriesTotal: inventory?.filter((entry) => entry.kind === "unavailable").length ?? 0,
    coverageTotal, hypothesesTotal,
    coverageOmitted: coverageTotal - coverageShown, hypothesesOmitted: hypothesesTotal - hypothesesShown,
    latestCheckpoint: latest?.entry.kind === "checkpoint" ? { id: latest.id, summary: latest.entry.summary, nextWork: latest.entry.nextWork, openRecordIds: latest.entry.openRecordIds } : null,
  };
}

/** Every retained scanner member needs an exact disposition; grouping by prose is not coverage. */
export function unfinishedScannerTriage(records: readonly SecurityScanLedgerRecord[], observations: readonly SecurityScanObservation[]): string | null {
  const byId = new Map(records.map((record) => [record.id, record]));
  const disposed = new Set<string>();
  function collect(refs: SecurityScanLedgerRecord["entry"]["evidenceRefs"], seen: Set<string>): void {
    for (const ref of refs) {
      if (ref.kind === "scanner_observation") disposed.add(ref.id);
      if (ref.kind !== "ledger_record" || seen.has(ref.id)) continue;
      seen.add(ref.id);
      const linked = byId.get(ref.id);
      if (linked && ["evidence", "counterevidence", "hypothesis", "finding", "dismissal"].includes(linked.entry.kind)) collect(linked.entry.evidenceRefs, seen);
    }
  }
  for (const record of records) {
    if (record.entry.kind === "finding" || record.entry.kind === "dismissal"
      || record.entry.kind === "hypothesis" && ["supported", "rejected"].includes(record.entry.state)) {
      collect(record.entry.evidenceRefs, new Set([record.id]));
    }
  }
  const pending = observations.find((observation) => !disposed.has(observation.id));
  return pending ? `Scanner observation ${pending.id} has no exact recorded disposition. Check saved findings, dismissals and resolved hypotheses first. If an existing conclusion establishes the disposition, update that record with the missing observation references, retaining its prior links; repair all applicable missing member links together. Investigate only a specific observation whose disposition is not established by saved evidence. Closed source work stays closed; a family-level summary alone does not identify the disposed members.` : null;
}
