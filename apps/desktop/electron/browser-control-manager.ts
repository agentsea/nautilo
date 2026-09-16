import type { WebContents } from "electron";
import {
  startBrowserControlCdpShim,
  type BrowserControlCdpShimHandle,
} from "./browser-control-cdp-shim";

export interface BrowserControlAppDescriptor {
  appId: string;
  mode: "app" | "browser";
  partition: string;
  url: string;
}

export interface BrowserControlViewSnapshot {
  appId: string;
  mode: "app" | "browser";
  partition: string;
  url: string;
  cdpUrl: string | null;
}

export type BrowserControlNavigationAction = "back" | "forward" | "reload";

export type BrowserControlNavigationResult =
  | { ok: true }
  | { ok: false; error: string };

export interface BrowserControlProviderState {
  version: 1;
  activeAppId: string | null;
  views: BrowserControlViewSnapshot[];
}

export type BrowserControlNeedsHumanReason =
  | "auth"
  | "2fa"
  | "captcha"
  | "blocked"
  | "unknown";

export interface BrowserControlNeedsHumanAction {
  appId: string;
  url: string;
  reason: BrowserControlNeedsHumanReason;
  summary?: string;
}

export interface BrowserControlManagerDeps {
  startCdpShim?: typeof startBrowserControlCdpShim;
  writeProviderState?: (state: BrowserControlProviderState) => void;
  onNeedsHumanAction?: (payload: BrowserControlNeedsHumanAction) => void;
}

interface BrowserControlViewRecord {
  descriptor: BrowserControlAppDescriptor;
  webContents: WebContents;
  cdpShim: BrowserControlCdpShimHandle | null;
}

interface BrowserControlReadyWaiter {
  appId: string;
  finish: (snapshot: BrowserControlViewSnapshot | null) => void;
}

/**
 * Owns control of Electron-renderer SaaS browser surfaces.
 *
 * D336 — the visible web content is a `<webview>` element owned by the
 * Workbench renderer, so the compositor handles layout/clipping and the view
 * can never float outside its panel. This manager does NOT create or position
 * any native view; it *adopts* the webview's `webContents` (resolved in main
 * from the renderer-provided id) to run the scoped CDP shim and publish the
 * agent-browser provider state. It intentionally knows nothing about Workbench
 * routes, Genie tools, or D337 attention events — those layers call in.
 */
export class BrowserControlManager {
  private readonly records = new Map<string, BrowserControlViewRecord>();
  private readonly readyWaiters = new Set<BrowserControlReadyWaiter>();
  private activeAppId: string | null = null;

  constructor(private readonly deps: BrowserControlManagerDeps) {
    // Clear any persisted provider state from a previous Electron process before
    // a new webview is adopted. Otherwise agent-browser can reconnect to a dead
    // CDP shim URL and fail with "Object has been destroyed".
    this.writeProviderState();
  }

  /**
   * Adopt (or re-adopt) the webview's `webContents` for an app and make it the
   * active provider target. Idempotent for the same `webContents`.
   */
  async adopt(
    descriptor: BrowserControlAppDescriptor,
    webContents: WebContents,
  ): Promise<BrowserControlViewSnapshot> {
    const existing = this.records.get(descriptor.appId);
    if (existing && existing.webContents === webContents) {
      existing.descriptor = descriptor;
      await this.ensureShim(existing);
      this.activeAppId = descriptor.appId;
      return this.commitAndSnapshot(existing);
    }

    if (existing) {
      existing.cdpShim?.close();
      existing.cdpShim = null;
      existing.webContents = webContents;
      existing.descriptor = descriptor;
      await this.ensureShim(existing);
      this.watchDestroy(descriptor.appId, webContents);
      this.activeAppId = descriptor.appId;
      return this.commitAndSnapshot(existing);
    }

    const record: BrowserControlViewRecord = {
      descriptor,
      webContents,
      cdpShim: null,
    };
    this.records.set(descriptor.appId, record);
    await this.ensureShim(record);
    this.watchDestroy(descriptor.appId, webContents);
    this.activeAppId = descriptor.appId;
    return this.commitAndSnapshot(record);
  }

  /**
   * Auto-release an app when its adopted guest `webContents` is destroyed (e.g.
   * a full-page sign-in guest swap) so we never leave an orphaned CDP shim
   * pointing at a dead target. Guarded so a stale handler from a previous guest
   * does not release a record that has since been re-adopted onto a new one.
   */
  private watchDestroy(appId: string, webContents: WebContents): void {
    if (typeof webContents.once !== "function") return;
    webContents.once("destroyed", () => {
      if (this.records.get(appId)?.webContents === webContents) {
        this.release(appId);
      }
    });
  }

  setActive(appId: string): BrowserControlViewSnapshot | null {
    this.pruneDestroyedRecords();
    const record = this.records.get(appId);
    if (!record) return null;
    this.activeAppId = appId;
    return this.commitAndSnapshot(record);
  }

  /**
   * Wait for the authoritative manager state to confirm that an app is the
   * active controllable target. The current state is checked first, so callers
   * can register this handshake before asking the renderer to mount a surface
   * without racing a fast adoption. A bounded null result preserves fail-closed
   * behavior when the renderer never adopts a guest.
   */
  waitForActiveView(
    appId: string,
    timeoutMs: number,
  ): Promise<BrowserControlViewSnapshot | null> {
    const current = this.controllableActiveSnapshot(appId);
    if (current) return Promise.resolve(current);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      const waiter: BrowserControlReadyWaiter = {
        appId,
        finish: (snapshot) => {
          if (!this.readyWaiters.delete(waiter)) return;
          clearTimeout(timeout);
          resolve(snapshot);
        },
      };
      this.readyWaiters.add(waiter);
      const timeout = setTimeout(() => waiter.finish(null), timeoutMs);
    });
  }

  navigateActive(action: BrowserControlNavigationAction): BrowserControlNavigationResult {
    this.pruneDestroyedRecords();
    const record = this.activeAppId ? this.records.get(this.activeAppId) : undefined;
    if (!record) return { ok: false, error: "No active embedded Browser view" };

    try {
      if (action === "reload") {
        record.webContents.reload();
      } else if (action === "back") {
        if (!record.webContents.navigationHistory.canGoBack()) {
          return { ok: false, error: "The embedded Browser has no previous history entry" };
        }
        record.webContents.navigationHistory.goBack();
      } else {
        if (!record.webContents.navigationHistory.canGoForward()) {
          return { ok: false, error: "The embedded Browser has no forward history entry" };
        }
        record.webContents.navigationHistory.goForward();
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  release(appId: string): boolean {
    const record = this.records.get(appId);
    if (!record) return false;
    record.cdpShim?.close();
    record.cdpShim = null;
    this.records.delete(appId);
    if (this.activeAppId === appId) this.activeAppId = null;
    this.writeProviderState();
    return true;
  }

  list(): BrowserControlViewSnapshot[] {
    this.pruneDestroyedRecords();
    return Array.from(this.records.values(), (record) => this.snapshot(record));
  }

  reportNeedsHumanAction(
    appId: string,
    reason: BrowserControlNeedsHumanReason,
    summary?: string,
  ): BrowserControlNeedsHumanAction | null {
    const record = this.records.get(appId);
    if (!record) return null;
    const payload: BrowserControlNeedsHumanAction = {
      appId,
      url: this.snapshot(record).url,
      reason,
      ...(summary ? { summary } : {}),
    };
    this.deps.onNeedsHumanAction?.(payload);
    return payload;
  }

  private async ensureShim(record: BrowserControlViewRecord): Promise<void> {
    if (record.cdpShim) return;
    const startShim = this.deps.startCdpShim ?? startBrowserControlCdpShim;
    record.cdpShim = await startShim({ webContents: record.webContents });
  }

  private snapshot(record: BrowserControlViewRecord): BrowserControlViewSnapshot {
    let url = record.descriptor.url;
    try {
      url = record.webContents.getURL() || url;
    } catch {
      // webContents may be gone during teardown; fall back to descriptor url.
    }
    return {
      appId: record.descriptor.appId,
      mode: record.descriptor.mode,
      partition: record.descriptor.partition,
      url,
      cdpUrl: record.cdpShim?.url ?? null,
    };
  }

  private pruneDestroyedRecords(): void {
    for (const [appId, record] of this.records.entries()) {
      if (
        typeof record.webContents.isDestroyed !== "function" ||
        !record.webContents.isDestroyed()
      ) {
        continue;
      }
      record.cdpShim?.close();
      record.cdpShim = null;
      this.records.delete(appId);
      if (this.activeAppId === appId) this.activeAppId = null;
    }
  }

  private commitAndSnapshot(record: BrowserControlViewRecord): BrowserControlViewSnapshot {
    const snapshot = this.snapshot(record);
    this.writeProviderState();
    if (snapshot.cdpUrl && this.activeAppId === snapshot.appId) {
      for (const waiter of this.readyWaiters) {
        if (waiter.appId === snapshot.appId) waiter.finish(snapshot);
      }
    }
    return snapshot;
  }

  private controllableActiveSnapshot(appId: string): BrowserControlViewSnapshot | null {
    if (this.activeAppId !== appId) return null;
    const record = this.records.get(appId);
    if (!record) return null;
    const snapshot = this.snapshot(record);
    return snapshot.cdpUrl ? snapshot : null;
  }

  private writeProviderState(): void {
    this.deps.writeProviderState?.({
      version: 1,
      activeAppId: this.activeAppId,
      views: this.list(),
    });
  }
}
