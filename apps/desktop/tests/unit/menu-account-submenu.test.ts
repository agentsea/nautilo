/**
 * M106 — assert the Account submenu's actual item list and enablement
 * matrix. Separate from `menu.test.ts` (which only covers the
 * `MenuAuthOptions` type contract) because the issue's Phase 3
 * acceptance requires an automated test that catches drift in the
 * submenu shape — including the removal of "Paste reset URL…".
 *
 * Imports the pure template builder (no `electron` runtime), so this
 * runs everywhere `bun:test` runs.
 */
import { describe, expect, test } from "bun:test";
import {
  buildAccountSubmenu,
  type MenuAuthOptions,
} from "../../electron/menu-account-template";

function noop(): void {}

function authStub(signedIn: boolean): MenuAuthOptions {
  return {
    signedIn,
    onSignIn: noop,
    onSignOut: noop,
    onChangePassword: noop,
    onChangePinMenu: noop,
    onRestorePinMenu: noop,
    onManageDevices: noop,
  };
}

function labels(items: ReturnType<typeof buildAccountSubmenu>): Array<string | "---"> {
  return items.map((item) =>
    item.type === "separator" ? "---" : (item.label ?? ""),
  );
}

describe("Account submenu shape (M106)", () => {
  test("emits exactly the M106-prescribed item order", () => {
    expect(labels(buildAccountSubmenu(authStub(true)))).toEqual([
      "Sign In…",
      "Sign Out",
      "---",
      "Change password…",
      "Change PIN…",
      "Restore PIN…",
      "---",
      "Manage devices…",
    ]);
  });

  test("does not contain 'Paste reset URL…' (removed in M106)", () => {
    const out = labels(buildAccountSubmenu(authStub(true)));
    expect(out).not.toContain("Paste reset URL…");
  });

  test("enablement when signed-in: every credential op enabled, Sign In disabled", () => {
    const items = buildAccountSubmenu(authStub(true));
    const byLabel = new Map<string, (typeof items)[number]>();
    for (const it of items) {
      if (it.type !== "separator" && typeof it.label === "string") {
        byLabel.set(it.label, it);
      }
    }
    expect(byLabel.get("Sign In…")?.enabled).toBe(false);
    expect(byLabel.get("Sign Out")?.enabled).toBe(true);
    expect(byLabel.get("Change password…")?.enabled).toBe(true);
    expect(byLabel.get("Change PIN…")?.enabled).toBe(true);
    expect(byLabel.get("Restore PIN…")?.enabled).toBe(true);
    expect(byLabel.get("Manage devices…")?.enabled).toBe(true);
  });

  test("enablement when signed-out: Sign In enabled, signed-in ops disabled", () => {
    const items = buildAccountSubmenu(authStub(false));
    const enabledByLabel = new Map<string, boolean | undefined>();
    for (const it of items) {
      if (it.type !== "separator" && typeof it.label === "string") {
        enabledByLabel.set(it.label, it.enabled);
      }
    }
    expect(enabledByLabel.get("Sign In…")).toBe(true);
    expect(enabledByLabel.get("Sign Out")).toBe(false);
    expect(enabledByLabel.get("Change password…")).toBe(false);
    expect(enabledByLabel.get("Change PIN…")).toBe(false);
    expect(enabledByLabel.get("Restore PIN…")).toBe(false);
    expect(enabledByLabel.get("Manage devices…")).toBe(false);
  });

  test("clicks dispatch to the right callback", () => {
    const calls: string[] = [];
    const auth: MenuAuthOptions = {
      signedIn: true,
      onSignIn: () => calls.push("signIn"),
      onSignOut: () => calls.push("signOut"),
      onChangePassword: () => calls.push("changePassword"),
      onChangePinMenu: () => calls.push("changePin"),
      onRestorePinMenu: () => calls.push("restorePin"),
      onManageDevices: () => calls.push("manageDevices"),
    };
    const items = buildAccountSubmenu(auth);
    for (const it of items) {
      if (it.type === "separator") continue;
      // Electron passes (menuItem, browserWindow, event); for shape tests
      // we don't care, so invoke with no args.
      (it.click as undefined | (() => void))?.();
    }
    expect(calls).toEqual([
      "signIn",
      "signOut",
      "changePassword",
      "changePin",
      "restorePin",
      "manageDevices",
    ]);
  });
});
