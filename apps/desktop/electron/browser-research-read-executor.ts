import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  browserArgvPrefix,
  agentBrowserArgv,
  agentBrowserMouseClickArgvs,
  agentBrowserViewportEvalArgv,
  browserImageCoordsToCss,
  normalizeBrowserPageReadResult,
  parseRelayBrowserResearchReadRequest,
  parseRelayBrowserResearchReadResult,
  type RelayBrowserResearchInitialReadRequest,
  type RelayBrowserResearchConsentRecoveryRequest,
  type RelayDispatchResult,
} from "@nautilo/relay";
import {
  agentBrowserPageReadAccessibilitySnapshotArgv,
  dispatchResearchBrowserPageRead,
  type BrowserPageReadDispatchDeps,
} from "./browser-page-read-dispatch";
import {
  type BrowserPageSnapshotOwnerBinding,
  type BrowserPageSnapshotStore,
} from "./browser-page-snapshot-store";
import type {
  BrowserResearchInterventionSnapshot,
  BrowserResearchConsentRecoverySnapshot,
  BrowserResearchLeaseSnapshot,
  BrowserResearchTargetManager,
} from "./browser-research-target-manager";
import {
  clearRoutineCookieWall,
  clickRoutineCookieControlByLabel,
  observeRoutineCookieWall,
  routineCookieControls,
} from "./browser-research-cookie-wall.ts";
import { parseAgentBrowserAccessibilitySnapshotEnvelope } from "./rendered-page-extractor.ts";

export interface BrowserResearchReadExecutorDeps {
  targetManager: Pick<BrowserResearchTargetManager,
    "createLease" | "getActiveLease" | "markChallenge" | "waitForDecision" | "prepareReobserve" | "release" |
    "retainConsentRecovery" | "getConsentRecovery" | "recordConsentRecoveryScreenshot">;
  agentBrowserBin: string;
  pluginRuntimeBin: string;
  providerScriptPath: string;
  exec: BrowserPageReadDispatchDeps["exec"];
  timeoutMs?: number;
  maxBuffer?: number;
  temporaryRoot?: string;
  onWarning?: (message: string, error?: unknown) => void;
  normalizeScreenshot?: (
    bytes: Buffer<ArrayBufferLike>,
    width: number,
    height: number,
  ) => Promise<{ readonly data: Buffer<ArrayBufferLike>; readonly width: number; readonly height: number }>;
  onIntervention?: (intervention: BrowserResearchInterventionSnapshot) => void;
  /** Electron-memory only; when present the lease may close before paging. */
  snapshotStore?: BrowserPageSnapshotStore;
  snapshotOwner?: BrowserPageSnapshotOwnerBinding;
  /** Present only when the exact v13 relay negotiated snapshot inspection. */
  publishSnapshotReference?: boolean;
}

/**
 * Composes one exact hidden research lease with agent-browser's direct-page
 * provider and the shared fixed page reader. Provider files and the daemon
 * session are lease-scoped and are always removed; the visible Browser's
 * provider state/config are never read or written.
 */
export class BrowserResearchReadExecutor {
  constructor(private readonly deps: BrowserResearchReadExecutorDeps) {}

  async recoverConsent(
    request: RelayBrowserResearchConsentRecoveryRequest,
    signal?: AbortSignal,
  ): Promise<RelayDispatchResult> {
    const recovery = this.deps.targetManager.getConsentRecovery(
      request.consentRecovery.reference,
      { laneKey: request.laneKey, ...(request.authorAgentId ? { authorAgentId: request.authorAgentId } : {}) },
    );
    if (!recovery || signal?.aborted) {
      return { status: "error", errorCode: "browser_research_expired", error: "The temporary consent-recovery Browser is no longer available." };
    }
    if (request.consentRecovery.operation === "abandon") {
      await this.deps.targetManager.release(recovery.leaseId);
      return { status: "ok", result: this.recoveryResult(recovery, "abandon", "released") };
    }

    let directory: string | null = null;
    let configPath: string | null = null;
    const session = `nautilo-research-${createHash("sha1").update(recovery.leaseId).digest("hex").slice(0, 12)}`;
    try {
      directory = await mkdtemp(join(this.deps.temporaryRoot ?? tmpdir(), "nautilo-research-recovery-"));
      const statePath = join(directory, "provider-state.json");
      configPath = join(directory, "agent-browser-provider.json");
      await writeFile(statePath, `${JSON.stringify({ version: 1, activeAppId: recovery.leaseId, views: [{
        appId: recovery.leaseId, role: "research", leaseId: recovery.leaseId, visible: false, state: "hot", cdpUrl: recovery.cdpUrl,
      }] })}\n`, { mode: 0o600 });
      await writeFile(configPath, `${JSON.stringify({ idleTimeout: "30s", plugins: [{
        name: "nautilo-browser", command: this.deps.pluginRuntimeBin,
        args: [this.deps.providerScriptPath, "--state", statePath], capabilities: ["browser.provider"],
      }] })}\n`, { mode: 0o600 });
      const input = {
        bin: this.deps.agentBrowserBin, cfgPath: configPath, session,
        timeoutMs: this.deps.timeoutMs ?? 30_000, maxBuffer: this.deps.maxBuffer ?? 9 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      };
      const operation = request.consentRecovery.operation;
      if (operation === "snapshot") {
        const captured = await this.deps.exec(this.deps.agentBrowserBin,
          agentBrowserPageReadAccessibilitySnapshotArgv(configPath, session),
          { timeout: input.timeoutMs, maxBuffer: input.maxBuffer, ...(signal ? { signal } : {}) });
        let envelope: unknown;
        try { envelope = JSON.parse(String(captured.stdout)); } catch { envelope = null; }
        const parsed = parseAgentBrowserAccessibilitySnapshotEnvelope(envelope);
        if (!parsed) return { status: "error", error: "The temporary consent surface could not be inspected." };
        return { status: "ok", result: {
          ...this.recoveryResult(recovery, operation, "consent_wall"),
          snapshot: parsed.snapshot.slice(0, 64_000),
          controls: routineCookieControls(parsed.snapshot).slice(0, 32),
        } };
      }
      if (operation === "screenshot") {
        const capturePath = join(directory, "consent-recovery.png");
        await this.deps.exec(this.deps.agentBrowserBin,
          agentBrowserArgv("browser_screenshot", { _capturePath: capturePath }, configPath, session),
          { timeout: input.timeoutMs, maxBuffer: input.maxBuffer, ...(signal ? { signal } : {}) });
        const sourceBytes = await readFile(capturePath);
        if (sourceBytes.length > 8 * 1024 * 1024) return { status: "error", error: "The temporary consent screenshot is too large." };
        const sourceWidth = sourceBytes.readUInt32BE(16);
        const sourceHeight = sourceBytes.readUInt32BE(20);
        const viewportCapture = await this.deps.exec(this.deps.agentBrowserBin,
          agentBrowserViewportEvalArgv(configPath, session),
          { timeout: input.timeoutMs, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) });
        const viewport = JSON.parse(String(viewportCapture.stdout).trim()) as { w?: unknown; h?: unknown; dpr?: unknown };
        const cssWidth = typeof viewport.w === "number" && viewport.w > 0 ? Math.round(viewport.w) : sourceWidth;
        const cssHeight = typeof viewport.h === "number" && viewport.h > 0 ? Math.round(viewport.h) : sourceHeight;
        // Retina captures are physically 2x (or more) in each dimension. The
        // model gains no useful consent-control detail from those extra pixels,
        // but their inline PNG payload can consume an enormous amount of
        // context. Normalize evidence to the CSS viewport while preserving
        // exact image-coordinate mapping for the following click.
        let bytes: Buffer<ArrayBufferLike> = sourceBytes;
        let imageWidth = sourceWidth;
        let imageHeight = sourceHeight;
        if (sourceWidth > cssWidth || sourceHeight > cssHeight) {
          if (!this.deps.normalizeScreenshot) {
            throw new Error("Screenshot normalization is unavailable.");
          }
          const normalized = await this.deps.normalizeScreenshot(sourceBytes, cssWidth, cssHeight);
          bytes = normalized.data;
          imageWidth = normalized.width;
          imageHeight = normalized.height;
        }
        if (bytes.length > 4 * 1024 * 1024) return { status: "error", error: "The temporary consent screenshot is too large." };
        const scale = cssWidth > 0 ? imageWidth / cssWidth : 1;
        this.deps.targetManager.recordConsentRecoveryScreenshot(recovery.reference, scale, imageWidth, imageHeight);
        return { status: "ok", result: {
          ...this.recoveryResult(recovery, operation, "consent_wall"),
          viewport: { cssWidth, cssHeight, imageWidth, imageHeight, scale },
          image: { mime: "image/png", base64: bytes.toString("base64") },
        } };
      }
      if (operation === "click_control") {
        const acted = await clickRoutineCookieControlByLabel(input, request.consentRecovery.label!, this.deps.exec);
        if (!acted.acted) return { status: "error", error: "That consent control is no longer safely actionable. Inspect the surface again." };
      } else if (operation === "click_coordinates") {
        if (recovery.screenshotScale === undefined || recovery.screenshotWidth === undefined || recovery.screenshotHeight === undefined ||
          request.consentRecovery.x! >= recovery.screenshotWidth || request.consentRecovery.y! >= recovery.screenshotHeight) {
          return { status: "error", error: "Capture the current consent screenshot before clicking image coordinates." };
        }
        const point = browserImageCoordsToCss(request.consentRecovery.x!, request.consentRecovery.y!, recovery.screenshotScale);
        for (const argv of agentBrowserMouseClickArgvs(configPath, session, point.cssX, point.cssY)) {
          await this.deps.exec(this.deps.agentBrowserBin, argv,
            { timeout: input.timeoutMs, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) });
        }
      } else if (operation === "wait") {
        await this.deps.exec(this.deps.agentBrowserBin,
          agentBrowserArgv("browser_wait", { milliseconds: request.consentRecovery.milliseconds! }, configPath, session),
          { timeout: input.timeoutMs, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) });
      }

      if (operation === "read") {
        const page = await dispatchResearchBrowserPageRead(
          request.consentRecovery.maxChars === undefined ? {} : { maxChars: request.consentRecovery.maxChars },
          recovery.requestedUrl,
          input,
          { hasActiveTarget: () => this.deps.targetManager.getActiveLease()?.leaseId === recovery.leaseId,
            exec: this.deps.exec,
            ...(this.deps.snapshotStore ? { snapshotStore: this.deps.snapshotStore } : {}),
            ...(this.deps.snapshotOwner ? { snapshotOwner: this.deps.snapshotOwner } : {}),
            ...(this.deps.publishSnapshotReference ? { publishSnapshotReference: true } : {}) },
        );
        if (page.status !== "ok") return page;
        const parsed = parseRelayBrowserResearchReadResult(page.result);
        if (!parsed.ok) return { status: "error", error: "The temporary consent page could not be read." };
        const observed = await observeRoutineCookieWall(input, this.deps.exec);
        if (!observed.observed) {
          await this.deps.targetManager.release(recovery.leaseId);
          return { status: "ok", result: { ...this.recoveryResult(recovery, operation, "cleared"), page: parsed.result } };
        }
        return { status: "ok", result: this.recoveryResult(recovery, operation, "consent_wall") };
      }
      const observed = await observeRoutineCookieWall(input, this.deps.exec);
      return { status: "ok", result: this.recoveryResult(recovery, operation, observed.observed ? "consent_wall" : "cleared") };
    } catch (error) {
      this.deps.onWarning?.("Browser consent recovery failed", error);
      return {
        status: "error",
        errorCode: "browser_research_recovery_failed",
        error: "The temporary consent-recovery Browser could not complete that action.",
      };
    } finally {
      if (configPath !== null) {
        try {
          await this.deps.exec(this.deps.agentBrowserBin, [...browserArgvPrefix(configPath, session), "close"], { timeout: 5_000, maxBuffer: 64 * 1024 });
        } catch {
          // Best-effort daemon cleanup; the isolated target and files still close below.
        }
      }
      if (directory !== null) await rm(directory, { recursive: true, force: true });
    }
  }

  private recoveryResult(
    recovery: BrowserResearchConsentRecoverySnapshot,
    operation: RelayBrowserResearchConsentRecoveryRequest["consentRecovery"]["operation"],
    state: "consent_wall" | "cleared" | "released",
  ) {
    return { kind: "browser_research_consent_recovery" as const, operation, reference: recovery.reference, expiresAt: recovery.expiresAt, state };
  }

  async read(request: RelayBrowserResearchInitialReadRequest, signal?: AbortSignal): Promise<RelayDispatchResult> {
    const parsedRequest = parseRelayBrowserResearchReadRequest(request);
    if (!parsedRequest.ok || "continuation" in parsedRequest.request || signal?.aborted) {
      return { status: "error", error: "browser research read is unavailable" };
    }
    let lease: BrowserResearchLeaseSnapshot;
    try {
      lease = await this.deps.targetManager.createLease(parsedRequest.request.url);
    } catch {
      // A local target/navigation failure is not evidence that the paired
      // Desktop transport was lost. Return the shared redacted page-failure
      // result so the cloud caller can retain its exact relay connection and
      // present an actionable retry/alternate-source outcome.
      return {
        status: "ok",
        result: normalizeBrowserPageReadResult(
          {
            targetRole: "research",
            requestedUrl: parsedRequest.request.url,
            ...(parsedRequest.request.maxChars === undefined ? {} : { maxChars: parsedRequest.request.maxChars }),
          },
          {},
          { transportFailure: "navigation-error" },
        ),
      };
    }
    let retainedForConsentRecovery = false;
    try {
      const first = await this.readOnce(lease, parsedRequest.request, signal);
      if (first.status !== "ok") return first;
      const parsedFirst = parseRelayBrowserResearchReadResult(first.result);
      if (!parsedFirst.ok) return { status: "error", error: "browser research read produced an invalid result" };
      if (parsedFirst.result.consentRecovery) {
        retainedForConsentRecovery = true;
        return first;
      }
      if (!parsedFirst.result.challenge.detected && parsedFirst.result.quality !== "challenge") return first;
      if (parsedRequest.request.challengeBehavior === "defer") return first;

      const intervention = this.deps.targetManager.markChallenge(lease.leaseId, {
        toolCallId: parsedRequest.request.toolCallId,
        laneKey: parsedRequest.request.laneKey,
        ...(parsedRequest.request.turnId ? { turnId: parsedRequest.request.turnId } : {}),
        ...(parsedRequest.request.authorAgentId ? { authorAgentId: parsedRequest.request.authorAgentId } : {}),
      });
      if (!intervention) return first;
      this.deps.onIntervention?.(intervention);
      const decision = await this.deps.targetManager.waitForDecision(lease.leaseId, signal);
      if (decision === "done") {
        const reobserveLease = await this.deps.targetManager.prepareReobserve(lease.leaseId);
        if (!reobserveLease) {
          return { status: "error", error: "The research browser moved to a disallowed or unavailable page." };
        }
        return await this.readOnce(reobserveLease, parsedRequest.request, signal);
      }
      if (decision === "alternate") {
        return { status: "error", errorCode: "browser_research_alternate", error: "The Human requested another source." };
      }
      if (decision === "expired") {
        return { status: "error", errorCode: "browser_research_expired", error: "The Human-verification handoff expired." };
      }
      return { status: "error", errorCode: "browser_research_cancelled", error: "The Human stopped browser research." };
    } finally {
      if (!retainedForConsentRecovery) await this.deps.targetManager.release(lease.leaseId);
    }
  }

  private async readOnce(
    lease: BrowserResearchLeaseSnapshot,
    request: RelayBrowserResearchInitialReadRequest,
    signal?: AbortSignal,
  ): Promise<RelayDispatchResult> {
    if (lease.documentState === "no-document") {
      return {
        status: "ok",
        result: normalizeBrowserPageReadResult(
          {
            targetRole: "research",
            requestedUrl: lease.requestedUrl,
            ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
          },
          {
            finalUrl: lease.requestedUrl,
            title: "",
            readiness: "complete",
            root: "none",
            blocks: [],
            totalCharacters: 0,
            totalCharactersCapped: false,
            metadataTruncated: false,
            iframeCount: 0,
            canvasCount: 0,
            virtualizedHint: false,
            boilerplateHint: false,
            challengeSignals: [],
            sourceTruncated: false,
          },
        ),
      };
    }
    const session = `nautilo-research-${createHash("sha1")
      .update(lease.leaseId)
      .digest("hex")
      .slice(0, 12)}`;
    let directory: string | null = null;
    let configPath: string | null = null;

    try {
      if (signal?.aborted) {
        return { status: "error", error: "browser research read was cancelled" };
      }
      directory = await mkdtemp(join(this.deps.temporaryRoot ?? tmpdir(), "nautilo-research-"));
      const statePath = join(directory, "provider-state.json");
      configPath = join(directory, "agent-browser-provider.json");
      await writeFile(
        statePath,
        `${JSON.stringify({
          version: 1,
          activeAppId: lease.leaseId,
          views: [
            {
              appId: lease.leaseId,
              role: "research",
              leaseId: lease.leaseId,
              visible: false,
              state: "hot",
              cdpUrl: lease.cdpUrl,
            },
          ],
        })}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        configPath,
        `${JSON.stringify({
          // This config and its direct-page session are lease-scoped. The
          // daemon may outlive `close`, so use agent-browser's own bounded
          // idle shutdown instead of leaving one process per research read.
          idleTimeout: "30s",
          plugins: [
            {
              name: "nautilo-browser",
              command: this.deps.pluginRuntimeBin,
              args: [this.deps.providerScriptPath, "--state", statePath],
              capabilities: ["browser.provider"],
            },
          ],
        })}\n`,
        { mode: 0o600 },
      );

      const deadline = Date.now() + (this.deps.timeoutMs ?? 30_000);
      const remainingTimeout = () => Math.max(0, deadline - Date.now());
      const dispatchInput = {
          bin: this.deps.agentBrowserBin,
          cfgPath: configPath,
          session,
          timeoutMs: remainingTimeout(),
          maxBuffer: this.deps.maxBuffer ?? 1024 * 1024,
          ...(signal === undefined ? {} : { signal }),
        };
      const dispatchDeps = {
          hasActiveTarget: () =>
            this.deps.targetManager.getActiveLease()?.leaseId === lease.leaseId,
          exec: this.deps.exec,
          ...(this.deps.snapshotStore === undefined ? {} : { snapshotStore: this.deps.snapshotStore }),
          ...(this.deps.snapshotOwner === undefined ? {} : { snapshotOwner: this.deps.snapshotOwner }),
          ...(this.deps.publishSnapshotReference === true ? { publishSnapshotReference: true } : {}),
        };
      for (const label of request.consentActions ?? []) {
        const actionTimeout = remainingTimeout();
        if (actionTimeout === 0 || signal?.aborted) break;
        const action = await clickRoutineCookieControlByLabel(
          { ...dispatchInput, timeoutMs: actionTimeout },
          label,
          this.deps.exec,
        );
        if (!action.acted) break;
      }
      let dispatched = await dispatchResearchBrowserPageRead(
        request.maxChars === undefined ? {} : { maxChars: request.maxChars },
        lease.requestedUrl,
        dispatchInput,
        dispatchDeps,
      );
      if (dispatched.status !== "ok") return dispatched;
      let parsedResult = parseRelayBrowserResearchReadResult(dispatched.result);
      let consentReceipt: string | undefined;
      if (parsedResult.ok) {
        const consentTimeout = remainingTimeout();
        const cleared = consentTimeout > 0
          ? await clearRoutineCookieWall({ ...dispatchInput, timeoutMs: consentTimeout }, this.deps.exec)
          : { observed: false, acted: false };
        let consentWallRemains = cleared.observed;
        const reobserveTimeout = remainingTimeout();
        if (cleared.acted && !signal?.aborted && reobserveTimeout > 0) {
          dispatched = await dispatchResearchBrowserPageRead(
            request.maxChars === undefined ? {} : { maxChars: request.maxChars },
            lease.requestedUrl,
            { ...dispatchInput, timeoutMs: reobserveTimeout },
            dispatchDeps,
          );
          if (dispatched.status !== "ok") return dispatched;
          parsedResult = parseRelayBrowserResearchReadResult(dispatched.result);
          const postReadTimeout = remainingTimeout();
          if (parsedResult.ok && postReadTimeout > 0) {
            consentWallRemains = (await observeRoutineCookieWall(
              { ...dispatchInput, timeoutMs: postReadTimeout },
              this.deps.exec,
            )).observed;
            if (!consentWallRemains && cleared.action) {
              consentReceipt = `consent-cleared-${cleared.action.replaceAll("_", "-")}`;
            }
          }
        }
        if (consentWallRemains && parsedResult.ok) {
          const recovery = this.deps.targetManager.retainConsentRecovery(lease.leaseId, {
            laneKey: request.laneKey,
            ...(request.authorAgentId ? { authorAgentId: request.authorAgentId } : {}),
          });
          return {
            status: "ok",
            result: {
              ...parsedResult.result,
              failure: "consent-wall",
              diagnostics: [...new Set([
                ...parsedResult.result.diagnostics,
                ...(cleared.action ? [`consent-attempted-${cleared.action.replaceAll("_", "-")}`] : ["consent-wall-observed"]),
                "consent-wall-remained",
              ])].slice(0, 8),
              ...(recovery ? { consentRecovery: {
                version: 1 as const,
                reference: recovery.reference,
                expiresAt: recovery.expiresAt,
                operations: ["snapshot", "screenshot", "click_control", "click_coordinates", "wait", "read", "abandon"] as const,
              } } : {}),
            },
          };
        }
      }
      return parsedResult.ok
        ? {
            status: "ok",
            result: consentReceipt
              ? { ...parsedResult.result, diagnostics: [...new Set([...parsedResult.result.diagnostics, consentReceipt])].slice(0, 8) }
              : parsedResult.result,
          }
        : { status: "error", error: "browser research read produced an invalid result" };
    } finally {
      if (configPath !== null) {
        try {
          await this.deps.exec(
            this.deps.agentBrowserBin,
            [...browserArgvPrefix(configPath, session), "close"],
            { timeout: 5_000, maxBuffer: 64 * 1024 },
          );
        } catch (error) {
          this.deps.onWarning?.("Failed to close the research agent-browser session", error);
        }
      }
      if (directory !== null) await rm(directory, { recursive: true, force: true });
    }
  }
}
