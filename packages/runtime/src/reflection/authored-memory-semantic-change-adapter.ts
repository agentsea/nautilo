import type { AuthoredMemorySemanticChange } from "@nautilo/agent";
import type { RecordSemanticCommitmentPort } from "@nautilo/reflection-bridge/server";

export interface SourceDependentSemanticWorkPort {
  reserveSourceRepair(input: Readonly<{
    sourceDependencyCommitment: Uint8Array;
    sourceChangeCommitment: Uint8Array;
  }>): Promise<Readonly<{ reserved: boolean }>>;
}

/**
 * Converts one process-local authored-Memory fact into keyed, content-free
 * reverse lookup. The store persists only HMAC commitments and Record work;
 * no raw Memory identifier enters semantic-work state or logs.
 */
export class AuthoredMemorySemanticChangeAdapter {
  constructor(private readonly ports: Readonly<{
    commitments: Pick<RecordSemanticCommitmentPort, "sourceDependency" | "sourceChange">;
    semanticWork: SourceDependentSemanticWorkPort;
    wakeup?(): void;
  }>) {}

  async admit(
    change: AuthoredMemorySemanticChange,
  ): Promise<Readonly<{ admitted: number }>> {
    const logicalSourceRef = `memory:${change.memoryId}`;
    const result = await this.ports.semanticWork.reserveSourceRepair({
      sourceDependencyCommitment: this.ports.commitments.sourceDependency({
        sourceKind: "memory",
        logicalSourceRef,
      }),
      sourceChangeCommitment: this.ports.commitments.sourceChange({
        sourceKind: "memory",
        logicalSourceRef,
        changeRef: change.changeRef,
      }),
    });
    if (result.reserved) this.ports.wakeup?.();
    return { admitted: result.reserved ? 1 : 0 };
  }
}
