export interface ForegroundMemoryContextItem {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly importance: number;
  readonly tier: number;
  readonly createdAt: Date;
  readonly score?: number;
}

/** Ranked Memory coordinate selected without opening its ordinary body. */
export interface ForegroundMemoryStructuralSelection {
  readonly representation: "structural";
  readonly id: string;
  readonly type: string | null;
  readonly importance: number;
  readonly tier: number;
  readonly createdAt: Date;
  readonly score?: number;
}

export type ForegroundMemoryRepairSelection =
  | ForegroundMemoryContextItem
  | ForegroundMemoryStructuralSelection;

export type ForegroundMemoryHistoryResult =
  | Readonly<{
      status: "verified";
      memories: readonly ForegroundMemoryContextItem[];
      provenance: "existing" | "repaired";
      repairedCount: number;
      verification: "authenticated" | "independent_parity";
      ordinaryRestoredCount: number;
    }>
  | Readonly<{
      status: "waiting_for_authority" | "failed";
      reason: string;
    }>;
