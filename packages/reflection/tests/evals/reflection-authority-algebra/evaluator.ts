import { performance } from "node:perf_hooks";

import {
  advanceAuthorityAlternatives,
  classifyAuthorityRepresentation,
} from "../../../src/authority/alternative-algebra";
import type { AuthorityAlgebraResult } from "../../../src/contracts/authority";
import {
  AUTHORITY_ALGEBRA_CORPUS,
  AUTHORITY_ALGEBRA_CORPUS_VERSION,
} from "./corpus";

export const AUTHORITY_ALGEBRA_REPORT_SCHEMA = "nautilo/reflection-authority-algebra/v1";
const OPERATIONS_PER_INVOCATION = 7;

export interface AuthorityAlgebraScenarioReport {
  readonly id: string;
  readonly purpose: string;
  readonly passed: boolean;
  readonly inputLeafCount: number;
  readonly inputAlternativeCount: number;
  readonly intermediatePeakAlternativeCount: number;
  readonly finalAlternativeCount: number;
  readonly dominancePrunedCount: number;
  readonly operations: number;
  readonly resumptions: number;
  readonly maxCheckpointBytes: number;
  readonly disposition: "representable" | "representation_capacity_exceeded";
  readonly observedLatencyMs: number;
  readonly latencyBudgetMs: number;
}

export interface AuthorityAlgebraReport {
  readonly schema: typeof AUTHORITY_ALGEBRA_REPORT_SCHEMA;
  readonly corpusVersion: typeof AUTHORITY_ALGEBRA_CORPUS_VERSION;
  readonly policyVersion: "authority-algebra-v1";
  readonly representationAlternativeLimit: 256;
  readonly operationsPerInvocation: number;
  readonly hardGatesPassed: boolean;
  readonly scenarios: readonly AuthorityAlgebraScenarioReport[];
}

export function evaluateAuthorityAlgebra(): AuthorityAlgebraReport {
  const scenarios = AUTHORITY_ALGEBRA_CORPUS.map((scenario) => {
    let continuation: string | undefined;
    let result: AuthorityAlgebraResult;
    let resumptions = 0;
    let maxCheckpointBytes = 0;
    const startedAt = performance.now();
    do {
      result = advanceAuthorityAlternatives({
        leaves: scenario.leaves,
        budget: { maxOperations: OPERATIONS_PER_INVOCATION },
        ...(continuation === undefined ? {} : { continuation }),
      });
      if (result.status === "paused") {
        continuation = result.continuation;
        resumptions += 1;
        maxCheckpointBytes = Math.max(maxCheckpointBytes, result.metrics.checkpointBytes);
      }
    } while (result.status === "paused");
    const observedLatencyMs = performance.now() - startedAt;
    const finalAlternativeCount = result.outcome.kind === "available"
      ? result.outcome.alternatives.length
      : 0;
    const dispositionResult = classifyAuthorityRepresentation(finalAlternativeCount);
    const disposition = dispositionResult.kind === "representable"
      ? "representable" as const
      : dispositionResult.reason;
    const passed = result.outcome.kind === "available"
      && finalAlternativeCount === scenario.expectedFinalAlternatives
      && disposition === scenario.expectedDisposition
      && result.metrics.operations <= scenario.maxOperations
      && maxCheckpointBytes <= scenario.maxCheckpointBytes
      && observedLatencyMs <= scenario.maxLatencyMs
      && resumptions > 0;
    return {
      id: scenario.id,
      purpose: scenario.purpose,
      passed,
      inputLeafCount: result.metrics.inputLeafCount,
      inputAlternativeCount: result.metrics.inputAlternativeCount,
      intermediatePeakAlternativeCount: result.metrics.intermediatePeakAlternativeCount,
      finalAlternativeCount,
      dominancePrunedCount: result.metrics.dominancePrunedCount,
      operations: result.metrics.operations,
      resumptions,
      maxCheckpointBytes,
      disposition,
      observedLatencyMs,
      latencyBudgetMs: scenario.maxLatencyMs,
    };
  });
  return {
    schema: AUTHORITY_ALGEBRA_REPORT_SCHEMA,
    corpusVersion: AUTHORITY_ALGEBRA_CORPUS_VERSION,
    policyVersion: "authority-algebra-v1",
    representationAlternativeLimit: 256,
    operationsPerInvocation: OPERATIONS_PER_INVOCATION,
    hardGatesPassed: scenarios.every((scenario) => scenario.passed),
    scenarios,
  };
}

export function stableAuthorityAlgebraEvidence(report: AuthorityAlgebraReport): unknown {
  return {
    ...report,
    scenarios: report.scenarios.map(({ observedLatencyMs: _, ...scenario }) => scenario),
  };
}
