/**
 * D557 — Desktop-local Ready-to-work desired-state contract.
 *
 * This module deliberately describes intent, never a grant or a live feature
 * state. Electron main binds it to the currently authenticated Human and the
 * active pairing marker before persistence; the renderer receives only the
 * redacted aggregate projection below.
 */

export const READY_TO_WORK_DESIRED_STATE_VERSION = 1 as const;

export const READY_TO_WORK_COMPONENT_IDS = [
  "voice",
  "auto_approve",
  "workstation",
  "computer_use",
  "coding_connection",
] as const;

export type ReadyToWorkComponentId = (typeof READY_TO_WORK_COMPONENT_IDS)[number];

export type ReadyToWorkSelection = Readonly<Record<ReadyToWorkComponentId, boolean>>;

export const READY_TO_WORK_CODING_HARNESS_IDS = ["codex", "hermes-acp"] as const;
export type ReadyToWorkCodingHarnessId = (typeof READY_TO_WORK_CODING_HARNESS_IDS)[number];

/** The exact active Desktop authority marker; never renderer-supplied. */
export type ReadyToWorkAuthorityBinding = Readonly<{
  scope: string;
  revision: string;
  connectionAttemptId: string;
  serverFingerprint: string;
}>;

export type ReadyToWorkBinding = Readonly<{
  humanId: string;
  authority: ReadyToWorkAuthorityBinding;
}>;

/** Present only for the one Ready mode. A missing/invalid file means Standard. */
export type ReadyToWorkDesiredState = Readonly<{
  version: typeof READY_TO_WORK_DESIRED_STATE_VERSION;
  humanId: string;
  authority: ReadyToWorkAuthorityBinding;
  components: ReadyToWorkSelection;
}>;

export type ReadyToWorkComponentState =
  | "ready"
  | "off_by_choice"
  | "needs_attention";

export type ReadyToWorkRepairTarget =
  | "startup_settings"
  | "voice_settings"
  | "auto_approve_settings"
  | "workstation_settings"
  | "computer_use_settings"
  | "coding_connection_settings";

/** Bounded, renderer-safe cause codes. Human copy remains owned by Workbench. */
export type ReadyToWorkReason =
  | "not_selected"
  | "restore_requested"
  | "owner_unavailable"
  | "owner_rejected"
  | "authority_changed"
  | "os_protection_unavailable"
  | "startup_receipt_missing"
  | "startup_receipt_invalid"
  | "workstation_profile_update_needed"
  | "workstation_capability_missing"
  | "workstation_relay_unavailable"
  | "computer_use_setup_required"
  | "computer_use_accessibility_required"
  | "computer_use_screen_recording_required"
  | "computer_use_provider_unavailable"
  | "coding_connection_unavailable"
  | "coding_harness_starting"
  | "coding_harness_not_installed"
  | "coding_harness_sign_in_required"
  | "coding_harness_unavailable";

export type ReadyToWorkComponentStatus = Readonly<{
  id: ReadyToWorkComponentId;
  state: ReadyToWorkComponentState;
  reason: ReadyToWorkReason | null;
  repairTarget: ReadyToWorkRepairTarget | null;
}>;

export type ReadyToWorkCodingHarnessStatus = Readonly<{
  id: ReadyToWorkCodingHarnessId;
  state: Exclude<ReadyToWorkComponentState, "off_by_choice">;
  reason: ReadyToWorkReason | null;
  repairTarget: "coding_connection_settings";
}>;

/**
 * Renderer-safe projection. `ready` is reserved for a later owner-driven
 * reconciliation; desired intent alone always projects as needs_attention.
 */
export type ReadyToWorkAggregateStatus = Readonly<{
  mode: "standard" | "ready";
  components: readonly ReadyToWorkComponentStatus[];
  /** Flattened enabled owner choices; the internal coding group is not UI. */
  codingHarnesses?: readonly ReadyToWorkCodingHarnessStatus[];
}>;

const HUMAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACTIVE_REVISION = /^[A-Za-z0-9._:-]{1,256}$/;
const CONNECTION_ATTEMPT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SERVER_FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:+/|=-]{0,255}$/;

export function isReadyToWorkOpaqueId(value: unknown): value is string {
  return typeof value === "string" && HUMAN_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

export function parseReadyToWorkSelection(value: unknown): ReadyToWorkSelection | null {
  if (!isRecord(value) || !hasExactKeys(value, READY_TO_WORK_COMPONENT_IDS)) return null;
  for (const id of READY_TO_WORK_COMPONENT_IDS) {
    if (typeof value[id] !== "boolean") return null;
  }
  return {
    voice: value["voice"] as boolean,
    auto_approve: value["auto_approve"] as boolean,
    workstation: value["workstation"] as boolean,
    computer_use: value["computer_use"] as boolean,
    coding_connection: value["coding_connection"] as boolean,
  };
}

export function parseReadyToWorkAuthorityBinding(value: unknown): ReadyToWorkAuthorityBinding | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "scope",
    "revision",
    "connectionAttemptId",
    "serverFingerprint",
  ])) return null;
  if (typeof value["scope"] !== "string" || value["scope"].length > 2048 ||
    typeof value["revision"] !== "string" || !ACTIVE_REVISION.test(value["revision"]) ||
    typeof value["connectionAttemptId"] !== "string" || !CONNECTION_ATTEMPT_ID.test(value["connectionAttemptId"]) ||
    typeof value["serverFingerprint"] !== "string" || !SERVER_FINGERPRINT.test(value["serverFingerprint"])) return null;
  try {
    const url = new URL(value["scope"]);
    if (url.origin !== value["scope"] || (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password) return null;
  } catch {
    return null;
  }
  return {
    scope: value["scope"],
    revision: value["revision"],
    connectionAttemptId: value["connectionAttemptId"],
    serverFingerprint: value["serverFingerprint"],
  };
}

export function parseReadyToWorkDesiredState(value: unknown): ReadyToWorkDesiredState | null {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "humanId", "authority", "components"])) {
    return null;
  }
  if (value["version"] !== READY_TO_WORK_DESIRED_STATE_VERSION || !isReadyToWorkOpaqueId(value["humanId"])) {
    return null;
  }
  const authority = parseReadyToWorkAuthorityBinding(value["authority"]);
  const components = parseReadyToWorkSelection(value["components"]);
  if (!authority || !components) return null;
  return {
    version: READY_TO_WORK_DESIRED_STATE_VERSION,
    humanId: value["humanId"],
    authority,
    components,
  };
}

export function createReadyToWorkDesiredState(
  binding: ReadyToWorkBinding,
  selection: ReadyToWorkSelection,
): ReadyToWorkDesiredState {
  const parsedBinding = parseReadyToWorkDesiredState({
    version: READY_TO_WORK_DESIRED_STATE_VERSION,
    humanId: binding.humanId,
    authority: binding.authority,
    components: selection,
  });
  if (!parsedBinding) throw new Error("Ready-to-work binding or selection is invalid");
  return parsedBinding;
}

export function hasReadyToWorkExactBinding(
  desired: ReadyToWorkDesiredState,
  binding: ReadyToWorkBinding,
): boolean {
  return hasReadyToWorkSameBinding(desired, binding);
}

export function hasReadyToWorkSameBinding(
  left: ReadyToWorkBinding,
  right: ReadyToWorkBinding,
): boolean {
  // A source-built Desktop intentionally mints these two markers in memory on
  // every process launch. Its profile-local stores plus the exact Human,
  // origin, and verified server fingerprint are the durable restart boundary;
  // requiring the ephemeral pair would make Ready restoration impossible.
  const sourceDevelopmentRestart =
    left.authority.revision.startsWith("dev-") &&
    right.authority.revision.startsWith("dev-") &&
    left.authority.connectionAttemptId.startsWith("legacy-dev-") &&
    right.authority.connectionAttemptId.startsWith("legacy-dev-");
  return left.humanId === right.humanId &&
    left.authority.scope === right.authority.scope &&
    (sourceDevelopmentRestart || (
      left.authority.revision === right.authority.revision &&
      left.authority.connectionAttemptId === right.authority.connectionAttemptId
    )) &&
    left.authority.serverFingerprint === right.authority.serverFingerprint;
}

const repairTargetFor = (id: ReadyToWorkComponentId): ReadyToWorkRepairTarget => {
  switch (id) {
    case "voice": return "voice_settings";
    case "auto_approve": return "auto_approve_settings";
    case "workstation": return "workstation_settings";
    case "computer_use": return "computer_use_settings";
    case "coding_connection": return "coding_connection_settings";
  }
};

export function readyToWorkAggregateStatus(
  desired: ReadyToWorkDesiredState | null,
  observed: Partial<Record<ReadyToWorkComponentId, Omit<ReadyToWorkComponentStatus, "id">>> = {},
): ReadyToWorkAggregateStatus {
  if (!desired) {
    return {
      mode: "standard",
      components: READY_TO_WORK_COMPONENT_IDS.map((id) => ({
        id,
        state: "off_by_choice" as const,
        reason: "not_selected" as const,
        repairTarget: null,
      })),
    };
  }
  return {
    mode: "ready",
    components: READY_TO_WORK_COMPONENT_IDS.map((id) => {
      if (!desired.components[id]) {
        return {
          id,
          state: "off_by_choice" as const,
          reason: "not_selected" as const,
          repairTarget: null,
        };
      }
      const live = observed[id];
      return live === undefined
        ? {
            id,
            state: "needs_attention" as const,
            reason: "restore_requested" as const,
            repairTarget: repairTargetFor(id),
          }
        : { id, ...live };
    }),
  };
}

export function withReadyToWorkCodingHarnesses(
  status: ReadyToWorkAggregateStatus,
  codingHarnesses: readonly ReadyToWorkCodingHarnessStatus[],
): ReadyToWorkAggregateStatus {
  if (status.mode === "ready" && status.components.find((item) => item.id === "coding_connection")?.state === "off_by_choice") {
    return { ...status, codingHarnesses: [] };
  }
  return { ...status, codingHarnesses: [...codingHarnesses] };
}
