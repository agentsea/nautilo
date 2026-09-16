// Immutable, document-safe provenance for completed Video generation outputs.
//
// A take is deliberately not a provider receipt or a byte transport. D525 and
// the future host bridge own those concerns. The project may retain only a
// local opaque handle, the creative lineage people need to understand a take,
// and the safe public identity of the ready Workspace artifact.


const TAKE_HANDLE = /^take_[A-Za-z0-9_-]{16,128}$/u;
const STABLE_SHOT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const EXTERNAL_ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const SAFE_SETTING_TEXT = /^[A-Za-z0-9._:+-]{1,64}$/u;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type GeneratedTakeMediaKind = "video" | "audio";

/** The stable public artifact identity; never an internal artifact row id. */
export type GeneratedTakeArtifact = {
  artifactId: string;
  path: string;
  zone: "workspace";
  mime: string;
  bytes: number;
};

/** D525's display-safe normalized settings subset. Prompt text is not lineage. */
export type GeneratedTakeSettings = {
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  audioEnabled?: boolean;
  instrumental?: boolean;
};

/**
 * Completed output metadata. The local handle is Video-owned; it is not a
 * receipt, provider queue ID, or artifact authority. A bridge must still
 * revalidate readiness and readability before preview or promotion.
 */
export type GeneratedTake = {
  id: string;
  briefRevision: number;
  shotId?: string;
  shotLabel?: string;
  mediaKind: GeneratedTakeMediaKind;
  modelId: string;
  settings: GeneratedTakeSettings;
  artifact: GeneratedTakeArtifact;
};

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) throw new Error(`Unsafe key "${key}" at ${path}.`);
    if (nested && typeof nested === "object" && !Array.isArray(nested)) assertRecord(nested, `${path}.${key}`);
  }
  return record;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not supported.`);
  }
}

function assertSafeDisplayText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string.`);
  if ([...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  }) || /(?:https?:|data:|blob:|file:)/iu.test(value)) {
    throw new Error(`${path} must not contain a URL or control characters.`);
  }
  return value;
}

function assertLogicalWorkspacePath(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty logical Workspace path.`);
  }
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0") || /^(?:https?:|data:|blob:|file:)/iu.test(value)) {
    throw new Error(`${path} must be a logical Workspace path.`);
  }
  if (value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${path} must not traverse Workspace paths.`);
  }
  return value;
}

function assertArtifact(value: unknown, mediaKind: GeneratedTakeMediaKind): GeneratedTakeArtifact {
  const record = assertRecord(value, "generatedTakes.artifact");
  assertExactKeys(record, ["artifactId", "path", "zone", "mime", "bytes"], "generatedTakes.artifact");
  if (typeof record["artifactId"] !== "string" || !EXTERNAL_ARTIFACT_ID.test(record["artifactId"])) {
    throw new Error("generatedTakes.artifact.artifactId must be a public Workspace artifact UUID.");
  }
  const path = assertLogicalWorkspacePath(record["path"], "generatedTakes.artifact.path");
  if (record["zone"] !== "workspace") throw new Error('generatedTakes.artifact.zone must be "workspace".');
  const mime = record["mime"];
  if (typeof mime !== "string" || mime.length > 128 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mime)) {
    throw new Error("generatedTakes.artifact.mime must be a bounded MIME type.");
  }
  if ((mediaKind === "video" && !mime.startsWith("video/")) || (mediaKind === "audio" && !mime.startsWith("audio/"))) {
    throw new Error("generatedTakes.artifact.mime must match the take media kind.");
  }
  if (!Number.isSafeInteger(record["bytes"]) || (record["bytes"] as number) <= 0) {
    throw new Error("generatedTakes.artifact.bytes must be a positive safe integer.");
  }
  return { artifactId: record["artifactId"], path, zone: "workspace", mime, bytes: record["bytes"] as number };
}

function assertSettings(value: unknown): GeneratedTakeSettings {
  const record = assertRecord(value, "generatedTakes.settings");
  assertExactKeys(record, ["durationSeconds", "resolution", "aspectRatio", "audioEnabled", "instrumental"], "generatedTakes.settings");
  const durationSeconds = record["durationSeconds"];
  if (durationSeconds !== undefined && (!Number.isSafeInteger(durationSeconds) || (durationSeconds as number) <= 0)) {
    throw new Error("generatedTakes.settings.durationSeconds must be a positive safe integer when present.");
  }
  for (const key of ["resolution", "aspectRatio"] as const) {
    const setting = record[key];
    if (setting !== undefined && (typeof setting !== "string" || !SAFE_SETTING_TEXT.test(setting))) {
      throw new Error(`generatedTakes.settings.${key} must be a bounded normalized setting when present.`);
    }
  }
  for (const key of ["audioEnabled", "instrumental"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      throw new Error(`generatedTakes.settings.${key} must be boolean when present.`);
    }
  }
  return {
    ...(durationSeconds === undefined ? {} : { durationSeconds: durationSeconds as number }),
    ...(record["resolution"] === undefined ? {} : { resolution: record["resolution"] as string }),
    ...(record["aspectRatio"] === undefined ? {} : { aspectRatio: record["aspectRatio"] as string }),
    ...(record["audioEnabled"] === undefined ? {} : { audioEnabled: record["audioEnabled"] as boolean }),
    ...(record["instrumental"] === undefined ? {} : { instrumental: record["instrumental"] as boolean }),
  };
}

/** Strictly validate and copy a completed, safe candidate take. */
export function validateGeneratedTake(value: unknown): GeneratedTake {
  const record = assertRecord(value, "generatedTake");
  assertExactKeys(record, ["id", "briefRevision", "shotId", "shotLabel", "mediaKind", "modelId", "settings", "artifact"], "generatedTake");
  if (typeof record["id"] !== "string" || !TAKE_HANDLE.test(record["id"])) {
    throw new Error("generatedTake.id must be a local opaque take handle.");
  }
  if (!Number.isSafeInteger(record["briefRevision"]) || (record["briefRevision"] as number) < 0) {
    throw new Error("generatedTake.briefRevision must be a non-negative integer.");
  }
  if (record["shotId"] !== undefined && (typeof record["shotId"] !== "string" || !STABLE_SHOT_ID.test(record["shotId"]))) {
    throw new Error("generatedTake.shotId must be a stable shot identifier when present.");
  }
  const shotLabel = record["shotLabel"] === undefined
    ? undefined
    : assertSafeDisplayText(record["shotLabel"], "generatedTake.shotLabel");
  if (record["mediaKind"] !== "video" && record["mediaKind"] !== "audio") {
    throw new Error('generatedTake.mediaKind must be "video" or "audio".');
  }
  if (typeof record["modelId"] !== "string" || !MODEL_ID.test(record["modelId"])) {
    throw new Error("generatedTake.modelId must be a normalized model identifier.");
  }
  const mediaKind = record["mediaKind"] as GeneratedTakeMediaKind;
  return {
    id: record["id"],
    briefRevision: record["briefRevision"] as number,
    ...(record["shotId"] === undefined ? {} : { shotId: record["shotId"] }),
    ...(shotLabel === undefined ? {} : { shotLabel }),
    mediaKind,
    modelId: record["modelId"],
    settings: assertSettings(record["settings"]),
    artifact: assertArtifact(record["artifact"], mediaKind),
  };
}

/** Strictly validate the optional project list and reject duplicate take/artifact identity. */
export function validateGeneratedTakes(value: unknown): GeneratedTake[] {
  if (!Array.isArray(value)) throw new Error("generatedTakes must be an array.");
  const takes = value.map((take) => validateGeneratedTake(take));
  const takeIds = new Set<string>();
  const artifactIds = new Set<string>();
  for (const take of takes) {
    if (takeIds.has(take.id)) throw new Error(`generatedTakes repeats take id "${take.id}".`);
    if (artifactIds.has(take.artifact.artifactId)) throw new Error("generatedTakes repeats a Workspace artifact.");
    takeIds.add(take.id);
    artifactIds.add(take.artifact.artifactId);
  }
  return takes;
}

/** Fixed-shape comparison for revalidated host input against persisted lineage. */
export function generatedTakesEqual(left: GeneratedTake, right: GeneratedTake): boolean {
  return JSON.stringify(validateGeneratedTake(left)) === JSON.stringify(validateGeneratedTake(right));
}
