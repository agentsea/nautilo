// Canonical, document-safe creative direction for the Video Generate workspace.
//
// This deliberately contains direction only. Provider capabilities, prices,
// jobs, files, URLs, and asset bytes belong to their respective host services.

export const GENERATION_BRIEF_VERSION = 1 as const;

// Creative project content has no app-local count or text-size quota.
// The document host bounds transport; each provider validates a submitted job.
/** A persisted, explicit custom-preset choice. The suffix is Human text. */
export const CUSTOM_DIRECTION_PREFIX = "Custom: ";

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STABLE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type GenerationMediaKind = "image" | "video" | "audio";

/**
 * A persisted reference is a direction/lineage record, never an asset
 * capability. The host re-authorizes every selected item at review time.
 */
export type GenerationReference = {
  /** Stable identifier from the project reference library; never a path or URL. */
  id: string;
  /** Human-facing library label, kept with the brief so it remains legible. */
  name: string;
  /** Optional for legacy labels-only direction; present for real media cards. */
  mediaKind?: GenerationMediaKind;
  /** Stable Human prompt token; provider indices are compiled separately. */
  mention?: string;
  /** E.g. subject identity, first frame, motion, composition, or voice. */
  role?: string;
  /** Human direction for what to take from (or ignore in) this item. */
  instruction?: string;
  /** Safe lineage only; never a native path, byte payload, URL, or token. */
  source?:
    | Readonly<{ kind: "project-media"; mediaId: string }>
    | Readonly<{ kind: "workspace-artifact"; artifactId: string; path: string; mimeType: string; sizeBytes: number }>;
};

export type GenerationDirectionBlockKind = "goal" | "references" | "shot" | "continuity" | "audio" | "exclusions" | "note";

/** Ordered, Human-owned canvas presentation over the canonical brief. */
export type GenerationDirectionBlock = {
  id: string;
  kind: GenerationDirectionBlockKind;
  collapsed?: boolean;
  /** Required only by shot blocks and binds to one canonical shot. */
  shotId?: string;
  /** Used only by a Text Note block. Notes never reach provider compilation. */
  note?: string;
  /** Goal block payload. Repeated Goal blocks are independent direction. */
  quickBrief?: string;
  goal?: string;
  /** Reference Board payload. Repeated boards retain independent cards. */
  references?: GenerationReference[];
  /** Independent payload for the corresponding global direction block. */
  continuity?: string;
  audio?: string;
  exclusions?: string;
};

export type GenerationShot = {
  /** App-generated stable identifier, used for all mutations and ordering. */
  id: string;
  title: string;
  description: string;
  /** A directional duration only; providers still validate their own limits. */
  durationSec?: number;
  continueFromPrevious?: boolean;
  framing: string;
  camera: string;
  motion: string;
  references: GenerationReference[];
  audio: string;
  continuity: string;
  exclusions: string;
};

export type GenerationBrief = {
  version: typeof GENERATION_BRIEF_VERSION;
  /** A compact editable direction, projected into (not parsed from) detail. */
  quickBrief: string;
  goal: string;
  references: GenerationReference[];
  continuity: string;
  shots: GenerationShot[];
  audio: string;
  exclusions: string;
  /** Empty is a genuine Blank canvas. Existing V1 briefs may omit it. */
  blocks: GenerationDirectionBlock[];
};

export type GenerationBriefDetailsPatch = Partial<
  Pick<GenerationBrief, "quickBrief" | "goal" | "references" | "continuity" | "audio" | "exclusions">
>;

export type GenerationShotPatch = Partial<Omit<GenerationShot, "id" | "durationSec">> & {
  /** Explicit undefined clears the optional duration in the editor. */
  durationSec?: number | undefined;
};
export type GenerationShotIdFactory = () => string;
export type GenerationDirectionBlockIdFactory = () => string;
export type GenerationDirectionBlockPatch = Partial<Omit<GenerationDirectionBlock, "id" | "kind" | "shotId">>;

export function isCustomDirection(value: string): boolean {
  return value.startsWith(CUSTOM_DIRECTION_PREFIX);
}

export function customDirectionText(value: string): string {
  return isCustomDirection(value) ? value.slice(CUSTOM_DIRECTION_PREFIX.length) : value;
}

export function customDirectionValue(value: string): string {
  return `${CUSTOM_DIRECTION_PREFIX}${value}`;
}

/** Replace only the asset lineage; the Human's role/instruction stay intact. */
export function replaceGenerationReferenceAsset(
  current: GenerationReference,
  replacement: Pick<GenerationReference, "name" | "mediaKind" | "source">,
): GenerationReference {
  return {
    ...current,
    name: replacement.name,
    ...(replacement.mediaKind ? { mediaKind: replacement.mediaKind } : {}),
    ...(replacement.source ? { source: replacement.source } : {}),
  };
}

/**
 * Existing V1 briefs used top-level global direction. Keep them readable
 * without mutating on open; new canvas blocks own their own payloads.
 */
export function effectiveGenerationDirectionBlocks(brief: GenerationBrief): readonly GenerationDirectionBlock[] {
  const current = validateGenerationBrief(brief);
  if (current.blocks.length > 0) return current.blocks;
  const blocks: GenerationDirectionBlock[] = [];
  if (current.quickBrief.trim() || current.goal.trim()) blocks.push({ id: "legacy-goal", kind: "goal", quickBrief: current.quickBrief, goal: current.goal });
  if (current.references.length) blocks.push({ id: "legacy-references", kind: "references", references: current.references });
  for (const shot of current.shots) blocks.push({ id: `legacy-${shot.id}`, kind: "shot", shotId: shot.id });
  if (current.continuity.trim()) blocks.push({ id: "legacy-continuity", kind: "continuity", continuity: current.continuity });
  if (current.audio.trim()) blocks.push({ id: "legacy-audio", kind: "audio", audio: current.audio });
  if (current.exclusions.trim()) blocks.push({ id: "legacy-exclusions", kind: "exclusions", exclusions: current.exclusions });
  return blocks;
}

/** Materialize a legacy presentation into real block-owned document state on its first edit. */
export function materializeGenerationDirectionBlocks(brief: GenerationBrief): GenerationBrief {
  const current = validateGenerationBrief(brief);
  if (current.blocks.length > 0) return current;
  // This is the one migration write: copy V1 global direction into real,
  // block-owned payload then retire its legacy mirrors. Otherwise deleting a
  // final materialized block would make the old top-level value reappear.
  return validateGenerationBrief({
    ...current,
    quickBrief: "",
    goal: "",
    references: [],
    continuity: "",
    audio: "",
    exclusions: "",
    blocks: [...effectiveGenerationDirectionBlocks(current)],
  });
}

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

function assertText(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  // eslint-disable-next-line no-control-regex -- Intentionally reject payload control characters.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    // Deliberately permit ordinary spaces, line breaks, and tabs but reject
    // non-printing controls from clipboard/payload corruption.
    throw new Error(`${path} must not contain control characters.`);
  }
  return value;
}

function assertStableId(value: unknown, path: string): string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new Error(`${path} must be a stable app identifier.`);
  }
  return value;
}

function assertBoolean(value: unknown, path: string): boolean { if (typeof value !== "boolean") throw new Error(`${path} must be boolean.`); return value; }

function assertReference(value: unknown, path: string): GenerationReference {
  const record = assertRecord(value, path);
  assertExactKeys(record, ["id", "name", "mediaKind", "mention", "role", "instruction", "source"], path);
  const id = assertStableId(record["id"], `${path}.id`);
  const name = assertText(record["name"], `${path}.name`);
  if (name.includes("://") || name.startsWith("/") || name.includes("\\")) {
    throw new Error(`${path}.name must be a library label, not a path or URL.`);
  }
  const mediaKind = record["mediaKind"];
  if (mediaKind !== undefined && mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") {
    throw new Error(`${path}.mediaKind must be image, video, or audio when present.`);
  }
  const safeMediaKind = mediaKind;
  const mention = record["mention"];
  if (mention !== undefined && (typeof mention !== "string" || !/^@(Image|Video|Audio)[1-9][0-9]*$/u.test(mention) || mention.length > 64 ||
      (mediaKind && !mention.toLowerCase().startsWith("@" + mediaKind)))) throw new Error(`${path}.mention must match its media kind.`);
  const role = record["role"] === undefined ? undefined : assertText(record["role"], `${path}.role`);
  const instruction = record["instruction"] === undefined
    ? undefined
    : assertText(record["instruction"], `${path}.instruction`);
  let source: GenerationReference["source"];
  if (record["source"] !== undefined) {
    const sourceRecord = assertRecord(record["source"], `${path}.source`);
    const kind = sourceRecord["kind"];
    if (kind === "project-media") {
      assertExactKeys(sourceRecord, ["kind", "mediaId"], `${path}.source`);
      source = { kind, mediaId: assertStableId(sourceRecord["mediaId"], `${path}.source.mediaId`) };
    } else if (kind === "workspace-artifact") {
      assertExactKeys(sourceRecord, ["kind", "artifactId", "path", "mimeType", "sizeBytes"], `${path}.source`);
      // Workspace public artifact identifiers are host-issued UUIDs rather
      // than app-owned block ids. Keep them opaque lineage only.
      const artifactId = assertText(sourceRecord["artifactId"], `${path}.source.artifactId`);
      if (artifactId.includes("://") || artifactId.includes("/") || artifactId.includes("\\")) {
        throw new Error(`${path}.source.artifactId must be an opaque public artifact identity.`);
      }
      const publicPath = assertText(sourceRecord["path"], `${path}.source.path`);
      const mimeType = assertText(sourceRecord["mimeType"], `${path}.source.mimeType`);
      const sizeBytes = sourceRecord["sizeBytes"];
      if (publicPath.startsWith("/") || publicPath.includes("\\") || publicPath.includes("://") || /^(?:data:|blob:|file:)/iu.test(publicPath) || publicPath.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error(`${path}.source.path must be a public Workspace logical path.`);
      }
      if (!Number.isSafeInteger(sizeBytes) || typeof sizeBytes !== "number" || sizeBytes < 0) throw new Error(`${path}.source.sizeBytes must be a non-negative safe integer.`);
      source = { kind, artifactId, path: publicPath, mimeType, sizeBytes };
    } else {
      throw new Error(`${path}.source.kind is not supported.`);
    }
  }
  return {
    id,
    name,
    ...(safeMediaKind ? { mediaKind: safeMediaKind } : {}),
    ...(typeof mention === "string" ? { mention } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(instruction !== undefined ? { instruction } : {}),
    ...(source ? { source } : {}),
  };
}

function assertReferences(value: unknown, path: string): GenerationReference[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  const references = value.map((reference, index) => assertReference(reference, `${path}[${index}]`));
  const seen = new Set<string>();
  for (const reference of references) {
    if (seen.has(reference.id)) throw new Error(`${path} must not repeat reference id "${reference.id}".`);
    seen.add(reference.id);
  }
  return references;
}

function assertShot(value: unknown, path: string): GenerationShot {
  const record = assertRecord(value, path);
  assertExactKeys(record, ["id", "title", "description", "durationSec", "continueFromPrevious", "framing", "camera", "motion", "references", "audio", "continuity", "exclusions"], path);
  const duration = record["durationSec"];
  if (
    duration !== undefined &&
    (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0)
  ) {
    throw new Error(`${path}.durationSec must be a positive bounded number when present.`);
  }
  return {
    id: assertStableId(record["id"], `${path}.id`),
    title: assertText(record["title"], `${path}.title`),
    description: assertText(record["description"], `${path}.description`),
    ...(duration !== undefined ? { durationSec: duration } : {}),
    // V1 documents predate the framing preset. Keep them valid without
    // inventing a visible choice until a Human picks one.
    framing: record["framing"] === undefined ? "" : assertText(record["framing"], `${path}.framing`),
    camera: assertText(record["camera"], `${path}.camera`),
    motion: assertText(record["motion"], `${path}.motion`),
    ...(record["continueFromPrevious"] === undefined ? {} : { continueFromPrevious: assertBoolean(record["continueFromPrevious"], `${path}.continueFromPrevious`) }),
    references: assertReferences(record["references"], `${path}.references`),
    audio: assertText(record["audio"], `${path}.audio`),
    continuity: assertText(record["continuity"], `${path}.continuity`),
    exclusions: assertText(record["exclusions"], `${path}.exclusions`),
  };
}

function assertDirectionBlocks(value: unknown, shots: readonly GenerationShot[]): GenerationDirectionBlock[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("generationBrief.blocks must be an array when present.");
  const shotIds = new Set(shots.map((shot) => shot.id));
  const used = new Set<string>();
  const shotBlocks = new Set<string>();
  return value.map((entry, index) => {
    const path = `generationBrief.blocks[${index}]`;
    const record = assertRecord(entry, path);
    assertExactKeys(record, ["id", "kind", "collapsed", "shotId", "note", "quickBrief", "goal", "references", "continuity", "audio", "exclusions"], path);
    const id = assertStableId(record["id"], `${path}.id`);
    if (used.has(id)) throw new Error(`generationBrief.blocks repeats block id "${id}".`);
    used.add(id);
    const kind = record["kind"];
    if (!["goal", "references", "shot", "continuity", "audio", "exclusions", "note"].includes(String(kind))) {
      throw new Error(`${path}.kind is not supported.`);
    }
    const collapsed = record["collapsed"];
    if (collapsed !== undefined && typeof collapsed !== "boolean") throw new Error(`${path}.collapsed must be a boolean when present.`);
    const shotId = record["shotId"];
    const note = record["note"];
    if (kind === "shot") {
      if (typeof shotId !== "string" || !shotIds.has(shotId)) throw new Error(`${path}.shotId must name an existing shot.`);
      if (shotBlocks.has(shotId)) throw new Error(`${path}.shotId may appear in only one block.`);
      shotBlocks.add(shotId);
      if (note !== undefined) throw new Error(`${path}.note is only allowed for note blocks.`);
      for (const key of ["quickBrief", "goal", "references", "continuity", "audio", "exclusions"]) {
        if (record[key] !== undefined) throw new Error(`${path}.${key} is not allowed for shot blocks.`);
      }
      return { id, kind, ...(collapsed === undefined ? {} : { collapsed: collapsed }), shotId };
    }
    if (shotId !== undefined) throw new Error(`${path}.shotId is only allowed for shot blocks.`);
    if (kind === "note") {
      for (const key of ["quickBrief", "goal", "references", "continuity", "audio", "exclusions"]) {
        if (record[key] !== undefined) throw new Error(`${path}.${key} is not allowed for note blocks.`);
      }
      return { id, kind, ...(collapsed === undefined ? {} : { collapsed: collapsed }), note: assertText(note ?? "", `${path}.note`) };
    }
    if (note !== undefined) throw new Error(`${path}.note is only allowed for note blocks.`);
    const shared = { id, kind: kind as Exclude<GenerationDirectionBlockKind, "shot" | "note">, ...(collapsed === undefined ? {} : { collapsed: collapsed }) };
    if (kind === "goal") {
      for (const key of ["references", "continuity", "audio", "exclusions"]) if (record[key] !== undefined) throw new Error(`${path}.${key} is not allowed for goal blocks.`);
      return { ...shared, quickBrief: assertText(record["quickBrief"] ?? "", `${path}.quickBrief`), goal: assertText(record["goal"] ?? "", `${path}.goal`) };
    }
    if (kind === "references") {
      for (const key of ["quickBrief", "goal", "continuity", "audio", "exclusions"]) if (record[key] !== undefined) throw new Error(`${path}.${key} is not allowed for references blocks.`);
      return { ...shared, references: assertReferences(record["references"] ?? [], `${path}.references`) };
    }
    if (kind === "continuity") {
      for (const key of ["quickBrief", "goal", "references", "audio", "exclusions"]) if (record[key] !== undefined) throw new Error(`${path}.${key} is not allowed for continuity blocks.`);
      return { ...shared, continuity: assertText(record["continuity"] ?? "", `${path}.continuity`) };
    }
    if (kind === "audio") {
      for (const key of ["quickBrief", "goal", "references", "continuity", "exclusions"]) if (record[key] !== undefined) throw new Error(`${path}.${key} is not allowed for audio blocks.`);
      return { ...shared, audio: assertText(record["audio"] ?? "", `${path}.audio`) };
    }
    for (const key of ["quickBrief", "goal", "references", "continuity", "audio"]) if (record[key] !== undefined) throw new Error(`${path}.${key} is not allowed for exclusions blocks.`);
    return { ...shared, exclusions: assertText(record["exclusions"] ?? "", `${path}.exclusions`) };
  });
}

/** Strictly validate and copy a V1 brief. Legacy project documents omit it. */
export function validateGenerationBrief(value: unknown): GenerationBrief {
  const record = assertRecord(value, "generationBrief");
  assertExactKeys(record, ["version", "quickBrief", "goal", "references", "continuity", "shots", "audio", "exclusions", "blocks"], "generationBrief");
  if (record["version"] !== GENERATION_BRIEF_VERSION) {
    throw new Error(`generationBrief.version must be ${GENERATION_BRIEF_VERSION}.`);
  }
  if (!Array.isArray(record["shots"])) throw new Error("generationBrief.shots must be an array.");
  const shots = record["shots"].map((shot, index) => assertShot(shot, `generationBrief.shots[${index}]`));
  const seenShotIds = new Set<string>();
  for (const shot of shots) {
    if (seenShotIds.has(shot.id)) throw new Error(`generationBrief.shots repeats shot id "${shot.id}".`);
    seenShotIds.add(shot.id);
  }
  const blocks = assertDirectionBlocks(record["blocks"], shots);
  return {
    version: GENERATION_BRIEF_VERSION,
    quickBrief: assertText(record["quickBrief"], "generationBrief.quickBrief"),
    goal: assertText(record["goal"], "generationBrief.goal"),
    references: assertReferences(record["references"], "generationBrief.references"),
    continuity: assertText(record["continuity"], "generationBrief.continuity"),
    shots,
    audio: assertText(record["audio"], "generationBrief.audio"),
    exclusions: assertText(record["exclusions"], "generationBrief.exclusions"),
    blocks,
  };
}

export function createEmptyGenerationBrief(): GenerationBrief {
  return {
    version: GENERATION_BRIEF_VERSION,
    quickBrief: "",
    goal: "",
    references: [],
    continuity: "",
    shots: [],
    audio: "",
    exclusions: "",
    blocks: [],
  };
}

export function createGenerationShotId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `shot-${uuid.replace(/-/g, "")}`;
  return `shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createGenerationDirectionBlockId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `block-${uuid.replace(/-/g, "")}`;
  return `block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createGenerationShot(
  partial: Partial<Omit<GenerationShot, "id">> = {},
  idFactory: GenerationShotIdFactory = createGenerationShotId,
): GenerationShot {
  const shot = {
    id: idFactory(),
    title: partial.title ?? "Untitled shot",
    description: partial.description ?? "",
    ...(partial.durationSec !== undefined ? { durationSec: partial.durationSec } : {}),
    ...(partial.continueFromPrevious !== undefined ? { continueFromPrevious: partial.continueFromPrevious } : {}),
    framing: partial.framing ?? "",
    camera: partial.camera ?? "",
    motion: partial.motion ?? "",
    references: partial.references ?? [],
    audio: partial.audio ?? "",
    continuity: partial.continuity ?? "",
    exclusions: partial.exclusions ?? "",
  };
  return assertShot(shot, "generationShot");
}

function normalized(brief: GenerationBrief): GenerationBrief {
  return validateGenerationBrief(brief);
}

export function updateGenerationBrief(brief: GenerationBrief, patch: GenerationBriefDetailsPatch): GenerationBrief {
  const current = normalized(brief);
  return validateGenerationBrief({ ...current, ...patch });
}

export function appendGenerationShot(
  brief: GenerationBrief,
  partial: Partial<Omit<GenerationShot, "id">> = {},
  idFactory: GenerationShotIdFactory = createGenerationShotId,
): GenerationBrief {
  const current = normalized(brief);
  const shot = createGenerationShot(partial, idFactory);
  return validateGenerationBrief({ ...current, shots: [...current.shots, shot] });
}

export function insertGenerationShot(
  brief: GenerationBrief,
  index: number,
  partial: Partial<Omit<GenerationShot, "id">> = {},
  idFactory: GenerationShotIdFactory = createGenerationShotId,
): GenerationBrief {
  const current = normalized(brief);
  if (!Number.isInteger(index) || index < 0 || index > current.shots.length) {
    throw new Error("Generation shot insertion index is out of range.");
  }
  const shot = createGenerationShot(partial, idFactory);
  return validateGenerationBrief({ ...current, shots: [...current.shots.slice(0, index), shot, ...current.shots.slice(index)] });
}

export function updateGenerationShot(brief: GenerationBrief, shotId: string, patch: GenerationShotPatch): GenerationBrief {
  const current = normalized(brief);
  const index = current.shots.findIndex((shot) => shot.id === shotId);
  if (index < 0) throw new Error(`Generation shot "${shotId}" was not found.`);
  const nextShot = assertShot({ ...current.shots[index], ...patch, id: shotId }, `generationBrief.shots[${index}]`);
  return validateGenerationBrief({ ...current, shots: current.shots.map((shot, i) => (i === index ? nextShot : shot)) });
}

export function moveGenerationShot(brief: GenerationBrief, shotId: string, destinationIndex: number): GenerationBrief {
  const current = normalized(brief);
  const sourceIndex = current.shots.findIndex((shot) => shot.id === shotId);
  if (sourceIndex < 0) throw new Error(`Generation shot "${shotId}" was not found.`);
  if (!Number.isInteger(destinationIndex) || destinationIndex < 0 || destinationIndex >= current.shots.length) {
    throw new Error("Generation shot destination index is out of range.");
  }
  const shots = [...current.shots];
  const [shot] = shots.splice(sourceIndex, 1);
  shots.splice(destinationIndex, 0, shot!);
  // Scene order and the canvas's scene slots must describe the same sequence.
  const represented = new Map(current.blocks.flatMap(block => block.kind === "shot" && block.shotId ? [[block.shotId, block] as const] : []));
  const ordered = shots.flatMap(item => { const block = represented.get(item.id); return block ? [block] : []; });
  let slot = 0;
  const blocks = current.blocks.map(block => block.kind === "shot" ? ordered[slot++]! : block);
  return validateGenerationBrief({ ...current, shots, blocks });
}

export function duplicateGenerationShot(
  brief: GenerationBrief,
  shotId: string,
  idFactory: GenerationShotIdFactory = createGenerationShotId,
): GenerationBrief {
  const current = normalized(brief);
  const index = current.shots.findIndex((shot) => shot.id === shotId);
  if (index < 0) throw new Error(`Generation shot "${shotId}" was not found.`);
  const source = current.shots[index]!;
  return insertGenerationShot(current, index + 1, { ...source, references: [...source.references] }, idFactory);
}

export function deleteGenerationShot(brief: GenerationBrief, shotId: string): GenerationBrief {
  const current = normalized(brief);
  const shots = current.shots.filter((shot) => shot.id !== shotId);
  if (shots.length === current.shots.length) throw new Error(`Generation shot "${shotId}" was not found.`);
  // Zero shots intentionally remains valid; callers must never refill this.
  return validateGenerationBrief({ ...current, shots, blocks: current.blocks.filter((block) => block.kind !== "shot" || block.shotId !== shotId) });
}

export function appendGenerationDirectionBlock(
  brief: GenerationBrief,
  block: Omit<GenerationDirectionBlock, "id">,
  idFactory: GenerationDirectionBlockIdFactory = createGenerationDirectionBlockId,
): GenerationBrief {
  const current = normalized(brief);
  return validateGenerationBrief({ ...current, blocks: [...current.blocks, { ...block, id: idFactory() }] });
}

export function updateGenerationDirectionBlock(
  brief: GenerationBrief,
  blockId: string,
  patch: GenerationDirectionBlockPatch,
): GenerationBrief {
  const current = normalized(brief);
  const index = current.blocks.findIndex((block) => block.id === blockId);
  if (index < 0) throw new Error(`Generation direction block "${blockId}" was not found.`);
  return validateGenerationBrief({
    ...current,
    blocks: current.blocks.map((block, itemIndex) => itemIndex === index ? { ...block, ...patch } : block),
  });
}

export function moveGenerationDirectionBlock(brief: GenerationBrief, blockId: string, destinationIndex: number): GenerationBrief {
  const current = normalized(brief);
  const sourceIndex = current.blocks.findIndex((block) => block.id === blockId);
  if (sourceIndex < 0) throw new Error(`Generation direction block "${blockId}" was not found.`);
  if (!Number.isInteger(destinationIndex) || destinationIndex < 0 || destinationIndex >= current.blocks.length) {
    throw new Error("Generation direction block destination index is out of range.");
  }
  const blocks = [...current.blocks];
  const [block] = blocks.splice(sourceIndex, 1);
  blocks.splice(destinationIndex, 0, block!);
  // The canvas is the Human-facing shot order. Keep the canonical shot list
  // in lockstep so generation source ordering cannot silently diverge.
  const blockShotIds = blocks.flatMap((candidate) => candidate.kind === "shot" && candidate.shotId ? [candidate.shotId] : []);
  const orderedShots = blockShotIds.map((shotId) => current.shots.find((shot) => shot.id === shotId)!).filter(Boolean);
  const unorderedShots = current.shots.filter((shot) => !blockShotIds.includes(shot.id));
  return validateGenerationBrief({ ...current, blocks, shots: [...orderedShots, ...unorderedShots] });
}

export function deleteGenerationDirectionBlock(brief: GenerationBrief, blockId: string): GenerationBrief {
  const current = normalized(brief);
  const block = current.blocks.find((candidate) => candidate.id === blockId);
  if (!block) throw new Error(`Generation direction block "${blockId}" was not found.`);
  const blocks = current.blocks.filter((candidate) => candidate.id !== blockId);
  if (block.kind === "shot" && block.shotId) {
    return deleteGenerationShot({ ...current, blocks }, block.shotId);
  }
  // Each non-shot canvas block owns its payload. Removing one never rewrites
  // another block (or legacy top-level fields retained for migration).
  return validateGenerationBrief({ ...current, blocks });
}

/** Build an editable starter. Blank remains `createEmptyGenerationBrief()`. */
export function createStarterGenerationBrief(
  shotIdFactory: GenerationShotIdFactory = createGenerationShotId,
  blockIdFactory: GenerationDirectionBlockIdFactory = createGenerationDirectionBlockId,
): GenerationBrief {
  const shot = createGenerationShot({
    title: "Opening moment",
    description: "Establish the first image and the change it begins.",
    framing: "Wide",
    camera: "Static",
    motion: "Subtle ambient movement",
  }, shotIdFactory);
  const blocks: GenerationDirectionBlock[] = [
    { id: blockIdFactory(), kind: "goal", quickBrief: "A short, directed piece with one clear opening moment.", goal: "" },
    { id: blockIdFactory(), kind: "references", references: [] },
    { id: blockIdFactory(), kind: "shot", shotId: shot.id },
    { id: blockIdFactory(), kind: "continuity", continuity: "" },
    { id: blockIdFactory(), kind: "audio", audio: "" },
    { id: blockIdFactory(), kind: "exclusions", exclusions: "" },
  ];
  return validateGenerationBrief({
    ...createEmptyGenerationBrief(),
    shots: [shot],
    blocks,
  });
}
