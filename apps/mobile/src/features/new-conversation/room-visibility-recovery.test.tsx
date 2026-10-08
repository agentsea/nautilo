import { beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import {
  act,
  createElement,
  forwardRef,
  type ReactNode,
  useImperativeHandle,
} from "react";
import { createRoot } from "react-dom/client";

const browser = new Window();
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

type Props = Record<string, unknown> & { children?: ReactNode };
const container = ({ children }: Props) => createElement("div", null, children);
const FlatList = forwardRef(function FlatList(
  { data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: Props,
  ref,
) {
  useImperativeHandle(ref, () => ({ scrollToOffset: () => {} }), []);
  const items = data as unknown[];
  return createElement(
    "div",
    null,
    ListHeaderComponent as ReactNode,
    ...items.map((item, index) => createElement(
      "div",
      { key: index },
      (renderItem as (input: { item: unknown }) => ReactNode)({ item }),
    )),
    items.length === 0 ? ListEmptyComponent as ReactNode : null,
    ListFooterComponent as ReactNode,
  );
});

mock.module("react-native", () => ({
  ActivityIndicator: () => createElement("span", null, "Loading"),
  FlatList,
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    children,
    disabled,
    onPress,
  }: Props) => {
    const state = accessibilityState as { checked?: boolean; selected?: boolean } | undefined;
    return createElement("button", {
      "aria-checked": state?.selected ?? state?.checked,
      "aria-label": accessibilityLabel as string | undefined,
      disabled: disabled as boolean | undefined,
      onClick: onPress as (() => void) | undefined,
      role: accessibilityRole as string | undefined,
    }, children);
  },
  StyleSheet: {
    create: <T,>(styles: T) => styles,
    hairlineWidth: 1,
  },
  Text: ({ children }: Props) => createElement("span", null, children),
  TextInput: ({ onChangeText, placeholder, value }: Props) => createElement("input", {
    "aria-label": placeholder as string,
    onInput: (event: { currentTarget: { value: string } }) => {
      (onChangeText as (next: string) => void)(event.currentTarget.value);
    },
    value: value as string,
  }),
  View: container,
}));
mock.module("react-native-keyboard-controller", () => ({ KeyboardAvoidingView: container }));
mock.module("@expo/vector-icons", () => ({
  Ionicons: ({ name }: { name: string }) => createElement("span", { "data-icon": name }),
}));

const navigation = { setOptions: () => {} };
const navigations: string[] = [];
mock.module("expo-router", () => ({
  router: { replace: (path: string) => { navigations.push(path); } },
  useLocalSearchParams: () => ({}),
  useNavigation: () => navigation,
}));

type ViewerState = "loading" | "cached" | "verified" | "stale";
let viewerState: ViewerState;
let roomDiscoverability: boolean | undefined;
const viewer = {
  userId: "viewer-a",
  capabilities: ["create_rooms", "manage_rooms"],
  get roomDiscoverability() { return roomDiscoverability; },
};
mock.module("@/providers/auth", () => ({
  useAuth: () => ({ viewer, viewerState }),
}));
mock.module("@/providers/server-registry", () => ({
  useServers: () => ({ activeServer: { id: "server-a", serverUrl: "https://test.invalid" } }),
}));

const theme = {
  color: {
    action: { primaryBg: "#06c" },
    border: { default: "#999", interactive: "#06c" },
    brand: { accent: "#06c" },
    status: { error: "#c00" },
    surface: { background: "#fff", element: "#eee", panel: "#fee", subtle: "#ddd" },
    text: { dim: "#777", disabled: "#aaa", foreground: "#111", muted: "#555", onPrimary: "#fff" },
  },
  radii: { lg: 16, md: 12, pill: 999, sm: 8 },
  spacing: { lg: 16, md: 12, sm: 8, xl: 24, xs: 4 },
  typography: { body: {}, bodyStrong: {}, caption: {}, label: {}, subheading: {} },
};
mock.module("@/providers/theme", () => ({ useAppTheme: () => theme }));

const createRequests: Array<Record<string, unknown>> = [];
const client = {
  createRoom: async (request: Record<string, unknown>) => {
    createRequests.push(request);
    return { id: "room-created" };
  },
  searchDirectory: async () => [],
};
mock.module("@/lib/api", () => ({ getApiClient: () => client }));

const { default: NewChatScreen } = await import("../../app/chat/new");

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find((node) => node.textContent?.includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function optionalButton(host: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find((node) => node.textContent?.includes(label)) ?? null;
}

async function enterNamedRoom(host: HTMLElement, name: string) {
  await act(async () => { button(host, "New room").click(); });
  const input = host.querySelector<HTMLInputElement>('input[aria-label="launch-planning"]');
  expect(input).not.toBeNull();
  await act(async () => {
    input!.value = name;
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async () => {
    await act(async () => { root.render(createElement(NewChatScreen)); });
  };
  await render();
  return {
    host,
    render,
    close: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

beforeEach(() => {
  viewerState = "verified";
  roomDiscoverability = true;
  createRequests.length = 0;
  navigations.length = 0;
});

test("preserves selected External while identity is unverified and submits it after recovery", async () => {
  const ui = await mount();
  try {
    await enterNamedRoom(ui.host, "Partner space");
    await act(async () => { button(ui.host, "External").click(); });
    expect(button(ui.host, "External").getAttribute("aria-checked")).toBe("true");
    expect(button(ui.host, "Create room").disabled).toBe(false);

    for (const transientState of ["cached", "stale"] as const) {
      viewerState = transientState;
      await ui.render();
      expect(button(ui.host, "External").getAttribute("aria-checked")).toBe("true");
      expect(ui.host.textContent).toContain("Waiting to verify External room support");
      expect(button(ui.host, "Create room").disabled).toBe(true);
      expect(createRequests).toHaveLength(0);
    }

    viewerState = "loading";
    await ui.render();
    expect(ui.host.textContent).toContain("Loading");
    expect(optionalButton(ui.host, "External")).toBeNull();
    expect(optionalButton(ui.host, "Create room")).toBeNull();
    expect(createRequests).toHaveLength(0);

    viewerState = "verified";
    await ui.render();
    expect(button(ui.host, "External").getAttribute("aria-checked")).toBe("true");
    expect(ui.host.textContent).toContain("Public access, hidden from discovery");
    expect(button(ui.host, "Create room").disabled).toBe(false);
    await act(async () => {
      button(ui.host, "Create room").click();
      await Promise.resolve();
    });

    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]).toMatchObject({
      catalogueKind: "room",
      discoverable: false,
      kind: "open",
      label: "Partner space",
    });
    expect(navigations).toEqual(["/chat/room-created"]);
  } finally {
    await ui.close();
  }
});

test("verified loss of support resets External before any request is sent", async () => {
  const ui = await mount();
  try {
    await enterNamedRoom(ui.host, "Safe fallback");
    await act(async () => { button(ui.host, "External").click(); });

    roomDiscoverability = false;
    await ui.render();
    expect(optionalButton(ui.host, "External")).toBeNull();
    expect(button(ui.host, "Private").getAttribute("aria-checked")).toBe("true");
    expect(createRequests).toHaveLength(0);

    await act(async () => {
      button(ui.host, "Create room").click();
      await Promise.resolve();
    });
    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]).toMatchObject({ kind: "private", label: "Safe fallback" });
    expect(createRequests[0]).not.toHaveProperty("discoverable");
  } finally {
    await ui.close();
  }
});

test("never offers External when the initial verified server lacks support", async () => {
  roomDiscoverability = undefined;
  const ui = await mount();
  try {
    await enterNamedRoom(ui.host, "Older server room");
    expect(optionalButton(ui.host, "External")).toBeNull();
    expect(button(ui.host, "Private").getAttribute("aria-checked")).toBe("true");
  } finally {
    await ui.close();
  }
});
