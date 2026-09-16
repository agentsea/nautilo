import type {
  AuthorityLeafAlternatives,
  EffectiveAudienceAlternative,
} from "../../../src/contracts/authority";

export const AUTHORITY_ALGEBRA_CORPUS_VERSION = "authority-algebra-corpus-v1";

export interface AuthorityAlgebraScenario {
  readonly id: string;
  readonly purpose: string;
  readonly leaves: readonly AuthorityLeafAlternatives[];
  readonly expectedFinalAlternatives: number;
  readonly expectedDisposition: "representable" | "representation_capacity_exceeded";
  readonly maxCheckpointBytes: number;
  readonly maxOperations: number;
  readonly maxLatencyMs: number;
}

const audience = (
  humanRefs: readonly string[],
  includesPublicBoundary = false,
): EffectiveAudienceAlternative => ({ humanRefs, includesPublicBoundary });

function pairAntichain(size: number): readonly EffectiveAudienceAlternative[] {
  const humans = Array.from({ length: 24 }, (_, index) => `h${String(index).padStart(2, "0")}`);
  const alternatives: EffectiveAudienceAlternative[] = [];
  for (let left = 0; left < humans.length && alternatives.length < size; left += 1) {
    for (let right = left + 1; right < humans.length && alternatives.length < size; right += 1) {
      alternatives.push(audience([humans[left] ?? "", humans[right] ?? ""]));
    }
  }
  return alternatives;
}

export const AUTHORITY_ALGEBRA_CORPUS: readonly AuthorityAlgebraScenario[] = [
  {
    id: "representative-overlap",
    purpose: "Multi-attached leaves remain disjunctive while intersections normalize.",
    leaves: [
      {
        terminalAuthorityLeafHandle: "leaf-a",
        alternatives: [audience(["ada", "alex", "casey"], true), audience(["ada", "sam"])],
      },
      {
        terminalAuthorityLeafHandle: "leaf-b",
        alternatives: [audience(["alex", "casey"], true), audience(["ada", "sam"])],
      },
      {
        terminalAuthorityLeafHandle: "leaf-c",
        alternatives: [audience(["ada", "alex", "casey", "sam"], true)],
      },
    ],
    expectedFinalAlternatives: 2,
    expectedDisposition: "representable",
    maxCheckpointBytes: 64_000,
    maxOperations: 1_000,
    maxLatencyMs: 250,
  },
  {
    id: "dominance-heavy",
    purpose: "Incremental maximality pruning collapses duplicate and dominated choices.",
    leaves: Array.from({ length: 8 }, (_, leafIndex) => ({
      terminalAuthorityLeafHandle: `dominance-${leafIndex}`,
      alternatives: Array.from({ length: 64 }, (_, alternativeIndex) =>
        audience(
          alternativeIndex % 2 === 0
            ? ["a", "b", "c", "d"]
            : ["a", "b", "c"],
          alternativeIndex % 4 === 0,
        )
      ),
    })),
    expectedFinalAlternatives: 1,
    expectedDisposition: "representable",
    maxCheckpointBytes: 64_000,
    maxOperations: 2_000,
    maxLatencyMs: 500,
  },
  {
    id: "crypto-boundary-256",
    purpose: "The complete canonical antichain fits the current crypto envelope limit.",
    leaves: [{
      terminalAuthorityLeafHandle: "boundary-256",
      alternatives: pairAntichain(256),
    }],
    expectedFinalAlternatives: 256,
    expectedDisposition: "representable",
    maxCheckpointBytes: 64_000,
    maxOperations: 1_000,
    maxLatencyMs: 1_000,
  },
  {
    id: "crypto-boundary-276",
    purpose: "A complete over-capacity antichain remains measured and unavailable.",
    leaves: [{
      terminalAuthorityLeafHandle: "boundary-276",
      alternatives: pairAntichain(276),
    }],
    expectedFinalAlternatives: 276,
    expectedDisposition: "representation_capacity_exceeded",
    maxCheckpointBytes: 64_000,
    maxOperations: 1_000,
    maxLatencyMs: 1_000,
  },
] as const;
