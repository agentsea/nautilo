export const TASK_CONTINUATION_LOCAL_STATUSES = [
  "available",
  "not_captured",
  "relay_disconnected",
  "relay_owner_mismatch",
  "relay_replaced",
  "folder_changed",
  "folder_invalid",
  "browser_session_expired",
  "capability_revoked",
] as const;

export type TaskContinuationLocalStatus =
  typeof TASK_CONTINUATION_LOCAL_STATUSES[number];

export type TaskReportBackContinuation = Readonly<{
  status: TaskContinuationLocalStatus;
  browserStatus?: "available" | "not_captured" | "browser_session_expired";
  relayId?: string;
  relaySessionId?: string;
  desktopSessionId?: string;
  pairingGeneration?: string;
  currentFolder?: string;
  workspacePath?: string;
  browserSessionId?: string;
  /** Original server capture time. Reconnect must never renew the binding lifetime. */
  bindingCapturedAt?: number;
}>;

const STATUS_SET = new Set<string>(TASK_CONTINUATION_LOCAL_STATUSES);

/** Strict parser for the server-authored foreground Job input. */
export function parseTaskReportBackContinuation(
  value: unknown,
): TaskReportBackContinuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ status: "not_captured" });
  }
  const raw = value as Record<string, unknown>;
  const status = typeof raw["status"] === "string" && STATUS_SET.has(raw["status"])
    ? raw["status"] as TaskContinuationLocalStatus
    : "not_captured";
  if (status !== "available") return Object.freeze({ status });
  const required = [
    "relayId",
    "relaySessionId",
    "desktopSessionId",
    "pairingGeneration",
    "currentFolder",
    "workspacePath",
  ] as const;
  if (required.some((key) => typeof raw[key] !== "string")) {
    return Object.freeze({ status: "not_captured" });
  }
  return Object.freeze({
    status,
    ...(raw["browserStatus"] === "available"
      || raw["browserStatus"] === "not_captured"
      || raw["browserStatus"] === "browser_session_expired"
      ? { browserStatus: raw["browserStatus"] }
      : {}),
    relayId: raw["relayId"] as string,
    relaySessionId: raw["relaySessionId"] as string,
    desktopSessionId: raw["desktopSessionId"] as string,
    pairingGeneration: raw["pairingGeneration"] as string,
    currentFolder: raw["currentFolder"] as string,
    workspacePath: raw["workspacePath"] as string,
    ...(typeof raw["bindingCapturedAt"] === "number" && Number.isFinite(raw["bindingCapturedAt"])
      && raw["bindingCapturedAt"] >= 0 ? { bindingCapturedAt: raw["bindingCapturedAt"] } : {}),
    ...(typeof raw["browserSessionId"] === "string"
      ? { browserSessionId: raw["browserSessionId"] }
      : {}),
  });
}

export function hasAvailableTaskReportBackContinuation(
  value: TaskReportBackContinuation | null | undefined,
): value is TaskReportBackContinuation & {
  status: "available";
  relayId: string;
  relaySessionId: string;
  desktopSessionId: string;
  pairingGeneration: string;
  currentFolder: string;
  workspacePath: string;
} {
  return value?.status === "available"
    && typeof value.relayId === "string" && value.relayId.length > 0
    && typeof value.relaySessionId === "string" && value.relaySessionId.length > 0
    && typeof value.desktopSessionId === "string" && value.desktopSessionId.length > 0
    && typeof value.pairingGeneration === "string" && value.pairingGeneration.length > 0
    && typeof value.currentFolder === "string" && value.currentFolder.length > 0
    && typeof value.workspacePath === "string";
}
