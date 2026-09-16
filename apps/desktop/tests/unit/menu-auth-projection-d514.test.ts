/** D514 Phase 0 — Account menu remains valid before Logto discovery. */
import { describe, expect, test } from "bun:test";
import {
  buildAccountSubmenuForProjection,
  type MenuAuthProjection,
} from "../../electron/menu-auth-projection";
import { buildAccountSubmenu } from "../../electron/menu-account-template";

function readyAuth(): MenuAuthProjection {
  return {
    status: "ready",
    signedIn: false,
    onSignIn: () => {},
    onSignOut: () => {},
    onChangePassword: () => {},
    onChangePinMenu: () => {},
    onRestorePinMenu: () => {},
    onManageDevices: () => {},
  };
}

describe("D514 account menu auth projection", () => {
  test("unresolved Logto discovery produces a reduced disabled menu without auth callbacks", () => {
    const items = buildAccountSubmenuForProjection({ status: "unresolved" });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.label)).toEqual([
      "Account unavailable",
      "Reconnect to enable account actions",
    ]);
    for (const item of items) {
      expect(item.enabled).toBe(false);
      expect(item.click).toBeUndefined();
    }
  });

  test("a later resolved projection is the unchanged ordinary signed-out menu", () => {
    const auth = readyAuth();
    const items = buildAccountSubmenuForProjection(auth);
    const signIn = items.find((item) => item.label === "Sign In…");
    const signOut = items.find((item) => item.label === "Sign Out");

    expect(
      items.map(({ label, enabled, type }) => ({ label, enabled, type })),
    ).toEqual(
      buildAccountSubmenu(auth).map(({ label, enabled, type }) => ({
        label,
        enabled,
        type,
      })),
    );
    expect(signIn?.enabled).toBe(true);
    expect(typeof signIn?.click).toBe("function");
    expect(signOut?.enabled).toBe(false);
  });
});
