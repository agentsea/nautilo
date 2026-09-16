import type { DesignNode } from "./scene-graph";
import type { VectorNetwork } from "./vector";
import { nodePaint } from "./render-style";
import { layoutTextNode, textRenderStyle, type TextMeasurer } from "./text-layout";
import { textOutlineGeometry } from "./text-outlines";

export type GeometryPoint = { x: number; y: number };
export type GeometryBox = { x: number; y: number; width: number; height: number };
export type GeometryBounds = { minX: number; minY: number; maxX: number; maxY: number };
export type GeometryMatrix = { a: number; b: number; c: number; d: number; e: number; f: number };

type TransformNode = Pick<DesignNode, "x" | "y" | "width" | "height" | "rotation"> & {
  skewX?: number;
  flipX?: boolean;
};

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

export function nodeCenter(node: Pick<DesignNode, "x" | "y" | "width" | "height">): GeometryPoint {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

export function rotatePoint(
  point: GeometryPoint,
  center: GeometryPoint,
  degrees: number,
): GeometryPoint {
  if (!degrees) return { ...point };
  const angle = radians(degrees);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

export function inverseRotatePoint(
  point: GeometryPoint,
  center: GeometryPoint,
  degrees: number,
): GeometryPoint {
  return rotatePoint(point, center, -degrees);
}

/** Matrix for T(center) R(rotation) SkewX(skewX) Scale(flipX ? -1 : 1, 1) T(-center). */
export function nodeTransformMatrix(node: TransformNode): GeometryMatrix {
  const angle = radians(node.rotation ?? 0);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const shear = Math.tan(radians(node.skewX ?? 0));
  const sx = node.flipX ? -1 : 1;
  const a = cos * sx;
  const b = sin * sx;
  const c = cos * shear - sin;
  const d = sin * shear + cos;
  const center = nodeCenter(node);
  return {
    a,
    b,
    c,
    d,
    e: center.x - a * center.x - c * center.y,
    f: center.y - b * center.x - d * center.y,
  };
}

export function transformPoint(point: GeometryPoint, matrix: GeometryMatrix): GeometryPoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

export function inverseTransformPoint(point: GeometryPoint, matrix: GeometryMatrix): GeometryPoint {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error("Geometry transform is not invertible.");
  const x = point.x - matrix.e;
  const y = point.y - matrix.f;
  return {
    x: (matrix.d * x - matrix.c * y) / determinant,
    y: (-matrix.b * x + matrix.a * y) / determinant,
  };
}

export function inverseTransformVector(vector: GeometryPoint, matrix: GeometryMatrix): GeometryPoint {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error("Geometry transform is not invertible.");
  return {
    x: (matrix.d * vector.x - matrix.c * vector.y) / determinant,
    y: (-matrix.b * vector.x + matrix.a * vector.y) / determinant,
  };
}

export function matrixToSvgTransform(matrix: GeometryMatrix): string {
  const format = (value: number): string => String(value);
  return `matrix(${format(matrix.a)} ${format(matrix.b)} ${format(matrix.c)} ${format(matrix.d)} ${format(matrix.e)} ${format(matrix.f)})`;
}

export function nodeLocalToDocument(node: DesignNode, point: GeometryPoint): GeometryPoint {
  return transformPoint({ x: node.x + point.x, y: node.y + point.y }, nodeTransformMatrix(node));
}

export function documentToNodeLocal(node: DesignNode, point: GeometryPoint): GeometryPoint {
  const unrotated = inverseTransformPoint(point, nodeTransformMatrix(node));
  return { x: unrotated.x - node.x, y: unrotated.y - node.y };
}

export function vectorNetworkToDocument(node: DesignNode, network: VectorNetwork): VectorNetwork {
  return {
    vertices: network.vertices.map((vertex) => ({ ...vertex, ...nodeLocalToDocument(node, vertex) })),
    segments: network.segments.map((segment) => ({
      ...segment,
      ...(segment.startHandle ? { startHandle: nodeLocalToDocument(node, segment.startHandle) } : {}),
      ...(segment.endHandle ? { endHandle: nodeLocalToDocument(node, segment.endHandle) } : {}),
    })),
    regions: network.regions,
  };
}

export function nodeCorners(node: DesignNode): GeometryPoint[] {
  const matrix = nodeTransformMatrix(node);
  return [
    { x: node.x, y: node.y },
    { x: node.x + node.width, y: node.y },
    { x: node.x + node.width, y: node.y + node.height },
    { x: node.x, y: node.y + node.height },
  ].map((point) => transformPoint(point, matrix));
}

export function boundsFromPoints(points: readonly GeometryPoint[]): GeometryBounds | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Axis-aligned document-space bounds of the node's rotated box and stroke. */
export function nodeVisualBounds(node: DesignNode): GeometryBounds {
  const bounds = boundsFromPoints(nodeCorners(node))!;
  const matrix = nodeTransformMatrix(node);
  const trace = matrix.a * matrix.a + matrix.b * matrix.b + matrix.c * matrix.c + matrix.d * matrix.d;
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  const maxSingular = Math.sqrt((trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant * determinant))) / 2);
  const stroke = nodePaint(node).stroke;
  const strokePadding = stroke
    ? stroke.width * maxSingular / 2
    : 0;
  return {
    minX: bounds.minX - strokePadding,
    minY: bounds.minY - strokePadding,
    maxX: bounds.maxX + strokePadding,
    maxY: bounds.maxY + strokePadding,
  };
}

/** Rendered content bounds, including glyph overflow and transformed text stroke. */
export function nodeRenderBounds(node: DesignNode, textMeasurer?: TextMeasurer | null): GeometryBounds {
  if (node.type !== "text") return nodeVisualBounds(node);
  const layout = layoutTextNode(node, textMeasurer);
  const width = Math.max(node.width, layout.measuredWidth);
  const height = Math.max(node.height, (layout.lines.length - 1) * layout.lineHeight + (node.fontSize ?? 14) * 1.25);
  let x = node.x;
  if (node.textAlign === "center") x = node.x + node.width / 2 - width / 2;
  if (node.textAlign === "right") x = node.x + node.width - width;
  const matrix = nodeTransformMatrix(node);
  const points = [
    { x, y: node.y },
    { x: x + width, y: node.y },
    { x: x + width, y: node.y + height },
    { x, y: node.y + height },
  ];
  const stretch = node.fontStretch ?? 1;
  const anchorX = node.x + (node.textAlign === "center" ? node.width / 2 : node.textAlign === "right" ? node.width : 0);
  if (textRenderStyle(node).bundled) {
    // Logical advances do not include glyph overhang or accents. Use the same
    // outlines as raster export, while retaining browser fallback for legacy
    // unwrapped text containing a glyph absent from the bundled font.
    try {
      const ink = textOutlineGeometry(node).bounds;
      if (ink) for (const inkX of [ink.minX, ink.maxX]) for (const inkY of [ink.minY, ink.maxY]) {
        points.push({ x: anchorX + (inkX - anchorX) * stretch, y: inkY });
      }
    } catch (error) {
      if (node.textWrap) throw error;
    }
  }
  const bounds = boundsFromPoints(points.map((point) => transformPoint(point, matrix)))!;
  const stroke = nodePaint(node).stroke;
  // SVG's default miter limit is four: the outer join extends at most
  // four half-stroke widths. This conservative bound follows the file format:
  // https://www.w3.org/TR/SVG11/painting.html#StrokeMiterlimitProperty
  const joinExtent = stroke?.join === "round" || stroke?.join === "bevel" ? 0.5 : 2;
  const a = matrix.a * stretch;
  const b = matrix.b * stretch;
  const trace = a * a + b * b + matrix.c * matrix.c + matrix.d * matrix.d;
  const determinant = a * matrix.d - b * matrix.c;
  const maxSingular = Math.sqrt((trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant * determinant))) / 2);
  const padding = (stroke?.width ?? 0) * joinExtent * maxSingular;
  return { minX: bounds.minX - padding, minY: bounds.minY - padding,
    maxX: bounds.maxX + padding, maxY: bounds.maxY + padding };
}

export function boundsToBox(bounds: GeometryBounds): GeometryBox {
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}
