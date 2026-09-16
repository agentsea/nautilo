import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "../..");

type KeyboardOwner = "screen" | "controller" | "list" | "bottom-sheet" | "embedded" | "web-readonly";

// Every production TSX module that renders an editable native input must name
// the surface that owns keyboard resizing. This inventory is deliberately
// exhaustive: adding a new input without adding (and reviewing) its owner
// fails this release gate.
const auditedInputs: Readonly<Record<string, KeyboardOwner>> = {
  "app/(drawer)/(tabs)/files.tsx": "list",
  "app/(drawer)/(tabs)/index.tsx": "list",
  "app/(drawer)/(tabs)/memory.tsx": "list",
  "app/(drawer)/(tabs)/settings/agent-photos.tsx": "screen",
  "app/(drawer)/(tabs)/settings/commands/[name].tsx": "screen",
  "app/(drawer)/(tabs)/settings/commands/index.tsx": "screen",
  "app/(drawer)/(tabs)/settings/commands/new.tsx": "screen",
  "app/(drawer)/(tabs)/settings/human-profile.tsx": "screen",
  "app/(drawer)/(tabs)/settings/profile.tsx": "screen",
  "app/(drawer)/(tabs)/settings/security.tsx": "screen",
  "app/(drawer)/(tabs)/settings/skills/[name].tsx": "screen",
  "app/(drawer)/(tabs)/settings/skills/index.tsx": "screen",
  "app/(drawer)/(tabs)/settings/voice-picker.tsx": "screen",
  "app/(drawer)/computers/index.tsx": "controller",
  "app/(drawer)/computers/manual.tsx": "screen",
  "app/(onboarding)/add-server.tsx": "screen",
  "app/(onboarding)/add-server.web.tsx": "screen",
  "app/(onboarding)/invite.tsx": "screen",
  "app/(onboarding)/qualification/markdown-source.tsx": "controller",
  "app/chat/[roomId].tsx": "controller",
  "app/chat/new.tsx": "controller",
  "app/files/computer/[remoteHostId]/[rootKind].tsx": "list",
  "app/memory/[id].tsx": "controller",
  "app/search/chats.tsx": "list",
  "components/agent-focus-bar.tsx": "bottom-sheet",
  "components/composer.tsx": "embedded",
  "components/crypto-device-admission-boundary.tsx": "controller",
  "components/chat-rename-sheet.tsx": "controller",
  "components/emoji-picker-sheet.tsx": "bottom-sheet",
  "components/members-sheet.tsx": "bottom-sheet",
  "components/message-edit-sheet.tsx": "controller",
  "components/model-switcher-sheet.tsx": "bottom-sheet",
  "components/pin-modal.tsx": "controller",
  "components/report-content-sheet.tsx": "bottom-sheet",
  "components/settings/settings-picker-screen.tsx": "screen",
  "components/shared-browser-viewer-pdf-qualification.web.tsx": "web-readonly",
  "features/artifacts/artifact-format-toolbar.tsx": "controller",
  "features/artifacts/artifact-viewer-actions-sheet.tsx": "controller",
  "features/artifacts/native-source-editor.tsx": "embedded",
  "features/artifacts/workspace-share-sheet.tsx": "embedded",
  "features/memory-management/manage-access-sheet.tsx": "controller",
  "features/room-chat-pane/ask-user-picker.tsx": "bottom-sheet",
  "features/settings/password-form.tsx": "embedded",
  "features/settings/pin-form.tsx": "embedded",
  "features/settings/soul-editor-sheet.tsx": "controller",
};

const embeddedOwners: Readonly<Record<string, readonly string[]>> = {
  "components/composer.tsx": [
    "app/chat/[roomId].tsx",
    "app/files/artifact/[id].tsx",
  ],
  "features/artifacts/native-source-editor.tsx": [
    "features/artifacts/artifact-editor-shell.tsx",
  ],
  "features/artifacts/workspace-share-sheet.tsx": [
    "features/artifacts/artifact-viewer-actions-sheet.tsx",
  ],
  "features/settings/password-form.tsx": [
    "app/(drawer)/(tabs)/settings/security.tsx",
  ],
  "features/settings/pin-form.tsx": [
    "app/(drawer)/(tabs)/settings/security.tsx",
  ],
};

function productionTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionTsxFiles(absolute);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [absolute];
  });
}

function filesRenderingInputs(): string[] {
  return productionTsxFiles(sourceRoot)
    .filter((file) => /<(?:[A-Za-z]+)?TextInput\b/.test(readFileSync(file, "utf8")))
    .map((file) => relative(sourceRoot, file))
    .sort();
}

describe("mobile keyboard surface contract", () => {
  test("every native text-entry surface has an audited keyboard owner", () => {
    expect(filesRenderingInputs()).toEqual(Object.keys(auditedInputs).sort());
  });

  test("audited owners use the approved cross-platform primitives", () => {
    for (const [path, owner] of Object.entries(auditedInputs)) {
      const source = readFileSync(resolve(sourceRoot, path), "utf8");
      if (owner === "screen") {
        expect(source, path).toContain("<Screen");
        expect(source, path).not.toContain("<Screen scroll={false}");
      } else if (owner === "controller") {
        expect(source, path).toContain(
          'import { KeyboardAvoidingView } from "react-native-keyboard-controller"',
        );
        expect(source, path).toContain("<KeyboardAvoidingView");
      } else if (owner === "list") {
        expect(source, path).toMatch(/<(?:FlatList|ScrollView)/);
      } else if (owner === "bottom-sheet") {
        expect(source, path).toContain("<BottomSheetTextInput");
        expect(source, path).toMatch(/<BottomSheet(?:ScrollView|FlatList)|<BottomSheet[\s\S]*?scrollable/);
      } else if (owner === "embedded") {
        const parents = embeddedOwners[path];
        expect(parents, `${path} must identify its keyboard-owning parent`).toBeDefined();
        for (const parent of parents ?? []) {
          const parentSource = readFileSync(resolve(sourceRoot, parent), "utf8");
          expect(parentSource, `${path} parent ${parent}`).toMatch(
            /<(?:Screen|KeyboardAvoidingView|KeyboardStickyView)/,
          );
          if (parentSource.includes("<KeyboardAvoidingView")) {
            expect(parentSource, `${path} parent ${parent}`).toContain(
              'from "react-native-keyboard-controller"',
            );
          }
          if (parentSource.includes("<KeyboardStickyView")) {
            expect(parentSource, `${path} parent ${parent}`).toContain(
              'import { KeyboardStickyView } from "react-native-keyboard-controller"',
            );
          }
        }
      } else if (owner === "web-readonly") {
        expect(path, `${path} must remain an explicit Web projection`).toEndWith(".web.tsx");
        expect(source, path).toContain("editable={false}");
      }
    }
  });

  test("bottom sheets keep their declared keyboard-safe height", () => {
    const source = readFileSync(resolve(sourceRoot, "components/bottom-sheet.tsx"), "utf8");
    expect(source).toContain('keyboardBehavior="interactive"');
    expect(source).toContain('android_keyboardInputMode="adjustResize"');
    expect(source).toContain("enableDynamicSizing={false}");
  });

  test("chat rename is a compact, keyboard-aware modal rather than a fixed bottom sheet", () => {
    const source = readFileSync(resolve(sourceRoot, "components/chat-rename-sheet.tsx"), "utf8");

    expect(source).toContain("<Modal");
    expect(source).toContain("transparent");
    expect(source).toContain('<KeyboardAvoidingView behavior="padding" style={styles.modalRoot}>');
    expect(source).toContain("accessibilityViewIsModal");
    expect(source).toContain("style={styles.backdrop}");
    expect(source).toContain("onPress={saving ? undefined : onClose}");
    expect(source).toContain("onPress={(event) => event.stopPropagation()}");
    expect(source.match(/accessible=\{false\}/g)?.length).toBe(2);
    expect(source).toContain('importantForAccessibility="yes"');
    expect(source).toContain("<ScrollView");
    expect(source).toContain("maxHeight: \"100%\"");
    expect(source).toContain("formBody: { flexShrink: 1 }");
    expect(source).not.toContain("BottomSheet");
    expect(source).not.toContain('"46%"');

    const formEnd = source.indexOf("</ScrollView>");
    const actionRow = source.indexOf("<View style={styles.actions}>");
    expect(formEnd).toBeGreaterThan(-1);
    expect(actionRow).toBeGreaterThan(formEnd);
  });

  test("Android asks the OS to resize the app window for its keyboard", () => {
    const appConfig = JSON.parse(
      readFileSync(resolve(sourceRoot, "../app.json"), "utf8"),
    ) as { expo?: { android?: { softwareKeyboardLayoutMode?: string } } };
    expect(appConfig.expo?.android?.softwareKeyboardLayoutMode).toBe("resize");
  });

  test("workspace sharing bounds one scroll body and keeps its actions outside it", () => {
    const share = readFileSync(resolve(sourceRoot, "features/artifacts/workspace-share-sheet.tsx"), "utf8");
    const owner = readFileSync(resolve(sourceRoot, "features/artifacts/artifact-viewer-actions-sheet.tsx"), "utf8");
    expect(share).toContain('maxHeight: "100%", flexShrink: 1');
    expect(share).toContain("body: { flexShrink: 1 }");
    expect(share).toContain('actions: { flexShrink: 0, flexDirection: "row"');
    expect(share).toContain('<ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">');
    expect(share.indexOf("<View style={styles.actions}>")).toBeGreaterThan(share.lastIndexOf("</ScrollView>"));
    expect(owner).toContain('shareContainer: { maxHeight: "100%", flexShrink: 1 }');
    expect(owner).toContain('style={mode === "share" ? styles.shareContainer :');
  });

  test("chat resizes the transcript and composer as one flex-height surface", () => {
    const source = readFileSync(resolve(sourceRoot, "app/chat/[roomId].tsx"), "utf8");

    expect(source).toContain(
      '<KeyboardAvoidingView behavior="padding" style={styles.container}>',
    );
    expect(source).toMatch(/container:\s*\{\s*flex:\s*1,/);
    expect(source).not.toMatch(
      /<KeyboardAvoidingView[^>]*>\s*<RoomChatComposer/,
    );
  });

  test("delegated work stays a non-shrinking chat sibling above search and transcript", () => {
    const chat = readFileSync(resolve(sourceRoot, "app/chat/[roomId].tsx"), "utf8");
    const strip = readFileSync(resolve(sourceRoot, "features/task-work/task-work-strip.tsx"), "utf8");
    const focus = chat.indexOf("<AgentFocusBar");
    const work = chat.indexOf("<TaskWorkStrip");
    const search = chat.indexOf("{searchOpen ? (");
    const pane = chat.indexOf("<RoomChatPane");

    expect(focus).toBeGreaterThan(-1);
    expect(work).toBeGreaterThan(focus);
    expect(search).toBeGreaterThan(work);
    expect(pane).toBeGreaterThan(work);
    expect(strip).toContain("flexShrink: 0");
    expect(chat.match(/<KeyboardAvoidingView/g)?.length).toBe(1);
  });

  test("Task work composes below the independent focus bar without taking over its persistence or chat controls", () => {
    const chat = readFileSync(resolve(sourceRoot, "app/chat/[roomId].tsx"), "utf8");
    const focus = readFileSync(resolve(sourceRoot, "components/agent-focus-bar.tsx"), "utf8");
    const strip = readFileSync(resolve(sourceRoot, "features/task-work/task-work-strip.tsx"), "utf8");
    const focusStart = chat.indexOf("const hasTopWorkStack = hasAgentFocusBar || hasTaskWorkStrip;");
    const focusEnd = chat.indexOf("{hasTopWorkStack ? <View", focusStart);
    const stripEnd = chat.indexOf("      <TaskWorkStatusAnnouncer", focusEnd);

    expect(focusStart).toBeGreaterThan(-1);
    expect(focusEnd).toBeGreaterThan(focusStart);
    expect(stripEnd).toBeGreaterThan(focusEnd);
    expect(chat.slice(focusEnd, stripEnd)).toContain("<AgentFocusBar");
    expect(chat.slice(focusEnd, stripEnd)).toContain("<TaskWorkStrip");
    expect(focus).toContain('const COLLAPSE_STORAGE_PREFIX = "@nautilo/agent-focus-bar-collapsed/"');
    expect(focus).toContain("AsyncStorage.getItem(collapseKey)");
    expect(focus).toContain("AsyncStorage.setItem(collapseKey");
    expect(strip).not.toContain("AsyncStorage");
    expect(strip).not.toContain("toggleFocus");
    expect(strip).not.toContain("focusedBotActorId");
    expect(chat.slice(focusEnd, stripEnd)).toContain("focusedBotActorId={focusedBotActorId}");
    expect(chat.slice(focusEnd, stripEnd)).toContain("toggleFocus={toggleFocus}");
    expect(chat).toContain("const hasTaskWorkStrip = taskWorkStripServerUrl !== null && projectTaskWorkStrip(taskWork) !== null;");
    expect(chat).toContain("const hasTopWorkStack = hasAgentFocusBar || hasTaskWorkStrip;");
  });

  test("file viewer keeps the full fixed-height chat dock attached above the keyboard", () => {
    const source = readFileSync(resolve(sourceRoot, "app/files/artifact/[id].tsx"), "utf8");

    expect(source).toMatch(
      /<KeyboardStickyView style=\{\[styles\.chatDock, \{ height: dockHeight \}\]\}>[\s\S]*?<RoomChatPane controller=\{chat\} actionSurface="room" \/>[\s\S]*?<RoomChatComposer[\s\S]*?<\/KeyboardStickyView>/,
    );
    expect(source).not.toContain('<KeyboardAvoidingView behavior="padding" style={[styles.chatDock');
  });
});
