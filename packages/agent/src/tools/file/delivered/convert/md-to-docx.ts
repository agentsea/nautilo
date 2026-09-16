import {
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import { remark } from "remark";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toString } from "mdast-util-to-string";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  depth?: number;
  ordered?: boolean;
  lang?: string;
  url?: string;
}

type DocxChild = Paragraph | Table;
type ParagraphChild = TextRun | ExternalHyperlink;

const processor = remark().use(remarkParse).use(remarkGfm);

function nodeText(node: MdNode): string {
  return toString(node as never).trim();
}

function headingLevel(depth: number | undefined): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (depth) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    case 4:
      return HeadingLevel.HEADING_4;
    case 5:
      return HeadingLevel.HEADING_5;
    default:
      return HeadingLevel.HEADING_6;
  }
}

function renderInlineChildren(
  node: MdNode,
  style: { bold?: boolean; italics?: boolean; code?: boolean } = {},
): ParagraphChild[] {
  if (typeof node.value === "string") {
    return [
      new TextRun({
        text: node.value,
        ...(style.bold ? { bold: true } : {}),
        ...(style.italics ? { italics: true } : {}),
        ...(style.code ? { font: "Courier New" } : {}),
      }),
    ];
  }

  const out: ParagraphChild[] = [];
  for (const child of node.children ?? []) {
    switch (child.type) {
      case "strong":
        out.push(...renderInlineChildren(child, { ...style, bold: true }));
        break;
      case "emphasis":
        out.push(...renderInlineChildren(child, { ...style, italics: true }));
        break;
      case "inlineCode":
        out.push(...renderInlineChildren(child, { ...style, code: true }));
        break;
      case "break":
        out.push(new TextRun({ text: "\n" }));
        break;
      case "link": {
        const text = renderInlineChildren(child, style);
        if (child.url) {
          out.push(new ExternalHyperlink({ link: child.url, children: text }));
        } else {
          out.push(...text);
        }
        break;
      }
      default:
        out.push(...renderInlineChildren(child, style));
    }
  }
  return out;
}

function paragraphFromText(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)] });
}

function renderNode(node: MdNode): DocxChild[] {
  switch (node.type) {
    case "heading":
      return [
        new Paragraph({
          heading: headingLevel(node.depth),
          children: renderInlineChildren(node),
        }),
      ];
    case "paragraph":
      return [new Paragraph({ children: renderInlineChildren(node) })];
    case "blockquote":
      return [
        new Paragraph({
          children: [new TextRun(nodeText(node))],
          indent: { left: 720 },
        }),
      ];
    case "list":
      return (node.children ?? []).map((child, i) =>
        new Paragraph({
          children: [new TextRun(`${node.ordered === true ? `${i + 1}.` : "-"} ${nodeText(child)}`)],
        }),
      );
    case "code": {
      const language = node.lang ? `${node.lang}\n` : "";
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: `${language}${node.value ?? ""}`,
              font: "Courier New",
            }),
          ],
        }),
      ];
    }
    case "table":
      return [renderTable(node)];
    case "thematicBreak":
      return [paragraphFromText("------------------------")];
    default:
      return [];
  }
}

function renderTable(node: MdNode): Table {
  return new Table({
    rows: (node.children ?? []).map(
      (row) =>
        new TableRow({
          children: (row.children ?? []).map(
            (cell) =>
              new TableCell({
                children: [paragraphFromText(nodeText(cell))],
              }),
          ),
        }),
    ),
  });
}

export async function markdownToDocxBuffer(markdown: string): Promise<Buffer> {
  const tree = processor.parse(markdown) as MdNode;
  const children = (tree.children ?? []).flatMap(renderNode);
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: children.length > 0 ? children : [paragraphFromText("")],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
