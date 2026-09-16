/**
 * Electron-local provider/runtime integration used by the Relay broker.
 *
 * This module owns binary discovery, health probes, provider configuration,
 * and provider-specific OAuth preparation. relay.ts consumes the resulting
 * narrow ports and capability projections; it does not own provider behavior.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  type OpenHueExecutor,
  type RelayCapabilities,
  type RelayDispatchResult,
} from "@nautilo/relay";

import {
  browserControlStateHasActiveView,
  browserControlStateSessionId,
} from "./browser-control-state.ts";
import { probeDesktopFfmpeg } from "./ffmpeg-runtime.ts";
import {
  canAdvertiseGoogleWorkspaceCapability,
  ensureGogKeyringBackend,
  ensureGoogleOAuthClientConfig,
  ensureGogKeyringPasswordEnv,
  GOG_KEYRING_PASSWORD_FILENAME,
  GOOGLE_OAUTH_CLIENT_FILENAME,
  hasHealthyGogAuthAccount,
  queryGoogleOAuthConfigured,
} from "./google-workspace-oauth.ts";
import {
  browserControlAgentBrowserConfigPath,
  browserControlStateFilePath,
  toolRuntimeConfigFilePath,
} from "./paths.ts";
import {
  clearPersistedToolRuntimePath,
  getConfiguredToolRuntimePath,
  persistToolRuntimePath,
  type ToolRuntimeHealth,
  type ToolRuntimeName,
} from "./tool-runtime-config.ts";
import type { DesktopRelayGoogleOAuthContext } from "./desktop-relay-session.ts";

const execFileAsync = promisify(execFile);
const EXEC_PROBE_TIMEOUT_MS = 5_000;
const OPENHUE_PROBE_TIMEOUT_MS = 5_000;
const AGENT_BROWSER_COMMON_CANDIDATES = [
  "/opt/homebrew/bin/agent-browser",
  "/usr/local/bin/agent-browser",
] as const;
const GOG_COMMON_CANDIDATES = [
  "/opt/homebrew/bin/gog",
  "/usr/local/bin/gog",
] as const;

export interface ToolRuntimeStatus {
  tool: ToolRuntimeName;
  configuredPath: string | null;
  resolvedPath: string | null;
  source: "configured" | "bundled" | "app-managed" | "common" | "path" | "env" | null;
  version: string | null;
  health: ToolRuntimeHealth;
  authHealthy?: boolean;
  checkedAt: string;
}

type RuntimeCandidateSource = Exclude<ToolRuntimeStatus["source"], null>;
interface RuntimeCandidate {
  bin: string;
  source: RuntimeCandidateSource;
}

let cachedAgentBrowserBin: string | null | undefined;
let cachedGogBin: string | null | undefined;
let cachedOpenHueBin: string | null | undefined;

export function parsePngIhdrDimensions(pngBytes: Buffer): { width: number; height: number } {
  if (pngBytes.length < 24 || pngBytes.toString("ascii", 1, 4) !== "PNG") {
    return { width: 0, height: 0 };
  }
  return {
    width: pngBytes.readUInt32BE(16),
    height: pngBytes.readUInt32BE(20),
  };
}

function bundledToolPath(name: string): string | null {
  if (!process.resourcesPath) return null;
  const root = name === "agent-browser"
    ? "tools-agent-browser"
    : name === "gog" ? "tools-gog" : "tools";
  const arched = path.join(process.resourcesPath, root, process.arch, name);
  if (fsSync.existsSync(arched)) return arched;
  const flat = path.join(process.resourcesPath, root, name);
  return fsSync.existsSync(flat) ? flat : null;
}

function devVendoredToolPath(name: string): string | null {
  const root = name === "agent-browser"
    ? "agent-browser"
    : name === "gog" ? "gog" : name === "openhue" ? "openhue" : null;
  if (!root) return null;
  const arched = path.join(__dirname, "..", "vendor", root, process.arch, name);
  if (fsSync.existsSync(arched)) return arched;
  const flat = path.join(__dirname, "..", "vendor", root, name);
  return fsSync.existsSync(flat) ? flat : null;
}

function bundledBunPath(): string | null {
  if (!process.resourcesPath) return null;
  const bundled = path.join(process.resourcesPath, "bun", process.arch, "bun");
  return fsSync.existsSync(bundled) ? bundled : null;
}

export function resolvePluginRuntimeBin(): string {
  return bundledBunPath() ?? "bun";
}

function runtimeCandidates(
  name: string,
  tool: ToolRuntimeName,
  envVar: string,
  bundledCandidates: Array<string | null>,
  appManagedCandidates: readonly string[],
  commonCandidates: readonly string[],
): RuntimeCandidate[] {
  const candidates: RuntimeCandidate[] = [];
  const configured = getConfiguredToolRuntimePath(toolRuntimeConfigFilePath(), tool);
  if (configured) candidates.push({ bin: configured, source: "configured" });
  for (const bundled of bundledCandidates) {
    if (bundled) candidates.push({ bin: bundled, source: "bundled" });
  }
  for (const candidate of appManagedCandidates) {
    candidates.push({ bin: candidate, source: "app-managed" });
  }
  for (const candidate of commonCandidates) {
    if (fsSync.existsSync(candidate)) candidates.push({ bin: candidate, source: "common" });
  }
  candidates.push({ bin: name, source: "path" });
  const override = process.env[envVar];
  if (override !== undefined && override.length > 0) {
    candidates.push({ bin: override, source: "env" });
  }
  return candidates;
}

function resolveExecutable(
  name: string,
  envVar: string,
  tool: ToolRuntimeName,
  bundledCandidates: Array<string | null>,
  appManagedCandidates: readonly string[],
  commonCandidates: readonly string[],
): string | null {
  let pathFallback: string | null = null;
  for (const candidate of runtimeCandidates(
    name,
    tool,
    envVar,
    bundledCandidates,
    appManagedCandidates,
    commonCandidates,
  )) {
    if (candidate.source === "path") {
      pathFallback = candidate.bin;
      continue;
    }
    if (fsSync.existsSync(candidate.bin)) return candidate.bin;
  }
  return pathFallback;
}

async function canRunExecutable(
  bin: string,
  args: readonly string[] = ["--version"],
): Promise<boolean> {
  try {
    await execFileAsync(bin, [...args], {
      timeout: EXEC_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

export async function resolveElectronIsPackaged(): Promise<boolean> {
  return (await resolveElectronPackagingState()) ?? false;
}

export async function resolveElectronPackagingState(): Promise<boolean | null> {
  try {
    const { app } = await import("electron");
    return typeof app.isPackaged === "boolean" ? app.isPackaged : null;
  } catch {
    return null;
  }
}

export async function probeFfmpeg(): Promise<
  | { ok: true; bin: string }
  | { ok: false; code: "FFMPEG_MISSING" | "FFMPEG_UNAVAILABLE"; message: string }
> {
  const resolved = await probeDesktopFfmpeg({
    isPackaged: await resolveElectronIsPackaged(),
  });
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.error };
  try {
    await execFileAsync(resolved.binaryPath, ["-version"], {
      timeout: EXEC_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, bin: resolved.binaryPath };
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? { ok: false, code: "FFMPEG_MISSING", message: "Managed FFmpeg is missing from this desktop relay." }
      : { ok: false, code: "FFMPEG_UNAVAILABLE", message: "Managed FFmpeg is present but cannot run on this desktop relay." };
  }
}

async function executableVersion(bin: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["--version"], {
      timeout: EXEC_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return (stdout || stderr).trim().split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

async function resolveRunnableExecutable(
  name: string,
  envVar: string,
  tool: ToolRuntimeName,
  bundledCandidates: Array<string | null>,
  appManagedCandidates: readonly string[],
  commonCandidates: readonly string[],
): Promise<{ bin: string; source: RuntimeCandidateSource; version: string | null } | null> {
  for (const candidate of runtimeCandidates(
    name,
    tool,
    envVar,
    bundledCandidates,
    appManagedCandidates,
    commonCandidates,
  )) {
    if (candidate.source !== "path" && !fsSync.existsSync(candidate.bin)) continue;
    if (!(await canRunExecutable(candidate.bin))) continue;
    return { bin: candidate.bin, source: candidate.source, version: await executableVersion(candidate.bin) };
  }
  return null;
}

export async function isGogAuthHealthy(bin: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(bin, ["auth", "list", "--check", "--json", "--no-input"], {
      timeout: EXEC_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return hasHealthyGogAuthAccount(stdout);
  } catch {
    return false;
  }
}

async function probeGogAuthHealth(
  bin: string,
  context: DesktopRelayGoogleOAuthContext | null,
  isClosed: () => boolean,
): Promise<boolean> {
  if (!applyGogKeyringPasswordEnv(context, isClosed)) return false;
  if (isClosed()) return false;
  await ensureGogKeyringBackend(bin, execFileAsync);
  if (isClosed()) return false;
  return isGogAuthHealthy(bin);
}

function toolRuntimeMetadata(version: string | null, health: ToolRuntimeHealth) {
  return {
    ...(version ? { lastKnownVersion: version } : {}),
    lastHealth: health,
    lastCheckedAt: new Date().toISOString(),
  };
}

export function agentBrowserInstallHint(): string {
  return "Install agent-browser (e.g. `brew install agent-browser`) or set NAUTILO_AGENT_BROWSER_BIN to a runnable binary.";
}

export function gogInstallHint(): string {
  return "Install gogcli (e.g. `brew install steipete/tap/gogcli`) or set NAUTILO_GOG_BIN to a runnable binary.";
}

function googleOAuthClientPath(context: DesktopRelayGoogleOAuthContext | null): string {
  return context?.clientPath ?? path.join(os.homedir(), ".nautilo", GOOGLE_OAUTH_CLIENT_FILENAME);
}

function gogKeyringPasswordPath(context: DesktopRelayGoogleOAuthContext | null): string {
  return path.join(path.dirname(googleOAuthClientPath(context)), GOG_KEYRING_PASSWORD_FILENAME);
}

function applyGogKeyringPasswordEnv(
  context: DesktopRelayGoogleOAuthContext | null,
  isClosed: () => boolean,
): boolean {
  if (isClosed()) return false;
  ensureGogKeyringPasswordEnv(gogKeyringPasswordPath(context), {
    existsSync: fsSync.existsSync,
    readFileSync: (filePath) => fsSync.readFileSync(filePath, "utf8"),
    writeFileSync: (filePath, data, opts) => fsSync.writeFileSync(filePath, data, opts),
    randomPassword: () => randomBytes(32).toString("hex"),
  });
  return !isClosed();
}

export async function prepareGoogleWorkspaceKeyring(
  bin: string,
  context: DesktopRelayGoogleOAuthContext | null,
  isClosed: () => boolean,
): Promise<void> {
  if (!applyGogKeyringPasswordEnv(context, isClosed) || isClosed()) {
    throw new Error("Desktop relay session retired");
  }
  await ensureGogKeyringBackend(bin, execFileAsync);
  if (isClosed()) throw new Error("Desktop relay session retired");
}

function googleOAuthClientSetupError(reason: string): RelayDispatchResult {
  switch (reason) {
    case "not_configured_on_server":
      return { status: "error", error: "Google Workspace integration is not configured on this server. Ask an administrator to upload the Google OAuth client JSON in Settings -> Integrations." };
    case "capability_missing":
      return { status: "error", error: "Your account is not allowed to use Google Workspace on this server. Ask an administrator to grant the use_google_workspace capability." };
    case "not_signed_in":
      return { status: "error", error: "Sign in to Nautilo before connecting Google Workspace." };
    case "fetch_failed":
      return { status: "error", error: "Could not download the Google OAuth client JSON from the server. Check your connection and retry." };
    case "gog_credentials_set_failed":
      return { status: "error", error: "Downloaded the Google OAuth client JSON, but gog rejected it during credentials setup." };
    default:
      return { status: "error", error: `Could not prepare Google Workspace OAuth client (${reason}).` };
  }
}

export async function ensureGoogleOAuthClientForDispatch(
  bin: string,
  context: DesktopRelayGoogleOAuthContext | null,
  isClosed: () => boolean,
): Promise<RelayDispatchResult | null> {
  if (!applyGogKeyringPasswordEnv(context, isClosed) || isClosed()) {
    return { status: "error", error: "Google Workspace relay session is no longer active." };
  }
  const oauthClientPath = googleOAuthClientPath(context);
  if (!fsSync.existsSync(oauthClientPath) && !context?.token) {
    return googleOAuthClientSetupError("not_signed_in");
  }
  if (isClosed()) return { status: "error", error: "Google Workspace relay session is no longer active." };
  const ensured = await ensureGoogleOAuthClientConfig(
    context?.serverUrl ?? "",
    context?.token ?? "",
    {
      fetchImpl: (...args) => {
        if (isClosed()) throw new Error("Desktop relay session retired");
        return globalThis.fetch(...args);
      },
      existsSync: fsSync.existsSync,
      writeFile: (filePath, data, opts) => isClosed()
        ? Promise.reject(new Error("Desktop relay session retired"))
        : fsp.writeFile(filePath, data, opts),
      execFileAsync: async (file, args, options) => {
        if (isClosed()) throw new Error("Desktop relay session retired");
        const { stdout, stderr } = await execFileAsync(file, [...args], options);
        return {
          stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
          stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
        };
      },
      resolveGogBin: () => bin,
      oauthClientPath,
    },
  );
  return ensured.ok ? null : googleOAuthClientSetupError(ensured.reason);
}

export function resolveToolsBin(): string {
  const override = process.env["NAUTILO_TOOLS_BIN"];
  if (override !== undefined && override.length > 0) return override;
  const candidates = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".bun", "bin"),
  ];
  for (const candidate of candidates) {
    try {
      if (fsSync.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next local runtime root.
    }
  }
  return "/usr/local/bin";
}

export function resolveAgentBrowserBin(): string | null {
  if (cachedAgentBrowserBin !== undefined) return cachedAgentBrowserBin;
  return resolveExecutable(
    "agent-browser",
    "NAUTILO_AGENT_BROWSER_BIN",
    "agent-browser",
    [bundledToolPath("agent-browser"), devVendoredToolPath("agent-browser")],
    [path.join(resolveToolsBin(), "agent-browser")],
    AGENT_BROWSER_COMMON_CANDIDATES,
  );
}

export function resolveGogBin(): string | null {
  if (cachedGogBin !== undefined) return cachedGogBin;
  return resolveExecutable(
    "gog",
    "NAUTILO_GOG_BIN",
    "gog",
    [bundledToolPath("gog"), devVendoredToolPath("gog")],
    [path.join(resolveToolsBin(), "gog")],
    GOG_COMMON_CANDIDATES,
  );
}

export function resolveOpenHueBin(): string {
  const override = process.env["NAUTILO_OPENHUE_BIN"];
  if (override !== undefined && override.length > 0) return override;
  const appManaged = path.join(resolveToolsBin(), "openhue");
  return bundledToolPath("openhue") ?? devVendoredToolPath("openhue") ??
    (fsSync.existsSync(appManaged) ? appManaged : null) ?? "openhue";
}

async function canRunOpenHue(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ["version"], {
      timeout: OPENHUE_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

export const openHueExecutor: OpenHueExecutor = {
  async execute(binary, argv, options) {
    try {
      const { stdout, stderr } = await execFileAsync(binary, [...argv], {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { code?: string | number | null; stdout?: string; stderr?: string; message?: string };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message ?? "",
        exitCode: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  },
};

export function resolveOpenHueDispatchBin(): string {
  return cachedOpenHueBin ?? resolveOpenHueBin();
}

export async function openHueRuntimeCapabilities(
  probe: (bin: string) => Promise<boolean> = canRunOpenHue,
): Promise<Pick<RelayCapabilities, "canDiscoverHue" | "canControlHue">> {
  const bin = resolveOpenHueBin();
  if (!(await probe(bin))) {
    cachedOpenHueBin = null;
    return {};
  }
  cachedOpenHueBin = bin;
  return { canDiscoverHue: true, canControlHue: true };
}

export async function browserRuntimeCapabilities(): Promise<
  Pick<RelayCapabilities, "canControlBrowser" | "browserSessionId">
> {
  const resolved = await resolveRunnableExecutable(
    "agent-browser",
    "NAUTILO_AGENT_BROWSER_BIN",
    "agent-browser",
    [bundledToolPath("agent-browser"), devVendoredToolPath("agent-browser")],
    [path.join(resolveToolsBin(), "agent-browser")],
    AGENT_BROWSER_COMMON_CANDIDATES,
  );
  cachedAgentBrowserBin = resolved?.bin ?? null;
  if (resolved && resolved.source !== "configured" && resolved.source !== "env") {
    persistToolRuntimePath(toolRuntimeConfigFilePath(), "agent-browser", resolved.bin, "auto-detected", {
      ...toolRuntimeMetadata(resolved.version, "healthy"),
    });
  }
  if (!resolved) return {};
  let browserSessionId: string | undefined;
  try {
    const state = JSON.parse(fsSync.readFileSync(browserControlStateFilePath(), "utf8")) as {
      activeAppId?: string | null;
      views?: Array<{ appId?: string; cdpUrl?: string | null }>;
    };
    browserSessionId = browserControlStateSessionId(state) ?? undefined;
  } catch {
    browserSessionId = undefined;
  }
  return { canControlBrowser: true, ...(browserSessionId === undefined ? {} : { browserSessionId }) };
}

export async function googleWorkspaceRuntimeCapabilities(
  context: DesktopRelayGoogleOAuthContext | null,
  isClosed: () => boolean,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Pick<RelayCapabilities, "canUseGoogleWorkspace">> {
  const resolved = await resolveRunnableExecutable(
    "gog",
    "NAUTILO_GOG_BIN",
    "gog",
    [bundledToolPath("gog"), devVendoredToolPath("gog")],
    [path.join(resolveToolsBin(), "gog")],
    GOG_COMMON_CANDIDATES,
  );
  if (!resolved) {
    cachedGogBin = null;
    return {};
  }
  cachedGogBin = resolved.bin;
  const serverConfigured = context && !isClosed()
    ? await queryGoogleOAuthConfigured(context.serverUrl, context.token, fetchImpl)
    : false;
  const localAuthHealthy = await probeGogAuthHealth(resolved.bin, context, isClosed);
  const health: ToolRuntimeHealth = localAuthHealthy ? "auth-healthy" : serverConfigured ? "healthy" : "auth-missing";
  if (resolved.source !== "configured" && resolved.source !== "env") {
    persistToolRuntimePath(toolRuntimeConfigFilePath(), "gog", resolved.bin, "auto-detected", {
      ...toolRuntimeMetadata(resolved.version, health),
    });
  }
  return canAdvertiseGoogleWorkspaceCapability({
    gogRunnable: true,
    serverOAuthConfigured: serverConfigured,
    localGogAuthHealthy: localAuthHealthy,
  }) ? { canUseGoogleWorkspace: true } : {};
}

async function probeToolRuntime(
  tool: ToolRuntimeName,
  context: DesktopRelayGoogleOAuthContext | null,
  isClosed: () => boolean,
): Promise<ToolRuntimeStatus> {
  const checkedAt = new Date().toISOString();
  const configuredPath = getConfiguredToolRuntimePath(toolRuntimeConfigFilePath(), tool);
  const isGog = tool === "gog";
  const name = isGog ? "gog" : "agent-browser";
  const resolved = await resolveRunnableExecutable(
    name,
    isGog ? "NAUTILO_GOG_BIN" : "NAUTILO_AGENT_BROWSER_BIN",
    tool,
    [bundledToolPath(name), devVendoredToolPath(name)],
    [path.join(resolveToolsBin(), name)],
    isGog ? GOG_COMMON_CANDIDATES : AGENT_BROWSER_COMMON_CANDIDATES,
  );
  if (!resolved) {
    return { tool, configuredPath, resolvedPath: null, source: null, version: null, health: "missing", checkedAt };
  }
  const authHealthy = isGog ? await probeGogAuthHealth(resolved.bin, context, isClosed) : undefined;
  const health: ToolRuntimeHealth = isGog ? authHealthy ? "auth-healthy" : "auth-missing" : "healthy";
  if (resolved.source !== "configured" && resolved.source !== "env") {
    persistToolRuntimePath(toolRuntimeConfigFilePath(), tool, resolved.bin, "auto-detected", {
      ...toolRuntimeMetadata(resolved.version, health),
    });
  }
  return {
    tool,
    configuredPath,
    resolvedPath: resolved.bin,
    source: resolved.source,
    version: resolved.version,
    health,
    ...(isGog ? { authHealthy: Boolean(authHealthy) } : {}),
    checkedAt,
  };
}

export async function getToolRuntimeStatus(
  context: DesktopRelayGoogleOAuthContext | null,
  isClosed: () => boolean,
): Promise<Record<ToolRuntimeName, ToolRuntimeStatus>> {
  return {
    "agent-browser": await probeToolRuntime("agent-browser", context, isClosed),
    gog: await probeToolRuntime("gog", context, isClosed),
  };
}

export async function refreshToolRuntimeStatus(
  context: DesktopRelayGoogleOAuthContext | null,
  isClosed: () => boolean,
): Promise<Record<ToolRuntimeName, ToolRuntimeStatus>> {
  cachedAgentBrowserBin = undefined;
  cachedGogBin = undefined;
  return getToolRuntimeStatus(context, isClosed);
}

export async function setToolRuntimePath(
  tool: ToolRuntimeName,
  configuredPath: string,
  context: DesktopRelayGoogleOAuthContext | null,
  isClosed: () => boolean,
): Promise<ToolRuntimeStatus> {
  persistToolRuntimePath(toolRuntimeConfigFilePath(), tool, configuredPath, "manual", {
    lastHealth: "unknown",
    lastCheckedAt: new Date().toISOString(),
  });
  if (tool === "agent-browser") cachedAgentBrowserBin = undefined;
  if (tool === "gog") cachedGogBin = undefined;
  return probeToolRuntime(tool, context, isClosed);
}

export async function clearToolRuntimePath(
  tool: ToolRuntimeName,
  context: DesktopRelayGoogleOAuthContext | null,
  isClosed: () => boolean,
): Promise<ToolRuntimeStatus> {
  clearPersistedToolRuntimePath(toolRuntimeConfigFilePath(), tool);
  if (tool === "agent-browser") cachedAgentBrowserBin = undefined;
  if (tool === "gog") cachedGogBin = undefined;
  return probeToolRuntime(tool, context, isClosed);
}

export function resolveBrowserControlProviderPath(): string {
  const resource = process.resourcesPath
    ? path.join(process.resourcesPath, "browser-control-provider.js")
    : "";
  if (resource && fsSync.existsSync(resource)) return resource;
  const bundled = path.join(__dirname, "browser-control-provider.js");
  if (fsSync.existsSync(bundled)) return bundled;
  return path.join(__dirname, "..", "electron", "browser-control-provider.js");
}

export function ensureAgentBrowserConfig(): string {
  const configPath = browserControlAgentBrowserConfigPath();
  const serialized = `${JSON.stringify({
    idleTimeout: "5m",
    plugins: [{
      name: "nautilo-browser",
      command: resolvePluginRuntimeBin(),
      args: [resolveBrowserControlProviderPath(), "--state", browserControlStateFilePath()],
      capabilities: ["browser.provider"],
    }],
  }, null, 2)}\n`;
  if (fsSync.existsSync(configPath)) {
    try {
      if (fsSync.readFileSync(configPath, "utf8") === serialized) return configPath;
    } catch {
      // Rewrite an unreadable provider configuration.
    }
  }
  fsSync.mkdirSync(path.dirname(configPath), { recursive: true });
  fsSync.writeFileSync(configPath, serialized, "utf8");
  return configPath;
}

export function browserDispatchSession(args: Record<string, unknown>): string {
  const requested = args["session"];
  if (typeof requested === "string" && requested.length > 0) return requested;
  try {
    const state = JSON.parse(fsSync.readFileSync(browserControlStateFilePath(), "utf8")) as {
      activeAppId?: string | null;
      views?: Array<{ appId?: string; cdpUrl?: string | null }>;
    };
    const sessionId = browserControlStateSessionId(state);
    if (sessionId !== null) return sessionId;
  } catch {
    // Use an ephemeral namespace until Electron publishes a browser surface.
  }
  return `nautilo-browser-${randomBytes(6).toString("hex")}`;
}

export function hasPublishedBrowserControlView(): boolean {
  try {
    return browserControlStateHasActiveView(
      JSON.parse(fsSync.readFileSync(browserControlStateFilePath(), "utf8")),
    );
  } catch {
    return false;
  }
}

export async function waitForPublishedBrowserControlView(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (hasPublishedBrowserControlView()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return hasPublishedBrowserControlView();
}

export const relayBinaryResolutionForTests = {
  resetCachedBins(): void {
    cachedAgentBrowserBin = undefined;
    cachedGogBin = undefined;
    cachedOpenHueBin = undefined;
  },
  resolveExecutable,
  canRunExecutable,
  isGogAuthHealthy,
  resolveRunnableExecutable,
  browserRuntimeCapabilities,
  googleWorkspaceRuntimeCapabilities,
  resolveAgentBrowserBin,
  resolveGogBin,
  resolveOpenHueBin,
  canRunOpenHue,
  openHueRuntimeCapabilities,
  openHueExecutor,
  bundledToolPath,
  devVendoredToolPath,
  queryGoogleOAuthConfigured,
  AGENT_BROWSER_COMMON_CANDIDATES,
  GOG_COMMON_CANDIDATES,
};
