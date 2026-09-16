import { describe, expect, mock, test } from "bun:test";
import React from "react";

const pushedKey = Symbol.for("nautilo.d501.router-pushed");
const pushed = ((globalThis as unknown as { [key: symbol]: unknown[] })[pushedKey] ??= []);
mock.module("expo-router", () => ({
  router: { push: (target: unknown) => pushed.push(target) },
  useNavigation: () => ({ addListener: () => () => undefined, dispatch: () => undefined }),
}));
mock.module("react-native", () => ({
  Pressable: "button",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "span",
}));
mock.module("expo-file-system", () => ({ Directory: class {}, File: class {}, Paths: { cache: "file:///cache" } }));

const {
  ArtifactEditButton,
  ArtifactEditActionView,
  artifactEditTarget,
  artifactViewerActionButtonStyle,
  artifactViewerActionLabelStyle,
  shouldMountArtifactDiscussion,
  shouldResolveArtifactEdit,
} = await import("./artifact-viewer-routing");

describe("artifact viewer edit routing", () => {
  test("checks only loaded source on either platform", () => {
    expect(shouldResolveArtifactEdit({ resultKind: "text" })).toBe(true);
    expect(shouldResolveArtifactEdit({ resultKind: "unsupported" })).toBe(false);
    expect(shouldResolveArtifactEdit({ resultKind: "file" })).toBe(false);
    expect(shouldResolveArtifactEdit({ resultKind: "other" })).toBe(false);
  });

  test("builds one typed ID-only target and the button dispatches it", () => {
    pushed.length = 0;
    expect(artifactEditTarget("artifact-1")).toEqual({
      pathname: "/files/artifact/edit/[id]",
      params: { id: "artifact-1" },
    });
    expect(artifactEditTarget("artifact-1", "room-1")).toEqual({
      pathname: "/files/artifact/edit/[id]",
      params: { id: "artifact-1", roomId: "room-1" },
    });
    const element = ArtifactEditButton({ artifactId: "artifact-1", roomId: "room-1" }) as React.ReactElement<{ onPress: () => void }>;
    element.props.onPress();
    expect(pushed).toEqual([artifactEditTarget("artifact-1", "room-1")]);
    expect(JSON.stringify(pushed[0])).not.toContain("content");
    expect(JSON.stringify(pushed[0])).not.toContain("canWrite");
    expect(element.props).toMatchObject({ accessibilityRole: "button", accessibilityLabel: "Edit file" });
  });

  test("the presentation component omits refused/loading state and renders ready admission", () => {
    expect(ArtifactEditActionView({})).toBeNull();
    const ready = ArtifactEditActionView({
      ready: { artifactId: "artifact-2", admission: { kind: "source", format: "text", content: "ready" } },
    });
    expect(React.isValidElement(ready)).toBe(true);
  });

  test("shares one compact appearance contract across viewer actions", () => {
    const appearance = {
      backgroundColor: "surface",
      borderColor: "border",
      textColor: "accent",
    };
    expect(artifactViewerActionButtonStyle(appearance, false)).toEqual([
      {
        minWidth: 64,
        minHeight: 36,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 16,
        borderWidth: 1,
        borderRadius: 999,
      },
      { backgroundColor: "surface", borderColor: "border" },
      false,
    ]);
    expect(artifactViewerActionButtonStyle(appearance, true).at(-1)).toEqual({ opacity: 0.72 });
    expect(artifactViewerActionLabelStyle(appearance)).toEqual([
      { fontSize: 15, fontWeight: "600", lineHeight: 20 },
      { color: "accent" },
    ]);
  });

  test("keeps the chat controller boundary absent until Discuss resolves a room", () => {
    expect(shouldMountArtifactDiscussion(true)).toBe(false);
    expect(shouldMountArtifactDiscussion(true, "")).toBe(false);
    expect(shouldMountArtifactDiscussion(false, "room-1")).toBe(false);
    expect(shouldMountArtifactDiscussion(true, "room-1")).toBe(true);
  });
});
