/**
 * Renderer-neutral node paint semantics. Both the live canvas and exported SVG
 * consume this small descriptor so an absent style cannot look different from
 * the static deliverable. An explicitly empty `fills` array remains no fill;
 * only an absent fills field receives the editor's conventional defaults.
 */

import type { DesignNode, DesignStroke } from "./scene-graph";

export const DEFAULT_FRAME_FILL = "#ffffff";
export const DEFAULT_FRAME_STROKE: DesignStroke = { color: "#cbd5e1", width: 1 };
export const DEFAULT_RECTANGLE_FILL = "#cbd5e1";
export const DEFAULT_VECTOR_STROKE: DesignStroke = { color: "#0f172a", width: 1 };

export type NodePaint = { fill: string | null; stroke: DesignStroke | undefined };

function explicitPrimaryFill(node: DesignNode): string | null {
  const fill = node.fills?.[0];
  return fill?.kind === "solid" ? fill.color : null;
}

export function nodePaint(node: DesignNode): NodePaint {
  const explicitFill = explicitPrimaryFill(node);
  // `strokeDisabled` records an intentional Off choice separately from absent
  // legacy paint, whose conventional defaults remain visible for compatibility.
  const stroke = node.strokeDisabled ? undefined : node.stroke;
  if (node.fills !== undefined) return { fill: explicitFill, stroke };
  if (node.booleanOp !== undefined) return { fill: null, stroke };
  switch (node.type) {
    case "frame":
      return { fill: DEFAULT_FRAME_FILL, stroke: node.strokeDisabled ? undefined : stroke ?? DEFAULT_FRAME_STROKE };
    case "rectangle":
      return { fill: DEFAULT_RECTANGLE_FILL, stroke };
    case "vector":
      // Connector geometry is a derived cache over durable endpoint metadata.
      // Its inspector's explicit Stroke Off removes `stroke`, which must stay
      // absent in both live and exported renderers. Ordinary legacy vectors
      // retain the conventional visible fallback when their paint is absent.
      return {
        fill: null,
        stroke: node.connector || node.strokeDisabled ? stroke : stroke ?? DEFAULT_VECTOR_STROKE,
      };
    default:
      return { fill: null, stroke };
  }
}
