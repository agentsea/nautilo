import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoomMessageSearchControls } from "../../src/adapters/runtime-contexts";
import { RoomTranscriptFindBar } from "../../src/components/rooms/room-transcript-find-bar";

let happyWindow: Window;
let domRoot: Root | null = null;
const priorGlobals: Record<string, unknown> = {};

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    Element: happyWindow.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

afterEach(() => {
  if (domRoot) act(() => domRoot?.unmount());
  domRoot = null;
});

afterAll(() => Object.assign(globalThis, priorGlobals));

function searchState(overrides: Partial<RoomMessageSearchControls> = {}): RoomMessageSearchControls {
  return {
    roomId: "room-1",
    query: "deploy",
    mode: "prefix",
    ignoreCase: true,
    status: "ready",
    generation: 1,
    asOf: null,
    currentPageIndex: 0,
    pages: [],
    hits: [{
      messageId: "42",
      createdAt: "2026-07-30T09:15:00.000Z",
      role: "assistant",
      snippet: "The deployment finished successfully with the requested migration.",
      authorDisplayName: "Genie",
    }],
    hasMoreOlder: true,
    canLoadNewer: false,
    error: null,
    setQuery: () => {},
    setMode: () => {},
    setIgnoreCase: () => {},
    loadOlder: async () => false,
    loadNewer: async () => false,
    clear: () => {},
    ...overrides,
  };
}

describe("RoomTranscriptFindBar", () => {
  test("renders compact result controls without duplicating the message body", () => {
    const html = renderToStaticMarkup(
      <RoomTranscriptFindBar search={searchState()} open onClose={() => {}} />,
    );

    expect(html).toContain('data-testid="room-transcript-find-bar"');
    expect(html).toContain("Search in this chat");
    expect(html).toContain('checked=""');
    expect(html).toContain("Partial words");
    expect(html).toContain("Ignore case");
    expect(html).toContain("Result 1 of 1 on this page");
    expect(html).toContain("More older results available");
    expect(html).not.toContain("Genie");
    expect(html).not.toContain("The deployment finished successfully");
    expect(html).not.toContain("room-search-result-preview");
  });

  test("announces empty and invalid states without claiming a total", () => {
    const empty = renderToStaticMarkup(
      <RoomTranscriptFindBar search={searchState({ status: "empty", hits: [] })} open onClose={() => {}} />,
    );
    const invalid = renderToStaticMarkup(
      <RoomTranscriptFindBar search={searchState({ status: "invalid", error: "Enter a search term." })} open onClose={() => {}} />,
    );

    expect(empty).toContain('role="status"');
    expect(empty).toContain("No matching messages.");
    expect(invalid).toContain('role="alert"');
    expect(invalid).toContain("Enter a search term.");
    expect(empty).not.toContain("of 0");
  });

  test("keeps loading and request-error copy bounded and exposes navigation totals", () => {
    const loading = renderToStaticMarkup(
      <RoomTranscriptFindBar search={searchState({ status: "loading", hits: [] })} open onClose={() => {}} />,
    );
    const error = renderToStaticMarkup(
      <RoomTranscriptFindBar
        search={searchState({ status: "error", error: "Search could not be completed." })}
        open
        onClose={() => {}}
        ordinal={21}
        totalLabel="40+"
      />,
    );

    expect(loading).toContain("Searching in this chat…");
    expect(error).toContain('role="alert"');
    expect(error).toContain("Search could not be completed.");
    expect(error).toContain("Result 21 of 40+");
  });

  test("bounds transcript activation feedback, retry, highlight, and return-to-latest affordances", () => {
    const html = renderToStaticMarkup(
      <RoomTranscriptFindBar
        search={searchState()}
        open
        onClose={() => {}}
        activationState={{ state: "failed", messageId: 42 }}
        onRetryActivation={() => {}}
        showReturnToLatest
        onReturnToLatest={() => {}}
        highlightedMessageId={42}
      />,
    );

    expect(html).toContain("Could not open the selected message.");
    expect(html).toContain("Retry opening message");
    expect(html).toContain("Return to latest");
    expect(html).not.toContain("Opened selected message in transcript.");
  });

  test("uses one concise live status region when the selected result is highlighted", () => {
    const html = renderToStaticMarkup(
      <RoomTranscriptFindBar search={searchState()} open onClose={() => {}} highlightedMessageId={42} />,
    );
    const container = happyWindow.document.createElement("div");
    container.innerHTML = html;

    expect(container.textContent).toContain("Opened selected message in transcript.");
    expect(container.querySelectorAll('[role="status"], [aria-live]').length).toBe(1);
  });

  test("keeps each transcript-direction arrow disabled only by its own action, boundary, or activation", () => {
    const renderButtons = (props: Partial<ComponentProps<typeof RoomTranscriptFindBar>>) => {
      const html = renderToStaticMarkup(
        <RoomTranscriptFindBar search={searchState()} open onClose={() => {}} {...props} />,
      );
      const container = happyWindow.document.createElement("div");
      container.innerHTML = html;
      return {
        older: container.querySelector("button[aria-label='Older search result']") as HTMLButtonElement,
        newer: container.querySelector("button[aria-label='Newer search result']") as HTMLButtonElement,
      };
    };

    expect(renderButtons({ onNext: () => {}, nextDisabled: false }).older.disabled).toBe(false);
    expect(renderButtons({ nextDisabled: false }).older.disabled).toBe(true);
    expect(renderButtons({ onNext: () => {}, nextDisabled: true }).older.disabled).toBe(true);
    expect(renderButtons({
      onNext: () => {},
      nextDisabled: false,
      activationState: { state: "hydrating", messageId: 42 },
    }).older.disabled).toBe(true);

    expect(renderButtons({ onPrevious: () => {}, previousDisabled: false }).newer.disabled).toBe(false);
    expect(renderButtons({ previousDisabled: false }).newer.disabled).toBe(true);
    expect(renderButtons({ onPrevious: () => {}, previousDisabled: true }).newer.disabled).toBe(true);
    expect(renderButtons({
      onPrevious: () => {},
      previousDisabled: false,
      activationState: { state: "hydrating", messageId: 42 },
    }).newer.disabled).toBe(true);
  });

  test("wires transcript-direction arrows and leaves keyboard semantics independent", () => {
    const onClose = mock(() => {});
    const onPrevious = mock(() => {});
    const onNext = mock(() => {});
    const container = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(container);
    domRoot = createRoot(container as unknown as Element);
    act(() => {
      domRoot?.render(
        <RoomTranscriptFindBar
          search={searchState()}
          open
          onClose={onClose}
          onPrevious={onPrevious}
          onNext={onNext}
          previousDisabled={false}
          nextDisabled={false}
        />,
      );
    });

    const older = container.querySelector("button[aria-label='Older search result']") as HTMLButtonElement;
    const newer = container.querySelector("button[aria-label='Newer search result']") as HTMLButtonElement;
    const escape = new happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const arrow = new happyWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    act(() => {
      older.click();
      newer.click();
      older.dispatchEvent(escape);
      older.dispatchEvent(arrow);
    });

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
    expect(arrow.defaultPrevented).toBe(false);
  });

  test("renders Ignore case as a real checked control and forwards changes", () => {
    const setIgnoreCase = mock(() => {});
    const container = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(container);
    domRoot = createRoot(container as unknown as Element);
    act(() => {
      domRoot?.render(
        <RoomTranscriptFindBar
          search={searchState({ ignoreCase: true, setIgnoreCase })}
          open
          onClose={() => {}}
        />,
      );
    });
    const checkbox = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes("Ignore case"));
    expect(checkbox?.checked).toBe(true);
    act(() => checkbox?.click());
    expect(setIgnoreCase).toHaveBeenCalledWith(false);
  });
});
