import type {
  DurableModelExposureDependency,
  DurableRecordEnvelope,
} from "@nautilo/reflection/durable";
import type { OrganizerEvidenceBudget } from "@nautilo/reflection";

/** Exact producer evidence; a current audience alone cannot authenticate authorship. */
export type MemorySourceDerivation = Readonly<{
  status: "current";
  audienceHumanIds: readonly string[];
  includesPublicBoundary: boolean;
}> & (
  | Readonly<{ kind: "human"; authorHumanId: string }>
  | Readonly<{ kind: "derived"; modelExposureDependencies: readonly DurableModelExposureDependency[] }>
  | Readonly<{ kind: "unknown" }>
);

export interface PersonalMemoryEvidencePort {
  /** Selected representation only; protected callers supply already authorized opens. */
  readRecord(dependency: Extract<DurableModelExposureDependency, { kind: "record" }>): Promise<DurableRecordEnvelope | null>;
  /** Must validate exact revision/fingerprint and current content/grant authority. */
  readSource(dependency: Extract<DurableModelExposureDependency, { kind: "source" }>): Promise<MemorySourceDerivation | null>;
  readAudience(terminalAuthorityLeafHandle: string): Promise<Readonly<{
    humanIds: readonly string[];
    includesPublicBoundary: boolean;
  }> | null>;
}

export type PersonalMemoryEvidence =
  | Readonly<{ kind: "human"; humanUserId: string }>
  | Readonly<{ kind: "service"; reason: "incomplete" | "mixed" | "shared" }>;

export class PersonalMemoryEvidenceChangedError extends Error {
  constructor() { super("Memory input evidence or current authority changed"); }
}

/**
 * Eligibility for one actual Memory prompt. Follow complete model exposure as
 * well as semantic support/children; never infer ancestry from a Room or owner.
 * Re-running this proof before a later call/publication must match admission.
 */
export async function classifyPersonalMemoryEvidence(input: Readonly<{
  dependencies: readonly DurableModelExposureDependency[] | undefined;
  ports: PersonalMemoryEvidencePort;
  budget: OrganizerEvidenceBudget;
}>): Promise<PersonalMemoryEvidence> {
  if (![input.budget.maxVisitedRecords, input.budget.maxTraversalWork].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError("Memory evidence budget must use nonnegative safe integers");
  }
  if (input.dependencies === undefined || input.dependencies.length === 0) return { kind: "service", reason: "incomplete" };
  const seen = new Set<string>();
  const visiting = new Set<string>();
  let work = 0;
  let records = 0;
  let human: string | undefined;
  let reason: "incomplete" | "mixed" | "shared" | undefined;
  const mergeAudience = (ids: readonly string[], publicBoundary: boolean): void => {
    const exact = [...new Set(ids)];
    if (publicBoundary || exact.length !== 1) { reason ??= "shared"; return; }
    if (human && human !== exact[0]) reason ??= "mixed";
    human ??= exact[0];
  };
  const visit = async (dependency: DurableModelExposureDependency): Promise<void> => {
    if (++work > input.budget.maxTraversalWork) { reason ??= "incomplete"; return; }
    const key = JSON.stringify(dependency);
    if (visiting.has(key)) { reason ??= "incomplete"; return; }
    if (seen.has(key)) return;
    visiting.add(key);
    try {
      if (dependency.kind === "source") {
        if (!dependency.observedRevision || !dependency.observedContentFingerprint) {
          reason ??= "incomplete"; return;
        }
        const source = await input.ports.readSource(dependency);
        if (!source) throw new PersonalMemoryEvidenceChangedError();
        mergeAudience(source.audienceHumanIds, source.includesPublicBoundary);
        if (source.kind === "unknown") reason ??= "incomplete";
        else if (source.kind === "human") {
          if (!source.authorHumanId || source.audienceHumanIds.some((id) => id !== source.authorHumanId)) reason ??= "shared";
          else if (human && human !== source.authorHumanId) reason ??= "mixed";
          else human = source.authorHumanId;
        } else if (source.modelExposureDependencies.length === 0) reason ??= "incomplete";
        else for (const child of source.modelExposureDependencies) await visit(child);
      } else {
        if (++records > input.budget.maxVisitedRecords) { reason ??= "incomplete"; return; }
        const record = await input.ports.readRecord(dependency);
        if (!record || record.recordRef !== dependency.recordRef
          || record.processingGeneration !== dependency.observedProcessingGeneration
          || record.lifecycle !== "current"
          || JSON.stringify([...record.semantic.terminalAuthorityLeafHandles].sort())
            !== JSON.stringify([...dependency.terminalAuthorityLeafHandles].sort())) throw new PersonalMemoryEvidenceChangedError();
        for (const leaf of record.semantic.terminalAuthorityLeafHandles) {
          const audience = await input.ports.readAudience(leaf);
          if (!audience) throw new PersonalMemoryEvidenceChangedError();
          mergeAudience(audience.humanIds, audience.includesPublicBoundary);
        }
        const exposure = record.semantic.modelExposureDependencies;
        if (record.semantic.posture === "derived" && exposure === undefined) reason ??= "incomplete";
        for (const child of exposure ?? []) await visit(child);
        if (record.semantic.sourceDependencies.length === 0 && record.semantic.childRecordRefs.length === 0
          && (exposure === undefined || exposure.length === 0)) reason ??= "incomplete";
        for (const source of record.semantic.sourceDependencies) {
          if (!source.authorityBearing) { reason ??= "incomplete"; continue; }
          await visit({
          kind: "source", sourceKind: source.sourceKind, logicalSourceRef: source.logicalSourceRef,
          ...(source.observedRevision === undefined ? {} : { observedRevision: source.observedRevision }),
          ...(source.observedContentFingerprint === undefined ? {} : { observedContentFingerprint: source.observedContentFingerprint }),
          terminalAuthorityLeafHandle: source.terminalAuthorityLeafHandle,
        });
        }
        // Child generations must occur in the exact exposure plan. A hierarchy
        // edge by itself has no immutable generation or complete disclosure proof.
        for (const child of record.semantic.childRecordRefs) {
          if (!exposure?.some((value) => value.kind === "record" && value.recordRef === child)) reason ??= "incomplete";
        }
      }
      seen.add(key);
    } finally { visiting.delete(key); }
  };
  for (const dependency of input.dependencies) await visit(dependency);
  return reason || !human ? { kind: "service", reason: reason ?? "incomplete" }
    : { kind: "human", humanUserId: human };
}

/** Once admitted, changed proof blocks work rather than choosing a new payer. */
export function assertSamePersonalMemoryEvidence(admitted: PersonalMemoryEvidence, current: PersonalMemoryEvidence): void {
  if (admitted.kind === "human" && (current.kind !== "human" || current.humanUserId !== admitted.humanUserId)) {
    throw new PersonalMemoryEvidenceChangedError();
  }
}
