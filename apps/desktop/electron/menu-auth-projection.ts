/**
 * D514 Phase 0 — account-menu projection when server authentication has not
 * been discovered yet.
 *
 * Menu construction is allowed before Logto discovery completes.  The menu
 * must therefore represent that fact rather than manufacture sign-in
 * callbacks which cannot safely start an auth flow.  Keeping this pure makes
 * the policy testable without Electron's runtime module.
 */
import type { MenuItemConstructorOptions } from "electron";
import {
  buildAccountSubmenu,
  type MenuAuthOptions as ResolvedMenuAuthOptions,
} from "./menu-account-template";

export type UnresolvedMenuAuthOptions = {
  /** Logto discovery is not currently authoritative for the active server. */
  status: "unresolved";
};

export type MenuAuthProjection =
  | ({ status: "ready" } & ResolvedMenuAuthOptions)
  | UnresolvedMenuAuthOptions;

/**
 * Render a reduced, non-actionable Account menu until the active server's
 * Logto configuration is available.  In particular, there is no Sign In
 * callback to invoke with a null endpoint/app id.
 */
export function buildAccountSubmenuForProjection(
  auth: MenuAuthProjection,
): MenuItemConstructorOptions[] {
  if (auth.status === "ready") {
    return buildAccountSubmenu(auth);
  }

  return [
    {
      label: "Account unavailable",
      enabled: false,
    },
    {
      label: "Reconnect to enable account actions",
      enabled: false,
    },
  ];
}
