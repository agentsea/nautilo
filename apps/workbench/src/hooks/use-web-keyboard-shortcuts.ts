/**
 * Global keyboard shortcut dispatcher (D077).
 *
 * On desktop the native macOS menu accelerators (`Cmd+Shift+B` /
 * `Cmd+Shift+I`) fire MenuAction events that useDesktopMenu dispatches
 * as the corresponding window events. On web there IS no native menu,
 * so this hook binds the same shortcuts to a `keydown` listener and
 * dispatches the same window events. Shell listens once, shortcut
 * works everywhere.
 *
 * Registered only when `!isDesktop` so we don't double-fire with the
 * native accelerators on packaged builds (Electron's menu click and a
 * global keydown listener both observe the keystroke).
 *
 * Kept in its own module rather than bolted onto `useDesktopMenu` so
 * the intent — "this exists purely for web parity" — stays legible.
 */

import { useEffect } from "react";
import { isDesktop } from "../lib/desktop";
import {
  MENU_TOGGLE_BROWSER_COLUMN_EVENT,
  MENU_TOGGLE_CONTEXT_PANEL_EVENT,
  MENU_TOGGLE_NAV_RAIL_EVENT,
} from "./use-desktop-menu";

export function useWebKeyboardShortcuts(): void {
  useEffect(() => {
    if (isDesktop) return;

    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || !e.shiftKey) return;

      // `KeyB` / `KeyI` / `Digit0` instead of `e.key` to sidestep
      // `shift` turning "b" into "B" across platforms / IMEs. Also
      // some keyboard layouts remap digit keys with shift (e.g.
      // French AZERTY shifted-0 is `à`), so keying on code is
      // layout-independent for both.
      if (e.code === "KeyB") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(MENU_TOGGLE_BROWSER_COLUMN_EVENT));
      } else if (e.code === "KeyI") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(MENU_TOGGLE_CONTEXT_PANEL_EVENT));
      } else if (e.code === "Digit0") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(MENU_TOGGLE_NAV_RAIL_EVENT));
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
