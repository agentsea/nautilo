import { describe, expect, test } from "bun:test";

import {
  applyRootInterfaceEntry,
  hasWritableInterfacePreferenceStorage,
  readInterfacePreference,
  readRootInterfaceOverride,
  selectRootInterface,
  type RootEntryBrowser,
  writeInterfacePreference,
} from "../../src/lib/interface-preference";

class MemoryStorage {
  readonly values = new Map<string, string>();
  fail = false;
  getItem(key: string): string | null {
    if (this.fail) throw new Error("blocked");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.fail) throw new Error("blocked");
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    if (this.fail) throw new Error("blocked");
    this.values.delete(key);
  }
}

function input(overrides: Partial<Parameters<typeof selectRootInterface>[0]> = {}) {
  return {
    pathname: "/",
    search: "",
    hash: "",
    isDesktop: false,
    hasCoarsePrimaryPointer: true,
    screenWidth: 390,
    screenHeight: 844,
    preference: { kind: "absent" } as const,
    storageWritable: true,
    ...overrides,
  };
}

function browser(pathname = "/", search = "", hash = "", storage = new MemoryStorage()) {
  const calls = { replaced: [] as string[], scrubbed: [] as string[] };
  return {
    browser: {
      location: {
        pathname,
        search,
        hash,
        replace: (url: string) => calls.replaced.push(url),
      },
      history: { state: null, replaceState: (_state: unknown, _title: string, url?: string | URL | null) => calls.scrubbed.push(String(url)) },
      localStorage: storage,
      matchMedia: () => ({ matches: true }),
      screen: { width: 390, height: 844 },
    } as unknown as RootEntryBrowser,
    calls,
    storage,
  };
}

describe("D515 interface preference", () => {
  test("selects an obvious first-visit handset, including 744px, in either orientation", () => {
    expect(selectRootInterface(input())).toEqual({ kind: "redirect-mobile" });
    expect(selectRootInterface(input({ screenWidth: 744, screenHeight: 1133 }))).toEqual({ kind: "redirect-mobile" });
    expect(selectRootInterface(input({ screenWidth: 844, screenHeight: 390 }))).toEqual({ kind: "redirect-mobile" });
  });

  test("leaves 768px, fine-pointer, narrowed laptops, Electron, paths, and bad storage in Workbench", () => {
    for (const overrides of [
      { screenWidth: 768, screenHeight: 1024 },
      { screenWidth: 767, screenHeight: 1024, hasCoarsePrimaryPointer: false },
      { screenWidth: 1440, screenHeight: 900 },
      { isDesktop: true },
      { pathname: "/settings" },
      { search: "?x=1" },
      { hash: "#secret" },
      { preference: { kind: "corrupt" } as const },
      { preference: { kind: "unavailable" } as const },
      { storageWritable: false },
    ]) expect(selectRootInterface(input(overrides))).toEqual({ kind: "continue" });
  });

  test("valid saved choices win before classifier input", () => {
    expect(selectRootInterface(input({ preference: { kind: "valid", preference: "mobile" } }))).toEqual({ kind: "redirect-mobile" });
    expect(selectRootInterface(input({ preference: { kind: "valid", preference: "workbench" } }))).toEqual({ kind: "continue" });
  });

  test("accepts only the exact namespaced root override", () => {
    expect(readRootInterfaceOverride({ pathname: "/", search: "?nautilo-interface=mobile", hash: "" })).toBe("mobile");
    expect(readRootInterfaceOverride({ pathname: "/", search: "?nautilo-interface=workbench", hash: "" })).toBe("workbench");
    for (const value of [
      { pathname: "/settings", search: "?nautilo-interface=mobile", hash: "" },
      { pathname: "/", search: "?nautilo-interface=mobile&x=1", hash: "" },
      { pathname: "/", search: "?nautilo-interface=mobile", hash: "#token=secret" },
      { pathname: "/", search: "?interface=mobile", hash: "" },
      { pathname: "/", search: "?nautilo-interface=mobile%20", hash: "" },
    ]) expect(readRootInterfaceOverride(value)).toBeNull();
  });

  test("writes only explicit choices and proves automatic-storage admission by round trip", () => {
    const storage = new MemoryStorage();
    expect(readInterfacePreference(storage)).toEqual({ kind: "absent" });
    expect(hasWritableInterfacePreferenceStorage(storage)).toBe(true);
    expect(writeInterfacePreference(storage, "mobile")).toBe(true);
    expect(readInterfacePreference(storage)).toEqual({ kind: "valid", preference: "mobile" });
    storage.values.set("nautilo.interface-preference.v1", "surprise");
    expect(readInterfacePreference(storage)).toEqual({ kind: "corrupt" });
    storage.fail = true;
    expect(hasWritableInterfacePreferenceStorage(storage)).toBe(false);
    expect(writeInterfacePreference(storage, "workbench")).toBe(false);
  });

  test("denies admission and removes its probe when a storage read lies", () => {
    const storage = new MemoryStorage();
    const originalGet = storage.getItem.bind(storage);
    storage.getItem = (key) => key.endsWith("probe.v1") ? "different" : originalGet(key);
    expect(hasWritableInterfacePreferenceStorage(storage)).toBe(false);
    expect(storage.values.has("nautilo.interface-preference.probe.v1")).toBe(false);
  });

  test("quota/full storage denies automatic selection without changing a saved choice", () => {
    const full = new MemoryStorage();
    full.setItem("nautilo.interface-preference.v1", "mobile");
    full.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); };
    expect(hasWritableInterfacePreferenceStorage(full)).toBe(false);
    expect(readInterfacePreference(full)).toEqual({ kind: "valid", preference: "mobile" });
  });

  test("consumes, persists best-effort, and scrubs an exact override before honoring it", () => {
    const mobile = browser("/", "?nautilo-interface=mobile");
    expect(applyRootInterfaceEntry(mobile.browser, false)).toBe(true);
    expect(mobile.calls.scrubbed).toEqual(["/"]);
    expect(mobile.calls.replaced).toEqual(["/mobile/"]);
    expect(readInterfacePreference(mobile.storage)).toEqual({ kind: "valid", preference: "mobile" });

    const failed = browser("/", "?nautilo-interface=workbench");
    failed.storage.fail = true;
    expect(applyRootInterfaceEntry(failed.browser, false)).toBe(false);
    expect(failed.calls.scrubbed).toEqual(["/"]);
    expect(failed.calls.replaced).toEqual([]);
  });

  test("automatic selection uses replacement navigation and never reacts to deep paths", () => {
    const automatic = browser();
    expect(applyRootInterfaceEntry(automatic.browser, false)).toBe(true);
    expect(automatic.calls.replaced).toEqual(["/mobile/"]);
    const deep = browser("/settings");
    expect(applyRootInterfaceEntry(deep.browser, false)).toBe(false);
    expect(deep.calls.replaced).toEqual([]);
  });

  test("deep paths do not read storage, probe it, or inspect browser hardware", () => {
    const deep = browser("/settings");
    Object.defineProperties(deep.browser, {
      localStorage: { get: () => { throw new Error("must not read storage"); } },
      matchMedia: { value: () => { throw new Error("must not inspect pointer"); } },
      screen: { get: () => { throw new Error("must not inspect screen"); } },
    });
    expect(applyRootInterfaceEntry(deep.browser, false)).toBe(false);
    expect(deep.calls.replaced).toEqual([]);
  });

  test("saved choices do not probe storage or inspect browser hardware", () => {
    const mobile = browser();
    mobile.storage.setItem("nautilo.interface-preference.v1", "mobile");
    mobile.storage.setItem = () => { throw new Error("must not probe storage"); };
    mobile.storage.removeItem = () => { throw new Error("must not probe storage"); };
    Object.defineProperties(mobile.browser, {
      matchMedia: { value: () => { throw new Error("must not inspect pointer"); } },
      screen: { get: () => { throw new Error("must not inspect screen"); } },
    });
    expect(applyRootInterfaceEntry(mobile.browser, false)).toBe(true);
    expect(mobile.calls.replaced).toEqual(["/mobile/"]);

    const workbench = browser();
    workbench.storage.setItem("nautilo.interface-preference.v1", "workbench");
    workbench.storage.setItem = () => { throw new Error("must not probe storage"); };
    workbench.storage.removeItem = () => { throw new Error("must not probe storage"); };
    Object.defineProperties(workbench.browser, {
      matchMedia: { value: () => { throw new Error("must not inspect pointer"); } },
      screen: { get: () => { throw new Error("must not inspect screen"); } },
    });
    expect(applyRootInterfaceEntry(workbench.browser, false)).toBe(false);
    expect(workbench.calls.replaced).toEqual([]);
  });

  test("blocked localStorage getters cannot crash bootstrap or trigger automatic selection", () => {
    const blocked = browser();
    Object.defineProperty(blocked.browser, "localStorage", {
      get: () => { throw new Error("storage access denied"); },
    });
    expect(applyRootInterfaceEntry(blocked.browser, false)).toBe(false);
    expect(blocked.calls.replaced).toEqual([]);
  });

  test("failed absent-preference storage admission does not inspect browser hardware", () => {
    const blocked = browser();
    blocked.storage.fail = true;
    Object.defineProperties(blocked.browser, {
      matchMedia: { value: () => { throw new Error("must not inspect pointer"); } },
      screen: { get: () => { throw new Error("must not inspect screen"); } },
    });
    expect(applyRootInterfaceEntry(blocked.browser, false)).toBe(false);
    expect(blocked.calls.replaced).toEqual([]);
  });

  test("the selector boundary has no auth, API, realtime, Agent, or guide_user dependency", async () => {
    const source = await Bun.file(new URL("../../src/lib/interface-preference.ts", import.meta.url)).text();
    const imports = source.match(/^import[^;]+;/gm)?.join("\n") ?? "";
    expect(imports).not.toMatch(/(?:api|realtime|socket|Agent|guide_user|auth|capabilit)/i);
    expect(source).not.toMatch(/userAgent|userAgentData|setTimeout|setInterval|addEventListener/);
  });
});
