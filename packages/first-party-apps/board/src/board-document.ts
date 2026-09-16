import type { BoardModel } from "@nautilo/office-board";
import { buildElementWorldLookup, connectionSitesForKind, siteWorldPos } from "@nautilo/office-slides/node";
import { assertNativeBoardModel } from "./board-model-validation";

const MANIFEST_ID = "manifest";
const MANIFEST_TYPE = "application/vnd.nautilo.document+json";
const PAYLOAD_ID = "wafflebase-board";
const PAYLOAD_TYPE = "application/vnd.wafflebase.board+json";
export const BOARD_FILE_EXTENSION = ".board.html" as const;

type ScriptBlock = { attributes: Record<string, string>; content: string };
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateBoardDocument(value: unknown): BoardModel {
  assertNativeBoardModel(value);
  return value;
}

type BoardAdoptionChange = {
  path: string;
  kind: "changed" | "discarded";
  message: string;
  adoptedValue?: unknown;
};

function collectAdoptionChanges(
  source: unknown,
  adopted: unknown,
  label: string,
  path: string,
  changes: BoardAdoptionChange[],
): void {
  if (Array.isArray(source)) {
    if (!Array.isArray(adopted)) {
      changes.push({ path, kind: "changed", message: `${label} changed during Board engine adoption`, adoptedValue: adopted });
      return;
    }
    if (adopted.length !== source.length) {
      changes.push({ path, kind: "changed", message: `${label} changed during Board engine adoption`, adoptedValue: adopted });
    }
    source.forEach((entry, index) => {
      if (index < adopted.length) collectAdoptionChanges(entry, adopted[index], `${label}[${index}]`, `${path}/${index}`, changes);
    });
    return;
  }
  if (isRecord(source)) {
    if (!isRecord(adopted)) {
      changes.push({ path, kind: "changed", message: `${label} changed during Board engine adoption`, adoptedValue: adopted });
      return;
    }
    for (const [key, entry] of Object.entries(source)) {
      const pointer = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (!Object.hasOwn(adopted, key)) {
        changes.push({ path: pointer, kind: "discarded", message: `${label}.${key} would be discarded by the Board engine` });
      } else {
        collectAdoptionChanges(entry, adopted[key], `${label}.${key}`, pointer, changes);
      }
    }
    return;
  }
  if (!Object.is(source, adopted)) {
    changes.push({ path, kind: "changed", message: `${label} would be changed by the Board engine`, adoptedValue: adopted });
  }
}

/** Refuse engine adoption if it would rewrite or discard any source fact.
 * Additive engine defaults are allowed because source content remains exact. */
export function assertBoardAdoptionPreserves(source: BoardModel, adopted: BoardModel): void {
  const changes: BoardAdoptionChange[] = [];
  collectAdoptionChanges(source, adopted, "document", "", changes);
  if (changes.length === 0) return;
  throw Object.assign(new Error(changes[0].message), {
    code: "engine_adoption_changes_source",
    phase: "engine_adoption",
    stateChanged: false,
    retrySafe: true,
    errors: changes,
    errorCount: changes.length,
    affectedPaths: changes.map((change) => change.path),
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
  while ((match = matcher.exec(html)) !== null) {
    blocks.push({ attributes: attributesFrom(match[1] ?? ""), content: match[2] ?? "" });
  }
  if ((html.match(/<script\b/gi)?.length ?? 0) !== blocks.length) throw new Error("Board contains an unterminated script block");
  return blocks;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw.replace(/<\\\/script/gi, "</script"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function assertOnlyDataAttributes(block: ScriptBlock, label: string): void {
  if (Object.keys(block.attributes).some((key) => key !== "id" && key !== "type")) {
    throw new Error(`${label} script contains executable or unsupported attributes`);
  }
}

export function parseBoardHtml(content: string): BoardModel {
  if (typeof content !== "string" || content.trim().length === 0) throw new Error("Board HTML must be a non-empty string");
  const scripts = scriptsFrom(content);
  if (scripts.length !== 2) throw new Error("Board HTML must contain exactly two data scripts");
  const manifests = scripts.filter(({ attributes }) => attributes["id"] === MANIFEST_ID && attributes["type"] === MANIFEST_TYPE);
  if (manifests.length !== 1) throw new Error("Board manifest script is missing or ambiguous");
  assertOnlyDataAttributes(manifests[0], "Board manifest");
  const manifest = parseJson(manifests[0].content, "Board manifest");
  if (!isRecord(manifest) || manifest["documentType"] !== "board" || manifest["editor"] !== "wafflebase" ||
      manifest["payloadId"] !== PAYLOAD_ID || manifest["payloadFormat"] !== PAYLOAD_TYPE || manifest["version"] !== "1.0") {
    throw new Error("Board manifest identity is invalid");
  }
  const payloads = scripts.filter(({ attributes }) => attributes["id"] === PAYLOAD_ID && attributes["type"] === PAYLOAD_TYPE);
  if (payloads.length !== 1) throw new Error("Board payload script is missing or ambiguous");
  assertOnlyDataAttributes(payloads[0], "Board payload");
  return validateBoardDocument(parseJson(payloads[0].content, "Board payload"));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function textFrom(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value["text"] === "string") return value["text"];
  const blocks = value["blocks"];
  if (!Array.isArray(blocks)) return "";
  return blocks.map((block) => {
    if (!isRecord(block) || !Array.isArray(block["inlines"])) return "";
    return block["inlines"].map((inline) => isRecord(inline) && typeof inline["text"] === "string" ? inline["text"] : "").join("");
  }).join("\n");
}

function staticPreview(model: BoardModel): string {
  // The shared helper applies every ancestor group's refSize scale, rotation,
  // flip and translation in the same order as the native canvas renderer.
  const worldLookup = buildElementWorldLookup(model.elements);
  const flattened = [...worldLookup.values()] as unknown as UnknownRecord[];
  const framed = flattened.filter((element) => isRecord(element["frame"]));
  let minX = 0; let minY = 0; let maxX = 1; let maxY = 1;
  if (framed.length > 0) {
    const first = framed[0]["frame"] as UnknownRecord;
    minX = first["x"] as number; minY = first["y"] as number;
    maxX = minX + (first["w"] as number); maxY = minY + (first["h"] as number);
    for (let index = 1; index < framed.length; index += 1) {
      const frame = framed[index]["frame"] as UnknownRecord;
      const x = frame["x"] as number; const y = frame["y"] as number;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + (frame["w"] as number)); maxY = Math.max(maxY, y + (frame["h"] as number));
    }
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min(900 / spanX, 500 / spanY, 1);
  const endpointPoint = (endpoint: UnknownRecord): { x: number; y: number } | undefined => {
    if (endpoint["kind"] === "free") return { x: endpoint["x"] as number, y: endpoint["y"] as number };
    const attached = worldLookup.get(endpoint["elementId"] as string);
    if (!attached) return undefined;
    const kind = attached.type === "shape" ? attached.data.kind : undefined;
    const site = connectionSitesForKind(kind)[endpoint["siteIndex"] as number];
    return site ? siteWorldPos(attached, site) : undefined;
  };
  const connectors = framed.filter((element) => element["type"] === "connector").map((element) => {
    const start = endpointPoint(element["start"] as UnknownRecord);
    const end = endpointPoint(element["end"] as UnknownRecord);
    if (!start || !end) return "";
    const x1 = (start.x - minX) * scale + 30;
    const y1 = (start.y - minY) * scale + 30;
    const x2 = (end.x - minX) * scale + 30;
    const y2 = (end.y - minY) * scale + 30;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }).join("");
  const cards = framed.filter((element) => element["type"] !== "connector" && element["type"] !== "group").map((element) => {
    const frame = element["frame"] as UnknownRecord;
    const data = element["data"] as UnknownRecord;
    const left = ((frame["x"] as number) - minX) * scale + 30;
    const top = ((frame["y"] as number) - minY) * scale + 30;
    const width = Math.max(2, (frame["w"] as number) * scale);
    const height = Math.max(2, (frame["h"] as number) * scale);
    const rotation = frame["rotation"] as number;
    const kind = typeof data["kind"] === "string" ? data["kind"] : "Shape";
    const elementType = typeof element["type"] === "string" ? element["type"] : "Item";
    const body = elementType === "image"
      ? `<img alt="" src="${escapeHtml(data["src"] as string)}">`
      : escapeHtml(textFrom(data) || (elementType === "shape" ? kind : elementType)).replaceAll("\n", "<br>");
    return `<div class="board-item board-${escapeHtml(elementType)}" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px;transform:rotate(${rotation}rad)">${body}</div>`;
  }).join("");
  const empty = cards.length === 0 ? '<div class="board-empty">Empty board</div>' : "";
  const connectorLayer = connectors ? `<svg class="board-connectors" aria-hidden="true">${connectors}</svg>` : "";
  return `<main class="board-preview" aria-label="Static preview of ${escapeHtml(model.meta.title)}"><div class="board-canvas">${connectorLayer}${cards}${empty}</div></main>`;
}

export function serializeBoardHtml(model: BoardModel): string {
  const safe = validateBoardDocument(structuredClone(model));
  const manifest = { documentType: "board", editor: "wafflebase", payloadId: PAYLOAD_ID, payloadFormat: PAYLOAD_TYPE, version: "1.0" };
  const style = "html,body{margin:0;min-height:100%;background:#e9e7df;color:#25241f;font:14px system-ui,sans-serif}.board-preview{padding:24px}.board-canvas{position:relative;min-height:560px;overflow:hidden;border:1px solid #cbc7ba;border-radius:18px;background-color:#f8f7f2;background-image:radial-gradient(#d8d4c8 1px,transparent 1px);background-size:20px 20px;box-shadow:0 14px 40px #3a382a1c}.board-connectors{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.board-connectors line{stroke:#68645b;stroke-width:2}.board-item{position:absolute;box-sizing:border-box;overflow:hidden;padding:12px;border:1px solid #aaa58f;border-radius:8px;background:#fff;white-space:pre-wrap;box-shadow:0 4px 12px #38352820}.board-shape{display:grid;place-items:center;border-radius:18px;background:#dce8ff}.board-text{border-color:transparent;background:transparent;box-shadow:none}.board-image{padding:0}.board-image img{width:100%;height:100%;object-fit:contain}.board-empty{position:absolute;inset:0;display:grid;place-items:center;color:#777268;font-size:18px}";
  return [
    "<!doctype html>",
    `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(safe.meta.title)}</title><style>${style}</style></head><body>`,
    staticPreview(safe),
    `<script id="${MANIFEST_ID}" type="${MANIFEST_TYPE}">${safeScriptJson(manifest)}</script>`,
    `<script id="${PAYLOAD_ID}" type="${PAYLOAD_TYPE}">${safeScriptJson(safe)}</script>`,
    "</body></html>",
  ].join("\n");
}

export function createBoardDocument(title = "Untitled Board"): BoardModel {
  return validateBoardDocument({ meta: { title }, elements: [] });
}
