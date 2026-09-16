/** Pure, renderer-neutral SVG geometry for Design boolean nodes. */

import type { DesignBooleanOp, DesignDocument, DesignNode } from "./scene-graph";
import {
  commandsFromVectorNetwork,
  parsePathData,
  pathDataFromCommands,
  translateCommands,
  type VectorPathCommand,
} from "./vector";
import { nodeTransformMatrix, nodeVisualBounds, transformPoint, type GeometryBounds } from "./geometry";

export function sanitizeId(id: string): string {
  return Array.from(id, (character) =>
    /[A-Za-z0-9-]/.test(character)
      ? character
      : `_u${character.codePointAt(0)!.toString(16)}_`,
  ).join("");
}

const CIRCLE_KAPPA = 0.5522847498307936;

function rectPathData(dx: number, dy: number, w: number, h: number): string {
  return pathDataFromCommands([
    { kind: "M", x: dx, y: dy },
    { kind: "L", x: dx + w, y: dy },
    { kind: "L", x: dx + w, y: dy + h },
    { kind: "L", x: dx, y: dy + h },
    { kind: "Z" },
  ]);
}

export function roundedRectPathData(dx: number, dy: number, w: number, h: number, r: number, radiusY = r): string {
  const rx = Math.min(r, w / 2);
  const ry = Math.min(radiusY, h / 2);
  if (!(rx > 0) || !(ry > 0)) return rectPathData(dx, dy, w, h);
  const kx = rx * CIRCLE_KAPPA;
  const ky = ry * CIRCLE_KAPPA;
  const x0 = dx;
  const y0 = dy;
  const x1 = dx + w;
  const y1 = dy + h;
  return pathDataFromCommands([
    { kind: "M", x: x0 + rx, y: y0 },
    { kind: "L", x: x1 - rx, y: y0 },
    { kind: "C", c1x: x1 - rx + kx, c1y: y0, c2x: x1, c2y: y0 + ry - ky, x: x1, y: y0 + ry },
    { kind: "L", x: x1, y: y1 - ry },
    { kind: "C", c1x: x1, c1y: y1 - ry + ky, c2x: x1 - rx + kx, c2y: y1, x: x1 - rx, y: y1 },
    { kind: "L", x: x0 + rx, y: y1 },
    { kind: "C", c1x: x0 + rx - kx, c1y: y1, c2x: x0, c2y: y1 - ry + ky, x: x0, y: y1 - ry },
    { kind: "L", x: x0, y: y0 + ry },
    { kind: "C", c1x: x0, c1y: y0 + ry - ky, c2x: x0 + rx - kx, c2y: y0, x: x0 + rx, y: y0 },
    { kind: "Z" },
  ]);
}

function transformCommands(commands: VectorPathCommand[], node: DesignNode, x: number, y: number): VectorPathCommand[] {
  const matrix = nodeTransformMatrix({ ...node, x, y });
  const point = (px: number, py: number) => transformPoint({ x: px, y: py }, matrix);
  return commands.map((command) => {
    if (command.kind === "Z") return command;
    if (command.kind === "C") {
      const c1 = point(command.c1x, command.c1y);
      const c2 = point(command.c2x, command.c2y);
      const end = point(command.x, command.y);
      return { kind: "C", c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y, x: end.x, y: end.y };
    }
    const next = point(command.x, command.y);
    return { kind: command.kind, x: next.x, y: next.y };
  });
}

/** Resolve one primitive exactly. Unsupported geometry returns null, never a box substitute. */
export function operandPathData(
  node: DesignNode,
  dx: number,
  dy: number,
  _resolveChild?: (childId: string) => DesignNode | null,
  _depth?: number,
): string | null {
  let commands: VectorPathCommand[] | null = null;
  if (node.type === "vector") {
    commands = node.vectorNetwork
      ? commandsFromVectorNetwork(node.vectorNetwork)
      : node.vectorPath
        ? parsePathData(node.vectorPath)
        : null;
  } else if (node.type === "rectangle" || node.type === "frame") {
    commands = parsePathData(roundedRectPathData(0, 0, node.width, node.height, node.radius ?? 0, node.radiusY));
  }
  if (!commands || commands.length === 0) return null;
  const translated = translateCommands(commands, dx, dy);
  return pathDataFromCommands(transformCommands(translated, node, dx, dy));
}

// Legacy flat descriptor retained for callers that already resolve primitive paths.
export type BooleanMaskDef = { kind: "mask"; id: string; source: string; knockouts: string[] };
export type BooleanClipDef = { kind: "clip"; id: string; pathData: string };
export type BooleanDef = BooleanMaskDef | BooleanClipDef;
export type BooleanComposition = {
  op: DesignBooleanOp;
  defs: BooleanDef[];
  mainPathData: string;
  fillRule: "nonzero" | "evenodd" | null;
  maskId: string | null;
  clipIds: string[];
};

export function buildBooleanComposition(
  node: DesignNode,
  resolveOperandPathData: (childId: string) => string | null,
): BooleanComposition | null {
  const op = node.booleanOp;
  if (op === undefined) return null;
  const ops = node.childIds.map(resolveOperandPathData).filter((d): d is string => Boolean(d));
  if (ops.length === 0) return null;
  const first = ops[0]!;
  if (ops.length === 1) return { op, defs: [], mainPathData: first, fillRule: null, maskId: null, clipIds: [] };
  const base = sanitizeId(node.id);
  if (op === "union" || op === "exclude") {
    return { op, defs: [], mainPathData: ops.join(" "), fillRule: op === "union" ? "nonzero" : "evenodd", maskId: null, clipIds: [] };
  }
  if (op === "subtract") {
    const maskId = `mask-${base}`;
    return { op, defs: [{ kind: "mask", id: maskId, source: first, knockouts: ops.slice(1) }], mainPathData: first, fillRule: null, maskId, clipIds: [] };
  }
  const clips: BooleanClipDef[] = ops.slice(1).map((pathData, index) => ({ kind: "clip", id: `clip-${base}-${index}`, pathData }));
  return { op, defs: clips, mainPathData: first, fillRule: null, maskId: null, clipIds: clips.map((clip) => clip.id) };
}

export type BooleanSvgNode =
  | { kind: "path"; pathData: string }
  | { kind: "use"; id: string }
  | { kind: "group"; children: BooleanSvgNode[]; maskId?: string; fill?: string };
export type ExactBooleanDef =
  | { kind: "mask"; id: string; bounds: GeometryBounds; content: BooleanSvgNode }
  | { kind: "shape"; id: string; content: BooleanSvgNode };
export type ExactBooleanComposition = { body: BooleanSvgNode; defs: ExactBooleanDef[]; bounds: GeometryBounds };
export type BooleanCompositionResult =
  | { ok: true; composition: ExactBooleanComposition }
  | { ok: false; reason: string };

function unionBounds(bounds: readonly GeometryBounds[]): GeometryBounds {
  return {
    minX: Math.min(...bounds.map((item) => item.minX)),
    minY: Math.min(...bounds.map((item) => item.minY)),
    maxX: Math.max(...bounds.map((item) => item.maxX)),
    maxY: Math.max(...bounds.map((item) => item.maxY)),
  };
}

function painted(body: BooleanSvgNode, fill: "#fff" | "#000"): BooleanSvgNode {
  return { kind: "group", fill, children: [body] };
}

export function booleanOperandUnsupportedReason(node: DesignNode): string | null {
  if (node.booleanOp !== undefined) return null;
  if (node.type === "rectangle" || node.type === "frame") return null;
  if (node.type === "vector") {
    if (node.vectorNetwork && commandsFromVectorNetwork(node.vectorNetwork).length > 0) return null;
    if (node.vectorPath && parsePathData(node.vectorPath)?.length) return null;
    return `Boolean operand "${node.name}" has no valid vector path.`;
  }
  return `Boolean operand "${node.name}" has unsupported ${node.type} geometry.`;
}

/** Build exact nested SVG composition in absolute document coordinates, without a depth cap. */
export function buildExactBooleanComposition(doc: DesignDocument, node: DesignNode): BooleanCompositionResult {
  const visiting = new Set<string>();
  const resolve = (current: DesignNode): BooleanCompositionResult => {
    if (visiting.has(current.id)) return { ok: false, reason: `Boolean operand cycle at "${current.name}".` };
    if (current.booleanOp === undefined) {
      const unsupported = booleanOperandUnsupportedReason(current);
      if (unsupported) return { ok: false, reason: unsupported };
      const pathData = operandPathData(current, current.x, current.y);
      if (!pathData) return { ok: false, reason: `Boolean operand "${current.name}" has empty geometry.` };
      const shapeId = `boolean-shape-${sanitizeId(current.id)}`;
      return {
        ok: true,
        composition: {
          body: { kind: "use", id: shapeId },
          defs: [{ kind: "shape", id: shapeId, content: { kind: "path", pathData } }],
          bounds: nodeVisualBounds(current),
        },
      };
    }

    visiting.add(current.id);
    const operands: ExactBooleanComposition[] = [];
    for (const childId of current.childIds) {
      const child = doc.nodes[childId];
      if (!child) {
        visiting.delete(current.id);
        return { ok: false, reason: `Boolean node "${current.name}" is missing operand ${childId}.` };
      }
      if (child.hidden) continue;
      const result = resolve(child);
      if (!result.ok) {
        visiting.delete(current.id);
        return result;
      }
      operands.push(result.composition);
    }
    visiting.delete(current.id);
    // Removing or hiding the final operand is a valid empty result. Keep the
    // container editable without manufacturing replacement geometry.
    if (operands.length === 0) return {
      ok: true,
      composition: {
        body: { kind: "group", children: [] },
        defs: [],
        bounds: { minX: current.x, minY: current.y, maxX: current.x, maxY: current.y },
      },
    };

    const defs = operands.flatMap((operand) => operand.defs);
    const bounds = unionBounds(operands.map((operand) => operand.bounds));
    const idBase = `boolean-${sanitizeId(current.id)}`;
    const finish = (body: BooleanSvgNode): BooleanCompositionResult => {
      const shapeId = `${idBase}-shape`;
      defs.push({ kind: "shape", id: shapeId, content: body });
      return { ok: true, composition: { body: { kind: "use", id: shapeId }, defs, bounds } };
    };
    if (operands.length === 1) return finish(operands[0]!.body);
    if (current.booleanOp === "union") {
      return finish({ kind: "group", children: operands.map((operand) => operand.body) });
    }
    if (current.booleanOp === "subtract") {
      const maskId = `${idBase}-subtract`;
      defs.push({ kind: "mask", id: maskId, bounds, content: { kind: "group", children: [painted(operands[0]!.body, "#fff"), ...operands.slice(1).map((operand) => painted(operand.body, "#000"))] } });
      return finish({ kind: "group", maskId, children: [operands[0]!.body] });
    }
    if (current.booleanOp === "intersect") {
      let body = operands[0]!.body;
      operands.slice(1).forEach((operand, index) => {
        const maskId = `${idBase}-intersect-${index}`;
        defs.push({ kind: "mask", id: maskId, bounds, content: painted(operand.body, "#fff") });
        body = { kind: "group", maskId, children: [body] };
      });
      return finish(body);
    }

    let body = operands[0]!.body;
    for (let index = 1; index < operands.length; index += 1) {
      const next = operands[index]!.body;
      const leftMask = `${idBase}-exclude-${index}-left`;
      const rightMask = `${idBase}-exclude-${index}-right`;
      defs.push({ kind: "mask", id: leftMask, bounds, content: { kind: "group", children: [painted(body, "#fff"), painted(next, "#000")] } });
      defs.push({ kind: "mask", id: rightMask, bounds, content: { kind: "group", children: [painted(next, "#fff"), painted(body, "#000")] } });
      body = { kind: "group", children: [{ kind: "group", maskId: leftMask, children: [body] }, { kind: "group", maskId: rightMask, children: [next] }] };
    }
    return finish(body);
  };
  if (node.booleanOp === undefined) return { ok: false, reason: `Node "${node.name}" is not a boolean node.` };
  return resolve(node);
}
