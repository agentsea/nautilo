import { z } from "zod";
import {
  invocationCanUseRecord,
  recordCanEnterCandidatePool,
} from "./authority";
import {
  REFLECTION_CORPUS_SCHEMA,
  type CandidateFixture,
  type ReflectionCandidateCorpus,
  type SyntheticRecord,
} from "./types";

const stableId = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9.-]*$/);
const humanIds = z.array(stableId).min(1);
const audiencePath = z.strictObject({
  namespaceId: stableId,
  domainId: stableId,
  humanIds,
  includesPublicBoundary: z.boolean(),
});
const recordSchema = z.strictObject({
  id: stableId,
  sourceKind: z.enum(["memory", "journal", "message", "parent"]),
  posture: z.enum(["authored", "derived"]),
  statement: z.string().trim().min(1).max(500),
  observedAt: z.string().min(1),
  roomAnchors: z.array(stableId).min(1),
  audiencePaths: z.array(audiencePath).min(1),
  parentIds: z.array(stableId),
  lifecycle: z.enum([
    "current",
    "stale",
    "superseded",
    "resolved",
    "sunset",
  ]),
});
const fixtureSchema = z.strictObject({
  id: stableId,
  mode: z.enum(["same_room", "cross_room"]),
  description: z.string().trim().min(1).max(500),
  invocation: audiencePath.extend({ roomId: stableId }),
  changedRecordId: stableId,
  records: z.array(recordSchema).min(2),
  semanticScores: z.record(stableId, z.number().finite().min(-1).max(1)),
  requiredCandidateIds: z.array(stableId),
  acceptableCandidateIds: z.array(stableId),
  forbiddenCandidateIds: z.array(stableId),
});
const corpusSchema = z.strictObject({
  schema: z.literal(REFLECTION_CORPUS_SCHEMA),
  version: z.string().trim().min(1).max(80),
  policyVersion: z.string().trim().min(1).max(80),
  boundGrid: z.array(z.number().int().positive()).min(1).max(8),
  baselineBound: z.number().int().positive(),
  semanticMinimumScore: z.number().finite().min(-1).max(1),
  fixtures: z.array(fixtureSchema).min(12),
});

export class ReflectionCorpusValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Reflection candidate corpus is invalid: ${issues.join("; ")}`);
    this.name = "ReflectionCorpusValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort((left, right) => left.localeCompare(right));
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]!.localeCompare(value) < 0,
  );
}

function graphHasCycle(records: readonly SyntheticRecord[]): boolean {
  const parentsByRecord = new Map(
    records.map((record) => [record.id, record.parentIds] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (recordId: string): boolean => {
    if (visiting.has(recordId)) return true;
    if (visited.has(recordId)) return false;
    visiting.add(recordId);
    for (const parentId of parentsByRecord.get(recordId) ?? []) {
      if (visit(parentId)) return true;
    }
    visiting.delete(recordId);
    visited.add(recordId);
    return false;
  };
  return records.some((record) => visit(record.id));
}

function inspectFixture(
  fixture: CandidateFixture,
  domainAudiences: Map<string, string>,
  namespaceDomains: Map<string, string>,
  namespaceBoundaries: Map<string, boolean>,
): string[] {
  const issues: string[] = [];
  const recordIds = fixture.records.map((record) => record.id);
  const recordIdSet = new Set(recordIds);
  for (const duplicate of duplicates(recordIds)) {
    issues.push(`${fixture.id}: duplicate Record ${duplicate}`);
  }
  if (!recordIdSet.has(fixture.changedRecordId)) {
    issues.push(`${fixture.id}: changed Record is missing`);
  }

  const relationshipGroups = [
    ["required", fixture.requiredCandidateIds],
    ["acceptable", fixture.acceptableCandidateIds],
    ["forbidden", fixture.forbiddenCandidateIds],
  ] as const;
  const relationshipOwner = new Map<string, string>();
  for (const [label, ids] of relationshipGroups) {
    for (const duplicate of duplicates(ids)) {
      issues.push(`${fixture.id}: duplicate ${label} candidate ${duplicate}`);
    }
    for (const id of ids) {
      if (!recordIdSet.has(id)) {
        issues.push(`${fixture.id}: unknown ${label} candidate ${id}`);
      }
      if (id === fixture.changedRecordId) {
        issues.push(`${fixture.id}: changed Record cannot be ${label}`);
      }
      const previous = relationshipOwner.get(id);
      if (previous) {
        issues.push(`${fixture.id}: candidate ${id} is both ${previous} and ${label}`);
      }
      relationshipOwner.set(id, label);
    }
  }

  const scoredIds = Object.keys(fixture.semanticScores).sort((a, b) =>
    a.localeCompare(b),
  );
  const expectedScoredIds = recordIds
    .filter((id) => id !== fixture.changedRecordId)
    .sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(scoredIds) !== JSON.stringify(expectedScoredIds)) {
    issues.push(`${fixture.id}: semantic score inventory must exactly match candidates`);
  }

  for (const record of fixture.records) {
    if (!Number.isFinite(Date.parse(record.observedAt))) {
      issues.push(`${fixture.id}: invalid timestamp for ${record.id}`);
    }
    if (!isSortedUnique(record.roomAnchors)) {
      issues.push(`${fixture.id}: Room anchors must be sorted and unique for ${record.id}`);
    }
    for (const duplicate of duplicates(record.parentIds)) {
      issues.push(`${fixture.id}: ${record.id} repeats parent ${duplicate}`);
    }
    for (const parentId of record.parentIds) {
      if (!recordIdSet.has(parentId)) {
        issues.push(`${fixture.id}: ${record.id} references unknown parent ${parentId}`);
      }
      if (parentId === record.id) {
        issues.push(`${fixture.id}: ${record.id} cannot parent itself`);
      }
    }
    for (const duplicate of duplicates(
      record.audiencePaths.map((path) => path.namespaceId),
    )) {
      issues.push(`${fixture.id}: ${record.id} repeats Namespace ${duplicate}`);
    }
    for (const path of record.audiencePaths) {
      inspectAuthorityPath(
        `${fixture.id}:${record.id}`,
        path.namespaceId,
        path.domainId,
        path.humanIds,
        path.includesPublicBoundary,
        domainAudiences,
        namespaceDomains,
        namespaceBoundaries,
        issues,
      );
    }
  }
  inspectAuthorityPath(
    `${fixture.id}:invocation`,
    fixture.invocation.namespaceId,
    fixture.invocation.domainId,
    fixture.invocation.humanIds,
    fixture.invocation.includesPublicBoundary,
    domainAudiences,
    namespaceDomains,
    namespaceBoundaries,
    issues,
  );

  if (graphHasCycle(fixture.records)) {
    issues.push(`${fixture.id}: existing-parent graph contains a cycle`);
  }
  const byId = new Map(fixture.records.map((record) => [record.id, record]));
  const changed = byId.get(fixture.changedRecordId);
  if (
    changed
    && (!recordCanEnterCandidatePool(changed)
      || !invocationCanUseRecord(fixture.invocation, changed))
  ) {
    issues.push(`${fixture.id}: changed Record is ineligible for this invocation`);
  }
  for (const requiredId of fixture.requiredCandidateIds) {
    const required = byId.get(requiredId);
    if (
      required
      && (!recordCanEnterCandidatePool(required)
        || !invocationCanUseRecord(fixture.invocation, required))
    ) {
      issues.push(`${fixture.id}: required candidate ${requiredId} is ineligible`);
    }
  }
  return issues;
}

function inspectAuthorityPath(
  owner: string,
  namespaceId: string,
  domainId: string,
  humanIds: readonly string[],
  includesPublicBoundary: boolean,
  domainAudiences: Map<string, string>,
  namespaceDomains: Map<string, string>,
  namespaceBoundaries: Map<string, boolean>,
  issues: string[],
): void {
  if (!isSortedUnique(humanIds)) {
    issues.push(`${owner}: Human audience must be sorted and unique`);
  }
  const fingerprint = JSON.stringify(humanIds);
  const knownAudience = domainAudiences.get(domainId);
  if (knownAudience !== undefined && knownAudience !== fingerprint) {
    issues.push(`${owner}: Domain ${domainId} has conflicting Human audiences`);
  } else {
    domainAudiences.set(domainId, fingerprint);
  }
  const knownDomain = namespaceDomains.get(namespaceId);
  if (knownDomain !== undefined && knownDomain !== domainId) {
    issues.push(`${owner}: Namespace ${namespaceId} maps to conflicting Domains`);
  } else {
    namespaceDomains.set(namespaceId, domainId);
  }
  const knownBoundary = namespaceBoundaries.get(namespaceId);
  if (
    knownBoundary !== undefined
    && knownBoundary !== includesPublicBoundary
  ) {
    issues.push(`${owner}: Namespace ${namespaceId} has conflicting public boundaries`);
  } else {
    namespaceBoundaries.set(namespaceId, includesPublicBoundary);
  }
}

export function validateReflectionCandidateCorpus(
  input: unknown,
): ReflectionCandidateCorpus {
  const parsed = corpusSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReflectionCorpusValidationError(
      parsed.error.issues.map((issue) =>
        `${issue.path.join(".") || "corpus"}: ${issue.message}`
      ),
    );
  }
  const corpus = parsed.data as ReflectionCandidateCorpus;
  const issues: string[] = [];
  const fixtureIds = corpus.fixtures.map((fixture) => fixture.id);
  for (const duplicate of duplicates(fixtureIds)) {
    issues.push(`duplicate fixture ${duplicate}`);
  }
  const recordIds = corpus.fixtures.flatMap((fixture) =>
    fixture.records.map((record) => record.id)
  );
  for (const duplicate of duplicates(recordIds)) {
    issues.push(`duplicate corpus Record ${duplicate}`);
  }
  if (
    !corpus.boundGrid.every(
      (bound, index) => index === 0 || corpus.boundGrid[index - 1]! < bound,
    )
  ) {
    issues.push("bound grid must be sorted and unique");
  }
  if (!corpus.boundGrid.includes(corpus.baselineBound)) {
    issues.push("baseline bound must be one member of the bound grid");
  }
  const domainAudiences = new Map<string, string>();
  const namespaceDomains = new Map<string, string>();
  const namespaceBoundaries = new Map<string, boolean>();
  for (const fixture of corpus.fixtures) {
    issues.push(...inspectFixture(
      fixture,
      domainAudiences,
      namespaceDomains,
      namespaceBoundaries,
    ));
  }
  const modes = new Set(corpus.fixtures.map((fixture) => fixture.mode));
  if (!modes.has("same_room") || !modes.has("cross_room")) {
    issues.push("corpus must contain same-Room and cross-Room fixtures");
  }
  if (issues.length > 0) {
    throw new ReflectionCorpusValidationError(issues.sort());
  }
  return corpus;
}
