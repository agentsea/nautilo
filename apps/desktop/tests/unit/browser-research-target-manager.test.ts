import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Rectangle,
  WebContents,
  WebContentsViewConstructorOptions,
} from "electron";
import { BrowserResearchTargetManager } from "../../electron/browser-research-target-manager";

class FakeSession {
  permissionRequest:
    | ((
        contents: unknown,
        permission: string,
        callback: (allowed: boolean) => void,
      ) => void)
    | null = null;
  permissionCheck: (() => boolean) | null = null;
  downloadHandlers = new Set<(event: { preventDefault(): void }) => void>();
  cleared = 0;
  cacheCleared = 0;
  requestGuard:
    | ((
        details: { url: string; resourceType?: string },
        callback: (response: { cancel: boolean }) => void,
      ) => void)
    | null = null;
  webRequest = {
    onBeforeRequest: (
      _filter: { urls: string[] },
      listener:
        | ((
            details: { url: string; resourceType?: string },
            callback: (response: { cancel: boolean }) => void,
          ) => void)
        | null,
    ): void => {
      this.requestGuard = listener;
    },
  };
  setPermissionRequestHandler(handler: typeof this.permissionRequest): void {
    this.permissionRequest = handler;
  }
  setPermissionCheckHandler(handler: typeof this.permissionCheck): void {
    this.permissionCheck = handler;
  }
  on(
    _event: "will-download",
    handler: (event: { preventDefault(): void }) => void,
  ): void {
    this.downloadHandlers.add(handler);
  }
  removeListener(
    _event: "will-download",
    handler: (event: { preventDefault(): void }) => void,
  ): void {
    this.downloadHandlers.delete(handler);
  }
  async clearStorageData(): Promise<void> {
    this.cleared += 1;
  }
  async clearCache(): Promise<void> {
    this.cacheCleared += 1;
  }
}

class FakeWebContents {
  readonly session = new FakeSession();
  url = "";
  destroyed = false;
  windowOpenHandler: (() => { action: "deny" }) | null = null;
  handlers = new Map<string, Array<(...args: any[]) => void>>();
  loaded: string[] = [];
  focused = 0;
  challengeCleared = false;
  constructor(
    private readonly finalUrl?: string,
    private readonly loadError?: Error,
  ) {}
  async loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    this.url = this.finalUrl ?? (this.loadError ? "about:blank" : url);
    if (this.loadError) throw this.loadError;
  }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }
  focus(): void {
    this.focused += 1;
  }
  async executeJavaScript(): Promise<boolean> {
    return this.challengeCleared;
  }
  getURL(): string {
    return this.url;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  setWindowOpenHandler(handler: () => { action: "deny" }): void {
    this.windowOpenHandler = handler;
  }
  on(event: string, handler: (...args: any[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

class FakeView {
  readonly webContents: FakeWebContents;
  bounds: Rectangle | null = null;
  constructor(finalUrl?: string, loadError?: Error) {
    this.webContents = new FakeWebContents(finalUrl, loadError);
  }
  setBounds(bounds: Rectangle): void {
    this.bounds = bounds;
  }
}

function harness(
  config: {
    finalUrl?: string;
    blockedUrl?: string;
    loadError?: Error;
    interventionTtlMs?: number;
    consentRecoveryTtlMs?: number;
  } = {},
) {
  const windows: FakeView[] = [];
  const options: WebContentsViewConstructorOptions[] = [];
  const closedShims: string[] = [];
  const attached = new Set<FakeView>();
  let sequence = 0;
  const manager = new BrowserResearchTargetManager({
    createLeaseId: () => `lease-${++sequence}`,
    createUrlPolicy: () => ({
      assertAllowed: async (rawUrl: string) => {
        const url = new URL(rawUrl);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error("blocked");
        if (rawUrl === config.blockedUrl) throw new Error("blocked");
        return url;
      },
    }),
    createView: (windowOptions) => {
      options.push(windowOptions);
      const window = new FakeView(config.finalUrl, config.loadError);
      windows.push(window);
      return window;
    },
    attachBackgroundView: (view) => {
      attached.add(view as FakeView);
      return true;
    },
    attachView: (view) => {
      attached.add(view as FakeView);
      return true;
    },
    detachView: (view) => {
      attached.delete(view as FakeView);
    },
    ...(config.interventionTtlMs === undefined
      ? {}
      : { interventionTtlMs: config.interventionTtlMs }),
    ...(config.consentRecoveryTtlMs === undefined
      ? {}
      : { consentRecoveryTtlMs: config.consentRecoveryTtlMs }),
    completionPollMs: 1,
    startCdpShim: async ({ webContents }) => ({
      url: `ws://research/${windows.indexOf(windows.find((item) => item.webContents === webContents)!) + 1}`,
      close: () => closedShims.push(`shim-${closedShims.length + 1}`),
    }),
  });
  return { manager, windows, options, closedShims, attached };
}

describe("BrowserResearchTargetManager", () => {
  test("Electron main owns one lazy manager and awaits cleanup during quit", () => {
    const main = readFileSync(
      join(import.meta.dir, "../../electron/main.ts"),
      "utf8",
    );
    expect(main).toContain(
      "browserResearchTargetManager ??= new BrowserResearchTargetManager",
    );
    expect(main).toContain(
      "createView: (options) => new WebContentsView(options)",
    );
    expect(main).not.toContain(
      "createWindow: (options) => new BrowserWindow(options)",
    );
    expect(main).toContain("await browserResearchTargetManager?.disposeAll()");
  });

  test("creates one detached anonymous research lease without persistent state", async () => {
    const { manager, windows, options } = harness();
    const lease = await manager.createLease("https://example.com/article");

    expect(lease).toMatchObject({
      leaseId: "lease-1",
      role: "research",
      requestedUrl: "https://example.com/article",
      currentUrl: "https://example.com/article",
      partition: "nautilo-research-lease-1",
      cdpUrl: "ws://research/1",
      documentState: "loaded",
      state: "agent_background",
    });
    expect(lease.partition.startsWith("persist:")).toBe(false);
    expect(windows[0]!.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 900 });
    expect(options[0]).toMatchObject({
      webPreferences: {
        partition: "nautilo-research-lease-1",
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    expect(windows[0]!.webContents.windowOpenHandler?.()).toEqual({
      action: "deny",
    });
    let permissionAllowed = true;
    windows[0]!.webContents.session.permissionRequest?.(
      {},
      "camera",
      (allowed) => {
        permissionAllowed = allowed;
      },
    );
    expect(permissionAllowed).toBe(false);
    expect(windows[0]!.webContents.session.permissionCheck?.()).toBe(false);
    expect(windows[0]!.webContents.session.requestGuard).not.toBeNull();
  });

  test("marks Chromium no-document responses without losing the live lease", async () => {
    const error = Object.assign(new Error("ERR_ABORTED (-3) loading URL"), {
      code: "ERR_ABORTED",
    });
    const { manager, windows, closedShims } = harness({ loadError: error });

    const lease = await manager.createLease("https://example.com/empty");

    expect(lease).toMatchObject({
      requestedUrl: "https://example.com/empty",
      currentUrl: "about:blank",
      documentState: "no-document",
      state: "agent_background",
    });
    expect(manager.getActiveLease()?.leaseId).toBe(lease.leaseId);
    expect(windows[0]!.webContents.destroyed).toBe(false);
    expect(closedShims).toHaveLength(0);
    await manager.release(lease.leaseId);
  });

  test("marks a resolved load that never commits away from the initial blank document", async () => {
    const { manager } = harness({ finalUrl: "" });

    const lease = await manager.createLease("https://example.com/status/204");

    expect(lease).toMatchObject({
      requestedUrl: "https://example.com/status/204",
      currentUrl: "https://example.com/status/204",
      documentState: "no-document",
      state: "agent_background",
    });
  });

  test("still tears down ordinary navigation failures", async () => {
    const { manager, windows, closedShims } = harness({
      loadError: new Error("ERR_FAILED"),
    });

    expect(manager.createLease("https://example.com/failure")).rejects.toThrow(
      "ERR_FAILED",
    );
    expect(manager.getActiveLease()).toBeNull();
    expect(windows[0]!.webContents.destroyed).toBe(true);
    expect(closedShims).toHaveLength(1);
  });

  test("challenge presentation attaches the exact lease inside Nautilo and detaches before reobservation", async () => {
    const { manager, windows, attached } = harness();
    const lease = await manager.createLease("https://example.com/challenge");
    expect(
      manager.markChallenge(lease.leaseId, {
        toolCallId: "tool-1",
        laneKey: "room:1",
      }),
    ).toMatchObject({ state: "awaiting_choice", host: "example.com" });
    expect(manager.present(lease.leaseId)).not.toBeNull();
    expect(
      manager.attachSurface(lease.leaseId, {
        x: 10,
        y: 20,
        width: 800,
        height: 600,
      }),
    ).toBe(true);
    expect(attached.has(windows[0]!)).toBe(true);
    expect(windows[0]!.bounds).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    });
    expect(windows[0]!.webContents.focused).toBe(1);
    expect(manager.detachSurface(lease.leaseId)).toBe(true);
    expect(attached.has(windows[0]!)).toBe(false);
    expect(manager.getActiveLease()?.state).toBe("human_foreground");

    expect(manager.present(lease.leaseId)).not.toBeNull();
    expect(
      manager.attachSurface(lease.leaseId, {
        x: 0,
        y: 80,
        width: 900,
        height: 700,
      }),
    ).toBe(true);
    const decision = manager.waitForDecision(lease.leaseId);
    expect(manager.resolveIntervention(lease.leaseId, "done")).toBe(true);
    expect(attached.has(windows[0]!)).toBe(false);
    expect(await decision).toBe("done");
    expect(manager.getActiveLease()?.state).toBe("reobserve");
    expect(await manager.prepareReobserve(lease.leaseId)).toMatchObject({
      leaseId: lease.leaseId,
      currentUrl: "https://example.com/challenge",
      state: "reobserve",
    });
    expect(windows).toHaveLength(1);
    await manager.release(lease.leaseId);
  });

  test("automatically resumes the exact suspended read when Human verification clears", async () => {
    const { manager, windows, attached } = harness();
    const lease = await manager.createLease("https://example.com/challenge");
    manager.markChallenge(lease.leaseId, {
      toolCallId: "tool-1",
      laneKey: "room:1",
    });
    manager.present(lease.leaseId);
    windows[0]!.webContents.challengeCleared = true;
    const decision = manager.waitForDecision(lease.leaseId);

    expect(
      manager.attachSurface(lease.leaseId, {
        x: 0,
        y: 80,
        width: 900,
        height: 700,
      }),
    ).toBe(true);
    expect(await decision).toBe("done");
    expect(attached.has(windows[0]!)).toBe(false);
    expect(manager.getActiveLease()?.state).toBe("reobserve");
    await manager.release(lease.leaseId);
  });

  test("keeps a still-blocked verification under Human control until it clears, then resumes once", async () => {
    const { manager, windows, attached } = harness();
    const lease = await manager.createLease("https://example.com/challenge");
    manager.markChallenge(lease.leaseId, {
      toolCallId: "tool-1",
      laneKey: "room:1",
    });
    manager.present(lease.leaseId);
    const decision = manager.waitForDecision(lease.leaseId);

    expect(
      manager.attachSurface(lease.leaseId, {
        x: 0,
        y: 80,
        width: 900,
        height: 700,
      }),
    ).toBe(true);
    await Bun.sleep(10);
    expect(manager.getActiveLease()?.state).toBe("human_foreground");
    expect(attached.has(windows[0]!)).toBe(true);
    expect(await manager.prepareReobserve(lease.leaseId)).toBeNull();
    expect(
      await Promise.race([
        decision,
        Bun.sleep(1).then(() => "still-blocked" as const),
      ]),
    ).toBe("still-blocked");

    windows[0]!.webContents.challengeCleared = true;
    expect(await decision).toBe("done");
    expect(attached.has(windows[0]!)).toBe(false);
    expect(manager.getActiveLease()?.state).toBe("reobserve");
    await manager.release(lease.leaseId);
  });

  test("expires an unanswered verification and clears the anonymous lease", async () => {
    const { manager, windows, attached, closedShims } = harness({
      interventionTtlMs: 5,
    });
    const lease = await manager.createLease("https://example.com/challenge");
    manager.markChallenge(lease.leaseId, {
      toolCallId: "tool-1",
      laneKey: "room:1",
    });
    manager.present(lease.leaseId);
    expect(
      manager.attachSurface(lease.leaseId, {
        x: 0,
        y: 80,
        width: 900,
        height: 700,
      }),
    ).toBe(true);

    expect(await manager.waitForDecision(lease.leaseId)).toBe("expired");
    // The original read owns terminal release; expiry only settles its wait.
    expect(manager.getActiveLease()?.state).toBe("human_foreground");
    expect(attached.has(windows[0]!)).toBe(true);
    expect(await manager.release(lease.leaseId)).toBe(true);
    expect(manager.getActiveLease()).toBeNull();
    expect(windows[0]!.webContents.destroyed).toBe(true);
    expect(windows[0]!.webContents.session.cleared).toBe(1);
    expect(windows[0]!.webContents.session.cacheCleared).toBe(1);
    expect(closedShims).toHaveLength(1);
  });

  test("rejects invalid, credentialed, and non-http destinations before creating a view", async () => {
    const { manager, windows } = harness();
    for (const url of [
      "file:///etc/passwd",
      "https://user:pass@example.com",
      "not a url",
    ]) {
      expect(manager.createLease(url)).rejects.toThrow();
    }
    expect(windows).toHaveLength(0);
  });

  test("a concurrent research read fails busy without destroying the active target", async () => {
    const { manager, windows, closedShims } = harness();
    await manager.createLease("https://one.example");
    expect(manager.createLease("https://two.example")).rejects.toThrow("busy");
    expect(windows[0]!.webContents.destroyed).toBe(false);
    expect(manager.getActiveLease()?.requestedUrl).toBe("https://one.example/");
    expect(closedShims).toHaveLength(0);
    await manager.disposeAll();
  });

  test("release is exact, idempotent, and clears all temporary state", async () => {
    const { manager, windows, closedShims } = harness();
    const lease = await manager.createLease("https://example.com");
    expect(await manager.release("wrong-lease")).toBe(false);
    expect(await manager.release(lease.leaseId)).toBe(true);
    expect(await manager.release(lease.leaseId)).toBe(false);
    expect(manager.getActiveLease()).toBeNull();
    expect(windows[0]!.webContents.destroyed).toBe(true);
    expect(windows[0]!.webContents.session.cleared).toBe(1);
    expect(windows[0]!.webContents.session.cacheCleared).toBe(1);
    expect(closedShims).toHaveLength(1);
  });

  test("retains consent recovery only for the bound lane and records screenshot geometry", async () => {
    const { manager, windows, attached } = harness({ consentRecoveryTtlMs: 1_000 });
    const lease = await manager.createLease("https://example.com/consent");
    const recovery = manager.retainConsentRecovery(lease.leaseId, {
      laneKey: "room:1",
      authorAgentId: "agent:1",
    });
    expect(recovery).toMatchObject({ leaseId: lease.leaseId, requestedUrl: "https://example.com/consent" });
    expect(recovery?.reference).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manager.getActiveLease()?.state).toBe("consent_recovery");
    expect(attached.has(windows[0]!)).toBe(true);
    expect(windows[0]!.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 900 });
    expect(manager.getConsentRecovery(recovery!.reference, { laneKey: "room:2", authorAgentId: "agent:1" })).toBeNull();
    expect(manager.getConsentRecovery(recovery!.reference, { laneKey: "room:1", authorAgentId: "agent:2" })).toBeNull();
    expect(manager.recordConsentRecoveryScreenshot(recovery!.reference, 2, 1600, 1200)).toBe(true);
    expect(manager.getConsentRecovery(recovery!.reference, { laneKey: "room:1", authorAgentId: "agent:1" })).toMatchObject({
      screenshotScale: 2, screenshotWidth: 1600, screenshotHeight: 1200,
    });
    await manager.disposeAll();
  });

  test("expires the anonymous consent-recovery target", async () => {
    const { manager, windows, attached } = harness({ consentRecoveryTtlMs: 5 });
    const lease = await manager.createLease("https://example.com/consent");
    expect(manager.retainConsentRecovery(lease.leaseId, {
      laneKey: "room:1",
      authorAgentId: "agent:1",
    })).not.toBeNull();
    await Bun.sleep(10);
    expect(manager.getActiveLease()).toBeNull();
    expect(attached.has(windows[0]!)).toBe(false);
    expect(windows[0]!.webContents.destroyed).toBe(true);
    expect(windows[0]!.webContents.session.cleared).toBe(1);
  });

  test("downloads and disallowed navigation fail closed", async () => {
    const { manager, windows } = harness();
    const lease = await manager.createLease("https://example.com");
    let downloadPrevented = false;
    for (const handler of windows[0]!.webContents.session.downloadHandlers) {
      handler({
        preventDefault: () => {
          downloadPrevented = true;
        },
      });
    }
    expect(downloadPrevented).toBe(true);

    let navigationPrevented = false;
    windows[0]!.webContents.emit(
      "will-navigate",
      {
        preventDefault: () => {
          navigationPrevented = true;
        },
      },
      "file:///tmp/secret",
    );
    await Bun.sleep(0);
    expect(navigationPrevented).toBe(true);
    expect(manager.getActiveLease()).toBeNull();
    expect(await manager.release(lease.leaseId)).toBe(false);
  });

  test("request interception validates public subresources separately from document navigation", async () => {
    const blockedUrl = "https://blocked.example/private";
    const seenPurposes: Array<string | undefined> = [];
    const windows: FakeView[] = [];
    const manager = new BrowserResearchTargetManager({
      createLeaseId: () => "lease-request-policy",
      createUrlPolicy: () => ({
        assertAllowed: async (rawUrl, purpose) => {
          seenPurposes.push(purpose);
          if (rawUrl === blockedUrl) throw new Error("blocked");
          return new URL(rawUrl);
        },
      }),
      createView: () => {
        const window = new FakeView();
        windows.push(window);
        return window;
      },
      attachBackgroundView: () => true,
      attachView: () => true,
      detachView: () => undefined,
      startCdpShim: async () => ({
        url: "ws://research/request-policy",
        close: () => undefined,
      }),
    });
    await manager.createLease("https://example.com");
    const guard = windows[0]!.webContents.session.requestGuard!;

    const allowed = await new Promise<{ cancel: boolean }>((resolve) =>
      guard(
        { url: "https://cdn.example/asset.js", resourceType: "script" },
        resolve,
      ),
    );
    const blocked = await new Promise<{ cancel: boolean }>((resolve) =>
      guard({ url: blockedUrl, resourceType: "mainFrame" }, resolve),
    );
    expect(allowed).toEqual({ cancel: false });
    expect(blocked).toEqual({ cancel: true });
    expect(seenPurposes).toEqual([
      "navigation",
      "navigation",
      "subresource",
      "navigation",
    ]);
  });

  test("revalidates the final committed URL and tears down a blocked redirect", async () => {
    const blockedUrl = "https://blocked.example/private";
    const { manager, windows } = harness({ finalUrl: blockedUrl, blockedUrl });
    expect(manager.createLease("https://example.com")).rejects.toThrow(
      "blocked",
    );
    expect(manager.getActiveLease()).toBeNull();
    expect(windows[0]!.webContents.destroyed).toBe(true);
  });

  test("revalidates the Human's final URL before agent reobservation", async () => {
    const blockedUrl = "https://blocked.example/private";
    const { manager, windows } = harness({ blockedUrl });
    const lease = await manager.createLease("https://example.com/challenge");
    manager.markChallenge(lease.leaseId, {
      toolCallId: "tool-1",
      laneKey: "room:1",
    });
    manager.present(lease.leaseId);
    manager.resolveIntervention(lease.leaseId, "done");
    windows[0]!.webContents.url = blockedUrl;

    expect(await manager.prepareReobserve(lease.leaseId)).toBeNull();
    expect(manager.getActiveLease()).toBeNull();
    expect(windows[0]!.webContents.destroyed).toBe(true);
  });

  test("renderer failure, relay loss, and server switch dispose the active anonymous lease", async () => {
    const main = readFileSync(
      join(import.meta.dir, "../../electron/main.ts"),
      "utf8",
    );
    expect(main).toContain("await browserResearchTargetManager?.disposeAll();");
    expect(main).toContain("if (status === \"disconnected\" || status === \"error\") {");
    expect(main).toContain("void browserResearchTargetManager?.disposeAll();");
    const { manager, windows } = harness();
    await manager.createLease("https://example.com");
    windows[0]!.webContents.emit("render-process-gone");
    await Bun.sleep(0);
    expect(manager.getActiveLease()).toBeNull();
    expect(windows[0]!.webContents.session.cleared).toBe(1);

    await manager.createLease("https://second.example");
    await manager.disposeAll();
    expect(manager.getActiveLease()).toBeNull();
    expect(windows[1]!.webContents.destroyed).toBe(true);
    expect(windows[1]!.webContents.session.cleared).toBe(1);
    expect(windows[1]!.webContents.session.cacheCleared).toBe(1);
  });
});
