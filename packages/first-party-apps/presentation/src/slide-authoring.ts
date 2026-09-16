import { MemSlidesStore, type ElementInit, type SlidesDocument } from "../engine/node.js";
import { applyDesignTheme } from "./slide-design";
import { assertSlideAdoptionPreserves, parseSlideHtml, validateSlideDocument } from "./slide-document";
import { patchSlideJson } from "./slide-json-patch";
import { assertNativeSlideModel } from "./slide-model-validation";
import { insertSlideTemplate } from "./slide-templates";

export type SlideAuthoringResources = {
  assets?: { read(target: unknown): Promise<unknown> };
  templates?: { read(input: { templateId: string }): Promise<{ content: string }> };
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

/** The loader preserves old documents. New general authoring additionally checks
 * the complete native field schema before allowing an edit to be published. */
export function validateAuthoredSlideDocument(value: unknown): SlidesDocument {
  assertNativeSlideModel(value);
  const document = validateSlideDocument(value);
  const adopted = new MemSlidesStore(document).read();
  assertSlideAdoptionPreserves(document, adopted);
  return adopted;
}

/** Convenience transforms own ID/geometry/resource bookkeeping. `patch` remains
 * the general data path for the entire native model, including rich formatting. */
export async function applySlideAuthoringOperation(
  source: SlidesDocument,
  operation: Record<string, unknown>,
  resources: SlideAuthoringResources,
): Promise<{ document: SlidesDocument; receipt: Record<string, unknown> } | null> {
  const op = operation["op"];
  if (op === "patch") {
    const patched = patchSlideJson(source, operation["changes"]);
    // Final validation belongs to the enclosing transaction so a later patch
    // may complete references created earlier in the same atomic batch.
    return { document: patched.value as SlidesDocument, receipt: { op, changedPaths: patched.paths } };
  }
  if (!["add-element", "duplicate-slide", "apply-theme", "apply-layout", "group-elements", "ungroup-element", "insert-template", "insert-image"].includes(op as string)) return null;
  const store = new MemSlidesStore(validateAuthoredSlideDocument(source));
  const mutate = <T>(operation: () => T): T => {
    let result!: T;
    store.batch(() => { result = operation(); });
    return result;
  };
  let receipt: Record<string, unknown> = { op };
  if (op === "apply-theme") {
    const themeId = string(operation["themeId"], "themeId");
    applyDesignTheme(store, themeId);
    receipt = { op, themeId };
  } else if (op === "insert-template") {
    if (!resources.templates) throw new Error("The host template library is unavailable; reconnect to an updated server.");
    const templateId = string(operation["templateId"], "templateId");
    const template = parseSlideHtml((await resources.templates.read({ templateId })).content);
    const after = operation["afterSlideId"] === undefined ? undefined : string(operation["afterSlideId"], "afterSlideId");
    const slideId = insertSlideTemplate(store, validateAuthoredSlideDocument(template), after);
    receipt = { op, templateId, slideId };
  } else {
    const slideId = string(operation["slideId"], "slideId");
    if (!source.slides.some(slide => slide.id === slideId)) throw new Error(`slide does not exist: ${slideId}`);
    if (op === "duplicate-slide") receipt = { op, sourceSlideId: slideId, slideId: mutate(() => store.duplicateSlide(slideId)) };
    else if (op === "apply-layout") {
      const layoutId = string(operation["layoutId"], "layoutId");
      if (!source.layouts.some(layout => layout.id === layoutId)) throw new Error(`layout does not exist: ${layoutId}`);
      mutate(() => store.applyLayout(slideId, layoutId));
      receipt = { op, slideId, layoutId };
    } else if (op === "group-elements") {
      if (!Array.isArray(operation["elementIds"])) throw new Error("elementIds must be an array");
      const ids = operation["elementIds"].map(id => string(id, "elementId"));
      receipt = { op, slideId, ...mutate(() => store.group(slideId, ids)) };
    } else if (op === "ungroup-element") {
      const groupId = string(operation["groupId"], "groupId");
      receipt = { op, slideId, groupId, elementIds: mutate(() => store.ungroup(slideId, groupId)) };
    } else {
      const parent = operation["parentGroupId"] === undefined ? undefined : string(operation["parentGroupId"], "parentGroupId");
      let element = structuredClone(object(operation["element"], "element"));
      if (Object.hasOwn(element, "id")) throw new Error("add-element generates its ID; omit element.id and use the returned identity");
      if (op === "insert-image") {
        if (!resources.assets) throw new Error("The host image resolver is unavailable; reconnect to an updated server.");
        const asset = object(await resources.assets.read(operation["asset"]), "resolved asset");
        if (asset["ok"] !== true) throw Object.assign(
          new Error(typeof asset["message"] === "string" ? asset["message"] : "Image source could not be read"),
          { code: asset["code"], phase: "resolve_asset", stateChanged: false, retrySafe: true, recoveryActions: ["inspect_source_asset", "choose_authorized_asset"] });
        const data = object(element["data"] ?? {}, "element.data");
        if (Object.hasOwn(data, "src")) throw new Error("insert-image resolves source bytes itself; omit element.data.src");
        element = { ...element, type: "image", data: { ...data, src: string(asset["dataUrl"], "resolved data URL") } };
        receipt = { op, slideId, sourceSha256: asset["sha256"], sourceBytes: asset["byteLength"], mimeType: asset["mimeType"] };
      }
      // Validate complete native payload before invoking typed engine methods.
      const candidate = structuredClone(source);
      const identity = crypto.randomUUID();
      candidate.slides.find(slide => slide.id === slideId)!.elements.push({ ...element, id: identity } as unknown as SlidesDocument["slides"][number]["elements"][number]);
      validateAuthoredSlideDocument(candidate);
      const elementId = mutate(() => store.addElement(slideId, element as unknown as ElementInit, parent));
      receipt = { ...receipt, slideId, elementId };
    }
  }
  return { document: store.read(), receipt };
}
