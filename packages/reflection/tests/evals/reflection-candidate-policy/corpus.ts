import {
  REFLECTION_CORPUS_SCHEMA,
  type CandidateFixture,
  type EvaluationMode,
  type RecordLifecycle,
  type RecordPosture,
  type RecordSourceKind,
  type ReflectionCandidateCorpus,
  type SyntheticAudiencePath,
  type SyntheticRecord,
} from "./types";
import { CANDIDATE_POLICY_V1 } from "../../../src/organizer/candidate-policy";

const HUMANS = Object.freeze({
  alice: "human-alice",
  alex: "human-alex",
  casey: "human-casey",
});

const AUDIENCES = Object.freeze({
  alice: Object.freeze({
    domainId: "domain-alice",
    humanIds: Object.freeze([HUMANS.alice]),
  }),
  alex: Object.freeze({
    domainId: "domain-alex",
    humanIds: Object.freeze([HUMANS.alex]),
  }),
  casey: Object.freeze({
    domainId: "domain-casey",
    humanIds: Object.freeze([HUMANS.casey]),
  }),
  caseyAlice: Object.freeze({
    domainId: "domain-casey-alice",
    humanIds: Object.freeze([HUMANS.alice, HUMANS.casey]),
  }),
  caseyAlex: Object.freeze({
    domainId: "domain-casey-alex",
    humanIds: Object.freeze([HUMANS.alex, HUMANS.casey]),
  }),
  caseyAlexAlice: Object.freeze({
    domainId: "domain-casey-alex-alice",
    humanIds: Object.freeze([HUMANS.alex, HUMANS.alice, HUMANS.casey]),
  }),
});

type AudienceName = keyof typeof AUDIENCES;

interface RecordSeed {
  id: string;
  statement: string;
  score?: number;
  sourceKind?: RecordSourceKind;
  posture?: RecordPosture;
  day?: number;
  roomAnchors?: readonly string[];
  audiencePaths?: readonly SyntheticAudiencePath[];
  parentIds?: readonly string[];
  lifecycle?: RecordLifecycle;
}

interface FixtureSeed {
  id: string;
  mode?: EvaluationMode;
  description: string;
  roomId?: string;
  audience?: AudienceName;
  invocation?: {
    roomId: string;
    namespaceId: string;
    audience: AudienceName;
    includesPublicBoundary?: boolean;
  };
  changedRecordId: string;
  records: readonly RecordSeed[];
  required: readonly string[];
  acceptable?: readonly string[];
  forbidden?: readonly string[];
}

function audiencePath(
  namespaceId: string,
  audience: AudienceName,
  includesPublicBoundary = false,
): SyntheticAudiencePath {
  return Object.freeze({
    namespaceId,
    domainId: AUDIENCES[audience].domainId,
    humanIds: AUDIENCES[audience].humanIds,
    includesPublicBoundary,
  });
}

function recordId(fixtureId: string, localId: string): string {
  return `${fixtureId}.${localId}`;
}

function buildFixture(seed: FixtureSeed): CandidateFixture {
  const roomId = seed.roomId ?? `room-${seed.id}`;
  const audienceName = seed.audience ?? "caseyAlex";
  const namespaceId = `namespace-${roomId}`;
  const records: SyntheticRecord[] = seed.records.map((record) =>
    Object.freeze({
      id: recordId(seed.id, record.id),
      sourceKind: record.sourceKind ?? "journal",
      posture: record.posture ?? "derived",
      statement: record.statement,
      observedAt: new Date(Date.UTC(2026, 0, record.day ?? 10, 12)).toISOString(),
      roomAnchors: Object.freeze([...(record.roomAnchors ?? [roomId])]),
      audiencePaths: Object.freeze([
        ...(record.audiencePaths ?? [audiencePath(namespaceId, audienceName)]),
      ]),
      parentIds: Object.freeze(
        (record.parentIds ?? []).map((id) => recordId(seed.id, id)),
      ),
      lifecycle: record.lifecycle ?? "current",
    }),
  );
  const semanticScores = Object.fromEntries(
    seed.records
      .filter((record) => record.id !== seed.changedRecordId)
      .map((record) => [recordId(seed.id, record.id), record.score ?? 0]),
  );
  const invocation = seed.invocation ?? {
    roomId,
    namespaceId,
    audience: audienceName,
  };
  return Object.freeze({
    id: seed.id,
    mode: seed.mode ?? "same_room",
    description: seed.description,
    invocation: Object.freeze({
      roomId: invocation.roomId,
      ...audiencePath(
        invocation.namespaceId,
        invocation.audience,
        invocation.includesPublicBoundary,
      ),
    }),
    changedRecordId: recordId(seed.id, seed.changedRecordId),
    records: Object.freeze(records),
    semanticScores: Object.freeze(semanticScores),
    requiredCandidateIds: Object.freeze(
      seed.required.map((id) => recordId(seed.id, id)),
    ),
    acceptableCandidateIds: Object.freeze(
      (seed.acceptable ?? []).map((id) => recordId(seed.id, id)),
    ),
    forbiddenCandidateIds: Object.freeze(
      (seed.forbidden ?? []).map((id) => recordId(seed.id, id)),
    ),
  });
}

const FIXTURES: readonly CandidateFixture[] = Object.freeze([
  buildFixture({
    id: "postgres-decision",
    description: "Competing database proposals lead to a supported PostgreSQL decision.",
    changedRecordId: "decision",
    records: [
      { id: "decision", sourceKind: "parent", statement: "Use PostgreSQL for the primary application store." },
      { id: "postgres-argument", statement: "PostgreSQL preserves relational constraints and operational familiarity.", score: 0.96, parentIds: ["decision"] },
      { id: "neon-argument", statement: "Neon offers PostgreSQL compatibility with managed branching and scale-to-zero.", score: 0.94, parentIds: ["decision"] },
      { id: "requirements-memory", sourceKind: "memory", posture: "authored", statement: "The system requires transactions, vector search, and portable SQL.", score: 0.9, parentIds: ["decision"] },
      { id: "ui-colors", statement: "The settings page should use calmer neutral colors.", score: 0.12, day: 10 },
    ],
    required: ["postgres-argument", "neon-argument", "requirements-memory"],
  }),
  buildFixture({
    id: "valuable-leaf",
    description: "A precise authored Memory remains useful without a forced parent.",
    changedRecordId: "checksum-memory",
    records: [
      { id: "checksum-memory", sourceKind: "memory", posture: "authored", statement: "Nightly backups are verified with a stored SHA-256 checksum." },
      { id: "lunch", statement: "The team ordered lunch at noon.", score: 0.28 },
      { id: "theme", statement: "Dark mode uses the slate palette.", score: 0.22 },
      { id: "welcome", sourceKind: "message", statement: "Welcome to the project room.", score: 0.18 },
    ],
    required: [],
  }),
  buildFixture({
    id: "emergent-depth",
    description: "A large Room discussion exposes several coherent intermediate topics.",
    changedRecordId: "replication-strategy",
    records: [
      { id: "replication-strategy", sourceKind: "parent", statement: "The replication strategy balances recovery, latency, and cost." },
      { id: "failure-cluster", sourceKind: "parent", statement: "Recovery objectives require tested point-in-time restore and regional failover.", score: 0.95, day: 3 },
      { id: "latency-cluster", sourceKind: "parent", statement: "Interactive workloads need local reads and bounded write latency.", score: 0.91, day: 4 },
      { id: "cost-cluster", sourceKind: "parent", statement: "Replica count must fit the operating budget under normal load.", score: 0.88, day: 5 },
      { id: "close-calendar", statement: "The calendar sync ran just before this discussion.", score: 0.19, day: 10 },
      { id: "close-avatar", statement: "A new avatar was uploaded during the same hour.", score: 0.16, day: 10 },
    ],
    required: ["failure-cluster", "latency-cluster", "cost-cluster"],
  }),
  buildFixture({
    id: "disagreement",
    description: "Conflicting cost claims remain distinct while their evidence stays nearby.",
    changedRecordId: "postgres-cheaper",
    records: [
      { id: "postgres-cheaper", statement: "PostgreSQL will be cheaper for the expected steady workload." },
      { id: "cost-risk-counterclaim", statement: "Managed PostgreSQL may cost more after storage and egress are included.", score: 0.93 },
      { id: "usage-estimate", sourceKind: "memory", posture: "authored", statement: "Projected traffic is 20 million reads and 2 million writes monthly.", score: 0.89 },
      { id: "premature-consensus", statement: "Everyone already agrees that cost is settled.", score: 0.55 },
      { id: "unrelated-release", statement: "The desktop release is scheduled for Friday.", score: 0.11 },
    ],
    required: ["cost-risk-counterclaim", "usage-estimate"],
    acceptable: ["premature-consensus"],
  }),
  buildFixture({
    id: "edited-evidence",
    description: "Corrected evidence keeps the stale predecessor and current support reachable.",
    changedRecordId: "retention-30-days",
    records: [
      { id: "retention-30-days", statement: "Operational logs are retained for 30 days." },
      { id: "retention-forever", statement: "Operational logs are retained indefinitely.", score: 0.94, lifecycle: "stale", day: 2 },
      { id: "corrected-policy", sourceKind: "memory", posture: "authored", statement: "The approved retention policy specifies a 30-day window.", score: 0.92, day: 9 },
      { id: "billing-note", statement: "Monthly billing closes on the first day.", score: 0.17 },
    ],
    required: ["retention-forever", "corrected-policy"],
  }),
  buildFixture({
    id: "partial-dependency-loss",
    description: "A successor remains grounded in surviving evidence after one dependency disappears.",
    changedRecordId: "supported-successor",
    records: [
      { id: "supported-successor", sourceKind: "parent", statement: "PostgreSQL remains selected because portability and transactions are still required." },
      { id: "portability", sourceKind: "memory", posture: "authored", statement: "The deployment must remain portable across managed and self-hosted PostgreSQL.", score: 0.95 },
      { id: "transactions", statement: "The workflow requires atomic multi-row updates.", score: 0.91 },
      { id: "removed-cost-report", statement: "A deleted cost report previously supported the decision.", score: 0.99, lifecycle: "sunset" },
      { id: "voice-setting", statement: "The voice setting uses the default speaker.", score: 0.12 },
    ],
    required: ["portability", "transactions"],
    forbidden: ["removed-cost-report"],
  }),
  buildFixture({
    id: "multi-parent-reuse",
    description: "One reusable leaf participates in two legitimate existing parent neighborhoods.",
    changedRecordId: "shared-portability",
    records: [
      { id: "shared-portability", sourceKind: "memory", posture: "authored", statement: "Portable SQL is required across hosting environments.", parentIds: ["database-parent", "deployment-parent"] },
      { id: "database-parent", sourceKind: "parent", statement: "Database selection constraints.", score: 0.71 },
      { id: "deployment-parent", sourceKind: "parent", statement: "Deployment portability constraints.", score: 0.69 },
      { id: "database-sibling", statement: "PostgreSQL extensions must be available in every supported host.", score: 0.94, parentIds: ["database-parent"] },
      { id: "deployment-sibling", statement: "Backups must restore on both managed and self-hosted installations.", score: 0.92, parentIds: ["deployment-parent"] },
      { id: "unrelated-sibling", statement: "The toolbar icon changed size.", score: 0.14 },
    ],
    required: ["database-sibling", "deployment-sibling"],
    acceptable: ["database-parent", "deployment-parent"],
  }),
  buildFixture({
    id: "cross-room-intersection",
    mode: "cross_room",
    description: "Two Room arguments are jointly available only to their shared Human audience.",
    invocation: { roomId: "room-cross-intersection", namespaceId: "namespace-cross-intersection", audience: "casey" },
    changedRecordId: "decision",
    records: [
      { id: "decision", statement: "Room A proposes PostgreSQL as the primary application store.", roomAnchors: ["room-database-a"], audiencePaths: [audiencePath("namespace-database-a", "caseyAlex")] },
      { id: "room-a-argument", statement: "Room A favored PostgreSQL for operational familiarity.", score: 0.95, roomAnchors: ["room-database-a"], audiencePaths: [audiencePath("namespace-database-a", "caseyAlex")] },
      { id: "room-b-argument", statement: "Room B favored PostgreSQL compatibility with managed Neon.", score: 0.93, roomAnchors: ["room-database-b"], audiencePaths: [audiencePath("namespace-database-b", "caseyAlice")] },
      { id: "alex-private", sourceKind: "memory", posture: "authored", statement: "Alex's private unrelated database note.", score: 0.99, roomAnchors: ["room-alex-private"], audiencePaths: [audiencePath("namespace-alex-private", "alex")] },
      { id: "shared-low-signal", statement: "A shared note mentions a database in passing.", score: 0.31, roomAnchors: ["room-database-a"], audiencePaths: [audiencePath("namespace-database-a", "caseyAlex")] },
    ],
    required: ["room-a-argument", "room-b-argument"],
    forbidden: ["alex-private"],
  }),
  buildFixture({
    id: "multi-attached-leaf",
    mode: "cross_room",
    description: "Separate attachment alternatives never authorize their wider Human union.",
    invocation: { roomId: "room-all-three", namespaceId: "namespace-all-three", audience: "caseyAlexAlice" },
    changedRecordId: "portability-question",
    records: [
      { id: "portability-question", statement: "Which portability requirements are available to this three-person Room?", roomAnchors: ["room-all-three"], audiencePaths: [audiencePath("namespace-all-three", "caseyAlexAlice")] },
      { id: "multi-attached-support", sourceKind: "memory", posture: "authored", statement: "Two separate working groups require portable SQL.", score: 0.99, roomAnchors: ["room-database-a", "room-database-b"], audiencePaths: [audiencePath("namespace-database-a", "caseyAlex"), audiencePath("namespace-database-b", "caseyAlice")] },
      { id: "all-three-support", sourceKind: "memory", posture: "authored", statement: "All three participants require backups that restore without provider-specific tooling.", score: 0.94, roomAnchors: ["room-all-three"], audiencePaths: [audiencePath("namespace-all-three", "caseyAlexAlice")] },
      { id: "all-three-parent", sourceKind: "parent", statement: "Cross-group portability requirements.", score: 0.73, roomAnchors: ["room-database-a", "room-database-b"], audiencePaths: [audiencePath("namespace-all-three", "caseyAlexAlice")] },
      { id: "room-a-only", statement: "A Room A-only operational detail.", score: 0.98, roomAnchors: ["room-database-a"], audiencePaths: [audiencePath("namespace-database-a", "caseyAlex")] },
    ],
    required: ["all-three-support"],
    acceptable: ["all-three-parent"],
    forbidden: ["multi-attached-support", "room-a-only"],
  }),
  buildFixture({
    id: "invocation-not-requester",
    mode: "cross_room",
    description: "A requester's private readability cannot widen a shared Room Agent invocation.",
    invocation: { roomId: "room-casey-alex", namespaceId: "namespace-casey-alex", audience: "caseyAlex" },
    changedRecordId: "shared-question",
    records: [
      { id: "shared-question", statement: "Which deployment policy applies in this shared Room?", audiencePaths: [audiencePath("namespace-casey-alex", "caseyAlex")] },
      { id: "casey-private", sourceKind: "memory", posture: "authored", statement: "Casey privately prefers a provider that the Room has not approved.", score: 0.99, roomAnchors: ["room-casey-private"], audiencePaths: [audiencePath("namespace-casey-private", "casey")] },
      { id: "alex-private", sourceKind: "memory", posture: "authored", statement: "Alex's private deployment note.", score: 0.98, roomAnchors: ["room-alex-private"], audiencePaths: [audiencePath("namespace-alex-private", "alex")] },
      { id: "shared-policy", sourceKind: "memory", posture: "authored", statement: "The shared Room approved PostgreSQL-compatible hosting.", score: 0.72, audiencePaths: [audiencePath("namespace-casey-alex", "caseyAlex")] },
      { id: "shared-journal", statement: "The Room agreed to revisit hosting after the benchmark.", score: 0.65, audiencePaths: [audiencePath("namespace-casey-alex", "caseyAlex")] },
    ],
    required: ["shared-policy"],
    acceptable: ["shared-journal"],
    forbidden: ["casey-private", "alex-private"],
  }),
  buildFixture({
    id: "temporal-anchor-trap",
    description: "Nearby Room activity is unrelated while older records carry the useful relationship.",
    changedRecordId: "restore-decision",
    records: [
      { id: "restore-decision", sourceKind: "parent", statement: "Backups must support tested point-in-time restore.", day: 10 },
      { id: "restore-evidence", statement: "The restore drill recovered the database to a five-minute target.", score: 0.96, day: 1 },
      { id: "backup-memory", sourceKind: "memory", posture: "authored", statement: "Every release requires a successful restore drill.", score: 0.91, day: 2 },
      { id: "near-avatar", statement: "An avatar changed during the discussion.", score: 0.2, day: 10 },
      { id: "near-calendar", statement: "The calendar synchronized during the discussion.", score: 0.18, day: 10 },
      { id: "near-voice", statement: "The voice preview played during the discussion.", score: 0.16, day: 10 },
      { id: "near-theme", statement: "The theme toggled during the discussion.", score: 0.14, day: 10 },
      { id: "near-window", statement: "The desktop window was resized.", score: 0.12, day: 10 },
      { id: "near-status", statement: "A presence status changed.", score: 0.1, day: 10 },
    ],
    required: ["restore-evidence", "backup-memory"],
  }),
  buildFixture({
    id: "semantic-authority-trap",
    mode: "cross_room",
    description: "Higher semantic similarity cannot outrank invocation-Namespace authority.",
    invocation: { roomId: "room-casey-alice", namespaceId: "namespace-casey-alice", audience: "caseyAlice" },
    changedRecordId: "hosting-question",
    records: [
      { id: "hosting-question", statement: "Why is PostgreSQL the approved hosting choice here?", audiencePaths: [audiencePath("namespace-casey-alice", "caseyAlice")] },
      { id: "inaccessible-exact-match", sourceKind: "memory", posture: "authored", statement: "PostgreSQL is the approved hosting choice for Casey and Alex.", score: 0.99, roomAnchors: ["room-casey-alex"], audiencePaths: [audiencePath("namespace-casey-alex", "caseyAlex")] },
      { id: "inaccessible-private-match", sourceKind: "memory", posture: "authored", statement: "Casey's private PostgreSQL hosting analysis.", score: 0.98, roomAnchors: ["room-casey-private"], audiencePaths: [audiencePath("namespace-casey-private", "casey")] },
      { id: "lexical-decoy", statement: "The PostgreSQL logo appears in the hosting dashboard.", score: 0.86, audiencePaths: [audiencePath("namespace-casey-alice", "caseyAlice")] },
      { id: "authorized-rationale", sourceKind: "memory", posture: "authored", statement: "This Room approved PostgreSQL because it needs transactions and portable SQL.", score: 0.74, audiencePaths: [audiencePath("namespace-casey-alice", "caseyAlice")] },
    ],
    required: ["authorized-rationale"],
    forbidden: ["inaccessible-exact-match", "inaccessible-private-match"],
  }),
  buildFixture({
    id: "public-private-boundary",
    mode: "cross_room",
    description: "A public invocation cannot use a private alternative with the same Humans.",
    invocation: { roomId: "room-public-casey", namespaceId: "namespace-public-casey", audience: "casey", includesPublicBoundary: true },
    changedRecordId: "public-question",
    records: [
      { id: "public-question", statement: "Which hosting rationale is available at this public boundary?", audiencePaths: [audiencePath("namespace-public-casey", "casey", true)] },
      { id: "private-exact-match", sourceKind: "memory", posture: "authored", statement: "The private hosting rationale is an exact semantic match.", score: 0.99, roomAnchors: ["room-private-casey"], audiencePaths: [audiencePath("namespace-private-casey", "casey")] },
      { id: "public-rationale", sourceKind: "memory", posture: "authored", statement: "The public hosting rationale preserves portable SQL.", score: 0.91, audiencePaths: [audiencePath("namespace-public-casey", "casey", true)] },
      { id: "public-decoy", statement: "The public dashboard displays a database icon.", score: 0.62, audiencePaths: [audiencePath("namespace-public-casey", "casey", true)] },
    ],
    required: ["public-rationale"],
    acceptable: ["public-decoy"],
    forbidden: ["private-exact-match"],
  }),
]);

export const REFLECTION_CANDIDATE_CORPUS: ReflectionCandidateCorpus =
  Object.freeze({
    schema: REFLECTION_CORPUS_SCHEMA,
    version: "2026-08-20.1",
    policyVersion: CANDIDATE_POLICY_V1.version,
    boundGrid: Object.freeze([2, 4, 8]),
    baselineBound: 4,
    semanticMinimumScore: CANDIDATE_POLICY_V1.semanticMinimumScore,
    fixtures: FIXTURES,
  });
