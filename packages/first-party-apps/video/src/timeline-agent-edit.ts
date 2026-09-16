/** Data-only adapters over the human editor's command kernel. No media authority,
 * clipboard store, render service, or alternative persistence path lives here. */
import * as commands from "./commands";
import { findClip, type VideoProject } from "./edl";

type Field = { type: "string" | "number" | "boolean" | "array"; enum?: readonly string[]; items?: { type: "string" }; minLength?: number };
const id: Field = { type: "string", minLength: 1 };
const text: Field = { type: "string" };
const number: Field = { type: "number" };
const boolean: Field = { type: "boolean" };
const ids: Field = { type: "array", items: { type: "string" } };
const choice = (...values: string[]): Field => ({ type: "string", enum: values });
const selection = { clipIds: ids, inSec: number, outSec: number };
const definitions: Record<string, { fields: Record<string, Field>; required: string[] }> = {
  "add-track": { fields: { trackId: id, beforeTrackId: id, name: id }, required: [] },
  "update-track": { fields: { trackId: id, name: id, hidden: boolean, muted: boolean, locked: boolean }, required: ["trackId"] },
  "delete-track": { fields: { trackId: id }, required: ["trackId"] },
  "reorder-track": { fields: { trackId: id, destinationIndex: number }, required: ["trackId", "destinationIndex"] },
  "add-clip": { fields: { trackId: id, kind: choice("video", "audio", "image", "text", "caption", "callout"), mediaId: id, timelineStartSec: number, durationSec: number, sourceInSec: number, sourceOutSec: number, text }, required: ["trackId", "kind", "timelineStartSec", "durationSec"] },
  "move-clip": { fields: { clipId: id, toTrackId: id, timelineStartSec: number }, required: ["clipId"] },
  "move-group": { fields: { clipIds: ids, anchorClipId: id, toTrackId: id, timelineStartSec: number }, required: ["clipIds", "anchorClipId", "toTrackId", "timelineStartSec"] },
  "split-clip": { fields: { clipId: id, atSec: number }, required: ["clipId", "atSec"] },
  "trim-clip": { fields: { clipId: id, sourceInSec: number, sourceOutSec: number, timelineStartSec: number, durationSec: number }, required: ["clipId"] },
  "delete-clip": { fields: { clipId: id }, required: ["clipId"] },
  "detach-audio": { fields: { clipId: id, toTrackId: id }, required: ["clipId"] },
  "link-clips": { fields: { clipIds: ids }, required: ["clipIds"] },
  "unlink-clips": { fields: { clipIds: ids }, required: ["clipIds"] },
  "set-text": { fields: { clipId: id, text }, required: ["clipId", "text"] },
  "set-clip-audio": { fields: { clipId: id, muted: boolean, volume: number }, required: ["clipId"] },
  "set-fade": { fields: { clipId: id, key: choice("videoIn", "videoOut", "audioIn", "audioOut"), durationSec: number, linkedAudio: boolean }, required: ["clipId", "key", "durationSec"] },
  "set-transition": { fields: { clipId: id, kind: choice("crossfade", "swipe"), direction: choice("left", "right", "up", "down"), durationSec: number }, required: ["clipId", "kind", "direction", "durationSec"] },
  "delete-selection": { fields: selection, required: [] },
  "copy-selection": { fields: { ...selection, destinationSec: number }, required: ["destinationSec"] },
  "move-selection": { fields: { ...selection, destinationSec: number }, required: ["destinationSec"] },
};

/** The manifest must contain this exact closed schema (checked in tests). */
const groupedActions = ["add-track", "update-track", "delete-track", "reorder-track", "link-clips", "unlink-clips"];
const branch = (op: string, fields: Record<string, Field>, required: string[]) => ({
  type: "object", additionalProperties: false,
  properties: { op: { type: "string", const: op }, ...fields }, required: ["op", ...required],
});
export const TIMELINE_EDIT_ACTIONS = Object.keys(definitions);
export const TIMELINE_EDIT_OPERATIONS_SCHEMA = {
  type: "array", minItems: 1,
  items: { oneOf: [
    branch("track", { mode: choice("add", "update", "delete", "reorder"), ...groupedActions.filter((action) => action.endsWith("-track")).reduce<Record<string, Field>>((fields, action) => ({ ...fields, ...definitions[action]!.fields }), {}) }, ["mode"]),
    branch("links", { mode: choice("link", "unlink"), clipIds: ids }, ["mode", "clipIds"]),
    ...Object.entries(definitions).filter(([action]) => !groupedActions.includes(action)).map(([action, definition]) => branch(action, definition.fields, definition.required)),
  ] },
};

function normalizeOperation(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { op, mode, ...fields } = value as Record<string, unknown>;
  if (Object.hasOwn(fields, "action")) return null;
  if (op === "track") {
    if (typeof mode !== "string" || !["add", "update", "delete", "reorder"].includes(mode)) return null;
    return { action: `${mode}-track`, ...fields };
  }
  if (op === "links") {
    if (mode !== "link" && mode !== "unlink") return null;
    return { action: `${mode}-clips`, ...fields };
  }
  if (mode !== undefined || groupedActions.includes(op as string)) return null;
  return { action: op, ...fields };
}

function validateOperation(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Expected an edit operation.";
  const operation = value as Record<string, unknown>;
  const action = operation["action"];
  if (typeof action !== "string" || !Object.hasOwn(definitions, action)) return "Unknown timeline action.";
  const definition = definitions[action]!;
  for (const key of Object.keys(operation)) if (key !== "action" && !Object.hasOwn(definition.fields, key)) return `Unsupported field: ${key}.`;
  for (const key of definition.required) if (operation[key] === undefined) return `Missing field: ${key}.`;
  for (const [key, field] of Object.entries(definition.fields)) {
    const v = operation[key];
    if (v === undefined) continue;
    if (field.type === "array" ? !Array.isArray(v) || !v.every((item) => typeof item === "string" && item.trim().length > 0)
      : typeof v !== field.type || (field.type === "number" && !Number.isFinite(v))
        || (field.minLength && typeof v === "string" && !v.trim().length)
        || (field.enum && !field.enum.includes(v as string))) return `Invalid field: ${key}.`;
  }
  return null;
}

function applyOperation(project: VideoProject, raw: Record<string, unknown>): commands.CommandResult<VideoProject> {
  // Flat operation fields are validated above and then checked by the same
  // commands as gestures. The command never receives arbitrary props or refs.
  const { action, ...input } = raw;
  switch (action) {
    case "add-track": {
      const result = commands.addTrack(project, { kind: "video", ...(input["trackId"] ? { id: input["trackId"] as string } : {}), ...(input["beforeTrackId"] ? { beforeTrackId: input["beforeTrackId"] as string } : {}) });
      if (!result.ok || !input["name"]) return result;
      const oldIds = new Set(project.sequences[0]!.tracks.map((track) => track.id));
      const track = result.project.sequences[0]!.tracks.find((track) => !oldIds.has(track.id))!;
      return commands.updateTrack(result.project, { trackId: track.id, name: input["name"] as string });
    }
    case "update-track": return commands.updateTrack(project, input as commands.UpdateTrackInput);
    case "delete-track": return commands.deleteTrack(project, input as commands.DeleteTrackInput);
    case "reorder-track": return commands.reorderTrack(project, input as commands.ReorderTrackInput);
    case "add-clip": {
      const kind = input["kind"] as commands.AddClipInput["kind"];
      const mediaId = input["mediaId"] as string | undefined;
      const media = project.media.find((asset) => asset.id === mediaId && (asset.kind === kind || (kind === "audio" && asset.kind === "video")));
      if (["video", "audio", "image"].includes(kind) && !media) return { ok: false, error: "Choose matching existing Media Bin media. Importing requires the host media bridge." };
      if (["video", "audio"].includes(kind) && (typeof media?.durationSec !== "number" || !Number.isFinite(media.durationSec) || media.durationSec <= 0)) return { ok: false, error: "Source duration is unmeasured. Restore/probe this media through the host before placing it." };
      const { text: content, ...clip } = input;
      if (["text", "caption", "callout"].includes(kind) ? typeof content !== "string" : content !== undefined) return { ok: false, error: "Text is required only for a text, caption or callout clip." };
      return commands.addClip(project, { ...clip, props: content === undefined ? {} : { text: content } } as commands.AddClipInput);
    }
    case "move-clip": return commands.moveClip(project, input as commands.MoveClipInput);
    case "move-group": return commands.moveClipGroup(project, input as commands.MoveClipGroupInput);
    case "trim-clip": return commands.trimClip(project, input as commands.TrimClipInput);
    case "split-clip": return commands.splitClip(project, input as commands.SplitClipInput);
    case "delete-clip": return commands.deleteClip(project, input as commands.DeleteClipInput);
    case "detach-audio": return commands.detachAudio(project, input as commands.DetachAudioInput);
    case "link-clips": case "unlink-clips": {
      const clipIds = input["clipIds"] as string[];
      if (new Set(clipIds).size < 2 || clipIds.some((id) => !findClip(project.sequences[0]!, id))) return { ok: false, error: "Choose at least two distinct existing clips." };
      return action === "link-clips" ? commands.linkClips(project, { clipIds }) : commands.unlinkClips(project, { clipIds });
    }
    case "set-text": case "set-clip-audio": {
      const clipId = input["clipId"] as string;
      const found = findClip(project.sequences[0]!, clipId);
      if (!found || found.track.hidden || found.track.locked) return { ok: false, error: "Select an existing visible, unlocked clip." };
      const { clipId: _clipId, ...props } = input;
      if (action === "set-text" && !["text", "caption", "callout"].includes(found.clip.kind)) return { ok: false, error: "This clip does not contain editable text." };
      if (action === "set-clip-audio" && (!["video", "audio"].includes(found.clip.kind) || !Object.keys(props).length || (props["volume"] !== undefined && ((props["volume"] as number) < 0 || (props["volume"] as number) > 1)))) return { ok: false, error: "Audio controls require a video/audio clip and muted or volume (0 to 1)." };
      return commands.updateClipProps(project, { clipId, props });
    }
    case "set-fade": return commands.setClipFade(project, input as Parameters<typeof commands.setClipFade>[1]);
    case "set-transition": return commands.setCutTransition(project, input as Parameters<typeof commands.setCutTransition>[1]);
    case "delete-selection": case "copy-selection": case "move-selection": {
      if ((input["inSec"] === undefined) !== (input["outSec"] === undefined)) return { ok: false, error: "A range requires both inSec and outSec." };
      const selection: commands.TimelineSelection = { clipIds: input["clipIds"] as string[] ?? [], ...(input["inSec"] === undefined ? {} : { range: { inSec: input["inSec"] as number, outSec: input["outSec"] as number } }) };
      if (action === "delete-selection") return commands.removeTimelineSelection(project, selection);
      const copy = commands.copyTimelineSelection(project, selection);
      if (!copy.ok) return copy;
      const removed = action === "move-selection" ? commands.removeTimelineSelection(project, selection) : { ok: true as const, project };
      if (!removed.ok) return removed;
      return commands.pasteTimelineClipboard(removed.project, copy.clipboard, input["destinationSec"] as number);
    }
    default: return { ok: false, error: "Unknown timeline action." };
  }
}

/** No writes until every operation succeeds. A failed paste also rolls back its
 * preceding cut; clipboard payloads never leave this transaction. */
export function applyTimelineOperations(project: VideoProject, operations: unknown): commands.CommandResult<VideoProject> {
  if (!Array.isArray(operations) || !operations.length) return { ok: false, error: "Provide at least one timeline operation." };
  let next = project;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = normalizeOperation(operations[index]);
    const problem = validateOperation(operation);
    if (problem) return { ok: false, error: `Operation ${index + 1}: ${problem}` };
    const result = applyOperation(next, operation!);
    if (!result.ok) return { ok: false, error: `Operation ${index + 1}: ${result.error}` };
    next = result.project;
  }
  return { ok: true, project: next };
}
