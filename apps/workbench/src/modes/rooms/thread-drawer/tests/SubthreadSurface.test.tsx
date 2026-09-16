import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AutoApproveContext,
  useApprovalAsk,
  useToolActivity,
  WsStateContext,
} from "../../../../adapters/runtime-contexts";
import { DrawerProvider } from "../drawer-state.tsx";
import { ToastProvider } from "../../../../components/toast";
import { clearTypingPingSender, setTypingPingSender } from "../../typing/typing-bus";
import {
  resetAgentStreamingVisibleOutputForTests,
  setAgentStreamingVisibleOutput,
} from "../../typing/presence-typing-strip-model";

const api = {
  getRoom: mock(async () => ({
    members: [
      { actorId: "human-peer", kind: "user", userId: "peer-id", displayName: "Maya", roomRole: "member" },
      { actorId: "genie-actor", kind: "agent", agentId: "genie-id", displayName: "Nova", handle: "star-guide", roomRole: "member" },
      { actorId: "atlas-actor", kind: "agent", agentId: "atlas-id", displayName: "Atlas", roomRole: "member" },
      { actorId: "observe-actor", kind: "agent", agentId: "observe-id", displayName: "Watcher", roomRole: "member", agentResponseMode: "observe" },
    ],
  })),
  approvalReply: mock(async () => ({ ok: true })),
  proveItAndResume: mock(async () => ({ ok: true })),
  denyProveIt: mock(async () => ({ ok: true })),
  addReaction: mock(async () => ({ reactions: [] })),
  removeReaction: mock(async () => ({ reactions: [] })),
  deleteRoomMessage: mock(async () => ({ ok: true as const })),
  searchRoomMessages: mock(async () => ({
    hits: [], hasMoreOlder: false, nextOlderCursor: null, asOf: null,
  })),
  getRoomMessagesAround: mock(async () => ({
    target: { messageId: "1", createdAt: "2026-01-01T00:00:00.000Z" },
    messages: [], includedToolCallCompanion: false, hasOlder: false, hasNewer: false,
  })),
  codex: {
    userPreference: mock(async () => ({
      enabled: true,
      profileId: "11111111-1111-4111-8111-111111111111",
      posture: "codex_default",
      revision: 1,
    })),
    models: mock(async () => ({
      models: [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "", isDefault: true }],
      preferredModelId: "gpt-5.6-sol",
    })),
  },
};

const focusToggle = mock(() => {});
const focus = {
  ring: { kind: "none" as const },
  isTarget: mock(() => false),
  isHeld: mock(() => false),
  isExpiringSoon: mock(() => false),
  secondsLeft: mock(() => null),
  remainingFraction: mock(() => null),
  reasonFor: mock(() => null),
  isBusy: mock(() => false),
  toggle: focusToggle,
  recentBotActorIds: ["atlas-actor"],
  refresh: mock(async () => {}),
};

const dispatch = mock(() => {});
let triggerResizeObservers: Array<() => void> = [];
let notificationSubthreadsById = new Map<
  string,
  { unreadCount: number; importantUnreadCount: number }
>();
const controllerOptions: unknown[] = [];
const controller = {
  state: {
    roomId: "child-1",
    parentRoomId: "parent-1",
    phase: "ready",
    visible: true,
    connected: true,
    detail: { parentRoomId: "parent-1" },
    anchor: { id: "root-1", content: "Thread root", role: "user", createdAt: "2026-01-01T00:00:00.000Z" },
    messages: [
      { id: "peer-message", role: "user", content: "**peer markdown**", createdAt: "2026-01-01T00:00:00.000Z", sourceUserId: "peer-id" },
      { id: "local-message", role: "user", content: "local reply", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "genie-message", role: "assistant", content: "Genie reply", createdAt: "2026-01-01T00:00:00.000Z", authorAgentId: "genie-id" },
    ],
    runtimeMessages: [
      { id: "peer-message", role: "user", content: [{ type: "text", text: "**peer markdown**" }], metadata: { custom: { sourceUserId: "peer-id" } } },
      { id: "local-message", role: "user", content: [{ type: "text", text: "local reply" }] },
      { id: "genie-message", role: "assistant", content: [{ type: "text", text: "Genie reply" }], metadata: { custom: { authorAgentId: "genie-id" } } },
      { id: "stream:genie", role: "assistant", content: [{ type: "text", text: "streaming" }], metadata: { custom: { authorAgentId: "genie-id" } } },
      { id: "tool-running", role: "assistant", content: [{ type: "tool-call", toolCallId: "running", toolName: "run_shell", args: {} }] },
      { id: "tool-success", role: "assistant", content: [{ type: "tool-call", toolCallId: "success", toolName: "file", args: {}, result: "done" }] },
      { id: "tool-error", role: "assistant", content: [{ type: "tool-call", toolCallId: "error", toolName: "run_shell", args: {}, result: "nope", isError: true }] },
    ],
    streams: {
      "stream:genie": { id: "stream:genie", turnId: "turn-1", authorAgentId: "genie-id", content: "streaming", done: false },
    },
    activeJobIds: ["job-child"],
    stopping: false,
    tools: {
      running: { toolCallId: "running", toolName: "run_shell", status: "running", turnId: "turn-1", authorAgentId: "genie-id" },
      success: { toolCallId: "success", toolName: "file", status: "success", result: "done", duration: 12, turnId: "turn-1", authorAgentId: "genie-id" },
      error: { toolCallId: "error", toolName: "run_shell", status: "error", error: "nope", duration: 15, turnId: "turn-1", authorAgentId: "genie-id" },
    },
    approvals: {
      approval: {
        type: "approval.ask",
        approvalId: "approval-child",
        threadId: "thread-child",
        laneKey: "room:child-1",
        tools: [{ name: "run_shell", args: { command: "pwd" } }],
        reason: "Needs approval",
        reasonCode: "destructive-tool",
        allowedVerbs: ["once", "deny"],
      },
      proveIt: {
        type: "prove_it.challenge",
        threadId: "prove-child",
        laneKey: "room:child-1",
        tools: [{ name: "run_shell", args: { command: "rm" } }],
      },
      resolved: {},
    },
    draft: "",
    send: { status: "idle", requestId: null, retryableDraft: null, error: null },
    read: { status: "marked", requestedForRoomId: "child-1" },
    reactionOperations: {},
    error: null,
  },
  dispatch,
  retryHydrate: mock(() => {}),
  setDraft: mock(() => {}),
  send: mock(async () => {}),
  sendText: mock(async () => true),
  markRead: mock(async () => true),
  stop: mock(async () => {}),
  ingestEvent: mock(() => {}),
};

mock.module("../../../../lib/api", () => ({ apiClient: api }));
mock.module("../../../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { isVerified: true, sessionUserId: "viewer-id", sessionActorId: "viewer-actor", capabilities: [], label: "You" } }),
}));
mock.module("../../../../notifications/notification-state-context", () => ({
  useNotificationState: () => ({
    subthreadsById: notificationSubthreadsById,
  }),
}));
mock.module("../../../../hooks/use-profile", () => ({
  useProfile: () => ({ agent: { name: "Genie" }, avatarSrc: "" }),
}));
mock.module("../../shape/use-room-focus", () => ({
  useRoomFocus: () => focus,
}));
mock.module("../../../../contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({ activeRoomId: "parent-1" }),
}));
mock.module("../../../../components/avatar/UserAvatar", () => ({
  UserAvatar: ({ displayName }: { displayName?: string }) => <span data-testid="user-avatar">{displayName}</span>,
}));
mock.module("../../../../components/avatar/authenticated-image", () => ({
  AuthenticatedAvatar: ({ alt }: { alt: string }) => <span data-testid="agent-avatar">{alt}</span>,
  fetchAvatarObjectUrl: mock(async () => ({ kind: "none" })),
  useAuthenticatedImage: () => ({ objectUrl: null, isShell: false, loading: false }),
}));
mock.module("../../../../viewers/markdown/markdown-viewer", () => ({
  ReaderMarkdown: ({ content }: { content: string }) => <span data-testid="reader-markdown">{content}</span>,
}));
mock.module("../../../../components/emoji/EmojiPickerPopover", () => ({
  computeComposerEmojiPopoverPosition: () => ({ left: 0, bottom: 0 }),
  computeEmojiPopoverPosition: () => ({ left: 0, bottom: 0 }),
  EmojiPickerPopover: ({ open, onSelect, onClose }: { open: boolean; onSelect: (emoji: string) => void; onClose: () => void }) => open ? (
    <>
      <button type="button" aria-label="Pick child add reaction" onClick={() => { onSelect("🔥"); onClose(); }}>Add</button>
      <button type="button" aria-label="Pick child remove reaction" onClick={() => { onSelect("👍"); onClose(); }}>Remove</button>
    </>
  ) : null,
}));
mock.module("../../../../components/tool-card/tool-card", () => ({
  ToolCard: ({ toolCallId, status, isError }: { toolCallId: string; status: { type: string }; isError?: boolean }) => {
    const activity = useToolActivity().find((item) => item.toolCallId === toolCallId);
    return <div data-testid={`tool-${toolCallId}`} data-status={status.type} data-error={String(isError === true)} data-activity={activity?.status} />;
  },
}));
mock.module("../../../../components/approval-ask-dock", () => ({
  ApprovalAskDock: () => {
    const { state, submit } = useApprovalAsk();
    return state.show ? (
      <>
        <button type="button" onClick={() => void submit("once")}>Approve child ask</button>
        <button type="button" onClick={() => void submit("deny")}>Deny child ask</button>
      </>
    ) : null;
  },
}));
mock.module("../../../../components/approval-dialog", () => ({
  ApprovalDialog: ({ onSubmit, onDeny }: { onSubmit: (pin: string) => void; onDeny: () => void }) => (
    <>
      <button type="button" onClick={() => onSubmit("123456")}>Approve child prove-it</button>
      <button type="button" onClick={onDeny}>Deny child prove-it</button>
    </>
  ),
}));
mock.module("../use-thread-room-controller", () => ({
  useThreadRoomController: (options: unknown) => {
    controllerOptions.push(options);
    return controller;
  },
}));

const {
  SubthreadSurface,
  buildSubthreadRuntimeMessages,
  isReactionTogglePending,
  orderThreadGenies,
  resolveThreadPresenceAgentName,
} = await import("../surfaces/SubthreadSurface");
const { collectRoomSearchTextRanges } = await import("../../../../components/conversation");

function surfaceElement(
  wsState: "open" | "closed" = "open",
  autoApprove = false,
) {
  return (
    <WsStateContext.Provider value={{ state: wsState, lastOpenAt: null }}>
      <AutoApproveContext.Provider
        value={{ enabled: autoApprove, setEnabled: () => {}, canToggle: true }}
      >
        <ToastProvider>
          <DrawerProvider>
            <SubthreadSurface subthreadRoomId="child-1" anchorMessageId={1} parentRoomId="parent-1" />
          </DrawerProvider>
        </ToastProvider>
      </AutoApproveContext.Provider>
    </WsStateContext.Provider>
  );
}

function renderSurface(
  wsState: "open" | "closed" = "open",
  autoApprove = false,
) {
  return render(surfaceElement(wsState, autoApprove));
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  globalThis.Element = window.Element;
  triggerResizeObservers = [];
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      triggerResizeObservers.push(() => callback([], this));
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: () => true,
  });
  api.getRoom.mockClear();
  api.approvalReply.mockClear();
  api.proveItAndResume.mockClear();
  api.denyProveIt.mockClear();
  api.addReaction.mockClear();
  api.removeReaction.mockClear();
  api.deleteRoomMessage.mockClear();
  api.searchRoomMessages.mockClear();
  api.getRoomMessagesAround.mockClear();
  api.codex.userPreference.mockClear();
  api.codex.models.mockClear();
  dispatch.mockClear();
  controller.stop.mockClear();
  controller.setDraft.mockClear();
  controller.send.mockClear();
  controller.sendText.mockClear();
  controller.markRead.mockReset();
  controller.markRead.mockImplementation(async () => true);
  notificationSubthreadsById = new Map();
  controllerOptions.length = 0;
  focusToggle.mockClear();
  focus.isTarget.mockClear();
  focus.isHeld.mockClear();
  focus.isExpiringSoon.mockClear();
  focus.secondsLeft.mockClear();
  focus.remainingFraction.mockClear();
  focus.reasonFor.mockClear();
  focus.isBusy.mockClear();
  controller.state.draft = "";
});

afterEach(() => {
  clearTypingPingSender();
  resetAgentStreamingVisibleOutputForTests();
});

describe("SubthreadSurface", () => {
  test("builds exact rendered-word ranges without mutating message DOM", () => {
    const content = document.createElement("div");
    content.innerHTML = "Darkness <a>dark</a> darker stock";
    const before = content.innerHTML;
    expect(collectRoomSearchTextRanges(content, "dark", "prefix").map((range) => range.toString()))
      .toEqual(["Darkness", "dark", "darker"]);
    expect(collectRoomSearchTextRanges(content, "dark", "whole").map((range) => range.toString()))
      .toEqual(["dark"]);
    expect(collectRoomSearchTextRanges(content, "Dark", "prefix", false).map((range) => range.toString()))
      .toEqual(["Darkness"]);
    expect(collectRoomSearchTextRanges(content, "dark", "prefix", false).map((range) => range.toString()))
      .toEqual(["dark", "darker"]);
    expect(content.innerHTML).toBe(before);
  });

  test("opens a child-Room transcript search and keeps the drawer open when Escape closes find", async () => {
    const view = renderSurface();
    fireEvent.click(view.getByLabelText("Search thread transcript"));
    expect(view.getByTestId("room-transcript-find-bar").getAttribute("data-layout")).toBe("compact");
    const input = view.getByRole("textbox", { name: "Search in this chat" });
    fireEvent.input(input, { target: { value: "needle" } });
    await waitFor(() => expect(api.searchRoomMessages).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "child-1",
      query: "needle",
    })));

    fireEvent.keyDown(input, { key: "Escape" });
    expect(view.queryByTestId("room-transcript-find-bar")).toBeNull();
    expect(view.getByTestId("thread-transcript-scroll")).toBeTruthy();
  });

  test("orders active focus, then requester-private access recency, then a stable fallback", () => {
    const sorted = orderThreadGenies(
      [
        { actorId: "nova", kind: "agent", agentId: "nova-id", displayName: "Nova", roomRole: "member" },
        { actorId: "atlas", kind: "agent", agentId: "atlas-id", displayName: "Atlas", roomRole: "member" },
        { actorId: "zeta", kind: "agent", agentId: "zeta-id", displayName: "Zeta", roomRole: "member" },
        { actorId: "watcher", kind: "agent", agentId: "watcher-id", displayName: "Watcher", roomRole: "member", agentResponseMode: "observe" },
      ],
      { ...focus, isTarget: (actorId: string) => actorId === "nova" },
      ["atlas"],
    );

    expect(sorted.map((member) => member.actorId)).toEqual(["nova", "atlas", "zeta"]);
  });

  test("uses shared markdown and roster identity for human, local, and Genie rows", async () => {
    const view = renderSurface();
    expect((await view.findAllByText("Maya")).length).toBeGreaterThan(0);
    expect(view.getAllByText("You").length).toBeGreaterThan(0);
    expect(view.getAllByText("Nova").length).toBeGreaterThan(0);
    expect(view.getByText("Thread root")).toBeTruthy();
    expect(view.getByText("peer markdown")).toBeTruthy();
    expect(api.getRoom).toHaveBeenCalledWith("parent-1");
  });

  test("keeps the complete thread transcript scrollable while the composer remains fixed", () => {
    const view = renderSurface();
    const transcript = view.getByTestId("thread-transcript-scroll");
    const composer = view.getByTestId("thread-composer");
    const root = view.getByText("Thread root");

    expect(transcript.className).toContain("overflow-y-auto");
    expect(transcript.className).toContain("min-w-0");
    expect(transcript.className).toContain("overflow-x-hidden");
    expect(transcript.contains(root)).toBe(true);
    expect(transcript.contains(composer)).toBe(false);
    expect(composer.className).toContain("shrink-0");
  });

  test("manual reader-away shows new activity and atomic return uses the viewport owner", async () => {
    const view = renderSurface();
    const transcript = view.getByTestId("thread-transcript-scroll");
    let scrollTop = 800;
    let scrollHeight = 1_000;
    const scrollTo = mock((options: ScrollToOptions) => {
      scrollTop = Math.min(Number(options.top ?? 0), 800);
      fireEvent.scroll(transcript);
    });
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.scroll(transcript);
    await waitFor(() => expect(scrollTo.mock.calls.length).toBeGreaterThan(0));
    scrollTop = 200;
    fireEvent.scroll(transcript);
    notificationSubthreadsById = new Map([
      ["child-1", { unreadCount: 2, importantUnreadCount: 0 }],
    ]);
    view.rerender(surfaceElement());

    const returnButton = await view.findByTestId("subthread-return-to-latest");
    expect(returnButton.textContent).toContain("New messages");
    expect(controller.markRead).not.toHaveBeenCalled();

    const scrollCallsWhileAway = scrollTo.mock.calls.length;
    scrollHeight = 400;
    fireEvent.scroll(transcript);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(view.getByTestId("subthread-return-to-latest")).toBeTruthy();
    expect(controller.markRead).not.toHaveBeenCalled();
    scrollHeight = 1_000;
    act(() => {
      for (const trigger of triggerResizeObservers) trigger();
    });
    expect(scrollTop).toBe(200);
    expect(scrollTo).toHaveBeenCalledTimes(scrollCallsWhileAway);

    const callsBeforeReturn = scrollTo.mock.calls.length;
    fireEvent.click(returnButton);

    await waitFor(() => expect(scrollTo.mock.calls.length).toBeGreaterThan(callsBeforeReturn));
    expect(scrollTo.mock.calls.at(-1)?.[0]).toMatchObject({ behavior: "instant" });
    await waitFor(() => expect(view.queryByTestId("subthread-return-to-latest")).toBeNull());
    await waitFor(() => expect(controller.markRead).toHaveBeenCalledTimes(1));
  });

  test("only a human scroll gesture reaching the exact edge resumes following", async () => {
    const view = renderSurface();
    const transcript = view.getByTestId("thread-transcript-scroll");
    let scrollTop = 800;
    let scrollHeight = 1_000;
    const scrollTo = mock((options: ScrollToOptions) => {
      scrollTop = Math.min(Number(options.top ?? 0), Math.max(0, scrollHeight - 200));
      fireEvent.scroll(transcript);
    });
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.scroll(transcript);
    await waitFor(() => expect(scrollTo.mock.calls.length).toBeGreaterThan(0));
    scrollTop = 200;
    fireEvent.scroll(transcript);
    expect(await view.findByTestId("subthread-return-to-latest")).toBeTruthy();

    scrollHeight = 400;
    fireEvent.scroll(transcript);
    expect(view.getByTestId("subthread-return-to-latest")).toBeTruthy();

    fireEvent.wheel(transcript, { deltaY: 10 });
    fireEvent.scroll(transcript);
    await waitFor(() => expect(view.queryByTestId("subthread-return-to-latest")).toBeNull());
  });

  test("marks only an authoritative unread child after its own viewport reaches bottom", async () => {
    const view = renderSurface();
    const transcript = view.getByTestId("thread-transcript-scroll");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    notificationSubthreadsById = new Map([
      ["child-1", { unreadCount: 3, importantUnreadCount: 1 }],
    ]);
    view.rerender(surfaceElement());
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(controller.markRead).not.toHaveBeenCalled();

    Object.defineProperty(transcript, "scrollTop", {
      configurable: true,
      writable: true,
      value: 800,
    });
    fireEvent.scroll(transcript);
    await waitFor(() => expect(controller.markRead).toHaveBeenCalledTimes(1));
    expect(controller.markRead).toHaveBeenCalledWith();
  });

  test("leaves an unfocused child unread and retries when the window regains focus", async () => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
    });
    const view = renderSurface();
    const transcript = view.getByTestId("thread-transcript-scroll");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 800 },
    });
    notificationSubthreadsById = new Map([
      ["child-1", { unreadCount: 3, importantUnreadCount: 1 }],
    ]);
    view.rerender(surfaceElement());
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(controller.markRead).not.toHaveBeenCalled();

    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    fireEvent.focus(window);
    await waitFor(() => expect(controller.markRead).toHaveBeenCalledTimes(1));
  });

  test("bounds a failed child read until a later gate event retries it", async () => {
    controller.markRead
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => true);
    const view = renderSurface();
    const transcript = view.getByTestId("thread-transcript-scroll");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 800 },
    });
    notificationSubthreadsById = new Map([
      ["child-1", { unreadCount: 3, importantUnreadCount: 1 }],
    ]);
    view.rerender(surfaceElement());
    await waitFor(() => expect(controller.markRead).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(controller.markRead).toHaveBeenCalledTimes(1);

    fireEvent.scroll(transcript);
    await waitFor(() => expect(controller.markRead).toHaveBeenCalledTimes(2));
  });

  test("uses the parent WebSocket state for child reconnect hydration", () => {
    renderSurface("closed");
    expect(controllerOptions).toContainEqual(expect.objectContaining({ roomId: "child-1", visible: true, connected: false }));
  });

  test("renders child stream and tool lifecycle cards through Assistant UI message parts", () => {
    const view = renderSurface();
    expect(view.getByText("streaming")).toBeTruthy();
    expect(view.getByTestId("tool-running").getAttribute("data-activity")).toBe("running");
    expect(view.getByTestId("tool-success")).toBeTruthy();
    expect(view.getByTestId("tool-error").getAttribute("data-error")).toBe("true");
    expect(view.getByTestId("tool-error")).toBeTruthy();
  });

  test("uses a pinned Genie search plus scrollable eligible-focus rail and a child-only stop", async () => {
    const view = renderSurface();
    const rail = await view.findByLabelText("Eligible Genies");
    const conch = view.getByTestId("thread-genie-conch-strip");
    const composerSurface = view.getByTestId("thread-composer-surface");
    expect(rail.className).toContain("overflow-x-auto");
    expect(composerSurface.contains(conch)).toBe(false);
    expect(view.queryByLabelText("Thread responder")).toBeNull();
    expect(view.queryByText("Let conductor choose")).toBeNull();
    expect(view.queryByText("Nova will reply")).toBeNull();
    fireEvent.click(view.getByLabelText("Focus on Nova"));
    expect(focusToggle).toHaveBeenCalledWith("genie-actor");

    fireEvent.click(view.getByLabelText("Search Genies"));
    const searchDialog = view.getByRole("dialog", { name: "Genie search popover" });
    expect(searchDialog.className).toContain("w-full");
    expect(searchDialog.className).toContain("overflow-y-auto");
    expect(searchDialog.className).not.toContain("absolute");
    const search = view.getByLabelText("Search people and agents") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "atl" } });
    expect(await view.findByRole("option", { name: /Atlas/ })).toBeTruthy();
    expect(view.queryByRole("option", { name: /Watcher/ })).toBeNull();
    fireEvent.click(view.getByRole("option", { name: /Atlas/ }));
    expect(focusToggle).toHaveBeenCalledWith("atlas-actor");

    fireEvent.click(view.getByLabelText("Search Genies"));
    const handleSearch = view.getByLabelText("Search people and agents") as HTMLInputElement;
    fireEvent.change(handleSearch, { target: { value: "star-guide" } });
    expect(await view.findByRole("option", { name: /Nova/ })).toBeTruthy();
    fireEvent.click(view.getByLabelText("Stop child reply"));
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect((view.getByLabelText("Attach files") as HTMLButtonElement).disabled).toBe(true);
  });

  test("uses Assistant UI composer primitives with a child-only send adapter even without a focused Genie", async () => {
    controller.state.draft = "Send this child reply";
    const priorJobs = controller.state.activeJobIds;
    const priorStreams = controller.state.streams;
    controller.state.activeJobIds = [];
    controller.state.streams = {};
    const view = renderSurface();
    const input = view.getByLabelText("Thread reply");
    const editable = input.querySelector<HTMLElement>("[contenteditable='true']");

    expect(editable).toBeTruthy();
    expect(view.getByTestId("thread-composer").contains(input)).toBe(true);
    expect(view.getByLabelText("Send thread reply")).toBeTruthy();
    expect((view.getByLabelText("Stop child reply") as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByLabelText("Attach files").getAttribute("title")).toContain("not yet supported");
    expect(view.queryByTestId("composer-harness-picker")).toBeNull();
    controller.state.activeJobIds = priorJobs;
    controller.state.streams = priorStreams;
  });

  test("offers inherited humans and agents from the production mention picker", async () => {
    const view = renderSurface();
    const input = view.getByLabelText("Thread reply");
    const editable = input.querySelector<HTMLElement>("[contenteditable='true']");
    expect(editable).toBeTruthy();

    editable!.focus();
    editable!.textContent = "@";
    const range = document.createRange();
    range.selectNodeContents(editable!);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.input(editable!, { inputType: "insertText", data: "@" });

    expect(await view.findByText("@star-guide")).toBeTruthy();
    expect(view.getByText("@maya")).toBeTruthy();
  });

  test("emits established typing pings only for native child-composer edits", async () => {
    const sender = mock(() => {});
    setTypingPingSender(sender);
    const view = renderSurface();
    const editable = view.getByLabelText("Thread reply").querySelector<HTMLElement>("[contenteditable='true']");
    expect(editable).toBeTruthy();

    await Promise.resolve();
    editable!.dispatchEvent(new window.Event("input", { bubbles: true }));

    expect(sender).toHaveBeenCalledWith({
      type: "typing.ping",
      roomId: "child-1",
      displayName: "You",
    });
  });

  test("shows only child-room human typing presence", async () => {
    const view = renderSurface();
    act(() => {
      window.dispatchEvent(new CustomEvent("nautilo:typing-ping", {
        detail: { roomId: "parent-1", userId: "parent-peer", displayName: "Parent peer" },
      }));
    });
    expect(view.queryByText("Parent peer")).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent("nautilo:typing-ping", {
        detail: { roomId: "child-1", userId: "child-peer", displayName: "Child peer" },
      }));
    });
    expect((await view.findByTestId("presence-chip-human")).textContent).toContain("Child peer");
  });

  test("uses child-local agent lifecycle state instead of parent-global presence", async () => {
    const priorStreams = controller.state.streams;
    const priorJobs = controller.state.activeJobIds;
    try {
      controller.state.streams = {};
      controller.state.activeJobIds = ["child-job"];
      // A parent-visible stream must not suppress a quiet child job.
      setAgentStreamingVisibleOutput(true);
      const quiet = renderSurface();
      expect((await quiet.findByTestId("presence-chip-agent")).textContent).toContain("Nova");
      quiet.unmount();

      // Visible child text suppresses only the child agent chip.
      controller.state.streams = {
        "stream:genie": {
          id: "stream:genie", turnId: "turn-1", authorAgentId: "genie-id", content: "visible", done: false,
        },
      };
      const streaming = renderSurface();
      expect(streaming.queryByTestId("presence-chip-agent")).toBeNull();
      streaming.unmount();

      // Once the child job is terminal, its chip clears even if the parent is active.
      controller.state.streams = {};
      controller.state.activeJobIds = [];
      const terminal = renderSurface();
      expect(terminal.queryByTestId("presence-chip-agent")).toBeNull();
      terminal.unmount();
    } finally {
      controller.state.streams = priorStreams;
      controller.state.activeJobIds = priorJobs;
    }
  });

  test("labels child work from an active stream or running child tool before focused fallback", () => {
    const args = {
      members: [
        { actorId: "genie-actor", kind: "agent" as const, agentId: "genie-id", displayName: "Nova", roomRole: "member" },
        { actorId: "atlas-actor", kind: "agent" as const, agentId: "atlas-id", displayName: "Atlas", roomRole: "member" },
      ],
      focus: { ...focus, isTarget: (actorId: string) => actorId === "atlas-actor" },
      fallbackName: "Genie",
    };
    expect(resolveThreadPresenceAgentName({
      ...args,
      streams: {
        active: { id: "active", turnId: "turn", authorAgentId: "genie-id", content: "text", done: false },
      },
      tools: {},
    })).toBe("Nova");
    // `tool.start` retires the active text stream; its running tool author
    // must still win over a different focused Genie during that quiet gap.
    expect(resolveThreadPresenceAgentName({
      ...args,
      streams: {},
      tools: {
        running: {
          toolCallId: "running", toolName: "run_web_search", status: "running",
          turnId: "turn", authorAgentId: "genie-id",
        },
      },
    })).toBe("Nova");
    expect(resolveThreadPresenceAgentName({
      ...args,
      streams: {},
      tools: {
        old: {
          toolCallId: "old", toolName: "run_web_search", status: "success",
          turnId: "prior-turn", authorAgentId: "genie-id",
        },
      },
    })).toBe("Atlas");
  });

  test("scopes ask and prove-it replies to child event identifiers only", async () => {
    const view = renderSurface();
    fireEvent.click(view.getByText("Approve child ask"));
    fireEvent.click(view.getByText("Approve child prove-it"));
    await Promise.resolve();
    expect(api.approvalReply).toHaveBeenCalledWith(
      "once", "thread-child", "room:child-1", "approval-child", undefined, undefined,
    );
    expect(api.proveItAndResume).toHaveBeenCalledWith("123456", "prove-child", "room:child-1");
    expect(api.approvalReply).not.toHaveBeenCalledWith(expect.anything(), "thread-parent", expect.anything(), expect.anything());
    expect(dispatch).toHaveBeenCalledWith({ type: "approval.localCleared", kind: "ask", approvalId: "approval-child" });
    expect(dispatch).toHaveBeenCalledWith({ type: "approval.localCleared", kind: "proveIt" });
  });

  test("auto-approves an eligible child ask once without flashing the dock", async () => {
    const view = renderSurface("open", true);

    expect(view.queryByText("Approve child ask")).toBeNull();
    await waitFor(() => {
      expect(api.approvalReply).toHaveBeenCalledTimes(1);
    });
    expect(api.approvalReply).toHaveBeenCalledWith(
      "once",
      "thread-child",
      "room:child-1",
      "approval-child",
      undefined,
      undefined,
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "approval.localCleared",
      kind: "ask",
      approvalId: "approval-child",
    });
  });

  test("keeps child network-egress asks manual when auto-approve is enabled", async () => {
    const previous = controller.state.approvals.approval;
    controller.state.approvals.approval = previous
      ? {
          ...previous,
          network: {
            host: "example.com",
            port: 443,
            reason: "network access",
            suggestedRule: { type: "domain", host: "example.com", ports: [443] },
          },
        }
      : null;
    try {
      const view = renderSurface("open", true);
      expect(view.getByText("Approve child ask")).toBeTruthy();
      await Promise.resolve();
      expect(api.approvalReply).not.toHaveBeenCalled();
    } finally {
      controller.state.approvals.approval = previous;
    }
  });

  test("scopes deny actions to child event identifiers only", async () => {
    const view = renderSurface();
    fireEvent.click(view.getByText("Deny child ask"));
    fireEvent.click(view.getByText("Deny child prove-it"));
    await Promise.resolve();
    expect(api.approvalReply).toHaveBeenCalledWith(
      "deny", "thread-child", "room:child-1", "approval-child", undefined, undefined,
    );
    expect(api.denyProveIt).toHaveBeenCalledWith("prove-child", "room:child-1");
    expect(api.denyProveIt).not.toHaveBeenCalledWith("thread-parent", expect.anything());
  });

  test("gives only the child row Reply, delete, and reactions without exposing nested threads", async () => {
    const messages = buildSubthreadRuntimeMessages(
      "parent-1",
      { id: "7", role: "user", content: [{ type: "text", text: "anchor" }] },
      [{ id: "7", role: "user", content: [{ type: "text", text: "child" }] }],
    );
    expect(messages.map((message) => message.id)).toEqual(["thread-anchor:parent-1:7", "7"]);
    expect(messages[0]?.metadata).toMatchObject({ custom: { parentAnchorRoomId: "parent-1", parentAnchorMessageId: "7" } });

    const priorAnchor = controller.state.anchor;
    const priorMessages = controller.state.runtimeMessages;
    try {
      controller.state.anchor = { id: "7", role: "user", content: "anchor", createdAt: "2026-01-01T00:00:00.000Z" };
      controller.state.runtimeMessages = [{
        id: "7", role: "user", content: [{ type: "text", text: "child" }],
        metadata: { custom: { reactions: [{ emoji: "👍", count: 1, actorIds: ["viewer-actor"] }] } },
      }];
      const view = renderSurface();
      expect(view.getByTestId("reaction-strip")).toBeTruthy();
      expect(view.getAllByLabelText("React")).toHaveLength(1);
      expect(view.queryByText("Open in thread")).toBeNull();
      expect(view.getAllByLabelText("Reply")).toHaveLength(1);
      expect(view.getAllByLabelText("Copy message")).toHaveLength(1);
      expect(view.getAllByLabelText("Delete message")).toHaveLength(1);
      expect(
        view.container
          .querySelector('[data-message-id="thread-anchor:parent-1:7"]')
          ?.querySelector('[aria-label="Reply"]'),
      ).toBeNull();
      fireEvent.click(view.getByLabelText("Reply"));
      expect(view.getByTestId("thread-composer-reply-preview").textContent).toContain("Replying to You");
      expect(view.queryByText("Open in thread")).toBeNull();
      fireEvent.click(view.getByLabelText("Cancel reply"));
      expect(view.queryByTestId("thread-composer-reply-preview")).toBeNull();
      const childRow = view.container.querySelector('[data-message-id="7"]') as HTMLElement;
      fireEvent.keyDown(childRow, { key: "ContextMenu" });
      expect(view.getByRole("menu", { name: "Message actions" })).toBeTruthy();
      expect(view.queryByText("Open in thread")).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(view.queryByRole("menu", { name: "Message actions" })).toBeNull();
      fireEvent.keyDown(childRow, { key: "F10", shiftKey: true });
      expect(view.getByRole("menu", { name: "Message actions" })).toBeTruthy();
      expect(view.queryByText("Open in thread")).toBeNull();
      fireEvent.click(view.getByLabelText("Delete message"));
      fireEvent.click(view.getByRole("button", { name: "Delete" }));
      await waitFor(() => {
        expect(api.deleteRoomMessage).toHaveBeenCalledWith("child-1", "7");
      });
      expect(api.deleteRoomMessage).not.toHaveBeenCalledWith("parent-1", "7");
    } finally {
      controller.state.anchor = priorAnchor;
      controller.state.runtimeMessages = priorMessages;
    }
  });

  test("forwards a child quote target when the thread composer sends", async () => {
    const priorAnchor = controller.state.anchor;
    const priorMessages = controller.state.runtimeMessages;
    try {
      controller.state.anchor = { id: "7", role: "user", content: "anchor", createdAt: "2026-01-01T00:00:00.000Z" };
      controller.state.runtimeMessages = [{
        id: "7", role: "user", content: [{ type: "text", text: "child" }],
      }];
      const view = renderSurface();
      fireEvent.click(view.getByLabelText("Reply"));
      const editable = view.getByLabelText("Thread reply").querySelector<HTMLElement>("[contenteditable='true']");
      expect(editable).toBeTruthy();
      editable!.focus();
      editable!.textContent = "quoted response";
      const range = document.createRange();
      range.selectNodeContents(editable!);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      fireEvent.input(editable!, { inputType: "insertText", data: "quoted response" });
      await waitFor(() => expect((view.getByLabelText("Send thread reply") as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(view.getByLabelText("Send thread reply"));
      await waitFor(() => expect(controller.sendText).toHaveBeenCalledWith(
        "quoted response",
        { replyToMessageId: 7 },
      ));
    } finally {
      controller.state.anchor = priorAnchor;
      controller.state.runtimeMessages = priorMessages;
    }
  });

  test("serializes a repeated child emoji toggle while preserving other reactions", () => {
    const pending = {
      "react-1": { roomId: "child-1", messageId: 7, emoji: "👍", delta: 1 as const, actorId: "viewer-actor" },
    };
    expect(isReactionTogglePending(pending, "child-1", 7, "👍")).toBe(true);
    expect(isReactionTogglePending(pending, "child-1", 7, "🎉")).toBe(false);
    expect(isReactionTogglePending(pending, "child-2", 7, "👍")).toBe(false);
  });

  test("sends add and remove requests only to the child Room", async () => {
    const priorAnchor = controller.state.anchor;
    const priorMessages = controller.state.runtimeMessages;
    try {
      controller.state.anchor = { id: "7", role: "user", content: "anchor", createdAt: "2026-01-01T00:00:00.000Z" };
      controller.state.runtimeMessages = [{
        id: "7", role: "user", content: [{ type: "text", text: "child" }],
        metadata: { custom: { reactions: [{ emoji: "👍", count: 1, actorIds: ["viewer-actor"] }] } },
      }];
      const view = renderSurface();
      fireEvent.click(view.getByLabelText("React"));
      fireEvent.click(view.getByLabelText("Pick child add reaction"));
      fireEvent.click(view.getByLabelText("React"));
      fireEvent.click(view.getByLabelText("Pick child remove reaction"));
      await Promise.resolve();

      expect(api.addReaction).toHaveBeenCalledWith("child-1", "7", "🔥");
      expect(api.removeReaction).toHaveBeenCalledWith("child-1", "7", "👍");
      expect(api.addReaction).not.toHaveBeenCalledWith("parent-1", expect.anything(), expect.anything());
      expect(api.removeReaction).not.toHaveBeenCalledWith("parent-1", expect.anything(), expect.anything());
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
        type: "reaction.optimistic", roomId: "child-1", messageId: 7,
      }));
    } finally {
      controller.state.anchor = priorAnchor;
      controller.state.runtimeMessages = priorMessages;
    }
  });
});
