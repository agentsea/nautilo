/**
 * D329 — Subagent transcript drawer scroll contract.
 *
 * The transcript adopts the chat's stick-to-bottom scroll primitive
 * (`use-stick-to-bottom`) so it follows streaming output and never squishes
 * tool cards (the old `flex-col` + `overflow` container shrank its children).
 * happy-dom lacks ResizeObserver/rAF, so we mock the lib to a structural
 * passthrough and assert the DOM scroll contract we wire up; real scroll
 * behavior is verified live.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Window } from "happy-dom";
import * as React from "react";
import { DrawerProvider } from "../../src/modes/rooms/thread-drawer/drawer-state.tsx";
import { RunningSubagentsContext } from "../../src/adapters/runtime-contexts";

type StbChildren =
  | React.ReactNode
  | ((ctx: { isAtBottom: boolean }) => React.ReactNode);

const renderStb = (children: StbChildren): React.ReactNode =>
  typeof children === "function" ? children({ isAtBottom: true }) : children;

const actualStb = await import("use-stick-to-bottom");

mock.module("use-stick-to-bottom", () => {
  function StickToBottom({
    children,
    resize: _resize,
    initial: _initial,
    mass: _mass,
    damping: _damping,
    stiffness: _stiffness,
    targetScrollTop: _targetScrollTop,
    contextRef: _contextRef,
    instance: _instance,
    ...props
  }: Record<string, unknown> & { children: StbChildren }) {
    return React.createElement("div", props, renderStb(children));
  }
  StickToBottom.Content = function Content({
    children,
    scrollClassName,
    ...props
  }: Record<string, unknown> & { children: StbChildren; scrollClassName?: string }) {
    return React.createElement(
      "div",
      { className: scrollClassName, "data-testid": "subagent-transcript-scroll-el" },
      React.createElement("div", props, renderStb(children)),
    );
  };
  return { StickToBottom, useStickToBottomContext: () => ({ scrollRef: { current: null }, isAtBottom: true }) };
});

let canonicalStatus = "completed";

const actualApi = await import("../../src/lib/api");

mock.module("../../src/lib/api", () => ({
  ...actualApi,
  apiClient: {
    ...actualApi.apiClient,
    getTask: async () => ({
      task: {
        id: "task-1",
        status: canonicalStatus,
        preset: "default",
        prompt: "work",
        scheduleKind: "now",
        nextFireAt: null,
        callingRoomId: null,
        expectedOutput: null,
        cron: null,
        runAt: null,
        timezone: "UTC",
        targetChat: "orphan",
        resultDelivery: "wake",
        useScope: false,
        scopeId: null,
        toolsMode: "all",
        toolsWhitelist: [],
        parentTaskId: null,
        depth: 0,
        selectionProfile: "balanced",
        selectionSpec: null,
        createdAt: "2026-06-15T10:00:00.000Z",
        updatedAt: "2026-06-15T10:00:00.000Z",
      },
      runs: [],
    }),
  },
}));

const { SubagentTranscriptSurface } = await import(
  "../../src/modes/rooms/subagents/SubagentTranscriptSurface"
);

const DOM_GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "customElements",
  "MutationObserver",
  "localStorage",
  "sessionStorage",
  "location",
  "__NAUTILO_HAPPY_DOM_WINDOW__",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const priorGlobals: Record<string, unknown> = {};
let happyWindow: Window;

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const k of DOM_GLOBAL_KEYS) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    customElements: happyWindow.customElements,
    MutationObserver: happyWindow.MutationObserver,
    localStorage: happyWindow.localStorage,
    sessionStorage: happyWindow.sessionStorage,
    location: happyWindow.location,
    __NAUTILO_HAPPY_DOM_WINDOW__: happyWindow,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

afterAll(() => {
  mock.module("../../src/lib/api", () => actualApi);
  mock.module("use-stick-to-bottom", () => actualStb);
  const g = globalThis as Record<string, unknown>;
  for (const key of DOM_GLOBAL_KEYS) {
    if (priorGlobals[key] === undefined) delete g[key];
    else g[key] = priorGlobals[key];
  }
});

afterEach(() => {
  canonicalStatus = "completed";
  cleanup();
});

describe("SubagentTranscriptSurface scroll contract", () => {
  test("a parked task without a dock entry is awaiting and has no working pulse", async () => {
    canonicalStatus = "awaiting";
    const view = render(
      <RunningSubagentsContext.Provider value={{ list: [], heartbeat: { count: 0, line: "" } }}>
        <DrawerProvider><SubagentTranscriptSurface taskId="task-1" /></DrawerProvider>
      </RunningSubagentsContext.Provider>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(view.getByTestId("subagent-transcript-header").textContent).toContain("needs attention");
    expect(view.queryByTestId("subagent-transcript-working")).toBeNull();
    expect(view.getByTestId("subagent-transcript-empty").className).not.toContain("animate-pulse");
  });

  test("uses a bounded box + stick-to-bottom scroll element, no flex-squish on rows (D329)", async () => {
    const view = render(
      <RunningSubagentsContext.Provider value={{ list: [], heartbeat: { count: 0, line: "" } }}>
        <DrawerProvider>
          <SubagentTranscriptSurface taskId="task-1" />
        </DrawerProvider>
      </RunningSubagentsContext.Provider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    // DrawerShell root is the bounded, non-scrolling frame.
    const shellRoot = view.container.firstElementChild as HTMLElement;
    expect(shellRoot.className).toContain("h-full");
    expect(shellRoot.className).toContain("min-h-0");

    // Outer StickToBottom box bounds the height (flex-1 of the surface column).
    const box = view.getByTestId("subagent-transcript-scroll");
    expect(box.className).toContain("min-h-0");
    expect(box.className).toContain("flex-1");

    // Inner element is the actual scroller.
    const scrollEl = view.getByTestId("subagent-transcript-scroll-el");
    expect(scrollEl.className).toContain("overflow-y-auto");

    // Content wrapper holds rows in normal flow (content-height column), so
    // tool cards can't be shrunk by the parent — the old squish bug.
    const content = scrollEl.firstElementChild as HTMLElement;
    expect(content.className).toContain("flex-col");
    expect(content.className).not.toContain("flex-1");
  });
});
