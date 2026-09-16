import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserArgvPrefix,
  buildDuckDuckGoHtmlSearchUrl,
  parseDuckDuckGoHtmlResults,
  parseRelayBrowserResearchSearchRequest,
  parseRelayBrowserResearchSearchResult,
  type RelayBrowserResearchSearchRequest,
  type RelayDispatchResult,
} from "@nautilo/relay";
import {
  agentBrowserPageReadHtmlArgv,
  parseAgentBrowserRenderedHtmlEnvelope,
  type BrowserPageReadDispatchDeps,
} from "./browser-page-read-dispatch.ts";
import type { BrowserResearchLeaseSnapshot, BrowserResearchTargetManager } from "./browser-research-target-manager.ts";
import { clearRoutineCookieWall, looksLikeRoutineCookieWallText } from "./browser-research-cookie-wall.ts";

export interface BrowserResearchSearchExecutorDeps {
  targetManager: Pick<BrowserResearchTargetManager, "createLease" | "getActiveLease" | "release">;
  agentBrowserBin: string;
  pluginRuntimeBin: string;
  providerScriptPath: string;
  exec: BrowserPageReadDispatchDeps["exec"];
  timeoutMs?: number;
  maxBuffer?: number;
  temporaryRoot?: string;
  onWarning?: (message: string, error?: unknown) => void;
}

/** Fixed-host rendered search discovery in Electron's anonymous research target. */
export class BrowserResearchSearchExecutor {
  constructor(private readonly deps: BrowserResearchSearchExecutorDeps) {}

  async search(request: RelayBrowserResearchSearchRequest, signal?: AbortSignal): Promise<RelayDispatchResult> {
    const parsed = parseRelayBrowserResearchSearchRequest(request);
    if (!parsed.ok || signal?.aborted) return { status: "error", error: "browser research search is unavailable" };
    const url = buildDuckDuckGoHtmlSearchUrl(parsed.request.query);
    if (!url) return this.result([], "invalid_query");

    let lease: BrowserResearchLeaseSnapshot;
    try {
      lease = await this.deps.targetManager.createLease(url);
    } catch {
      return this.result([], "navigation_error");
    }
    try {
      return await this.searchLease(lease, parsed.request.maxResults, signal);
    } finally {
      await this.deps.targetManager.release(lease.leaseId);
    }
  }

  private result(items: unknown[], failure?: import("@nautilo/relay").DuckDuckGoHtmlSearchFailureKind): RelayDispatchResult {
    const candidate = { provider: "duckduckgo_html" as const, items, ...(failure ? { failure } : {}) };
    const parsed = parseRelayBrowserResearchSearchResult(candidate);
    return parsed.ok
      ? { status: "ok", result: parsed.result }
      : { status: "error", error: "browser research search produced an invalid result" };
  }

  private async searchLease(
    lease: BrowserResearchLeaseSnapshot,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<RelayDispatchResult> {
    if (lease.documentState === "no-document") return this.result([], "render_failed");
    const session = `nautilo-research-search-${createHash("sha1").update(lease.leaseId).digest("hex").slice(0, 12)}`;
    let directory: string | null = null;
    let configPath: string | null = null;
    try {
      if (signal?.aborted) return { status: "error", errorCode: "browser_research_cancelled", error: "browser research search was cancelled" };
      directory = await mkdtemp(join(this.deps.temporaryRoot ?? tmpdir(), "nautilo-research-search-"));
      const statePath = join(directory, "provider-state.json");
      configPath = join(directory, "agent-browser-provider.json");
      await writeFile(statePath, `${JSON.stringify({
        version: 1,
        activeAppId: lease.leaseId,
        views: [{ appId: lease.leaseId, role: "research", leaseId: lease.leaseId, visible: false, state: "hot", cdpUrl: lease.cdpUrl }],
      })}\n`, { mode: 0o600 });
      await writeFile(configPath, `${JSON.stringify({
        idleTimeout: "30s",
        plugins: [{ name: "nautilo-browser", command: this.deps.pluginRuntimeBin, args: [this.deps.providerScriptPath, "--state", statePath], capabilities: ["browser.provider"] }],
      })}\n`, { mode: 0o600 });
      if (this.deps.targetManager.getActiveLease()?.leaseId !== lease.leaseId) return this.result([], "navigation_error");
      const deadline = Date.now() + (this.deps.timeoutMs ?? 30_000);
      const remainingTimeout = () => Math.max(0, deadline - Date.now());
      const execOptions = { timeout: remainingTimeout(), maxBuffer: this.deps.maxBuffer ?? 9 * 1024 * 1024, ...(signal ? { signal } : {}) };
      let capture = await this.deps.exec(
        this.deps.agentBrowserBin,
        agentBrowserPageReadHtmlArgv(configPath, session),
        execOptions,
      );
      let html = parseAgentBrowserRenderedHtmlEnvelope(String(capture.stdout));
      if (html === undefined) return this.result([], "render_failed");
      let outcome = parseDuckDuckGoHtmlResults(html, { maxResults });
      if (!outcome.ok && looksLikeRoutineCookieWallText(html)) {
        const consentTimeout = remainingTimeout();
        const cleared = consentTimeout > 0 ? await clearRoutineCookieWall({
          bin: this.deps.agentBrowserBin,
          cfgPath: configPath,
          session,
          timeoutMs: consentTimeout,
          maxBuffer: this.deps.maxBuffer ?? 9 * 1024 * 1024,
          ...(signal ? { signal } : {}),
        }, this.deps.exec) : { acted: false };
        const recaptureTimeout = remainingTimeout();
        if (cleared.acted && !signal?.aborted && recaptureTimeout > 0) {
          capture = await this.deps.exec(this.deps.agentBrowserBin, agentBrowserPageReadHtmlArgv(configPath, session), { ...execOptions, timeout: recaptureTimeout });
          html = parseAgentBrowserRenderedHtmlEnvelope(String(capture.stdout));
          if (html === undefined) return this.result([], "render_failed");
          outcome = parseDuckDuckGoHtmlResults(html, { maxResults });
        }
      }
      return outcome.ok ? this.result([...outcome.items]) : this.result([], outcome.failure);
    } catch {
      return signal?.aborted
        ? { status: "error", errorCode: "browser_research_cancelled", error: "browser research search was cancelled" }
        : this.result([], "render_failed");
    } finally {
      if (configPath !== null) {
        try {
          await this.deps.exec(this.deps.agentBrowserBin, [...browserArgvPrefix(configPath, session), "close"], { timeout: 5_000, maxBuffer: 64 * 1024 });
        } catch (error) {
          this.deps.onWarning?.("Failed to close the research search agent-browser session", error);
        }
      }
      if (directory !== null) await rm(directory, { recursive: true, force: true });
    }
  }
}
