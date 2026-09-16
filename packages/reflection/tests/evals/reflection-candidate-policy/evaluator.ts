import {
  invocationCanUseRecord,
  recordCanEnterCandidatePool,
} from "./authority";
import { validateReflectionCandidateCorpus } from "./validation";
import {
  REFLECTION_RESULT_SCHEMA,
  type AggregateEvaluationResult,
  type BaselineId,
  type CandidateFixture,
  type CandidatePolicyId,
  type CandidateRun,
  type CandidateSemanticView,
  type EvaluationMode,
  type FixtureEvaluationResult,
  type FixtureMetrics,
  type PolicyDecision,
  type ReflectionCandidateCorpus,
  type ReflectionEvaluationReport,
  type SyntheticRecord,
} from "./types";

interface PreparedFixture {
  fixture: CandidateFixture;
  changed: CandidateSemanticView;
  eligibleRecords: readonly SyntheticRecord[];
  eligibleViews: readonly CandidateSemanticView[];
  eligibleIds: ReadonlySet<string>;
}

interface SimilarityPort {
  score(recordId: string): number;
  openedIds(): readonly string[];
}

type CandidateRunner = (
  prepared: PreparedFixture,
  bound: number,
) => CandidateRun;

const POLICY_ORDER: readonly CandidatePolicyId[] = Object.freeze([
  "semantic_neighbors",
  "existing_parent",
  "temporal_room_anchor",
]);
const BASELINE_ORDER: readonly BaselineId[] = Object.freeze([
  "memory",
  "journal_recent",
  "flat_combined",
]);
const POLICY_SIMPLICITY: Readonly<Record<CandidatePolicyId, number>> =
  Object.freeze({
    existing_parent: 0,
    temporal_room_anchor: 1,
    semantic_neighbors: 2,
  });

function compareIds(left: string, right: string): number {
  return left.localeCompare(right);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : round(values.reduce((total, value) => total + value, 0) / values.length);
}

function semanticView(
  record: SyntheticRecord,
  visibleRecordIds: ReadonlySet<string>,
): CandidateSemanticView {
  if (record.sourceKind === "message") {
    throw new TypeError("Raw Messages cannot enter Organizer candidate views");
  }
  return Object.freeze({
    id: record.id,
    sourceKind: record.sourceKind,
    observedAt: record.observedAt,
    roomAnchors: Object.freeze([...record.roomAnchors]),
    parentIds: Object.freeze(
      record.parentIds.filter((parentId) => visibleRecordIds.has(parentId)),
    ),
  });
}

function prepareFixture(fixture: CandidateFixture): PreparedFixture {
  const byId = new Map(fixture.records.map((record) => [record.id, record]));
  const changedRecord = byId.get(fixture.changedRecordId);
  if (!changedRecord || changedRecord.sourceKind === "message") {
    throw new TypeError(`${fixture.id}: invalid changed Record`);
  }
  const eligibleRecords = fixture.records
    .filter((record) => record.id !== fixture.changedRecordId)
    .filter((record) =>
      record.lifecycle === "current" || record.lifecycle === "stale"
    )
    .filter((record) => invocationCanUseRecord(fixture.invocation, record))
    .sort((left, right) => compareIds(left.id, right.id));
  const eligibleIds = new Set([
    fixture.changedRecordId,
    ...eligibleRecords.map((record) => record.id),
  ]);
  const candidateRecords = eligibleRecords.filter(recordCanEnterCandidatePool);
  return Object.freeze({
    fixture,
    changed: semanticView(changedRecord, eligibleIds),
    eligibleRecords: Object.freeze(eligibleRecords),
    eligibleViews: Object.freeze(
      candidateRecords.map((record) => semanticView(record, eligibleIds)),
    ),
    eligibleIds: new Set(eligibleRecords.map((record) => record.id)),
  });
}

function recordedSimilarityPort(fixture: CandidateFixture): SimilarityPort {
  const opened: string[] = [];
  return Object.freeze({
    score(recordId: string): number {
      const score = fixture.semanticScores[recordId];
      if (score === undefined) {
        throw new TypeError(`${fixture.id}: missing semantic score for ${recordId}`);
      }
      opened.push(recordId);
      return score;
    },
    openedIds(): readonly string[] {
      return Object.freeze([...opened]);
    },
  });
}

function selectedRun(input: {
  selected: readonly { id: string; score: number }[];
  eligiblePoolSize: number;
  consideredIds: readonly string[];
  openedSemanticIds?: readonly string[];
  scoredIds?: readonly string[];
}): CandidateRun {
  return Object.freeze({
    selectedIds: Object.freeze(input.selected.map((entry) => entry.id)),
    scores: Object.freeze(
      Object.fromEntries(input.selected.map((entry) => [entry.id, round(entry.score)])),
    ),
    trace: Object.freeze({
      eligiblePoolSize: input.eligiblePoolSize,
      consideredIds: Object.freeze([...input.consideredIds]),
      openedSemanticIds: Object.freeze([...(input.openedSemanticIds ?? [])]),
      scoredIds: Object.freeze([...(input.scoredIds ?? [])]),
    }),
  });
}

function semanticRunner(minimumScore: number): CandidateRunner {
  return (prepared, bound) => {
    const port = recordedSimilarityPort(prepared.fixture);
    const scored = prepared.eligibleViews
      .map((candidate) => ({ id: candidate.id, score: port.score(candidate.id) }))
      .filter((entry) => entry.score >= minimumScore)
      .sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
    return selectedRun({
      selected: scored.slice(0, bound),
      eligiblePoolSize: prepared.eligibleViews.length,
      consideredIds: prepared.eligibleViews.map((candidate) => candidate.id),
      openedSemanticIds: port.openedIds(),
      scoredIds: scored.map((entry) => entry.id),
    });
  };
}

function relationScore(
  changed: CandidateSemanticView,
  candidate: CandidateSemanticView,
): number {
  if (
    changed.parentIds.includes(candidate.id)
    || candidate.parentIds.includes(changed.id)
  ) return 3;
  if (candidate.parentIds.some((parentId) => changed.parentIds.includes(parentId))) {
    return 2;
  }
  return 0;
}

const existingParentRunner: CandidateRunner = (prepared, bound) => {
  const related = prepared.eligibleViews
    .map((candidate) => ({
      id: candidate.id,
      score: relationScore(prepared.changed, candidate),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
  return selectedRun({
    selected: related.slice(0, bound),
    eligiblePoolSize: prepared.eligibleViews.length,
    consideredIds: prepared.eligibleViews.map((candidate) => candidate.id),
  });
};

function sharedRoomAnchor(
  changed: CandidateSemanticView,
  candidate: CandidateSemanticView,
): boolean {
  return candidate.roomAnchors.some((anchor) => changed.roomAnchors.includes(anchor));
}

const temporalRoomAnchorRunner: CandidateRunner = (prepared, bound) => {
  const changedAt = Date.parse(prepared.changed.observedAt);
  const local = prepared.eligibleViews
    .filter((candidate) => sharedRoomAnchor(prepared.changed, candidate))
    .map((candidate) => {
      const distanceDays = Math.abs(Date.parse(candidate.observedAt) - changedAt)
        / (24 * 60 * 60 * 1_000);
      return { id: candidate.id, score: 1 / (1 + distanceDays) };
    })
    .sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
  return selectedRun({
    selected: local.slice(0, bound),
    eligiblePoolSize: prepared.eligibleViews.length,
    consideredIds: prepared.eligibleViews.map((candidate) => candidate.id),
  });
};

function memoryBaselineRunner(minimumScore: number): CandidateRunner {
  return (prepared, bound) => {
    const port = recordedSimilarityPort(prepared.fixture);
    const memories = prepared.eligibleViews
      .filter((candidate) => candidate.sourceKind === "memory")
      .map((candidate) => ({ id: candidate.id, score: port.score(candidate.id) }))
      .filter((entry) => entry.score >= minimumScore)
      .sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
    return selectedRun({
      selected: memories.slice(0, bound),
      eligiblePoolSize: memories.length,
      consideredIds: memories.map((entry) => entry.id),
      openedSemanticIds: port.openedIds(),
      scoredIds: memories.map((entry) => entry.id),
    });
  };
}

const journalRecentBaselineRunner: CandidateRunner = (prepared, bound) => {
  const roomRecords = prepared.eligibleRecords.filter((record) =>
    record.roomAnchors.includes(prepared.fixture.invocation.roomId)
  );
  const journalRecords = roomRecords
    .filter((record) => record.sourceKind === "journal")
    .sort((left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || compareIds(left.id, right.id)
    );
  // The committed baseline has no rollup fixture: every active Room-local
  // Journal Record therefore survives the current Journal/recent projection.
  // Keeping this characterization inside the offline evaluator avoids making
  // Reflection depend on Runtime's durable-entity prompt adapter.
  const projectedIds = new Set(journalRecords.map((record) => record.id));
  const records = roomRecords
    .filter((record) =>
      record.sourceKind === "message" || projectedIds.has(record.id)
    )
    .sort((left, right) =>
      Date.parse(right.observedAt) - Date.parse(left.observedAt)
      || compareIds(left.id, right.id)
    );
  return selectedRun({
    selected: records.slice(0, bound).map((record) => ({ id: record.id, score: 0 })),
    eligiblePoolSize: records.length,
    consideredIds: records.map((record) => record.id),
  });
};

function flatCombinedBaselineRunner(minimumScore: number): CandidateRunner {
  return (prepared, bound) => {
    const port = recordedSimilarityPort(prepared.fixture);
    const flat = prepared.eligibleViews
      .filter((candidate) =>
        candidate.sourceKind === "memory" || candidate.sourceKind === "journal"
      )
      .map((candidate) => ({ id: candidate.id, score: port.score(candidate.id) }))
      .filter((entry) => entry.score >= minimumScore)
      .sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
    return selectedRun({
      selected: flat.slice(0, bound),
      eligiblePoolSize: flat.length,
      consideredIds: flat.map((entry) => entry.id),
      openedSemanticIds: port.openedIds(),
      scoredIds: flat.map((entry) => entry.id),
    });
  };
}

function relationExists(changed: SyntheticRecord, candidate: SyntheticRecord): boolean {
  return changed.parentIds.includes(candidate.id)
    || candidate.parentIds.includes(changed.id)
    || candidate.parentIds.some((parentId) => changed.parentIds.includes(parentId));
}

function metricsForRun(
  fixture: CandidateFixture,
  run: CandidateRun,
  repeated: CandidateRun,
): FixtureMetrics {
  const selected = new Set(run.selectedIds);
  const required = fixture.requiredCandidateIds;
  const acceptable = new Set([
    ...fixture.requiredCandidateIds,
    ...fixture.acceptableCandidateIds,
  ]);
  const contaminationCount = run.selectedIds.filter((id) => !acceptable.has(id)).length;
  const byId = new Map(fixture.records.map((record) => [record.id, record]));
  const requiredAnchors = new Set(
    required.flatMap((id) => byId.get(id)?.roomAnchors ?? []),
  );
  const selectedRequiredAnchors = new Set(
    required
      .filter((id) => selected.has(id))
      .flatMap((id) => byId.get(id)?.roomAnchors ?? []),
  );
  const changed = byId.get(fixture.changedRecordId)!;
  const parentRelatedRequired = required.filter((id) => {
    const candidate = byId.get(id);
    return candidate ? relationExists(changed, candidate) : false;
  });
  return Object.freeze({
    usefulNeighborRecall: required.length === 0
      ? 1
      : round(required.filter((id) => selected.has(id)).length / required.length),
    contaminationRate: run.selectedIds.length === 0
      ? 0
      : round(contaminationCount / run.selectedIds.length),
    selectedCount: run.selectedIds.length,
    comparedCount: run.trace.consideredIds.length,
    anchorCoverage: requiredAnchors.size === 0
      ? 1
      : round(selectedRequiredAnchors.size / requiredAnchors.size),
    existingParentCoverage: parentRelatedRequired.length === 0
      ? 1
      : round(
        parentRelatedRequired.filter((id) => selected.has(id)).length
          / parentRelatedRequired.length,
      ),
    repeatStable: JSON.stringify(run) === JSON.stringify(repeated),
  });
}

function fixtureResult(
  prepared: PreparedFixture,
  runner: CandidateRunner,
  bound: number,
): FixtureEvaluationResult {
  const first = runner(prepared, bound);
  const second = runner(prepared, bound);
  const exposedIds = new Set([
    ...first.selectedIds,
    ...first.trace.consideredIds,
    ...first.trace.openedSemanticIds,
    ...first.trace.scoredIds,
    ...Object.keys(first.scores),
  ]);
  const authorityLeakFree = [...exposedIds].every((id) => prepared.eligibleIds.has(id));
  const forbiddenExposureFree = prepared.fixture.forbiddenCandidateIds.every(
    (id) => !exposedIds.has(id),
  );
  const requiredRelationshipsReachable = prepared.fixture.requiredCandidateIds.every(
    (id) => first.selectedIds.includes(id),
  );
  const deterministic = JSON.stringify(first) === JSON.stringify(second);
  const failures: string[] = [];
  if (!authorityLeakFree) failures.push("authority_leak");
  if (!forbiddenExposureFree) failures.push("forbidden_candidate_exposed");
  if (!requiredRelationshipsReachable) failures.push("required_relationship_unreachable");
  if (!deterministic) failures.push("nondeterministic_output");
  return Object.freeze({
    fixtureId: prepared.fixture.id,
    mode: prepared.fixture.mode,
    selectedIds: first.selectedIds,
    trace: first.trace,
    metrics: metricsForRun(prepared.fixture, first, second),
    gates: Object.freeze({
      authorityLeakFree,
      forbiddenExposureFree,
      requiredRelationshipsReachable,
      deterministic,
      passed: failures.length === 0,
      failures: Object.freeze(failures),
    }),
  });
}

function aggregateResult(input: {
  id: CandidatePolicyId | BaselineId;
  kind: "candidate_policy" | "baseline";
  mode: EvaluationMode;
  bound: number;
  fixtures: readonly CandidateFixture[];
  runner: CandidateRunner;
}): AggregateEvaluationResult {
  const fixtures = input.fixtures
    .filter((fixture) => fixture.mode === input.mode)
    .map(prepareFixture)
    .map((prepared) => fixtureResult(prepared, input.runner, input.bound));
  return Object.freeze({
    id: input.id,
    kind: input.kind,
    mode: input.mode,
    bound: input.bound,
    fixtures: Object.freeze(fixtures),
    aggregate: Object.freeze({
      hardGatesPassed: fixtures.every((fixture) => fixture.gates.passed),
      meanRecall: mean(fixtures.map((fixture) => fixture.metrics.usefulNeighborRecall)),
      meanContamination: mean(
        fixtures.map((fixture) => fixture.metrics.contaminationRate),
      ),
      totalSelected: fixtures.reduce(
        (total, fixture) => total + fixture.metrics.selectedCount,
        0,
      ),
      totalCompared: fixtures.reduce(
        (total, fixture) => total + fixture.metrics.comparedCount,
        0,
      ),
      repeatStable: fixtures.every((fixture) => fixture.metrics.repeatStable),
    }),
  });
}

function candidateRunner(
  policyId: CandidatePolicyId,
  corpus: ReflectionCandidateCorpus,
): CandidateRunner {
  switch (policyId) {
    case "semantic_neighbors":
      return semanticRunner(corpus.semanticMinimumScore);
    case "existing_parent":
      return existingParentRunner;
    case "temporal_room_anchor":
      return temporalRoomAnchorRunner;
  }
}

function baselineRunner(
  baselineId: BaselineId,
  corpus: ReflectionCandidateCorpus,
): CandidateRunner {
  switch (baselineId) {
    case "memory":
      return memoryBaselineRunner(corpus.semanticMinimumScore);
    case "journal_recent":
      return journalRecentBaselineRunner;
    case "flat_combined":
      return flatCombinedBaselineRunner(corpus.semanticMinimumScore);
  }
}

function chooseDecision(
  mode: EvaluationMode,
  results: readonly AggregateEvaluationResult[],
): PolicyDecision {
  const passing = results
    .filter((result) => result.mode === mode && result.aggregate.hardGatesPassed)
    .sort((left, right) =>
      left.aggregate.meanContamination - right.aggregate.meanContamination
      || left.aggregate.totalCompared - right.aggregate.totalCompared
      || left.bound - right.bound
      || POLICY_SIMPLICITY[left.id as CandidatePolicyId]
        - POLICY_SIMPLICITY[right.id as CandidatePolicyId]
      || left.id.localeCompare(right.id)
    );
  const selected = passing[0];
  if (!selected) {
    return Object.freeze({
      mode,
      outcome: "reject_all",
      policyId: null,
      bound: null,
      reason: "No tested policy/bound passed every authority, reachability, and determinism gate.",
    });
  }
  return Object.freeze({
    mode,
    outcome: "selected",
    policyId: selected.id as CandidatePolicyId,
    bound: selected.bound,
    reason:
      `Passed every hard gate; selected by lowest contamination, then deterministic work, `
      + `bound, and policy simplicity (mean contamination ${selected.aggregate.meanContamination}).`,
  });
}

export function evaluateReflectionCandidatePolicies(
  input: unknown,
): ReflectionEvaluationReport {
  const corpus = validateReflectionCandidateCorpus(input);
  const modes: readonly EvaluationMode[] = ["same_room", "cross_room"];
  const baselines = BASELINE_ORDER.flatMap((baselineId) =>
    modes.map((mode) =>
      aggregateResult({
        id: baselineId,
        kind: "baseline",
        mode,
        bound: corpus.baselineBound,
        fixtures: corpus.fixtures,
        runner: baselineRunner(baselineId, corpus),
      })
    )
  );
  const candidatePolicies = POLICY_ORDER.flatMap((policyId) =>
    corpus.boundGrid.flatMap((bound) =>
      modes.map((mode) =>
        aggregateResult({
          id: policyId,
          kind: "candidate_policy",
          mode,
          bound,
          fixtures: corpus.fixtures,
          runner: candidateRunner(policyId, corpus),
        })
      )
    )
  );
  return Object.freeze({
    schema: REFLECTION_RESULT_SCHEMA,
    corpusVersion: corpus.version,
    policyVersion: corpus.policyVersion,
    boundGrid: Object.freeze([...corpus.boundGrid]),
    baselineBound: corpus.baselineBound,
    semanticMinimumScore: corpus.semanticMinimumScore,
    baselines: Object.freeze(baselines),
    candidatePolicies: Object.freeze(candidatePolicies),
    decisions: Object.freeze(
      modes.map((mode) => chooseDecision(mode, candidatePolicies)),
    ),
  });
}
