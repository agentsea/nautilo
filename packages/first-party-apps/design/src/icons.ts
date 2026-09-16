/** Zero-dependency SVG icons bundled with the sandboxed Design app. */
const SVG_NS = "http://www.w3.org/2000/svg";

export const DESIGN_ICON_NAMES = [
  "frame", "text", "rectangle", "image", "group", "vector", "plus",
  "select", "shapes", "ellipse", "triangle", "diamond", "pentagon", "hexagon", "star", "arrow",
  "pen", "connector", "undo", "redo", "layers", "inspector", "expand", "more", "chevron",
] as const;
export type DesignIconName = (typeof DESIGN_ICON_NAMES)[number];

const paths: Record<DesignIconName, readonly string[]> = {
  frame: ["M3 2.5h10v11H3z", "M5.5 5h5v6h-5z"],
  text: ["M3 3h10", "M8 3v10", "M5.5 13h5"],
  rectangle: ["M2.5 3.5h11v9h-11z"],
  image: ["M2.5 3.5h11v9h-11z", "m4.5 10 2-2 1.5 1.5 1.5-2 2 2.5", "M5.5 6.5h.01"],
  group: ["M2.5 4.5h7v7h-7z", "M6.5 2.5h7v7h-4"],
  vector: ["M3 12 6.5 4l3 7 3.5-5", "M3 12h.01", "M6.5 4h.01", "M9.5 11h.01", "M13 6h.01"],
  plus: ["M8 3v10", "M3 8h10"],
  select: ["m3 2 9 6-4.3 1.1L6.5 13z"],
  shapes: ["M3 3.5h5v5H3z", "m9 6 2.5-2.5L14 6l-2.5 2.5z", "M9 10h5v3.5H9z"],
  ellipse: ["M13.5 8c0 3-2.5 5-5.5 5s-5.5-2-5.5-5 2.5-5 5.5-5 5.5 2 5.5 5z"],
  triangle: ["M8 2.5 13.5 13h-11z"],
  diamond: ["m8 2.5 5.5 5.5L8 13.5 2.5 8z"],
  pentagon: ["m8 2.5 5.2 3.8-2 6.2H4.8l-2-6.2z"],
  hexagon: ["m5 2.75 6 0 3 5.25-3 5.25H5L2 8z"],
  star: ["m8 2.25 1.75 3.55 3.92.57-2.83 2.76.67 3.9L8 11.2l-3.51 1.84.67-3.9-2.83-2.76 3.92-.57z"],
  arrow: ["M2.5 6.25h6V3l5 5-5 5v-3.25h-6z"],
  pen: ["m4 12.5 1.1-3.2L11.6 2.8l1.6 1.6-6.5 6.5z", "m10.5 3.9 1.6 1.6", "M3 13h5"],
  connector: ["M4 4h.01", "M12 12h.01", "M4 4h4v4h4"],
  undo: ["M6.5 4 3 7.5 6.5 11", "M3.5 7.5H10a3 3 0 0 1 3 3"],
  redo: ["m9.5 4 3.5 3.5-3.5 3.5", "M12.5 7.5H6a3 3 0 0 0-3 3"],
  layers: ["m3 4 5-2 5 2-5 2z", "m3 7 5 2 5-2", "m3 10 5 2 5-2"],
  inspector: ["M3 2.5h10v11H3z", "M5.5 5.5h5", "M5.5 8h5", "M5.5 10.5h3"],
  expand: ["M6 3H3v3", "m3 3 3.5 3.5", "M10 3h3v3", "m13 3-3.5 3.5", "M6 13H3v-3", "m3 13 3.5-3.5", "M10 13h3v-3", "m13 13-3.5-3.5"],
  more: ["M4 8h.01", "M8 8h.01", "M12 8h.01"],
  chevron: ["m5.5 6 2.5 2.5L10.5 6"],
};

/**
 * All current Design chrome icons are decorative: their adjacent visible text
 * supplies the accessible name. The SVG is explicitly absent from the a11y tree.
 */
export function createDesignIcon(document: Document, name: DesignIconName): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, "svg");
  icon.classList.add("design-icon");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("width", "1em");
  icon.setAttribute("height", "1em");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.5");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  for (const d of paths[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    icon.appendChild(path);
  }
  return icon;
}
