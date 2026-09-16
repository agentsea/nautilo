import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

let happyWindow: Window;
let container: HTMLDivElement;
let root: Root;
let ThreadContextMenu: (typeof import("../components/ThreadContextMenu"))["ThreadContextMenu"];

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });
  mock.module("../use-open-thread", () => ({ useOpenThread: () => () => undefined }));
  ({ ThreadContextMenu } = await import("../components/ThreadContextMenu"));
});

afterAll(() => {
  mock.restore();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function mount(
  surface: "room" | "subthread",
  onEdit = () => undefined,
  block: { blocked: boolean; onToggle: () => void } = {
    blocked: false,
    onToggle: () => undefined,
  },
) {
  container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <ThreadContextMenu
        parentRoomId={surface === "room" ? "room-1" : null}
        messageId={42}
        anchorX={0}
        anchorY={0}
        surface={surface}
        onClose={() => undefined}
        onCopy={() => undefined}
        onEdit={onEdit}
        block={block}
        onDelete={() => undefined}
      />,
    );
  });
}

function unmount() {
  act(() => root.unmount());
  container.remove();
}

describe("ThreadContextMenu", () => {
  test("keeps Edit in the secondary room context route and focuses the first action", () => {
    mount("room");
    expect(container.querySelector("[role='menu']")).not.toBeNull();
    expect(container.textContent).toContain("Edit message");
    expect(container.textContent).toContain("Open in thread");
    expect(
      Array.from(container.querySelectorAll("[role='menuitem']")).map((item) => item.textContent),
    ).toEqual(["Open in thread", "Copy message", "Edit message", "Block person", "Delete message"]);
    const deleteItem = Array.from(container.querySelectorAll("[role='menuitem']")).find(
      (item) => item.textContent === "Delete message",
    );
    expect(deleteItem?.className).toContain("text-foreground-muted");
    expect(deleteItem?.className).toContain("hover:text-red-500");
    expect(deleteItem?.className).toContain("focus:text-red-500");
    expect(deleteItem?.className).toContain("active:text-red-500");
    expect(happyWindow.document.activeElement?.textContent).toContain("Open in thread");
    unmount();
  });

  test("never offers nested thread navigation in a subthread", () => {
    mount("subthread");
    expect(container.textContent).not.toContain("Open in thread");
    expect(container.textContent).toContain("Copy message");
    expect(container.textContent).toContain("Edit message");
    expect(
      Array.from(container.querySelectorAll("[role='menuitem']")).map((item) => item.textContent),
    ).toEqual(["Copy message", "Edit message", "Block person", "Delete message"]);
    unmount();
  });

  test("executes the pre-authorized Edit callback", () => {
    const calls: string[] = [];
    mount("room", () => calls.push("edit"));
    const edit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Edit message"),
    ) as HTMLButtonElement;
    act(() => edit.click());
    expect(calls).toEqual(["edit"]);
    unmount();
  });

  test("toggles an existing Human block without presenting it as destructive", () => {
    const calls: string[] = [];
    mount("room", undefined, { blocked: true, onToggle: () => calls.push("unblock") });
    const unblock = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Unblock person"),
    ) as HTMLButtonElement;
    expect(unblock.className).not.toContain("hover:text-red-500");
    act(() => unblock.click());
    expect(calls).toEqual(["unblock"]);
    unmount();
  });
});
