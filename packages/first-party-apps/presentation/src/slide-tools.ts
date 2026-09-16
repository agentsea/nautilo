import { reconcileAuthoredConnectors } from "./slide-connector-reconciliation";
import { MemSlidesStore, deckSlideHeight, deckFontScale, SLIDE_WIDTH, flattenElements, type SlidesDocument } from "../engine/node.js";
import {
  assertSlideAdoptionPreserves,
  parseSlideHtml,
  serializeSlideHtml,
  validateSlideDocument,
} from "./slide-document";

import { applySlideAuthoringOperation, validateAuthoredSlideDocument, type SlideAuthoringResources } from "./slide-authoring";
import { getDesignThemes } from "./slide-design";
import { captureSlideTemplate } from "./slide-templates";
import { nativeSlideModelSchemaDescriptor, assertNativeSlideModel } from "./slide-model-validation";

export type AppDocumentTarget =
  | { surface: "workspace"; path: string }
  | { surface: "currentFolder"; relativePath: string };
type WriteResult =
  | { kind: "saved"; sha256: string; revision?: number | null }
  | { kind: "conflict"; currentSha256: string | null }
  | { kind: "error"; message: string };
export type ServerNautiloAppHost = SlideAuthoringResources & {
  templates?: {
    list(input?: { cursor?: string }): Promise<{ templates: Array<{ id: string; name: string }>; nextCursor: string | null }>;
    read(input: { templateId: string }): Promise<{ content: string }>;
    save(input: { name: string; content: string }): Promise<
      { ok: true; template: { id: string; name: string }; stateChanged: boolean; warnings?: string[] } | ResourceFailure>;
    remove(input: { templateId: string }): Promise<{ ok: true; stateChanged: boolean; warnings?: string[] } | ResourceFailure>;
  };
  document: {
    createFromAction(
      id: string,
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
      displayPath: string;
      baseSha256: string | null;
      baseRevision: number | null;
    }>;
    write(
      target: AppDocumentTarget,
      next: { content: string },
      opts: { baseSha256: string; baseRevision: number | null },
    ): Promise<WriteResult>;
    writeBound(next: { content: string }): Promise<WriteResult>;
  };
};
type ResourceFailure = { ok: false; code: string; phase: string; retrySafe: boolean; stateChanged: false | "unknown"; recoveryActions: string[]; message: string };
export type AgentToolContext = { nautiloApp: ServerNautiloAppHost };
type Version =
  | { kind: "artifact_revision"; revision: number }
  | { kind: "local_sha"; sha256: string };
type ShapeFramePatch = Partial<{ x: number; y: number; w: number; h: number; rotation: number }>;
type Operation =
  | { op: "add-slide"; layoutId: string; atIndex?: number }
  | { op: "delete-slide"; slideId: string }
  | { op: "move-slide"; slideId: string; toIndex: number }
  | { op: "set-text"; slideId: string; elementId: string; text: string }
  | { op: "update-shape"; slideId: string; elementId: string; frame?: ShapeFramePatch; fill?: string }
  | { op: "set-notes"; slideId: string; text: string }
  | { op: "set-title"; title: string };

const SHA = /^[a-f0-9]{64}$/;
const fail = (
  status: "invalid_request" | "stale_revision" | "stale_version" | "error",
  code: string,
  message: string,
  retrySafe: boolean,
  stateChanged: false | "unknown" = false,
) => ({ ok: false as const, status, code, message, retrySafe, stateChanged });
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function unknownKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
function target(value: unknown): AppDocumentTarget {
  const x = record(value, "target");
  const extra = unknownKey(x, ["surface", "path", "relativePath"]);
  if (extra) throw new Error(`unknown target field ${extra}`);
  if (
    x["surface"] === "workspace" &&
    typeof x["path"] === "string" &&
    x["path"].length &&
    x["relativePath"] === undefined
  )
    return { surface: "workspace", path: x["path"] };
  if (
    x["surface"] === "currentFolder" &&
    typeof x["relativePath"] === "string" &&
    x["relativePath"].length &&
    x["path"] === undefined &&
    !x["relativePath"].startsWith("/") &&
    !x["relativePath"].startsWith("\\") &&
    !/^[A-Za-z]:/.test(x["relativePath"]) &&
    !containsControlCharacter(x["relativePath"]) &&
    !x["relativePath"].split(/[\\/]/).includes("..")
  )
    return { surface: "currentFolder", relativePath: x["relativePath"] };
  throw new Error(
    "target must identify one workspace path or current-folder relativePath",
  );
}
function version(value: unknown): Version {
  const x = record(value, "documentVersion");
  if (
    x["kind"] === "artifact_revision" &&
    unknownKey(x, ["kind", "revision"]) === undefined &&
    Number.isSafeInteger(x["revision"]) &&
    (x["revision"] as number) >= 0
  )
    return x as Version;
  if (
    x["kind"] === "local_sha" &&
    unknownKey(x, ["kind", "sha256"]) === undefined &&
    typeof x["sha256"] === "string" &&
    SHA.test(x["sha256"])
  )
    return x as Version;
  throw new Error("live presentation version is invalid");
}
function paragraph(text: string) {
  return [
    {
      id: `tool-${crypto.randomUUID()}`,
      type: "paragraph" as const,
      inlines: [{ text, style: {} }],
      style: {
        alignment: "left" as const,
        lineHeight: 1.5,
        marginTop: 0,
        marginBottom: 8,
        textIndent: 0,
        marginLeft: 0,
      },
    },
  ];
}

function operations(value: unknown): Operation[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("operations must be a non-empty array");
  return value.map((entry, index) => {
    const x = record(entry, `operations[${index}]`);
    const op = x["op"];
    const fields: Record<string, string[]> = {
      "add-slide": ["op", "layoutId", "atIndex"],
      "delete-slide": ["op", "slideId"],
      "move-slide": ["op", "slideId", "toIndex"],
      "set-text": ["op", "slideId", "elementId", "text"],
      "update-shape": ["op", "slideId", "elementId", "frame", "fill"],
      "set-notes": ["op", "slideId", "text"],
      "set-title": ["op", "title"],
    };
    if (typeof op !== "string" || !fields[op])
      throw new Error(`operations[${index}].op is unsupported`);
    const extra = unknownKey(x, fields[op]);
    if (extra)
      throw new Error(`operations[${index}] has unknown field ${extra}`);
    for (const key of fields[op].filter(
      (key) => !["op", "atIndex", "toIndex", "frame", "fill"].includes(key),
    ))
      if (typeof x[key] !== "string")
        throw new Error(`operations[${index}].${key} must be a string`);
    if (op === "update-shape") {
      if (x["frame"] === undefined && x["fill"] === undefined)
        throw new Error("update-shape requires a frame change or solid fill");
      if (x["frame"] !== undefined) {
        const frame = record(x["frame"], "frame");
        if (Object.keys(frame).length === 0 || unknownKey(frame, ["x", "y", "w", "h", "rotation"]))
          throw new Error("frame must contain supported geometry fields");
        for (const [key, value] of Object.entries(frame)) {
          if (typeof value !== "number" || !Number.isFinite(value))
            throw new Error(`frame.${key} must be finite`);
          if ((key === "w" || key === "h") && value < 0)
            throw new Error("frame dimensions must be non-negative");
        }
      }
      if (x["fill"] !== undefined && (typeof x["fill"] !== "string" || !/^#[a-f0-9]{6}$/i.test(x["fill"])))
        throw new Error("fill must be a solid #RRGGBB color");
    }
    if (op === "add-slide" && x["atIndex"] !== undefined)
      integer(x["atIndex"], `operations[${index}].atIndex`);
    if (op === "move-slide")
      integer(x["toIndex"], `operations[${index}].toIndex`);
    return x as unknown as Operation;
  });
}

function applyLegacy(
  source: SlidesDocument,
  raw: unknown,
): { document: SlidesDocument; receipt: unknown[] } {
  const ops = operations(raw);
  const adopted = new MemSlidesStore(source).read();
  assertSlideAdoptionPreserves(source, adopted);
  const store = new MemSlidesStore(adopted);
  const receipts: unknown[] = [];
  let title = adopted.meta.title;
  store.batch(() => {
    for (const op of ops) {
      const current = store.read();
      if (op.op === "add-slide") {
        if (!current.layouts.some((layout) => layout.id === op.layoutId))
          throw new Error(`layout does not exist: ${op.layoutId}`);
        if (op.atIndex !== undefined && op.atIndex > current.slides.length)
          throw new Error("add-slide atIndex exceeds slide count");
        const id = store.addSlide(op.layoutId, op.atIndex);
        receipts.push({ op: op.op, slideId: id });
      } else if (op.op === "delete-slide") {
        if (!current.slides.some((slide) => slide.id === op.slideId))
          throw new Error(`slide does not exist: ${op.slideId}`);
        if (current.slides.length <= 1)
          throw new Error("cannot delete the last slide");
        store.removeSlide(op.slideId);
        receipts.push({ op: op.op, slideId: op.slideId });
      } else if (op.op === "move-slide") {
        if (!current.slides.some((slide) => slide.id === op.slideId))
          throw new Error(`slide does not exist: ${op.slideId}`);
        if (op.toIndex >= current.slides.length)
          throw new Error(
            "move-slide toIndex must identify an existing slide position",
          );
        store.moveSlide(op.slideId, op.toIndex);
        receipts.push({ op: op.op, slideId: op.slideId, toIndex: op.toIndex });
      } else if (op.op === "set-text") {
        const slide = current.slides.find((item) => item.id === op.slideId);
        if (!slide) throw new Error(`slide does not exist: ${op.slideId}`);
        const element = slide.elements.find((item) => item.id === op.elementId);
        if (!element || element.type !== "text")
          throw new Error(`text element does not exist: ${op.elementId}`);
        if (
          element.data.blocks.length !== 1 ||
          element.data.blocks[0].type !== "paragraph" ||
          element.data.blocks[0].inlines.length !== 1 ||
          element.data.blocks[0].inlines[0].style.image !== undefined
        )
          throw new Error(
            "set-text requires one uniformly styled paragraph; rich text is ambiguous",
          );
        const block = element.data.blocks[0];
        store.withTextElement(op.slideId, op.elementId, () => [
          {
            ...structuredClone(block),
            inlines: [{ ...structuredClone(block.inlines[0]), text: op.text }],
          },
        ]);
        receipts.push({
          op: op.op,
          slideId: op.slideId,
          elementId: op.elementId,
        });
      } else if (op.op === "update-shape") {
        const slide = current.slides.find((item) => item.id === op.slideId);
        const shape = slide?.elements.find((item) => item.id === op.elementId);
        if (!shape || shape.type !== "shape")
          throw new Error("update-shape requires an existing top-level shape");
        if (op.frame) {
          const next = { ...shape.frame, ...op.frame };
          if (!Number.isFinite(next.x + next.w) || !Number.isFinite(next.y + next.h))
            throw new Error("shape frame extent must remain finite");
          // The store refreshes attached connector bounds and preserves all
          // other shape data, including adjustments, stroke and animation.
          store.updateElementFrame(op.slideId, op.elementId, op.frame);
        }
        if (op.fill !== undefined)
          store.updateElementData(op.slideId, op.elementId, { fill: { kind: "srgb", value: op.fill } });
        receipts.push({ op: op.op, slideId: op.slideId, elementId: op.elementId });
      } else if (op.op === "set-notes") {
        if (!current.slides.some((slide) => slide.id === op.slideId))
          throw new Error(`slide does not exist: ${op.slideId}`);
        store.withNotes(op.slideId, () => paragraph(op.text));
        receipts.push({ op: op.op, slideId: op.slideId });
      } else {
        if (!op.title.trim()) throw new Error("title must not be blank");
        title = op.title;
        receipts.push({ op: op.op });
      }
    }
  });
  const document = store.read();
  document.meta.title = title;
  return { document: validateSlideDocument(document), receipt: receipts };
}

function cursorEncode(
  versionToken: string,
  slideId: string | null,
  offset: number,
): string {
  return btoa(JSON.stringify({ versionToken, slideId, offset }));
}
async function apply(source: SlidesDocument, raw: unknown, ctx: AgentToolContext) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("operations must be a non-empty array");
  let document = structuredClone(source);
  const receipt: unknown[] = [];
  let authored = false;
  for (const [index, item] of raw.entries()) {
    try {
      const operation = record(item, `operations[${index}]`);
      const result = await applySlideAuthoringOperation(document, operation, ctx.nautiloApp);
      if (result) {
        document = result.document; receipt.push(result.receipt); authored = true;
      } else {
        const legacy = applyLegacy(document, [operation]);
        document = legacy.document; receipt.push(...legacy.receipt);
      }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { batchOperationIndex: index });
    }
  }
  if (authored) {
    assertNativeSlideModel(document);
    validateSlideDocument(document);
    const derivedPaths = reconcileAuthoredConnectors(source, document);
    if (derivedPaths.length > 0) receipt.push({ op: "reconcile-derived-geometry", changedPaths: derivedPaths });
    document = validateAuthoredSlideDocument(document);
  }
  return { document, receipt };
}

function editFailure(error: unknown) {
  const e = error instanceof Error ? error : new Error(String(error));
  const details = e as Error & { code?: string; errors?: unknown; errorCount?: number; affectedPaths?: readonly string[]; phase?: string; retrySafe?: boolean; stateChanged?: false | "unknown"; recoveryActions?: string[]; operationIndex?: number; batchOperationIndex?: number; path?: string };
  return { ...fail("invalid_request", details.code ?? "edit_failed", e.message, details.retrySafe ?? true, details.stateChanged ?? false),
    phase: details.phase ?? "prepare", recoveryActions: details.recoveryActions ?? ["inspect_document", "inspect_authoring_contract", "correct_input"],
    ...(details.errors !== undefined ? { validationErrors: details.errors, errorCount: details.errorCount, affectedPaths: details.affectedPaths } : {}),
    ...(details.batchOperationIndex !== undefined ? { operationIndex: details.batchOperationIndex } : {}),
    ...(details.operationIndex !== undefined ? { patchOperationIndex: details.operationIndex } : {}),
    ...(details.path !== undefined ? { path: details.path } : {}) };
}

function cursorOffset(
  raw: unknown,
  versionToken: string,
  slideId: string | null,
): number {
  if (raw === undefined) return 0;
  if (typeof raw !== "string") throw new Error("cursor must be a string");
  try {
    const x = record(JSON.parse(atob(raw)), "cursor");
    if (unknownKey(x, ["versionToken", "slideId", "offset"]))
      throw new Error("cursor shape is invalid");
    if (x["versionToken"] !== versionToken || x["slideId"] !== slideId)
      throw new Error(
        "cursor belongs to another presentation query or version",
      );
    return integer(x["offset"], "cursor offset");
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "cursor is invalid",
    );
  }
}
function inspect(
  document: SlidesDocument,
  input: Record<string, unknown>,
  versionToken: string,
) {
  const pageSize = input["pageSize"] === undefined ? document.slides.length : integer(input["pageSize"], "pageSize");
  if (pageSize < 1) throw new Error("pageSize must be at least 1");
  if (input["slideId"] !== undefined && typeof input["slideId"] !== "string")
    throw new Error("slideId must be a string");
  const slideId =
    typeof input["slideId"] === "string" ? input["slideId"] : null;
  const view = input["view"] ?? "slides";
  if (!["summary", "slides", "document", "resources"].includes(view as string)) throw new Error("view must be summary, slides, document or resources");
  if (view !== "slides" && (input["cursor"] !== undefined || input["pageSize"] !== undefined || slideId !== null)) throw new Error("slide selection and pagination apply only to view=slides");
  const serialized = serializeSlideHtml(document);
  const facts = {
    title: document.meta.title, slideCount: document.slides.length,
    documentBytes: new TextEncoder().encode(serialized).byteLength,
    canvas: { width: SLIDE_WIDTH, height: deckSlideHeight(document.meta), fontScale: deckFontScale(document.meta), rotationUnit: "radians" },
    availableViews: ["summary", "slides", "document", "resources"],
  };
  if (view === "summary") return { ...facts, completeness: "complete", projection: "summary", contentIncluded: false,
    slides: document.slides.map((slide, index) => ({ id: slide.id, index, path: `/slides/${index}`, layoutId: slide.layoutId, themeId: slide.themeId ?? document.meta.themeId, elementCount: flattenElements(slide.elements).length, noteBlockCount: slide.notes.length })) };
  if (view === "document") return { ...facts, completeness: "complete", document, returnedSlides: document.slides.length, remainingSlides: 0 };
  if (view === "resources") return { ...facts, completeness: "complete", meta: document.meta, themes: getDesignThemes(document), masters: document.masters, layouts: document.layouts,
    scope: "document resources plus built-in theme catalog; use inspect-slide-templates for the private library" };
  const offset = cursorOffset(input["cursor"], versionToken, slideId);
  const selected =
    slideId === null
      ? document.slides
      : document.slides.filter((slide) => slide.id === slideId);
  if (slideId !== null && selected.length === 0)
    throw new Error("slideId does not exist");
  if (offset > selected.length)
    throw new Error("cursor offset exceeds this presentation query");
  const slides = selected.slice(offset, offset + pageSize);
  const next = offset + slides.length;
  return {
    ...facts,
    slides,
    slidePaths: slides.map(slide => ({ id: slide.id, path: `/slides/${document.slides.findIndex(candidate => candidate.id === slide.id)}` })),
    selectedSlideCount: selected.length, returnedSlides: slides.length, remainingSlides: Math.max(0, selected.length - next),
    selectionPolicy: input["pageSize"] === undefined ? "full selected content" : "caller pageSize",
    meta: document.meta,
    completeness:
      next < selected.length ? ("partial" as const) : ("complete" as const),
    ...(next < selected.length
      ? { nextCursor: cursorEncode(versionToken, slideId, next) }
      : {}),
  };
}
function nextVersion(
  write: Extract<WriteResult, { kind: "saved" }>,
  prior: Version,
): Version {
  return prior.kind === "artifact_revision" &&
    Number.isSafeInteger(write.revision)
    ? { kind: "artifact_revision", revision: write.revision! }
    : prior.kind === "local_sha" && SHA.test(write.sha256)
      ? { kind: "local_sha", sha256: write.sha256 }
      : prior;
}

export async function createFile(args: unknown, ctx: AgentToolContext) {
  let x: Record<string, unknown>;
  try {
    x = record(args, "arguments");
    const extra = unknownKey(x, [
      "targetSurface",
      "filename",
      "openAfterCreate",
    ]);
    if (extra) throw new Error(`unknown field ${extra}`);
    if (
      (x["targetSurface"] !== "workspace" &&
        x["targetSurface"] !== "currentFolder") ||
      typeof x["filename"] !== "string" ||
      !x["filename"].endsWith(".presentation.html") ||
      x["filename"].includes("/") ||
      x["filename"].includes("\\") ||
      containsControlCharacter(x["filename"])
    )
      throw new Error(
        "filename must be a safe basename ending in .presentation.html",
      );
    if (
      x["openAfterCreate"] !== undefined &&
      typeof x["openAfterCreate"] !== "boolean"
    )
      throw new Error("openAfterCreate must be a boolean");
  } catch (error) {
    return fail("invalid_request", "create_failed", String(error), true);
  }
  try {
    const result = await ctx.nautiloApp.document.createFromAction(
      "new-presentation",
      {
        targetSurface: x["targetSurface"],
        filename: x["filename"],
        ...(typeof x["openAfterCreate"] === "boolean"
          ? { openAfterCreate: x["openAfterCreate"] }
          : {}),
      },
    );
    return { ok: true as const, status: "created" as const, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const failure = JSON.parse(message) as Record<string, unknown>;
      if (failure["ok"] === false && failure["status"] === "create_failed" &&
          failure["phase"] === "create" && typeof failure["code"] === "string" &&
          typeof failure["message"] === "string" && Array.isArray(failure["recoveryActions"])) {
        return failure;
      }
    } catch { /* Ordinary or uncertain host error: require inspection first. */ }
    return fail("error", "create_failed", message, false, "unknown");
  }
}
export async function inspectDocument(args: unknown, ctx: AgentToolContext) {
  try {
    const x = record(args, "arguments");
    const extra = unknownKey(x, ["target", "slideId", "pageSize", "cursor", "view"]);
    if (extra) throw new Error(`unknown field ${extra}`);
    const t = target(x["target"]);
    const envelope = await ctx.nautiloApp.document.read(t);
    if (!envelope.baseSha256 || !SHA.test(envelope.baseSha256))
      throw new Error("host did not provide revision identity");
    return {
      ok: true as const,
      status: "inspected" as const,
      displayPath: envelope.displayPath,
      expectedSha256: envelope.baseSha256,
      revision: envelope.baseRevision,
      ...inspect(parseSlideHtml(envelope.content), x, envelope.baseSha256),
    };
  } catch (error) {
    return fail("invalid_request", "inspection_failed", String(error), true);
  }
}
export async function editDocument(args: unknown, ctx: AgentToolContext) {
  let x: Record<string, unknown>, t: AppDocumentTarget;
  try {
    x = record(args, "arguments");
    const extra = unknownKey(x, ["target", "expectedSha256", "operations"]);
    if (extra) throw new Error(`unknown field ${extra}`);
    t = target(x["target"]);
    if (
      typeof x["expectedSha256"] !== "string" ||
      !SHA.test(x["expectedSha256"])
    )
      throw new Error("expectedSha256 must come from inspection");
  } catch (e) {
    return editFailure(e);
  }
  try {
    const env = await ctx.nautiloApp.document.read(t);
    if (env.baseSha256 !== x["expectedSha256"])
      return fail(
        "stale_revision",
        "stale_revision",
        "The presentation changed after inspection.",
        false,
      );
    const applied = await apply(parseSlideHtml(env.content), x["operations"], ctx);
    let write: WriteResult;
    try {
      write = await ctx.nautiloApp.document.write(
        t,
        { content: serializeSlideHtml(applied.document) },
        { baseSha256: env.baseSha256, baseRevision: env.baseRevision },
      );
    } catch (e) {
      return fail("error", "write_failed", String(e), false, "unknown");
    }
    if (write.kind === "conflict")
      return fail(
        "stale_revision",
        "write_conflict",
        "The presentation changed before saving.",
        false,
      );
    if (write.kind === "error")
      return fail("error", "write_failed", write.message, false);
    return {
      ok: true as const,
      status: "saved" as const,
      sha256: write.sha256,
      revision: write.revision ?? null,
      receipt: applied.receipt,
    };
  } catch (e) {
    return editFailure(e);
  }
}

function live(args: unknown, allowed: string[]) {
  const x = record(args, "arguments");
  const extra = unknownKey(x, [
    ...allowed,
    "sessionToken",
    "documentVersion",
    "idempotencyKey",
    "__canonicalContent",
  ]);
  if (extra) throw new Error(`unknown field ${extra}`);
  if (
    typeof x["sessionToken"] !== "string" ||
    typeof x["__canonicalContent"] !== "string"
  )
    throw new Error("live presentation session is unavailable");
  const v = version(x["documentVersion"]);
  return {
    x,
    v,
    token: JSON.stringify(v),
    document: parseSlideHtml(x["__canonicalContent"]),
  };
}
export function inspectOpenPresentation(args: unknown, _ctx: AgentToolContext) {
  try {
    const b = live(args, ["slideId", "pageSize", "cursor", "view"]);
    return {
      ok: true as const,
      status: "inspected" as const,
      documentVersion: b.v,
      versionToken: b.token,
      ...inspect(b.document, b.x, b.token),
    };
  } catch (e) {
    return fail("invalid_request", "inspection_failed", String(e), true);
  }
}
export async function editOpenPresentation(
  args: unknown,
  ctx: AgentToolContext,
) {
  try {
    const b = live(args, ["expectedVersion", "operations"]);
    if (b.x["expectedVersion"] !== b.token)
      return fail(
        "stale_version",
        "stale_version",
        "The open presentation version differs from inspection.",
        false,
      );
    const applied = await apply(b.document, b.x["operations"], ctx);
    let write: WriteResult;
    try {
      write = await ctx.nautiloApp.document.writeBound({
        content: serializeSlideHtml(applied.document),
      });
    } catch (e) {
      return fail("error", "bound_write_failed", String(e), false, "unknown");
    }
    if (write.kind === "conflict")
      return fail(
        "stale_version",
        "version_conflict",
        "The open presentation changed before saving.",
        false,
      );
    if (write.kind === "error")
      return fail("error", "bound_write_failed", write.message, false);
    const documentVersion = nextVersion(write, b.v);
    return {
      ok: true as const,
      status: "saved" as const,
      documentVersion,
      versionToken: JSON.stringify(documentVersion),
      receipt: applied.receipt,
    };
  } catch (e) {
    return editFailure(e);
  }
}


/** Schema discovery is separate from document reads; callers choose full schema
 * or one definition with its transitive references, without hidden truncation. */
export function describeAuthoring(args: unknown) {
  try {
    const x = record(args, "arguments");
    if (unknownKey(x, ["definition", "includeSchema"])) throw new Error("unknown authoring discovery field");
    const descriptor = nativeSlideModelSchemaDescriptor();
    const schema = descriptor.schema;
    const definitions = record(schema["definitions"] ?? {}, "definitions");
    const names = Object.keys(definitions).sort();
    if (x["definition"] !== undefined) {
      const name = x["definition"];
      if (typeof name !== "string" || !Object.hasOwn(definitions, name)) throw new Error("definition is not in the returned definitionNames");
      const included: Record<string, unknown> = {};
      const pending = [name];
      while (pending.length > 0) {
        const key = pending.pop()!;
        if (Object.hasOwn(included, key)) continue;
        included[key] = definitions[key];
        const scan = [definitions[key]];
        while (scan.length > 0) {
          const item = scan.pop();
          if (item && typeof item === "object") {
            const ref = (item as Record<string, unknown>)["$ref"];
            if (typeof ref === "string" && ref.startsWith("#/definitions/")) pending.push(decodeURIComponent(ref.slice("#/definitions/".length)).replace(/~1/g, "/").replace(/~0/g, "~"));
            scan.push(...Object.values(item as Record<string, unknown>));
          }
        }
      }
      return { ok: true, version: descriptor.version, completeness: "complete", schema: { $ref: `#/definitions/${encodeURIComponent(name)}`, definitions: included } };
    }
    return { ok: true, version: descriptor.version, definitionNames: names,
      definitionCount: names.length, schemaBytes: new TextEncoder().encode(JSON.stringify(schema)).byteLength,
      ...(x["includeSchema"] === true ? { schema, completeness: "complete" } : { completeness: "overview", schemaIncluded: false, fullSchemaOption: { includeSchema: true } }),
      editing: "patch accepts native JSON Pointer add/remove/replace/copy/move/test over the whole model; full model and relationships are validated before one canonical write. No creative property allowlist.",
      helpers: "add-slide, add-element, duplicate-slide, insert-template, insert-image, apply-theme, apply-layout, group-elements and ungroup-element perform identity, resource and geometry bookkeeping; legacy text/notes/title/shape shortcuts remain available.",
      preservation: "Use test preconditions for addressed IDs/values. Patch rich text runs to preserve other formatting. Use duplicate-slide/insert-template to regenerate object identities. Inspect returned receipts and canonical version before another edit.",
      resources: "Inspect view=resources for actual themes/layouts/masters. inspect-slide-templates browses the private library. insert-image reads an authorized asset in code; omit element.id and element.data.src because the helper supplies both. Use element.frame plus desired image data such as alt, crop and effects. add-element also allocates its ID; omit element.id. Do not invent or copy base64 into tool arguments." };
  } catch (error) { return editFailure(error); }
}

export async function presentationTemplates(args: unknown, ctx: AgentToolContext) {
  try {
    const x = record(args, "arguments");
    const library = ctx.nautiloApp.templates;
    if (!library) throw new Error("The host template library is unavailable; reconnect to an updated server.");
    if (x["action"] === "list") {
      const cursor = x["cursor"];
      if (cursor !== undefined && typeof cursor !== "string") throw new Error("cursor must be a string");
      const page = await library.list(cursor === undefined ? {} : { cursor });
      return { ok: true, ...page, returnedCount: page.templates.length, completeness: page.nextCursor === null ? "complete" : "partial", totalCount: null, totalCountState: "unknown" };
    }
    if (x["action"] === "read") {
      if (typeof x["templateId"] !== "string") throw new Error("templateId is required");
      const template = await library.read({ templateId: x["templateId"] });
      return { ok: true, document: parseSlideHtml(template.content), completeness: "complete" };
    }
    if (x["action"] === "remove") {
      if (typeof x["templateId"] !== "string") throw new Error("templateId is required");
      const removed = await library.remove({ templateId: x["templateId"] });
      return removed.ok ? { ...removed, status: "deleted", insertedCopiesChanged: false } : removed;
    }
    if (x["action"] === "save") {
      if (typeof x["slideId"] !== "string" || typeof x["name"] !== "string") throw new Error("name and slideId are required");
      const envelope = await ctx.nautiloApp.document.read(target(x["source"]));
      if (typeof x["expectedSha256"] !== "string" || envelope.baseSha256 !== x["expectedSha256"])
        return { ...fail("stale_revision", "stale_revision", "The template source changed; inspect it again before capturing.", false), recoveryActions: ["inspect_document", "retry_with_current_version"] };
      const captured = captureSlideTemplate(parseSlideHtml(envelope.content), x["slideId"]);
      const saved = await library.save({ name: x["name"], content: serializeSlideHtml(captured) });
      return saved.ok ? { ok: true, status: "template_saved", ...saved.template, stateChanged: saved.stateChanged, ...(saved.warnings ? { warnings: saved.warnings } : {}) } : saved;
    }
    throw new Error("action must be list, read, save or remove");
  } catch (error) { return editFailure(error); }
}

export async function saveOpenTemplate(args: unknown, ctx: AgentToolContext) {
  try {
    const b = live(args, ["expectedVersion", "slideId", "name"]);
    if (b.x["expectedVersion"] !== b.token)
      return fail("stale_version", "stale_version", "The source changed; inspect the open presentation again.", false);
    if (typeof b.x["slideId"] !== "string" || typeof b.x["name"] !== "string") throw new Error("slideId and name are required");
    if (!ctx.nautiloApp.templates) throw new Error("The host template library is unavailable.");
    const captured = captureSlideTemplate(b.document, b.x["slideId"]);
    const result = await ctx.nautiloApp.templates.save({ name: b.x["name"], content: serializeSlideHtml(captured) });
    return result.ok ? { ok: true, status: "template_saved", ...result.template, stateChanged: result.stateChanged, sourceVersion: b.v, sourceChanged: false, ...(result.warnings ? { warnings: result.warnings } : {}) } : result;
  } catch (error) { return editFailure(error); }
}
