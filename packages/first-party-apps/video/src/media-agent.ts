import { normalizeVideoExportSettings, type VideoExportSettings } from "@nautilo/types";
/** Native work is asynchronous. These receipts observe the existing editor operation,
 * not a second job system. They survive only as long as this editor session. */
export type MediaCommand =
  | { action: "inspect-media" | "import-media" }
  | { action: "export-media"; publishToWorkspace: boolean; exportSettings?: VideoExportSettings }
  | { action: "cancel-import" | "cancel-export"; operationId: string }
  | { action: "choose-import-rate"; operationId: string; decision: "adopt-source-rate" | "keep-project-rate" };
export type MediaOperation = {
  id: string;
  kind: "import" | "export";
  stage: "choosing" | "awaiting-rate" | "saving" | "preparing" | "rendering" | "publishing" | "cancelling" | "succeeded" | "cancelled" | "failed" | "unknown";
  stateChanged: boolean | "unknown";
  retrySafe: false;
  code?: string;
  mediaId?: string;
  label?: string;
  sizeBytes?: number;
  processedTimeUs?: number;
  exportSettings?: VideoExportSettings;
  sourceRate?: { numerator: number; denominator: number };
  workspace?: { status: "published" | "not_published" | "unknown"; path: string; artifactId?: string };
};
export type MediaOperationsResult = { status: "media_operations"; import: MediaOperation | null; export: MediaOperation | null; workspaceExportSupported: boolean; nativeDialogsRequired: true };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));

export function parseMediaCommand(value: unknown): MediaCommand | null {
  const v = record(value); if (!v) return null;
  if (["inspect-media", "import-media"].includes(String(v["action"])) && only(v, ["action"])) return v as MediaCommand;
  if (v["action"] === "export-media" && typeof v["publishToWorkspace"] === "boolean" && only(v, ["action", "publishToWorkspace", "exportSettings"])) {
    const exportSettings = normalizeVideoExportSettings(v["exportSettings"]);
    return exportSettings ? { action: "export-media", publishToWorkspace: v["publishToWorkspace"], ...(v["exportSettings"] === undefined ? {} : { exportSettings }) } : null;
  }
  if (typeof v["operationId"] !== "string" || !uuid.test(v["operationId"])) return null;
  if (["cancel-import", "cancel-export"].includes(String(v["action"])) && only(v, ["action", "operationId"])) return v as MediaCommand;
  if (v["action"] === "choose-import-rate" && ["adopt-source-rate", "keep-project-rate"].includes(String(v["decision"])) && only(v, ["action", "operationId", "decision"])) return v as MediaCommand;
  return null;
}

export function newMediaOperation(kind: MediaOperation["kind"]): MediaOperation {
  return { id: crypto.randomUUID(), kind, stage: kind === "import" ? "choosing" : "preparing", stateChanged: "unknown", retrySafe: false };
}
export function mediaOperationActive(operation: MediaOperation | null): boolean {
  return operation !== null && !["succeeded", "cancelled", "failed", "unknown"].includes(operation.stage);
}

function validOperation(value: unknown, kind: MediaOperation["kind"]): boolean {
  if (value === null) return true;
  const v = record(value);
  if (!v || !only(v, ["id", "kind", "stage", "stateChanged", "retrySafe", "code", "mediaId", "label", "sizeBytes", "processedTimeUs", "sourceRate", "workspace", "exportSettings"]) ||
    typeof v["id"] !== "string" || !uuid.test(v["id"]) || v["kind"] !== kind || v["retrySafe"] !== false ||
    ![true, false, "unknown"].includes(v["stateChanged"] as boolean | string) ||
    !["choosing", "awaiting-rate", "saving", "preparing", "rendering", "publishing", "cancelling", "succeeded", "cancelled", "failed", "unknown"].includes(String(v["stage"]))) return false;
  for (const key of ["code", "mediaId", "label"]) if (v[key] !== undefined && typeof v[key] !== "string") return false;
  if (v["exportSettings"] !== undefined && (kind !== "export" || !normalizeVideoExportSettings(v["exportSettings"]))) return false;
  const code = v["code"];
  if (code !== undefined && (typeof code !== "string" || !/^[a-z0-9_]+$/u.test(code))) return false;
  for (const key of ["sizeBytes", "processedTimeUs"]) if (v[key] !== undefined && (!Number.isSafeInteger(v[key]) || Number(v[key]) < 0)) return false;
  if (v["sourceRate"] !== undefined) {
    const rate = record(v["sourceRate"]);
    if (!rate || !only(rate, ["numerator", "denominator"]) || ![rate["numerator"], rate["denominator"]].every(n => Number.isSafeInteger(n) && Number(n) > 0)) return false;
  }
  if (v["workspace"] !== undefined) {
    const workspace = record(v["workspace"]);
    if (!workspace || !only(workspace, ["status", "path", "artifactId"]) || !["published", "not_published", "unknown"].includes(String(workspace["status"])) || typeof workspace["path"] !== "string" || (workspace["artifactId"] !== undefined && typeof workspace["artifactId"] !== "string")) return false;
  }
  return true;
}
export function parseMediaOperationsResult(value: unknown): MediaOperationsResult | null {
  const v = record(value);
  return v && Object.keys(v).length === 5 && only(v, ["status", "import", "export", "workspaceExportSupported", "nativeDialogsRequired"]) && v["status"] === "media_operations" && v["nativeDialogsRequired"] === true && typeof v["workspaceExportSupported"] === "boolean" && validOperation(v["import"], "import") && validOperation(v["export"], "export") ? v as MediaOperationsResult : null;
}
