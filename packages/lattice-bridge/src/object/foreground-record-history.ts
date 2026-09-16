export interface ForegroundRecordContextItem {
  readonly recordRef: string;
  readonly statement: string;
  readonly lifecycle: "current" | "stale" | "superseded" | "resolved";
  readonly structuralHeight: number;
}

export interface ForegroundRecordRepairSelection {
  readonly recordRef: string;
  readonly statement: string;
  readonly structuralHeight: number;
  readonly lifecycle?: "current" | "stale" | "superseded" | "resolved";
}

export interface ForegroundRecordStructuralSelection {
  readonly representation: "structural";
  readonly recordRef: string;
  readonly structuralHeight: number;
}

export type ForegroundRecordSourceSelection =
  | ForegroundRecordRepairSelection
  | ForegroundRecordStructuralSelection;

export type ForegroundRecordHistoryResult =
  | Readonly<{
      status: "verified";
      records: readonly ForegroundRecordContextItem[];
      provenance: "existing" | "repaired";
      repairedCount: number;
      verification: "authenticated" | "independent_parity";
      ordinaryRestoredCount: number;
    }>
  | Readonly<{
      status: "waiting_for_authority" | "failed";
      reason: string;
    }>;
