/**
 * `.design.html` text container — parse/serialize the HTML wrapper around the
 * renderer-neutral scene graph JSON. Mirrors spreadsheet-html-document.ts.
 *
 * The persisted artifact is an HTML document with two non-executable script
 * blocks:
 *   - `<script type="application/vnd.nautilo.design+json" id="manifest">` —
 *     document manifest (type/editor/version).
 *   - `<script type="application/vnd.nautilo.design-scene+json" id="scene">` —
 *     the scene graph payload (see scene-graph.ts).
 *
 * The `<body>` contains a read-only static SVG preview of the first page so
 * the artifact is human-readable when opened outside the mini-app.
 */

import {
  assertSafeObjectKeys,
  createEmptyDocument,
  DESIGN_DOCUMENT_VERSION,
  findPage,
  firstPageId,
  parseDesignDocument,
  validateDesignDocument,
  type DesignDocument,
  type DesignStroke,
} from "./scene-graph";
import { nodePaint } from "./render-style";
import { dashArrayToString, pathDataFromVectorNetwork } from "./vector";
import {
  buildExactBooleanComposition,
  type BooleanSvgNode,
  type ExactBooleanComposition,
} from "./boolean-composition";
import { matrixToSvgTransform, nodeRenderBounds, nodeTransformMatrix, type GeometryBounds } from "./geometry";
import { designBundledFontFaceCss } from "./bundled-fonts";
import { bundledFontTextByWeight, layoutTextNode, textRenderStyle, type TextMeasurer } from "./text-layout";
import { textOutlinePath } from "./text-outlines";

export const NAUTILO_DESIGN_MANIFEST_TYPE = "application/vnd.nautilo.design+json";
export const NAUTILO_DESIGN_MANIFEST_ID = "manifest";
export const NAUTILO_DESIGN_SCENE_TYPE = "application/vnd.nautilo.design-scene+json";
export const NAUTILO_DESIGN_SCENE_ID = "scene";
export const DESIGN_DOCUMENT_TYPE = "design";
export const DESIGN_EDITOR = "nautilo-design";
export const DESIGN_HTML_VERSION = "1.0";
const PREVIEW_PADDING = 32;

export type DesignHtmlManifest = {
  documentType: typeof DESIGN_DOCUMENT_TYPE;
  editor: typeof DESIGN_EDITOR;
  payloadId: string;
  payloadFormat: typeof NAUTILO_DESIGN_SCENE_TYPE;
  version: typeof DESIGN_HTML_VERSION;
  metadata?: {
    createdBy?: string;
    updatedAt?: string;
  };
};

export type DesignHtmlDocument = {
  manifest: DesignHtmlManifest;
  scene: DesignDocument;
};

export type DesignHtmlParseResult =
  | { ok: true; document: DesignHtmlDocument }
  | { ok: false; error: string };

type ScriptBlock = {
  attrs: Record<string, string>;
  content: string;
};

function escapeHtml(value: string | number): string {
  const text = typeof value === "number" ? value.toString() : value;
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeScriptJson(json: string): string {
  return json.replace(/<\/script/gi, "<\\/script");
}

function stripEscapedScriptEnd(text: string): string {
  return text.replace(/<\\\/script/gi, "</script");
}

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

function parseJsonBlock(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function validateManifest(value: unknown): DesignHtmlManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest must be an object.");
  }
  const unsafe = assertSafeObjectKeys(value as Record<string, unknown>, "manifest");
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (record["documentType"] !== DESIGN_DOCUMENT_TYPE) {
    throw new Error('Manifest documentType must be "design".');
  }
  if (record["editor"] !== DESIGN_EDITOR) {
    throw new Error(`Manifest editor must be "${DESIGN_EDITOR}".`);
  }
  if (typeof record["payloadId"] !== "string" || record["payloadId"].trim().length === 0) {
    throw new Error("Manifest payloadId must be a non-empty string.");
  }
  if (record["payloadFormat"] !== NAUTILO_DESIGN_SCENE_TYPE) {
    throw new Error(`Manifest payloadFormat must be "${NAUTILO_DESIGN_SCENE_TYPE}".`);
  }
  if (record["version"] !== DESIGN_HTML_VERSION) {
    throw new Error(`Manifest version must be "${DESIGN_HTML_VERSION}".`);
  }
  const manifest: DesignHtmlManifest = {
    documentType: DESIGN_DOCUMENT_TYPE,
    editor: DESIGN_EDITOR,
    payloadId: record["payloadId"].trim(),
    payloadFormat: NAUTILO_DESIGN_SCENE_TYPE,
    version: DESIGN_HTML_VERSION,
  };
  if (record["metadata"] !== undefined) {
    if (!record["metadata"] || typeof record["metadata"] !== "object" || Array.isArray(record["metadata"])) {
      throw new Error("Manifest metadata must be an object.");
    }
    const metaUnsafe = assertSafeObjectKeys(
      record["metadata"] as Record<string, unknown>,
      "manifest.metadata",
    );
    if (metaUnsafe) throw new Error(metaUnsafe);
    const meta = record["metadata"] as Record<string, unknown>;
    const metadata: NonNullable<DesignHtmlManifest["metadata"]> = {};
    if (meta["createdBy"] !== undefined) {
      if (typeof meta["createdBy"] !== "string") {
        throw new Error("metadata.createdBy must be a string.");
      }
      metadata.createdBy = meta["createdBy"];
    }
    if (meta["updatedAt"] !== undefined) {
      if (typeof meta["updatedAt"] !== "string") {
        throw new Error("metadata.updatedAt must be a string.");
      }
      metadata.updatedAt = meta["updatedAt"];
    }
    manifest.metadata = metadata;
  }
  return manifest;
}

function findRequiredScript(blocks: ScriptBlock[], id: string, type: string): ScriptBlock {
  const matches = blocks.filter(
    (block) => block.attrs["id"] === id && block.attrs["type"]?.toLowerCase() === type,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one script#${id} with type ${type}.`);
  }
  return matches[0]!;
}

export function parseDesignHtml(raw: string): DesignHtmlParseResult {
  try {
    const blocks = extractScriptBlocks(raw);
    const executable = blocks.find((block) => {
      const type = block.attrs["type"]?.toLowerCase();
      return !type || type === "text/javascript" || type === "module" || block.attrs["src"];
    });
    if (executable) {
      throw new Error("Design documents must not contain executable script tags.");
    }
    const manifestBlock = findRequiredScript(
      blocks,
      NAUTILO_DESIGN_MANIFEST_ID,
      NAUTILO_DESIGN_MANIFEST_TYPE,
    );
    const manifest = validateManifest(parseJsonBlock(manifestBlock.content, "Manifest"));
    const sceneBlock = findRequiredScript(
      blocks,
      manifest.payloadId,
      manifest.payloadFormat,
    );
    const scene = validateDesignDocument(parseJsonBlock(sceneBlock.content, "Scene"));
    return { ok: true, document: { manifest, scene } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createDefaultManifest(): DesignHtmlManifest {
  return {
    documentType: DESIGN_DOCUMENT_TYPE,
    editor: DESIGN_EDITOR,
    payloadId: NAUTILO_DESIGN_SCENE_ID,
    payloadFormat: NAUTILO_DESIGN_SCENE_TYPE,
    version: DESIGN_HTML_VERSION,
    metadata: {
      createdBy: "nautilo",
      updatedAt: new Date().toISOString(),
    },
  };
}

// ----- SVG preview (pure string builder, no DOM) -----

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error("SVG geometry must contain finite coordinates.");
  return String(n);
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function svgAttr(name: string, value: string | number): string {
  return ` ${name}="${escapeHtml(typeof value === "number" ? formatNumber(value) : value)}"`;
}

function strokeAttrs(stroke: DesignStroke | undefined): string {
  if (!stroke) return "";
  let out = `${svgAttr("stroke", stroke.color)}${svgAttr("stroke-width", stroke.width)}`;
  if (stroke.cap !== undefined) out += svgAttr("stroke-linecap", stroke.cap);
  if (stroke.join !== undefined) out += svgAttr("stroke-linejoin", stroke.join);
  if (stroke.dash !== undefined) {
    const dash = dashArrayToString(stroke.dash);
    if (dash !== null) out += svgAttr("stroke-dasharray", dash);
  }
  return out;
}

/** Preview bounds use the same center-origin rotation geometry as the canvas. */
function previewBounds(doc: DesignDocument, nodeIds: readonly string[], textMeasurer?: TextMeasurer | null): GeometryBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  const visit = (id: string): void => {
    const node = doc.nodes[id];
    if (!node || node.hidden) return;
    if (node.booleanOp !== undefined) {
      const result = buildExactBooleanComposition(doc, node);
      if (!result.ok) return;
      const bounds = result.composition.bounds;
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
      seen = true;
      return;
    }
    if (node.type !== "group") {
      const bounds = nodeRenderBounds(node, textMeasurer);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
      seen = true;
    }
    for (const childId of node.childIds) visit(childId);
  };
  for (const id of nodeIds) visit(id);
  return seen ? { minX, minY, maxX, maxY } : null;
}

function booleanSvgNode(node: BooleanSvgNode): string {
  if (node.kind === "path") return `<path${svgAttr("d", node.pathData)}/>`;
  if (node.kind === "use") return `<use${svgAttr("href", `#${node.id}`)}/>`;
  const mask = node.maskId ? svgAttr("mask", `url(#${node.maskId})`) : "";
  const fill = node.fill ? svgAttr("fill", node.fill) : "";
  return `<g${mask}${fill}>${node.children.map(booleanSvgNode).join("")}</g>`;
}

function exactBooleanSvg(composition: ExactBooleanComposition): string {
  const defs = composition.defs.length === 0
    ? ""
    : `<defs>${composition.defs.map((def) => {
      if (def.kind === "shape") {
        return `<g${svgAttr("id", def.id)}>${booleanSvgNode(def.content)}</g>`;
      }
      const width = Math.max(1, def.bounds.maxX - def.bounds.minX);
      const height = Math.max(1, def.bounds.maxY - def.bounds.minY);
      return `<mask${svgAttr("id", def.id)} maskUnits="userSpaceOnUse"${svgAttr("x", def.bounds.minX)}${svgAttr("y", def.bounds.minY)}${svgAttr("width", width)}${svgAttr("height", height)}>${booleanSvgNode(def.content)}</mask>`;
    }).join("")}</defs>`;
  return `${defs}${booleanSvgNode(composition.body)}`;
}

export type RenderSceneSvgOptions = {
  nodeIds?: readonly string[];
  textMeasurer?: TextMeasurer | null;
  /** Use exact bundled-font geometry for host rasterization. */
  outlineText?: boolean;
  /** Fail before emitting a visible image source into an export artifact. */
  rejectImageSources?: boolean;
  /** Emit opaque references for the authorized host export resolver only. */
  hostAssetReferences?: boolean;
};

export class UnsupportedImageSourceError extends Error {
  constructor() {
    super("Design export requires resolved image assets.");
    this.name = "UnsupportedImageSourceError";
  }
}

function ancestorPresentation(doc: DesignDocument, nodeId: string): { hidden: boolean; opacity: number } {
  let opacity = 1;
  let parentId = doc.nodes[nodeId]?.parentId ?? null;
  while (parentId !== null) {
    const parent = doc.nodes[parentId];
    if (!parent) break;
    if (parent.hidden) return { hidden: true, opacity: 0 };
    opacity *= parent.opacity ?? 1;
    parentId = parent.parentId;
  }
  return { hidden: false, opacity };
}

/** Emit SVG with absolute spatial geometry and structural opacity inheritance. */
export function renderSceneSvg(
  doc: DesignDocument,
  pageId?: string,
  options?: RenderSceneSvgOptions,
): string {
  const resolvedPageId = pageId ?? firstPageId(doc);
  if (!resolvedPageId) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"></svg>`;
  }
  const page = findPage(doc, resolvedPageId);
  if (!page) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"></svg>`;
  }
  const requestedRoots = options?.nodeIds
    ? [...new Set(options.nodeIds)]
    : page.children;
  if (options?.nodeIds) {
    for (const id of requestedRoots) {
      const node = doc.nodes[id];
      if (!node) throw new Error(`Cannot export unknown node ${id}.`);
      let root = node;
      while (root.parentId !== null) {
        const parent = doc.nodes[root.parentId];
        if (!parent) throw new Error(`Cannot export node ${id} with missing parent ${root.parentId}.`);
        root = parent;
      }
      if (!page.children.includes(root.id)) {
        throw new Error(`Cannot export node ${id} from page ${resolvedPageId}.`);
      }
    }
  }
  const requested = new Set(requestedRoots);
  const rootIds = requestedRoots.filter((id) => {
    let parentId = doc.nodes[id]?.parentId ?? null;
    while (parentId !== null) {
      if (requested.has(parentId)) return false;
      parentId = doc.nodes[parentId]?.parentId ?? null;
    }
    return true;
  });
  const visibleRootIds = rootIds.filter((id) => !ancestorPresentation(doc, id).hidden);
  const bounds = previewBounds(doc, visibleRootIds, options?.textMeasurer);
  let width = 800;
  let height = 600;
  let offsetX = 0;
  let offsetY = 0;
  if (bounds) {
    width = Math.max(1, bounds.maxX - bounds.minX) + PREVIEW_PADDING * 2;
    height = Math.max(1, bounds.maxY - bounds.minY) + PREVIEW_PADDING * 2;
    offsetX = bounds.minX - PREVIEW_PADDING;
    offsetY = bounds.minY - PREVIEW_PADDING;
  }
  const renderNodeRecursive = (id: string): string => {
    const node = doc.nodes[id];
    if (!node || node.hidden) return "";
    const opacityAttr =
      node.opacity !== undefined && node.opacity !== 1 ? svgAttr("opacity", node.opacity) : "";
    const transformAttr =
      (node.rotation !== undefined && node.rotation !== 0) || node.skewX || node.flipX
        ? svgAttr("transform", matrixToSvgTransform(nodeTransformMatrix(node)))
        : "";
    const paint = nodePaint(node);
    const fillAttr = svgAttr("fill", paint.fill ?? "none");
    const stroke = strokeAttrs(paint.stroke);
    const groupOpen = `<g${transformAttr}${fillAttr}${stroke}>`;
    let body = "";
    if (node.booleanOp !== undefined) {
      const result = buildExactBooleanComposition(doc, node);
      if (!result.ok) {
        if (options?.outlineText) throw new Error(result.reason);
        return `<g${opacityAttr}${svgAttr("data-boolean-error", result.reason)}><title>${escapeXmlText(result.reason)}</title></g>`;
      }
      return `<g${opacityAttr}${fillAttr}>${exactBooleanSvg(result.composition)}</g>`;
    }
    if (node.type === "text") {
      const font = textRenderStyle(node);
      const fontSize = font.fontSize;
      const fontFamily = font.fontFamily;
      const fontWeight =
        node.textWrap || node.fontWeight !== undefined ? svgAttr("font-weight", String(font.fontWeight)) : "";
      const anchor =
        node.textAlign === "center" ? "middle" : node.textAlign === "right" ? "end" : "start";
      const textAnchor = svgAttr("text-anchor", anchor);
      const anchorX = node.textAlign === "center" ? node.width / 2 : node.textAlign === "right" ? node.width : 0;
      const color = node.color ?? "#0f172a";
      const layout = layoutTextNode(node, options?.textMeasurer);
      const fontStretch = node.fontStretch ?? 1;
      const stretchTransform = fontStretch === 1
        ? ""
        : svgAttr("transform", `translate(${formatNumber(node.x + anchorX)} 0) scale(${formatNumber(fontStretch)} 1) translate(${formatNumber(-(node.x + anchorX))} 0)`);
      const tspans = layout.lines
        .map((line, i) => {
          const y = node.y + fontSize + i * layout.lineHeight;
          return `<tspan x="${formatNumber(node.x + anchorX)}" y="${formatNumber(y)}">${escapeXmlText(line)}</tspan>`;
        })
        .join("");
      if (options?.outlineText) {
        const path = textOutlinePath(node);
        body = path ? `<path${stretchTransform}${svgAttr("fill", color)}${svgAttr("d", path)}/>` : "";
      } else {
        body = `<text${stretchTransform}${svgAttr("font-size", fontSize)}${svgAttr("font-family", fontFamily)}${fontWeight}${svgAttr("fill", color)}${textAnchor}>${tspans}</text>`;
      }
    } else if (node.type === "image") {
      if (node.assetRef) {
        body = options?.hostAssetReferences
          ? `<image${svgAttr("href", `nautilo-asset:${node.assetRef}`)}${svgAttr("x", node.x)}${svgAttr("y", node.y)}${svgAttr("width", node.width)}${svgAttr("height", node.height)} preserveAspectRatio="xMidYMid meet"/>`
          : `<rect${svgAttr("x", node.x)}${svgAttr("y", node.y)}${svgAttr("width", node.width)}${svgAttr("height", node.height)} fill="#e2e8f0" stroke="#64748b"/><text${svgAttr("x", node.x + 8)}${svgAttr("y", node.y + 20)} font-size="12" fill="#334155">Image — open in Nautilo Design</text>`;
      } else {
        if (options?.rejectImageSources && node.src?.trim()) throw new UnsupportedImageSourceError();
        if (options?.outlineText) throw new Error("PNG export requires resolved image assets.");
        const href = node.src ?? "";
        body = `<image${svgAttr("href", href)}${svgAttr("x", node.x)}${svgAttr("y", node.y)}${svgAttr("width", node.width)}${svgAttr("height", node.height)} preserveAspectRatio="xMidYMid meet"/>`;
      }
    } else if (node.type === "vector") {
      const d = node.vectorNetwork
        ? pathDataFromVectorNetwork(node.vectorNetwork)
        : node.vectorPath;
      if (d) {
        body = `<path${svgAttr("transform", `translate(${formatNumber(node.x)} ${formatNumber(node.y)})`)}${svgAttr("d", d)}/>`;
      }
    } else if (node.type === "rectangle") {
      const radiusYAttr = node.radius !== undefined && node.radius > 0
        ? svgAttr("ry", node.radiusY ?? node.radius)
        : "";
      body = `<rect${svgAttr("x", node.x)}${svgAttr("y", node.y)}${svgAttr("width", node.width)}${svgAttr("height", node.height)}${node.radius !== undefined && node.radius > 0 ? svgAttr("rx", node.radius) : ""}${radiusYAttr}/>`;
    } else if (node.type === "frame" || node.type === "group") {
      if (node.type === "frame") {
        const radiusYAttr = node.radius !== undefined && node.radius > 0
          ? svgAttr("ry", node.radiusY ?? node.radius)
          : "";
        body = `<rect${svgAttr("x", node.x)}${svgAttr("y", node.y)}${svgAttr("width", node.width)}${svgAttr("height", node.height)}${node.radius !== undefined && node.radius > 0 ? svgAttr("rx", node.radius) : ""}${radiusYAttr}/>`;
      }
    }
    const own = `${groupOpen}${body}</g>`;
    const children = node.childIds.map(renderNodeRecursive).join("");
    return `<g${opacityAttr}>${own}${children}</g>`;
  };
  const innerSvg = visibleRootIds
    .map((id) => {
      const rendered = renderNodeRecursive(id);
      const inheritedOpacity = ancestorPresentation(doc, id).opacity;
      return inheritedOpacity === 1 ? rendered : `<g${svgAttr("opacity", inheritedOpacity)}>${rendered}</g>`;
    })
    .join("");
  const embeddedFontCss = options?.outlineText ? "" : designBundledFontFaceCss(bundledFontTextByWeight(Object.values(doc.nodes)));
  const fontCss = embeddedFontCss ? `<style>${embeddedFontCss}</style>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(width)}" height="${formatNumber(height)}" viewBox="${formatNumber(offsetX)} ${formatNumber(offsetY)} ${formatNumber(width)} ${formatNumber(height)}">${fontCss}${innerSvg}</svg>`;
}

export function buildDesignPreviewHtml(doc: DesignDocument): string {
  const page = doc.pages[0];
  const title = escapeHtml(page?.name ?? "Design");
  const svg = renderSceneSvg(doc, page?.id);
  if (Object.keys(doc.nodes).length === 0) {
    return `<main class="nautilo-design-preview"><h1>${title}</h1><p>Empty design. Open with Nautilo Design to edit.</p></main>`;
  }
  return `<main class="nautilo-design-preview"><h1>${title}</h1>${svg}<p>Static preview. Open with Nautilo Design to edit.</p></main>`;
}

export type SerializeDesignHtmlOptions = {
  touchMetadata?: boolean;
  updatedAt?: string;
};

export function serializeDesignHtml(
  manifest: DesignHtmlManifest,
  scene: DesignDocument,
  opts: SerializeDesignHtmlOptions = {},
): string {
  const normalizedScene = validateDesignDocument(scene);
  const metadata =
    opts.touchMetadata === true
      ? {
          ...manifest.metadata,
          updatedAt: opts.updatedAt ?? new Date().toISOString(),
        }
      : manifest.metadata;
  const nextManifest: DesignHtmlManifest = {
    ...manifest,
    ...(metadata ? { metadata } : {}),
  };
  const manifestJson = escapeScriptJson(JSON.stringify(nextManifest, null, 2));
  const sceneJson = escapeScriptJson(JSON.stringify(normalizedScene, null, 2));
  const preview = buildDesignPreviewHtml(normalizedScene);
  const title = escapeHtml(normalizedScene.pages[0]?.name ?? "Design");
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 1.5rem; color: #0f172a; background: #fff; }
      .nautilo-design-preview h1 { font-size: 1.1rem; margin: 0 0 0.75rem; }
      .nautilo-design-preview svg { max-width: 100%; height: auto; border: 1px solid #e2e8f0; background: #f8fafc; }
      .nautilo-design-preview p { color: #64748b; font-size: 0.8rem; margin: 0.5rem 0 0; }
    </style>
    <script type="${NAUTILO_DESIGN_MANIFEST_TYPE}" id="${NAUTILO_DESIGN_MANIFEST_ID}">
${manifestJson}
    </script>
    <script type="${manifest.payloadFormat}" id="${manifest.payloadId}">
${sceneJson}
    </script>
  </head>
  <body>
    ${preview}
  </body>
</html>
`;
  return html;
}

export function createEmptyDesignHtml(): string {
  return serializeDesignHtml(createDefaultManifest(), createEmptyDocument());
}

/** Re-export for tests that want to parse a raw scene JSON payload directly. */
export { parseDesignDocument, DESIGN_DOCUMENT_VERSION };
