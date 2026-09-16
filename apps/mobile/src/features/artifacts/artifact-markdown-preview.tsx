import Markdown from "react-native-markdown-display";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { useAppTheme } from "@/providers/theme";
import { MOBILE_MARKDOWN_PARSER } from "@/lib/mobile-markdown-parser";
import type { AppTheme } from "@/theme/tokens";

export function ArtifactMarkdownPreview({ source }: { source: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createMarkdownStyles(theme), [theme]);
  return (
    <View accessibilityLabel="Markdown preview">
      <Markdown markdownit={MOBILE_MARKDOWN_PARSER} style={styles}>
        {source}
      </Markdown>
    </View>
  );
}

function createMarkdownStyles(t: AppTheme) {
  return StyleSheet.create({
    body: { color: t.color.text.foreground, ...t.typography.body },
    heading1: { color: t.color.text.foreground, marginBottom: t.spacing.md, ...t.typography.title },
    heading2: { color: t.color.text.foreground, marginTop: t.spacing.lg, marginBottom: t.spacing.sm, ...t.typography.heading },
    heading3: { color: t.color.text.foreground, marginTop: t.spacing.md, marginBottom: t.spacing.sm, ...t.typography.subheading },
    heading4: { color: t.color.text.foreground, marginTop: t.spacing.md, marginBottom: t.spacing.xs, ...t.typography.bodyStrong },
    heading5: { color: t.color.text.foreground, marginTop: t.spacing.sm, marginBottom: t.spacing.xs, ...t.typography.label },
    heading6: { color: t.color.text.muted, marginTop: t.spacing.sm, marginBottom: t.spacing.xs, ...t.typography.caption },
    paragraph: { color: t.color.text.foreground, marginTop: 0, marginBottom: t.spacing.md, ...t.typography.body },
    blockquote: {
      backgroundColor: t.color.surface.subtle,
      borderColor: t.color.border.interactive,
      borderLeftWidth: 3,
      marginBottom: t.spacing.md,
      marginLeft: 0,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
    },
    bullet_list: { marginBottom: t.spacing.md },
    ordered_list: { marginBottom: t.spacing.md },
    list_item: { color: t.color.text.foreground, ...t.typography.body },
    bullet_list_icon: { color: t.color.text.muted, marginLeft: t.spacing.sm, marginRight: t.spacing.sm },
    ordered_list_icon: { color: t.color.text.muted, marginLeft: t.spacing.sm, marginRight: t.spacing.sm },
    code_inline: {
      color: t.color.text.foreground,
      backgroundColor: t.color.surface.element,
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
      backgroundColor: t.color.surface.element,
      borderColor: t.color.border.default,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: t.radii.sm,
      fontFamily: "monospace",
      marginBottom: t.spacing.md,
      padding: t.spacing.md,
    },
    code_block: {
      color: t.color.text.foreground,
      backgroundColor: t.color.surface.element,
      borderColor: t.color.border.default,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: t.radii.sm,
      fontFamily: "monospace",
      marginBottom: t.spacing.md,
      padding: t.spacing.md,
    },
    link: { color: t.color.brand.accent, textDecorationLine: "underline" },
    hr: { backgroundColor: t.color.border.default, marginBottom: t.spacing.md },
  });
}
