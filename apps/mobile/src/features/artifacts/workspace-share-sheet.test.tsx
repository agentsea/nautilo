import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const browser = new Window();
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true });
type Props = Record<string, unknown> & { children?: ReactNode };
const container = ({ children }: Props) => createElement("div", null, children);
mock.module("react-native", () => ({
  Modal: container, View: container, ScrollView: container,
  Text: ({ children }: Props) => createElement("span", null, children),
  ActivityIndicator: () => createElement("span", null, "Loading people"),
  FlatList: ({ data, renderItem, ListEmptyComponent }: Props) => createElement("div", null,
    (data as unknown[]).length ? (data as unknown[]).map((item, index) => createElement("div", { key: index }, (renderItem as (input: { item: unknown }) => ReactNode)({ item }))) : ListEmptyComponent as ReactNode),
  StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
  Pressable: ({ children, accessibilityLabel, disabled, onPress }: Props) => createElement("button", {
    "aria-label": accessibilityLabel as string, disabled: disabled as boolean, onClick: onPress as () => void,
  }, children),
  TextInput: ({ accessibilityLabel, value, onChangeText }: Props) => createElement("input", {
    "aria-label": accessibilityLabel as string, value: value as string,
    onChange: (event: { target: { value: string } }) => (onChangeText as (value: string) => void)(event.target.value),
  }),
}));
mock.module("react-native-keyboard-controller", () => ({ KeyboardAvoidingView: container }));
mock.module("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
mock.module("@/providers/theme", () => ({ useAppTheme: () => ({
  color: { status: { error: "" }, surface: { overlay: "", panel: "" }, text: { foreground: "", muted: "", dim: "", onPrimary: "" }, brand: { accent: "" }, border: { default: "", interactive: "" }, action: { primaryBg: "" } },
  spacing: { sm: 8, md: 12, lg: 16 }, radii: { md: 8, lg: 16 }, typography: { subheading: {}, caption: {}, body: {}, label: {} },
}) }));
let fail = true;
const recipients: string[] = [];
const client = {
  searchDirectory: async () => [
    { id: "viewer", kind: "user", actionable: true, displayName: "Self", handle: "self" },
    { id: "mara", kind: "user", actionable: true, displayName: "Mara", handle: "mara" },
    { id: "jun", kind: "user", actionable: true, displayName: "Jun", handle: "jun" },
  ],
  shareWorkspaceArtifact: async (_file: string, recipient: string) => {
    recipients.push(recipient);
    if (recipient === "jun" && fail) throw Error("private server details must not render");
    return { status: "shared" as const };
  },
};
mock.module("@/lib/api", () => ({ getApiClient: () => client }));
const { WorkspaceShareSheet } = await import("./workspace-share-sheet");

test("mounted sharing UI renders partial receipt, retries failures only, and updates success", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let closed = false;
  const button = (label: string): HTMLButtonElement => {
    const found = Array.from(host.querySelectorAll("button")).find(node => (node.getAttribute("aria-label") || node.textContent) === label);
    expect(found).toBeDefined();
    return found as HTMLButtonElement;
  };
  try {
    await act(async () => { root.render(createElement(WorkspaceShareSheet, {
      embedded: true, serverUrl: "https://test.invalid", artifactId: "file", path: "fixture.md", roomId: "origin", viewerId: "viewer", isCurrent: () => true, onClose: () => { closed = true; },
    })); });
    expect(host.textContent).toContain("Adds the same file to their workspace, not a separate copy.");
    expect(host.textContent).not.toContain("Shared with me");
    expect(host.textContent).not.toContain("Self");
    expect(button("Add to workspaces").disabled).toBe(true);
    await act(async () => { button("Mara").click(); });
    await act(async () => { button("Jun").click(); });
    await act(async () => { button("Add to workspaces").click(); });
    expect(host.textContent).toContain("1 of 2 shared");
    expect(host.textContent).not.toContain("private server details");
    fail = false;
    await act(async () => { button("Retry failed deliveries").click(); });
    expect(host.textContent).toContain("2 of 2 shared");
    expect(host.textContent).not.toContain("Retry failed deliveries");
    expect(recipients).toEqual(["mara", "jun", "jun"]);
    await act(async () => { button("Done").click(); });
    expect(closed).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
