import { identityMatrix, multiplyMatrices, transformNode } from "./affine-transform";
import { boundsFromPoints, nodeVisualBounds, type GeometryMatrix } from "./geometry";
import type { DesignFragment } from "./organization";
import { createNode, type DesignNode, type DesignStroke } from "./scene-graph";
import type { TextMeasurer } from "./text-layout";
import {
  parsePathData,
  type VectorNetwork,
  type VectorPathCommand,
  type VectorSegment,
  type VectorVertex,
} from "./vector";

export type SvgImportErrorCode =
  | "invalid-xml"
  | "unsafe-document"
  | "unsafe-attribute"
  | "external-reference"
  | "unsupported-element"
  | "unsupported-attribute"
  | "unsupported-transform"
  | "unsupported-path"
  | "unsupported-paint"
  | "text-measurement-unavailable"
  | "invalid-geometry";

export type SvgImportResult =
  | { ok: true; fragment: DesignFragment }
  | { ok: false; error: { code: SvgImportErrorCode; message: string; element?: string } };

export type SvgDomParser = { parseFromString(source: string, mimeType: "image/svg+xml"): Document };
export type SvgImportOptions = { parser?: SvgDomParser; textMeasurer?: TextMeasurer };

type Presentation = { fill: string | null; stroke: DesignStroke | undefined };

class SvgImportFailure extends Error {
  constructor(readonly code: SvgImportErrorCode, message: string, readonly element?: string) {
    super(message);
  }
}

const CONTAINER_ATTRIBUTES = new Set(["id", "transform", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "opacity", "fill-opacity", "stroke-opacity", "fill-rule"]);
const ROOT_ATTRIBUTES = new Set([...CONTAINER_ATTRIBUTES, "xmlns", "version", "viewBox", "width", "height", "preserveAspectRatio"]);
const SHAPE_ATTRIBUTES = new Set(CONTAINER_ATTRIBUTES);
const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  svg: ROOT_ATTRIBUTES,
  g: CONTAINER_ATTRIBUTES,
  rect: new Set([...SHAPE_ATTRIBUTES, "x", "y", "width", "height", "rx", "ry"]),
  circle: new Set([...SHAPE_ATTRIBUTES, "cx", "cy", "r"]),
  ellipse: new Set([...SHAPE_ATTRIBUTES, "cx", "cy", "rx", "ry"]),
  line: new Set([...SHAPE_ATTRIBUTES, "x1", "y1", "x2", "y2"]),
  polyline: new Set([...SHAPE_ATTRIBUTES, "points"]),
  polygon: new Set([...SHAPE_ATTRIBUTES, "points"]),
  path: new Set([...SHAPE_ATTRIBUTES, "d"]),
  text: new Set([...SHAPE_ATTRIBUTES, "x", "y", "font-size", "font-family", "font-weight", "text-anchor"]),
};

const FORBIDDEN_ELEMENTS = new Set(["script", "foreignobject", "use", "image", "style", "a", "iframe", "object", "embed"]);
const URL_VALUE = /url\s*\(/i;
const SAFE_COLOR = /^(?:none|transparent|#[0-9a-f]{3,8}|[a-z]+|rgba?\(\s*[-+\d.%]+(?:\s*[, ]\s*[-+\d.%]+){2,3}\s*\))$/i;

function fail(code: SvgImportErrorCode, message: string, element?: Element): never {
  throw new SvgImportFailure(code, message, element?.localName ?? undefined);
}

function numberValue(element: Element, name: string, fallback?: number): number {
  const raw = element.getAttribute(name);
  if (raw === null) {
    if (fallback !== undefined) return fallback;
    return fail("invalid-geometry", `<${element.localName}> requires ${name}.`, element);
  }
  if (!/^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?$/.test(raw.trim())) {
    return fail("invalid-geometry", `${name} on <${element.localName}> must be a unitless finite number.`, element);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return fail("invalid-geometry", `${name} on <${element.localName}> must be finite.`, element);
  return value;
}

function opacityValue(element: Element): number | undefined {
  if (!element.hasAttribute("opacity")) return undefined;
  const opacity = numberValue(element, "opacity");
  if (opacity < 0 || opacity > 1) fail("unsupported-paint", `opacity on <${element.localName}> must be between 0 and 1.`, element);
  return opacity;
}

const SVG_NUMBER = "[+-]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][+-]?\\d+)?";

function numberList(raw: string): number[] | null {
  if (!new RegExp(`^\\s*${SVG_NUMBER}(?:\\s*(?:,\\s*|\\s+)${SVG_NUMBER})*\\s*$`).test(raw)) return null;
  return raw.match(new RegExp(SVG_NUMBER, "g"))?.map(Number) ?? null;
}

function rootViewportMatrix(root: Element): GeometryMatrix {
  const viewBoxRaw = root.getAttribute("viewBox");
  const hasWidth = root.hasAttribute("width");
  const hasHeight = root.hasAttribute("height");
  if (hasWidth !== hasHeight) {
    fail("invalid-geometry", "Root SVG width and height must be supplied together to establish an exact viewport.", root);
  }
  const viewportWidth = hasWidth ? numberValue(root, "width") : undefined;
  const viewportHeight = hasHeight ? numberValue(root, "height") : undefined;
  if ((viewportWidth !== undefined && viewportWidth <= 0) || (viewportHeight !== undefined && viewportHeight <= 0)) {
    fail("invalid-geometry", "Root SVG width and height must be positive.", root);
  }
  if (viewBoxRaw === null) return identityMatrix;
  const viewBox = numberList(viewBoxRaw);
  if (!viewBox || viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
    fail("invalid-geometry", "Root SVG viewBox must contain four finite numbers.", root);
  }
  const [minX, minY, viewWidth, viewHeight] = viewBox;
  if (viewWidth! <= 0 || viewHeight! <= 0) fail("invalid-geometry", "Root SVG viewBox dimensions must be positive.", root);
  const rawAspectRatio = root.getAttribute("preserveAspectRatio")?.trim() || "xMidYMid meet";
  const tokens = rawAspectRatio.split(/\s+/);
  const align = tokens[0]!;
  const mode = tokens[1] ?? "meet";
  if (align === "none") {
    if (tokens.length !== 1) fail("unsupported-transform", `Unsupported preserveAspectRatio ${rawAspectRatio}.`, root);
  } else if (!/^(?:xMin|xMid|xMax)(?:YMin|YMid|YMax)$/.test(align)
    || tokens.length > 2
    || (mode !== "meet" && mode !== "slice")) {
    fail("unsupported-transform", `Unsupported preserveAspectRatio ${rawAspectRatio}.`, root);
  }
  if (mode === "slice") {
    fail("unsupported-transform", "preserveAspectRatio slice requires viewport clipping, which Design cannot represent exactly.", root);
  }
  // Without an explicit viewport there is no outer embedding context. Keeping
  // viewBox user units is the only lossless canonical import.
  if (viewportWidth === undefined || viewportHeight === undefined) return identityMatrix;

  if (align === "none") {
    const scaleX = viewportWidth / viewWidth!;
    const scaleY = viewportHeight / viewHeight!;
    return { a: scaleX, b: 0, c: 0, d: scaleY, e: -minX! * scaleX, f: -minY! * scaleY };
  }
  const scale = Math.min(viewportWidth / viewWidth!, viewportHeight / viewHeight!);
  const remainingX = viewportWidth - viewWidth! * scale;
  const remainingY = viewportHeight - viewHeight! * scale;
  const alignX = align.startsWith("xMin") ? 0 : align.startsWith("xMid") ? 0.5 : 1;
  const alignY = align.endsWith("YMin") ? 0 : align.endsWith("YMid") ? 0.5 : 1;
  return {
    a: scale, b: 0, c: 0, d: scale,
    e: remainingX * alignX - minX! * scale,
    f: remainingY * alignY - minY! * scale,
  };
}

function matrixForTransform(raw: string | null, element: Element): GeometryMatrix {
  if (!raw?.trim()) return identityMatrix;
  const pattern = /\s*([A-Za-z]+)\s*\(([^)]*)\)\s*,?/gy;
  let offset = 0;
  let matrix = identityMatrix;
  while (offset < raw.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(raw);
    if (!match) {
      if (raw.slice(offset).trim().length === 0) break;
      fail("unsupported-transform", `Cannot parse transform on <${element.localName}>.`, element);
    }
    const args = match[2]!.trim().length === 0 ? [] : numberList(match[2]!);
    if (!args || args.some((value) => !Number.isFinite(value))) fail("unsupported-transform", `Transform arguments on <${element.localName}> must be finite numbers.`, element);
    const name = match[1]!.toLowerCase();
    let next: GeometryMatrix;
    if (name === "matrix" && args.length === 6) {
      next = { a: args[0]!, b: args[1]!, c: args[2]!, d: args[3]!, e: args[4]!, f: args[5]! };
    } else if (name === "translate" && (args.length === 1 || args.length === 2)) {
      next = { ...identityMatrix, e: args[0]!, f: args[1] ?? 0 };
    } else if (name === "scale" && (args.length === 1 || args.length === 2)) {
      next = { ...identityMatrix, a: args[0]!, d: args[1] ?? args[0]! };
    } else if (name === "rotate" && (args.length === 1 || args.length === 3)) {
      const angle = args[0]! * Math.PI / 180;
      const rotation = { ...identityMatrix, a: Math.cos(angle), b: Math.sin(angle), c: -Math.sin(angle), d: Math.cos(angle) };
      if (args.length === 1) next = rotation;
      else {
        const [cx, cy] = args.slice(1);
        next = multiplyMatrices(
          { ...identityMatrix, e: cx!, f: cy! },
          multiplyMatrices(rotation, { ...identityMatrix, e: -cx!, f: -cy! }),
        );
      }
    } else if ((name === "skewx" || name === "skewy") && args.length === 1) {
      const tangent = Math.tan(args[0]! * Math.PI / 180);
      next = name === "skewx" ? { ...identityMatrix, c: tangent } : { ...identityMatrix, b: tangent };
    } else {
      fail("unsupported-transform", `Unsupported ${match[1]} transform on <${element.localName}>.`, element);
    }
    matrix = multiplyMatrices(matrix, next!);
    offset = pattern.lastIndex;
  }
  return matrix;
}

function validateElement(element: Element): string {
  const tag = element.localName.toLowerCase();
  if (tag === "image") {
    fail("external-reference", "Importing embedded or linked images is not supported yet.", element);
  }
  if (FORBIDDEN_ELEMENTS.has(tag)) fail("unsafe-document", `<${element.localName}> is not allowed in imported SVG.`, element);
  const allowed = ELEMENT_ATTRIBUTES[tag];
  if (!allowed) fail("unsupported-element", `<${element.localName}> is not supported by the Design importer.`, element);
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name;
    if (/^on/i.test(name) || name === "style") fail("unsafe-attribute", `${name} is not allowed on imported SVG.`, element);
    if (name === "href" || name.endsWith(":href") || URL_VALUE.test(attribute.value)) {
      fail("external-reference", `${name} on <${element.localName}> may not reference external content.`, element);
    }
    if (!allowed.has(name)) fail("unsupported-attribute", `${name} is not supported on <${element.localName}>.`, element);
  }
  if (element.hasAttribute("fill-rule") && element.getAttribute("fill-rule") !== "nonzero") {
    fail("unsupported-paint", `Only nonzero fill-rule can be imported exactly.`, element);
  }
  for (const alpha of ["fill-opacity", "stroke-opacity"] as const) {
    if (element.hasAttribute(alpha) && numberValue(element, alpha) !== 1) {
      fail("unsupported-paint", `${alpha} cannot be represented exactly.`, element);
    }
  }
  return tag;
}

function colorValue(element: Element, name: "fill" | "stroke", fallback: string | null): string | null {
  const raw = element.getAttribute(name);
  if (raw === null) return fallback;
  const value = raw.trim();
  if (!SAFE_COLOR.test(value)) fail("unsupported-paint", `${name} on <${element.localName}> is not a supported solid color.`, element);
  return value.toLowerCase() === "none" ? null : value;
}

function presentationFor(element: Element, inherited: Presentation): Presentation {
  const fill = colorValue(element, "fill", inherited.fill);
  const strokeColor = colorValue(element, "stroke", inherited.stroke?.color ?? null);
  let stroke: DesignStroke | undefined;
  if (strokeColor) {
    const width = numberValue(element, "stroke-width", inherited.stroke?.width ?? 1);
    if (width < 0) fail("invalid-geometry", `stroke-width cannot be negative.`, element);
    const cap = element.getAttribute("stroke-linecap") ?? inherited.stroke?.cap;
    const join = element.getAttribute("stroke-linejoin") ?? inherited.stroke?.join;
    if (cap && !["butt", "round", "square"].includes(cap)) fail("unsupported-paint", `Unsupported stroke-linecap ${cap}.`, element);
    if (join && !["miter", "round", "bevel"].includes(join)) fail("unsupported-paint", `Unsupported stroke-linejoin ${join}.`, element);
    const dashRaw = element.getAttribute("stroke-dasharray");
    const dash = dashRaw === null
      ? inherited.stroke?.dash
      : dashRaw.trim().toLowerCase() === "none"
        ? undefined
        : numberList(dashRaw);
    if (dash === null || dash?.some((value) => !Number.isFinite(value) || value < 0)) fail("unsupported-paint", `Invalid stroke-dasharray.`, element);
    stroke = { color: strokeColor, width };
    if (cap) stroke.cap = cap as NonNullable<DesignStroke["cap"]>;
    if (join) stroke.join = join as NonNullable<DesignStroke["join"]>;
    if (dash) stroke.dash = dash;
  }
  return { fill, stroke };
}

function commandsToNetwork(commands: VectorPathCommand[], prefix: string): VectorNetwork {
  const vertices: VectorVertex[] = [];
  const segments: VectorSegment[] = [];
  const regions: VectorNetwork["regions"] = [];
  let current: VectorVertex | null = null;
  let start: VectorVertex | null = null;
  let subpathVertexIds: string[] = [];
  let subpathSegmentCount = 0;
  let subpathIndex = -1;
  let subpathClosed = false;

  const newVertex = (x: number, y: number): VectorVertex => {
    const vertex = { id: `${prefix}-v${vertices.length}`, x, y };
    vertices.push(vertex);
    return vertex;
  };
  const discardIsolatedMove = (): void => {
    if (start && subpathSegmentCount === 0) vertices.splice(vertices.indexOf(start), 1);
  };

  for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
    const command = commands[commandIndex]!;
    if (command.kind === "M") {
      discardIsolatedMove();
      subpathIndex++;
      current = newVertex(command.x, command.y);
      start = current;
      subpathVertexIds = [current.id];
      subpathSegmentCount = 0;
      subpathClosed = false;
      continue;
    }
    if (!current || !start) fail("unsupported-path", "Every SVG path subpath must begin with M.");
    if (command.kind === "Z") {
      if (subpathSegmentCount > 0 && !subpathClosed) {
        if (current !== start) {
          segments.push({ id: `${prefix}-s${segments.length}`, startVertexId: current.id, endVertexId: start.id });
        }
        regions.push({ id: `${prefix}-r${subpathIndex}`, vertexIds: [...subpathVertexIds] });
      }
      current = start;
      subpathClosed = true;
      continue;
    }
    const closesToStart = commands[commandIndex + 1]?.kind === "Z"
      && subpathSegmentCount > 0
      && command.x === start.x
      && command.y === start.y;
    const end = closesToStart ? start : newVertex(command.x, command.y);
    const segment: VectorSegment = {
      id: `${prefix}-s${segments.length}`,
      startVertexId: current.id,
      endVertexId: end.id,
    };
    if (command.kind === "C") {
      segment.startHandle = { x: command.c1x, y: command.c1y };
      segment.endHandle = { x: command.c2x, y: command.c2y };
    }
    segments.push(segment);
    subpathSegmentCount++;
    if (!closesToStart) subpathVertexIds.push(end.id);
    current = end;
  }
  discardIsolatedMove();
  if (segments.length === 0) fail("invalid-geometry", "Imported vector has no drawable segments.");
  return { vertices, segments, regions };
}

function translatedNetwork(network: VectorNetwork, dx: number, dy: number): VectorNetwork {
  const point = <T extends { x: number; y: number }>(value: T): T => ({ ...value, x: value.x + dx, y: value.y + dy });
  return {
    vertices: network.vertices.map(point),
    segments: network.segments.map((segment) => ({
      ...segment,
      ...(segment.startHandle ? { startHandle: point(segment.startHandle) } : {}),
      ...(segment.endHandle ? { endHandle: point(segment.endHandle) } : {}),
    })),
    regions: network.regions.map((region) => ({ ...region, vertexIds: [...region.vertexIds] })),
  };
}

function vectorNode(id: string, parentId: string | null, name: string, commands: VectorPathCommand[], presentation: Presentation): DesignNode {
  const network = commandsToNetwork(commands, id);
  const points = [
    ...network.vertices,
    ...network.segments.flatMap((segment) => [segment.startHandle, segment.endHandle].filter((point): point is { x: number; y: number } => point !== undefined)),
  ];
  const bounds = boundsFromPoints(points);
  if (!bounds) fail("invalid-geometry", `${name} has no drawable geometry.`);
  return createNode({
    id, type: "vector", parentId, name,
    x: bounds.minX, y: bounds.minY,
    width: Math.max(1, bounds.maxX - bounds.minX), height: Math.max(1, bounds.maxY - bounds.minY),
    vectorNetwork: translatedNetwork(network, -bounds.minX, -bounds.minY),
    fills: presentation.fill ? [{ kind: "solid", color: presentation.fill }] : [],
    ...(presentation.stroke ? { stroke: presentation.stroke } : { strokeDisabled: true }),
  });
}

function pointsCommands(element: Element, close: boolean): VectorPathCommand[] {
  const raw = element.getAttribute("points")?.trim() ?? "";
  if (!raw) fail("invalid-geometry", `<${element.localName}> requires points.`, element);
  const tokens = numberList(raw);
  if (!tokens || tokens.length < (close ? 6 : 4) || tokens.length % 2 !== 0 || tokens.some((value) => !Number.isFinite(value))) {
    fail("invalid-geometry", `points on <${element.localName}> must contain finite coordinate pairs.`, element);
  }
  const commands: VectorPathCommand[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    commands.push({ kind: index === 0 ? "M" : "L", x: tokens[index]!, y: tokens[index + 1]! });
  }
  if (close) commands.push({ kind: "Z" });
  return commands;
}

function ellipseCommands(cx: number, cy: number, rx: number, ry: number): VectorPathCommand[] {
  const k = 0.5522847498307936;
  return [
    { kind: "M", x: cx + rx, y: cy },
    { kind: "C", c1x: cx + rx, c1y: cy + k * ry, c2x: cx + k * rx, c2y: cy + ry, x: cx, y: cy + ry },
    { kind: "C", c1x: cx - k * rx, c1y: cy + ry, c2x: cx - rx, c2y: cy + k * ry, x: cx - rx, y: cy },
    { kind: "C", c1x: cx - rx, c1y: cy - k * ry, c2x: cx - k * rx, c2y: cy - ry, x: cx, y: cy - ry },
    { kind: "C", c1x: cx + k * rx, c1y: cy - ry, c2x: cx + rx, c2y: cy - k * ry, x: cx + rx, y: cy },
    { kind: "Z" },
  ];
}

function transformedNode(node: DesignNode, matrix: GeometryMatrix, element: Element): DesignNode {
  try {
    return transformNode(node, matrix);
  } catch (cause) {
    fail("invalid-geometry", cause instanceof Error ? cause.message : "SVG transform is not representable.", element);
  }
}

function transformedStroke(stroke: DesignStroke | undefined, matrix: GeometryMatrix, element: Element): DesignStroke | undefined {
  if (!stroke || stroke.width === 0) return stroke;
  const scaleX = Math.hypot(matrix.a, matrix.b);
  const scaleY = Math.hypot(matrix.c, matrix.d);
  const dot = matrix.a * matrix.c + matrix.b * matrix.d;
  const tolerance = 1e-9 * Math.max(1, scaleX, scaleY) ** 2;
  if (Math.abs(scaleX - scaleY) > tolerance || Math.abs(dot) > tolerance) {
    fail("unsupported-paint", `A nonuniform or skewed transform on stroked <${element.localName}> cannot be represented exactly.`, element);
  }
  return {
    ...stroke,
    width: stroke.width * scaleX,
    ...(stroke.dash ? { dash: stroke.dash.map((value) => value * scaleX) } : {}),
  };
}

/** Parse a safe SVG subset into an atomic clipboard-style fragment. */
export function importSvgFragment(source: string, options: SvgImportOptions = {}): SvgImportResult {
  try {
    if (/<!DOCTYPE/i.test(source)) fail("unsafe-document", "SVG doctypes are not allowed.");
    const parser = options.parser ?? (typeof DOMParser === "undefined" ? undefined : new DOMParser());
    if (!parser) fail("invalid-xml", "SVG import requires a DOMParser supplied by the browser or caller.");
    const xml = parser.parseFromString(source, "image/svg+xml");
    if (xml.querySelector("parsererror")) fail("invalid-xml", "SVG is not well-formed XML.");
    const root = xml.documentElement;
    if (!root || root.localName.toLowerCase() !== "svg") fail("invalid-xml", "The document root must be <svg>.");
    let sequence = 0;
    const nodes: DesignNode[] = [];
    const nextId = () => `svg-import-${++sequence}`;

    const visit = (element: Element, parentId: string | null, parentMatrix: GeometryMatrix, inherited: Presentation): string => {
      const tag = validateElement(element);
      const id = nextId();
      const name = element.getAttribute("id")?.trim() || `Imported ${tag}`;
      const attributeMatrix = matrixForTransform(element.getAttribute("transform"), element);
      const localMatrix = tag === "svg"
        ? multiplyMatrices(attributeMatrix, rootViewportMatrix(element))
        : attributeMatrix;
      const matrix = multiplyMatrices(parentMatrix, localMatrix);
      const presentation = presentationFor(element, inherited);
      if (tag === "svg" || tag === "g") {
        if (tag === "svg" && element !== root) fail("unsupported-element", "Nested <svg> elements are not supported.", element);
        const opacity = opacityValue(element);
        const group = createNode({ id, type: "group", parentId, name, width: 0, height: 0, ...(opacity !== undefined ? { opacity } : {}) });
        nodes.push(group);
        for (const child of Array.from(element.children)) group.childIds.push(visit(child, id, matrix, presentation));
        const children = group.childIds.map((childId) => nodes.find((node) => node.id === childId)!).filter(Boolean);
        if (children.length > 0) {
          const boxes = children.map(nodeVisualBounds);
          group.x = Math.min(...boxes.map((box) => box.minX));
          group.y = Math.min(...boxes.map((box) => box.minY));
          group.width = Math.max(...boxes.map((box) => box.maxX)) - group.x;
          group.height = Math.max(...boxes.map((box) => box.maxY)) - group.y;
        }
        return id;
      }
      if (element.children.length > 0) fail("unsupported-element", `<${element.localName}> may not contain child elements.`, element);
      let node: DesignNode;
      if (tag === "rect") {
        const x = numberValue(element, "x", 0);
        const y = numberValue(element, "y", 0);
        const width = numberValue(element, "width");
        const height = numberValue(element, "height");
        if (width < 0 || height < 0) fail("invalid-geometry", "Rectangle dimensions cannot be negative.", element);
        const rx = numberValue(element, "rx", 0);
        const ry = numberValue(element, "ry", rx);
        const opacity = opacityValue(element);
        const rectangle = createNode({ id, type: "rectangle", parentId, name, x, y, width, height, radius: rx, radiusY: ry,
          fills: presentation.fill ? [{ kind: "solid", color: presentation.fill }] : [],
          ...(presentation.stroke ? { stroke: presentation.stroke } : { strokeDisabled: true }),
          ...(opacity !== undefined ? { opacity } : {}),
        });
        node = transformedNode(rectangle, matrix, element);
        const stroke = transformedStroke(presentation.stroke, matrix, element);
        if (stroke) node.stroke = stroke;
      } else if (tag === "text") {
        if (!options.textMeasurer) fail("text-measurement-unavailable", "Text import requires an exact font measurer.", element);
        if (presentation.stroke) fail("unsupported-paint", "Stroked SVG text cannot be represented exactly.", element);
        const text = element.textContent ?? "";
        const fontSize = numberValue(element, "font-size", 16);
        const fontFamily = element.getAttribute("font-family") ?? "system-ui, sans-serif";
        const fontWeight = element.getAttribute("font-weight") ?? "normal";
        const anchor = element.getAttribute("text-anchor") ?? "start";
        if (!["start", "middle", "end"].includes(anchor)) fail("unsupported-attribute", `Unsupported text-anchor ${anchor}.`, element);
        const width = options.textMeasurer(text, { fontSize, fontFamily, fontWeight });
        if (!Number.isFinite(width) || width < 0) fail("text-measurement-unavailable", "The text measurer returned an invalid width.", element);
        const baselineX = numberValue(element, "x", 0);
        const x = baselineX - (anchor === "middle" ? width / 2 : anchor === "end" ? width : 0);
        const y = numberValue(element, "y", 0) - fontSize;
        const opacity = opacityValue(element);
        node = transformedNode(createNode({ id, type: "text", parentId, name, x, y, width: Math.max(1, width), height: fontSize * 1.25,
          text, fontSize, fontFamily, fontWeight, textAlign: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
          color: presentation.fill ?? "transparent", ...(opacity !== undefined ? { opacity } : {}),
        }), matrix, element);
      } else {
        let commands: VectorPathCommand[];
        if (tag === "circle" || tag === "ellipse") {
          const cx = numberValue(element, "cx", 0);
          const cy = numberValue(element, "cy", 0);
          const rx = tag === "circle" ? numberValue(element, "r") : numberValue(element, "rx");
          const ry = tag === "circle" ? rx : numberValue(element, "ry");
          if (rx < 0 || ry < 0) fail("invalid-geometry", "Ellipse radii cannot be negative.", element);
          commands = ellipseCommands(cx, cy, rx, ry);
        } else if (tag === "line") {
          commands = [{ kind: "M", x: numberValue(element, "x1", 0), y: numberValue(element, "y1", 0) }, { kind: "L", x: numberValue(element, "x2", 0), y: numberValue(element, "y2", 0) }];
        } else if (tag === "polyline" || tag === "polygon") {
          commands = pointsCommands(element, tag === "polygon");
        } else {
          const parsed = parsePathData(element.getAttribute("d") ?? "");
          if (!parsed) fail("unsupported-path", "Path data must use only M, L, H, V, C, and Z commands.", element);
          commands = parsed;
        }
        node = transformedNode(vectorNode(id, parentId, name, commands, presentation), matrix, element);
        const stroke = transformedStroke(presentation.stroke, matrix, element);
        if (stroke) node.stroke = stroke;
        const opacity = opacityValue(element);
        if (opacity !== undefined) node.opacity = opacity;
      }
      nodes.push(node);
      return id;
    };

    const rootId = visit(root, null, identityMatrix, { fill: "#000000", stroke: undefined });
    return { ok: true, fragment: { roots: [rootId], nodes } };
  } catch (cause) {
    if (cause instanceof SvgImportFailure) return { ok: false, error: { code: cause.code, message: cause.message, ...(cause.element ? { element: cause.element } : {}) } };
    return { ok: false, error: { code: "invalid-xml", message: cause instanceof Error ? cause.message : "SVG import failed." } };
  }
}
