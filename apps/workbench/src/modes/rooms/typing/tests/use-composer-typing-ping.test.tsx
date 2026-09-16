import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useRef } from "react";
import { clearTypingPingSender, setTypingPingSender } from "../typing-bus";
import { useComposerTypingPing } from "../use-composer-typing-ping";

function ComposerProbe({ roomId = "child-room" }: { readonly roomId?: string | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useComposerTypingPing({ rootRef, roomId, displayName: "Alex" });
  return (
    <div ref={rootRef}>
      <div data-nautilo-composer-input>
        <div aria-label="Thread reply" contentEditable />
      </div>
      <button
        type="button"
        onClick={() => {
          const editable = rootRef.current?.querySelector<HTMLElement>("[contenteditable='true']");
          if (editable) editable.textContent = "restored draft";
        }}
      >
        Restore draft
      </button>
    </div>
  );
}

describe("useComposerTypingPing", () => {
  let now = 1_000_000;
  let originalNow: () => number;

  beforeEach(() => {
    reapplyHappyDomGlobals();
    globalThis.Element = window.Element;
    now = 1_000_000;
    originalNow = Date.now;
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = originalNow;
    clearTypingPingSender();
  });

  test("emits a child-room ping for a native edit, throttles it, and keeps programmatic restoration silent", () => {
    const sender = mock(() => {});
    setTypingPingSender(sender);
    const view = render(<ComposerProbe />);
    const editable = view.getByLabelText("Thread reply");

    fireEvent.click(view.getByText("Restore draft"));
    expect(sender).not.toHaveBeenCalled();

    fireEvent.input(editable, { inputType: "insertText", data: "h" });
    expect(sender).toHaveBeenCalledWith({
      type: "typing.ping",
      roomId: "child-room",
      displayName: "Alex",
    });

    fireEvent.input(editable, { inputType: "insertText", data: "i" });
    expect(sender).toHaveBeenCalledTimes(1);

    now += 10_000;
    fireEvent.input(editable, { inputType: "insertText", data: "!" });
    expect(sender).toHaveBeenCalledTimes(2);
  });

  test("makes the first genuine edit in a new child room immediately eligible", () => {
    const sender = mock(() => {});
    setTypingPingSender(sender);
    const view = render(<ComposerProbe roomId="child-A" />);
    const editable = view.getByLabelText("Thread reply");

    fireEvent.input(editable, { inputType: "insertText", data: "a" });
    view.rerender(<ComposerProbe roomId="child-B" />);
    fireEvent.input(view.getByLabelText("Thread reply"), { inputType: "insertText", data: "b" });

    expect(sender).toHaveBeenLastCalledWith({
      type: "typing.ping",
      roomId: "child-B",
      displayName: "Alex",
    });
    expect(sender).toHaveBeenCalledTimes(2);
  });
});
