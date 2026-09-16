/**
 * D525 Phase 3.2 — browser-safe generated media result envelope.
 *
 * This deliberately does not mirror a Venice response. The server owns provider
 * receipts, queue identifiers, signed URLs, and recovery transport. Tool cards
 * receive only this narrow, display-safe projection and resolve media through
 * the authenticated Workspace artifact API.
 */

import type { MediaGenerationStatusDtoV1 } from "@nautilo/api-client";

export const GENERATED_MEDIA_STATES = [
  "queued",
  "submitting",
  "generating",
  "downloading",
  "saving",
  "ready",
  "needs-action",
  "failed",
  "unknown",
  "cleanup-pending",
] as const;

export type GeneratedMediaState = (typeof GENERATED_MEDIA_STATES)[number];
export type GeneratedMediaKind = "video" | "audio";

export const GENERATED_MEDIA_RECOVERY_KINDS = [
  "wait",
  "retry_same_receipt",
  "revise_prompt",
  "switch_model",
  "repair_venice",
  "fresh_generation",
] as const;

export type GeneratedMediaRecoveryKind = (typeof GENERATED_MEDIA_RECOVERY_KINDS)[number];

export type GeneratedMediaArtifact = {
  artifactId: string;
  path: string;
  zone: "workspace";
  mime: string;
  bytes: number;
};

export type GeneratedMediaRecoveryAction = {
  /** Server-issued opaque action handle; never a provider receipt or URL. */
  actionId: string;
  kind: GeneratedMediaRecoveryKind;
  label: string;
  /** Only a fresh, newly approved generation can carry new spend. */
  newSpend: boolean;
};

export type GeneratedMediaEnvelope = {
  kind: "generated_media";
  version: 1;
  /** Opaque server-local receipt, never a Venice/provider receipt. */
  receiptId?: string;
  /** True = acknowledged; false = provably not started; null = admission outcome unknown. */
  queueStarted: boolean | null;
  mediaKind: GeneratedMediaKind;
  state: GeneratedMediaState;
  model: string;
  promptSummary: string;
  settings: Record<string, string | number | boolean>;
  artifact?: GeneratedMediaArtifact;
  progress?: {
    elapsedSeconds?: number;
    estimatedSeconds?: number;
    message?: string;
  };
  failure?: {
    code: string;
    message: string;
    creditsRefunded?: boolean;
  };
  recoveryActions: GeneratedMediaRecoveryAction[];
};

type RecordValue = Record<string, unknown>;

const UNSAFE_KEY = /(?:^|[_-])(queue|receipt|provider|signed|download|delivery|raw|url)(?:[_-]|$)|^(?:queueId|receiptId|providerId|signedUrl|downloadUrl|deliveryUrl|rawError|url)$/i;
const URL_VALUE = /(?:https?:\/\/|blob:|data:)/i;
const LOCAL_RECEIPT = /^mg_[A-Za-z0-9_-]{16,128}$/;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isSafeText(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0) && !URL_VALUE.test(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isKnownState(value: unknown): value is GeneratedMediaState {
  return typeof value === "string" && GENERATED_MEDIA_STATES.includes(value as GeneratedMediaState);
}

function isKnownRecoveryKind(value: unknown): value is GeneratedMediaRecoveryKind {
  return typeof value === "string" && GENERATED_MEDIA_RECOVERY_KINDS.includes(value as GeneratedMediaRecoveryKind);
}

function parseArtifact(value: unknown): GeneratedMediaArtifact | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["artifactId", "path", "zone", "mime", "bytes"])) return null;
  if (!isSafeText(value["artifactId"]) || !isSafeText(value["path"]) || !isSafeText(value["mime"])) return null;
  if (value["zone"] !== "workspace" || !isFiniteNonNegative(value["bytes"])) return null;
  return {
    artifactId: value["artifactId"],
    path: value["path"],
    zone: "workspace",
    mime: value["mime"],
    bytes: value["bytes"],
  };
}

function parseSettings(value: unknown): Record<string, string | number | boolean> | null {
  if (!isRecord(value)) return null;
  const output: Record<string, string | number | boolean> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!key || UNSAFE_KEY.test(key)) return null;
    if (typeof setting === "string") {
      if (!isSafeText(setting, true)) return null;
      output[key] = setting;
    } else if (typeof setting === "number") {
      if (!Number.isFinite(setting)) return null;
      output[key] = setting;
    } else if (typeof setting === "boolean") {
      output[key] = setting;
    } else {
      return null;
    }
  }
  return output;
}

function parseProgress(value: unknown): GeneratedMediaEnvelope["progress"] | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ["elapsedSeconds", "estimatedSeconds", "message"])) return null;
  if (value["elapsedSeconds"] !== undefined && !isFiniteNonNegative(value["elapsedSeconds"])) return null;
  if (value["estimatedSeconds"] !== undefined && !isFiniteNonNegative(value["estimatedSeconds"])) return null;
  if (value["message"] !== undefined && !isSafeText(value["message"], true)) return null;
  return {
    ...(value["elapsedSeconds"] === undefined ? {} : { elapsedSeconds: value["elapsedSeconds"] }),
    ...(value["estimatedSeconds"] === undefined ? {} : { estimatedSeconds: value["estimatedSeconds"] }),
    ...(value["message"] === undefined ? {} : { message: value["message"] }),
  };
}

function parseFailure(value: unknown): GeneratedMediaEnvelope["failure"] | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ["code", "message", "creditsRefunded"])) return null;
  if (!isSafeText(value["code"]) || !isSafeText(value["message"])) return null;
  if (value["creditsRefunded"] !== undefined && typeof value["creditsRefunded"] !== "boolean") return null;
  return {
    code: value["code"],
    message: value["message"],
    ...(value["creditsRefunded"] === undefined ? {} : { creditsRefunded: value["creditsRefunded"] }),
  };
}

function parseRecoveryActions(value: unknown): GeneratedMediaRecoveryAction[] | null {
  if (!Array.isArray(value)) return null;
  const actions: GeneratedMediaRecoveryAction[] = [];
  const actionIds = new Set<string>();
  for (const rawAction of value) {
    if (!isRecord(rawAction) || !hasOnlyKeys(rawAction, ["actionId", "kind", "label", "newSpend"])) return null;
    if (!isSafeText(rawAction["actionId"]) || !isKnownRecoveryKind(rawAction["kind"]) || !isSafeText(rawAction["label"])) return null;
    if (typeof rawAction["newSpend"] !== "boolean") return null;
    if (rawAction["kind"] === "fresh_generation" ? !rawAction["newSpend"] : rawAction["newSpend"]) return null;
    if (actionIds.has(rawAction["actionId"])) return null;
    actionIds.add(rawAction["actionId"]);
    actions.push({
      actionId: rawAction["actionId"],
      kind: rawAction["kind"],
      label: rawAction["label"],
      newSpend: rawAction["newSpend"],
    });
  }
  return actions;
}

/**
 * Strictly parses the browser-safe result projection. Any topology-shaped key,
 * unknown structural field, provider URL, or unsupported state falls back to
 * the generic unavailable card instead of becoming browser-visible.
 */
export function parseGeneratedMediaEnvelope(raw: string | undefined): GeneratedMediaEnvelope | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !hasOnlyKeys(value, [
      "kind", "version", "receiptId", "queueStarted", "mediaKind", "state", "model", "promptSummary", "settings", "artifact", "progress", "failure", "recoveryActions",
    ])) return null;
    if (value["kind"] !== "generated_media" || value["version"] !== 1) return null;
    if (value["queueStarted"] !== true && value["queueStarted"] !== false && value["queueStarted"] !== null) return null;
    if (value["receiptId"] !== undefined &&
      (typeof value["receiptId"] !== "string" || !LOCAL_RECEIPT.test(value["receiptId"]))) return null;
    // A confirmed queue must always be addressable by the durable local
    // receipt. A fail-closed pre-admission result may truthfully omit it.
    if ((value["queueStarted"] === true || value["queueStarted"] === null) && value["receiptId"] === undefined) return null;
    if (value["queueStarted"] === null && value["state"] !== "unknown" && value["state"] !== "submitting") return null;
    if (value["queueStarted"] === false && value["state"] !== "failed" && value["state"] !== "needs-action") return null;
    if (value["queueStarted"] === true && (value["state"] === "unknown" || value["state"] === "submitting")) return null;
    if (value["mediaKind"] !== "video" && value["mediaKind"] !== "audio") return null;
    if (!isKnownState(value["state"]) || !isSafeText(value["model"]) || !isSafeText(value["promptSummary"], true)) return null;
    const settings = parseSettings(value["settings"]);
    const artifact = value["artifact"] === undefined ? undefined : parseArtifact(value["artifact"]);
    const progress = parseProgress(value["progress"]);
    const failure = parseFailure(value["failure"]);
    const recoveryActions = parseRecoveryActions(value["recoveryActions"]);
    if (!settings || artifact === null || progress === null || failure === null || recoveryActions === null) return null;
    if (artifact && value["mediaKind"] === "video" && !artifact.mime.startsWith("video/")) return null;
    if (artifact && value["mediaKind"] === "audio" && !artifact.mime.startsWith("audio/")) return null;
    if ((value["state"] === "ready" || value["state"] === "cleanup-pending") && !artifact) return null;
    const failureRequired = value["state"] === "failed" || value["state"] === "needs-action" || value["state"] === "unknown";
    if (failureRequired !== (failure !== undefined)) return null;
    return {
      kind: "generated_media",
      version: 1,
      ...(value["receiptId"] === undefined ? {} : { receiptId: value["receiptId"] }),
      queueStarted: value["queueStarted"],
      mediaKind: value["mediaKind"],
      state: value["state"],
      model: value["model"],
      promptSummary: value["promptSummary"],
      settings,
      ...(artifact ? { artifact } : {}),
      ...(progress ? { progress } : {}),
      ...(failure ? { failure } : {}),
      recoveryActions,
    };
  } catch {
    return null;
  }
}

/** Map an authorized status DTO without copying creative or provider-private data. */
export function mapMediaGenerationStatusToEnvelope(
  dto: MediaGenerationStatusDtoV1,
  current: GeneratedMediaEnvelope,
): GeneratedMediaEnvelope | null {
  if (dto.receiptId !== current.receiptId) return null;
  if (dto.mediaKind !== current.mediaKind) return null;
  if (dto.modelId !== current.model) return null;
  const normalizedCurrentSettings: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(current.settings)) {
    // Reference count is a safe approval/card fact, not a Venice pricing or
    // normalized generation setting. The receipt/model binding still fixes
    // the exact approved request; the public status DTO intentionally omits
    // this count rather than duplicating input-summary data as settings.
    if (key === "referenceImages") {
      if (
        current.model !== "seedance-2-5-reference-to-video-basic" ||
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > 30
      ) return null;
      continue;
    }
    normalizedCurrentSettings[
      key === "audio" ? "audioEnabled" : key === "forceInstrumental" ? "instrumental" : key
    ] = value;
  }
  const canonicalSettings = (settings: Record<string, string | number | boolean>) => JSON.stringify(
    Object.entries(settings).sort(([left], [right]) => left.localeCompare(right)),
  );
  if (canonicalSettings(normalizedCurrentSettings) !== canonicalSettings(dto.settings)) return null;

  let state: GeneratedMediaState = dto.state;
  let queueStarted: boolean | null;
  if (dto.state === "submitting" || dto.state === "unknown") {
    queueStarted = null;
  } else if (dto.state === "failed" || dto.state === "needs-action") {
    const certainty = dto.failure?.completionCertainty;
    if (certainty !== "not_started" && certainty !== "accepted" && certainty !== "complete") {
      queueStarted = null;
      state = "unknown";
    } else {
      queueStarted = certainty === "accepted" || certainty === "complete";
    }
  } else {
    queueStarted = true;
  }

  const candidate: GeneratedMediaEnvelope = {
    kind: "generated_media",
    version: 1,
    receiptId: dto.receiptId,
    queueStarted,
    mediaKind: dto.mediaKind,
    state,
    model: current.model,
    promptSummary: current.promptSummary,
    settings: current.settings,
    ...(dto.progress ? {
      progress: {
        ...(dto.progress.elapsedSeconds === undefined ? {} : { elapsedSeconds: dto.progress.elapsedSeconds }),
        ...(dto.progress.estimatedSeconds === undefined ? {} : { estimatedSeconds: dto.progress.estimatedSeconds }),
        ...(dto.progress.message === undefined ? {} : { message: dto.progress.message }),
      },
    } : {}),
    ...(dto.artifact ? { artifact: dto.artifact } : {}),
    ...(dto.failure ? {
      failure: {
        code: dto.failure.code,
        message: dto.failure.message,
        ...(dto.failure.creditsRefunded === undefined ? {} : { creditsRefunded: dto.failure.creditsRefunded }),
      },
    } : {}),
    recoveryActions: dto.recoveryActions.map((action) => ({ ...action })),
  };
  return parseGeneratedMediaEnvelope(JSON.stringify(candidate));
}

export function generatedMediaStateLabel(state: GeneratedMediaState): string {
  return {
    queued: "Queued",
    submitting: "Submitting — awaiting provider acknowledgement",
    generating: "Generating",
    downloading: "Downloading to Workspace",
    saving: "Saving to Workspace",
    ready: "Ready",
    "needs-action": "Needs your attention",
    failed: "Generation could not continue",
    unknown: "Outcome unknown",
    "cleanup-pending": "Ready — provider cleanup pending",
  }[state];
}
