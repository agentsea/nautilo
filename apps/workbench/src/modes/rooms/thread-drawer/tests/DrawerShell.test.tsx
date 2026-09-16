import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { DrawerProvider } from "../drawer-state";
import { DrawerShell } from "../components/DrawerShell";

beforeEach(reapplyHappyDomGlobals);
afterEach(cleanup);

describe("DrawerShell", () => {
  test("uses a temporary surface close action for the button and Escape", () => {
    const close = mock(() => {});
    const view = render(
      <DrawerProvider>
        <DrawerShell title="Events" onClose={close}>
          <div>Event feed</div>
        </DrawerShell>
      </DrawerProvider>,
    );

    fireEvent.click(view.getByRole("button", { name: "Close Events" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(close).toHaveBeenCalledTimes(2);
  });
});
