import "../bun-dom-preload";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { ComposerSendButton } from "../../src/components/composer/ComposerSendButton";

describe("ComposerSendButton", () => {
  test("presents a disabled, busy send control while the request is pending", () => {
    const onSend = mock(() => {});
    const view = render(
      <ComposerSendButton
        disabled
        pending
        disabledTitle={undefined}
        onSend={onSend}
      />,
    );

    const button = view.getByRole("button", { name: "Sending message" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("title")).toBe("Sending message…");
    fireEvent.click(button);
    expect(onSend).not.toHaveBeenCalled();
  });

  test("sends once when the control is available", () => {
    const onSend = mock(() => {});
    const view = render(
      <ComposerSendButton
        disabled={false}
        pending={false}
        disabledTitle={undefined}
        onSend={onSend}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
