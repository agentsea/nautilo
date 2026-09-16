import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

const UNICODE_FIXTURE = [
  "# Unicode and IME",
  "",
  "Café · naïve · 東京 · 한국어 · مرحبا · 🫖",
  "",
  "Edit this line with a composing keyboard: **bold**, _italic_, and [link](https://nautilo.ai).",
].join("\n");

const PASTE_FIXTURE =
  "Pasted: 🫖 **bold** _italic_ [Nautilo](https://nautilo.ai)\nSecond line.";

function boundaryFixture(): string {
  const heading = "# 3,900-character source boundary fixture\n\n";
  const unit = "**bold** _italic_ [link](https://nautilo.ai) 🫖 ";
  return (heading + unit.repeat(100)).slice(0, 3_900);
}

function stressFixture(): string {
  const longLine = "A".repeat(8_000);
  return `${longLine}\n${"Unicode 🫖 東京 **source stays visible**. ".repeat(250)}`.slice(
    0,
    16_000,
  );
}

function largeSourceFixture(targetCharacters: number): string {
  const prefix = "# Large native source\n\nCafé 東京 한국어 مرحبا 🫖\n\n";
  const line = `${"A".repeat(120)}\n`;
  return (prefix + line.repeat(Math.ceil(targetCharacters / line.length))).slice(
    0,
    targetCharacters,
  );
}

type Selection = { start: number; end: number };

export default function MarkdownSourceQualificationScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [value, setValue] = useState(UNICODE_FIXTURE);
  const [inputVersion, setInputVersion] = useState(0);
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  const [mounted, setMounted] = useState(true);
  const [clipboardReady, setClipboardReady] = useState(false);
  const [loadEvidence, setLoadEvidence] = useState("small fixture");
  const loadStartedAt = useRef<number | null>(null);

  const onSelectionChange = (
    event: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
  ): void => setSelection(event.nativeEvent.selection);

  const copyPasteFixture = async (): Promise<void> => {
    await Clipboard.setStringAsync(PASTE_FIXTURE);
    setClipboardReady(true);
  };

  const loadFixture = (nextValue: string): void => {
    loadStartedAt.current = Date.now();
    setLoadEvidence(`${new TextEncoder().encode(nextValue).byteLength.toLocaleString()} bytes loading`);
    setValue(nextValue);
    setSelection({ start: 0, end: 0 });
    setInputVersion((current) => current + 1);
  };

  return (
    <View style={styles.root}>
      <AppBar
        title="Markdown source qualification"
        left={<AppBarBackButton onPress={() => router.back()} />}
      />
      <KeyboardAvoidingView behavior="padding" style={styles.body}>
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.actions}
          style={styles.actionScroller}
        >
          <Action label="Unicode / IME" onPress={() => loadFixture(UNICODE_FIXTURE)} styles={styles} />
          <Action label="3,900 chars" onPress={() => loadFixture(boundaryFixture())} styles={styles} />
          <Action label="16,000 chars" onPress={() => loadFixture(stressFixture())} styles={styles} />
          <Action label="Empty" onPress={() => loadFixture("")} styles={styles} />
          <Action label="Copy paste fixture" onPress={() => void copyPasteFixture()} styles={styles} />
        </ScrollView>

        <View style={styles.proofActions}>
          <Action label="1M" onPress={() => loadFixture(largeSourceFixture(1_000_000))} styles={styles} />
          <Action label="5M" onPress={() => loadFixture(largeSourceFixture(5_000_000))} styles={styles} />
          <Action label="10M" onPress={() => loadFixture(largeSourceFixture(10_000_000))} styles={styles} />
          <Action
            label={mounted ? "Unmount input" : "Remount input"}
            onPress={() => setMounted((current) => !current)}
            styles={styles}
          />
        </View>

        <View style={styles.telemetry}>
          <Text style={styles.telemetryText} testID="markdown-source-length">
            {value.length.toLocaleString()} chars
          </Text>
          <Text style={styles.telemetryText} testID="markdown-source-selection">
            selection {selection.start}–{selection.end}
          </Text>
          <Text style={styles.telemetryText}>{Platform.OS}</Text>
          <Text style={styles.telemetryText} testID="markdown-source-load-evidence">
            {loadEvidence}
          </Text>
        </View>

        <Text style={styles.instructions}>
          This is the production fallback boundary: the platform TextInput owns IME, cursor,
          selection, paste, and undo. Every Markdown delimiter remains visible and canonical.
        </Text>
        {clipboardReady ? (
          <Text style={styles.ready} accessibilityRole="alert">
            Paste fixture copied. Use the native paste action inside the editor.
          </Text>
        ) : null}

        <View style={styles.editorFrame}>
          {mounted ? (
            <TextInput
              key={inputVersion}
              testID="markdown-source-input"
              accessibilityLabel="Markdown source qualification input"
              multiline
              autoCorrect
              scrollEnabled
              defaultValue={value}
              onChangeText={setValue}
              onSelectionChange={onSelectionChange}
              onContentSizeChange={() => {
                if (loadStartedAt.current === null) return;
                setLoadEvidence(
                  `${new TextEncoder().encode(value).byteLength.toLocaleString()} bytes ready in ${Date.now() - loadStartedAt.current} ms`,
                );
                loadStartedAt.current = null;
              }}
              style={styles.input}
              textAlignVertical="top"
            />
          ) : (
            <View style={styles.unmounted} testID="markdown-source-unmounted">
              <Text style={styles.instructions}>
                Input unmounted; remount to verify controlled teardown.
              </Text>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function Action({
  label,
  onPress,
  styles,
}: {
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.action}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.surface.background },
    body: { flex: 1, padding: theme.spacing.md, gap: theme.spacing.sm },
    actionScroller: { flexGrow: 0 },
    actions: { gap: theme.spacing.sm, paddingRight: theme.spacing.md },
    action: {
      borderColor: theme.color.border.default,
      borderRadius: theme.radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    actionText: { ...theme.typography.bodyStrong, color: theme.color.text.foreground },
    telemetry: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.md },
    proofActions: { flexDirection: "row", gap: theme.spacing.sm },
    telemetryText: { ...theme.typography.caption, color: theme.color.text.muted },
    instructions: { ...theme.typography.caption, color: theme.color.text.muted },
    ready: { ...theme.typography.caption, color: theme.color.status.success },
    editorFrame: {
      flex: 1,
      minHeight: 160,
      borderColor: theme.color.border.default,
      borderRadius: theme.radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
    },
    input: {
      flex: 1,
      padding: theme.spacing.md,
      ...theme.typography.body,
      color: theme.color.text.foreground,
      backgroundColor: theme.color.surface.panel,
    },
    unmounted: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: theme.spacing.lg,
      backgroundColor: theme.color.surface.panel,
    },
  });
}
