import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

mock.module("react-native", () => ({
  Keyboard: { dismiss: () => undefined },
  Modal: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
  Pressable: ({
    children,
    accessibilityLabel,
    disabled,
  }: Record<string, unknown>) =>
    createElement(
      "button",
      { "aria-label": accessibilityLabel, disabled },
      children as never,
    ),
  ScrollView: ({ children, ...props }: Record<string, unknown>) =>
    createElement("div", props, children as never),
  StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
  Text: ({ children, ...props }: Record<string, unknown>) =>
    createElement("span", props, children as never),
  TextInput: ({
    accessibilityLabel,
    defaultValue,
  }: {
    accessibilityLabel?: string;
    defaultValue?: string;
  }) =>
    createElement("input", {
      "aria-label": accessibilityLabel,
      defaultValue,
      "data-native-source": "true",
    }),
  View: ({ children, accessibilityLabel, ...props }: Record<string, unknown>) =>
    createElement(
      "div",
      { ...props, "aria-label": accessibilityLabel },
      children as never,
    ),
}));
mock.module("@expo/vector-icons", () => ({
  Ionicons: Object.assign(
    ({ name }: { name: string }) => createElement("i", null, name),
    { glyphMap: {} },
  ),
}));
mock.module("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children, ...props }: Record<string, unknown>) =>
    createElement("div", props, children as never),
}));
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
mock.module("@/providers/theme", () => ({
  useAppTheme: () => ({
    color: {
      brand: { accent: "#0" },
      border: { default: "#1", interactive: "#2", strong: "#3" },
      surface: { panel: "#4", element: "#5", overlay: "#6" },
      text: { foreground: "#7", onPrimary: "#8", dim: "#9" },
      action: { primaryBg: "#a" },
      status: { error: "#b" },
    },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
    radii: { sm: 8, md: 12, lg: 16, pill: 999 },
    typography: { subheading: {}, body: {}, label: {}, caption: {} },
  }),
}));
mock.module("./artifact-format-toolbar", () => ({
  ArtifactFormatToolbar: ({
    accessibilityLabel,
    primaryActions,
    afterLinkActions,
    link,
    formatSheet,
  }: {
    accessibilityLabel: string;
    primaryActions: Array<{ label: string }>;
    afterLinkActions?: Array<{ label: string }>;
    link?: { label: string };
    formatSheet?: { label: string };
  }) =>
    createElement(
      "div",
      { "aria-label": accessibilityLabel },
      [...primaryActions, ...(afterLinkActions ?? [])]
        .map((action) => action.label)
        .join(" "),
      ` ${link?.label ?? ""} ${formatSheet?.label ?? ""}`,
    ),
}));
mock.module("react-native-markdown-display", () => ({
  default: ({ children }: { children: string }) =>
    createElement("article", null, children),
}));
mock.module("./artifact-markdown-preview", () => ({
  ArtifactMarkdownPreview: ({ source }: { source: string }) =>
    createElement("article", { "aria-label": "Markdown preview" }, source),
}));

const {
  NativeSourceEditor,
  NativeSourceToolbar,
  replaceNativeSourceDocument,
  useNativeSourceEditorSession,
} = await import("./native-source-editor");

function TestEditor({ format }: { format: "markdown" | "text" }) {
  const content = format === "markdown" ? "# title" : "plain";
  const session = useNativeSourceEditorSession(content);
  return createElement(
    "section",
    null,
    createElement(NativeSourceEditor, {
      content,
      session,
      onDirtyChange: () => undefined,
    }),
    format === "markdown"
      ? createElement(NativeSourceToolbar, {
          session,
          onDirtyChange: () => undefined,
        })
      : null,
  );
}

describe("NativeSourceEditor structural native-source contract", () => {
  test("is uncontrolled, exposes the source input, and keeps Markdown controls out of plain text", () => {
    const markdown = renderToStaticMarkup(
      createElement(TestEditor, { format: "markdown" }),
    );
    expect(markdown).toContain("Bold");
    expect(markdown).toContain("Add link");
    expect(markdown).toContain("Preview");
    expect(markdown).toContain("File source editor");
    const plain = renderToStaticMarkup(
      createElement(TestEditor, { format: "text" }),
    );
    expect(plain).not.toContain("Bold");
    expect(plain).not.toContain("Preview");
    expect(plain).toContain('data-native-source="true"');
  });

  test("declares native selection/change callbacks and hides rather than conditionally removes the input for preview", async () => {
    const source = await Bun.file(
      new URL("./native-source-editor.tsx", import.meta.url),
    ).text();
    expect(source).toContain("onChangeText");
    expect(source).toContain("onSelectionChange");
    expect(source).toContain("defaultValue={content}");
    expect(source).toContain("selectionColor={theme.color.brand.accent}");
    expect(source).toContain("sourceStyles.surface");
    expect(source).toContain("marginHorizontal: theme.spacing.md");
    expect(source).toContain("borderWidth: StyleSheet.hairlineWidth");
    expect(source).toContain("paddingTop: theme.spacing.md");
    expect(source).not.toContain("value={");
    expect(source).toContain("session.preview ? styles.hidden : undefined");
    expect(source).toContain(
      "requestAnimationFrame(() => session.input.current?.focus())",
    );
    expect(source).toContain('textAlignVertical="top"');
    expect(source).toContain("setNativeProps({ text: next.value })");
    expect(source).toContain("setNativeProps({ selection: next.selection })");
    expect(source).toContain(
      "onDirtyChange(next.value !== session.buffer.current.baseline)",
    );
    expect(source).toContain("Keyboard.dismiss()");
    expect(source).toContain("disabled: session.preview");
    expect(source).toContain('glyph: "•"');
    expect(source).toContain('glyph: "1."');
    expect(source).toContain("onReturnToEditor={() => session.input.current?.focus()}");
    expect((source.match(/<TextInput\n/g) ?? []).length).toBe(1);
    expect((source.match(/<ScrollView/g) ?? []).length).toBe(1);
  });

  test("explicit latest replacement resets source and selection without focusing", () => {
    const nativeCalls: unknown[] = [];
    const session = {
      buffer: {
        current: {
          baseline: "old",
          current: "local",
          selection: { start: 5, end: 5 },
        },
      },
      input: {
        current: {
          setNativeProps: (value: unknown) => nativeCalls.push(value),
        },
      },
      preview: false,
      setPreview: () => undefined,
      refresh: () => undefined,
    } as unknown as Parameters<typeof replaceNativeSourceDocument>[0];
    const queued: Array<() => void> = [];
    const original = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: () => void) => {
      queued.push(callback);
      return 1;
    }) as typeof requestAnimationFrame;
    try {
      replaceNativeSourceDocument(session, "latest 🫖\nsource");
      queued.forEach((callback) => callback());
    } finally {
      globalThis.requestAnimationFrame = original;
    }
    expect(session.buffer.current).toEqual({
      baseline: "latest 🫖\nsource",
      current: "latest 🫖\nsource",
      selection: { start: 0, end: 0 },
    });
    expect(nativeCalls).toEqual([
      { text: "latest 🫖\nsource" },
      { selection: { start: 0, end: 0 } },
    ]);
  });
});
