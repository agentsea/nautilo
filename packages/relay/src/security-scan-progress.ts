import { taskPreparationText } from "@nautilo/types";
/** Fixed scanner stages only; never source text, paths, commands or authority. */
export type SecurityScanProgress = {
  stage: "preparing_scanners" | "scanner_started" | "scanner_finished" | "recording_evidence" | "research_ready" | "inventory_progress";
  probe?: "gitleaks" | "osv_scanner" | "trivy" | "semgrep";
  filesObserved?: number;
  directoriesObserved?: number;
};
export type RelaySecurityScanProgressMessage = SecurityScanProgress & {
  type: "relay:security-scan-progress";
  correlationId: string;
};

export function isSecurityScanProgress(value: unknown): value is SecurityScanProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!Object.keys(item).every((key) => ["stage", "probe", "type", "correlationId", "filesObserved", "directoriesObserved"].includes(key))) return false;
  if (typeof item["stage"] !== "string") return false;
  if (!["preparing_scanners", "scanner_started", "scanner_finished", "recording_evidence", "research_ready", "inventory_progress"].includes(item["stage"])) return false;
  if (item["stage"] === "inventory_progress") {
    return item["probe"] === undefined
      && Number.isSafeInteger(item["filesObserved"]) && (item["filesObserved"] as number) >= 0
      && Number.isSafeInteger(item["directoriesObserved"]) && (item["directoriesObserved"] as number) >= 0;
  }
  if (item["filesObserved"] !== undefined || item["directoriesObserved"] !== undefined) return false;
  const scannerStage = item["stage"] === "scanner_started" || item["stage"] === "scanner_finished";
  return scannerStage
    ? typeof item["probe"] === "string" && ["gitleaks", "osv_scanner", "trivy", "semgrep"].includes(item["probe"])
    : item["probe"] === undefined;
}

export function securityScanProgressText(progress: SecurityScanProgress): string {
  return taskPreparationText(progress);
}
