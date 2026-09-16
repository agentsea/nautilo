import "../bun-dom-preload.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ChatsSearchControls } from "../../src/adapters/runtime-contexts";
import {
  ChatsSearchResults,
  decodeChatSearchSnippetOnce,
} from "../../src/components/rooms/chats-search-results";

function searchState(overrides: Partial<ChatsSearchControls> = {}): ChatsSearchControls {
  return {
    scope: { serverKey: "server", viewerKey: "viewer", viewerGeneration: 1 },
    query: "launch",
    mode: "prefix",
    ignoreCase: true,
    status: "ready",
    generation: 1,
    messageAsOf: null,
    currentMessagePageIndex: 0,
    pages: [],
    conversations: [],
    conversationsTruncated: false,
    messages: [],
    hasMoreOlderMessages: false,
    canLoadNewerMessages: false,
    error: null,
    setQuery: () => {},
    setMode: () => {},
    setIgnoreCase: () => {},
    loadOlderMessages: async () => false,
    loadNewerMessages: async () => false,
    retry: async () => false,
    clear: () => {},
    ...overrides,
  };
}

afterEach(cleanup);

describe("ChatsSearchResults", () => {
  test("decodes the five server entities exactly once", () => {
    expect(
      decodeChatSearchSnippetOnce("&lt;tag&gt; &amp; &quot;quote&quot; &#39;apostrophe&#39;"),
    ).toBe('<tag> & "quote" \'apostrophe\'');
    expect(decodeChatSearchSnippetOnce("&amp;lt;tag&amp;gt; &amp;amp;")).toBe(
      "&lt;tag&gt; &amp;",
    );
  });

  test("renders the shared conversation and subthread message result shape", () => {
    const openConversation = mock(() => {});
    const openMessage = mock(() => {});
    const { getByRole, getByText } = render(
      <ChatsSearchResults
        search={searchState({
          conversations: [
            {
              matchedBy: "participant",
              room: {
                id: "room-1",
                label: "Launch room",
                type: "group",
                graphThreadId: "thread-1",
                createdAt: "2026-08-05T10:00:00.000Z",
                lastMessageAt: "2026-08-05T11:00:00.000Z",
                memberCount: 2,
                kind: "group",
                roster: [
                  { actorId: "actor-1", kind: "user", displayName: "Alex" },
                  { actorId: "actor-2", kind: "agent", displayName: "Jeannie" },
                ],
              },
            },
          ],
          messages: [
            {
              messageId: "42",
              createdAt: "2026-08-05T10:30:00.000Z",
              role: "assistant",
              snippet: "launch &amp; plan",
              roomId: "thread-room",
              roomLabel: "Details",
              roomKind: "subthread",
              parentRoomId: "room-1",
              parentRoomLabel: "Launch room",
            },
          ],
        })}
        onOpenConversation={openConversation}
        onOpenMessage={openMessage}
      />,
    );

    expect(getByText("Alex · Jeannie")).toBeTruthy();
    expect(getByText("Launch room › Details")).toBeTruthy();
    expect(getByText("launch & plan")).toBeTruthy();
    expect(getByText("1 matching chat · 1 message match shown")).toBeTruthy();
    expect(getByText("Chat names or participants")).toBeTruthy();
    expect(getByText("Text inside your chats")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /Launch room Alex/ }));
    fireEvent.click(getByRole("button", { name: /Launch room › Details launch & plan/ }));
    expect(openConversation).toHaveBeenCalledWith("room-1");
    expect(openMessage).toHaveBeenCalledWith("thread-room", "42");
  });

  test("explains a message-text match when no chat name or participant matches", () => {
    const view = render(
      <ChatsSearchResults
        search={searchState({
          messages: [{
            messageId: "84",
            createdAt: "2026-08-05T10:30:00.000Z",
            role: "assistant",
            snippet: "The workflow stopped fighting the environment.",
            roomId: "room-2",
            roomLabel: "New chat",
            roomKind: "private",
          }],
        })}
        onOpenConversation={() => {}}
        onOpenMessage={() => {}}
      />,
    );

    expect(view.getByText("0 matching chats · 1 message match shown")).toBeTruthy();
    expect(view.getByText("No chat names or participants match.")).toBeTruthy();
    expect(view.getByText("The workflow stopped fighting the environment.")).toBeTruthy();
  });

  test("shows honest pending, invalid, retry, empty, truncation, and bounded paging states", () => {
    const retry = mock(async () => true);
    const loadOlderMessages = mock(async () => true);
    const callbacks = {
      onOpenConversation: () => {},
      onOpenMessage: () => {},
    };

    const view = render(
      <ChatsSearchResults
        search={searchState({ status: "debouncing", pages: [] })}
        {...callbacks}
      />,
    );
    expect(view.getByText("Searching all chats…")).toBeTruthy();

    view.rerender(
      <ChatsSearchResults
        search={searchState({ status: "invalid", error: "Use at least two characters." })}
        {...callbacks}
      />,
    );
    expect(view.getByRole("alert").textContent).toContain("at least two");

    view.rerender(
      <ChatsSearchResults
        search={searchState({ status: "error", error: "Search failed.", retry })}
        {...callbacks}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);

    view.rerender(
      <ChatsSearchResults search={searchState({ status: "empty" })} {...callbacks} />,
    );
    expect(view.getByText("No conversations or messages match this search.")).toBeTruthy();

    view.rerender(
      <ChatsSearchResults
        search={searchState({
          conversationsTruncated: true,
          hasMoreOlderMessages: true,
          loadOlderMessages,
        })}
        {...callbacks}
      />,
    );
    expect(view.getByText(/Refine your search/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Load older" }));
    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
  });
});
