import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};
let container: HTMLDivElement;
let root: Root;

let MessageReactTrigger: (typeof import("./MessageReactTrigger"))["MessageReactTrigger"];

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const k of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });

  mock.module("../../../../components/emoji/EmojiPickerPopover", () => ({
    EmojiPickerPopover: ({
      open,
      onSelect,
      onClose,
      popoverTestId,
    }: {
      open: boolean;
      onSelect: (emoji: string) => void;
      onClose: () => void;
      popoverTestId?: string;
    }) =>
      open ? (
        <div data-testid={popoverTestId ?? "emoji-picker-popover"}>
          <button
            type="button"
            data-testid="mock-emoji"
            onClick={() => {
              onSelect("👍");
              onClose();
            }}
          >
            👍
          </button>
          <button type="button" data-testid="mock-close" onClick={onClose}>
            close
          </button>
        </div>
      ) : null,
    computeComposerEmojiPopoverPosition: () => ({ left: 0, bottom: 0 }),
  }));

  ({ MessageReactTrigger } = await import("./MessageReactTrigger"));
});

afterAll(() => {
  mock.restore();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete g[key];
    else g[key] = priorGlobals[key];
  }
});

function mount(
  onReact: (emoji: string) => void,
  disabled = false,
  accessibleLabel?: string,
  title?: string,
) {
  container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MessageReactTrigger
        onReact={onReact}
        disabled={disabled}
        accessibleLabel={accessibleLabel}
        title={title}
      />,
    );
  });
}

function unmount() {
  act(() => {
    root.unmount();
  });
  container.remove();
}

describe("MessageReactTrigger", () => {
  test("renders add-reaction affordance with stable test id", () => {
    mount(() => undefined);
    const trigger = container.querySelector('[data-testid="message-react-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe("Add reaction");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    unmount();
  });

  test("accepts an exact caller-provided accessibility label and title", () => {
    mount(() => undefined, false, "React", "React");
    const trigger = container.querySelector('[data-testid="message-react-trigger"]');
    expect(trigger?.getAttribute("aria-label")).toBe("React");
    expect(trigger?.getAttribute("title")).toBe("React");
    unmount();
  });

  test("click opens picker and selecting emoji calls onReact", () => {
    const reacted: string[] = [];
    mount((emoji) => reacted.push(emoji));

    const trigger = container.querySelector(
      '[data-testid="message-react-trigger"]',
    ) as HTMLButtonElement;
    act(() => {
      trigger.click();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="message-react-popover"]')).not.toBeNull();

    const emoji = container.querySelector('[data-testid="mock-emoji"]') as HTMLButtonElement;
    act(() => {
      emoji.click();
    });
    expect(reacted).toEqual(["👍"]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    unmount();
  });

  test("long-press (~400ms) opens picker without requiring click", async () => {
    const reacted: string[] = [];
    mount((emoji) => reacted.push(emoji));

    const trigger = container.querySelector(
      '[data-testid="message-react-trigger"]',
    ) as HTMLButtonElement;

    act(() => {
      trigger.dispatchEvent(new happyWindow.PointerEvent("pointerdown", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 420));
    act(() => {
      trigger.dispatchEvent(new happyWindow.PointerEvent("pointerup", { bubbles: true }));
    });

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="message-react-popover"]')).not.toBeNull();
    unmount();
  });

  test("disabled trigger does not open on click", () => {
    mount(() => undefined, true);
    const trigger = container.querySelector(
      '[data-testid="message-react-trigger"]',
    ) as HTMLButtonElement;
    act(() => {
      trigger.click();
    });
    expect(container.querySelector('[data-testid="message-react-popover"]')).toBeNull();
    unmount();
  });
});
