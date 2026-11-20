import type { HtmlFormattingSelection } from "./html-formatting-toolbar";
import type { HtmlTextSelectionOffsets } from "./html-text-selection";

export const emptyHtmlFormattingSelection: HtmlFormattingSelection = {
  available: false, collapsed: true, marks: { bold: "off", italic: "off", underline: "off", superscript: "off" }, link: null,
};

/** Read rendered formatting, including decorations painted by an ancestor. */
export function describeHtmlFormatting(root: HTMLElement, offsets: HtmlTextSelectionOffsets) {
  const win = root.ownerDocument.defaultView!;
  const start = Math.min(offsets.anchor, offsets.focus), end = Math.max(offsets.anchor, offsets.focus);
  const leaves: { element: Element; start: number; end: number }[] = [];
  let position = 0;
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const length = node.textContent?.length ?? 0;
      if (length && node.parentElement) leaves.push({ element: node.parentElement, start: position, end: position + length });
      position += length;
    } else if (node.nodeName === "BR") position++;
    else node.childNodes.forEach(visit);
  };
  visit(root);
  const selected = start === end
    ? [leaves.find(leaf => start > leaf.start && start <= leaf.end) ?? leaves.find(leaf => start === leaf.start)].filter(Boolean) as typeof leaves
    : leaves.filter(leaf => leaf.start < end && leaf.end > start);
  const elements = selected.length ? selected.map(leaf => leaf.element) : [root];
  const owners = new Map<number, string>();
  let unlocatedUnderline = false;
  const values = elements.map(element => {
    const style = win.getComputedStyle(element);
    let underline = false;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const lines = win.getComputedStyle(ancestor).textDecorationLine;
      if (!lines.split(/\s+/).includes("underline")) continue;
      underline = true;
      const source = ancestor.getAttribute("data-nautilo-html-source");
      if (source !== null && Number.isFinite(Number(source))) owners.set(Number(source), lines);
      // Lexical's wrapper may inherit the root's computed decoration. Only
      // source-backed ancestors can be changed in canonical HTML.
      else if (!ancestor.closest("[contenteditable=true]")) unlocatedUnderline = true;
    }
    const href = element.closest("a[href]")?.getAttribute("href") ?? null;
    return { bold: Number.parseInt(style.fontWeight, 10) >= 600 || style.fontWeight === "bold",
      superscript: element.closest("sup") !== null, italic: style.fontStyle === "italic" || style.fontStyle.startsWith("oblique"), underline, href };
  });
  const state = (mark: "bold" | "italic" | "underline" | "superscript") => values.every(value => value[mark]) ? "on" : values.some(value => value[mark]) ? "mixed" : "off";
  const href = values[0]?.href;
  return {
    selection: { available: true, collapsed: start === end,
      marks: { bold: state("bold"), italic: state("italic"), underline: state("underline"), superscript: state("superscript") },
      link: href && values.every(value => value.href === href) ? { href } : null,
    } satisfies HtmlFormattingSelection,
    underlineOwners: [...owners.keys()], underlineOwnerLines: Object.fromEntries(owners), unlocatedUnderline,
    anyLink: values.some(value => value.href !== null),
  };
}

/** Text-only edits shift offsets but preserve the order of source elements. */
export function mapHtmlSourceOwners(oldPreview: string, nextPreview: string, owners: number[], lines: Record<number, string>) {
  const parse = (html: string) => Array.from(new DOMParser().parseFromString(html, "text/html")
    .querySelectorAll("[data-nautilo-html-source]"), element => Number(element.getAttribute("data-nautilo-html-source")));
  const before = parse(oldPreview), after = parse(nextPreview);
  if (before.length !== after.length) throw new Error("The page structure changed. Select the text again.");
  const mapped: number[] = [], mappedLines: Record<number, string> = {};
  for (const owner of owners) {
    const index = before.indexOf(owner), current = after[index];
    if (index < 0 || current === undefined) throw new Error("The formatting source changed. Select the text again.");
    mapped.push(current); mappedLines[current] = lines[owner];
  }
  return { underlineOwners: mapped, underlineOwnerLines: mappedLines };
}
