export const SLIDES_ICONS = {
  slides: ["M4 3h16v14H4z", "M8 21h8", "M12 17v4"],
  save: ["M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z", "M17 21v-8H7v8", "M7 3v5h8"],
  undo: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
  redo: ["m15 14 5-5-5-5", "M20 9H9.5a5.5 5.5 0 0 0 0 11H13"],
  plus: ["M12 5v14", "M5 12h14"],
  pointer: ["m5 3 14 9-6 2-3 6Z"],
  type: ["M4 7V4h16v3", "M9 20h6", "M12 4v16"],
  image: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "m3 16 5-5 4 4 3-3 6 6", "M14.5 8.5h.01"],
  play: ["m8 5 11 7-11 7Z"],
  chevron: ["m9 18 6-6-6-6"],
  panel: ["M4 5h16v14H4z", "M4 9h16"],
  alignLeft: ["M4 6h16", "M4 12h10", "M4 18h16"],
  alignCenter: ["M4 6h16", "M7 12h10", "M4 18h16"],
  alignRight: ["M4 6h16", "M10 12h10", "M4 18h16"],
} as const;

export type SlidesIconName = keyof typeof SLIDES_ICONS;

export function slidesIcon(doc: Document, name: SlidesIconName): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of SLIDES_ICONS[name]) {
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
