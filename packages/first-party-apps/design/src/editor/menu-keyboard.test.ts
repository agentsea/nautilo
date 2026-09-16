import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { focusMenu, installMenuKeyboard } from "./menu-keyboard";

function menuHarness() {
  const window = new Window();
  const trigger = window.document.createElement("button");
  trigger.textContent = "More";
  const menu = window.document.createElement("div");
  menu.setAttribute("role", "menu");
  const first = window.document.createElement("button");
  first.setAttribute("role", "menuitem");
  first.textContent = "First";
  const disabled = window.document.createElement("button");
  disabled.setAttribute("role", "menuitem");
  disabled.disabled = true;
  disabled.textContent = "Disabled";
  const hidden = window.document.createElement("button");
  hidden.setAttribute("role", "menuitem");
  hidden.hidden = true;
  hidden.textContent = "Hidden";
  const last = window.document.createElement("button");
  last.setAttribute("role", "menuitem");
  last.textContent = "Last";
  menu.append(first, disabled, hidden, last);
  window.document.body.append(trigger, menu);
  let closes = 0;
  const cleanup = installMenuKeyboard(menu as unknown as HTMLElement, trigger as unknown as HTMLElement, { close: () => { closes += 1; } });
  const key = (value: string) => new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  return { window, trigger, menu, first, last, cleanup, key, closes: () => closes };
}

describe("menu keyboard", () => {
  test("focuses and traverses enabled visible menu items", () => {
    const { window, menu, first, last, cleanup, key } = menuHarness();
    focusMenu(menu as unknown as HTMLElement);
    expect(window.document.activeElement).toBe(first);
    first.dispatchEvent(key("ArrowDown"));
    expect(window.document.activeElement).toBe(last);
    last.dispatchEvent(key("ArrowDown"));
    expect(window.document.activeElement).toBe(first);
    first.dispatchEvent(key("End"));
    expect(window.document.activeElement).toBe(last);
    last.dispatchEvent(key("Home"));
    expect(window.document.activeElement).toBe(first);
    cleanup();
  });

  test("closes on Escape or Tab and returns to the trigger only for Escape", () => {
    const { window, trigger, menu, first, cleanup, key, closes } = menuHarness();
    focusMenu(menu as unknown as HTMLElement);
    first.dispatchEvent(key("Escape"));
    expect(closes()).toBe(1);
    expect(window.document.activeElement).toBe(trigger);

    first.focus();
    first.dispatchEvent(key("Tab"));
    expect(closes()).toBe(2);
    expect(window.document.activeElement).toBe(first);
    cleanup();
  });
});
