const paths = {
  select: "m5 3 14 10-7 1-3 7Z",
  pan: "M8 13V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8c0 5-3 7-7 7-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-2l2 2",
  note: "M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm10 18v-6h6M7 8h10M7 12h6",
  text: "M4 5V3h16v2M12 3v18M8 21h8",
  shape: "M3 5h12v12H3ZM16 10a6 6 0 1 1-5 9",
  connector: "M4 19 20 3M11 3h9v9",
  image: "M4 3h16v18H4ZM4 16l5-5 4 4 3-3 4 4M8 7h.01",
  undo: "M8 5 3 10l5 5M3 10h12a6 6 0 0 1 0 12",
  redo: "m16 5 5 5-5 5M21 10H9a6 6 0 0 0 0 12",
  fit: "M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8Z",
  minus: "M5 12h14",
  plus: "M5 12h14M12 5v14",
  trash: "M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
  grid: "M3 3h18v18H3ZM3 9h18M3 15h18M9 3v18M15 3v18",
  overview: "M3 3h18v18H3ZM7 7h5v4H7ZM13 13h4v4h-4",
  close: "m6 6 12 12M6 18 18 6",
  board: "M3 4h18v14H3ZM8 22l4-4 4 4M7 8h4v5H7ZM14 8h3M14 12h3",
} as const;
export type BoardIcon = keyof typeof paths;
export function icon(doc: Document, name: BoardIcon): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const p = doc.createElementNS(svg.namespaceURI, "path");
  p.setAttribute("d", paths[name]);
  svg.append(p);
  return svg;
}
