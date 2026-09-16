import { MemSlidesStore, type SlidesDocument } from "../engine/node.js";

const MANIFEST_ID = "manifest";
const MANIFEST_TYPE = "application/vnd.nautilo.document+json";
const PAYLOAD_ID = "wafflebase-presentation";
const PAYLOAD_TYPE = "application/vnd.wafflebase.presentation+json";
const ELEMENT_TYPES = new Set(["text", "shape", "image", "table", "group", "connector", "chart"]);
const SAFE_IMAGE_SOURCE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type ScriptBlock = { attributes: Record<string, string>; content: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
}

/** Reject prototype-pollution keys and every non-finite numeric value without
 * rewriting the payload. Unknown JSON fields otherwise round-trip exactly. */
function assertSafeJson(value: unknown, path = "document"): void {
  const pending: Array<{ value: unknown; path: string }> = [{ value, path }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new Error(`${current.path} must be finite`);
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((entry, index) => pending.push({ value: entry, path: `${current.path}[${index}]` }));
      continue;
    }
    for (const key of Object.keys(current.value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error(`${current.path}.${key} is forbidden`);
      // Rich-text blocks can carry nested images as well as top-level slide
      // image elements. Treat every source-bearing payload as image authority;
      // native presentations do not fetch external assets in this release.
      if (key === "src") assertImageSource((current.value as Record<string, unknown>)[key], `${current.path}.src`);
      pending.push({ value: (current.value as Record<string, unknown>)[key], path: `${current.path}.${key}` });
    }
  }
}

function assertFrame(value: unknown, path: string): void {
  assertRecord(value, path);
  for (const key of ["x", "y", "w", "h", "rotation"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) throw new Error(`${path}.${key} must be finite`);
  }
  if ((value["w"] as number) < 0 || (value["h"] as number) < 0) throw new Error(`${path} dimensions must be non-negative`);
}

function assertImageSource(value: unknown, path: string): void {
  const match = typeof value === "string" ? SAFE_IMAGE_SOURCE.exec(value) : null;
  if (!match) {
    throw new Error(`${path} must be a self-contained base64 PNG, JPEG, GIF, or WebP data URL`);
  }
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0)); }
  catch { throw new Error(`${path} contains invalid base64 image data`); }
  const signature = match[1] === "png"
    ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    : match[1] === "jpeg" ? [0xff, 0xd8, 0xff]
      : match[1] === "gif" ? [0x47, 0x49, 0x46, 0x38]
        : [0x52, 0x49, 0x46, 0x46];
  if (signature.some((byte, index) => bytes[index] !== byte) ||
    (match[1] === "webp" && String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP")) {
    throw new Error(`${path} does not match its declared image format`);
  }
}

function assertStringRecordFields(value: unknown, path: string, fields: readonly string[]): void {
  assertRecord(value, path);
  for (const field of fields) assertString(value[field], `${path}.${field}`);
}

function validateBackgroundImages(value: unknown, path: string): void {
  if (value === undefined) return;
  assertRecord(value, path);
  if (value["image"] !== undefined) {
    assertRecord(value["image"], `${path}.image`);
    assertImageSource(value["image"]["src"], `${path}.image.src`);
  }
}

function validateBlocks(value: unknown, path: string, allowSparseBlockStyle = false): void {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  value.forEach((block, blockIndex) => {
    const blockPath = `${path}[${blockIndex}]`;
    assertRecord(block, blockPath);
    assertString(block["id"], `${blockPath}.id`);
    assertString(block["type"], `${blockPath}.type`);
    if (!["paragraph", "title", "subtitle", "heading", "list-item", "horizontal-rule", "table", "page-break"].includes(block["type"])) throw new Error(`${blockPath}.type is unsupported`);
    if (!Array.isArray(block["inlines"])) throw new Error(`${blockPath}.inlines must be an array`);
    assertRecord(block["style"], `${blockPath}.style`);
    const alignment = block["style"]["alignment"];
    if (
      (!allowSparseBlockStyle || alignment !== undefined) &&
      !["left", "center", "right", "justify"].includes(alignment as string)
    ) {
      throw new Error(`${blockPath}.style.alignment is unsupported`);
    }
    for (const field of ["lineHeight", "marginTop", "marginBottom", "textIndent", "marginLeft"] as const) {
      const fieldValue = block["style"][field];
      if ((!allowSparseBlockStyle || fieldValue !== undefined) && typeof fieldValue !== "number") {
        throw new Error(`${blockPath}.style.${field} must be a finite number`);
      }
    }
    if (block["type"] === "table") assertRecord(block["tableData"], `${blockPath}.tableData`);
    block["inlines"].forEach((inline, inlineIndex) => {
      const inlinePath = `${blockPath}.inlines[${inlineIndex}]`;
      assertRecord(inline, inlinePath);
      if (typeof inline["text"] !== "string") throw new Error(`${inlinePath}.text must be a string`);
      assertRecord(inline["style"], `${inlinePath}.style`);
      const href = inline["style"]["href"];
      if (href !== undefined && (typeof href !== "string" || !/^(?:https?:|mailto:)/i.test(href))) {
        throw new Error(`${inlinePath}.style.href must use http, https, or mailto`);
      }
      if (inline["style"]["image"] !== undefined) {
        assertRecord(inline["style"]["image"], `${inlinePath}.style.image`);
        assertImageSource(inline["style"]["image"]["src"], `${inlinePath}.style.image.src`);
        for (const field of ["width", "height"] as const) if (typeof inline["style"]["image"][field] !== "number") throw new Error(`${inlinePath}.style.image.${field} must be finite`);
      }
    });
  });
}

function validateElement(
  value: unknown,
  path: string,
  ids: Set<string>,
  attachedReferences: Array<{ id: string; path: string }>,
  requireId = true,
): void {
  assertRecord(value, path);
  if (requireId) {
    assertString(value["id"], `${path}.id`);
    if (ids.has(value["id"])) throw new Error(`duplicate presentation object id: ${value["id"]}`);
    ids.add(value["id"]);
  } else if (value["id"] !== undefined) {
    throw new Error(`${path}.id is not valid on an element template`);
  }
  assertString(value["type"], `${path}.type`);
  if (!ELEMENT_TYPES.has(value["type"])) throw new Error(`${path}.type is unsupported: ${value["type"]}`);
  assertFrame(value["frame"], `${path}.frame`);

  if (value["type"] === "connector") {
    if (!["straight", "elbow", "curved"].includes(value["routing"] as string)) throw new Error(`${path}.routing is unsupported`);
    assertRecord(value["arrowheads"], `${path}.arrowheads`);
    for (const endpoint of ["start", "end"] as const) {
      assertRecord(value[endpoint], `${path}.${endpoint}`);
      if (value[endpoint]["kind"] === "attached") {
        assertString(value[endpoint]["elementId"], `${path}.${endpoint}.elementId`);
        attachedReferences.push({ id: value[endpoint]["elementId"], path: `${path}.${endpoint}.elementId` });
      } else if (value[endpoint]["kind"] !== "free") {
        throw new Error(`${path}.${endpoint}.kind is unsupported`);
      } else if (typeof value[endpoint]["x"] !== "number" || typeof value[endpoint]["y"] !== "number") {
        throw new Error(`${path}.${endpoint} must contain numeric coordinates`);
      }
    }
  } else {
    assertRecord(value["data"], `${path}.data`);
    if (value["type"] === "text") validateBlocks(value["data"]["blocks"], `${path}.data.blocks`);
    if (value["type"] === "shape") assertString(value["data"]["kind"], `${path}.data.kind`);
    if (value["type"] === "image") assertImageSource(value["data"]["src"], `${path}.data.src`);
    if (value["type"] === "group") {
      if (!Array.isArray(value["data"]["children"])) throw new Error(`${path}.data.children must be an array`);
      value["data"]["children"].forEach((child, index) =>
        validateElement(child, `${path}.data.children[${index}]`, ids, attachedReferences, requireId));
    }
    if (value["type"] === "table") {
      if (!Array.isArray(value["data"]["columnWidths"]) || !Array.isArray(value["data"]["rows"])) {
        throw new Error(`${path}.data must contain columnWidths and rows arrays`);
      }
      value["data"]["rows"].forEach((row, rowIndex) => {
        assertRecord(row, `${path}.data.rows[${rowIndex}]`);
        if (typeof row["height"] !== "number" || !Array.isArray(row["cells"])) throw new Error(`${path}.data.rows[${rowIndex}] is invalid`);
        row["cells"].forEach((cell, cellIndex) => {
          assertRecord(cell, `${path}.data.rows[${rowIndex}].cells[${cellIndex}]`);
          assertRecord(cell["body"], `${path}.data.rows[${rowIndex}].cells[${cellIndex}].body`);
          validateBlocks(cell["body"]["blocks"], `${path}.data.rows[${rowIndex}].cells[${cellIndex}].body.blocks`);
          assertRecord(cell["style"], `${path}.data.rows[${rowIndex}].cells[${cellIndex}].style`);
        });
      });
    }
    if (value["type"] === "chart") {
      if (!Array.isArray(value["data"]["categories"]) || !Array.isArray(value["data"]["series"])) {
        throw new Error(`${path}.data must contain categories and series arrays`);
      }
      if (!["column", "bar", "line", "area", "pie"].includes(value["data"]["kind"] as string)) throw new Error(`${path}.data.kind is unsupported`);
      if (value["data"]["categories"].some((category) => typeof category !== "string")) throw new Error(`${path}.data.categories must contain strings`);
      value["data"]["series"].forEach((series, index) => {
        assertRecord(series, `${path}.data.series[${index}]`);
        if (!Array.isArray(series["values"]) || series["values"].some((item) => item !== null && typeof item !== "number")) throw new Error(`${path}.data.series[${index}].values is invalid`);
      });
      const axis = value["data"]["valueAxis"];
      if (axis !== undefined) {
        assertRecord(axis, `${path}.data.valueAxis`);
        for (const key of ["min", "max", "crossAt"] as const) {
          if (axis[key] !== undefined && (typeof axis[key] !== "number" || !Number.isFinite(axis[key]))) {
            throw new Error(`${path}.data.valueAxis.${key} must be finite`);
          }
        }
        if (typeof axis["min"] === "number" && typeof axis["max"] === "number" && axis["min"] >= axis["max"]) {
          throw new Error(`${path}.data.valueAxis.min must be less than max`);
        }
        if ((axis["min"] === Number.MAX_VALUE && axis["max"] === undefined) ||
            (axis["max"] === -Number.MAX_VALUE && axis["min"] === undefined)) {
          throw new Error(`${path}.data.valueAxis cannot infer a distinct finite endpoint`);
        }
        if (axis["crosses"] !== undefined && !["autoZero", "min", "max"].includes(axis["crosses"] as string)) {
          throw new Error(`${path}.data.valueAxis.crosses is unsupported`);
        }
      }
    }
  }
}

export function validateSlideDocument(value: unknown): SlidesDocument {
  assertSafeJson(value);
  assertRecord(value, "document");
  assertRecord(value["meta"], "document.meta");
  for (const key of ["title", "themeId", "masterId"] as const) assertString(value["meta"][key], `document.meta.${key}`);
  for (const key of ["themes", "masters", "layouts", "slides", "guides"] as const) {
    if (!Array.isArray(value[key])) throw new Error(`document.${key} must be an array`);
  }
  const themes = value["themes"] as unknown[];
  const masters = value["masters"] as unknown[];
  const layouts = value["layouts"] as unknown[];
  const slides = value["slides"] as unknown[];
  if (slides.length === 0) throw new Error("A native presentation must contain at least one slide");

  const ids = new Set<string>();
  const themeIds = new Set<string>();
  const masterIds = new Set<string>();
  const layoutIds = new Set<string>();
  const addNamed = (entry: unknown, path: string, set: Set<string>) => {
    assertRecord(entry, path); assertString(entry["id"], `${path}.id`);
    if (ids.has(entry["id"])) throw new Error(`duplicate presentation object id: ${entry["id"]}`);
    ids.add(entry["id"]); set.add(entry["id"]);
  };
  themes.forEach((entry, index) => {
    const path = `document.themes[${index}]`;
    addNamed(entry, path, themeIds); assertRecord(entry, path); assertString(entry["name"], `${path}.name`);
    assertStringRecordFields(entry["colors"], `${path}.colors`, ["text", "background", "textSecondary", "backgroundAlt", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hyperlink", "visitedHyperlink"]);
    assertStringRecordFields(entry["fonts"], `${path}.fonts`, ["heading", "body"]);
  });
  masters.forEach((entry, index) => {
    addNamed(entry, `document.masters[${index}]`, masterIds);
    assertRecord(entry, `document.masters[${index}]`);
    assertString(entry["themeId"], `document.masters[${index}].themeId`);
    assertRecord(entry["placeholderStyles"], `document.masters[${index}].placeholderStyles`);
    for (const required of ["title", "body"] as const) assertRecord(entry["placeholderStyles"][required], `document.masters[${index}].placeholderStyles.${required}`);
    validateBackgroundImages(entry["background"], `document.masters[${index}].background`);
  });
  layouts.forEach((entry, index) => {
    addNamed(entry, `document.layouts[${index}]`, layoutIds);
    assertRecord(entry, `document.layouts[${index}]`);
    assertString(entry["masterId"], `document.layouts[${index}].masterId`);
    assertString(entry["name"], `document.layouts[${index}].name`);
    if (!Array.isArray(entry["placeholders"]) || !Array.isArray(entry["staticElements"])) {
      throw new Error(`document.layouts[${index}] must contain placeholders and staticElements arrays`);
    }
    const references: Array<{ id: string; path: string }> = [];
    entry["placeholders"].forEach((element, elementIndex) =>
      validateElement(element, `document.layouts[${index}].placeholders[${elementIndex}]`, ids, references, false));
    entry["staticElements"].forEach((element, elementIndex) =>
      validateElement(element, `document.layouts[${index}].staticElements[${elementIndex}]`, ids, references));
    if (references.length > 0) throw new Error(`document.layouts[${index}] element templates cannot contain attached connector references`);
    validateBackgroundImages(entry["background"], `document.layouts[${index}].background`);
  });
  if (!themeIds.has(value["meta"]["themeId"] as string)) throw new Error("document.meta.themeId references a missing theme");
  if (!masterIds.has(value["meta"]["masterId"] as string)) throw new Error("document.meta.masterId references a missing master");

  masters.forEach((entry, index) => {
    if (!themeIds.has((entry as Record<string, unknown>)["themeId"] as string)) throw new Error(`document.masters[${index}].themeId references a missing theme`);
  });
  layouts.forEach((entry, index) => {
    if (!masterIds.has((entry as Record<string, unknown>)["masterId"] as string)) throw new Error(`document.layouts[${index}].masterId references a missing master`);
  });

  slides.forEach((entry, slideIndex) => {
    const path = `document.slides[${slideIndex}]`;
    addNamed(entry, path, new Set()); assertRecord(entry, path);
    assertString(entry["layoutId"], `${path}.layoutId`);
    if (!layoutIds.has(entry["layoutId"])) throw new Error(`${path}.layoutId references a missing layout`);
    if (entry["themeId"] !== undefined) {
      assertString(entry["themeId"], `${path}.themeId`);
      if (!themeIds.has(entry["themeId"])) throw new Error(`${path}.themeId references a missing theme`);
    }
    if (!Array.isArray(entry["elements"]) || !Array.isArray(entry["notes"])) throw new Error(`${path} must contain elements and notes arrays`);
    // NotesPanel emits paragraph blocks with an intentionally sparse
    // `style: {}`. Notes rendering supplies its own defaults, so validate any
    // style fields that are present while preserving the owned model exactly.
    validateBlocks(entry["notes"], `${path}.notes`, true);
    validateBackgroundImages(entry["background"], `${path}.background`);
    const slideElementIds = new Set<string>();
    const references: Array<{ id: string; path: string }> = [];
    entry["elements"].forEach((element, index) => validateElement(element, `${path}.elements[${index}]`, ids, references));
    entry["elements"].forEach((element) => {
      const collect = (candidate: unknown): void => {
        if (!isRecord(candidate)) return;
        if (typeof candidate["id"] === "string") slideElementIds.add(candidate["id"]);
        if (candidate["type"] === "group" && isRecord(candidate["data"]) && Array.isArray(candidate["data"]["children"])) candidate["data"]["children"].forEach(collect);
      };
      collect(element);
    });
    for (const reference of references) if (!slideElementIds.has(reference.id)) throw new Error(`${reference.path} references a missing element`);
    if (entry["animations"] !== undefined) {
      if (!Array.isArray(entry["animations"])) throw new Error(`${path}.animations must be an array`);
      entry["animations"].forEach((animation, index) => {
        assertRecord(animation, `${path}.animations[${index}]`);
        assertString(animation["id"], `${path}.animations[${index}].id`);
        if (ids.has(animation["id"])) throw new Error(`duplicate presentation object id: ${animation["id"]}`);
        ids.add(animation["id"]);
        assertString(animation["elementId"], `${path}.animations[${index}].elementId`);
        if (!slideElementIds.has(animation["elementId"])) throw new Error(`${path}.animations[${index}].elementId references a missing element`);
      });
    }
  });
  return value as unknown as SlidesDocument;
}

export type SlideAdoptionChange = {
  path: string;
  kind: "changed" | "discarded";
  message: string;
  adoptedValue?: unknown;
};

/** Report all incompatible fields together, with native JSON Pointers that a
 * caller can address. Never apply the engine's suggested transformation here. */
function collectAdoptionChanges(source: unknown, adopted: unknown, label: string, path: string, changes: SlideAdoptionChange[]): void {
  if (Array.isArray(source)) {
    if (!Array.isArray(adopted)) {
      changes.push({ path, kind: "changed", message: `${label} changed during engine adoption`, adoptedValue: adopted });
      return;
    }
    if (adopted.length !== source.length) changes.push({ path, kind: "changed", message: `${label} changed during engine adoption`, adoptedValue: adopted });
    source.forEach((entry, index) => {
      if (index < adopted.length) collectAdoptionChanges(entry, adopted[index], `${label}[${index}]`, `${path}/${index}`, changes);
    });
    return;
  }
  if (isRecord(source)) {
    if (!isRecord(adopted)) {
      changes.push({ path, kind: "changed", message: `${label} changed during engine adoption`, adoptedValue: adopted });
      return;
    }
    for (const [key, entry] of Object.entries(source)) {
      const pointer = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (!Object.hasOwn(adopted, key)) changes.push({ path: pointer, kind: "discarded", message: `${label}.${key} would be discarded by the presentation engine` });
      else collectAdoptionChanges(entry, adopted[key], `${label}.${key}`, pointer, changes);
    }
    return;
  }
  if (!Object.is(source, adopted)) changes.push({ path, kind: "changed", message: `${label} would be changed by the presentation engine`, adoptedValue: adopted });
}

/** Refuse to mount a valid container when the current engine migration would
 * silently discard or rewrite any source field. Additive migration defaults
 * are allowed because they preserve every source fact. */
export function assertSlideAdoptionPreserves(source: SlidesDocument, adopted: SlidesDocument): void {
  const changes: SlideAdoptionChange[] = [];
  collectAdoptionChanges(source, adopted, "document", "", changes);
  if (changes.length === 0) return;
  throw Object.assign(new Error(changes[0].message), {
    code: "engine_adoption_changes_source", phase: "engine_adoption",
    stateChanged: false, retrySafe: true,
    errors: changes, errorCount: changes.length,
    affectedPaths: changes.map(change => change.path),
    recoveryActions: ["inspect_adoption_changes", "correct_input_without_discarding_unrelated_content", "retry_with_current_version"],
  });
}

function attributesFrom(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matcher = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const key = match[1].toLowerCase();
    if (Object.hasOwn(attributes, key)) throw new Error(`duplicate script attribute: ${key}`);
    attributes[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function scriptsFrom(html: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  const matcher = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(html)) !== null) blocks.push({ attributes: attributesFrom(match[1] ?? ""), content: match[2] ?? "" });
  if ((html.match(/<script\b/gi)?.length ?? 0) !== blocks.length) throw new Error("presentation contains an unterminated script block");
  return blocks;
}

function parseJson(raw: string, label: string): unknown {
  try { return JSON.parse(raw.replace(/<\\\/script/gi, "</script")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

export function parseSlideHtml(html: string): SlidesDocument {
  if (typeof html !== "string" || html.trim().length === 0) throw new Error("presentation HTML must be a non-empty string");
  const scripts = scriptsFrom(html);
  if (scripts.length !== 2) throw new Error("presentation HTML must contain exactly two data scripts");
  const manifestBlocks = scripts.filter(({ attributes }) => attributes["id"] === MANIFEST_ID && attributes["type"] === MANIFEST_TYPE);
  if (manifestBlocks.length !== 1) throw new Error("presentation manifest script is missing or ambiguous");
  if (Object.keys(manifestBlocks[0].attributes).some((key) => key !== "id" && key !== "type")) throw new Error("presentation manifest script contains executable or unsupported attributes");
  const manifest = parseJson(manifestBlocks[0].content, "presentation manifest");
  assertSafeJson(manifest, "manifest"); assertRecord(manifest, "manifest");
  if (manifest["documentType"] !== "presentation" || manifest["editor"] !== "wafflebase" || manifest["payloadFormat"] !== PAYLOAD_TYPE || manifest["version"] !== "1.0") {
    throw new Error("presentation manifest identity is invalid");
  }
  if (manifest["payloadId"] !== PAYLOAD_ID) throw new Error("presentation manifest payloadId is invalid");
  const payloadBlocks = scripts.filter(({ attributes }) => attributes["id"] === PAYLOAD_ID && attributes["type"] === PAYLOAD_TYPE);
  if (payloadBlocks.length !== 1) throw new Error("presentation payload script is missing or ambiguous");
  if (Object.keys(payloadBlocks[0].attributes).some((key) => key !== "id" && key !== "type")) throw new Error("presentation payload script contains executable or unsupported attributes");
  return validateSlideDocument(parseJson(payloadBlocks[0].content, "presentation payload"));
}

function safeScriptJson(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c"); }

export function serializeSlideHtml(document: SlidesDocument): string {
  const safe = validateSlideDocument(structuredClone(document));
  const manifest = { documentType: "presentation", editor: "wafflebase", payloadId: PAYLOAD_ID, payloadFormat: PAYLOAD_TYPE, version: "1.0" };
  return ["<!doctype html>", '<html><head><meta charset="utf-8"><title>Presentation</title></head><body>', `<script id="${MANIFEST_ID}" type="${MANIFEST_TYPE}">${safeScriptJson(manifest)}</script>`, `<script id="${PAYLOAD_ID}" type="${PAYLOAD_TYPE}">${safeScriptJson(safe)}</script>`, "</body></html>"].join("\n");
}

export function createSlideDocument(): SlidesDocument {
  const store = new MemSlidesStore();
  store.batch(() => store.addSlide("title-slide"));
  return validateSlideDocument(store.read());
}
