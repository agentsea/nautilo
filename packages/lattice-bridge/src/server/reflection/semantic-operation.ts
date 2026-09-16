import type {BackgroundReflectionSemanticWorkDescriptorV2, ReflectionSemanticRunInputV2} from "@nautilo/lattice-crypto/background";
import type {createPostgresReflectionSemanticObjectPort} from "./postgres-authority-object-port.ts";
import type {ReflectionSemanticPlanCoordinates} from "./postgres-semantic-plan.ts";

/** One named Lattice semantic operation; the server composes the existing V2 request owner. */
export interface ReflectionSemanticOperationRequest {
  readonly workKind: BackgroundReflectionSemanticWorkDescriptorV2["workKind"];
  readonly coordinates: ReflectionSemanticPlanCoordinates;
  readonly validateInput: ReflectionSemanticRunInputV2["semanticObjects"]["validateInput"];
  readonly validateOutput: ReflectionSemanticRunInputV2["semanticObjects"]["validateOutput"];
  readonly execute: (inputs: Parameters<ReflectionSemanticRunInputV2["execute"]>[0], outputObjectId: string | undefined,
    signal: AbortSignal, assertCurrent: () => Promise<void>) => ReturnType<ReflectionSemanticRunInputV2["execute"]>;
  readonly attach: Parameters<typeof createPostgresReflectionSemanticObjectPort>[0]["attach"];
  readonly signal?: AbortSignal;
}

export interface ReflectionSemanticOperationPort {
  /** Persisted descriptor inventory is a planning hint; the next gate revalidates every coordinate. */
  readPendingInputBindings?(input: Readonly<{
    workKind: ReflectionSemanticOperationRequest["workKind"]; recordRef: string; claimGeneration: number; signal?: AbortSignal;
  }>): Promise<ReflectionSemanticPlanCoordinates["inputBindings"]>;
  runSemantic(operation: ReflectionSemanticOperationRequest): Promise<Readonly<{status: "executed" | "waiting" | "reconciliation_required"}>>;
}
