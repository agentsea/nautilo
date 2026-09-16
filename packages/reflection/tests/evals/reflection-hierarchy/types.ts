export const REFLECTION_HIERARCHY_CORPUS_SCHEMA =
  "nautilo/reflection-hierarchy-corpus/v1" as const;
export const REFLECTION_HIERARCHY_REPORT_SCHEMA =
  "nautilo/reflection-hierarchy-results/v1" as const;

export interface HierarchyScenarioResult {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  readonly diagnostics: Readonly<Record<string, string | number | boolean>>;
}

export interface HierarchyEvaluationReport {
  readonly schema: typeof REFLECTION_HIERARCHY_REPORT_SCHEMA;
  readonly corpusSchema: typeof REFLECTION_HIERARCHY_CORPUS_SCHEMA;
  readonly corpusVersion: string;
  readonly policyVersion: string;
  readonly promptVersion: string;
  readonly structuralHardGatesPassed: boolean;
  readonly scenarios: readonly HierarchyScenarioResult[];
  readonly semanticDiagnostics: {
    readonly unsupportedClaimCount: number;
    readonly usefulParentRecall: number;
    readonly redundantParentCount: number;
    readonly preservedDisagreement: boolean;
    readonly maxStructuralHeight: number;
    readonly maxFanOut: number;
    readonly noChangeRate: number;
    readonly successorChurn: number;
    readonly searchUsefulness: number;
    readonly evidenceTraceCompleteness: number;
  };
}
