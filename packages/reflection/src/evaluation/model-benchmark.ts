import {
  runOrganizer,
  type OrganizerInput,
  type OrganizerModelInvoker,
} from "../organizer/processor";
import type { RecordSnapshot } from "../contracts/hierarchy";
import { CANDIDATE_POLICY_V1 } from "../organizer/candidate-policy";

export const HIERARCHY_MODEL_BENCHMARK_SCHEMA =
  "nautilo/reflection-hierarchy-model-benchmark/v1" as const;
export const HIERARCHY_MODEL_BENCHMARK_CORPUS_VERSION = "2026-08-21.1";
export const HIERARCHY_MODEL_BENCHMARK_PROMPT_VERSION = "hierarchy-organizer-v4";

export interface ModelBenchmarkUsage {
  readonly call: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ModelBenchmarkMetadata {
  readonly provider: string;
  readonly model: string;
  readonly runs: number;
  readonly implementationSha: string | null;
  readonly implementationDirty: boolean;
}

interface BenchmarkFixture {
  readonly id: string;
  readonly expectedOperation: "create_parent" | "extend_parent" | "wrap_parent" | "no_change";
  readonly requiredSelectedHandles: readonly string[];
  readonly requiredParentHandle?: string;
  readonly input: OrganizerInput;
}

function snapshot(
  recordRef: string,
  statement: string,
  posture: "authored" | "derived" = "derived",
  structuralHeight = 0,
): RecordSnapshot {
  return {
    recordRef,
    observedContentFingerprint: `benchmark:${recordRef}`,
    posture,
    anchors: [],
    statement,
    sourceRefs: [],
    childRecordRefs: [],
    structuralHeight,
    lifecycle: "current",
  };
}

export const HIERARCHY_MODEL_BENCHMARK_FIXTURES: readonly BenchmarkFixture[] =
  Object.freeze([
    {
      id: "postgres-decision",
      expectedOperation: "create_parent",
      requiredSelectedHandles: ["C0", "R1", "R2"],
      input: {
        changed: {
          handle: "C0",
          snapshot: snapshot(
            "benchmark-memory",
            "The primary store needs portable SQL and strong transactions.",
            "authored",
          ),
        },
        candidates: [
          {
            handle: "R1",
            snapshot: snapshot(
              "benchmark-neon",
              "Casey suggested Neon for managed Postgres branching and operations.",
            ),
          },
          {
            handle: "R2",
            snapshot: snapshot(
              "benchmark-postgres",
              "Alex preferred Postgres for relational constraints and familiar operations.",
            ),
          },
        ],
        existingParents: [],
        changeReason: "created",
        maxSelectedChildren: CANDIDATE_POLICY_V1.sameRoomBound,
      },
    },
    {
      id: "valuable-independent-leaf",
      expectedOperation: "no_change",
      requiredSelectedHandles: [],
      input: {
        changed: {
          handle: "C0",
          snapshot: snapshot(
            "benchmark-leaf",
            "Nightly backups are verified with a stored SHA-256 checksum.",
            "authored",
          ),
        },
        candidates: [{
          handle: "R1",
          snapshot: snapshot("benchmark-theme", "Dark mode uses the slate palette."),
        }],
        existingParents: [],
        changeReason: "created",
        maxSelectedChildren: CANDIDATE_POLICY_V1.sameRoomBound,
      },
    },
    {
      id: "preserved-disagreement",
      expectedOperation: "create_parent",
      requiredSelectedHandles: ["C0", "R1"],
      input: {
        changed: {
          handle: "C0",
          snapshot: snapshot(
            "benchmark-cost-a",
            "PostgreSQL will be cheaper for the expected steady workload.",
          ),
        },
        candidates: [{
          handle: "R1",
          snapshot: snapshot(
            "benchmark-cost-b",
            "Managed PostgreSQL may cost more after storage and egress are included.",
          ),
        }],
        existingParents: [],
        changeReason: "created",
        maxSelectedChildren: CANDIDATE_POLICY_V1.sameRoomBound,
      },
    },
    {
      id: "extend-existing-database-parent",
      expectedOperation: "extend_parent",
      requiredSelectedHandles: ["C0"],
      requiredParentHandle: "P1",
      input: {
        changed: {
          handle: "C0",
          snapshot: snapshot(
            "benchmark-preview-requirement",
            "The same PostgreSQL decision now also requires managed branch previews.",
          ),
        },
        candidates: [{
          handle: "R1",
          snapshot: snapshot(
            "benchmark-neon-branching",
            "Neon provides managed PostgreSQL branch previews.",
          ),
        }],
        existingParents: [{
          handle: "P1",
          snapshot: snapshot(
            "benchmark-database-parent",
            "The team chose PostgreSQL for portable SQL and strong transactions.",
            "derived",
            1,
          ),
        }],
        changeReason: "created",
        maxSelectedChildren: CANDIDATE_POLICY_V1.sameRoomBound,
      },
    },
    {
      id: "wrap-existing-parent-without-replacing-it",
      expectedOperation: "wrap_parent",
      requiredSelectedHandles: ["R1"],
      requiredParentHandle: "C0",
      input: {
        changed: {
          handle: "C0",
          snapshot: snapshot(
            "benchmark-database-parent",
            "The team chose PostgreSQL for portable SQL and strong transactions.",
            "derived",
            1,
          ),
        },
        candidates: [{
          handle: "R1",
          snapshot: snapshot(
            "benchmark-operating-plan",
            "The database operating plan requires verified backups.",
            "derived",
            1,
          ),
        }],
        existingParents: [],
        changeReason: "created",
        maxSelectedChildren: CANDIDATE_POLICY_V1.sameRoomBound,
      },
    },
  ]);

export interface NormalizedBenchmarkProposal {
  readonly operation: string;
  readonly selectedHandles: readonly string[];
  readonly parentHandle?: string;
  /** Validated and bounded Organizer text, not the raw provider response. */
  readonly statement?: string;
}

export interface HierarchyModelBenchmarkReport {
  readonly schema: typeof HIERARCHY_MODEL_BENCHMARK_SCHEMA;
  readonly provider: string;
  readonly model: string;
  readonly runs: number;
  readonly corpusVersion: string;
  readonly policyVersion: string;
  readonly promptVersion: string;
  readonly implementation: { readonly sha: string | null; readonly dirty: boolean };
  readonly scenarios: readonly {
    readonly fixtureId: string;
    readonly repetition: number;
    readonly proposal: NormalizedBenchmarkProposal | null;
    readonly structuralGatePassed: boolean;
    readonly semanticDiagnostics: {
      readonly expectedOperationMatched: boolean;
      readonly requiredSupportSelected: boolean;
      readonly requiredParentSelected: boolean;
      readonly redundantParent: boolean;
    };
    readonly calls: number;
    readonly repairs: number;
    readonly errorCode: "invalid_output" | "provider_invocation_failed" | null;
  }[];
  readonly aggregate: {
    readonly structuralHardGatesPassed: boolean;
    readonly expectedOperationRate: number;
    readonly usefulParentRate: number;
    readonly redundantParentCount: number;
    readonly agreementRate: number;
    readonly successorChurn: number;
  };
  readonly usage: readonly ModelBenchmarkUsage[];
}

function proposalKey(proposal: NormalizedBenchmarkProposal | null): string {
  return proposal === null
    ? "invalid"
    : JSON.stringify({
        operation: proposal.operation,
        selectedHandles: proposal.selectedHandles,
        parentHandle: proposal.parentHandle ?? null,
        statement: proposal.statement ?? null,
      });
}

function usageValue(value: number | undefined): number | undefined {
  return value === undefined || !Number.isSafeInteger(value) || value < 0 ? undefined : value;
}

export async function runHierarchyModelBenchmark(input: {
  readonly metadata: ModelBenchmarkMetadata;
  readonly invoke: OrganizerModelInvoker;
  readonly usage: readonly ModelBenchmarkUsage[];
  readonly signal?: AbortSignal;
}): Promise<HierarchyModelBenchmarkReport> {
  if (!Number.isSafeInteger(input.metadata.runs) || input.metadata.runs < 1) {
    throw new RangeError("benchmark runs must be a positive safe integer");
  }
  const scenarios: HierarchyModelBenchmarkReport["scenarios"][number][] = [];
  for (const fixture of HIERARCHY_MODEL_BENCHMARK_FIXTURES) {
    for (let repetition = 1; repetition <= input.metadata.runs; repetition += 1) {
      let calls = 0;
      let providerFailed = false;
      const result = await runOrganizer({
        snapshot: fixture.input,
        invoke: async (prompt, signal) => {
          calls += 1;
          try {
            return await input.invoke(prompt, signal);
          } catch {
            providerFailed = true;
            return "";
          }
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const proposal = result.ok
        ? {
            operation: result.proposal.operation,
            selectedHandles: "childRecordRefs" in result.proposal
              ? [...result.proposal.childRecordRefs]
              : "additionRefs" in result.proposal
                ? [...result.proposal.additionRefs]
              : [],
            ...("parentRecordRef" in result.proposal
              ? { parentHandle: result.proposal.parentRecordRef }
              : {}),
            ...("statement" in result.proposal
              ? { statement: result.proposal.statement }
              : {}),
          }
        : null;
      const selected = new Set(proposal?.selectedHandles ?? []);
      const expectedOperationMatched = proposal?.operation === fixture.expectedOperation;
      const requiredSupportSelected = fixture.requiredSelectedHandles.every((handle) =>
        selected.has(handle)
      );
      const requiredParentSelected = fixture.requiredParentHandle === undefined
        || proposal?.parentHandle === fixture.requiredParentHandle;
      scenarios.push({
        fixtureId: fixture.id,
        repetition,
        proposal,
        structuralGatePassed: result.ok,
        semanticDiagnostics: {
          expectedOperationMatched,
          requiredSupportSelected,
          requiredParentSelected,
          redundantParent: fixture.expectedOperation === "no_change"
            && proposal?.operation === "create_parent",
        },
        calls,
        repairs: result.ok ? result.attempts - 1 : 1,
        errorCode: result.ok
          ? null
          : providerFailed
            ? "provider_invocation_failed"
            : "invalid_output",
      });
    }
  }
  const expected = scenarios.filter(
    (scenario) => scenario.semanticDiagnostics.expectedOperationMatched,
  ).length;
  const usefulParents = scenarios.filter((scenario) =>
    scenario.proposal?.operation === "create_parent"
    && scenario.semanticDiagnostics.expectedOperationMatched
    && scenario.semanticDiagnostics.requiredSupportSelected
  ).length;
  const expectedParents = HIERARCHY_MODEL_BENCHMARK_FIXTURES
    .filter((fixture) => fixture.expectedOperation === "create_parent").length
    * input.metadata.runs;
  const stableGroups = HIERARCHY_MODEL_BENCHMARK_FIXTURES.filter((fixture) => {
    const keys = scenarios
      .filter((scenario) => scenario.fixtureId === fixture.id)
      .map((scenario) => proposalKey(scenario.proposal));
    return new Set(keys).size === 1;
  }).length;
  return {
    schema: HIERARCHY_MODEL_BENCHMARK_SCHEMA,
    provider: input.metadata.provider,
    model: input.metadata.model,
    runs: input.metadata.runs,
    corpusVersion: HIERARCHY_MODEL_BENCHMARK_CORPUS_VERSION,
    policyVersion: CANDIDATE_POLICY_V1.version,
    promptVersion: HIERARCHY_MODEL_BENCHMARK_PROMPT_VERSION,
    implementation: {
      sha: input.metadata.implementationSha,
      dirty: input.metadata.implementationDirty,
    },
    scenarios,
    aggregate: {
      structuralHardGatesPassed: scenarios.every((scenario) => scenario.structuralGatePassed),
      expectedOperationRate: expected / Math.max(1, scenarios.length),
      usefulParentRate: usefulParents / Math.max(1, expectedParents),
      redundantParentCount: scenarios.filter(
        (scenario) => scenario.semanticDiagnostics.redundantParent,
      ).length,
      agreementRate: stableGroups / HIERARCHY_MODEL_BENCHMARK_FIXTURES.length,
      successorChurn: scenarios.filter((scenario) =>
        scenario.proposal?.operation === "extend_parent"
        || scenario.proposal?.operation === "supersede_parent"
        || scenario.proposal?.operation === "resolve_parent"
      ).length / Math.max(1, scenarios.length),
    },
    usage: input.usage.map((entry) => ({
      call: entry.call,
      ...(usageValue(entry.inputTokens) === undefined
        ? {}
        : { inputTokens: usageValue(entry.inputTokens)! }),
      ...(usageValue(entry.outputTokens) === undefined
        ? {}
        : { outputTokens: usageValue(entry.outputTokens)! }),
      ...(usageValue(entry.totalTokens) === undefined
        ? {}
        : { totalTokens: usageValue(entry.totalTokens)! }),
    })),
  };
}

export function renderHierarchyModelBenchmarkReport(
  report: HierarchyModelBenchmarkReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
