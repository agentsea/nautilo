/**
 * M055 — `MenuOptions.auth` shape + Account submenu rendering.
 *
 * Pure shape unit tests: the Electron Menu builder runs in main and
 * needs the `electron` module, which we don't have under bun:test.
 * What we CAN test is the typed `MenuAuthOptions` contract — that the
 * shape M055 added didn't accidentally drop a callback or change a
 * field name in a way main's MenuOptions builder won't compile
 * against. The real menu-clicks integration is a manual smoke (see
 * the verification block in ISSUE-M055).
 */
import { describe, expect, test } from "bun:test";
// Type-only imports so the electron-bound module body is never
// evaluated under bun:test (importing it would pull the real
// `electron` package and fail outside an Electron runtime).
import type {
  MenuAuthOptions,
  MenuOptions,
} from "../../electron/menu";

describe("MenuAuthOptions contract (M055)", () => {
  test("signed-out auth options still expose Account submenu callbacks", () => {
    const auth: MenuAuthOptions = {
      status: "ready",
      signedIn: false,
      onSignIn: () => {},
      onSignOut: () => {},
      onChangePassword: () => {},
      onChangePinMenu: () => {},
      onRestorePinMenu: () => {},
      onManageDevices: () => {},
    };
    expect(auth.signedIn).toBe(false);
    expect(typeof auth.onSignIn).toBe("function");
    expect(typeof auth.onSignOut).toBe("function");
    expect(typeof auth.onChangePassword).toBe("function");
    expect(typeof auth.onChangePinMenu).toBe("function");
    expect(typeof auth.onRestorePinMenu).toBe("function");
    expect(typeof auth.onManageDevices).toBe("function");
  });

  test("logto-mode auth options carry every callback the menu needs", () => {
    let signInCount = 0;
    let signOutCount = 0;
    let manageCount = 0;
    let changeCount = 0;
    let changePinCount = 0;
    let restorePinCount = 0;
    const auth: MenuAuthOptions = {
      status: "ready",
      signedIn: false,
      onSignIn: () => {
        signInCount += 1;
      },
      onSignOut: () => {
        signOutCount += 1;
      },
      onChangePassword: () => {
        changeCount += 1;
      },
      onChangePinMenu: () => {
        changePinCount += 1;
      },
      onRestorePinMenu: () => {
        restorePinCount += 1;
      },
      onManageDevices: () => {
        manageCount += 1;
      },
    };
    auth.onSignIn();
    auth.onSignOut();
    auth.onChangePassword();
    auth.onChangePinMenu();
    auth.onRestorePinMenu();
    auth.onManageDevices();
    expect(signInCount).toBe(1);
    expect(signOutCount).toBe(1);
    expect(changeCount).toBe(1);
    expect(changePinCount).toBe(1);
    expect(restorePinCount).toBe(1);
    expect(manageCount).toBe(1);
  });

  test("MenuOptions.auth is required (compile-time + runtime presence)", () => {
    // If a future refactor drops the `auth` field from MenuOptions,
    // this test fails to typecheck. The runtime assertion is just
    // belt-and-braces.
    const opts: MenuOptions = {
      recentCurrentFolders: ["/x"],
      onCommitCurrentFolder: () => {},
      onOpenFolder: () => {},
      onSwitchServer: () => {},
      auth: {
        status: "ready",
        signedIn: true,
        onSignIn: () => {},
        onSignOut: () => {},
        onChangePassword: () => {},
        onChangePinMenu: () => {},
        onRestorePinMenu: () => {},
        onManageDevices: () => {},
      },
    };
    expect(opts.auth?.signedIn).toBe(true);
    expect(typeof opts.onSwitchServer).toBe("function");
  });
});
