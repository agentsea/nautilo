import { useMemo, useRef, useState, type RefObject } from "react";
import {
  Keyboard,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

import {
  createNativeSourceBuffer,
  insertMarkdownLink,
  isSupportedMarkdownHref,
  setMarkdownBlockPrefix,
  updateNativeSourceBuffer,
  wrapMarkdown,
  type NativeSelection,
  type NativeSourceBuffer,
} from "./native-source-buffer";
import { ArtifactMarkdownPreview } from "./artifact-markdown-preview";
import {
  ArtifactFormatToolbar,
  type ArtifactFormatToolbarAction,
} from "./artifact-format-toolbar";

type SourceEdit = { value: string; selection: NativeSelection };

export type NativeSourceEditorSession = {
  buffer: RefObject<NativeSourceBuffer>;
  input: RefObject<TextInput | null>;
  preview: boolean;
  setPreview: (preview: boolean) => void;
  refresh: () => void;
};

export function useNativeSourceEditorSession(
  content: string,
): NativeSourceEditorSession {
  const buffer = useRef(createNativeSourceBuffer(content));
  const input = useRef<TextInput>(null);
  const [preview, setPreview] = useState(false);
  const [, setRevision] = useState(0);
  return {
    buffer,
    input,
    preview,
    setPreview,
    refresh: () => setRevision((current) => current + 1),
  };
}

/** Install an explicitly reloaded canonical source without synthesizing history. */
export function replaceNativeSourceDocument(
  session: NativeSourceEditorSession,
  content: string,
): void {
  session.buffer.current.baseline = content;
  session.buffer.current.current = content;
  session.buffer.current.selection = { start: 0, end: 0 };
  session.input.current?.setNativeProps({ text: content });
  requestAnimationFrame(() => {
    session.input.current?.setNativeProps({ selection: { start: 0, end: 0 } });
  });
  session.refresh();
}

function applySourceEdit(
  session: NativeSourceEditorSession,
  next: SourceEdit,
  onDirtyChange: (dirty: boolean) => void,
) {
  session.buffer.current.current = next.value;
  session.buffer.current.selection = next.selection;
  session.input.current?.setNativeProps({ text: next.value });
  requestAnimationFrame(() => {
    session.input.current?.setNativeProps({ selection: next.selection });
    session.input.current?.focus();
  });
  onDirtyChange(next.value !== session.buffer.current.baseline);
  session.refresh();
}

export function NativeSourceToolbar({
  session,
  onDirtyChange,
}: {
  session: NativeSourceEditorSession;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const apply = (next: SourceEdit) =>
    applySourceEdit(session, next, onDirtyChange);
  const formatWith = (marker: string) =>
    apply(
      wrapMarkdown(
        session.buffer.current.current,
        session.buffer.current.selection,
        marker,
      ),
    );
  const togglePreview = () => {
    if (session.preview) {
      session.setPreview(false);
      requestAnimationFrame(() => session.input.current?.focus());
      return;
    }
    Keyboard.dismiss();
    session.setPreview(true);
  };

  const primaryActions: readonly ArtifactFormatToolbarAction[] = [
    {
      id: "bold",
      label: "Bold",
      glyph: "B",
      disabled: session.preview,
      onPress: () => formatWith("**"),
    },
    {
      id: "italic",
      label: "Italic",
      glyph: "I",
      disabled: session.preview,
      onPress: () => formatWith("_"),
    },
  ];
  const afterLinkActions: readonly ArtifactFormatToolbarAction[] = [
    {
      id: "preview",
      label: session.preview ? "Edit" : "Preview",
      icon: session.preview ? "create-outline" : "eye-outline",
      selected: session.preview,
      onPress: togglePreview,
    },
  ];

  return (
    <ArtifactFormatToolbar
      accessibilityLabel="Markdown formatting"
      primaryActions={primaryActions}
      afterLinkActions={afterLinkActions}
      link={{
        label: "Add link",
        disabled: session.preview,
        hint: session.preview
          ? "Return to source editing to add a link"
          : "Add a Markdown link at the native selection",
        validate: isSupportedMarkdownHref,
        invalidMessage: "Use an http(s) or mailto URL without spaces.",
        onSubmit: (href) =>
          apply(
            insertMarkdownLink(
              session.buffer.current.current,
              session.buffer.current.selection,
              href,
            ),
          ),
      }}
      formatSheet={{
        label: "Format",
        icon: "ellipsis-horizontal",
        title: "Block formatting",
        actions: [
          {
            id: "paragraph",
            label: "Paragraph",
            glyph: "¶",
            onPress: () =>
              apply(
                setMarkdownBlockPrefix(
                  session.buffer.current.current,
                  session.buffer.current.selection,
                  "",
                ),
              ),
            disabled: session.preview,
          },
          {
            id: "heading-1",
            label: "Heading 1",
            glyph: "H1",
            onPress: () =>
              apply(
                setMarkdownBlockPrefix(
                  session.buffer.current.current,
                  session.buffer.current.selection,
                  "# ",
                ),
              ),
            disabled: session.preview,
          },
          {
            id: "heading-2",
            label: "Heading 2",
            glyph: "H2",
            onPress: () =>
              apply(
                setMarkdownBlockPrefix(
                  session.buffer.current.current,
                  session.buffer.current.selection,
                  "## ",
                ),
              ),
            disabled: session.preview,
          },
          {
            id: "heading-3",
            label: "Heading 3",
            glyph: "H3",
            onPress: () =>
              apply(
                setMarkdownBlockPrefix(
                  session.buffer.current.current,
                  session.buffer.current.selection,
                  "### ",
                ),
              ),
            disabled: session.preview,
          },
          {
            id: "unordered-list",
            label: "Bulleted list",
            glyph: "•",
            onPress: () =>
              apply(
                setMarkdownBlockPrefix(
                  session.buffer.current.current,
                  session.buffer.current.selection,
                  "- ",
                ),
              ),
            disabled: session.preview,
          },
          {
            id: "ordered-list",
            label: "Numbered list",
            glyph: "1.",
            onPress: () =>
              apply(
                setMarkdownBlockPrefix(
                  session.buffer.current.current,
                  session.buffer.current.selection,
                  "1. ",
                ),
              ),
            disabled: session.preview,
          },
        ],
      }}
      onReturnToEditor={() => session.input.current?.focus()}
    />
  );
}

export function NativeSourceEditor({
  content,
  session,
  onDirtyChange,
}: {
  content: string;
  session: NativeSourceEditorSession;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const theme = useAppTheme();
  const sourceStyles = useMemo(() => createSourceStyles(theme), [theme]);

  return (
    <View style={styles.root}>
      <TextInput
        ref={session.input}
        multiline
        scrollEnabled
        selectionColor={theme.color.brand.accent}
        defaultValue={content}
        style={[
          styles.input,
          sourceStyles.surface,
          session.preview ? styles.hidden : undefined,
        ]}
        textAlignVertical="top"
        onChangeText={(text) =>
          onDirtyChange(updateNativeSourceBuffer(session.buffer.current, text))
        }
        onSelectionChange={(event) => {
          session.buffer.current.selection = event.nativeEvent.selection;
        }}
        accessibilityLabel="File source editor"
      />
      {session.preview ? (
        <ScrollView
          style={styles.preview}
          contentContainerStyle={styles.previewContent}
        >
          <ArtifactMarkdownPreview source={session.buffer.current.current} />
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  input: { flex: 1, minHeight: 0, textAlignVertical: "top" },
  hidden: { display: "none" },
  preview: { flex: 1, minHeight: 0 },
  previewContent: { padding: 16 },
});

function createSourceStyles(theme: AppTheme) {
  return StyleSheet.create({
    surface: {
      ...theme.typography.body,
      color: theme.color.text.foreground,
      backgroundColor: theme.color.surface.element,
      borderColor: theme.color.border.default,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: theme.radii.md,
      marginHorizontal: theme.spacing.md,
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.xl,
    },
  });
}
