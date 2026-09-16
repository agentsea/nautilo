// Parse/serialize for `.video.html` text-container artifacts.
//
// HTML container with a manifest and one JSON payload script.
// `<script type="application/vnd.nautilo.document+json" id="manifest">` block
// plus a payload `<script>` block holding the EDL project JSON. The parser
// Rejects executable script tags. The host enforces its document transport limit.

import {
  type Clip,
  type ClipKind,
  type FrameRate,
  type MediaAsset,
  type MediaKind,
  type WorkspaceArtifactMediaSource,
  type ProjectMetadata,
  type Sequence,
  type Track,
  type TrackKind,
  type TimelineMarker,
  type VideoDocument,
  type VideoManifest,
  type VideoProject,
  EDL_VERSION,
  DEFAULT_FRAME_RATE,
  COMPATIBLE_TRACK_BY_CLIP_KIND,
  createEmptyProject,
  isFrameRate,
  isProjectRelativeMediaRef,
} from "./edl";
import { type GenerationBrief, validateGenerationBrief } from "./generation-brief";
import { type GeneratedTake, validateGeneratedTakes } from "./generation-takes";
import { hasProjectTransitions, transitionProblem } from "./transitions";
import { computeSequenceDurationSec } from "./timing";

export const NAUTILO_DOCUMENT_MANIFEST_TYPE = "application/vnd.nautilo.document+json";
export const NAUTILO_DOCUMENT_MANIFEST_ID = "manifest";
export const NAUTILO_VIDEO_EDL_TYPE = "application/vnd.nautilo.video-edl+json";
export const DEFAULT_VIDEO_EDL_ID = "nautilo-video-edl";
export const VIDEO_DOCUMENT_TYPE = "video";
export const VIDEO_EDITOR = "nautilo-video";
export const VIDEO_HTML_VERSION = "1.0";
import { fadeSupported, hasProjectFades, validFades, type FadeKey } from "./fades";

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CLIP_KINDS: readonly ClipKind[] = ["video", "audio", "image", "text", "caption", "callout"];
const TRACK_KINDS: readonly TrackKind[] = ["video", "overlay", "caption", "audio", "music"];
const MEDIA_KINDS: readonly MediaKind[] = ["video", "audio", "image"];

export type VideoHtmlParseResult =
  | { ok: true; document: VideoDocument }
  | { ok: false; error: string };

export type SerializeVideoHtmlOptions = {
  touchMetadata?: boolean;
  updatedAt?: string;
};

function escapeHtml(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
      ? `${value}`
      : "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeScriptJson(json: string): string {
  return json.replace(/<\/script/gi, "<\\/script");
}

function stripEscapedScriptEnd(text: string): string {
  return text.replace(/<\\\/script/gi, "</script");
}

function assertSafeObjectKeys(record: Record<string, unknown>, path: string): string | null {
  for (const key of Object.keys(record)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) return `Unsafe key "${key}" at ${path}`;
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = assertSafeObjectKeys(value as Record<string, unknown>, `${path}.${key}`);
      if (nested) return nested;
    }
  }
  return null;
}

type ScriptBlock = {
  attrs: Record<string, string>;
  content: string;
};

function attrMap(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrText)) !== null) {
    attrs[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function extractScriptBlocks(html: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    blocks.push({
      attrs: attrMap(match[1] ?? ""),
      content: stripEscapedScriptEnd(match[2] ?? "").trim(),
    });
  }
  return blocks;
}

function findRequiredScript(blocks: ScriptBlock[], id: string, type: string): ScriptBlock {
  const matches = blocks.filter(
    (block) => block.attrs["id"] === id && block.attrs["type"]?.toLowerCase() === type.toLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one script#${id} with type ${type}.`);
  }
  return matches[0]!;
}

function parseJsonBlock(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateManifest(value: unknown): VideoManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest must be an object.");
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, "manifest");
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (record["documentType"] !== VIDEO_DOCUMENT_TYPE) {
    throw new Error('Manifest documentType must be "video".');
  }
  if (record["editor"] !== VIDEO_EDITOR) {
    throw new Error('Manifest editor must be "nautilo-video".');
  }
  if (typeof record["payloadId"] !== "string" || record["payloadId"].trim().length === 0) {
    throw new Error("Manifest payloadId must be a non-empty string.");
  }
  if (record["payloadFormat"] !== NAUTILO_VIDEO_EDL_TYPE) {
    throw new Error(`Manifest payloadFormat must be "${NAUTILO_VIDEO_EDL_TYPE}".`);
  }
  if (record["version"] !== VIDEO_HTML_VERSION && record["version"] !== "1.1" && record["version"] !== "1.2") {
    throw new Error(`Manifest version must be "${VIDEO_HTML_VERSION}".`);
  }
  const md = record["metadata"];
  const manifest: VideoManifest = {
    documentType: VIDEO_DOCUMENT_TYPE,
    editor: VIDEO_EDITOR,
    payloadId: record["payloadId"].trim(),
    payloadFormat: NAUTILO_VIDEO_EDL_TYPE,
    version: record["version"],
  };
  if (md && typeof md === "object" && !Array.isArray(md)) {
    manifest.metadata = { ...(md as { createdBy?: string; updatedAt?: string }) };
  }
  return manifest;
}

function validateNumber(value: unknown, path: string, opts?: { min?: number; allowUndefined?: boolean }): number | undefined {
  if (value === undefined) {
    if (opts?.allowUndefined) return undefined;
    throw new Error(`${path} is required.`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  if (opts?.min !== undefined && value < opts.min) {
    throw new Error(`${path} must be >= ${opts.min}.`);
  }
  return value;
}

function validateFrameRate(value: unknown, path: string): FrameRate {
  // Legacy documents intentionally acquire the visible V1 default on read.
  if (value === undefined) return { ...DEFAULT_FRAME_RATE };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object with positive integer numerator and denominator.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["numerator", "denominator"].includes(key))) {
    throw new Error(`${path} includes an unsupported field.`);
  }
  const numerator = record["numerator"];
  const denominator = record["denominator"];
  if (
    typeof numerator !== "number" ||
    typeof denominator !== "number" ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    throw new Error(`${path} must be a positive rational frame rate with safe integer components.`);
  }
  return { numerator, denominator };
}

function validateMarkers(value: unknown, path: string): TimelineMarker[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array when present.`);
  return value.map((entry, index) => {
    const markerPath = `${path}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${markerPath} must be an object.`);
    }
    const unsafe = assertSafeObjectKeys(entry as Record<string, unknown>, markerPath);
    if (unsafe) throw new Error(unsafe);
    const record = entry as Record<string, unknown>;
    if (typeof record["id"] !== "string" || record["id"].trim().length === 0) {
      throw new Error(`${markerPath}.id must be a non-empty string.`);
    }
    const timeSec = validateNumber(record["timeSec"], `${markerPath}.timeSec`, { min: 0 })!;
    if (record["label"] !== undefined && typeof record["label"] !== "string") {
      throw new Error(`${markerPath}.label must be a string when present.`);
    }
    return {
      id: record["id"].trim(),
      timeSec,
      ...(typeof record["label"] === "string" && record["label"].length > 0 ? { label: record["label"] } : {}),
    };
  });
}

function validateProps(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  // Keep validation a pure boundary: normalized EDL output never aliases an
  // input props object that a caller might later mutate.
  return structuredClone(value) as Record<string, unknown>;
}

function validateClip(value: unknown, index: number, trackPath: string, trackKind: TrackKind): Clip {
  const path = `${trackPath}.clips[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || record["id"].length === 0) {
    throw new Error(`${path}.id must be a non-empty string.`);
  }
  if (typeof record["trackId"] !== "string" || record["trackId"].length === 0) {
    throw new Error(`${path}.trackId must be a non-empty string.`);
  }
  const kind = record["kind"];
  if (typeof kind !== "string" || !CLIP_KINDS.includes(kind as ClipKind)) {
    throw new Error(`${path}.kind must be one of ${CLIP_KINDS.join(", ")}.`);
  }
  const clipKind = kind as ClipKind;
  if (!COMPATIBLE_TRACK_BY_CLIP_KIND[clipKind].includes(trackKind)) {
    throw new Error(`${path}.kind "${clipKind}" is not allowed on ${trackKind} track.`);
  }
  if (record["mediaId"] !== undefined && (typeof record["mediaId"] !== "string" || record["mediaId"].length === 0)) {
    throw new Error(`${path}.mediaId must be a non-empty string when present.`);
  }
  const timelineStartSec = validateNumber(record["timelineStartSec"], `${path}.timelineStartSec`, { min: 0 });
  const durationSec = validateNumber(record["durationSec"], `${path}.durationSec`, { min: 0 });
  if (durationSec! <= 0) {
    throw new Error(`${path}.durationSec must be > 0.`);
  }
  const sourceInSec = validateNumber(record["sourceInSec"], `${path}.sourceInSec`, { min: 0, allowUndefined: true });
  const sourceOutSec = validateNumber(record["sourceOutSec"], `${path}.sourceOutSec`, { min: 0, allowUndefined: true });
  if (sourceInSec !== undefined && sourceOutSec !== undefined && sourceOutSec < sourceInSec) {
    throw new Error(`${path}.sourceOutSec must be >= sourceInSec.`);
  }
  let linkedClipIds: string[] | undefined;
  if (record["linkedClipIds"] !== undefined) {
    if (!isStringArray(record["linkedClipIds"])) {
      throw new Error(`${path}.linkedClipIds must be a string array when present.`);
    }
    linkedClipIds = [...record["linkedClipIds"]];
  }
  const props = validateProps(record["props"], `${path}.props`);
  if (props["fades"] !== undefined && (!validFades(props["fades"]) || Object.keys(props["fades"]).some((key) => !fadeSupported({ kind: clipKind } as Clip, key as FadeKey)))) throw new Error(`${path}.props["fades"] is invalid for this clip.`);
  const base = {
    id: record["id"],
    trackId: record["trackId"],
    timelineStartSec: timelineStartSec!,
    durationSec: durationSec!,
    ...(record["mediaId"] !== undefined ? { mediaId: record["mediaId"] } : {}),
    ...(sourceInSec !== undefined ? { sourceInSec } : {}),
    ...(sourceOutSec !== undefined ? { sourceOutSec } : {}),
    ...(linkedClipIds ? { linkedClipIds } : {}),
    props,
  };
  return { kind: clipKind, ...base } as Clip;
}

function validateTrack(value: unknown, index: number, seqPath: string): Track {
  const path = `${seqPath}.tracks[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["id", "kind", "name", "locked", "muted", "hidden", "order", "clips"].includes(key))) {
    throw new Error(`${path} includes an unsupported field.`);
  }
  if (typeof record["id"] !== "string" || record["id"].length === 0) {
    throw new Error(`${path}.id must be a non-empty string.`);
  }
  const kind = record["kind"];
  if (typeof kind !== "string" || !TRACK_KINDS.includes(kind as TrackKind)) {
    throw new Error(`${path}.kind must be one of ${TRACK_KINDS.join(", ")}.`);
  }
  const trackKind = kind as TrackKind;
  if (record["name"] !== undefined && (typeof record["name"] !== "string" || record["name"].trim().length === 0)) {
    throw new Error(`${path}.name must be a non-empty string when present.`);
  }
  for (const field of ["locked", "muted", "hidden"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "boolean") {
      throw new Error(`${path}.${field} must be a boolean when present.`);
    }
  }
  const order = validateNumber(record["order"], `${path}.order`, { min: 0 });
  if (!Array.isArray(record["clips"])) {
    throw new Error(`${path}.clips must be an array.`);
  }
  const trackId = record["id"];
  const clips = (record["clips"] as unknown[]).map((entry, i) => {
    const clip = validateClip(entry, i, path, trackKind);
    if (clip.trackId !== trackId) {
      throw new Error(`${path}.clips[${i}].trackId must match owning track id.`);
    }
    return clip;
  });
  return {
    id: trackId,
    kind: trackKind,
    ...(typeof record["name"] === "string" ? { name: record["name"].trim() } : {}),
    ...(typeof record["locked"] === "boolean" ? { locked: record["locked"] } : {}),
    ...(typeof record["muted"] === "boolean" ? { muted: record["muted"] } : {}),
    ...(typeof record["hidden"] === "boolean" ? { hidden: record["hidden"] } : {}),
    order: order!,
    clips,
  };
}

function validateSequence(value: unknown, index: number): Sequence {
  const path = `sequences[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || record["id"].length === 0) {
    throw new Error(`${path}.id must be a non-empty string.`);
  }
  const durationSec = validateNumber(record["durationSec"], `${path}.durationSec`, { min: 0 });
  const frameRate = validateFrameRate(record["frameRate"], `${path}.frameRate`);
  if (!Array.isArray(record["tracks"])) {
    throw new Error(`${path}.tracks must be an array.`);
  }
  const tracks = (record["tracks"] as unknown[]).map((entry, i) => validateTrack(entry, i, path));
  const markers = validateMarkers(record["markers"], `${path}.markers`);
  return {
    id: record["id"],
    frameRate,
    durationSec: durationSec!,
    tracks,
    ...(markers ? { markers } : {}),
  };
}

function validateWorkspaceArtifactMediaSource(value: unknown, path: string, ref: string): WorkspaceArtifactMediaSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a Workspace artifact source object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["kind", "artifactId", "path"].includes(key))) {
    throw new Error(`${path} includes an unsupported field.`);
  }
  if (record["kind"] !== "workspace-artifact") {
    throw new Error(`${path}.kind must be "workspace-artifact".`);
  }
  if (typeof record["artifactId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record["artifactId"])) {
    throw new Error(`${path}.artifactId must be a public Workspace artifact UUID.`);
  }
  if (!isProjectRelativeMediaRef(record["path"]) || record["path"] !== ref) {
    throw new Error(`${path}.path must equal the project-relative media ref.`);
  }
  return { kind: "workspace-artifact", artifactId: record["artifactId"], path: record["path"] };
}

function validateMediaAsset(value: unknown, index: number): MediaAsset {
  const path = `media[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, path);
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || record["id"].length === 0) {
    throw new Error(`${path}.id must be a non-empty string.`);
  }
  const kind = record["kind"];
  if (typeof kind !== "string" || !MEDIA_KINDS.includes(kind as MediaKind)) {
    throw new Error(`${path}.kind must be one of ${MEDIA_KINDS.join(", ")}.`);
  }
  if (!isProjectRelativeMediaRef(record["ref"])) {
    throw new Error(`${path}.ref must be a safe project-relative media ref.`);
  }
  const durationSec = validateNumber(record["durationSec"], `${path}.durationSec`, { min: 0, allowUndefined: true });
  const lifecycle = record["lifecycle"];
  if (lifecycle !== undefined && lifecycle !== "local-working" && lifecycle !== "durable") {
    throw new Error(`${path}.lifecycle must be "local-working" or "durable" when present.`);
  }
  const frameRate = record["frameRate"];
  if (frameRate !== undefined && !isFrameRate(frameRate)) {
    throw new Error(`${path}.frameRate must be a positive rational frame rate with safe integer components.`);
  }
  const source = record["source"] === undefined
    ? undefined
    : validateWorkspaceArtifactMediaSource(record["source"], `${path}.source`, record["ref"]);
  if (source !== undefined && lifecycle !== "durable") {
    throw new Error(`${path}.source requires lifecycle "durable".`);
  }
  return {
    id: record["id"],
    kind: kind as MediaKind,
    ref: record["ref"],
    ...(lifecycle !== undefined ? { lifecycle } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(frameRate !== undefined ? { frameRate } : {}),
    ...(typeof record["label"] === "string" && record["label"].length > 0 ? { label: record["label"] } : {}),
  };
}

export function validateVideoProject(value: unknown): VideoProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EDL payload must be an object.");
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, "project");
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (record["version"] !== EDL_VERSION) {
    throw new Error(`Project version must be ${EDL_VERSION}.`);
  }
  if (!Array.isArray(record["sequences"])) {
    throw new Error("Project must include a sequences array.");
  }
  if (record["sequences"].length === 0) {
    throw new Error("Project must include at least one sequence.");
  }
  if (!Array.isArray(record["media"])) {
    throw new Error("Project must include a media array.");
  }
  const sequences = (record["sequences"] as unknown[]).map((entry, i) => validateSequence(entry, i));
  const media = (record["media"] as unknown[]).map((entry, i) => validateMediaAsset(entry, i));
  const invalidTransition = transitionProblem({ version: EDL_VERSION, sequences, media });
  if (invalidTransition) throw new Error(invalidTransition);
  let generatedTakes: GeneratedTake[] | undefined;
  if (record["generatedTakes"] !== undefined) {
    generatedTakes = validateGeneratedTakes(record["generatedTakes"]);
  }
  let generationBrief: GenerationBrief | undefined;
  if (record["generationBrief"] !== undefined) {
    generationBrief = validateGenerationBrief(record["generationBrief"]);
  }
  let metadata: ProjectMetadata | undefined;
  if (record["metadata"] !== undefined) {
    if (!record["metadata"] || typeof record["metadata"] !== "object" || Array.isArray(record["metadata"])) {
      throw new Error("Project metadata must be an object when present.");
    }
    const mdUnsafe = assertSafeObjectKeys(record["metadata"] as Record<string, unknown>, "project.metadata");
    if (mdUnsafe) throw new Error(mdUnsafe);
    metadata = record["metadata"] as ProjectMetadata;
  }
  return {
    version: EDL_VERSION,
    sequences,
    media,
    ...(generatedTakes ? { generatedTakes } : {}),
    ...(generationBrief ? { generationBrief } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function createDefaultManifest(): VideoManifest {
  return {
    documentType: VIDEO_DOCUMENT_TYPE,
    editor: VIDEO_EDITOR,
    payloadId: DEFAULT_VIDEO_EDL_ID,
    payloadFormat: NAUTILO_VIDEO_EDL_TYPE,
    version: VIDEO_HTML_VERSION,
    metadata: {
      createdBy: "nautilo",
      updatedAt: new Date().toISOString(),
    },
  };
}

export function parseVideoHtml(raw: string): VideoHtmlParseResult {
  try {
    const blocks = extractScriptBlocks(raw);
    const executable = blocks.find((block) => {
      const type = block.attrs["type"]?.toLowerCase();
      return !type || type === "text/javascript" || type === "module" || block.attrs["src"];
    });
    if (executable) throw new Error("Video documents must not contain executable script tags.");
    const manifestBlock = findRequiredScript(blocks, NAUTILO_DOCUMENT_MANIFEST_ID, NAUTILO_DOCUMENT_MANIFEST_TYPE);
    const manifest = validateManifest(parseJsonBlock(manifestBlock.content, "Manifest"));
    const payloadBlock = findRequiredScript(blocks, manifest.payloadId, manifest.payloadFormat);
    const project = validateVideoProject(parseJsonBlock(payloadBlock.content, "EDL payload"));
    if (hasProjectFades(project) && manifest.version === "1.0") throw new Error("Fades require Video document version 1.1 or newer.");
    if (hasProjectTransitions(project) && manifest.version !== "1.2") throw new Error("Cut transitions require Video document version 1.2.");
    return { ok: true, document: { manifest, project } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function buildVideoPreviewHtml(project: VideoProject): string {
  const sequence = project.sequences[0]!;
  const trackCount = sequence.tracks.length;
  const clipCount = sequence.tracks.reduce((total, track) => total + track.clips.length, 0);
  const durationSec = computeSequenceDurationSec(sequence);
  const title = escapeHtml(project.metadata?.title ?? "Untitled video");
  return `<main class="nautilo-video-preview">
  <h1>${title}</h1>
  <p>Sequence <code>${escapeHtml(sequence.id)}</code>: ${trackCount} track(s), ${clipCount} clip(s), ${durationSec}s.</p>
  <p>Static preview. Open with Video Timeline to edit.</p>
</main>`;
}

export function serializeVideoHtml(
  manifest: VideoManifest,
  project: VideoProject,
  opts: SerializeVideoHtmlOptions = {},
): string {
  const normalizedProject = validateVideoProject(project);
  const md =
    opts.touchMetadata === true
      ? {
          ...manifest.metadata,
          updatedAt: opts.updatedAt ?? new Date().toISOString(),
        }
      : manifest.metadata;
  const nextManifest: VideoManifest = {
    ...manifest,
    // Older editors reject 1.1 instead of silently playing/exporting without fades.
    version: hasProjectTransitions(normalizedProject) ? "1.2" : hasProjectFades(normalizedProject) && manifest.version === "1.0" ? "1.1" : manifest.version,
    ...(md ? { metadata: md } : {}),
  };
  const manifestJson = escapeScriptJson(JSON.stringify(nextManifest, null, 2));
  const projectJson = escapeScriptJson(JSON.stringify(normalizedProject, null, 2));
  const preview = buildVideoPreviewHtml(normalizedProject);
  const title = escapeHtml(normalizedProject.metadata?.title ?? "Untitled video");
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; color: #0f172a; background: #fff; }
      h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }
      p { color: #64748b; font-size: 0.875rem; }
      code { background: #f1f5f9; padding: 0.05rem 0.25rem; border-radius: 0.25rem; }
    </style>
    <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="${NAUTILO_DOCUMENT_MANIFEST_ID}">
${manifestJson}
    </script>
    <script type="${manifest.payloadFormat}" id="${manifest.payloadId}">
${projectJson}
    </script>
  </head>
  <body>
    ${preview}
  </body>
</html>
`;
  return html;
}

export function createEmptyVideoHtml(): string {
  return serializeVideoHtml(createDefaultManifest(), createEmptyProject());
}
