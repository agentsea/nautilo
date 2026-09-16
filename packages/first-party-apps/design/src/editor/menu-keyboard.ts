/**
 * Keyboard behavior shared by the editor's small, caller-owned menus. The
 * caller controls open state and placement; this module only manages focus
 * while that menu is present.
 */

export type MenuKeyboardOptions = {
  close: () => void;
};

function isVisibleMenuItem(item: HTMLElement, menu: HTMLElement): boolean {
  if (item.hidden || item.hasAttribute("disabled") || item.getAttribute("aria-disabled") === "true") return false;
  for (let current: HTMLElement | null = item; current && current !== menu; current = current.parentElement) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
  }
  return true;
}

function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(
    '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], button, a[href], [tabindex]',
  )).filter((item) => isVisibleMenuItem(item, menu));
}

/** Focus the first enabled, visible item after the caller opens a menu. */
export function focusMenu(menu: HTMLElement): void {
  menuItems(menu)[0]?.focus();
}

/**
 * Install conventional in-menu navigation. Callers invoke `focusMenu` when
 * opening, and call the returned cleanup when the menu is permanently removed.
 */
export function installMenuKeyboard(
  menu: HTMLElement,
  trigger: HTMLElement,
  { close }: MenuKeyboardOptions,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const items = menuItems(menu);
    const active = menu.ownerDocument.activeElement as HTMLElement | null;
    const index = active ? items.indexOf(active) : -1;
    const focus = (nextIndex: number): void => {
      const target = items[nextIndex];
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        if (items.length > 0) focus(index === -1 || index === items.length - 1 ? 0 : index + 1);
        return;
      case "ArrowUp":
        if (items.length > 0) focus(index <= 0 ? items.length - 1 : index - 1);
        return;
      case "Home":
        focus(0);
        return;
      case "End":
        focus(items.length - 1);
        return;
      case "Escape":
        event.preventDefault();
        close();
        trigger.focus();
        return;
      case "Tab":
        // Do not trap Tab. The caller closes the menu while browser focus
        // continues through the surrounding document in its normal order.
        close();
        return;
      default:
        return;
    }
  };
  menu.addEventListener("keydown", onKeyDown);
  return () => menu.removeEventListener("keydown", onKeyDown);
}
