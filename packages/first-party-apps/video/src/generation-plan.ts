// Browser-safe, deterministic lowering of a Video GenerationBrief into
// reviewed text-to-video job intent. This module deliberately does not know
// live catalog availability, defaults, quote prices, paid approval, jobs, or
// provider transport. Those are host responsibilities.

import type { MediaAsset } from "./edl";
import { VENICE_REFERENCE_VIDEO_MAX_BYTES, VENICE_REFERENCE_VIDEO_SIZE_WARNING } from "@nautilo/types";
import { referenceMentions } from "./generator-composer";
import {
  customDirectionText,
  effectiveGenerationDirectionBlocks,
  validateGenerationBrief,
  type GenerationBrief,
  type GenerationShot,
  type GenerationReference,
} from "./generation-brief";

export const VIDEO_GENERATION_PLAN_VERSION = 1 as const;

export const VIDEO_GENERATION_CATALOG_MODELS = {
  seedance: "venice:seedance-2-5-text-to-video-basic",
  seedanceReference: "venice:seedance-2-5-reference-to-video-basic",
  minimaxH3: "venice:minimax-h3-enhanced-text-to-video",
} as const;

export type VideoGenerationCatalogModelId =
  (typeof VIDEO_GENERATION_CATALOG_MODELS)[keyof typeof VIDEO_GENERATION_CATALOG_MODELS];

export type VideoGenerationPlanDocument = Readonly<{
  /** The saved document version reviewed by this plan; local unsaved plans cannot execute. */
  sha256: string;
  revision: number | null;
}>;

export type VideoGenerationPlanScope =
  | Readonly<{ kind: "quick-brief" }>
  | Readonly<{ kind: "shots"; shotIds: readonly [string, ...string[]] }>;

/**
 * User-selected settings only. Capability ranges, defaults, and normalization
 * remain host/catalog-owned and are applied after this plan is reviewed.
 */
export type VideoGenerationRequestedSettings = Readonly<{
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  audio?: boolean;
}>;

export type VideoGenerationJobSource =
  | Readonly<{ kind: "quick-brief" }>
  | Readonly<{ kind: "shot"; shotId: string }>;

export type VideoGenerationJobIntent = Readonly<{
  source: VideoGenerationJobSource;
  /** Signed/current catalog resolution happens only in the host. */
  modelId: VideoGenerationCatalogModelId;
  settings: VideoGenerationRequestedSettings;
}>;

/**
 * `scope` says which sources the Human selected; `jobs` repeats that exact
 * selection so each source can carry its own reviewed model/settings choice.
 */
export type VideoGenerationPlanIntentV1 = Readonly<{
  version: typeof VIDEO_GENERATION_PLAN_VERSION;
  document: VideoGenerationPlanDocument;
  scope: VideoGenerationPlanScope;
  jobs: readonly [VideoGenerationJobIntent, ...VideoGenerationJobIntent[]];
}>;

export type VideoGenerationReferenceOmission = Readonly<{
  scope: "brief" | "shot";
  shotId?: string;
  id: string;
  name: string;
}>;

export type VideoGenerationPlanIssue =
  | Readonly<{
      code: "REFERENCE_INPUT_UNSUPPORTED";
      references: readonly [VideoGenerationReferenceOmission, ...VideoGenerationReferenceOmission[]];
    }>
  | Readonly<{ code: "REFERENCE_UNAVAILABLE"; message: string }>
  | Readonly<{ code: "CONTINUATION_REQUIRED"; shotId: string }>
  | Readonly<{ code: "EMPTY_DIRECTION"; source: VideoGenerationJobSource }>
  | Readonly<{ code: "MISSING_SHOT"; shotId: string }>
  | Readonly<{ code: "DUPLICATE_SHOT"; shotId: string }>
  | Readonly<{ code: "INVALID_SCOPE" }>
  | Readonly<{ code: "INVALID_MODEL"; modelId: string }>
  | Readonly<{ code: "INVALID_SETTINGS"; jobIndex: number; message: string }>
  | Readonly<{ code: "FRACTIONAL_DURATION"; shotId: string; durationSec: number }>
  | Readonly<{ code: "AMBIGUOUS_DURATION"; shotId: string }>;

export function generationPlanIssueMessage(issue: VideoGenerationPlanIssue): string {
  switch (issue.code) {
    case "REFERENCE_UNAVAILABLE": return issue.message;
    case "CONTINUATION_REQUIRED": return "Generate the preceding scene first, or turn off Continue from previous scene.";
    case "REFERENCE_INPUT_UNSUPPORTED": return "Use Seedance for reference images, videos, and scene continuation. MiniMax H3 is text-only here.";
    case "EMPTY_DIRECTION": return "Write a prompt before generating.";
    case "FRACTIONAL_DURATION": return "Choose a whole number of seconds.";
    default: return "Check the selected scenes and their settings.";
  }
}

export type VideoGenerationPlanJob = Readonly<{
  jobKey: string;
  source: VideoGenerationJobSource;
  title: string;
  catalogModelId: VideoGenerationCatalogModelId;
  /** Host-private after preparation; do not persist it as a provider request. */
  prompt: string;
  /** Still unnormalized: the host resolves current defaults and constraints. */
  requestedSettings: VideoGenerationRequestedSettings;
  referenceImages?: readonly { path: string }[];
  referenceVideos?: readonly { path: string }[];
}>;

export type VideoGenerationPlanDraftV1 =
  | Readonly<{
      status: "blocked";
      sourceFingerprint: string;
      issues: readonly [VideoGenerationPlanIssue, ...VideoGenerationPlanIssue[]];
      jobs: readonly [];
    }>
  | Readonly<{
      status: "ready-for-quote";
      sourceFingerprint: string;
      issues: readonly [];
      jobs: readonly [VideoGenerationPlanJob, ...VideoGenerationPlanJob[]];
    }>;

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const STABLE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_SAFE_SETTING_BYTES = 64;
const MODEL_IDS = new Set<string>(Object.values(VIDEO_GENERATION_CATALOG_MODELS));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  for (const [key, nested] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) throw new Error(`Unsafe key "${key}" at ${path}.`);
    if (isRecord(nested)) assertRecord(nested, `${path}.${key}`);
  }
  return value;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new Error(`${path}.${key} is not supported.`);
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertStableShotId(value: unknown, path: string): string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new Error(`${path} must be a stable app identifier.`);
  }
  return value;
}

function assertSafeSettingString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string when present.`);
  }
  if (utf8Bytes(value) > MAX_SAFE_SETTING_BYTES) {
    throw new Error(`${path} exceeds ${MAX_SAFE_SETTING_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function assertRequestedSettings(value: unknown, jobIndex: number): VideoGenerationRequestedSettings {
  const path = `generationPlan.jobs[${jobIndex}].settings`;
  const record = assertRecord(value, path);
  assertExactKeys(record, ["durationSeconds", "aspectRatio", "resolution", "audio"], path);
  const durationSeconds = record["durationSeconds"];
  if (durationSeconds !== undefined && (typeof durationSeconds !== "number" || !Number.isSafeInteger(durationSeconds) || durationSeconds <= 0)) {
    throw new Error(`${path}.durationSeconds must be a positive integer when present.`);
  }
  const aspectRatio = record["aspectRatio"] === undefined ? undefined : assertSafeSettingString(record["aspectRatio"], `${path}.aspectRatio`);
  const resolution = record["resolution"] === undefined ? undefined : assertSafeSettingString(record["resolution"], `${path}.resolution`);
  const audio = record["audio"];
  if (audio !== undefined && typeof audio !== "boolean") {
    throw new Error(`${path}.audio must be a boolean when present.`);
  }
  return {
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(resolution === undefined ? {} : { resolution }),
    ...(audio === undefined ? {} : { audio }),
  };
}

function assertJobSource(value: unknown, jobIndex: number): VideoGenerationJobSource {
  const path = `generationPlan.jobs[${jobIndex}].source`;
  const record = assertRecord(value, path);
  const kind = record["kind"];
  if (kind === "quick-brief") {
    assertExactKeys(record, ["kind"], path);
    return { kind };
  }
  if (kind === "shot") {
    assertExactKeys(record, ["kind", "shotId"], path);
    return { kind, shotId: assertStableShotId(record["shotId"], `${path}.shotId`) };
  }
  throw new Error(`${path}.kind must be "quick-brief" or "shot".`);
}

export function validateVideoGenerationPlanIntent(value: unknown): VideoGenerationPlanIntentV1 {
  const record = assertRecord(value, "generationPlan");
  assertExactKeys(record, ["version", "document", "scope", "jobs"], "generationPlan");
  if (record["version"] !== VIDEO_GENERATION_PLAN_VERSION) {
    throw new Error(`generationPlan.version must be ${VIDEO_GENERATION_PLAN_VERSION}.`);
  }
  const document = assertRecord(record["document"], "generationPlan.document");
  assertExactKeys(document, ["sha256", "revision"], "generationPlan.document");
  const sha256 = document["sha256"];
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    throw new Error("generationPlan.document.sha256 must be a lowercase SHA-256 digest.");
  }
  const revision = document["revision"];
  if (revision !== null && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) {
    throw new Error("generationPlan.document.revision must be a non-negative safe integer or null.");
  }

  const scopeRecord = assertRecord(record["scope"], "generationPlan.scope");
  let scope: VideoGenerationPlanScope;
  if (scopeRecord["kind"] === "quick-brief") {
    assertExactKeys(scopeRecord, ["kind"], "generationPlan.scope");
    scope = { kind: "quick-brief" };
  } else if (scopeRecord["kind"] === "shots") {
    assertExactKeys(scopeRecord, ["kind", "shotIds"], "generationPlan.scope");
    const shotIds = scopeRecord["shotIds"];
    if (!Array.isArray(shotIds) || shotIds.length === 0) {
      throw new Error("generationPlan.scope.shotIds must contain at least one shot.");
    }
    scope = {
      kind: "shots",
      shotIds: shotIds.map((id, index) => assertStableShotId(id, `generationPlan.scope.shotIds[${index}]`)) as [string, ...string[]],
    };
  } else {
    throw new Error('generationPlan.scope.kind must be "quick-brief" or "shots".');
  }

  const rawJobs = record["jobs"];
  if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
    throw new Error("generationPlan.jobs must contain at least one job.");
  }
  const jobs = rawJobs.map((rawJob, jobIndex) => {
    const path = `generationPlan.jobs[${jobIndex}]`;
    const job = assertRecord(rawJob, path);
    assertExactKeys(job, ["source", "modelId", "settings"], path);
    const modelId = job["modelId"];
    if (typeof modelId !== "string" || !MODEL_IDS.has(modelId)) {
      throw new Error(`${path}.modelId is not a supported text-to-video catalog model.`);
    }
    return {
      source: assertJobSource(job["source"], jobIndex),
      modelId: modelId as VideoGenerationCatalogModelId,
      settings: assertRequestedSettings(job["settings"], jobIndex),
    };
  });

  return {
    version: VIDEO_GENERATION_PLAN_VERSION,
    document: { sha256, revision: revision },
    scope,
    jobs: jobs as [VideoGenerationJobIntent, ...VideoGenerationJobIntent[]],
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A stable browser SHA-256 binding of brief, exact plan intent, and saved document version. */
export async function fingerprintVideoGenerationPlan(
  brief: GenerationBrief,
  intent: VideoGenerationPlanIntentV1,
): Promise<string> {
  const normalizedBrief = validateGenerationBrief(brief);
  const normalizedIntent = validateVideoGenerationPlanIntent(intent);
  if (!globalThis.crypto?.subtle) throw new Error("Secure browser hashing is unavailable.");
  const bytes = new TextEncoder().encode(canonical({ brief: normalizedBrief, intent: normalizedIntent }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${hex(new Uint8Array(digest))}`;
}

function sourceEquals(left: VideoGenerationJobSource, right: VideoGenerationJobSource): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "quick-brief" || (right.kind === "shot" && left.shotId === right.shotId);
}

function selectedSources(scope: VideoGenerationPlanScope): readonly VideoGenerationJobSource[] {
  return scope.kind === "quick-brief"
    ? [{ kind: "quick-brief" }]
    : scope.shotIds.map((shotId) => ({ kind: "shot", shotId }));
}

function omittedReferences(
  brief: GenerationBrief,
  sources: readonly VideoGenerationJobSource[],
): VideoGenerationReferenceOmission[] {
  const omissions: VideoGenerationReferenceOmission[] = effectiveGenerationDirectionBlocks(brief)
    .filter((block) => block.kind === "references")
    .flatMap((block) => (block.references ?? []).map((reference) => ({ scope: "brief" as const, ...reference })));
  for (const source of sources) {
    if (source.kind !== "shot") continue;
    const shot = brief.shots.find((candidate) => candidate.id === source.shotId);
    for (const reference of shot?.references ?? []) {
      omissions.push({ scope: "shot", shotId: source.shotId, ...reference });
    }
  }
  return omissions;
}

function promptLines(brief: GenerationBrief, shot?: GenerationShot): string[] {
  const lines: string[] = [];
  const add = (label: string, value: string): void => {
    const humanText = customDirectionText(value);
    if (humanText.trim().length > 0) lines.push(`${label}:\n${humanText}`);
  };
  for (const block of effectiveGenerationDirectionBlocks(brief)) {
    if (block.kind === "goal") {
      add("Goal", block.goal ?? "");
      add("Quick brief", block.quickBrief ?? "");
    }
    if (block.kind === "continuity") add("Continuity", block.continuity ?? "");
    if (block.kind === "audio") add("Audio direction", block.audio ?? "");
    if (block.kind === "exclusions") add("Do not include", block.exclusions ?? "");
  }
  if (shot) {
    add("Shot title", shot.title);
    add("Shot description", shot.description);
    add("Framing", shot.framing);
    add("Camera", shot.camera);
    add("Motion", shot.motion);
  }
  if (shot) add("Shot continuity", shot.continuity);
  if (shot) add("Shot audio direction", shot.audio);
  if (shot) add("Shot exclusions", shot.exclusions);
  return lines;
}

function hasMeaningfulDirection(brief: GenerationBrief, shot?: GenerationShot): boolean {
  const globalValues = effectiveGenerationDirectionBlocks(brief).flatMap((block) => block.kind === "goal"
    ? [block.quickBrief ?? "", block.goal ?? ""]
    : block.kind === "continuity"
      ? [block.continuity ?? ""]
      : block.kind === "audio"
        ? [block.audio ?? ""]
        : block.kind === "exclusions"
          ? [block.exclusions ?? ""]
          : []);
  if (globalValues.some((value) => customDirectionText(value).trim().length > 0)) return true;
  if (!shot) return false;
  return [shot.title, shot.description, shot.framing, shot.camera, shot.motion, shot.continuity, shot.audio, shot.exclusions]
    .some((value) => customDirectionText(value).trim().length > 0 && value.trim() !== "Untitled shot");
}

function jobTitle(source: VideoGenerationJobSource, shot?: GenerationShot): string {
  if (source.kind === "quick-brief") return "Quick brief";
  return shot?.title.trim() || "Untitled shot";
}

function jobKey(index: number, source: VideoGenerationJobSource): string {
  return source.kind === "quick-brief" ? `quick-${index + 1}` : `shot-${source.shotId}`;
}

function adjustedSettings(
  job: VideoGenerationJobIntent,
  shot: GenerationShot | undefined,
  issues: VideoGenerationPlanIssue[],
): VideoGenerationRequestedSettings {
  if (!shot) return job.settings;
  if (shot.durationSec !== undefined && job.settings.durationSeconds !== undefined) {
    issues.push({ code: "AMBIGUOUS_DURATION", shotId: shot.id });
    return job.settings;
  }
  if (shot.durationSec !== undefined && !Number.isSafeInteger(shot.durationSec)) {
    issues.push({ code: "FRACTIONAL_DURATION", shotId: shot.id, durationSec: shot.durationSec });
    return job.settings;
  }
  return shot.durationSec === undefined ? job.settings : { ...job.settings, durationSeconds: shot.durationSec };
}

/**
 * Validates the exact Human-selected partition and creates only a reviewable,
 * text-only draft. It never resolves defaults, quotes, reserves receipts, or
 * starts generation.
 */
export async function buildVideoGenerationPlanDraft(
  brief: GenerationBrief,
  intent: VideoGenerationPlanIntentV1,
  context: { media?: readonly MediaAsset[]; previousSceneVideo?: GenerationReference; allowPendingContinuation?: boolean } = {},
): Promise<VideoGenerationPlanDraftV1> {
  const normalizedBrief = validateGenerationBrief(brief);
  const normalizedIntent = validateVideoGenerationPlanIntent(intent);
  const sourceFingerprint = await fingerprintVideoGenerationPlan(normalizedBrief, normalizedIntent);
  const issues: VideoGenerationPlanIssue[] = [];
  const sources = selectedSources(normalizedIntent.scope);

  const sourceKeys = new Set<string>();
  for (const source of sources) {
    const key = source.kind === "quick-brief" ? source.kind : `shot:${source.shotId}`;
    if (sourceKeys.has(key)) {
      if (source.kind === "shot") issues.push({ code: "DUPLICATE_SHOT", shotId: source.shotId });
      else issues.push({ code: "INVALID_SCOPE" });
    }
    sourceKeys.add(key);
  }
  if (normalizedIntent.jobs.length !== sources.length || normalizedIntent.jobs.some((job, index) => !sourceEquals(job.source, sources[index]!))) {
    issues.push({ code: "INVALID_SCOPE" });
  }


  const jobs: VideoGenerationPlanJob[] = [];
  for (const [index, intentJob] of normalizedIntent.jobs.entries()) {
    const source = intentJob.source;
    const shot = source.kind === "shot" ? normalizedBrief.shots.find((candidate) => candidate.id === source.shotId) : undefined;
    if (source.kind === "shot" && !shot) {
      issues.push({ code: "MISSING_SHOT", shotId: source.shotId });
      continue;
    }
    if (!hasMeaningfulDirection(normalizedBrief, shot)) {
      issues.push({ code: "EMPTY_DIRECTION", source });
      continue;
    }
    const requestedSettings = adjustedSettings(intentJob, shot, issues);
    const references = omittedReferences(normalizedBrief, [source]) as (GenerationReference & VideoGenerationReferenceOmission)[];
    const mapping = referenceMentions(references);
    if (shot?.continueFromPrevious) {
      if (context.previousSceneVideo) references.unshift({ ...context.previousSceneVideo, scope: "shot" });
      else if (!context.allowPendingContinuation) issues.push({ code: "CONTINUATION_REQUIRED", shotId: shot.id });
    }
    const referenceImages: { path: string }[] = [];
    const referenceVideos: { path: string }[] = [];
    let prompt = promptLines(normalizedBrief, shot).join("\n\n");
    const directions: string[] = [];
    const mapped = new Map<string, string>();
    const seen = new Map<string, string>();
    for (const reference of references) {
      const mediaId = reference.source?.kind === "project-media" ? reference.source.mediaId : undefined;
      const asset = context.media?.find(asset => asset.id === mediaId);
      const lineage = reference.source?.kind === "workspace-artifact" ? reference.source : asset?.source?.kind === "workspace-artifact" ? asset.source : undefined;
      const kind = reference.mediaKind ?? asset?.kind;
      if (!lineage || (kind !== "image" && kind !== "video")) {
        issues.push({ code: "REFERENCE_UNAVAILABLE", message: `Replace "${reference.name}" with a saved Workspace image or video.` }); continue;
      }
      // Saved metadata provides early feedback only. The host rechecks the
      // authorized artifact before quoting, including project-media references
      // whose document lineage intentionally does not contain a byte count.
      if (kind === "video" && "sizeBytes" in lineage && typeof lineage.sizeBytes === "number" && lineage.sizeBytes > VENICE_REFERENCE_VIDEO_MAX_BYTES) {
        issues.push({ code: "REFERENCE_UNAVAILABLE", message: `${reference.name}: ${VENICE_REFERENCE_VIDEO_SIZE_WARNING}` });
        continue;
      }
      const list = kind === "image" ? referenceImages : referenceVideos;
      const key = kind + ":" + lineage.path;
      let tag = seen.get(key);
      if (!tag) { list.push({ path: lineage.path }); tag = `<${kind === "image" ? "Image" : "Video"} ${list.length}>`; seen.set(key, tag); }
      const token = mapping.get(reference.id);
      if (token) {
        if (mapped.has(token) && mapped.get(token) !== tag) issues.push({ code: "REFERENCE_UNAVAILABLE", message: `Reference mention ${token} is ambiguous. Replace the conflicting reference.` });
        mapped.set(token, tag);
      }
      directions.push(`Refer to ${tag} for ${reference.role || "visual guidance"}.${reference.instruction ? " " + reference.instruction : ""}`);
    }
    prompt = [...directions, prompt].join("\n\n").replace(/@(Image|Video|Audio)[1-9][0-9]*/gu, token => {
      const tag = mapped.get(token);
      if (!tag) issues.push({ code: "REFERENCE_UNAVAILABLE", message: `The prompt mentions removed reference ${token}. Update the prompt or attach that reference.` });
      return tag ?? token;
    });
    if (shot?.continueFromPrevious && context.previousSceneVideo) prompt = `Extend <Video 1>, generate only the new scene, without repeating the source clip.\n\n${prompt}`;
    const needsReferences = references.length > 0 || shot?.continueFromPrevious === true;
    if (needsReferences && intentJob.modelId === VIDEO_GENERATION_CATALOG_MODELS.minimaxH3) {
      issues.push({ code: "REFERENCE_INPUT_UNSUPPORTED", references: references.length ? references as [VideoGenerationReferenceOmission, ...VideoGenerationReferenceOmission[]] : [{ scope: "shot", id: shot!.id, name: "Previous scene" }] });
    }
    jobs.push({
      jobKey: jobKey(index, source),
      source,
      title: jobTitle(source, shot),
      catalogModelId: needsReferences ? VIDEO_GENERATION_CATALOG_MODELS.seedanceReference : intentJob.modelId,
      prompt,
      ...(needsReferences ? { referenceImages, referenceVideos } : {}),
      requestedSettings,
    });
  }

  if (issues.length > 0 || jobs.length !== sources.length) {
    return {
      status: "blocked",
      sourceFingerprint,
      issues: issues.length > 0 ? issues as [VideoGenerationPlanIssue, ...VideoGenerationPlanIssue[]] : [{ code: "INVALID_SCOPE" }],
      jobs: [],
    };
  }
  return {
    status: "ready-for-quote",
    sourceFingerprint,
    issues: [],
    jobs: jobs as [VideoGenerationPlanJob, ...VideoGenerationPlanJob[]],
  };
}
