/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canOpenTaskWorkOverview,
  shouldCloseTaskWorkOverview,
  shouldCloseTaskWorkOverviewFromUpHandle,
  shouldFocusTaskWorkOverviewShell,
  shouldRestoreTaskWorkStripFocus,
  taskWorkOverviewCloseAccessibilityAction,
  taskWorkOverviewScopeKey,
} from "./task-work-overview-presentation";
import type { TaskWorkViewState } from "./task-work-state";

const scope = { serverId: "server", userId: "owner", actorId: "actor", viewerEpoch: 1 };
const view = (rows: number, quiet = false): TaskWorkViewState => ({ kind: rows ? "ready" : "empty", scope, selectors: { quiet, overviewRows: Array.from({ length: rows }), topRows: [], actionNeeded: [], active: [], paused: [], terminalHistory: [], newlyCompleted: [] } } as unknown as TaskWorkViewState);

describe("Task work overview shell", () => {
  test("fences open state by room, server, owner and viewer epoch", () => {
    const first = taskWorkOverviewScopeKey({ roomId: "room", serverUrl: "https://a", scope });
    expect(first).not.toBe(taskWorkOverviewScopeKey({ roomId: "room", serverUrl: "https://a", scope: { ...scope, viewerEpoch: 2 } }));
    expect(canOpenTaskWorkOverview({ isScreenFocused: true, scopeKey: first, view: view(1) })).toBeTrue();
    expect(canOpenTaskWorkOverview({ isScreenFocused: false, scopeKey: first, view: view(1) })).toBeFalse();
  });
  test("keeps quiet bounded history open but closes true-empty work", () => {
    expect(shouldCloseTaskWorkOverview(view(1, true))).toBeFalse();
    expect(shouldCloseTaskWorkOverview(view(0))).toBeTrue();
  });
  test("restores focus only for a same-scope explicit close", () => {
    expect(shouldRestoreTaskWorkStripFocus({ reason: "explicit", openScopeKey: "scope-a", currentScopeKey: "scope-a" })).toBeTrue();
    expect(shouldRestoreTaskWorkStripFocus({ reason: "teardown", openScopeKey: "scope-a", currentScopeKey: "scope-a" })).toBeFalse();
    expect(shouldRestoreTaskWorkStripFocus({ reason: "explicit", openScopeKey: "scope-a", currentScopeKey: "scope-b" })).toBeFalse();
  });
  test("announces the restored conversation when an explicit same-scope close has no strip", () => {
    expect(taskWorkOverviewCloseAccessibilityAction({ reason: "explicit", openScopeKey: "scope", currentScopeKey: "scope", stripAvailable: true })).toBe("focus-strip");
    expect(taskWorkOverviewCloseAccessibilityAction({ reason: "explicit", openScopeKey: "scope", currentScopeKey: "scope", stripAvailable: false })).toBe("announce-conversation");
    expect(taskWorkOverviewCloseAccessibilityAction({ reason: "teardown", openScopeKey: "scope", currentScopeKey: "scope", stripAvailable: false })).toBe("none");
    expect(taskWorkOverviewCloseAccessibilityAction({ reason: "explicit", openScopeKey: "scope", currentScopeKey: "other", stripAvailable: false })).toBe("none");
  });
  test("focuses only after visible layout and normal-motion reveal completion", () => {
    expect(shouldFocusTaskWorkOverviewShell({ stageHeight: 0, reducedMotion: false, revealFinished: true, alreadyFocused: false })).toBeFalse();
    expect(shouldFocusTaskWorkOverviewShell({ stageHeight: 300, reducedMotion: false, revealFinished: false, alreadyFocused: false })).toBeFalse();
    expect(shouldFocusTaskWorkOverviewShell({ stageHeight: 300, reducedMotion: false, revealFinished: true, alreadyFocused: false })).toBeTrue();
    expect(shouldFocusTaskWorkOverviewShell({ stageHeight: 300, reducedMotion: true, revealFinished: false, alreadyFocused: false })).toBeTrue();
    expect(shouldFocusTaskWorkOverviewShell({ stageHeight: 300, reducedMotion: true, revealFinished: true, alreadyFocused: true })).toBeFalse();
  });
  test("only an upward centered handle gesture closes", () => {
    expect(shouldCloseTaskWorkOverviewFromUpHandle({ dx: 1, dy: -14, startX: 100, windowWidth: 360 })).toBeTrue();
    expect(shouldCloseTaskWorkOverviewFromUpHandle({ dx: 1, dy: 14, startX: 100, windowWidth: 360 })).toBeFalse();
    expect(shouldCloseTaskWorkOverviewFromUpHandle({ dx: 30, dy: -14, startX: 100, windowWidth: 360 })).toBeFalse();
    expect(shouldCloseTaskWorkOverviewFromUpHandle({ dx: 1, dy: -14, startX: 10, windowWidth: 360 })).toBeFalse();
  });
  test("shell contains no modal, list, input, or task rows", () => {
    const source = readFileSync(resolve(import.meta.dir, "task-work-overview-shell.tsx"), "utf8");
    expect(source).toContain("Delegated work");
    expect(source).toContain("minHeight: 44");
    expect(source).not.toMatch(/<Modal|BottomSheet|FlatList|TextInput|TaskWorkRow/);
  });

  test("uses a reduced-motion-safe clipped reveal and a scoped modal accessibility trap", () => {
    const source = readFileSync(resolve(import.meta.dir, "task-work-overview-shell.tsx"), "utf8");
    expect(source).toContain("useReducedMotion");
    expect(source).toContain("Animated.timing");
    expect(source).toContain("useNativeDriver: false");
    expect(source).toContain("reveal.interpolate");
    expect(source).toContain("onLayout={(event) => setStageHeight(event.nativeEvent.layout.height)}");
    expect(source).toContain("shouldFocusTaskWorkOverviewShell");
    expect(source).toContain("if (finished && mountedRef.current) setRevealFinished(true);");
    expect(source).toContain("zIndex: 30, elevation: 30");
    expect(source).toContain("<View {...responder.panHandlers} style={styles.handleHit}><View style={styles.handle} /></View>");
    expect(source).toContain("handleHit: { minHeight: 44");
    expect(source).toContain("useWindowDimensions");
    expect(source).toContain("const largeText = fontScale >= 1.3");
    expect(source).toContain('flexWrap: "wrap"');
    expect(source).toContain("title: { flexShrink: 1");
    expect(source).toContain('role: "dialog"');
    expect(source).toContain("accessibilityViewIsModal");
    expect(source).toContain('"aria-modal": true');
    expect(source).toContain("onWebKeyDown");
    expect(source).toContain("taskWorkOverviewTabWrap");
    expect(source).toContain('typeof document === "undefined" ? keyEvent.target : document.activeElement');
    expect(source).toContain(':not([disabled]):not([aria-disabled="true"])');
    expect(source).toContain("onAccessibilityEscape={() => onClose()}");
  });

  test("keeps the pane and draft-owning composer mounted but inert under the shell", () => {
    const route = readFileSync(resolve(import.meta.dir, "../../app/chat/[roomId].tsx"), "utf8");
    const stage = route.indexOf("style={styles.chatStage}");
    const pane = route.indexOf("<RoomChatPane");
    const composer = route.indexOf("<RoomChatComposer");
    const shell = route.indexOf("<TaskWorkOverviewShell");
    expect(stage).toBeGreaterThan(-1);
    expect(pane).toBeGreaterThan(stage);
    expect(composer).toBeGreaterThan(pane);
    expect(shell).toBeGreaterThan(composer);
    expect(route.match(/<RoomChatPane/g)?.length).toBe(1);
    expect(route.match(/<RoomChatComposer/g)?.length).toBe(1);
    expect(route).toContain('pointerEvents={overviewOpen ? "none" : "auto"}');
    expect(route).toContain("accessibilityElementsHidden={overviewOpen}");
    expect(route).toContain("const hasTopWorkStack = hasAgentFocusBar || hasTaskWorkStrip;");
    expect(route).toContain("{hasTopWorkStack ? <View");
    expect(route).toContain("interactionDisabled={overviewOpen}");
    expect(route).toContain('importantForAccessibility={overviewOpen ? "no-hide-descendants" : "auto"}');
    expect(route).toContain('"aria-hidden": true, inert: true');
  });

  test("keeps explicit close focus distinct from scope teardown and wires all close paths", () => {
    const route = readFileSync(resolve(import.meta.dir, "../../app/chat/[roomId].tsx"), "utf8");
    expect(route).toContain("BackHandler.addEventListener");
    expect(route).toContain('event.data.action.type !== "GO_BACK" && event.data.action.type !== "POP"');
    expect(route).toContain('event.key === "Escape"');
    expect(route).toContain('closeOverview("explicit")');
    expect(route).toContain("taskWorkOverviewCloseAccessibilityAction({");
    expect(route).toContain("AccessibilityInfo.setAccessibilityFocus(node)");
    expect(route).toContain("Delegated work closed. Conversation restored.");
    expect(route).toContain("const chatContentRef = useRef<View>(null);");
    expect(route).toContain("ref={chatContentRef}");
    expect(route).toContain('tabIndex: -1, role: "main", "aria-label": "Conversation"');
    expect(route).toContain("chatContentRef.current?.focus?.();");
  });
});
