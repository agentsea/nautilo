import Markdown, {
  type ASTNode,
  type RenderRules,
} from "react-native-markdown-display";
import { memo, useMemo, type ReactNode } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import { MOBILE_MARKDOWN_PARSER } from "@/lib/mobile-markdown-parser";

const TABLE_CELL_MIN_WIDTH = 84;
const TABLE_CELL_MAX_WIDTH = 240;
const TABLE_CHARACTER_WIDTH = 7.5;
const TABLE_CELL_CHROME_WIDTH = 24;

type MarkdownStyles = StyleSheet.NamedStyles<
  Record<string, ViewStyle | TextStyle | ImageStyle>
> & {
  code_block: TextStyle;
  code_inline: TextStyle;
  fence: TextStyle;
  table: ViewStyle;
  tableScrollContent: ViewStyle;
  tableViewport: ViewStyle;
  td: ViewStyle;
  text: TextStyle;
  th: ViewStyle;
};

function nodeText(node: ASTNode): string {
  return node.children.length > 0
    ? node.children.map(nodeText).join("")
    : (node.content ?? "");
}

function tableRows(node: ASTNode): ASTNode[] {
  if (node.type === "tr") return [node];
  return node.children.flatMap(tableRows);
}

/**
 * Gives wide columns readable space while leaving compact tables below the
 * viewport width. The ScrollView's minWidth then expands compact tables only
 * to the available message width.
 */
export function estimateAssistantTableWidth(node: ASTNode): number {
  return assistantTableColumnWidths(node).reduce((sum, width) => sum + width, 0);
}

export function assistantTableColumnWidths(node: ASTNode): number[] {
  const rows = tableRows(node);
  const columnWidths: number[] = [];

  for (const row of rows) {
    const cells = row.children.filter(
      (child) => child.type === "th" || child.type === "td",
    );
    cells.forEach((cell, columnIndex) => {
      const estimatedWidth = Math.ceil(
        nodeText(cell).trim().length * TABLE_CHARACTER_WIDTH +
          TABLE_CELL_CHROME_WIDTH,
      );
      columnWidths[columnIndex] = Math.max(
        columnWidths[columnIndex] ?? TABLE_CELL_MIN_WIDTH,
        Math.min(TABLE_CELL_MAX_WIDTH, Math.max(TABLE_CELL_MIN_WIDTH, estimatedWidth)),
      );
    });
  }

  return columnWidths;
}

export function createAssistantChatMarkdownRules(
  styles: MarkdownStyles,
  selectable = false,
): RenderRules {
  const renderCell = (
    kind: "th" | "td",
    node: ASTNode,
    children: ReactNode[],
    parentNodes: ASTNode[],
    rendererStyles: Record<string, ViewStyle>,
  ) => {
    const table = parentNodes.find((parent) => parent.type === "table");
    const width = table
      ? assistantTableColumnWidths(table)[node.index]
      : TABLE_CELL_MIN_WIDTH;
    return (
      <View
        key={node.key}
        style={[
          rendererStyles[`_VIEW_SAFE_${kind}`] ?? styles[kind],
          {
            flexBasis: width,
            flexGrow: 0,
            flexShrink: 0,
            width,
          },
        ]}>
        {children}
      </View>
    );
  };
  const renderCode = (style: TextStyle) => (node: ASTNode, children: ReactNode[]) => (
    <Text key={node.key} selectable={selectable} style={style}>{node.content ?? children}</Text>
  );

  return {
    text: (node: ASTNode, children: ReactNode[], _parents: ASTNode[], _styles: Record<string, ViewStyle>, inheritedStyles: TextStyle = {}) => (
      <Text key={node.key} selectable={selectable} style={[inheritedStyles, styles.text]}>{node.content ?? children}</Text>
    ),
    code_inline: renderCode(styles.code_inline),
    fence: renderCode(styles.fence),
    code_block: renderCode(styles.code_block),
    table: (node: ASTNode, children: ReactNode[]) => (
      <ScrollView
        key={node.key}
        horizontal
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator
        style={styles.tableViewport}
        contentContainerStyle={styles.tableScrollContent}
        accessibilityLabel="Scrollable Markdown table"
        accessibilityHint="Swipe horizontally to view additional columns">
        <View
          style={[
            styles.table,
            {
              width: estimateAssistantTableWidth(node),
              minWidth: "100%",
            },
          ]}>
          {children}
        </View>
      </ScrollView>
    ),
    th: (
      node: ASTNode,
      children: ReactNode[],
      parentNodes: ASTNode[],
      rendererStyles: Record<string, ViewStyle>,
    ) =>
      renderCell("th", node, children, parentNodes, rendererStyles),
    td: (
      node: ASTNode,
      children: ReactNode[],
      parentNodes: ASTNode[],
      rendererStyles: Record<string, ViewStyle>,
    ) =>
      renderCell("td", node, children, parentNodes, rendererStyles),
  };
}

export function createAssistantChatMarkdownStyles(t: AppTheme): MarkdownStyles {
  return StyleSheet.create({
    body: {
      alignSelf: "stretch",
      flexShrink: 1,
      color: t.color.text.foreground,
      ...t.typography.body,
    },
    // Body defaults belong above semantic nodes. Repeating them on inline
    // groups/leaves overrides inherited heading, emphasis, and link styles.
    text: {},
    // iOS can round a six-line 132pt text frame down to 131.99988pt,
    // making TextKit clip the final line into the preceding one. Half a
    // physical pixel of padding makes text layout round up with spare room;
    // whole-pixel padding is subtracted again and does not fix this case.
    textgroup: Platform.OS === "ios"
      ? { paddingBottom: StyleSheet.hairlineWidth / 2 }
      : {},
    paragraph: {
      color: t.color.text.foreground,
      marginTop: 0,
      marginBottom: t.spacing.xs,
      ...t.typography.body,
    },
    heading1: {
      color: t.color.text.foreground,
      marginTop: t.spacing.sm,
      marginBottom: t.spacing.xs,
      ...t.typography.heading,
    },
    heading2: {
      color: t.color.text.foreground,
      marginTop: t.spacing.sm,
      marginBottom: t.spacing.xs,
      ...t.typography.subheading,
    },
    heading3: {
      color: t.color.text.foreground,
      marginTop: t.spacing.xs,
      marginBottom: t.spacing.xs,
      ...t.typography.bodyStrong,
    },
    heading4: {
      color: t.color.text.foreground,
      marginTop: t.spacing.xs,
      marginBottom: t.spacing.xs,
      ...t.typography.bodyStrong,
    },
    heading5: {
      color: t.color.text.foreground,
      marginTop: t.spacing.xs,
      marginBottom: t.spacing.xs,
      ...t.typography.label,
    },
    heading6: {
      color: t.color.text.muted,
      marginTop: t.spacing.xs,
      marginBottom: t.spacing.xs,
      ...t.typography.caption,
    },
    strong: {
      color: t.color.text.foreground,
      fontWeight: "700",
    },
    em: {
      color: t.color.text.foreground,
      fontStyle: "italic",
    },
    s: {
      color: t.color.text.muted,
      textDecorationLine: "line-through",
    },
    blockquote: {
      backgroundColor: t.color.surface.subtle,
      borderColor: t.color.border.interactive,
      borderLeftWidth: 3,
      marginVertical: t.spacing.xs,
      marginLeft: 0,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xs,
    },
    bullet_list: {
      marginVertical: t.spacing.xs,
    },
    ordered_list: {
      marginVertical: t.spacing.xs,
    },
    list_item: {
      color: t.color.text.foreground,
      ...t.typography.body,
    },
    bullet_list_icon: {
      color: t.color.text.muted,
      marginLeft: t.spacing.xs,
      marginRight: t.spacing.sm,
    },
    ordered_list_icon: {
      color: t.color.text.muted,
      marginLeft: t.spacing.xs,
      marginRight: t.spacing.sm,
    },
    // The renderer defaults to flex: 1 (zero basis). In a shrink-wrapped
    // bubble that under-measures wrapped list text; use natural size + shrink.
    bullet_list_content: {
      flex: -1,
      minWidth: 0,
    },
    ordered_list_content: {
      flex: -1,
      minWidth: 0,
    },
    code_inline: {
      color: t.color.text.foreground,
      backgroundColor: t.color.surface.subtle,
      borderColor: t.color.border.default,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: t.radii.sm,
      flexShrink: 1,
      fontFamily: "monospace",
      maxWidth: "100%",
      minWidth: 0,
      paddingHorizontal: t.spacing.xs,
    },
    fence: {
      color: t.color.text.foreground,
      backgroundColor: t.color.surface.background,
      borderColor: t.color.border.default,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: t.radii.sm,
      fontFamily: "monospace",
      marginVertical: t.spacing.xs,
      padding: t.spacing.sm,
    },
    code_block: {
      color: t.color.text.foreground,
      backgroundColor: t.color.surface.background,
      borderColor: t.color.border.default,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: t.radii.sm,
      fontFamily: "monospace",
      marginVertical: t.spacing.xs,
      padding: t.spacing.sm,
    },
    link: {
      color: t.color.brand.accent,
      textDecorationLine: "underline",
    },
    hr: {
      backgroundColor: t.color.border.default,
      marginVertical: t.spacing.sm,
    },
    tableViewport: {
      alignSelf: "stretch",
      flexGrow: 0,
      flexShrink: 1,
      maxWidth: "100%",
      marginVertical: t.spacing.xs,
    },
    tableScrollContent: {
      flexGrow: 1,
      minWidth: "100%",
    },
    table: {
      alignSelf: "stretch",
      backgroundColor: t.color.surface.background,
      borderColor: t.color.border.default,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: t.radii.sm,
      overflow: "hidden",
    },
    thead: {
      backgroundColor: t.color.surface.subtle,
    },
    tbody: {
      backgroundColor: t.color.surface.background,
    },
    tr: {
      borderBottomColor: t.color.border.default,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
    },
    th: {
      flexBasis: 0,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xs,
    },
    td: {
      flexBasis: 0,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: t.spacing.xs,
    },
  });
}

export const AssistantChatMarkdown = memo(function AssistantChatMarkdown({
  source,
  selectable = false,
}: {
  source: string;
  /** Inert transcript rows retain Markdown while allowing native text selection. */
  selectable?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createAssistantChatMarkdownStyles(theme), [theme]);
  const rules = useMemo(() => createAssistantChatMarkdownRules(styles, selectable), [selectable, styles]);

  return (
    <Markdown
      markdownit={MOBILE_MARKDOWN_PARSER}
      rules={rules}
      style={styles}
      mergeStyle>
      {source}
    </Markdown>
  );
});
