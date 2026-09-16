import type { DesignDocument, DesignNode } from "./scene-graph";
import { nodeCenter, nodeTransformMatrix, transformPoint, type GeometryMatrix } from "./geometry";
import { selectionRoots, subtreeIds } from "./organization";
import { parsePathData, pathDataFromCommands } from "./vector";
import { scaleNetwork } from "./editor/vector-edit";

export const identityMatrix: GeometryMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Compose left after right, in document coordinates. */
export function multiplyMatrices(left: GeometryMatrix, right: GeometryMatrix): GeometryMatrix {
  return {
    a: left.a * right.a + left.c * right.b, b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d, d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e, f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function inverseMatrix(matrix: GeometryMatrix): GeometryMatrix {
  const det = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(det) || det === 0) throw new Error("Transform must be invertible.");
  return { a: matrix.d / det, b: -matrix.b / det, c: -matrix.c / det, d: matrix.a / det,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / det, f: (matrix.b * matrix.e - matrix.a * matrix.f) / det };
}

/**
 * Affine geometry expressed with positive dimensions, rotation, shear and
 * reflection. Editor resizing retains stroke widths/dashes in document units;
 * format import separately maps source paint under its transform contract.
 */
export function transformNode(node: DesignNode, matrix: GeometryMatrix): DesignNode {
  const center = transformPoint(nodeCenter(node), matrix);
  // Pure translation keeps optional fields and floating point coordinates stable.
  if (matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1) {
    const next = { ...node, x: node.x + matrix.e, y: node.y + matrix.f };
    return transformEndpoints(next, matrix);
  }
  const combined = multiplyMatrices(matrix, nodeTransformMatrix(node));
  const det = combined.a * combined.d - combined.b * combined.c;
  const sx = Math.hypot(combined.a, combined.b);
  if (!Number.isFinite(det) || det === 0 || sx === 0) throw new Error("Transform must preserve nonzero axes.");
  const flip = det < 0 ? -1 : 1;
  const qx = combined.a / sx / flip;
  const qy = combined.b / sx / flip;
  const sy = Math.abs(det) / sx;
  const shear = (qx * combined.c + qy * combined.d) / sy;
  const width = node.width * sx;
  const height = node.height * sy;
  const commands = node.vectorPath === undefined ? null : parsePathData(node.vectorPath);
  if (node.vectorPath !== undefined && !commands) throw new Error("This path cannot be transformed without changing its geometry.");
  const next: DesignNode = {
    ...node, x: center.x - width / 2, y: center.y - height / 2, width, height,
    rotation: Math.atan2(qy, qx) * 180 / Math.PI,
    skewX: Math.atan(shear) * 180 / Math.PI, flipX: flip === -1,
    ...(node.radius !== undefined || node.radiusY !== undefined ? { radius: (node.radius ?? 0) * sx, radiusY: (node.radiusY ?? node.radius ?? 0) * sy } : {}),
    ...(node.type === "text" ? { fontSize: (node.fontSize ?? 14) * sy, fontStretch: (node.fontStretch ?? 1) * sx / sy } : {}),
    ...(commands ? { vectorPath: pathDataFromCommands(commands.map((command) => command.kind === "Z" ? command : command.kind === "C" ? { ...command, x: command.x * sx, y: command.y * sy, c1x: command.c1x * sx, c1y: command.c1y * sy, c2x: command.c2x * sx, c2y: command.c2y * sy } : { ...command, x: command.x * sx, y: command.y * sy })) } : {}),
    ...(node.vectorNetwork ? { vectorNetwork: scaleNetwork(node.vectorNetwork, sx, sy) } : {}),
  };
  if (![next.x, next.y, width, height, next.rotation, next.skewX].every(Number.isFinite)) throw new Error("Transform exceeds numeric precision.");
  return transformEndpoints(next, matrix);
}

function transformEndpoints(node: DesignNode, matrix: GeometryMatrix): DesignNode {
  if (!node.connector) return node;
  return { ...node, connector: { ...node.connector,
    start: { ...node.connector.start, ...transformPoint(node.connector.start, matrix) },
    end: { ...node.connector.end, ...transformPoint(node.connector.end, matrix) },
  } };
}

/** The same world transform is baked once into every selected subtree. */
export function transformSubtrees(doc: DesignDocument, ids: readonly string[], matrix: GeometryMatrix): DesignDocument {
  const nodes = { ...doc.nodes };
  for (const id of subtreeIds(doc, selectionRoots(doc, ids))) nodes[id] = transformNode(nodes[id]!, matrix);
  return { ...doc, nodes };
}

/** Map a node's untransformed box to a new box while retaining its local axes. */
export function boxTransform(node: DesignNode, box: Pick<DesignNode, "x" | "y" | "width" | "height">): GeometryMatrix {
  if ((node.width === 0 && box.width !== 0) || (node.height === 0 && box.height !== 0)) throw new Error("A zero-size axis cannot be resized; edit its points first.");
  const center = nodeCenter(node);
  const nextCenter = nodeCenter(box);
  const linear = { ...nodeTransformMatrix(node), e: 0, f: 0 };
  const scale = { ...identityMatrix, a: node.width === 0 ? 1 : box.width / node.width, d: node.height === 0 ? 1 : box.height / node.height };
  const world = multiplyMatrices(multiplyMatrices(linear, scale), inverseMatrix(linear));
  return { ...world, e: nextCenter.x - world.a * center.x - world.c * center.y,
    f: nextCenter.y - world.b * center.x - world.d * center.y };
}
