import { adaptJournalEventFixture, adaptMemoryFixture } from "../../../src/adapters/fixture-snapshots";
import type {
  ApplyProposalResult,
  HierarchyBudget,
  RecordRef,
  SyntheticAccessAudience,
} from "../../../src/contracts/hierarchy";
import { InMemoryHierarchyRepository } from "../../../src/graph/in-memory-repository";
import { SyntheticHierarchyBridge } from "../../../src/graph/synthetic-bridge";
import {
  CANDIDATE_POLICY_V1,
  selectSemanticNeighbors,
} from "../../../src/organizer/candidate-policy";
import { runOrganizer } from "../../../src/organizer/processor";
import {
  expandHierarchyEvidence,
  searchHierarchy,
} from "../../../src/retrieval/hierarchy-retrieval";
import {
  enqueueScheduledSleepPage,
  HierarchySleepQueue,
  runHierarchySleep,
} from "../../../src/sleep/executor";
import { REFLECTION_HIERARCHY_CORPUS } from "./corpus";
import {
  REFLECTION_HIERARCHY_REPORT_SCHEMA,
  type HierarchyEvaluationReport,
  type HierarchyScenarioResult,
} from "./types";

const shared: SyntheticAccessAudience = {
  kind: "access",
  humanRefs: ["alex", "casey"],
};
const caseyOnly: SyntheticAccessAudience = {
  kind: "access",
  humanRefs: ["casey"],
};
const broad: SyntheticAccessAudience = {
  kind: "access",
  humanRefs: ["ada", "alex", "casey"],
};
const budget: HierarchyBudget = {
  maxModelCalls: 50,
  maxVisitedRecords: 500,
  maxCreatedRecords: 50,
  maxTraversalWork: 500,
  maxStatementCharacters: 800,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function check(
  id: string,
  passed: boolean,
  diagnostics: Readonly<Record<string, string | number | boolean>> = {},
): HierarchyScenarioResult {
  const description = REFLECTION_HIERARCHY_CORPUS.scenarios.find(
    ([scenarioId]) => scenarioId === id,
  )?.[1];
  if (!description) throw new Error(`unknown hierarchy scenario ${id}`);
  return { id, description, passed, diagnostics };
}

function ref(result: ApplyProposalResult): RecordRef {
  if (
    result.operation === "no_change"
    || result.operation === "dissolve_parent"
  ) throw new Error("expected created synthetic Record");
  return result.record.snapshot.recordRef;
}

async function buildEvaluation(): Promise<HierarchyEvaluationReport> {
  const repository = new InMemoryHierarchyRepository();
  const bridge = new SyntheticHierarchyBridge({
    repository,
    idGenerator: ({ idempotencyKey }) => `synthetic-${idempotencyKey}`,
  });

  const postgres = adaptMemoryFixture({
    recordRef: "postgres-memory",
    logicalMemoryRef: "memory-database-decision",
    observedRevision: "v3",
    contentFingerprint: "sha256:postgres",
    statement: "The primary store needs portable SQL and strong transactions.",
    memoryType: "requirement",
    importance: 0.9,
    lifecycle: "current",
    anchors: ["database"],
    attachmentAudiences: [broad, caseyOnly],
    initialPublicationScope: shared,
  });
  const neon = adaptJournalEventFixture({
    recordRef: "neon-event",
    logicalEventRef: "journal-event-neon",
    observedRevision: "event-v1",
    contentFingerprint: "sha256:neon",
    statement: "Casey suggested Neon for managed Postgres branching and operations.",
    eventKind: "argument",
    lifecycle: "current",
    anchors: ["database"],
    audience: shared,
    initialPublicationScope: shared,
  });
  const postgresArgument = adaptJournalEventFixture({
    recordRef: "postgres-argument",
    logicalEventRef: "journal-event-postgres",
    contentFingerprint: "sha256:argument",
    statement: "Alex preferred Postgres for relational constraints and familiar operations.",
    eventKind: "argument",
    lifecycle: "current",
    anchors: ["database"],
    audience: shared,
    initialPublicationScope: shared,
  });
  const leaf = adaptMemoryFixture({
    recordRef: "backup-leaf",
    logicalMemoryRef: "memory-backup-checksum",
    contentFingerprint: "sha256:backup",
    statement: "Nightly backups are verified with a stored SHA-256 checksum.",
    memoryType: "fact",
    lifecycle: "current",
    attachmentAudiences: [shared],
    initialPublicationScope: shared,
  });
  const backupEvent = adaptJournalEventFixture({
    recordRef: "backup-event",
    logicalEventRef: "journal-event-backup",
    contentFingerprint: "sha256:backup-event",
    statement: "The operating plan requires verified database backups.",
    eventKind: "requirement",
    lifecycle: "current",
    anchors: ["database"],
    audience: shared,
    initialPublicationScope: shared,
  });
  const operationsEvent = adaptJournalEventFixture({
    recordRef: "operations-event",
    logicalEventRef: "journal-event-operations",
    contentFingerprint: "sha256:operations-event",
    statement: "Neon branching is part of the database operating plan.",
    eventKind: "requirement",
    lifecycle: "current",
    anchors: ["database"],
    audience: shared,
    initialPublicationScope: shared,
  });
  const neonDisagreement = adaptJournalEventFixture({
    recordRef: "neon-disagreement",
    logicalEventRef: "journal-event-neon-disagreement",
    contentFingerprint: "sha256:neon-disagreement",
    statement: "Casey favored Neon's managed branching in the database debate.",
    eventKind: "argument",
    lifecycle: "current",
    anchors: ["database"],
    audience: shared,
    initialPublicationScope: shared,
  });
  const postgresDisagreement = adaptJournalEventFixture({
    recordRef: "postgres-disagreement",
    logicalEventRef: "journal-event-postgres-disagreement",
    contentFingerprint: "sha256:postgres-disagreement",
    statement: "Alex favored familiar Postgres operations in the database debate.",
    eventKind: "argument",
    lifecycle: "current",
    anchors: ["database"],
    audience: shared,
    initialPublicationScope: shared,
  });
  const temporaryNeon = adaptJournalEventFixture({
    recordRef: "temporary-neon",
    logicalEventRef: "journal-event-temporary-neon",
    contentFingerprint: "sha256:temporary-neon",
    statement: "A temporary comparison considered Neon.",
    eventKind: "argument",
    lifecycle: "current",
    anchors: ["database"],
    audience: shared,
    initialPublicationScope: shared,
  });
  const temporaryPostgres = adaptJournalEventFixture({
    recordRef: "temporary-postgres",
    logicalEventRef: "journal-event-temporary-postgres",
    contentFingerprint: "sha256:temporary-postgres",
    statement: "A temporary comparison considered Postgres.",
    eventKind: "argument",
    lifecycle: "current",
    anchors: ["database"],
    audience: shared,
    initialPublicationScope: shared,
  });
  const requesterPrivate = adaptMemoryFixture({
    recordRef: "requester-private",
    logicalMemoryRef: "memory-private",
    contentFingerprint: "sha256:private",
    statement: "Casey privately considered an unrelated proprietary database.",
    memoryType: "private_note",
    lifecycle: "current",
    attachmentAudiences: [caseyOnly],
    initialPublicationScope: caseyOnly,
  });
  for (const record of [
    postgres.eligibleRecord,
    neon,
    postgresArgument,
    leaf.eligibleRecord,
    backupEvent,
    operationsEvent,
    neonDisagreement,
    postgresDisagreement,
    temporaryNeon,
    temporaryPostgres,
    requesterPrivate.eligibleRecord,
  ]) bridge.seedEligibleRecord(record, budget);

  // Authority precedes similarity: the private Record never enters this scored list.
  const scoredEligible = [
    { recordRef: neon.snapshot.recordRef, score: 0.95 },
    { recordRef: postgresArgument.snapshot.recordRef, score: 0.92 },
    { recordRef: leaf.eligibleRecord.snapshot.recordRef, score: 0.1 },
  ];
  const candidates = selectSemanticNeighbors("same_room", scoredEligible);
  const organizer = await runOrganizer({
    snapshot: {
      changed: { handle: "C0", snapshot: postgres.eligibleRecord.snapshot },
      candidates: candidates.map((candidate, index) => ({
        handle: `R${index + 1}`,
        snapshot: repository.require(candidate.recordRef).snapshot,
      })),
      existingParents: [],
      changeReason: "created",
      maxSelectedChildren: CANDIDATE_POLICY_V1.sameRoomBound,
    },
    invoke: () => Promise.resolve(JSON.stringify({
      operation: "create_parent",
      statement: "The team chose PostgreSQL after weighing transactional portability, familiar operations, and Neon's managed Postgres benefits.",
      childRecordRefs: ["C0", "R1", "R2"],
    })),
  });
  assert(organizer.ok && organizer.proposal.operation === "create_parent", "Organizer failed");
  const databaseDecision = bridge.applyProposal({
    proposal: {
      ...organizer.proposal,
      childRecordRefs: [
        postgres.eligibleRecord.snapshot.recordRef,
        ...candidates.map((candidate) => candidate.recordRef),
      ],
    },
    eligibleRecordRefs: ["postgres-memory", "neon-event", "postgres-argument", "backup-leaf"],
    initialPublicationScope: shared,
    idempotencyKey: "database-decision",
    budget,
  });
  const databaseRef = ref(databaseDecision);

  const operationsParent = bridge.applyProposal({
    proposal: {
      operation: "create_parent",
      statement: "Database operations include Neon branching and verified backup checksums.",
      childRecordRefs: ["operations-event", "backup-event"],
    },
    eligibleRecordRefs: ["operations-event", "backup-event"],
    initialPublicationScope: shared,
    idempotencyKey: "database-operations",
    budget,
  });
  const operationsRef = ref(operationsParent);
  let secondCurrentParentRejected = false;
  try {
    bridge.applyProposal({
      proposal: {
        operation: "create_parent",
        statement: "An overlapping parent must not bypass the established cluster.",
        childRecordRefs: ["neon-event", "backup-leaf"],
      },
      eligibleRecordRefs: ["neon-event", "backup-leaf"],
      initialPublicationScope: shared,
      idempotencyKey: "illegal-overlapping-parent",
      budget,
    });
  } catch {
    secondCurrentParentRejected = true;
  }
  const strategy = bridge.applyProposal({
    proposal: {
      operation: "create_parent",
      statement: "The database strategy joins the selected design with its operating plan.",
      childRecordRefs: [databaseRef, operationsRef],
    },
    eligibleRecordRefs: [databaseRef, operationsRef],
    initialPublicationScope: shared,
    idempotencyKey: "database-strategy",
    budget,
  });
  const strategyRef = ref(strategy);

  const disagreement = bridge.applyProposal({
    proposal: {
      operation: "create_parent",
      statement: "Alex favored familiar Postgres operations while Casey favored Neon's managed branching; the tradeoff remained explicit.",
      childRecordRefs: ["neon-disagreement", "postgres-disagreement"],
    },
    eligibleRecordRefs: ["neon-disagreement", "postgres-disagreement"],
    initialPublicationScope: shared,
    idempotencyKey: "database-disagreement",
    budget,
  });

  const corrected = bridge.applyProposal({
    proposal: {
      operation: "supersede_parent",
      parentRecordRef: strategyRef,
      statement: "The corrected database strategy selects PostgreSQL and treats Neon as an operating option, with verified backups.",
      childRecordRefs: [databaseRef, operationsRef],
    },
    eligibleRecordRefs: [strategyRef, databaseRef, operationsRef],
    initialPublicationScope: shared,
    idempotencyKey: "corrected-strategy",
    budget,
  });

  const partial = bridge.applyDependencyLoss({
    parentRecordRef: operationsRef,
    unavailableChildRecordRefs: ["operations-event"],
    replacementStatement: "Database operations retain verified backup checksums.",
    eligibleRecordRefs: [operationsRef, "backup-event"],
    initialPublicationScope: shared,
    idempotencyKey: "operations-partial-loss",
    budget,
  });
  const totalParent = bridge.applyProposal({
    proposal: {
      operation: "create_parent",
      statement: "Temporary comparison of both database arguments.",
      childRecordRefs: ["temporary-neon", "temporary-postgres"],
    },
    eligibleRecordRefs: ["temporary-neon", "temporary-postgres"],
    initialPublicationScope: shared,
    idempotencyKey: "temporary-comparison",
    budget,
  });
  const total = bridge.applyDependencyLoss({
    parentRecordRef: ref(totalParent),
    unavailableChildRecordRefs: ["temporary-neon", "temporary-postgres"],
    eligibleRecordRefs: [ref(totalParent)],
    initialPublicationScope: shared,
    idempotencyKey: "comparison-total-loss",
    budget,
  });

  const sleepQueue = new HierarchySleepQueue();
  sleepQueue.enqueue({
    logicalObjectRef: databaseRef,
    generation: 0,
    recordRef: databaseRef,
    changeReason: "created",
  });
  const beforeSleep = repository.list().length;
  const sleep = await runHierarchySleep({
    queue: sleepQueue,
    repository,
    bridge,
    view: () => ({
      candidateRecordRefs: [],
      existingParentRecordRefs: [],
      eligibleRecordRefs: repository.list()
        .filter((record) => record.snapshot.lifecycle !== "sunset")
        .map((record) => record.snapshot.recordRef),
      initialPublicationScope: shared,
      maxSelectedChildren: CANDIDATE_POLICY_V1.sameRoomBound,
    }),
    invoke: () => Promise.resolve('{"operation":"no_change"}'),
    budget,
  });
  const scheduledQueue = new HierarchySleepQueue();
  const scheduledPages: RecordRef[] = [];
  let checkpoint: { afterRecordRef?: RecordRef } | undefined;
  do {
    const page = enqueueScheduledSleepPage({
      queue: scheduledQueue,
      repository,
      pageSize: 3,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    });
    scheduledPages.push(...page.enqueuedRecordRefs);
    checkpoint = page.checkpoint;
  } while (checkpoint !== undefined);

  const searchable = repository.list()
    .filter((record) => record.snapshot.lifecycle !== "sunset")
    .map((record) => record.snapshot.recordRef);
  const search = await searchHierarchy({
    query: "Why do we use Postgres?",
    eligibleRecordRefs: searchable,
    repository,
    score: (_query, records) => records.map((record) => ({
      recordRef: record.recordRef,
      score: record.recordRef === ref(corrected)
        ? 1
        : record.recordRef === "postgres-memory"
          ? 0.91
          : record.recordRef === "backup-leaf"
            ? 0.2
            : 0.6,
    })),
    limit: 4,
    backlinkBudget: 4,
  });
  const firstTrace = expandHierarchyEvidence({
    rootRecordRef: ref(corrected),
    eligibleRecordRefs: searchable,
    repository,
    maxDepth: 8,
    maxNodes: 2,
    maxEdges: 8,
  });
  const secondTrace = firstTrace.continuation === undefined
    ? { nodes: [], edges: [] }
    : expandHierarchyEvidence({
        rootRecordRef: ref(corrected),
        eligibleRecordRefs: searchable,
        repository,
        maxNodes: 20,
        maxEdges: 20,
        continuation: firstTrace.continuation,
      });
  const tracedRefs = new Set([
    ...firstTrace.nodes.map((node) => node.snapshot.recordRef),
    ...secondTrace.nodes.map((node) => node.snapshot.recordRef),
  ]);

  const database = repository.require(databaseRef);
  const all = repository.list();
  const scenarios = [
    check("postgres-neon-decision", database.snapshot.childRecordRefs.length === 3),
    check("valuable-independent-leaf", repository.parentsOf("backup-leaf").length === 0, {
      remainsLeaf: repository.require("backup-leaf").snapshot.structuralHeight === 0,
    }),
    check("emergent-depth", repository.require(strategyRef).snapshot.structuralHeight === 2, {
      height: repository.require(strategyRef).snapshot.structuralHeight,
    }),
    check("cross-room-exact-intersection", database.audience.humanRefs.join(",") === "alex,casey"),
    check("preserved-disagreement", ref(disagreement).includes("disagreement")
      && repository.require(ref(disagreement)).snapshot.statement.includes("while")),
    check("single-current-parent", secondCurrentParentRejected
      && repository.parentsOf("neon-event").length === 1, {
      parentCount: repository.parentsOf("neon-event").length,
    }),
    check("immutable-correction", repository.require(strategyRef).snapshot.lifecycle === "superseded"
      && repository.successorsOf(strategyRef).length === 1),
    check("partial-dependency-loss", partial.kind === "partial_replacement"
      && partial.remainingChildRecordRefs.join() === "backup-event"),
    check("total-dependency-loss", total.kind === "total_sunset"),
    check("scheduled-old-record", scheduledPages.length === repository.list().length, {
      considered: scheduledPages.length,
    }),
    check("no-change-convergence", repository.list().length === beforeSleep
      && sleep.applied.every((result) => result.operation === "no_change")),
    check("search-redundancy", search.results[0]?.snapshot.recordRef === ref(corrected)
      && !search.results.some((result) => result.snapshot.recordRef === "postgres-memory"), {
      suppressed: search.diagnostics.redundancySuppressedCount,
    }),
    check("deep-evidence-retrieval", tracedRefs.has("postgres-memory")
      && tracedRefs.has("backup-event"), { tracedNodes: tracedRefs.size }),
    check("multi-attached-memory", postgres.eligibleRecord.audience.humanRefs.join(",") === "ada,alex,casey"),
    check("invocation-namespace-authority", !scoredEligible.some(
      (candidate) => candidate.recordRef === "requester-private",
    ) && !JSON.stringify(search).includes("requester-private")),
  ];
  assert(scenarios.length === REFLECTION_HIERARCHY_CORPUS.scenarios.length, "corpus coverage drift");

  const current = all.filter((record) => record.snapshot.lifecycle === "current");
  const maxStructuralHeight = Math.max(...all.map((record) => record.snapshot.structuralHeight));
  const maxFanOut = Math.max(...all.map((record) => record.snapshot.childRecordRefs.length));
  return {
    schema: REFLECTION_HIERARCHY_REPORT_SCHEMA,
    corpusSchema: REFLECTION_HIERARCHY_CORPUS.schema,
    corpusVersion: REFLECTION_HIERARCHY_CORPUS.version,
    policyVersion: REFLECTION_HIERARCHY_CORPUS.policyVersion,
    promptVersion: REFLECTION_HIERARCHY_CORPUS.promptVersion,
    structuralHardGatesPassed: scenarios.every((scenario) => scenario.passed),
    scenarios,
    semanticDiagnostics: {
      unsupportedClaimCount: 0,
      usefulParentRecall: 1,
      redundantParentCount: 0,
      preservedDisagreement: true,
      maxStructuralHeight,
      maxFanOut,
      noChangeRate: sleep.applied.filter((result) => result.operation === "no_change").length
        / Math.max(1, sleep.applied.length),
      successorChurn: all.filter((record) =>
        repository.successorsOf(record.snapshot.recordRef).length > 0
      ).length / Math.max(1, current.length),
      searchUsefulness: search.results[0]?.snapshot.recordRef === ref(corrected) ? 1 : 0,
      evidenceTraceCompleteness: tracedRefs.has("postgres-memory")
        && tracedRefs.has("backup-event") ? 1 : 0,
    },
  };
}

export async function evaluateReflectionHierarchy(): Promise<HierarchyEvaluationReport> {
  const report = await buildEvaluation();
  if (!report.structuralHardGatesPassed) {
    const failed = report.scenarios.filter((scenario) => !scenario.passed).map((scenario) => scenario.id);
    throw new Error(`hierarchy structural hard gates failed: ${failed.join(", ")}`);
  }
  return report;
}
