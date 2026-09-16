/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import type { ASTNode } from "react-native-markdown-display";

import {
  ASSISTANT_RESPONSE_GFM_TABLE_FIXTURE as fixture,
  ASSISTANT_RESPONSE_GFM_TABLE_PARTIAL as partialFixture,
} from "../../../../dev/fixtures/assistant-response-gfm-table";

const mockPlatform = {
  OS: "ios",
  select: (choices: Record<string, unknown>) => choices[mockPlatform.OS] ?? choices.default,
};

mock.module("react-native", () => ({
  Linking: { openURL: async () => {} },
  Platform: mockPlatform,
  ScrollView: "ScrollView",
  Image: { propTypes: {} },
  StyleSheet: {
    create: <T,>(styles: T): T => styles,
    flatten: <T,>(style: T): T => style,
    hairlineWidth: 1,
  },
  Text: "Text",
  TouchableWithoutFeedback: "TouchableWithoutFeedback",
  View: "View",
}));
mock.module("react-native-fit-image", () => ({ default: "FitImage" }));
mock.module("@/providers/theme", () => ({ useAppTheme: mock(() => ({})) }));

const markdownDisplay = await import("react-native-markdown-display");
const {
  assistantTableColumnWidths,
  createAssistantChatMarkdownRules,
  createAssistantChatMarkdownStyles,
  estimateAssistantTableWidth,
} = await import("./assistant-chat-markdown");
const { MOBILE_MARKDOWN_PARSER } = await import("@/lib/mobile-markdown-parser");
const { buildAppTheme } = await import("@/theme/tokens");

function renderedTextStyles(value: unknown, result = new Map<string, Record<string, unknown>>()): Map<string, Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const child of value) renderedTextStyles(child, result);
  } else if (isValidElement(value)) {
    const { children, style, selectable } = (value as ReactElement<{
      children?: unknown; style?: Record<string, unknown> | Record<string, unknown>[]; selectable?: boolean;
    }>).props;
    if (typeof children === "string" && selectable === true) {
      result.set(children, (Array.isArray(style) ? style : [style]).reduce<Record<string, unknown>>(
        (merged, entry) => ({ ...merged, ...entry }), {},
      ));
    }
    renderedTextStyles(children, result);
  }
  return result;
}

describe("assistant Markdown text inheritance", () => {
  test("reserves subpixel rounding space only on iOS text groups without changing typography", () => {
    try {
      for (const mode of ["light", "dark"] as const) {
        const theme = buildAppTheme(mode);
        mockPlatform.OS = "ios";
        const ios = createAssistantChatMarkdownStyles(theme);
        expect(ios.textgroup).toEqual({ paddingBottom: 0.5 });
        expect(ios.text).toEqual({});
        expect(ios.paragraph).toMatchObject(theme.typography.body);
        for (const platform of ["android", "web"]) {
          mockPlatform.OS = platform;
          const other = createAssistantChatMarkdownStyles(theme);
          expect(other.textgroup).toEqual({});
          expect(other.code_inline).toEqual(ios.code_inline);
          expect(other.fence).toEqual(ios.fence);
          expect(other.table).toEqual(ios.table);
        }
      }
    } finally {
      mockPlatform.OS = "ios";
    }
  });

  test("preserves body defaults, bold, nested emphasis, headings, and links through the real AST renderer", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = buildAppTheme(mode);
      const styles = createAssistantChatMarkdownStyles(theme);
      const renderer = new markdownDisplay.AstRenderer({
        ...markdownDisplay.renderRules,
        ...createAssistantChatMarkdownRules(styles, true),
      }, styles);
      const text = renderedTextStyles(renderer.render(parse([
        "Plain", "", "**Bold**", "", "***Nested***", "",
        "[Link](https://example.com)", "", "~~Deleted~~", "",
        ...Array.from({ length: 6 }, (_, index) => `${"#".repeat(index + 1)} Heading${index + 1}\n`),
      ].join("\n"))));
      expect(text.get("Plain")).toMatchObject(theme.typography.body);
      expect(text.get("Bold")).toMatchObject({ fontWeight: "700" });
      expect(text.get("Nested")).toMatchObject({ fontWeight: "700", fontStyle: "italic" });
      expect(text.get("Link")).toMatchObject({ color: theme.color.brand.accent, textDecorationLine: "underline" });
      expect(text.get("Deleted")).toMatchObject({ textDecorationLine: "line-through" });
      for (let level = 1; level <= 6; level++) {
        const heading = styles[`heading${level}`] as { fontSize: number; fontWeight: string; lineHeight: number };
        expect(text.get(`Heading${level}`)).toMatchObject({
          fontSize: heading.fontSize, fontWeight: heading.fontWeight, lineHeight: heading.lineHeight,
        });
      }
    }
  });
});

function findNode(nodes: readonly ASTNode[], type: string): ASTNode | undefined {
  for (const node of nodes) {
    if (node.type === type) return node;
    const child = findNode(node.children, type);
    if (child) return child;
  }
}

function contents(node: ASTNode): string {
  return `${node.content}${node.children.map(contents).join("")}`;
}

function parse(source: string): ASTNode[] {
  return markdownDisplay.tokensToAST(
    markdownDisplay.stringToTokens(source, MOBILE_MARKDOWN_PARSER),
  );
}

const INLINE_CODE_WRAP_FIXTURE = [
  "1. Current directory: `/Users/tester/Projects/sample-workspace`",
  "2. Visible entries: `.DS_Store`, `.agents`, `.cache`, `.cursor`, `.nautilo`, `.officecli`, `AGENTS.md`, `archive`, `private_notes`, `apps`, `sample-editor`, `drafts`, `crypto-lab`, `nautilo`, `sample-catalogs`, `sample-docs`, `packages`, `worktrees`",
  "3. `sample-editor` folder: `Yes`",
].join("\n");

describe("assistant chat Markdown tables", () => {
  test("processes the smart-quotes denial-of-service fixture with the shared parser", () => {
    const payload = '"'.repeat(80_000);
    const tokens = markdownDisplay.stringToTokens(
      payload,
      MOBILE_MARKDOWN_PARSER,
    );

    expect(tokens).not.toHaveLength(0);
  });

  test("bounds long and repeated inline-code spans inside narrow message content", () => {
    const tree = parse(INLINE_CODE_WRAP_FIXTURE);
    const inlineCode: ASTNode[] = [];
    const collect = (nodes: readonly ASTNode[]): void => {
      for (const node of nodes) {
        if (node.type === "code_inline") inlineCode.push(node);
        collect(node.children);
      }
    };
    collect(tree);

    expect(inlineCode.map((node) => node.content)).toContain(
      "/Users/tester/Projects/sample-workspace",
    );
    expect(inlineCode).toHaveLength(21);

    for (const mode of ["light", "dark"] as const) {
      const styles = createAssistantChatMarkdownStyles(buildAppTheme(mode));
      expect(styles.code_inline).toMatchObject({
        flexShrink: 1,
        maxWidth: "100%",
        minWidth: 0,
      });
    }
  });

  test("measures list content from its natural width before shrinking it into the bubble", () => {
    const tree = parse(INLINE_CODE_WRAP_FIXTURE);
    expect(findNode(tree, "ordered_list")).toBeDefined();
    expect(findNode(tree, "list_item")).toBeDefined();

    for (const mode of ["light", "dark"] as const) {
      const styles = createAssistantChatMarkdownStyles(buildAppTheme(mode));
      expect(styles.ordered_list_content).toMatchObject({
        flex: -1,
        minWidth: 0,
      });
      expect(styles.bullet_list_content).toMatchObject({
        flex: -1,
        minWidth: 0,
      });
    }
  });

  test("the shared fixture parses with GFM structure, alignment, rich cells, and an empty cell", () => {
    const tree = parse(fixture);
    const table = findNode(tree, "table");
    expect(table).toBeDefined();
    if (!table) throw new Error("Expected the shared fixture to contain a table");
    expect(findNode(tree, "thead")).toBeDefined();
    expect(findNode(tree, "tbody")).toBeDefined();
    expect(findNode(tree, "link")?.attributes.href).toBe("https://nautilo.ai");
    expect(findNode(tree, "code_inline")?.content).toBe("ready");

    const rows = table.children.flatMap((section) => section.children);
    const headers = rows[0]?.children ?? [];
    expect(headers[0]?.attributes.style).toContain("text-align:left");
    expect(headers[1]?.attributes.style).toContain("text-align:center");
    expect(headers[2]?.attributes.style).toContain("text-align:right");
    const emptyCell = rows[1]?.children[4];
    expect(emptyCell).toBeDefined();
    if (!emptyCell) throw new Error("Expected the shared fixture to contain an empty cell");
    expect(contents(emptyCell).trim()).toBe("");
  });

  test("partial streamed syntax converges deterministically to one table", () => {
    expect(findNode(parse(partialFixture), "table")).toBeUndefined();
    const completed = parse(fixture);
    const tables: ASTNode[] = [];
    const collect = (nodes: readonly ASTNode[]): void => {
      for (const node of nodes) {
        if (node.type === "table") tables.push(node);
        collect(node.children);
      }
    };
    collect(completed);
    expect(tables).toHaveLength(1);
  });

  test("uses theme colors and contains wide content in a horizontal table-only scroller", () => {
    const table = findNode(parse(fixture), "table");
    expect(table).toBeDefined();
    if (!table) throw new Error("Expected wide fixture table");
    expect(estimateAssistantTableWidth(table)).toBeGreaterThan(500);
    const columnWidths = assistantTableColumnWidths(table);
    expect(columnWidths[3]).toBeGreaterThan(columnWidths[0] ?? 0);

    const compact = findNode(parse("| A | B |\n| --- | ---: |\n| x | 2 |"), "table");
    expect(compact).toBeDefined();
    if (!compact) throw new Error("Expected compact fixture table");
    expect(estimateAssistantTableWidth(compact)).toBeLessThan(320);

    for (const mode of ["light", "dark"] as const) {
      const theme = buildAppTheme(mode);
      const styles = createAssistantChatMarkdownStyles(theme);
      expect(styles.table).toMatchObject({
        borderColor: theme.color.border.default,
        backgroundColor: theme.color.surface.background,
      });
      expect(styles.thead).toMatchObject({
        backgroundColor: theme.color.surface.subtle,
      });
      expect(styles.tr).toMatchObject({
        borderBottomColor: theme.color.border.default,
      });
      expect(JSON.stringify(styles)).not.toContain("#000000");

      const rules = createAssistantChatMarkdownRules(styles);
      const rendered = rules.table?.(table, ["table rows"], [], styles);
      expect(isValidElement(rendered)).toBe(true);
      const scroller = rendered as ReactElement<Record<string, unknown>>;
      expect(scroller.type).toBe("ScrollView");
      expect(scroller.props.horizontal).toBe(true);
      expect(scroller.props.nestedScrollEnabled).toBe(true);
      expect(scroller.props.accessibilityLabel).toBe("Scrollable Markdown table");
      expect(styles.tableViewport).toMatchObject({ maxWidth: "100%", flexShrink: 1 });
      expect(styles.tableScrollContent).toMatchObject({ minWidth: "100%" });
    }
  });

  test("keeps the parser's unsafe HTML mode disabled", async () => {
    const source = await Bun.file(
      new URL("../lib/mobile-markdown-parser.ts", import.meta.url),
    ).text();
    expect(source).toContain("html: false");
    expect(source).toContain("linkify: false");
    expect(source).not.toContain("WebView");
  });
});
