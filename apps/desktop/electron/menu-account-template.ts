/**
 * M106 — Account submenu template builder.
 *
 * Extracted from menu.ts so it can be unit-tested without `electron`'s
 * runtime named exports (`app`, `dialog`, `Menu`, `shell`) — those are
 * missing on CI's Linux electron stub and would fail static named-import
 * validation. Type-only imports are erased and remain safe.
 */
import type { MenuItemConstructorOptions } from "electron";

export interface MenuAuthOptions {
  signedIn: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  /** M101 Phase 4 — open Logto `/account/password` in the embedded auth window. */
  onChangePassword: () => void;
  onChangePinMenu: () => void;
  onRestorePinMenu: () => void;
  onManageDevices: () => void;
}

export function buildAccountSubmenu(
  auth: MenuAuthOptions,
): MenuItemConstructorOptions[] {
  return [
    {
      label: "Sign In…",
      enabled: !auth.signedIn,
      click: () => auth.onSignIn(),
    },
    {
      label: "Sign Out",
      enabled: auth.signedIn,
      click: () => auth.onSignOut(),
    },
    { type: "separator" },
    {
      label: "Change password…",
      enabled: auth.signedIn,
      click: () => auth.onChangePassword(),
    },
    {
      label: "Change PIN…",
      enabled: auth.signedIn,
      click: () => auth.onChangePinMenu(),
    },
    {
      label: "Restore PIN…",
      enabled: auth.signedIn,
      click: () => auth.onRestorePinMenu(),
    },
    { type: "separator" },
    {
      label: "Manage devices…",
      enabled: auth.signedIn,
      click: () => auth.onManageDevices(),
    },
  ];
}
