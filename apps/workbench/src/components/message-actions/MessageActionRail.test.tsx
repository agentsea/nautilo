import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { ReactNode } from "react";
import type { MessageActionDescriptor } from "@nautilo/types";

let happyWindow: Window;
let container: HTMLDivElement;
let root: Root;
let MessageActionRail: (typeof import("./MessageActionRail"))["MessageActionRail"];

const allRoomDescriptors: readonly MessageActionDescriptor[] = [
  { id: "reply", accessibleLabel: "Reply", destructive: false },
  { id: "react", accessibleLabel: "React", destructive: false },
  { id: "reply-in-thread", accessibleLabel: "Reply in thread", destructive: false },
  { id: "copy", accessibleLabel: "Copy message", destructive: false },
  { id: "edit", accessibleLabel: "Edit message", destructive: false },
  { id: "delete", accessibleLabel: "Delete message", destructive: true },
];

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });
  mock.module("../emoji/EmojiPickerPopover", () => ({
    EmojiPickerPopover: () => null,
  }));
  ({ MessageActionRail } = await import("./MessageActionRail"));
});

afterAll(() => {
  mock.restore();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function mount(
  alwaysVisible: boolean,
  onReply = () => undefined,
  leading?: ReactNode,
  onEdit = () => undefined,
) {
  container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <div className="group">
        <MessageActionRail
          descriptors={allRoomDescriptors}
          alwaysVisible={alwaysVisible}
          leading={leading}
          onReact={() => undefined}
          onReply={onReply}
          onReplyInThread={() => undefined}
          onCopy={() => undefined}
          onEdit={onEdit}
          onDelete={() => undefined}
        />
      </div>,
    );
  });
}

function unmount() {
  act(() => root.unmount());
  container.remove();
}

describe("MessageActionRail", () => {
  test("renders the shared room order as neutral icon buttons", () => {
    mount(true);
    expect(
      Array.from(container.querySelectorAll("[data-testid^='message-action-rail-']")).map(
        (element) => element.getAttribute("data-testid"),
      ),
    ).toEqual([
      "message-action-rail-slot",
      "message-action-rail-reply",
      "message-action-rail-reply-in-thread",
      "message-action-rail-copy",
      "message-action-rail-edit",
      "message-action-rail-delete",
    ]);
    const react = container.querySelector("[data-testid='message-react-trigger']");
    expect(react?.getAttribute("aria-label")).toBe("React");
    expect(react?.getAttribute("title")).toBe("React");
    const deleteButton = container.querySelector("[data-testid='message-action-rail-delete']");
    expect(deleteButton?.className).toContain("text-foreground-muted");
    expect(deleteButton?.className).toContain("hover:text-red-500");
    expect(deleteButton?.className).toContain("focus:text-red-500");
    expect(deleteButton?.className).toContain("active:text-red-500");
    expect(deleteButton?.className).toContain("hidden group-hover:flex");
    unmount();
  });

  test("keeps an older row's fixed slot while its controls are hover/focus revealed", () => {
    mount(false);
    const slot = container.querySelector("[data-testid='message-action-rail-slot']");
    const rail = container.querySelector("[data-testid='message-action-rail']");
    expect(slot?.className).toContain("h-8");
    expect(rail?.className).toContain("opacity-0");
    expect(rail?.className).toContain("group-hover:opacity-100");
    expect(rail?.className).toContain("group-focus-within:opacity-100");
    expect(container.querySelector("[data-testid='message-action-rail-delete']")?.className).not.toContain("hidden");
    unmount();
  });

  test("places persistent thread replies before the action icons in one footer", () => {
    mount(false, undefined, <button data-testid="thread-replies">4 replies</button>);
    const slot = container.querySelector("[data-testid='message-action-rail-slot']");
    expect(slot?.className).toContain("gap-1");
    expect(slot?.firstElementChild?.getAttribute("data-testid")).toBe(
      "thread-replies",
    );
    expect(slot?.lastElementChild?.getAttribute("data-testid")).toBe(
      "message-action-rail",
    );
    unmount();
  });

  test("binds existing action handlers", () => {
    const calls: string[] = [];
    mount(true, () => calls.push("reply"), undefined, () => calls.push("edit"));
    act(() => {
      (container.querySelector("[data-testid='message-action-rail-reply']") as HTMLButtonElement).click();
      (container.querySelector("[data-testid='message-action-rail-edit']") as HTMLButtonElement).click();
    });
    expect(calls).toEqual(["reply", "edit"]);
    unmount();
  });
});
