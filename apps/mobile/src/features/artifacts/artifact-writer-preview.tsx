import { useMemo } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";

import { useAppTheme } from "@/providers/theme";
import { prepareWriterPreview, type PreviewInline } from "./artifact-writer-preview-model";

export function ArtifactWriterPreview({ source }: { source: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => StyleSheet.create({
    document: { gap: theme.spacing.md, paddingBottom: theme.spacing.xl },
    paragraph: { color: theme.color.text.foreground, ...theme.typography.body, lineHeight: 25 },
    heading: { color: theme.color.text.foreground, marginTop: theme.spacing.lg, fontWeight: "700" },
    listRow: { flexDirection: "row", alignItems: "flex-start", paddingLeft: theme.spacing.sm, marginVertical: 1 },
    listMarker: { width: 30, color: theme.color.text.muted, ...theme.typography.body },
    listText: { flex: 1, color: theme.color.text.foreground, ...theme.typography.body },
    link: { textDecorationLine: "underline", color: theme.color.brand.accent },
    unavailable: { color: theme.color.text.muted, paddingVertical: theme.spacing.xl, textAlign: "center", ...theme.typography.body },
  }), [theme]);
  const prepared = useMemo(() => prepareWriterPreview(source), [source]);
  if (!prepared.ok) return <Text style={styles.unavailable}>This file could not be displayed.</Text>;

  let orderedIndex = 0;
  let priorWasOrdered = false;
  return (
    <View style={styles.document} accessibilityLabel="Writer document">
      {prepared.document.blocks.map((block) => {
        if (block.type === "list-item") {
          orderedIndex = block.listKind === "ordered" ? (priorWasOrdered ? orderedIndex + 1 : 1) : 0;
          priorWasOrdered = block.listKind === "ordered";
          return (
            <View key={block.id} style={styles.listRow}>
              <Text style={styles.listMarker}>{block.listKind === "ordered" ? `${orderedIndex}.` : "•"}</Text>
              <Text selectable style={styles.listText}>{renderInlines(block.inlines, styles.link)}</Text>
            </View>
          );
        }
        priorWasOrdered = false;
        orderedIndex = 0;
        const headingStyle = block.type === "heading" ? headingTypography(block.headingLevel ?? 1) : undefined;
        return (
          <Text key={block.id} selectable style={[block.type === "heading" ? styles.heading : styles.paragraph, headingStyle]}>
            {renderInlines(block.inlines, styles.link)}
          </Text>
        );
      })}
    </View>
  );
}

function headingTypography(level: number): { fontSize: number; lineHeight: number } {
  switch (level) {
    case 1: return { fontSize: 30, lineHeight: 37 };
    case 2: return { fontSize: 26, lineHeight: 33 };
    case 3: return { fontSize: 22, lineHeight: 29 };
    case 4: return { fontSize: 19, lineHeight: 26 };
    case 5: return { fontSize: 17, lineHeight: 24 };
    default: return { fontSize: 16, lineHeight: 23 };
  }
}

function renderInlines(inlines: PreviewInline[], linkStyle: object) {
  return inlines.map((inline, index) => {
    const decorations = [inline.style.underline ? "underline" : "", inline.style.strikethrough ? "line-through" : ""].filter(Boolean).join(" ");
    const style = {
      ...(inline.style.bold ? { fontWeight: "700" as const } : {}),
      ...(inline.style.italic ? { fontStyle: "italic" as const } : {}),
      ...(decorations ? { textDecorationLine: decorations as "underline" | "line-through" | "underline line-through" } : {}),
      ...(inline.style.color ? { color: inline.style.color } : {}),
      ...(inline.style.backgroundColor ? { backgroundColor: inline.style.backgroundColor } : {}),
    };
    if (inline.style.href) {
      return (
        <Text key={index} accessibilityRole="link" style={[style, linkStyle]} onPress={() => void Linking.openURL(inline.style.href!)}>
          {inline.text}
        </Text>
      );
    }
    return <Text key={index} style={style}>{inline.text}</Text>;
  });
}
