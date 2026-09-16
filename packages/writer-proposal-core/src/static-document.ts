import { parseWriterHtml } from "./writer-html";
import { normalizeEmbeddedRasterDataUrl } from "./raster-data-url";
import { validateBlockStyle, validateInlineStyle, validateTableCellStyle } from "./writer-style-validation";

export type StaticWriterWarning = Readonly<{
  code: "unsupported_block" | "unsupported_style" | "unsafe_link" | "unavailable_image" | "malformed_structure";
  path: string;
  message: string;
}>;

export type StaticWriterDocumentResult =
  | Readonly<{ kind: "ready"; html: string; warnings: readonly StaticWriterWarning[] }>
  | Readonly<{ kind: "not_writer"; message: string }>
  | Readonly<{ kind: "malformed"; message: string }>;

type RecordValue = Record<string, unknown>;
type RenderContext = { warnings: StaticWriterWarning[] };
type ListItem = { level: number; kind: "ol" | "ul"; html: string; attrs: string };

const WRITER_MANIFEST_MARKER = "application/vnd.nautilo.document+json";
const IMAGE_OBJECT_CHARACTER = "\uFFFC";
const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const INLINE_STYLE_KEYS = new Set(["bold", "italic", "underline", "strikethrough", "fontSize", "fontFamily", "color", "backgroundColor", "href", "superscript", "subscript", "clear"]);
const BLOCK_STYLE_KEYS = new Set(["alignment", "lineHeight", "marginTop", "marginBottom", "textIndent", "marginLeft"]);
const CELL_STYLE_KEYS = new Set(["backgroundColor", "verticalAlign", "padding"]);

/** Convert a canonical Writer envelope to inert, self-contained semantic HTML. */
export function buildStaticWriterDocument(source: string): StaticWriterDocumentResult {
  const parsed = parseWriterHtml(source);
  if (!parsed.ok) {
    return source.toLowerCase().includes(WRITER_MANIFEST_MARKER)
      ? { kind: "malformed", message: parsed.error }
      : { kind: "not_writer", message: "The source is not a canonical Writer document." };
  }

  const context: RenderContext = { warnings: [] };
  const body = renderBlocks(parsed.document.document.blocks, "blocks", context);
  const content = body.length > 0 ? body : '<p class="writer-empty">Empty document.</p>';
  const html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
    '<style>html,body{margin:0;padding:0;background:#fff;color:#111}body{font:16px/1.5 system-ui,sans-serif;padding:16px;overflow-wrap:anywhere}' +
    'h1,h2,h3,h4,h5,h6,p,ul,ol,pre,table,hr{margin:0 0 .75em}table{border-collapse:collapse;display:block;max-width:100%;overflow-x:auto}' +
    'td,th{border:1px solid #bbb;padding:.4em;vertical-align:top}img{display:block;max-width:100%;height:auto}.writer-image-unavailable,.writer-unsupported{border-left:3px solid #999;padding:.5em;color:#555}' +
    '</style></head><body><main class="nautilo-writer-static">' + content + '</main></body></html>';
  return { kind: "ready", html, warnings: context.warnings };
}

function renderBlocks(blocks: unknown, path: string, context: RenderContext): string {
  if (!Array.isArray(blocks)) {
    warn(context, "malformed_structure", path, "Expected a block list; its content could not be rendered.");
    return '<p class="writer-unsupported">Document content unavailable.</p>';
  }
  const blockValues = blocks as unknown[];
  const output: string[] = [];
  for (let index = 0; index < blockValues.length;) {
    const block: unknown = blockValues[index];
    const blockPath = `${path}[${index}]`;
    if (isRecord(block) && block["type"] === "list-item") {
      const run: ListItem[] = [];
      while (index < blockValues.length && isRecord(blockValues[index]) && (blockValues[index] as RecordValue)["type"] === "list-item") {
        const item = blockValues[index] as RecordValue;
        const itemPath = `${path}[${index}]`;
        const rawLevel = item["listLevel"];
        let level = Number.isSafeInteger(rawLevel) && Number(rawLevel) >= 0 ? Number(rawLevel) : 0;
        if (level !== rawLevel) warn(context, "malformed_structure", itemPath, "Invalid list depth was rendered at the document level.");
        if (run.length === 0 && level !== 0) {
          warn(context, "malformed_structure", itemPath, "A list cannot begin nested; its depth was normalized.");
          level = 0;
        } else if (run.length > 0 && level > run[run.length - 1]!.level + 1) {
          warn(context, "malformed_structure", itemPath, "A skipped list depth was normalized to preserve reading order.");
          level = run[run.length - 1]!.level + 1;
        }
        run.push({
          level,
          kind: item["listKind"] === "ordered" ? "ol" : "ul",
          html: renderInlines(item["inlines"], `${itemPath}.inlines`, context),
          attrs: blockStyleAttribute(item["style"], `${itemPath}.style`, context),
        });
        index += 1;
      }
      output.push(renderList(run));
      continue;
    }
    output.push(renderBlock(block, blockPath, context));
    index += 1;
  }
  return output.join("");
}

function renderList(items: readonly ListItem[]): string {
  if (items.length === 0) return "";
  const tags: Array<"ol" | "ul"> = [items[0]!.kind];
  let level = 0;
  let html = `<${tags[0]}><li${items[0]!.attrs}>${items[0]!.html || "&nbsp;"}`;
  for (const item of items.slice(1)) {
    if (item.level > level) {
      tags.push(item.kind);
      html += `<${item.kind}><li${item.attrs}>${item.html || "&nbsp;"}`;
      level += 1;
      continue;
    }
    while (level > item.level) {
      html += `</li></${tags.pop()!}>`;
      level -= 1;
    }
    const active = tags[level]!;
    if (active === item.kind) html += `</li><li${item.attrs}>${item.html || "&nbsp;"}`;
    else {
      html += `</li></${active}><${item.kind}><li${item.attrs}>${item.html || "&nbsp;"}`;
      tags[level] = item.kind;
    }
  }
  while (level >= 0) {
    html += `</li></${tags[level]!}>`;
    level -= 1;
  }
  return html;
}

function renderBlock(value: unknown, path: string, context: RenderContext): string {
  if (!isRecord(value)) {
    warn(context, "malformed_structure", path, "A malformed block could not be rendered.");
    return '<p class="writer-unsupported">Unsupported document content.</p>';
  }
  const inlineHtml = renderInlines(value["inlines"], `${path}.inlines`, context);
  const attrs = blockStyleAttribute(value["style"], `${path}.style`, context);
  switch (value["type"]) {
    case "paragraph": return `<p${attrs}>${inlineHtml}</p>`;
    case "title": return `<h1 class="writer-title"${attrs}>${inlineHtml}</h1>`;
    case "subtitle": return `<h2 class="writer-subtitle"${attrs}>${inlineHtml}</h2>`;
    case "heading": {
      const level = Number.isInteger(value["headingLevel"]) && Number(value["headingLevel"]) >= 1 && Number(value["headingLevel"]) <= 6
        ? Number(value["headingLevel"]) : 1;
      if (level !== value["headingLevel"]) warn(context, "malformed_structure", path, "Invalid heading level was rendered as level one.");
      return `<h${level}${attrs}>${inlineHtml}</h${level}>`;
    }
    case "horizontal-rule": return `<hr${attrs}>`;
    case "page-break": return `<hr aria-label="Page break"${attrs}>`;
    case "table": return renderTable(value["tableData"], `${path}.tableData`, context, attrs);
    default: {
      const text = inlineHtml || escapeHtml(collectRecoverableText(value));
      const type = typeof value["type"] === "string" ? value["type"] : "unknown";
      warn(context, "unsupported_block", path, `Unsupported block type ${type} was simplified.`);
      return `<section class="writer-unsupported" data-writer-unsupported="${escapeAttribute(type)}">${text || "Unsupported document content."}</section>`;
    }
  }
}

function renderTable(value: unknown, path: string, context: RenderContext, attrs: string): string {
  if (!isRecord(value) || !Array.isArray(value["rows"])) {
    warn(context, "malformed_structure", path, "Malformed table content was replaced with a visible placeholder.");
    return '<p class="writer-unsupported">Table content unavailable.</p>';
  }
  const rows = value["rows"] as unknown[];
  let html = `<table${attrs}><tbody>`;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row: unknown = rows[rowIndex];
    if (!isRecord(row) || !Array.isArray(row["cells"])) {
      warn(context, "malformed_structure", `${path}.rows[${rowIndex}]`, "Malformed table row was disclosed.");
      html += '<tr><td class="writer-unsupported">Row content unavailable.</td></tr>';
      continue;
    }
    const cells = row["cells"] as unknown[];
    html += "<tr>";
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      const cell: unknown = cells[cellIndex];
      if (!isRecord(cell)) {
        warn(context, "malformed_structure", `${path}.rows[${rowIndex}].cells[${cellIndex}]`, "Malformed table cell was disclosed.");
        html += '<td class="writer-unsupported">Cell content unavailable.</td>';
        continue;
      }
      if (cell["colSpan"] === 0) continue;
      const cellPath = `${path}.rows[${rowIndex}].cells[${cellIndex}]`;
      const attrs = [spanAttribute("colspan", cell["colSpan"]), spanAttribute("rowspan", cell["rowSpan"]),
        tableCellStyleAttribute(cell["style"], `${cellPath}.style`, context)].filter(Boolean).join("");
      html += `<td${attrs}>${renderBlocks(cell["blocks"], `${cellPath}.blocks`, context)}</td>`;
    }
    html += "</tr>";
  }
  return html + "</tbody></table>";
}

function blockStyleAttribute(value: unknown, path: string, context: RenderContext): string {
  if (value === undefined) return "";
  if (!isRecord(value)) {
    warn(context, "malformed_structure", path, "Malformed block styling was ignored.");
    return "";
  }

  const unknown = Object.keys(value).filter((key) => !BLOCK_STYLE_KEYS.has(key));
  if (unknown.length > 0) {
    warn(context, "unsupported_style", path, `Unsupported block style was omitted: ${unknown.join(", ")}.`);
  }

  const declarations: string[] = [];
  const cssNames: Record<string, string> = {
    alignment: "text-align", lineHeight: "line-height", marginTop: "margin-top",
    marginBottom: "margin-bottom", textIndent: "text-indent", marginLeft: "margin-left",
  };
  for (const key of BLOCK_STYLE_KEYS) {
    if (value[key] === undefined) continue;
    const validated = validateBlockStyle({ [key]: value[key] });
    if (!validated.ok) {
      warn(context, "unsupported_style", `${path}.${key}`, `Invalid block style ${key} was omitted.`);
      continue;
    }
    const rendered = typeof value[key] === "string" || typeof value[key] === "number" ? `${value[key]}` : "";
    const suffix = key === "alignment" || key === "lineHeight" ? "" : "px";
    declarations.push(`${cssNames[key]}:${rendered}${suffix}`);
  }
  return styleAttribute(declarations);
}

function tableCellStyleAttribute(value: unknown, path: string, context: RenderContext): string {
  if (value === undefined) return "";
  if (!isRecord(value)) {
    warn(context, "malformed_structure", path, "Malformed table cell styling was ignored.");
    return "";
  }
  const unknown = Object.keys(value).filter((key) => !CELL_STYLE_KEYS.has(key));
  if (unknown.length > 0) warn(context, "unsupported_style", path, `Unsupported table cell style was omitted: ${unknown.join(", ")}.`);
  const declarations: string[] = [];
  for (const key of CELL_STYLE_KEYS) {
    if (value[key] === undefined) continue;
    const validated = validateTableCellStyle({ [key]: value[key] });
    if (!validated.ok) {
      warn(context, "unsupported_style", `${path}.${key}`, `Invalid table cell style ${key} was omitted.`);
      continue;
    }
    if (key === "backgroundColor" && typeof value[key] === "string") declarations.push(`background-color:${normalizeColor(value[key])}`);
    else if (key === "verticalAlign" && typeof value[key] === "string") declarations.push(`vertical-align:${value[key]}`);
    else if (key === "padding" && typeof value[key] === "number") declarations.push(`padding:${value[key]}px`);
  }
  return styleAttribute(declarations);
}

function renderInlines(value: unknown, path: string, context: RenderContext): string {
  if (value === undefined) return "";
  if (!Array.isArray(value)) {
    warn(context, "malformed_structure", path, "Malformed inline content could not be rendered.");
    return "";
  }
  return value.map((inline, index) => renderInline(inline, `${path}[${index}]`, context)).join("");
}

function renderInline(value: unknown, path: string, context: RenderContext): string {
  if (!isRecord(value) || typeof value["text"] !== "string") {
    warn(context, "malformed_structure", path, "Malformed inline content could not be rendered.");
    return "";
  }
  const style = isRecord(value["style"]) ? value["style"] : {};
  if (!isRecord(value["style"])) warn(context, "malformed_structure", `${path}.style`, "Malformed inline styling was ignored.");
  if (value["text"] === IMAGE_OBJECT_CHARACTER && style["image"] !== undefined) return renderImage(style["image"], path, context);

  let html = escapeHtml(value["text"]);
  const known = new Set([...INLINE_STYLE_KEYS, "code", "image"]);
  const unsupported = Object.keys(style).filter((key) => !known.has(key));
  if (unsupported.length > 0) warn(context, "unsupported_style", `${path}.style`, `Unsupported inline style was omitted: ${unsupported.join(", ")}.`);
  const validKeys = new Set<string>();
  for (const key of INLINE_STYLE_KEYS) {
    if (style[key] === undefined) continue;
    const validated = validateInlineStyle({ [key]: style[key] }, "closed");
    if (validated.ok) validKeys.add(key);
    else warn(context, "unsupported_style", `${path}.style.${key}`, `Invalid inline style ${key} was omitted.`);
  }
  if (style["code"] !== undefined) {
    if (typeof style["code"] === "boolean") validKeys.add("code");
    else warn(context, "unsupported_style", `${path}.style.code`, "Invalid inline style code was omitted.");
  }
  const declarations: string[] = [];
  for (const key of ["fontSize", "fontFamily", "color", "backgroundColor"] as const) {
    if (!validKeys.has(key)) continue;
    if (key === "fontSize") declarations.push(`font-size:${String(style[key])}px`);
    else if (key === "fontFamily") declarations.push(`font-family:${cssString(String(style[key]))}`);
    else declarations.push(`${key === "color" ? "color" : "background-color"}:${normalizeColor(String(style[key]))}`);
  }
  if (declarations.length > 0) html = `<span${styleAttribute(declarations)}>${html}</span>`;
  if ((validKeys.has("code") && style["code"] === true) || (validKeys.has("fontFamily") && isMonospace(style["fontFamily"]))) html = `<code>${html}</code>`;
  if (validKeys.has("bold") && style["bold"] === true) html = `<strong>${html}</strong>`;
  if (validKeys.has("italic") && style["italic"] === true) html = `<em>${html}</em>`;
  if (validKeys.has("underline") && style["underline"] === true) html = `<u>${html}</u>`;
  if (validKeys.has("strikethrough") && style["strikethrough"] === true) html = `<s>${html}</s>`;
  if (validKeys.has("superscript") && style["superscript"] === true) html = `<sup>${html}</sup>`;
  if (validKeys.has("subscript") && style["subscript"] === true) html = `<sub>${html}</sub>`;
  if (validKeys.has("href") && typeof style["href"] === "string") {
    const href = safeHref(style["href"]);
    if (href === null) warn(context, "unsafe_link", `${path}.style.href`, "Unsafe or unsupported link destination was removed.");
    else html = `<a href="${escapeAttribute(href)}">${html}</a>`;
  }
  return html;
}

function renderImage(value: unknown, path: string, context: RenderContext): string {
  const source = isRecord(value) && typeof value["src"] === "string" ? normalizeEmbeddedRasterDataUrl(value["src"]) : null;
  if (!isRecord(value) || source === null) {
    warn(context, "unavailable_image", `${path}.style.image`, "Only embedded PNG, JPEG and GIF images are available.");
    return '<span class="writer-image-unavailable">Image unavailable.</span>';
  }
  const alt = typeof value["alt"] === "string" && value["alt"].length > 0 ? value["alt"] : "Embedded image";
  const width = finitePositive(value["width"]) ? ` width="${value["width"]}"` : "";
  const height = finitePositive(value["height"]) ? ` height="${value["height"]}"` : "";
  return `<img src="${source}" alt="${escapeAttribute(alt)}"${width}${height}>`;
}

function safeHref(value: string): string | null {
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || "<>\"'".includes(character);
  })) return null;
  try {
    const parsed = new URL(value);
    return SAFE_LINK_SCHEMES.has(parsed.protocol) ? value : null;
  } catch {
    return null;
  }
}

function collectRecoverableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectRecoverableText).join("");
  if (!isRecord(value)) return "";
  if (typeof value["text"] === "string") return value["text"];
  if (Array.isArray(value["inlines"])) return collectRecoverableText(value["inlines"]);
  if (Array.isArray(value["blocks"])) return collectRecoverableText(value["blocks"]);
  return "";
}

function spanAttribute(name: string, value: unknown): string {
  return Number.isSafeInteger(value) && Number(value) > 1 ? ` ${name}="${Number(value)}"` : "";
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isMonospace(value: unknown): boolean {
  return typeof value === "string" && /^(?:monospace|ui-monospace|courier(?: new)?)$/i.test(value.trim());
}

function styleAttribute(declarations: readonly string[]): string {
  return declarations.length > 0 ? ` style="${escapeAttribute(declarations.join(";"))}"` : "";
}

function normalizeColor(value: string): string {
  return value.startsWith("#") ? value : `#${value}`;
}

function cssString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function warn(context: RenderContext, code: StaticWriterWarning["code"], path: string, message: string): void {
  context.warnings.push({ code, path, message });
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
