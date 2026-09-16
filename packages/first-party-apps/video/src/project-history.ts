import type { VideoProject } from "./edl";
import { computeSequenceDurationSec, detectTrackTimingViolations } from "./timing";
import { validateVideoProject } from "./video-document";

type Path = readonly string[];

type Change = {
  path: Path;
  before: unknown;
  after: unknown;
};

export type VideoProjectMergeResult =
  | { ok: true; project: VideoProject }
  | { ok: false; reason: string };

export type VideoProjectHistoryResult = VideoProjectMergeResult & {
  direction?: "undo" | "redo";
};

export type VideoProjectHistoryState = Readonly<{
  canUndo: boolean;
  canRedo: boolean;
}>;

type HistoryEntry = Readonly<{
  before: VideoProject;
  after: VideoProject;
}>;

const clone = <T>(value: T): T => structuredClone(value);

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function containsMediaReference(value: unknown, mediaId: string): boolean {
  return (JSON.stringify(value) ?? "").includes(`"mediaId":${JSON.stringify(mediaId)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEntityArray(value: unknown[]): boolean {
  return value.every((entry) => isRecord(entry) && typeof entry["id"] === "string");
}

function orderedEntityIds(value: unknown[]): string[] {
  return value.map((entry) => (entry as { id: string }).id);
}

function overlapReason(path: Path): string {
  const field = path.at(-1);
  if (path.some((part) => part.startsWith("clips#"))) {
    if (["timelineStartSec", "durationSec", "sourceInSec", "sourceOutSec", "trackId"].includes(field ?? "")) {
      return "This clip's position or timing changed elsewhere. Nothing was overwritten.";
    }
    return "This clip changed elsewhere. Nothing was overwritten.";
  }
  if (path.some((part) => part.startsWith("tracks#"))) return "This track changed elsewhere. Nothing was overwritten.";
  if (path.includes("blocks") || path.includes("shots")) return "The generation brief order or content changed elsewhere. Nothing was overwritten.";
  if (path.includes("media")) return "This media item changed elsewhere. Nothing was overwritten.";
  if (field === "title") return "The project title changed elsewhere. Nothing was overwritten.";
  return "This part of the project changed elsewhere. Nothing was overwritten.";
}

function shouldIgnoreDerivedField(path: Path): boolean {
  if (path.at(-1) === "updatedAt") return true;
  return path.at(-1) === "durationSec" && path.at(-2)?.startsWith("sequences#") === true;
}

function diff(before: unknown, after: unknown, path: Path = []): Change[] {
  if (equal(before, after) || shouldIgnoreDerivedField(path)) return [];
  if (path.at(-1) === "metadata") {
    const withoutTimestamp = (value: unknown): Record<string, unknown> => {
      if (!isRecord(value)) return {};
      const { updatedAt: _ignored, ...rest } = value;
      return rest;
    };
    const prior = withoutTimestamp(before);
    const next = withoutTimestamp(after);
    if (equal(prior, next)) return [];
    const changes: Change[] = [];
    for (const key of new Set([...Object.keys(prior), ...Object.keys(next)])) {
      changes.push(...diff(prior[key], next[key], [...path, key]));
    }
    return changes;
  }
  if (Array.isArray(before) && Array.isArray(after) && isEntityArray(before) && isEntityArray(after)) {
    const ordered = path.at(-1) === "blocks" || path.at(-1) === "shots";
    if (ordered && !equal(orderedEntityIds(before), orderedEntityIds(after))) {
      return [{ path, before: clone(before), after: clone(after) }];
    }
    const beforeById = new Map(before.map((entry) => [(entry as { id: string }).id, entry]));
    const afterById = new Map(after.map((entry) => [(entry as { id: string }).id, entry]));
    const changes: Change[] = [];
    for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
      const nextPath = [...path, `${path.at(-1) ?? "entity"}#${id}`];
      if (!beforeById.has(id) || !afterById.has(id)) {
        changes.push({ path: nextPath, before: clone(beforeById.get(id)), after: clone(afterById.get(id)) });
      } else {
        changes.push(...diff(beforeById.get(id), afterById.get(id), nextPath));
      }
    }
    return changes;
  }
  if (isRecord(before) && isRecord(after)) {
    const changes: Change[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      changes.push(...diff(before[key], after[key], [...path, key]));
    }
    return changes;
  }
  return [{ path, before: clone(before), after: clone(after) }];
}

function pathsOverlap(left: Path, right: Path): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function entityId(part: string): string | null {
  const separator = part.indexOf("#");
  return separator < 0 ? null : part.slice(separator + 1);
}

function applyChange(root: unknown, change: Change): void {
  let parent = root as Record<string, unknown> | unknown[];
  for (let index = 0; index < change.path.length - 1; index += 1) {
    const part = change.path[index]!;
    const id = entityId(part);
    if (id !== null) {
      if (!Array.isArray(parent)) throw new Error("A changed item can no longer be located.");
      const found = parent.find((entry) => isRecord(entry) && entry["id"] === id);
      if (!found) throw new Error(`Entity ${id} no longer exists.`);
      parent = found as Record<string, unknown>;
    } else {
      if (!isRecord(parent)) throw new Error("A changed item can no longer be located.");
      if (parent[part] === undefined) {
        parent[part] = entityId(change.path[index + 1] ?? "") !== null ? [] : {};
      }
      parent = parent[part] as Record<string, unknown> | unknown[];
    }
  }
  const finalPart = change.path.at(-1);
  if (!finalPart) throw new Error("A whole-project replacement is unsafe.");
  const id = entityId(finalPart);
  if (id !== null) {
    if (!Array.isArray(parent)) throw new Error("A changed item can no longer be located.");
    const foundIndex = parent.findIndex((entry) => isRecord(entry) && entry["id"] === id);
    if (change.after === undefined) {
      if (foundIndex < 0) throw new Error(`Entity ${id} no longer exists.`);
      parent.splice(foundIndex, 1);
    } else if (foundIndex < 0) {
      parent.push(clone(change.after));
    } else {
      parent[foundIndex] = clone(change.after);
    }
    return;
  }
  if (!isRecord(parent)) throw new Error("A changed item can no longer be located.");
  if (change.after === undefined) delete parent[finalPart];
  else parent[finalPart] = clone(change.after);
}

function changedTrackIds(changes: Change[]): Set<string> {
  const ids = new Set<string>();
  for (const change of changes) {
    for (const part of change.path) {
      if (part.startsWith("tracks#")) ids.add(part.slice("tracks#".length));
    }
  }
  return ids;
}

function findTrack(project: VideoProject, id: string): Record<string, unknown> | undefined {
  return project.sequences.flatMap((sequence) => sequence.tracks).find((track) => track.id === id) as unknown as Record<string, unknown> | undefined;
}

function dependencyConflict(desiredChanges: Change[], externalChanges: Change[], external: VideoProject): string | null {
  for (const trackId of changedTrackIds(desiredChanges)) {
    const externalTrack = findTrack(external, trackId);
    const onlyChangesAllowedWhileLocked = desiredChanges
      .filter((change) => change.path.some((part) => part === `tracks#${trackId}`))
      .every((change) => ["locked", "muted", "hidden"].includes(change.path.at(-1) ?? ""));
    // An exact inverse may own both the lock and the contents it protected.
    // A later actor's lock still fences in the path-overlap check above.
    const ownsUnlock = desiredChanges.some((change) => change.path.at(-2) === `tracks#${trackId}` &&
      change.path.at(-1) === "locked" && change.before === true && change.after !== true);
    if (externalTrack?.["locked"] === true && !onlyChangesAllowedWhileLocked && !ownsUnlock) {
      return `Unlock track ${typeof externalTrack["name"] === "string" ? externalTrack["name"] : trackId} before undoing an edit to its contents.`;
    }
  }
  const removedMedia = desiredChanges
    .filter((change) => change.path.some((part) => part.startsWith("media#")) && change.after === undefined)
    .map((change) => entityId(change.path.at(-1)!)!)
    .filter(Boolean);
  for (const mediaId of removedMedia) {
    const externalTouchesReference = externalChanges.some((change) =>
      change.path.some((part) => part.startsWith("clips#")) &&
      (change.path.at(-1) === "mediaId"
        ? change.before === mediaId || change.after === mediaId
        : containsMediaReference(change.before, mediaId) || containsMediaReference(change.after, mediaId)));
    if (externalTouchesReference) {
      return `Media ${mediaId} is used by another editor's clip change; removing it would be unsafe.`;
    }
  }
  const externallyRemovedMedia = externalChanges
    .filter((change) => change.path.some((part) => part.startsWith("media#")) && change.after === undefined)
    .map((change) => entityId(change.path.at(-1)!)!)
    .filter(Boolean);
  for (const mediaId of externallyRemovedMedia) {
    const localTouchesReference = desiredChanges.some((change) =>
      change.path.some((part) => part.startsWith("clips#")) &&
      (change.path.at(-1) === "mediaId"
        ? change.before === mediaId || change.after === mediaId
        : containsMediaReference(change.before, mediaId) || containsMediaReference(change.after, mediaId)));
    if (localTouchesReference) {
      return `Media ${mediaId} was removed externally; the related clip change cannot be applied safely.`;
    }
  }
  return null;
}

function referencedMediaIds(project: VideoProject): Set<string> {
  const ids = new Set<string>();
  for (const clip of project.sequences.flatMap((sequence) => sequence.tracks).flatMap((track) => track.clips)) {
    if (clip.mediaId) ids.add(clip.mediaId);
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isRecord(value)) return;
    if (value["kind"] === "project-media" && typeof value["mediaId"] === "string") ids.add(value["mediaId"]);
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(project.generationBrief);
  return ids;
}

function introducedDanglingMedia(base: VideoProject, merged: VideoProject): string | null {
  const baseMedia = new Set(base.media.map((asset) => asset.id));
  const mergedMedia = new Set(merged.media.map((asset) => asset.id));
  const preexisting = new Set([...referencedMediaIds(base)].filter((id) => !baseMedia.has(id)));
  return [...referencedMediaIds(merged)].find((id) => !mergedMedia.has(id) && !preexisting.has(id)) ?? null;
}

/** True only when every field affected by the authored edit is back at its preimage. */
export function videoChangeMatchesPreimage(before: VideoProject, after: VideoProject, current: VideoProject): boolean {
  const original = diff(validateVideoProject(before), validateVideoProject(after));
  const remaining = diff(validateVideoProject(before), validateVideoProject(current));
  return original.every((change) => !remaining.some((other) => pathsOverlap(change.path, other.path)));
}

/** Conservatively merges two independently edited projects against their common base. */
export function mergeVideoProjects(base: VideoProject, local: VideoProject, external: VideoProject): VideoProjectMergeResult {
  let normalizedBase: VideoProject;
  let normalizedLocal: VideoProject;
  let normalizedExternal: VideoProject;
  try {
    normalizedBase = validateVideoProject(base);
    normalizedLocal = validateVideoProject(local);
    normalizedExternal = validateVideoProject(external);
  } catch (error) {
    return { ok: false, reason: `A project is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  const localChanges = diff(normalizedBase, normalizedLocal);
  const externalChanges = diff(normalizedBase, normalizedExternal);
  for (const localChange of localChanges) {
    const overlap = externalChanges.find((externalChange) => pathsOverlap(localChange.path, externalChange.path));
    if (overlap) {
      return { ok: false, reason: overlapReason(localChange.path) };
    }
  }
  const dependent = dependencyConflict(localChanges, externalChanges, normalizedExternal);
  if (dependent) return { ok: false, reason: dependent };
  const merged = clone(normalizedExternal) as unknown;
  try {
    for (const change of localChanges) applyChange(merged, change);
    const project = merged as VideoProject;
    project.sequences = project.sequences.map((sequence) => ({
      ...sequence,
      durationSec: computeSequenceDurationSec(sequence),
    }));
    const normalized = validateVideoProject(project);
    const timing = normalized.sequences.flatMap((sequence) => detectTrackTimingViolations(sequence));
    if (timing.length > 0) {
      const violation = timing[0]!;
      return { ok: false, reason: `The merged project would overlap clips ${violation.clipIds.join(" and ")} on track ${violation.trackId}.` };
    }
    const danglingMediaId = introducedDanglingMedia(normalizedBase, normalized);
    if (danglingMediaId) {
      return { ok: false, reason: `The merged project would leave media ${danglingMediaId} referenced after removal.` };
    }
    return { ok: true, project: normalized };
  } catch (error) {
    return { ok: false, reason: `The merged project would be unsafe: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Actor-local, in-memory history. Create a separate instance for external
 * receipt/revert history; Genie changes must not be recorded in human history.
 */
export class VideoProjectHistory {
  private readonly undoEntries: HistoryEntry[] = [];
  private readonly redoEntries: HistoryEntry[] = [];

  getState(): VideoProjectHistoryState {
    return { canUndo: this.undoEntries.length > 0, canRedo: this.redoEntries.length > 0 };
  }

  clear(): void {
    this.undoEntries.length = 0;
    this.redoEntries.length = 0;
  }

  record(before: VideoProject, after: VideoProject): void {
    const normalizedBefore = validateVideoProject(before);
    const normalizedAfter = validateVideoProject(after);
    if (equal(normalizedBefore, normalizedAfter)) return;
    this.undoEntries.push({ before: clone(normalizedBefore), after: clone(normalizedAfter) });
    this.redoEntries.length = 0;
  }

  observeExternal(current: VideoProject): VideoProjectMergeResult {
    try {
      return { ok: true, project: validateVideoProject(current) };
    } catch (error) {
      return { ok: false, reason: `External project is invalid: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  undo(current: VideoProject): VideoProjectHistoryResult {
    const entry = this.undoEntries.at(-1);
    if (!entry) return { ok: false, reason: "There is no human change to undo." };
    const result = mergeVideoProjects(entry.after, entry.before, current);
    if (!result.ok) return { ...result, direction: "undo" };
    this.undoEntries.pop();
    this.redoEntries.push(entry);
    return { ...result, direction: "undo" };
  }

  redo(current: VideoProject): VideoProjectHistoryResult {
    const entry = this.redoEntries.at(-1);
    if (!entry) return { ok: false, reason: "There is no human change to redo." };
    const result = mergeVideoProjects(entry.before, entry.after, current);
    if (!result.ok) return { ...result, direction: "redo" };
    this.redoEntries.pop();
    this.undoEntries.push(entry);
    return { ...result, direction: "redo" };
  }
}
