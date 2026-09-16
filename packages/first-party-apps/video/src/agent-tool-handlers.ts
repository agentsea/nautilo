// Agent tool handlers for the nautilo-video first-party app.
//
// Structural EDL operations use the shared first-party document
// read/parse/mutate/write flow. Rendering and export intentionally remain
// internal `not_implemented` placeholders until the platform proves D385's
// bounded media-preview and allowlisted local-processing path; they are not
// advertised in this app's manifest.

import {
  type VideoDocument,
  type VideoProject,
  type Clip,
} from "./edl";
import {
  parseVideoHtml,
  serializeVideoHtml,
} from "./video-document";
import { inspectProject, summarizeTimelineEdit } from "./timeline-inspection";
import { applyTimelineOperations } from "./timeline-agent-edit";
import { editGenerationScene, inspectGenerationProject, organizeGenerationProject } from "./generation-agent";
import {
  addClip as addClipCommand,
  moveClip as moveClipCommand,
  trimClip as trimClipCommand,
  splitClip as splitClipCommand,
  deleteClip as deleteClipCommand,
  detachAudio as detachAudioCommand,
  updateClipProps as updateClipPropsCommand,
  type AddClipInput,
  type MoveClipInput,
  type TrimClipInput,
  type SplitClipInput,
  type DeleteClipInput,
  type DetachAudioInput,
  type UpdateClipPropsInput,
} from "./commands";

export type AppDocumentTarget =
  | { surface: "workspace"; path: string }
  | { surface: "currentFolder"; relativePath: string };

/** The host binds the live editor; no model-authored document path is accepted. */
export async function controlOpenVideo(args: { command: unknown }, ctx: AgentToolContext): Promise<unknown> {
  return ctx.nautiloApp.session?.command(args.command) ?? { status: "unavailable", stateChanged: false, retrySafe: false };
}

export const reviewOpenVideoGeneration = controlOpenVideo;
export const controlVideoMedia = controlOpenVideo;
export async function inspectVideoMedia(_args: Record<string, never>, ctx: AgentToolContext): Promise<unknown> {
  return controlOpenVideo({ command: { action: "inspect-media" } }, ctx);
}

export async function organizeGeneration(args: { target: AppDocumentTarget; expectedSha256: string; expectedRevision?: number; operations: unknown[] }, ctx: AgentToolContext) {
  const invalid = validateEditRequest(args);
  if (invalid) return invalid;
  return mutateAndPersist(args.target, ctx, project => organizeGenerationProject(project, args.operations),
    { sha256: args.expectedSha256, ...(args.expectedRevision === undefined ? {} : { revision: args.expectedRevision }) });
}

export async function inspectGeneration(args: InspectTimelineArgs, ctx: AgentToolContext) {
  const target = validateAppDocumentTarget(args.target);
  if (!target.ok) return target;
  const parsed = await readAndParse(target.target, ctx);
  if (!parsed.ok) return parsed;
  return { ok: true, version: { sha256: parsed.baseSha256, revision: parsed.baseRevision }, ...inspectGenerationProject(parsed.document.project) };
}

export async function editGeneration(args: { target: AppDocumentTarget; expectedSha256: string; expectedRevision?: number; scene: unknown }, ctx: AgentToolContext) {
  const invalid = validateEditRequest({ ...args, operations: [] });
  if (invalid) return invalid;
  const result = await mutateAndPersist(args.target, ctx, project => editGenerationScene(project, args.scene),
    { sha256: args.expectedSha256, ...(args.expectedRevision === undefined ? {} : { revision: args.expectedRevision }) });
  return result;
}

export type ServerNautiloAppHost = {
  session?: { command(input: unknown): Promise<unknown> };
  document: {
    createFromAction(
      actionId: string,
      opts: {
        targetSurface: "workspace" | "currentFolder";
        filename: string;
        openAfterCreate?: boolean;
      },
    ): Promise<{
      target: AppDocumentTarget;
      displayPath: string;
      opened: boolean;
    }>;
    read(target: AppDocumentTarget): Promise<{
      content: string;
      mimeType: string | null;
      displayPath: string;
      baseSha256: string | null;
      baseRevision: number | null;
    }>;
    write(
      target: AppDocumentTarget,
      next: { content: string },
      opts?: { baseSha256?: string | null; baseRevision?: number | null },
    ): Promise<
      | { kind: "saved"; sha256: string; revision?: number | null; size?: number }
      | { kind: "conflict"; currentSha256: string | null }
      | { kind: "error"; message: string }
    >;
  };
};

export type AgentToolContext = {
  nautiloApp: ServerNautiloAppHost;
};

type ToolError = { ok: false; error: string };

function toolError(message: string): ToolError {
  return { ok: false, error: message };
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function validateBasenameFilename(filename: unknown): string | null {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    return "filename must be a non-empty basename";
  }
  if (filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
    return "filename must be a basename without path separators";
  }
  if (/^[A-Za-z]:[\\/]/.test(filename)) {
    return "filename must not be an absolute path";
  }
  if (hasControlChars(filename)) {
    return "filename must not contain control characters";
  }
  return null;
}

export function validateAppDocumentTarget(
  target: unknown,
): { ok: true; target: AppDocumentTarget } | ToolError {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return toolError("target must be an object");
  }
  const record = target as Record<string, unknown>;
  if (record["surface"] === "workspace") {
    if (typeof record["path"] !== "string" || record["path"].trim().length === 0) {
      return toolError("target.path is required for workspace surface");
    }
    return { ok: true, target: { surface: "workspace", path: record["path"].trim() } };
  }
  if (record["surface"] === "currentFolder") {
    if (typeof record["relativePath"] !== "string" || record["relativePath"].trim().length === 0) {
      return toolError("target.relativePath is required for currentFolder surface");
    }
    const relativePath = record["relativePath"].trim();
    if (
      relativePath.includes("..") ||
      relativePath.startsWith("/") ||
      relativePath.startsWith("\\") ||
      hasControlChars(relativePath)
    ) {
      return toolError("target.relativePath must be a safe relative path");
    }
    return { ok: true, target: { surface: "currentFolder", relativePath } };
  }
  return toolError('target.surface must be "workspace" or "currentFolder"');
}

// ---- createFile (real) ----

export type CreateFileArgs = {
  targetSurface: "workspace" | "currentFolder";
  filename: string;
  openAfterCreate?: boolean;
  initialContent?: "empty";
};

export async function createFile(
  args: CreateFileArgs,
  ctx: AgentToolContext,
): Promise<
  | { ok: true; displayPath: string; target: AppDocumentTarget; opened: boolean }
  | ToolError
> {
  const filenameError = validateBasenameFilename(args.filename);
  if (filenameError) return toolError(filenameError);
  if (args.targetSurface !== "workspace" && args.targetSurface !== "currentFolder") {
    return toolError('targetSurface must be "workspace" or "currentFolder"');
  }
  if (args.initialContent != null && args.initialContent !== "empty") {
    return toolError('initialContent must be "empty" when provided');
  }

  try {
    const result = await ctx.nautiloApp.document.createFromAction("new-video", {
      targetSurface: args.targetSurface,
      filename: args.filename,
      ...(args.openAfterCreate !== undefined ? { openAfterCreate: args.openAfterCreate } : {}),
    });
    return {
      ok: true,
      displayPath: result.displayPath,
      target: result.target,
      opened: result.opened,
    };
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

// ---- shared read/parse helper ----

type ParsedDocument = {
  ok: true;
  document: VideoDocument;
  displayPath: string;
  baseSha256: string | null;
  baseRevision: number | null;
} | ToolError;

async function readAndParse(
  target: AppDocumentTarget,
  ctx: AgentToolContext,
): Promise<ParsedDocument> {
  let envelope;
  try {
    envelope = await ctx.nautiloApp.document.read(target);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
  const parsed = parseVideoHtml(envelope.content);
  if (!parsed.ok) return toolError(parsed.error);
  return {
    ok: true,
    document: parsed.document,
    displayPath: envelope.displayPath,
    baseSha256: envelope.baseSha256,
    baseRevision: envelope.baseRevision,
  };
}

// Shared mutation-result shape for first-party document tools.
export type MutationSaved = {
  ok: true;
  status: "saved";
  displayPath: string;
  sha256: string;
  revision?: number | null;
};
export type MutationConflict = {
  ok: true;
  status: "conflict";
  displayPath: string;
  currentSha256: string | null;
};
export type MutationWriteError = {
  ok: true;
  status: "error";
  displayPath: string;
  message: string;
};
export type MutationResult = MutationSaved | MutationConflict | MutationWriteError | ToolError;

/**
 * Read-parse-mutate-serialize-write pipeline shared by every mutating handler.
 * `mutate` runs against the parsed VideoProject and must return either a
 * `{ok:true,project}` from `commands.ts` or a `{ok:false,error}`. On success
 * we re-serialize the document and write with optimistic-concurrency tokens
 * captured at read time. Uses compare-and-swap semantics for
 * saved / conflict / error / tool-error outcomes.
 */
async function mutateAndPersist(
  target: AppDocumentTarget,
  ctx: AgentToolContext,
  mutate: (project: VideoProject, manifest: VideoDocument["manifest"]) =>
    | { ok: true; project: VideoProject }
    | { ok: false; error: string },
  expected?: { sha256: string; revision?: number },
): Promise<MutationResult> {
  const parsed = await readAndParse(target, ctx);
  if (!parsed.ok) return parsed;

  if (expected && (parsed.baseSha256 !== expected.sha256 || (expected.revision !== undefined && parsed.baseRevision !== expected.revision))) {
    return { ok: true, status: "conflict", displayPath: parsed.displayPath, currentSha256: parsed.baseSha256 };
  }

  const mutation = mutate(parsed.document.project, parsed.document.manifest);
  if (!mutation.ok) return toolError(mutation.error);

  let content: string;
  try {
    content = serializeVideoHtml(parsed.document.manifest, mutation.project, {
      touchMetadata: true,
    });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }

  let writeResult;
  try {
    writeResult = await ctx.nautiloApp.document.write(
      target,
      { content },
      {
        baseSha256: parsed.baseSha256,
        baseRevision: parsed.baseRevision,
      },
    );
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }

  if (writeResult.kind === "conflict") {
    return {
      ok: true,
      status: "conflict",
      displayPath: parsed.displayPath,
      currentSha256: writeResult.currentSha256,
    };
  }
  if (writeResult.kind === "error") {
    return {
      ok: true,
      status: "error",
      displayPath: parsed.displayPath,
      message: writeResult.message,
    };
  }
  return {
    ok: true,
    status: "saved",
    displayPath: parsed.displayPath,
    sha256: writeResult.sha256,
    revision: writeResult.revision ?? null,
  };
}

// ---- inspectTimeline (real, read-only) ----

export type InspectTimelineArgs = {
  target: AppDocumentTarget;
  includeClips?: boolean;
};

export type InspectTimelineResult = ({ ok: true; displayPath: string; version: { sha256: string | null; revision: number | null } } & ReturnType<typeof inspectProject>) | ToolError;

export async function inspectTimeline(
  args: InspectTimelineArgs,
  ctx: AgentToolContext,
): Promise<InspectTimelineResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const target = targetResult.target;

  const parsed = await readAndParse(target, ctx);
  if (!parsed.ok) return parsed;

  return { ok: true, displayPath: parsed.displayPath, version: { sha256: parsed.baseSha256, revision: parsed.baseRevision }, ...inspectProject(parsed.document.project, args.includeClips === true) };
}

export type EditTimelineArgs = { target: AppDocumentTarget; expectedSha256: string; expectedRevision?: number; operations: unknown };

function validateEditRequest(args: EditTimelineArgs): ToolError | null {
  const target = validateAppDocumentTarget(args.target);
  if (!target.ok) return target;
  if (typeof args.expectedSha256 !== "string" || !args.expectedSha256.trim()) return toolError("Inspect the timeline first and provide its expectedSha256.");
  if (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)) return toolError("expectedRevision must be a non-negative integer.");
  return null;
}

/** Dry-run the exact command batch. This is a structural plan, not a rendered video. */
export async function previewTimelineEdit(args: EditTimelineArgs, ctx: AgentToolContext) {
  const invalid = validateEditRequest(args);
  if (invalid) return invalid;
  const parsed = await readAndParse(args.target, ctx);
  if (!parsed.ok) return parsed;
  if (parsed.baseSha256 !== args.expectedSha256 || (args.expectedRevision !== undefined && parsed.baseRevision !== args.expectedRevision)) return { ok: true as const, status: "conflict" as const, stateChanged: false, currentSha256: parsed.baseSha256 };
  const result = applyTimelineOperations(parsed.document.project, args.operations);
  if (!result.ok) return result;
  // Dry run includes the exact serialization/format gate used by Apply.
  try { serializeVideoHtml(parsed.document.manifest, result.project); }
  catch (error) { return toolError(error instanceof Error ? error.message : String(error)); }
  return { ok: true as const, status: "preview" as const, stateChanged: false, generatedIdsAreProvisional: true, expectedSha256: args.expectedSha256, summary: summarizeTimelineEdit(parsed.document.project, result.project) };
}

/** One approved batch becomes one ordinary authored document write/receipt. */
export async function editTimeline(args: EditTimelineArgs, ctx: AgentToolContext) {
  const invalid = validateEditRequest(args);
  if (invalid) return invalid;
  let summary: ReturnType<typeof summarizeTimelineEdit> | undefined;
  const result = await mutateAndPersist(args.target, ctx, (project) => {
    const edited = applyTimelineOperations(project, args.operations);
    if (edited.ok) summary = summarizeTimelineEdit(project, edited.project);
    return edited;
  }, { sha256: args.expectedSha256, ...(args.expectedRevision !== undefined ? { revision: args.expectedRevision } : {}) });
  return result.ok && result.status === "saved" ? { ...result, summary } : result;
}

// ---- structural mutating handlers ----
//
// Each mutating handler validates the target + args, then runs the shared
// read-parse-mutate-serialize-write pipeline (`mutateAndPersist`) against the
// committed pure command from `./commands`. Optimistic-concurrency tokens
// (baseSha256/baseRevision) captured at read time are passed to `write`, so a
// stale read surfaces as `{ok:true,status:"conflict",currentSha256}` exactly
// through the same compare-and-swap write path.

function validateClipId(clipId: unknown): string | null {
  if (typeof clipId !== "string" || clipId.trim().length === 0) {
    return "clipId must be a non-empty string";
  }
  return null;
}

function validateTrackId(trackId: unknown): string | null {
  if (typeof trackId !== "string" || trackId.trim().length === 0) {
    return "trackId must be a non-empty string";
  }
  return null;
}

export type AddClipArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
  trackId: string;
  clip: {
    kind: "video" | "audio" | "image" | "text" | "caption" | "callout";
    mediaId?: string;
    timelineStartSec: number;
    durationSec: number;
    sourceInSec?: number;
    sourceOutSec?: number;
    props?: Record<string, unknown>;
  };
};

export async function addClip(args: AddClipArgs, ctx: AgentToolContext): Promise<MutationResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const trackIdError = validateTrackId(args.trackId);
  if (trackIdError) return toolError(trackIdError);
  if (!args.clip || typeof args.clip.kind !== "string") {
    return toolError("clip.kind must be one of video, audio, image, text, caption, callout");
  }
  if (args.clip.mediaId !== undefined && (typeof args.clip.mediaId !== "string" || args.clip.mediaId.length === 0)) {
    return toolError("clip.mediaId must be a non-empty string when present");
  }
  if (args.clip.props !== undefined && (typeof args.clip.props !== "object" || args.clip.props === null || Array.isArray(args.clip.props))) {
    return toolError("clip.props must be an object when present");
  }

  const input: AddClipInput = {
    trackId: args.trackId,
    kind: args.clip.kind,
    timelineStartSec: args.clip.timelineStartSec,
    durationSec: args.clip.durationSec,
    ...(args.sequenceId !== undefined ? { sequenceId: args.sequenceId } : {}),
    ...(args.clip.mediaId !== undefined ? { mediaId: args.clip.mediaId } : {}),
    ...(args.clip.sourceInSec !== undefined ? { sourceInSec: args.clip.sourceInSec } : {}),
    ...(args.clip.sourceOutSec !== undefined ? { sourceOutSec: args.clip.sourceOutSec } : {}),
    ...(args.clip.props !== undefined ? { props: args.clip.props } : {}),
  };

  return mutateAndPersist(args.target, ctx, (project) => addClipCommand(project, input));
}

export type MoveClipArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
  clipId: string;
  toTrackId?: string;
  timelineStartSec?: number;
};

export async function moveClip(args: MoveClipArgs, ctx: AgentToolContext): Promise<MutationResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const clipIdError = validateClipId(args.clipId);
  if (clipIdError) return toolError(clipIdError);
  if (args.toTrackId !== undefined) {
    const trackIdError = validateTrackId(args.toTrackId);
    if (trackIdError) return toolError(trackIdError);
  }

  const input: MoveClipInput = {
    clipId: args.clipId,
    ...(args.sequenceId !== undefined ? { sequenceId: args.sequenceId } : {}),
    ...(args.toTrackId !== undefined ? { toTrackId: args.toTrackId } : {}),
    ...(args.timelineStartSec !== undefined ? { timelineStartSec: args.timelineStartSec } : {}),
  };

  return mutateAndPersist(args.target, ctx, (project) => moveClipCommand(project, input));
}

export type TrimClipArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
  clipId: string;
  sourceInSec?: number;
  sourceOutSec?: number;
  durationSec?: number;
};

export async function trimClip(args: TrimClipArgs, ctx: AgentToolContext): Promise<MutationResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const clipIdError = validateClipId(args.clipId);
  if (clipIdError) return toolError(clipIdError);

  const input: TrimClipInput = {
    clipId: args.clipId,
    ...(args.sequenceId !== undefined ? { sequenceId: args.sequenceId } : {}),
    ...(args.sourceInSec !== undefined ? { sourceInSec: args.sourceInSec } : {}),
    ...(args.sourceOutSec !== undefined ? { sourceOutSec: args.sourceOutSec } : {}),
    ...(args.durationSec !== undefined ? { durationSec: args.durationSec } : {}),
  };

  return mutateAndPersist(args.target, ctx, (project) => trimClipCommand(project, input));
}

export type SplitClipArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
  clipId: string;
  atSec: number;
};

export async function splitClip(args: SplitClipArgs, ctx: AgentToolContext): Promise<MutationResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const clipIdError = validateClipId(args.clipId);
  if (clipIdError) return toolError(clipIdError);
  if (typeof args.atSec !== "number" || !Number.isFinite(args.atSec) || args.atSec < 0) {
    return toolError("atSec must be a non-negative finite number");
  }

  const input: SplitClipInput = {
    clipId: args.clipId,
    atSec: args.atSec,
    ...(args.sequenceId !== undefined ? { sequenceId: args.sequenceId } : {}),
  };

  return mutateAndPersist(args.target, ctx, (project) => splitClipCommand(project, input));
}

export type DeleteClipArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
  clipId: string;
};

export async function deleteClip(args: DeleteClipArgs, ctx: AgentToolContext): Promise<MutationResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const clipIdError = validateClipId(args.clipId);
  if (clipIdError) return toolError(clipIdError);

  const input: DeleteClipInput = {
    clipId: args.clipId,
    ...(args.sequenceId !== undefined ? { sequenceId: args.sequenceId } : {}),
  };

  return mutateAndPersist(args.target, ctx, (project) => deleteClipCommand(project, input));
}

export type DetachAudioArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
  clipId: string;
  toTrackId?: string;
};

export async function detachAudio(args: DetachAudioArgs, ctx: AgentToolContext): Promise<MutationResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const clipIdError = validateClipId(args.clipId);
  if (clipIdError) return toolError(clipIdError);
  if (args.toTrackId !== undefined) {
    const trackIdError = validateTrackId(args.toTrackId);
    if (trackIdError) return toolError(trackIdError);
  }

  const input: DetachAudioInput = {
    clipId: args.clipId,
    ...(args.sequenceId !== undefined ? { sequenceId: args.sequenceId } : {}),
    ...(args.toTrackId !== undefined ? { toTrackId: args.toTrackId } : {}),
  };

  return mutateAndPersist(args.target, ctx, (project) => detachAudioCommand(project, input));
}

export type ReplaceCaptionTextArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
  clipId: string;
  text: string;
};

export async function replaceCaptionText(
  args: ReplaceCaptionTextArgs,
  ctx: AgentToolContext,
): Promise<MutationResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const clipIdError = validateClipId(args.clipId);
  if (clipIdError) return toolError(clipIdError);
  if (typeof args.text !== "string") {
    return toolError("text must be a string");
  }

  const input: UpdateClipPropsInput = {
    clipId: args.clipId,
    props: { text: args.text },
    ...(args.sequenceId !== undefined ? { sequenceId: args.sequenceId } : {}),
  };

  return mutateAndPersist(args.target, ctx, (project) => {
    // Enforce caption-kind: replaceCaptionText may only target caption clips.
    const seq = project.sequences[0];
    if (!seq) return { ok: false, error: "Project has no sequences." };
    const sequence = args.sequenceId
      ? project.sequences.find((s) => s.id === args.sequenceId)
      : seq;
    if (!sequence) return { ok: false, error: `Sequence not found: ${args.sequenceId}` };
    let found: Clip | undefined;
    for (const track of sequence.tracks) {
      const clip = track.clips.find((c) => c.id === args.clipId);
      if (clip) {
        found = clip;
        break;
      }
    }
    if (!found) return { ok: false, error: `Clip not found: ${args.clipId}` };
    if (found.kind !== "caption") {
      return { ok: false, error: `replaceCaptionText requires a caption clip; clip ${args.clipId} is kind "${found.kind}".` };
    }
    return updateClipPropsCommand(project, input);
  });
}

export type AddOverlayArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
  trackId: string;
  clip: {
    kind: "text" | "callout" | "image";
    timelineStartSec: number;
    durationSec: number;
    props?: Record<string, unknown>;
  };
};

export async function addOverlay(args: AddOverlayArgs, ctx: AgentToolContext): Promise<MutationResult> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return targetResult;
  const trackIdError = validateTrackId(args.trackId);
  if (trackIdError) return toolError(trackIdError);
  if (!args.clip || typeof args.clip.kind !== "string") {
    return toolError("clip.kind must be one of text, callout, image");
  }
  if (args.clip.props !== undefined && (typeof args.clip.props !== "object" || args.clip.props === null || Array.isArray(args.clip.props))) {
    return toolError("clip.props must be an object when present");
  }

  const input: AddClipInput = {
    trackId: args.trackId,
    kind: args.clip.kind,
    timelineStartSec: args.clip.timelineStartSec,
    durationSec: args.clip.durationSec,
    ...(args.sequenceId !== undefined ? { sequenceId: args.sequenceId } : {}),
    ...(args.clip.props !== undefined ? { props: args.clip.props } : {}),
  };

  // addClipCommand enforces track-kind compatibility; overlay kinds (text,
  // callout, image) are only allowed on overlay tracks per edl.ts.
  return mutateAndPersist(args.target, ctx, (project) => addClipCommand(project, input));
}

// ---- renderPreview / exportVideo ----
//
// These two handlers are intentionally `not_implemented` placeholders. Real
// server-side render/export orchestration lands in a later phase. The
// response shape below is STABLE and MUST NOT change once external callers
// depend on it:
//   - on a valid target + host: `{ ok:true, status:"not_implemented" }`
//   - on invalid target / missing host: `{ ok:false, error:string }`
// Future real implementations will return a richer `{ ok:true, status:"queued"
// |"rendered", ... }` shape; the placeholder exists so callers can detect
// "not yet wired" without a hard error.

export type RenderPreviewArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
};

export function renderPreview(
  args: RenderPreviewArgs,
  ctx: AgentToolContext,
): Promise<{ ok: true; status: "not_implemented" } | ToolError> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return Promise.resolve(targetResult);
  if (!ctx.nautiloApp?.document) return Promise.resolve(toolError("missing nautiloApp host"));
  return Promise.resolve({ ok: true, status: "not_implemented" });
}

export type ExportVideoArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
  preset?: string;
};

export function exportVideo(
  args: ExportVideoArgs,
  ctx: AgentToolContext,
): Promise<{ ok: true; status: "not_implemented" } | ToolError> {
  const targetResult = validateAppDocumentTarget(args.target);
  if (!targetResult.ok) return Promise.resolve(targetResult);
  if (!ctx.nautiloApp?.document) return Promise.resolve(toolError("missing nautiloApp host"));
  return Promise.resolve({ ok: true, status: "not_implemented" });
}

export type LinkClipsArgs = {
  target: AppDocumentTarget;
  sequenceId?: string;
  clipIds: string[];
};

export async function linkClips(args: LinkClipsArgs, ctx: AgentToolContext): Promise<MutationResult> {
  const target = validateAppDocumentTarget(args.target);
  if (!target.ok) return target;
  return mutateAndPersist(args.target, ctx, (project) => {
    if (args.sequenceId !== undefined && args.sequenceId !== project.sequences[0]?.id) return toolError("Choose the active sequence.");
    return applyTimelineOperations(project, [{ op: "links", mode: "link", clipIds: args.clipIds }]);
  });
}

export async function unlinkClips(args: LinkClipsArgs, ctx: AgentToolContext): Promise<MutationResult> {
  const target = validateAppDocumentTarget(args.target);
  if (!target.ok) return target;
  return mutateAndPersist(args.target, ctx, (project) => {
    if (args.sequenceId !== undefined && args.sequenceId !== project.sequences[0]?.id) return toolError("Choose the active sequence.");
    return applyTimelineOperations(project, [{ op: "links", mode: "unlink", clipIds: args.clipIds }]);
  });
}

// Re-export helpers used by consumers / tests.
export { parseVideoHtml, serializeVideoHtml };
export type { VideoDocument, VideoProject };
