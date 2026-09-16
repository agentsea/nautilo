/**
 * D515 root-entry UX only. This deliberately knows nothing about auth, API,
 * realtime, capabilities, or client identity.
 */
export type InterfacePreference = "mobile" | "workbench";

export const INTERFACE_PREFERENCE_KEY = "nautilo.interface-preference.v1";
const INTERFACE_PREFERENCE_PROBE_KEY = "nautilo.interface-preference.probe.v1";
export const INTERFACE_OVERRIDE_PARAMETER = "nautilo-interface";
const MOBILE_ENTRY_PATH = "/mobile/";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type InterfacePreferenceRead =
  | { kind: "absent" }
  | { kind: "valid"; preference: InterfacePreference }
  | { kind: "corrupt" }
  | { kind: "unavailable" };

export type RootInterfaceOverride = InterfacePreference | null;

export type InterfaceSelectionInput = Readonly<{
  pathname: string;
  search: string;
  hash: string;
  isDesktop: boolean;
  hasCoarsePrimaryPointer: boolean;
  screenWidth: number;
  screenHeight: number;
  preference: InterfacePreferenceRead;
  storageWritable: boolean;
}>;

export type InterfaceSelection =
  | { kind: "continue" }
  | { kind: "redirect-mobile" };

function isInterfacePreference(value: string | null): value is InterfacePreference {
  return value === "mobile" || value === "workbench";
}

/** Read a single origin-local, non-secret UX preference without throwing. */
export function readInterfacePreference(storage: StorageLike | null | undefined): InterfacePreferenceRead {
  if (!storage) return { kind: "unavailable" };
  try {
    const value = storage.getItem(INTERFACE_PREFERENCE_KEY);
    if (value === null) return { kind: "absent" };
    return isInterfacePreference(value)
      ? { kind: "valid", preference: value }
      : { kind: "corrupt" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Explicit switching is best-effort: navigation must still work if it fails. */
export function writeInterfacePreference(
  storage: StorageLike | null | undefined,
  preference: InterfacePreference,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(INTERFACE_PREFERENCE_KEY, preference);
    return storage.getItem(INTERFACE_PREFERENCE_KEY) === preference;
  } catch {
    return false;
  }
}

/**
 * Automatic selection is allowed only when this bounded write/read/remove
 * probe succeeds. A failed cleanup is also a failed admission.
 */
export function hasWritableInterfacePreferenceStorage(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  let admitted = false;
  try {
    storage.setItem(INTERFACE_PREFERENCE_PROBE_KEY, "1");
    if (storage.getItem(INTERFACE_PREFERENCE_PROBE_KEY) !== "1") return false;
    storage.removeItem(INTERFACE_PREFERENCE_PROBE_KEY);
    admitted = storage.getItem(INTERFACE_PREFERENCE_PROBE_KEY) === null;
  } catch {
    admitted = false;
  } finally {
    try {
      storage.removeItem(INTERFACE_PREFERENCE_PROBE_KEY);
    } catch {
      admitted = false;
    }
  }
  return admitted;
}

/** Only the literal, non-secret root hint is accepted; variants are inert. */
export function readRootInterfaceOverride(location: Pick<Location, "pathname" | "search" | "hash">): RootInterfaceOverride {
  if (location.pathname !== "/" || location.hash) return null;
  if (location.search === `?${INTERFACE_OVERRIDE_PARAMETER}=mobile`) return "mobile";
  if (location.search === `?${INTERFACE_OVERRIDE_PARAMETER}=workbench`) return "workbench";
  return null;
}

/**
 * Pure selector used after an override has been dealt with. Direct/deep paths,
 * Electron, saved choices, bad storage, and ambiguous hardware stay put.
 */
export function selectRootInterface(input: InterfaceSelectionInput): InterfaceSelection {
  if (input.isDesktop || input.pathname !== "/" || input.search || input.hash) return { kind: "continue" };
  if (input.preference.kind === "valid") {
    return input.preference.preference === "mobile" ? { kind: "redirect-mobile" } : { kind: "continue" };
  }
  if (input.preference.kind !== "absent" || !input.storageWritable) return { kind: "continue" };
  const shortestScreenDimension = Math.min(input.screenWidth, input.screenHeight);
  return input.hasCoarsePrimaryPointer && shortestScreenDimension < 768
    ? { kind: "redirect-mobile" }
    : { kind: "continue" };
}

export type RootEntryBrowser = Readonly<{
  location: Pick<Location, "pathname" | "search" | "hash" | "replace">;
  history: Pick<History, "state" | "replaceState">;
  localStorage: StorageLike;
  matchMedia: (query: string) => Pick<MediaQueryList, "matches">;
  screen: Pick<Screen, "width" | "height">;
}>;

function scrubRootOverride(browser: RootEntryBrowser): void {
  browser.history.replaceState(browser.history.state, "", "/");
}

function safeLocalStorage(browser: RootEntryBrowser): StorageLike | null {
  try {
    return browser.localStorage;
  } catch {
    return null;
  }
}

/**
 * Consume the one-navigation root hint before any Workbench bootstrap. This
 * returns true only after issuing replacement navigation to Mobile.
 */
export function applyRootInterfaceEntry(
  browser: RootEntryBrowser,
  isDesktop: boolean,
): boolean {
  if (isDesktop) return false;
  const override = readRootInterfaceOverride(browser.location);
  if (override) {
    const storage = safeLocalStorage(browser);
    writeInterfacePreference(storage, override);
    scrubRootOverride(browser);
    if (override === "mobile") {
      browser.location.replace(MOBILE_ENTRY_PATH);
      return true;
    }
    return false;
  }

  if (browser.location.pathname !== "/" || browser.location.search || browser.location.hash) return false;

  const storage = safeLocalStorage(browser);
  const preference = readInterfacePreference(storage);
  if (preference.kind === "valid") {
    if (preference.preference === "mobile") {
      browser.location.replace(MOBILE_ENTRY_PATH);
      return true;
    }
    return false;
  }
  if (preference.kind !== "absent") return false;
  const storageWritable = hasWritableInterfacePreferenceStorage(storage);
  if (!storageWritable) return false;

  const selection = selectRootInterface({
    pathname: browser.location.pathname,
    search: browser.location.search,
    hash: browser.location.hash,
    isDesktop,
    hasCoarsePrimaryPointer: browser.matchMedia("(pointer: coarse)").matches,
    screenWidth: browser.screen.width,
    screenHeight: browser.screen.height,
    preference,
    storageWritable,
  });
  if (selection.kind === "redirect-mobile") {
    browser.location.replace(MOBILE_ENTRY_PATH);
    return true;
  }
  return false;
}

/** Browser-only explicit links use this best-effort persistence helper. */
export function rememberMobileInterfaceChoice(): void {
  if (typeof window === "undefined") return;
  try {
    writeInterfacePreference(window.localStorage, "mobile");
  } catch {
    // An ordinary anchor still owns navigation when browser storage is denied.
  }
}
