import { createElement, type ReactElement } from "react";
import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { remark } from "remark";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toString } from "mdast-util-to-string";
import {
  modernReportTheme,
} from "@nautilo/fonts";
import {
  reactPdfFamilyForRole,
  reactPdfFamilyForText,
  registerReactPdfFonts,
  validateTextForReactPdfFonts,
} from "@nautilo/fonts/react-pdf";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  depth?: number;
  ordered?: boolean;
  lang?: string;
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 54,
    paddingRight: 54,
    paddingBottom: 54,
    paddingLeft: 54,
    fontFamily: reactPdfFamilyForRole(modernReportTheme.fonts.body),
    fontSize: modernReportTheme.typography.bodySize,
    lineHeight: modernReportTheme.typography.lineHeight,
    color: modernReportTheme.colors.foreground,
  },
  h1: { fontSize: 22, marginBottom: 12, fontWeight: 700, fontFamily: reactPdfFamilyForRole(modernReportTheme.fonts.heading) },
  h2: { fontSize: 17, marginTop: 10, marginBottom: 8, fontWeight: 700, fontFamily: reactPdfFamilyForRole(modernReportTheme.fonts.heading) },
  h3: { fontSize: 14, marginTop: 8, marginBottom: 6, fontWeight: 700, fontFamily: reactPdfFamilyForRole(modernReportTheme.fonts.heading) },
  paragraph: { marginBottom: 8 },
  list: { marginBottom: 8 },
  listItem: { marginBottom: 4, paddingLeft: 12 },
  codeBlock: {
    marginTop: 4,
    marginBottom: 10,
    padding: 8,
    backgroundColor: "#f3f4f6",
    fontFamily: reactPdfFamilyForRole(modernReportTheme.fonts.mono),
    fontSize: 9,
    lineHeight: 1.35,
  },
  quote: {
    marginBottom: 8,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: "#d1d5db",
    color: modernReportTheme.colors.muted,
  },
  rule: { height: 1, marginTop: 8, marginBottom: 12, backgroundColor: "#d1d5db" },
  table: { marginBottom: 10, borderWidth: 1, borderColor: "#d1d5db" },
  tableRow: { flexDirection: "row" },
  tableCell: {
    flexGrow: 1,
    flexBasis: 0,
    padding: 4,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#d1d5db",
  },
  tableCellText: { fontSize: 9 },
});

const processor = remark().use(remarkParse).use(remarkGfm);

function validatePdfTextSupport(markdown: string): string | null {
  return validateTextForReactPdfFonts(markdown);
}

function nodeText(node: MdNode): string {
  return toString(node as never).trim();
}

function inlineText(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(inlineText).join("");
}

function renderNode(node: MdNode, key: string): ReactElement | null {
  switch (node.type) {
    case "heading": {
      const depth = node.depth ?? 1;
      const style = depth === 1 ? styles.h1 : depth === 2 ? styles.h2 : styles.h3;
      const text = nodeText(node);
      return createElement(Text, { key, style: [style, { fontFamily: reactPdfFamilyForText(text, modernReportTheme.fonts.heading) }] }, text);
    }
    case "paragraph": {
      const text = inlineText(node);
      return createElement(Text, { key, style: [styles.paragraph, { fontFamily: reactPdfFamilyForText(text) }] }, text);
    }
    case "blockquote":
      return createElement(
        View,
        { key, style: styles.quote },
        ...(node.children ?? []).map((child, i) => renderNode(child, `${key}-q${i}`)),
      );
    case "list": {
      const marker = node.ordered === true ? "1." : "-";
      const items = (node.children ?? []).map((child, i) =>
        createElement(
          Text,
          {
            key: `${key}-li${i}`,
            style: [
              styles.listItem,
              { fontFamily: reactPdfFamilyForText(nodeText(child)) },
            ],
          },
          `${node.ordered === true ? `${i + 1}.` : marker} ${nodeText(child)}`,
        ),
      );
      return createElement(View, { key, style: styles.list }, ...items);
    }
    case "code": {
      const label = node.lang ? `${node.lang}\n` : "";
      return createElement(
        View,
        { key, style: styles.codeBlock },
        createElement(Text, null, `${label}${node.value ?? ""}`),
      );
    }
    case "thematicBreak":
      return createElement(View, { key, style: styles.rule });
    case "table":
      return renderTable(node, key);
    default:
      return null;
  }
}

function renderTable(node: MdNode, key: string): ReactElement {
  const rows = (node.children ?? []).map((row, rowIdx) => {
    const cells = (row.children ?? []).map((cell, cellIdx) =>
      createElement(
        View,
        { key: `${key}-r${rowIdx}-c${cellIdx}`, style: styles.tableCell },
        createElement(Text, { style: styles.tableCellText }, nodeText(cell)),
      ),
    );
    return createElement(View, { key: `${key}-r${rowIdx}`, style: styles.tableRow }, ...cells);
  });
  return createElement(View, { key, style: styles.table }, ...rows);
}

export async function markdownToPdfBuffer(markdown: string): Promise<Buffer> {
  registerReactPdfFonts(Font);
  const textError = validatePdfTextSupport(markdown);
  if (textError) throw new Error(textError);
  const tree = processor.parse(markdown) as MdNode;
  const children = (tree.children ?? [])
    .map((node, i) => renderNode(node, `node-${i}`))
    .filter((node): node is ReactElement => node !== null);

  const document = createElement(
    Document,
    null,
    createElement(Page, { size: "A4", style: styles.page }, ...children),
  );
  return renderToBuffer(document);
}
