/** D103 — isolated updater policy tests. No Electron module or network is loaded. */
import { describe, expect, test } from "bun:test";
import {
  UpdateController,
  sanitizeUpdateInfo,
  sanitizeUpdaterError,
  type ElectronUpdaterFacade,
  type UpdateControllerUi,
  type UpdaterEvent,
  type UpdaterTimers,
} from "../../electron/updater";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

class FakeUpdater implements ElectronUpdaterFacade {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;
  checkFailure: Error | null = null;
  downloadFailure: Error | null = null;
  checkDeferred: Deferred<unknown> | null = null;
  downloadDeferred: Deferred<unknown> | null = null;
  latestVersion: string | null = null;
  private readonly listeners = new Map<UpdaterEvent, Set<(...args: unknown[]) => void>>();

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    if (this.checkDeferred) await this.checkDeferred.promise;
    if (this.checkFailure) throw this.checkFailure;
    if (this.latestVersion) this.emit("update-available", { version: this.latestVersion });
    return undefined;
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1;
    if (this.downloadDeferred) return this.downloadDeferred.promise;
    if (this.downloadFailure) throw this.downloadFailure;
    return undefined;
  }

  quitAndInstall(): void {
    this.installCalls += 1;
  }

  on(event: UpdaterEvent, listener: (...args: unknown[]) => void): void {
    const handlers = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
    handlers.add(listener);
    this.listeners.set(event, handlers);
  }

  removeListener(event: UpdaterEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: UpdaterEvent, ...args: unknown[]): void {
    if (event === "update-available") {
      const version = args[0] && typeof args[0] === "object" ? (args[0] as { version?: unknown }).version : null;
      this.latestVersion = typeof version === "string" ? version : null;
    }
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, handlers) => total + handlers.size, 0);
  }
}

class FakeTimers implements UpdaterTimers {
  readonly timeouts: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  readonly intervals: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];

  setTimeout(callback: () => void, delayMs: number): unknown {
    const timer = { callback, delayMs, cleared: false };
    this.timeouts.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }

  setInterval(callback: () => void, delayMs: number): unknown {
    const timer = { callback, delayMs, cleared: false };
    this.intervals.push(timer);
    return timer;
  }

  clearInterval(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }

  fireTimeout(index = 0): void {
    const timer = this.timeouts[index];
    if (timer && !timer.cleared) timer.callback();
  }

  fireInterval(index = 0): void {
    const timer = this.intervals[index];
    if (timer && !timer.cleared) timer.callback();
  }
}

function makeUi(overrides: Partial<UpdateControllerUi> = {}) {
  const calls = {
    available: [] as string[],
    ready: [] as string[],
    noUpdate: 0,
    errors: [] as string[],
  };
  const ui: UpdateControllerUi = {
    showAvailable: (update) => {
      calls.available.push(update.version);
      return "later";
    },
    showReady: (update) => {
      calls.ready.push(update.version);
      return "later";
    },
    showNoUpdate: () => {
      calls.noUpdate += 1;
    },
    showError: (error) => {
      calls.errors.push(error.message);
    },
    ...overrides,
  };
  return { ui, calls };
}

function createController(overrides: {
  enabled?: boolean;
  updater?: FakeUpdater;
  timers?: FakeTimers;
  ui?: UpdateControllerUi;
  beforeInstall?: () => Promise<boolean> | boolean;
} = {}) {
  const updater = overrides.updater ?? new FakeUpdater();
  const timers = overrides.timers ?? new FakeTimers();
  const ui = overrides.ui ?? makeUi().ui;
  const controller = new UpdateController({
    updater,
    timers,
    ui,
    productionFeedEnabled: overrides.enabled ?? true,
    disabledReason: "test",
    startupDelayMs: 7,
    periodicCheckMs: 11,
    ...(overrides.beforeInstall ? { beforeInstall: overrides.beforeInstall } : {}),
  });
  return { controller, updater, timers, ui };
}

describe("D103 UpdateController — production gate and explicit updater flags", () => {
  test("disabled modes never initialize, subscribe to, schedule, or call updater", async () => {
    const { controller, updater, timers } = createController({ enabled: false });

    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.listenerCount()).toBe(0);
    expect(controller.getState()).toEqual({ kind: "disabled", reason: "test" });
    expect(controller.getSanitizedStatus()).toEqual({ kind: "hidden" });
    expect(controller.startScheduling()).toBe(false);
    expect(await controller.checkNow()).toEqual({ accepted: false, reason: "disabled" });
    expect(updater.checkCalls).toBe(0);
    expect(timers.timeouts).toHaveLength(0);
  });

  test("disabled construction does not touch a platform updater facade", () => {
    const inaccessibleUpdater = new Proxy({} as ElectronUpdaterFacade, {
      get: () => {
        throw new Error("platform updater was initialized");
      },
      set: () => {
        throw new Error("platform updater was initialized");
      },
    });

    expect(
      () =>
        new UpdateController({
          updater: inaccessibleUpdater,
          timers: new FakeTimers(),
          ui: makeUi().ui,
          productionFeedEnabled: false,
          disabledReason: "unpackaged",
        }),
    ).not.toThrow();
  });

  test("manual no-update gets a native confirmation while automatic checks stay quiet", async () => {
    const manualUi = makeUi();
    const { controller, updater } = createController({ ui: manualUi.ui });

    await controller.checkNow();
    updater.emit("update-not-available");
    expect(controller.getState()).toEqual({ kind: "idle" });
    expect(manualUi.calls.noUpdate).toBe(1);

    await controller.checkForUpdates("startup");
    updater.emit("update-not-available");
    expect(manualUi.calls.noUpdate).toBe(1);
  });
});

describe("D103 UpdateController — explicit discovery and download", () => {
  test("available → Later does not download and exposes only a narrow status", async () => {
    const fixture = makeUi();
    const { controller, updater } = createController({ ui: fixture.ui });

    await controller.checkNow();
    updater.emit("update-available", { version: "0.14.0", releaseNotes: "untrusted provider data" });
    updater.emit("update-available", { version: "0.14.0", releaseNotes: "duplicate provider event" });
    await settle();

    expect(controller.getState()).toEqual({ kind: "available", update: { version: "0.14.0" } });
    expect(controller.getSanitizedStatus()).toEqual({ kind: "available", version: "0.14.0" });
    expect(fixture.calls.available).toEqual(["0.14.0"]);
    expect(updater.downloadCalls).toBe(0);
  });

  test("available → Download reports bounded progress then ready without auto-install", async () => {
    const fixture = makeUi({ showAvailable: () => "download" });
    const { controller, updater } = createController({ ui: fixture.ui });

    await controller.checkNow();
    updater.emit("update-available", { version: "0.14.0" });
    await settle();
    expect(updater.downloadCalls).toBe(1);
    expect(updater.installCalls).toBe(0);

    updater.emit("download-progress", { percent: 101.4 });
    expect(controller.getSanitizedStatus()).toEqual({
      kind: "downloading",
      version: "0.14.0",
      percent: 100,
    });
    updater.emit("update-downloaded", { version: "0.14.0", path: "/private/never/projected" });
    await settle();

    expect(controller.getState()).toEqual({ kind: "ready", update: { version: "0.14.0" } });
    expect(controller.getSanitizedStatus()).toEqual({ kind: "ready", version: "0.14.0" });
    expect(fixture.calls.ready).toEqual(["0.14.0"]);
    expect(updater.installCalls).toBe(0);
  });

  test("Download refreshes the selected version once and starts exactly one matching transfer", async () => {
    const fixture = makeUi();
    const { controller, updater } = createController({ ui: fixture.ui });

    await controller.checkNow();
    updater.emit("update-available", { version: "0.14.0" });
    await settle();

    expect(await controller.downloadUpdate()).toEqual({ accepted: true, coalesced: false });

    expect(updater.checkCalls).toBe(2);
    expect(updater.downloadCalls).toBe(1);
    expect(controller.getState()).toEqual({
      kind: "downloading",
      update: { version: "0.14.0" },
      percent: 0,
    });
    expect(fixture.calls.available).toEqual(["0.14.0"]);
  });

  test("a newer refresh replaces the offer and requires another explicit Download", async () => {
    const fixture = makeUi();
    const { controller, updater } = createController({ ui: fixture.ui });

    await controller.checkNow();
    updater.emit("update-available", { version: "0.14.0" });
    await settle();
    updater.latestVersion = "0.15.0";

    expect(await controller.downloadUpdate()).toEqual({ accepted: true, coalesced: false });
    await settle();

    expect(updater.downloadCalls).toBe(0);
    expect(controller.getState()).toEqual({ kind: "available", update: { version: "0.15.0" } });
    expect(fixture.calls.available).toEqual(["0.14.0", "0.15.0"]);

    expect(await controller.downloadUpdate()).toEqual({ accepted: true, coalesced: false });
    expect(updater.checkCalls).toBe(3);
    expect(updater.downloadCalls).toBe(1);
    expect(controller.getState()).toEqual({
      kind: "downloading",
      update: { version: "0.15.0" },
      percent: 0,
    });
  });

  test("stale, equal, and superseded refresh events cannot regress the newest observed offer", async () => {
    const fixture = makeUi();
    const updater = new FakeUpdater();
    const { controller } = createController({ updater, ui: fixture.ui });

    await controller.checkNow();
    updater.emit("update-available", { version: "0.15.0" });
    await settle();
    updater.checkDeferred = deferred();

    const download = controller.downloadUpdate();
    await settle();
    updater.emit("update-available", { version: "0.14.0" });
    updater.emit("update-available", { version: "0.16.0" });
    updater.emit("update-available", { version: "0.15.0" });
    updater.checkDeferred.resolve(undefined);
    await download;
    await settle();

    expect(updater.downloadCalls).toBe(0);
    expect(controller.getState()).toEqual({ kind: "available", update: { version: "0.16.0" } });
    expect(fixture.calls.available).toEqual(["0.15.0", "0.16.0"]);

    updater.emit("update-available", { version: "0.15.0" });
    expect(controller.getState()).toEqual({ kind: "available", update: { version: "0.16.0" } });
  });

  test("a failed refresh preserves the retryable offer and starts no transfer", async () => {
    const fixture = makeUi();
    const { controller, updater } = createController({ ui: fixture.ui });

    await controller.checkNow();
    updater.emit("update-available", { version: "0.14.0" });
    await settle();
    updater.checkFailure = new Error("https://secret.example/private-token");

    expect(await controller.downloadUpdate()).toEqual({ accepted: true, coalesced: false });

    expect(updater.downloadCalls).toBe(0);
    expect(controller.getState()).toEqual({ kind: "available", update: { version: "0.14.0" } });
    expect(controller.getSanitizedStatus()).toEqual({ kind: "available", version: "0.14.0" });
    expect(fixture.calls.errors).toEqual(["Unable to check for updates. Please try again later."]);
    expect(fixture.calls.errors.join(" ")).not.toContain("secret.example");
  });

  test("duplicate checks and downloads collapse to a single updater operation", async () => {
    const fixture = makeUi();
    const updater = new FakeUpdater();
    updater.checkDeferred = deferred();
    const { controller } = createController({ updater, ui: fixture.ui });

    const first = controller.checkNow();
    const second = controller.checkNow();
    expect(updater.checkCalls).toBe(1);
    updater.checkDeferred.resolve(undefined);
    await first;
    expect(await second).toEqual({ accepted: true, coalesced: true });

    updater.emit("update-available", { version: "0.14.0" });
    await settle();
    updater.downloadDeferred = deferred();
    const downloadOne = controller.downloadUpdate();
    const downloadTwo = controller.downloadUpdate();
    expect(await controller.checkNow()).toEqual({ accepted: false, reason: "busy" });
    await settle();
    expect(updater.downloadCalls).toBe(1);
    updater.downloadDeferred.resolve(undefined);
    await downloadOne;
    expect(await downloadTwo).toEqual({ accepted: true, coalesced: true });
    expect(fixture.calls.available).toEqual(["0.14.0"]);
  });

  test("a periodic tick preserves an available update and does not start another check", async () => {
    const fixture = makeUi();
    const { controller, updater, timers } = createController({ ui: fixture.ui });
    controller.startScheduling();
    await controller.checkNow();
    updater.emit("update-available", { version: "0.14.0" });
    await settle();

    timers.fireInterval();
    await settle();

    expect(updater.checkCalls).toBe(1);
    expect(controller.getState()).toEqual({ kind: "available", update: { version: "0.14.0" } });
    expect(controller.getSanitizedStatus()).toEqual({ kind: "available", version: "0.14.0" });
    controller.openUpdateFlow();
    expect(fixture.calls.available).toEqual(["0.14.0", "0.14.0"]);
  });

  test("a periodic tick preserves a ready update and the explicit install path", async () => {
    const fixture = makeUi();
    const { controller, updater, timers } = createController({ ui: fixture.ui });
    controller.startScheduling();
    await controller.checkNow();
    updater.emit("update-available", { version: "0.14.0" });
    await settle();
    await controller.downloadUpdate();
    updater.emit("update-downloaded", { version: "0.14.0" });
    await settle();

    timers.fireInterval();
    await settle();

    expect(updater.checkCalls).toBe(2);
    expect(controller.getState()).toEqual({ kind: "ready", update: { version: "0.14.0" } });
    expect(controller.getSanitizedStatus()).toEqual({ kind: "ready", version: "0.14.0" });
    controller.openUpdateFlow();
    expect(fixture.calls.ready).toEqual(["0.14.0", "0.14.0"]);
  });
});

describe("D103 UpdateController — error, scheduling, and install boundary", () => {
  test("raw provider errors and invalid metadata are sanitized, and a later check recovers", async () => {
    const fixture = makeUi();
    const { controller, updater } = createController({ ui: fixture.ui });
    updater.checkFailure = new Error("https://secret.example/private-token");

    await controller.checkNow();
    expect(controller.getState()).toEqual({
      kind: "error",
      error: { phase: "check", message: "Unable to check for updates. Please try again later." },
    });
    expect(fixture.calls.errors.join(" ")).not.toContain("secret.example");
    expect(fixture.calls.errors.join(" ")).not.toContain("private-token");

    updater.checkFailure = null;
    await controller.checkNow();
    updater.emit("update-not-available");
    expect(controller.getState()).toEqual({ kind: "idle" });

    await controller.checkNow();
    updater.emit("update-available", { version: "not-a-version", url: "https://untrusted.example" });
    expect(controller.getState()).toEqual({
      kind: "error",
      error: { phase: "invalid-update", message: "The available update could not be verified." },
    });
  });

  test("late provider events cannot erase or regress available, downloading, ready, or installing", async () => {
    const installGate = deferred<boolean>();
    const fixture = makeUi();
    const { controller, updater } = createController({
      ui: fixture.ui,
      beforeInstall: () => installGate.promise,
    });

    await controller.checkNow();
    updater.emit("update-available", { version: "0.14.0" });
    await settle();
    updater.emit("update-not-available");
    expect(controller.getState()).toEqual({ kind: "available", update: { version: "0.14.0" } });

    await controller.downloadUpdate();
    updater.emit("update-available", { version: "0.15.0" });
    expect(controller.getState()).toEqual({
      kind: "downloading",
      update: { version: "0.14.0" },
      percent: 0,
    });

    updater.emit("update-downloaded", { version: "0.14.0" });
    await settle();
    updater.emit("update-not-available");
    updater.emit("update-available", { version: "0.15.0" });
    expect(controller.getState()).toEqual({ kind: "ready", update: { version: "0.14.0" } });

    const installing = controller.installUpdate();
    updater.emit("update-available", { version: "0.15.0" });
    updater.emit("update-not-available");
    expect(controller.getState()).toEqual({ kind: "installing", update: { version: "0.14.0" } });
    expect(controller.getSanitizedStatus()).toEqual({ kind: "installing", version: "0.14.0" });
    installGate.resolve(true);
    await installing;
  });

  test("rechecks persistence admission after confirmation without invoking the installer", async () => {
    let prepared = true;
    const fixture = makeUi();
    const { controller, updater } = createController({
      ui: fixture.ui,
      beforeInstall: () => prepared,
    });
    await controller.checkNow();
    updater.emit("update-available", { version: "0.14.0" });
    await settle();
    await controller.downloadUpdate();
    updater.emit("update-downloaded", { version: "0.14.0" });
    await settle();
    const installing = controller.installUpdate();
    prepared = false;
    expect(await installing).toEqual({ accepted: false, reason: "not-ready" });
    expect(updater.installCalls).toBe(0);
    expect(controller.getState().kind).toBe("ready");
    prepared = true;
    expect((await controller.installUpdate()).accepted).toBe(true);
    expect(updater.installCalls).toBe(1);
  });

  test("downloaded events require downloading state and the selected version", async () => {
    const earlyFixture = makeUi();
    const early = createController({ ui: earlyFixture.ui });
    await early.controller.checkNow();
    early.updater.emit("update-downloaded", { version: "0.14.0" });
    expect(early.controller.getState()).toEqual({ kind: "checking", source: "manual" });
    early.updater.emit("update-available", { version: "0.14.0" });
    await settle();
    early.updater.emit("update-downloaded", { version: "0.14.0" });
    expect(early.controller.getState()).toEqual({ kind: "available", update: { version: "0.14.0" } });
    expect(earlyFixture.calls.ready).toHaveLength(0);

    for (const invalidInfo of [{ version: "0.15.0" }, { version: "not-a-version" }]) {
      const fixture = makeUi();
      const { controller, updater } = createController({ ui: fixture.ui });
      await controller.checkNow();
      updater.emit("update-available", { version: "0.14.0" });
      await settle();
      await controller.downloadUpdate();
      updater.emit("update-downloaded", invalidInfo);

      expect(controller.getState()).toEqual({
        kind: "error",
        error: { phase: "invalid-update", message: "The available update could not be verified." },
      });
      expect(fixture.calls.ready).toHaveLength(0);
      expect(updater.installCalls).toBe(0);
    }
  });

  test("scheduler starts once, uses delayed + periodic checks, and disposal clears every listener/timer", async () => {
    const { controller, updater, timers } = createController();
    expect(controller.startScheduling()).toBe(true);
    expect(controller.startScheduling()).toBe(false);
    expect(timers.timeouts.map((timer) => timer.delayMs)).toEqual([7]);
    expect(timers.intervals.map((timer) => timer.delayMs)).toEqual([11]);

    timers.fireTimeout();
    await settle();
    timers.fireInterval();
    await settle();
    expect(updater.checkCalls).toBe(2);

    controller.dispose();
    // The startup callback already fired and cleared its own handle; the live
    // periodic handle is the scheduler resource dispose must cancel.
    expect(timers.timeouts[0]?.cleared).toBe(false);
    expect(timers.intervals[0]?.cleared).toBe(true);
    expect(updater.listenerCount()).toBe(0);
    updater.emit("update-available", { version: "0.14.0" });
    expect(controller.getState().kind).toBe("checking");
    expect(await controller.checkNow()).toEqual({ accepted: false, reason: "disposed" });
  });

  test("ordinary quit never installs, while ready-only Restart & Update is idempotent", async () => {
    const fixture = makeUi();
    const { controller, updater } = createController({ ui: fixture.ui });

    expect(await controller.installUpdate()).toEqual({ accepted: false, reason: "not-ready" });
    await controller.checkNow();
    updater.emit("update-available", { version: "0.14.0" });
    await settle();
    await controller.downloadUpdate();
    updater.emit("update-downloaded", { version: "0.14.0" });
    await settle();

    expect(controller.onOrdinaryQuit()).toEqual({ installRequested: false });
    expect(updater.installCalls).toBe(0);

    const first = controller.installUpdate();
    const duplicate = controller.installUpdate();
    await first;
    expect(await duplicate).toEqual({ accepted: true, coalesced: true });
    expect(updater.installCalls).toBe(1);
    expect(controller.getState()).toEqual({ kind: "installing", update: { version: "0.14.0" } });
  });
});

describe("D103 updater sanitizers", () => {
  test("only a valid semantic version leaves release transport metadata", () => {
    expect(sanitizeUpdateInfo({ version: "0.14.0", releaseNotes: "ignore me", path: "/private" })).toEqual({
      version: "0.14.0",
    });
    expect(sanitizeUpdateInfo({ version: "v0.14.0" })).toBeNull();
    expect(sanitizeUpdateInfo({ version: "0.14.0\nsecret" })).toBeNull();
    expect(sanitizeUpdaterError("download")).toEqual({
      phase: "download",
      message: "Unable to download the update. Please try again later.",
    });
  });
});
