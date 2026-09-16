import { describe, expect, mock, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const pushedKey = Symbol.for("nautilo.d501.router-pushed");
const pushed = ((globalThis as unknown as { [key: symbol]: unknown[] })[
  pushedKey
] ??= []);
mock.module("expo-router", () => ({
  router: { push: (target: unknown) => pushed.push(target) },
  useNavigation: () => ({
    addListener: () => () => undefined,
    dispatch: () => undefined,
  }),
}));
mock.module("@/components/app-bar", () => ({
  AppBar: ({
    title,
    left,
    rightExtra,
    showOverflow,
  }: {
    title: string;
    left?: React.ReactNode;
    rightExtra?: React.ReactNode;
    showOverflow?: boolean;
  }) => (
    <header data-overflow={String(showOverflow)}>
      {left}
      <span>{title}</span>
      {rightExtra}
    </header>
  ),
  AppBarBackButton: ({ onPress: _onPress }: { onPress: () => void }) => (
    <button>Back</button>
  ),
}));
mock.module("react-native", () => ({
  ActivityIndicator: "activity-indicator",
  Alert: { alert: () => undefined },
  Button: ({ title }: { title: string }) => <button>{title}</button>,
  Keyboard: { dismiss: () => undefined },
  Pressable: ({
    children,
    accessibilityLabel,
    disabled,
    style,
  }: {
    children?: React.ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    style?: React.CSSProperties;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} style={style}>
      {children}
    </button>
  ),
  StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
  ScrollView: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Text: ({
    children,
    style,
  }: {
    children?: React.ReactNode;
    style?: React.CSSProperties;
  }) => <span style={style}>{children}</span>,
  TextInput: "input",
  View: ({
    children,
    accessibilityLabel,
    accessibilityRole,
    style,
  }: {
    children?: React.ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    style?: React.CSSProperties;
  }) => (
    <div aria-label={accessibilityLabel} role={accessibilityRole} style={style}>
      {children}
    </div>
  ),
}));
mock.module("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({
    children,
    behavior,
  }: {
    children?: React.ReactNode;
    behavior?: string;
  }) => <section data-keyboard-behavior={behavior}>{children}</section>,
}));
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 12, left: 0 }),
}));
mock.module("@/providers/theme", () => ({
  useAppTheme: () => ({
    color: {
      surface: { background: "white" },
      brand: { accent: "blue" },
      text: { muted: "gray", foreground: "black" },
      border: { default: "silver" },
    },
    spacing: { md: 8, lg: 12, xl: 16 },
    typography: { body: {}, label: {} },
    radii: { md: 6 },
  }),
}));

const { ArtifactEditorShell } = await import("./artifact-editor-shell");

describe("ArtifactEditorShell presentation", () => {
  test("wires native beforeRemove and the visible AppBar back control through the same dirty exit coordinator", async () => {
    const source = await Bun.file(
      new URL("./artifact-editor-shell.tsx", import.meta.url),
    ).text();
    expect(source).toMatch(/navigation\.addListener\(\s*"beforeRemove"/);
    expect(source).toContain("exitCoordinatorRef.current.intercept(");
    expect(source).toMatch(/preventDefault: \(\) => event\.preventDefault\(\),\s*action: event\.data\.action/);
    expect(source).toMatch(/\(action\) => navigation\.dispatch\(action as typeof event\.data\.action\)/);
    expect(source).toMatch(/<AppBarBackButton\s+onPress=\{\(\) => requestExit\(onBack\)\}/);
    expect(source).not.toContain("<AppBarBackButton onPress={onBack}");
  });

  test("keeps save truth above the editor and the optional toolbar directly above the keyboard", () => {
    const markup = renderToStaticMarkup(
      <ArtifactEditorShell
        title="Draft.md"
        sessionKey="a:1"
        phase={{ kind: "ready" }}
        onBack={() => undefined}
        toolbar={<span>Toolbar slot</span>}
      >
        {({ dirty, markDirty: _markDirty }) => (
          <span>Editor slot {String(dirty)}</span>
        )}
      </ArtifactEditorShell>,
    );
    expect(markup).toContain('data-overflow="false"');
    expect(markup).toContain('data-keyboard-behavior="padding"');
    expect(markup.indexOf("Draft.md")).toBeLessThan(
      markup.indexOf("Editor slot"),
    );
    expect(markup.indexOf("Editor slot")).toBeLessThan(
      markup.indexOf("Toolbar slot"),
    );
    expect(markup).toContain("padding-bottom:12px");
    expect(markup).toContain('aria-label="Editor toolbar"');
    expect(markup).toContain('aria-label="Editor"');
  });

  test("shell and native source editor keep one scroll owner with a flex/minHeight chain", async () => {
    const shell = await Bun.file(
      new URL("./artifact-editor-shell.tsx", import.meta.url),
    ).text();
    const source = await Bun.file(
      new URL("./native-source-editor.tsx", import.meta.url),
    ).text();
    const markdown = await Bun.file(
      new URL("./artifact-markdown-preview.tsx", import.meta.url),
    ).text();
    expect(shell).toMatch(/root:\s*\{\s*flex: 1,\s*minHeight: 0/);
    expect(shell).toContain("frame: { flex: 1, minHeight: 0 }");
    expect(shell).toMatch(/<KeyboardAvoidingView\s+behavior="padding"\s+style=\{styles\.root\}>/);
    expect(source).toContain("root: { flex: 1, minHeight: 0 }");
    expect(source).toContain("input: { flex: 1, minHeight: 0");
    expect(source).toContain("preview: { flex: 1, minHeight: 0 }");
    expect(source).toContain("scrollEnabled");
    expect((source.match(/<ScrollView/g) ?? []).length).toBe(1);
    expect(markdown).not.toContain("ScrollView");
  });

  test("omits the toolbar when absent and keeps Save disabled in Task 1.2", () => {
    const markup = renderToStaticMarkup(
      <ArtifactEditorShell
        title="Draft"
        sessionKey="a:1"
        phase={{ kind: "ready" }}
        onBack={() => undefined}
      >
        <span>Editor</span>
      </ArtifactEditorShell>,
    );
    expect(markup).not.toContain("Editor toolbar");
    expect(markup).toContain('aria-label="Save file"');
    expect(markup).toContain('disabled=""');
  });

  test("owns loading and retryable error states without mounting editor content", () => {
    const loading = renderToStaticMarkup(
      <ArtifactEditorShell
        title="Edit file"
        sessionKey="load"
        phase={{ kind: "loading" }}
        onBack={() => undefined}
      >
        <span>Must not mount</span>
      </ArtifactEditorShell>,
    );
    expect(loading).toContain("Loading file…");
    expect(loading).not.toContain("Must not mount");

    const error = renderToStaticMarkup(
      <ArtifactEditorShell
        title="Edit file"
        sessionKey="error"
        phase={{
          kind: "error",
          message: "Network unavailable",
          onRetry: () => undefined,
        }}
        onBack={() => undefined}
      />,
    );
    expect(error).toContain("Network unavailable");
    expect(error).toContain("Retry");
    expect(error).toContain('aria-label="Retry loading file"');
  });

  test("keeps the ready editor mounted with an accessible retryable save notice", () => {
    const markup = renderToStaticMarkup(
      <ArtifactEditorShell
        title="Draft"
        sessionKey="save:1"
        phase={{ kind: "ready" }}
        saveNotice={{
          message: "Could not confirm the save. Your edits are preserved.",
          onRetry: () => undefined,
        }}
        onBack={() => undefined}
      >
        <span>Unsaved source remains mounted</span>
      </ArtifactEditorShell>,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Save status"');
    expect(markup).toContain('aria-label="Retry save"');
    expect(markup).toContain("Unsaved source remains mounted");
  });

  test("renders accessible conflict recovery actions without replacing the editor", () => {
    const markup = renderToStaticMarkup(
      <ArtifactEditorShell
        title="Draft"
        sessionKey="conflict:1"
        phase={{ kind: "ready" }}
        saveState="unavailable"
        saveNotice={{
          message: "This file changed elsewhere. Your edits are preserved.",
          actions: [
            { label: "Reload latest", onPress: () => undefined },
            { label: "Copy changes", onPress: () => undefined },
            { label: "Keep editing", onPress: () => undefined },
          ],
        }}
        onBack={() => undefined}
      >
        <span>Local conflicting source</span>
      </ArtifactEditorShell>,
    );
    expect(markup).toContain('aria-label="Reload latest"');
    expect(markup).toContain('aria-label="Copy changes"');
    expect(markup).toContain('aria-label="Keep editing"');
    expect(markup).toContain("Local conflicting source");
  });
});
