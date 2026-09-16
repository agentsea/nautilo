import { randomBytes, randomUUID } from "node:crypto";
import type {
  Rectangle,
  WebContents,
  WebContentsViewConstructorOptions,
} from "electron";
import {
  startBrowserControlCdpShim,
  type BrowserControlCdpShimHandle,
} from "./browser-control-cdp-shim";
import {
  createBrowserResearchUrlPolicy,
  parseResearchHttpUrl,
  type BrowserResearchUrlPolicy,
} from "./browser-research-url-policy";

export interface BrowserResearchLeaseSnapshot {
  leaseId: string;
  role: "research";
  requestedUrl: string;
  currentUrl: string;
  partition: string;
  cdpUrl: string;
  documentState: "loaded" | "no-document";
  state: BrowserResearchLeaseState;
}

export type BrowserResearchLeaseState =
  "agent_background" | "consent_recovery" | "awaiting_choice" | "human_foreground" | "reobserve";

export type BrowserResearchDecision =
  "done" | "alternate" | "cancel" | "expired";

export interface BrowserResearchInterventionSnapshot {
  id: string;
  toolCallId: string;
  laneKey: string;
  turnId?: string;
  authorAgentId?: string;
  state: "awaiting_choice";
  host: string;
  reason: "human-verification";
  expiresAt: string;
}

export interface BrowserResearchInterventionBinding {
  toolCallId: string;
  laneKey: string;
  turnId?: string;
  authorAgentId?: string;
}

export interface BrowserResearchConsentRecoverySnapshot {
  reference: string;
  expiresAt: string;
  requestedUrl: string;
  currentUrl: string;
  cdpUrl: string;
  leaseId: string;
  screenshotScale?: number;
  screenshotWidth?: number;
  screenshotHeight?: number;
}

interface ResearchSession {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  on(
    event: "will-download",
    handler: (event: { preventDefault(): void }) => void,
  ): void;
  removeListener(
    event: "will-download",
    handler: (event: { preventDefault(): void }) => void,
  ): void;
  clearStorageData(): Promise<void>;
  clearCache?(): Promise<void>;
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener:
        | ((
            details: { url: string; resourceType?: string },
            callback: (response: { cancel: boolean }) => void,
          ) => void)
        | null,
    ): void;
  };
}

interface ResearchWebContents {
  session: ResearchSession;
  loadURL(url: string): Promise<unknown>;
  close(): void;
  focus(): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  getURL(): string;
  isDestroyed(): boolean;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  on(
    event: "will-navigate",
    handler: (event: { preventDefault(): void }, url: string) => void,
  ): void;
  on(event: "render-process-gone" | "unresponsive", handler: () => void): void;
}

interface ResearchView {
  webContents: ResearchWebContents;
  setBounds(bounds: Rectangle): void;
}

export interface BrowserResearchTargetManagerDeps {
  createView(options: WebContentsViewConstructorOptions): ResearchView;
  attachBackgroundView(view: ResearchView): boolean;
  attachView(view: ResearchView): boolean;
  detachView(view: ResearchView): void;
  startCdpShim?: typeof startBrowserControlCdpShim;
  createLeaseId?: () => string;
  onWarning?: (message: string, error?: unknown) => void;
  onSurfaceClosed?: (leaseId: string) => void;
  onVerificationCleared?: (leaseId: string) => void;
  createUrlPolicy?: () => BrowserResearchUrlPolicy;
  /** Test seam; production uses the bounded ten-minute intervention TTL. */
  interventionTtlMs?: number;
  /** Test seam; production retains an actively used unresolved consent target for five minutes. */
  consentRecoveryTtlMs?: number;
  completionPollMs?: number;
}

interface ActiveResearchLease {
  leaseId: string;
  requestedUrl: string;
  partition: string;
  view: ResearchView;
  shim: BrowserControlCdpShimHandle;
  urlPolicy: BrowserResearchUrlPolicy;
  documentState: "loaded" | "no-document";
  downloadHandler: (event: { preventDefault(): void }) => void;
  releasePromise: Promise<boolean> | null;
  state: BrowserResearchLeaseState;
  intervention: BrowserResearchInterventionSnapshot | null;
  decisionPromise: Promise<BrowserResearchDecision> | null;
  resolveDecision: ((decision: BrowserResearchDecision) => void) | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  completionPollTimer: ReturnType<typeof setInterval> | null;
  completionProbePending: boolean;
  hostAttached: boolean;
  surfaceAttached: boolean;
  consentRecovery: {
    reference: string;
    expiresAt: number;
    laneKey: string;
    authorAgentId?: string;
    screenshotScale?: number;
    screenshotWidth?: number;
    screenshotHeight?: number;
  } | null;
}

const RESEARCH_INTERVENTION_TTL_MS = 10 * 60_000;
const RESEARCH_CONSENT_RECOVERY_TTL_MS = 5 * 60_000;
const RESEARCH_COMPLETION_POLL_MS = 500;
const RESEARCH_BACKGROUND_VIEWPORT: Rectangle = { x: 0, y: 0, width: 1280, height: 900 };

// Fixed, boolean-only probe. CAPTCHA response values never cross the isolated
// WebContents boundary; their presence is enough to resume reobservation.
const RESEARCH_CHALLENGE_CLEARED_PROBE = String.raw`(() => {
  const hasResponse = (selectors) => selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some((node) => {
    const value = typeof node.value === 'string' ? node.value : node.getAttribute('value');
    return typeof value === 'string' && value.trim().length > 0;
  }));
  if (hasResponse([
    'textarea[name="g-recaptcha-response"]', 'input[name="g-recaptcha-response"]',
    'textarea[name="h-captcha-response"]', 'input[name="h-captcha-response"]',
    'textarea[name="hcaptcha-response"]', 'input[name="hcaptcha-response"]',
    'textarea[name="cf-turnstile-response"]', 'input[name="cf-turnstile-response"]'
  ])) return true;
  const widget = document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="challenges.cloudflare.com" i]');
  const surface = [document.title, ...Array.from(document.querySelectorAll('h1,h2,[role="heading"],[role="alert"]')).slice(0, 8).map((node) => node.textContent)].join(' ').toLowerCase();
  const blockingCopy = /verify (you are )?human|verify your identity|human verification|just a moment|attention required/.test(surface);
  const genericCaptcha = /captcha/.test(surface) && (document.body?.innerText || '').length < 5000;
  const cloudflare = location.pathname.includes('/cdn-cgi/challenge-platform/') || document.querySelector('#challenge-form, [class*="cf-chl-" i], [id*="cf-chl-" i]');
  return !widget && !blockingCopy && !genericCaptcha && !cloudflare;
})()`;

function isNoDocumentNavigationAbort(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_ABORTED") return true;
  return error instanceof Error && error.message.includes("ERR_ABORTED");
}

function researchViewOptions(
  partition: string,
): WebContentsViewConstructorOptions {
  return {
    webPreferences: {
      partition,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  };
}

/**
 * Owns one anonymous Electron research target that remains detached while the
 * agent works and may be attached to Nautilo's built-in Browser surface for a
 * bounded Human verification handoff.
 *
 * This target is deliberately separate from BrowserControlManager: it is never
 * written to browser-control-state.json and therefore cannot become the active
 * interactive provider target. The exact lease snapshot is consumed only by
 * the upcoming bounded research-read composite.
 */
export class BrowserResearchTargetManager {
  private active: ActiveResearchLease | null = null;

  constructor(private readonly deps: BrowserResearchTargetManagerDeps) {}

  async createLease(rawUrl: string): Promise<BrowserResearchLeaseSnapshot> {
    const urlPolicy = (
      this.deps.createUrlPolicy ?? createBrowserResearchUrlPolicy
    )();
    const requestedUrl = (await urlPolicy.assertAllowed(rawUrl, "navigation"))
      .href;
    if (this.active) throw new Error("Research browser is busy");

    const leaseId = (this.deps.createLeaseId ?? randomUUID)();
    const partition = `nautilo-research-${leaseId}`;
    const view = this.deps.createView(researchViewOptions(partition));
    // Record the intended agent viewport up front. Electron materializes it
    // only after the view is mounted; consent recovery does that offscreen.
    // Human presentation replaces these bounds explicitly.
    view.setBounds(RESEARCH_BACKGROUND_VIEWPORT);
    const session = view.webContents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.setPermissionCheckHandler(() => false);
    const requestGuard = (
      details: { url: string; resourceType?: string },
      callback: (response: { cancel: boolean }) => void,
    ): void => {
      // Main-frame redirects consume the bounded document-navigation budget.
      // Every other request remains DNS/public-address validated, but public
      // rendering fan-out cannot exhaust that budget or poison the page read.
      const purpose =
        details.resourceType === "mainFrame" ? "navigation" : "subresource";
      void urlPolicy.assertAllowed(details.url, purpose).then(
        () => callback({ cancel: false }),
        (error: unknown) => {
          this.deps.onWarning?.(
            "Blocked non-public research browser request",
            error,
          );
          callback({ cancel: true });
        },
      );
    };
    session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      requestGuard,
    );

    const downloadHandler = (event: { preventDefault(): void }): void =>
      event.preventDefault();
    session.on("will-download", downloadHandler);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    const failClosedNavigation = (
      event: { preventDefault(): void },
      nextUrl: string,
    ): void => {
      try {
        parseResearchHttpUrl(nextUrl);
      } catch {
        event.preventDefault();
        void this.release(leaseId);
      }
    };
    view.webContents.on("will-navigate", failClosedNavigation);

    let shim: BrowserControlCdpShimHandle;
    try {
      const startShim = this.deps.startCdpShim ?? startBrowserControlCdpShim;
      shim = await startShim({
        webContents: view.webContents as unknown as WebContents,
      });
    } catch (error) {
      session.webRequest.onBeforeRequest(
        { urls: ["http://*/*", "https://*/*"] },
        null,
      );
      session.removeListener("will-download", downloadHandler);
      if (!view.webContents.isDestroyed()) view.webContents.close();
      await this.clearEphemeralSession(session);
      throw error;
    }

    const lease: ActiveResearchLease = {
      leaseId,
      requestedUrl,
      partition,
      view,
      shim,
      urlPolicy,
      documentState: "loaded",
      downloadHandler,
      releasePromise: null,
      state: "agent_background",
      intervention: null,
      decisionPromise: null,
      resolveDecision: null,
      expiryTimer: null,
      completionPollTimer: null,
      completionProbePending: false,
      hostAttached: false,
      surfaceAttached: false,
      consentRecovery: null,
    };
    this.active = lease;

    const release = (): void => {
      void this.release(leaseId);
    };
    view.webContents.on("render-process-gone", release);
    view.webContents.on("unresponsive", release);

    try {
      await view.webContents.loadURL(requestedUrl);
    } catch (error) {
      // Chromium reports HTTP 204/205 and other successful no-document
      // responses as ERR_ABORTED because there is no renderer navigation to
      // commit. Preserve the live blank target so the shared page reader can
      // classify it as empty instead of misreporting a Desktop disconnect.
      const currentUrl = view.webContents.getURL();
      const noDocumentResponse =
        isNoDocumentNavigationAbort(error) &&
        this.active === lease &&
        !view.webContents.isDestroyed() &&
        (currentUrl === "" ||
          currentUrl === "about:blank" ||
          currentUrl === requestedUrl);
      if (!noDocumentResponse) {
        await this.release(leaseId);
        throw error;
      }
      lease.documentState = "no-document";
    }
    // Electron also has a second no-document behavior: loadURL resolves but
    // the fresh target never commits away from its initial blank document.
    // Since this is a new, detached, single-navigation view, a blank URL after
    // the awaited load is the same valid empty response, not a readable page.
    const committedUrl = view.webContents.getURL();
    if (committedUrl === "" || committedUrl === "about:blank") {
      lease.documentState = "no-document";
    }
    try {
      const currentUrl = committedUrl;
      await urlPolicy.assertAllowed(
        currentUrl.startsWith("http://") || currentUrl.startsWith("https://")
          ? currentUrl
          : requestedUrl,
        "navigation",
      );
    } catch (error) {
      await this.release(leaseId);
      throw error;
    }
    if (this.active !== lease || view.webContents.isDestroyed()) {
      throw new Error("Research browser target closed during navigation");
    }
    return this.snapshot(lease);
  }

  markChallenge(
    leaseId: string,
    binding: BrowserResearchInterventionBinding,
  ): BrowserResearchInterventionSnapshot | null {
    const lease = this.active;
    if (
      !lease ||
      lease.leaseId !== leaseId ||
      lease.state !== "agent_background"
    )
      return null;
    lease.state = "awaiting_choice";
    const interventionTtlMs =
      this.deps.interventionTtlMs ?? RESEARCH_INTERVENTION_TTL_MS;
    const expiresAt = Date.now() + interventionTtlMs;
    lease.intervention = {
      id: lease.leaseId,
      ...binding,
      state: "awaiting_choice",
      host: new URL(lease.view.webContents.getURL() || lease.requestedUrl)
        .hostname,
      reason: "human-verification",
      expiresAt: new Date(expiresAt).toISOString(),
    };
    lease.decisionPromise = new Promise((resolve) => {
      lease.resolveDecision = resolve;
    });
    lease.expiryTimer = setTimeout(() => {
      this.settleDecision(lease, "expired");
    }, interventionTtlMs);
    lease.expiryTimer.unref?.();
    return lease.intervention;
  }

  retainConsentRecovery(
    leaseId: string,
    binding: Pick<BrowserResearchInterventionBinding, "laneKey" | "authorAgentId">,
  ): BrowserResearchConsentRecoverySnapshot | null {
    const lease = this.active;
    if (!lease || lease.leaseId !== leaseId || lease.state !== "agent_background") return null;
    // A detached or fully clipped WebContentsView keeps a zero-sized Chromium
    // layout viewport even after setBounds(). Mount the exact anonymous target
    // beneath Workbench before visual recovery so screenshots and pixel input
    // operate on a real 1280x900 page without becoming visible to the user.
    lease.view.setBounds(RESEARCH_BACKGROUND_VIEWPORT);
    if (!lease.hostAttached) {
      if (!this.deps.attachBackgroundView(lease.view)) return null;
      lease.hostAttached = true;
    }
    const expiresAt = Date.now() + (this.deps.consentRecoveryTtlMs ?? RESEARCH_CONSENT_RECOVERY_TTL_MS);
    lease.state = "consent_recovery";
    lease.consentRecovery = {
      reference: randomBytes(32).toString("base64url"),
      expiresAt,
      laneKey: binding.laneKey,
      ...(binding.authorAgentId ? { authorAgentId: binding.authorAgentId } : {}),
    };
    this.scheduleConsentRecoveryExpiry(lease);
    return this.consentRecoverySnapshot(lease);
  }

  getConsentRecovery(
    reference: string,
    binding: Pick<BrowserResearchInterventionBinding, "laneKey" | "authorAgentId">,
  ): BrowserResearchConsentRecoverySnapshot | null {
    const lease = this.active;
    const recovery = lease?.consentRecovery;
    if (!lease || lease.state !== "consent_recovery" || !recovery ||
      recovery.reference !== reference || recovery.expiresAt <= Date.now() ||
      recovery.laneKey !== binding.laneKey ||
      recovery.authorAgentId !== binding.authorAgentId) return null;
    recovery.expiresAt = Date.now() + (this.deps.consentRecoveryTtlMs ?? RESEARCH_CONSENT_RECOVERY_TTL_MS);
    this.scheduleConsentRecoveryExpiry(lease);
    return this.consentRecoverySnapshot(lease);
  }

  private scheduleConsentRecoveryExpiry(lease: ActiveResearchLease): void {
    if (!lease.consentRecovery) return;
    if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
    const expectedReference = lease.consentRecovery.reference;
    lease.expiryTimer = setTimeout(() => {
      if (this.active?.consentRecovery?.reference === expectedReference) void this.release(lease.leaseId);
    }, Math.max(0, lease.consentRecovery.expiresAt - Date.now()));
    lease.expiryTimer.unref?.();
  }

  recordConsentRecoveryScreenshot(
    reference: string,
    scale: number,
    width: number,
    height: number,
  ): boolean {
    const lease = this.active;
    const recovery = lease?.consentRecovery;
    if (!lease || lease.state !== "consent_recovery" || !recovery || recovery.reference !== reference ||
      !Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(width) || width <= 0 ||
      !Number.isSafeInteger(height) || height <= 0) return false;
    recovery.screenshotScale = scale;
    recovery.screenshotWidth = width;
    recovery.screenshotHeight = height;
    return true;
  }

  private consentRecoverySnapshot(lease: ActiveResearchLease): BrowserResearchConsentRecoverySnapshot | null {
    const recovery = lease.consentRecovery;
    if (!recovery) return null;
    return {
      reference: recovery.reference,
      expiresAt: new Date(recovery.expiresAt).toISOString(),
      requestedUrl: lease.requestedUrl,
      currentUrl: lease.view.webContents.getURL() || lease.requestedUrl,
      cdpUrl: lease.shim.url,
      leaseId: lease.leaseId,
      ...(recovery.screenshotScale === undefined ? {} : { screenshotScale: recovery.screenshotScale }),
      ...(recovery.screenshotWidth === undefined ? {} : { screenshotWidth: recovery.screenshotWidth }),
      ...(recovery.screenshotHeight === undefined ? {} : { screenshotHeight: recovery.screenshotHeight }),
    };
  }

  getActiveIntervention(): BrowserResearchInterventionSnapshot | null {
    return this.active?.intervention ?? null;
  }

  async waitForDecision(
    leaseId: string,
    signal?: AbortSignal,
  ): Promise<BrowserResearchDecision> {
    const lease = this.active;
    if (!lease || lease.leaseId !== leaseId || !lease.decisionPromise)
      return "cancel";
    if (signal?.aborted) return "cancel";
    if (!signal) return lease.decisionPromise;
    let abortListener: (() => void) | null = null;
    try {
      return await Promise.race([
        lease.decisionPromise,
        new Promise<BrowserResearchDecision>((resolve) => {
          abortListener = () => resolve("cancel");
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      ]);
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  present(leaseId: string): BrowserResearchInterventionSnapshot | null {
    const lease = this.active;
    if (
      !lease ||
      lease.leaseId !== leaseId ||
      (lease.state !== "awaiting_choice" && lease.state !== "human_foreground")
    )
      return null;
    lease.state = "human_foreground";
    return lease.intervention;
  }

  attachSurface(leaseId: string, bounds: Rectangle): boolean {
    const lease = this.active;
    if (
      !lease ||
      lease.leaseId !== leaseId ||
      lease.state !== "human_foreground" ||
      lease.view.webContents.isDestroyed()
    )
      return false;
    if (!lease.surfaceAttached) {
      if (!lease.hostAttached) {
        if (!this.deps.attachView(lease.view)) return false;
        lease.hostAttached = true;
      }
      lease.surfaceAttached = true;
    }
    lease.view.setBounds(bounds);
    // A WebContentsView can receive pointer events while its owning renderer
    // retains keyboard focus. Human-verification surfaces must explicitly
    // focus the attached page so text-entry challenges work as expected.
    lease.view.webContents.focus();
    this.startCompletionMonitor(lease);
    return true;
  }

  detachSurface(leaseId: string): boolean {
    const lease = this.active;
    if (!lease || lease.leaseId !== leaseId) return false;
    if (lease.surfaceAttached && lease.hostAttached) {
      this.deps.detachView(lease.view);
      lease.hostAttached = false;
    }
    lease.surfaceAttached = false;
    this.stopCompletionMonitor(lease);
    return true;
  }

  resolveIntervention(
    leaseId: string,
    decision: "done" | "alternate" | "cancel",
  ): boolean {
    const lease = this.active;
    if (!lease || lease.leaseId !== leaseId || !lease.intervention)
      return false;
    if (decision === "done" && lease.state !== "human_foreground") return false;
    this.stopCompletionMonitor(lease);
    if (lease.surfaceAttached && lease.hostAttached) {
      this.deps.detachView(lease.view);
      lease.hostAttached = false;
    }
    lease.surfaceAttached = false;
    if (decision === "done") {
      lease.state = "reobserve";
      this.deps.onVerificationCleared?.(lease.leaseId);
    }
    this.settleDecision(lease, decision);
    return true;
  }

  getActiveLease(): BrowserResearchLeaseSnapshot | null {
    const lease = this.active;
    if (!lease || lease.view.webContents.isDestroyed()) return null;
    return this.snapshot(lease);
  }

  async prepareReobserve(
    leaseId: string,
  ): Promise<BrowserResearchLeaseSnapshot | null> {
    const lease = this.active;
    if (
      !lease ||
      lease.leaseId !== leaseId ||
      lease.state !== "reobserve" ||
      lease.view.webContents.isDestroyed()
    )
      return null;
    const currentUrl = lease.view.webContents.getURL() || lease.requestedUrl;
    try {
      await lease.urlPolicy.assertAllowed(currentUrl, "navigation");
    } catch (error) {
      this.deps.onWarning?.(
        "Blocked non-public research browser reobservation",
        error,
      );
      await this.release(leaseId);
      return null;
    }
    return this.snapshot(lease);
  }

  async release(leaseId: string): Promise<boolean> {
    const lease = this.active;
    if (!lease || lease.leaseId !== leaseId) return false;
    if (lease.releasePromise) return lease.releasePromise;
    this.settleDecision(lease, "cancel");
    this.active = null;
    lease.releasePromise = this.teardown(lease);
    return lease.releasePromise;
  }

  async disposeAll(): Promise<void> {
    const leaseId = this.active?.leaseId;
    if (leaseId) await this.release(leaseId);
  }

  private snapshot(lease: ActiveResearchLease): BrowserResearchLeaseSnapshot {
    return {
      leaseId: lease.leaseId,
      role: "research",
      requestedUrl: lease.requestedUrl,
      currentUrl: lease.view.webContents.getURL() || lease.requestedUrl,
      partition: lease.partition,
      cdpUrl: lease.shim.url,
      documentState: lease.documentState,
      state: lease.state,
    };
  }

  private async teardown(lease: ActiveResearchLease): Promise<boolean> {
    if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
    this.stopCompletionMonitor(lease);
    lease.shim.close();
    if (lease.hostAttached) this.deps.detachView(lease.view);
    lease.hostAttached = false;
    lease.surfaceAttached = false;
    lease.consentRecovery = null;
    lease.view.webContents.session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      null,
    );
    lease.view.webContents.session.removeListener(
      "will-download",
      lease.downloadHandler,
    );
    if (!lease.view.webContents.isDestroyed()) lease.view.webContents.close();
    await this.clearEphemeralSession(lease.view.webContents.session);
    this.deps.onSurfaceClosed?.(lease.leaseId);
    return true;
  }

  private settleDecision(
    lease: ActiveResearchLease,
    decision: BrowserResearchDecision,
  ): void {
    if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
    lease.expiryTimer = null;
    const resolve = lease.resolveDecision;
    lease.resolveDecision = null;
    resolve?.(decision);
  }

  private startCompletionMonitor(lease: ActiveResearchLease): void {
    if (lease.completionPollTimer) return;
    const poll = (): void => {
      if (
        this.active !== lease ||
        lease.state !== "human_foreground" ||
        lease.completionProbePending ||
        lease.view.webContents.isDestroyed()
      )
        return;
      lease.completionProbePending = true;
      void lease.view.webContents
        .executeJavaScript(RESEARCH_CHALLENGE_CLEARED_PROBE, false)
        .then(
          (cleared) => {
            lease.completionProbePending = false;
            if (
              cleared === true &&
              this.active === lease &&
              lease.state === "human_foreground"
            ) {
              this.resolveIntervention(lease.leaseId, "done");
            }
          },
          () => {
            lease.completionProbePending = false;
          },
        );
    };
    lease.completionPollTimer = setInterval(
      poll,
      this.deps.completionPollMs ?? RESEARCH_COMPLETION_POLL_MS,
    );
    lease.completionPollTimer.unref?.();
    poll();
  }

  private stopCompletionMonitor(lease: ActiveResearchLease): void {
    if (lease.completionPollTimer) clearInterval(lease.completionPollTimer);
    lease.completionPollTimer = null;
    lease.completionProbePending = false;
  }

  private async clearEphemeralSession(session: ResearchSession): Promise<void> {
    try {
      await session.clearStorageData();
      await session.clearCache?.();
    } catch (error) {
      this.deps.onWarning?.(
        "Failed to clear temporary research browser storage",
        error,
      );
    }
  }
}
