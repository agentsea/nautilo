import type {
  DesktopFilesystemAccessOperation,
  DesktopFilesystemGrantLifetime,
} from "@nautilo/desktop-filesystem-grants";
import { COMPUTER_USE_SEMANTIC_VERSION } from "@nautilo/types";
import type {
  ProfileCapabilityBackend,
  ProfileNetworkMode,
} from "@nautilo/workstation-profiles";
import {
  BROWSER_PAGE_READ_MAX_CHARS,
  BROWSER_PAGE_READ_MAX_DIAGNOSTICS,
  BROWSER_PAGE_READ_MAX_TITLE_CHARS,
  BROWSER_PAGE_READ_MAX_URL_CHARS,
  BROWSER_PAGE_READ_PROGRAM_MAX_BLOCKS,
  BROWSER_PAGE_READ_PROGRAM_MAX_BLOCK_TEXT_CHARS,
  BROWSER_PAGE_READ_PROGRAM_MAX_LINKS_PER_BLOCK,
  BROWSER_PAGE_SNAPSHOT_FIND_MAX_MATCHES,
  BROWSER_PAGE_SNAPSHOT_FIND_MAX_RESPONSE_CHARACTERS,
  BROWSER_PAGE_SNAPSHOT_RANGE_MAX_AFTER_CHARACTERS,
  BROWSER_PAGE_SNAPSHOT_RANGE_MAX_BEFORE_CHARACTERS,
  parseBrowserPageSnapshotInspectionRequest,
  type BrowserPageReadResult,
  type BrowserPageSnapshotInspectionRequest,
  type BrowserPageSnapshotInspectionResult,
} from "./browser-page-reader";

/**
 * the only agent scope an advisory desktop grant snapshot may declare.
 * It means "any Genie agent acting for this already-bound desktop user,
 * instance, and relay" — never an unbound cross-subject wildcard. The strict
 * snapshot parser rejects any other value.
 */
export const DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE = "all_owned_agents" as const;

/** v13: inert find/range over an owner-bound retained page snapshot. */
export const BROWSER_RESEARCH_SNAPSHOT_INSPECTION_PROTOCOL_VERSION = 13 as const;

/** an Electron-only, deliberately narrow declaration of Codex hosting. */
export const CODEX_RELAY_CAPABILITY_VERSION = 1 as const;

/** a separate, closed Agent SDK fact stream; not a Codex or ACP capability. */
export const CLAUDE_RELAY_CAPABILITY_VERSION = 1 as const;

/** v18 — Desktop-local Claude execution host, distinct from discovery. */
export const CLAUDE_EXECUTION_RELAY_CAPABILITY_VERSION = 2 as const;

/** strict, secret-free structured SSH readiness projection. */
export const RELAY_STRUCTURED_SSH_READINESS_VERSION = 1 as const;

export type RelayStructuredSshReadiness =
  | {
      readonly version: typeof RELAY_STRUCTURED_SSH_READINESS_VERSION;
      readonly state: "unavailable";
      readonly provider: "openssh";
      readonly ssh: "observed" | "unavailable";
      readonly scp: "observed" | "unavailable";
    }
  | {
      readonly version: typeof RELAY_STRUCTURED_SSH_READINESS_VERSION;
      readonly state: "not-enabled";
      readonly provider: "openssh";
      readonly ssh: "observed";
      readonly scp: "observed" | "unavailable";
    }
  | {
      readonly version: typeof RELAY_STRUCTURED_SSH_READINESS_VERSION;
      readonly state: "enabled";
      readonly provider: "openssh";
      readonly ssh: "observed";
      readonly scp: "observed" | "unavailable";
      /** Exact aggregate across enabled Electron-local managed capabilities. */
      readonly auth: boolean;
      readonly exec: boolean;
      readonly upload: boolean;
      readonly download: boolean;
    };

export type RelayStructuredSshReadinessValidationResult =
  | { readonly ok: true; readonly readiness: RelayStructuredSshReadiness }
  | { readonly ok: false; readonly error: string };

const STRUCTURED_SSH_BASE_READINESS_KEYS = new Set([
  "version",
  "state",
  "provider",
  "ssh",
  "scp",
]);
const STRUCTURED_SSH_ENABLED_READINESS_KEYS = new Set([
  ...STRUCTURED_SSH_BASE_READINESS_KEYS,
  "auth",
  "exec",
  "upload",
  "download",
]);

/**
 * Parses the complete readiness projection. It contains only local
 * OpenSSH observations and aggregates from enabled managed capabilities:
 * destination identity readiness stays Electron-local and per-operation.
 * Exact state-specific keys prevent secret or authority-bearing material from
 * being smuggled beside the allow-listed readiness facts.
 */
export function parseRelayStructuredSshReadiness(
  value: unknown,
): RelayStructuredSshReadinessValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "structured SSH readiness must be an object" };
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expectedKeys = record["state"] === "enabled"
    ? STRUCTURED_SSH_ENABLED_READINESS_KEYS
    : STRUCTURED_SSH_BASE_READINESS_KEYS;
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => !expectedKeys.has(key))
  ) {
    return { ok: false, error: "structured SSH readiness has unexpected fields" };
  }
  if (record["version"] !== RELAY_STRUCTURED_SSH_READINESS_VERSION) {
    return { ok: false, error: "unsupported structured SSH readiness version" };
  }
  if (record["provider"] !== "openssh") {
    return { ok: false, error: "unsupported structured SSH provider" };
  }
  if (record["ssh"] !== "observed" && record["ssh"] !== "unavailable") {
    return { ok: false, error: "invalid structured SSH binary readiness" };
  }
  if (record["scp"] !== "observed" && record["scp"] !== "unavailable") {
    return { ok: false, error: "invalid structured SSH scp readiness" };
  }

  if (record["state"] === "unavailable") {
    return {
      ok: true,
      readiness: Object.freeze({
        version: RELAY_STRUCTURED_SSH_READINESS_VERSION,
        state: "unavailable",
        provider: "openssh",
        ssh: record["ssh"],
        scp: record["scp"],
      }),
    };
  }

  if (record["state"] === "not-enabled" && record["ssh"] === "observed") {
    return {
      ok: true,
      readiness: Object.freeze({
        version: RELAY_STRUCTURED_SSH_READINESS_VERSION,
        state: "not-enabled",
        provider: "openssh",
        ssh: "observed",
        scp: record["scp"],
      }),
    };
  }

  if (
    record["state"] === "enabled" &&
    record["ssh"] === "observed" &&
    typeof record["auth"] === "boolean" &&
    typeof record["exec"] === "boolean" &&
    typeof record["upload"] === "boolean" &&
    typeof record["download"] === "boolean"
  ) {
    return {
      ok: true,
      readiness: Object.freeze({
        version: RELAY_STRUCTURED_SSH_READINESS_VERSION,
        state: "enabled",
        provider: "openssh",
        ssh: "observed",
        scp: record["scp"],
        auth: record["auth"],
        exec: record["exec"],
        upload: record["upload"],
        download: record["download"],
      }),
    };
  }

  return { ok: false, error: "invalid structured SSH readiness state" };
}

export interface RelayCodexCapability {
  readonly version: typeof CODEX_RELAY_CAPABILITY_VERSION;
  /** v1 admits only the paired Electron main process; headless is deferred. */
  readonly hostKind: "electron";
  readonly maxProfiles: 4;
  readonly maxActiveTurns: 4;
}

export interface RelayClaudeCapability {
  readonly version: typeof CLAUDE_RELAY_CAPABILITY_VERSION;
  readonly hostKind: "electron";
  readonly registrations: readonly ["claude-agent-sdk"];
}

/** Closed v1 declaration; host readiness stays Electron-local. */
export interface RelayClaudeExecutionCapability {
  readonly version: typeof CLAUDE_EXECUTION_RELAY_CAPABILITY_VERSION;
}

export function parseRelayClaudeExecutionCapability(value: unknown):
  | { readonly ok: true; readonly value: RelayClaudeExecutionCapability }
  | { readonly ok: false } {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return { ok: false };
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "version") return { ok: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, "version");
    if (
      descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable ||
      descriptor.value !== CLAUDE_EXECUTION_RELAY_CAPABILITY_VERSION
    ) return { ok: false };
    return { ok: true, value: Object.freeze({ version: CLAUDE_EXECUTION_RELAY_CAPABILITY_VERSION }) };
  } catch {
    return { ok: false };
  }
}

/** Closed v1 Claude host declaration. Invalid input is always denial-only. */
export function parseRelayClaudeCapability(value: unknown):
  | { readonly ok: true; readonly value: RelayClaudeCapability }
  | { readonly ok: false } {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return { ok: false };
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    return keys.length === 3 && keys.every((key) => key === "version" || key === "hostKind" || key === "registrations") &&
      record["version"] === CLAUDE_RELAY_CAPABILITY_VERSION && record["hostKind"] === "electron" &&
      Array.isArray(record["registrations"]) && record["registrations"].length === 1 && record["registrations"][0] === "claude-agent-sdk"
      ? { ok: true, value: record as unknown as RelayClaudeCapability }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** narrow Electron-only ACP readiness transport, not ACP execution. */
export const ACP_RELAY_CAPABILITY_VERSION = 2 as const;

export type RelayAcpCapability =
  | Readonly<{
      readonly version: 1;
      readonly hostKind: "electron";
      readonly registrations: readonly ["hermes-acp"];
    }>
  | Readonly<{
      readonly version: typeof ACP_RELAY_CAPABILITY_VERSION;
      readonly hostKind: "electron";
      /** Non-empty canonical subset of exact built-ins; never a plugin registry. */
      readonly registrations:
        | readonly ["hermes-acp"]
        | readonly ["opencode-acp"]
        | readonly ["hermes-acp", "opencode-acp"];
    }>;

/**
 * one active grant as advertised in the advisory snapshot. This is a
 * DISCOVERY hint only: it carries the minimum the server needs to construct a
 * single-grant `RelayDesktopFilesystemGrantRequest`, and nothing that could stand in
 * for authority. Platform authorization, filesystem identity, origin,
 * createdBy, timestamps, lastUsedAt, and revoked history are deliberately
 * omitted — the relay-local resolver reloads the live grant and decides final
 * authority, so a stale or revoked entry here fails locally.
 */
export interface RelayDesktopFilesystemGrantSnapshotEntry {
  readonly id: string;
  readonly canonicalRoot: string;
  readonly access: readonly DesktopFilesystemAccessOperation[];
  readonly policyVersion: number;
  readonly lifetime: DesktopFilesystemGrantLifetime;
  readonly expiresAt?: string | undefined;
}

/**
 * advisory snapshot of a desktop relay's ACTIVE Desktop Filesystem Grants,
 * advertised in `RelayCapabilities` at register. It exists purely so the server
 * can discover which grant ids might satisfy a filesystem request and reference
 * exactly one of them; it is NEVER authority. The relay-local resolver reloads
 * the live local grant store, revalidates subject/policy/lifetime/identity, and
 * decides every access — stale or revoked snapshot data fails closed locally.
 * Only the Electron desktop relay advertises this; the headless relay does not.
 */
export interface RelayDesktopFilesystemGrantSnapshot {
  readonly revision: number;
  readonly instanceId: string;
  readonly agentScope: typeof DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE;
  readonly grants: readonly RelayDesktopFilesystemGrantSnapshotEntry[];
}

/**
 * one typed toolchain capability a bound Workstation Profile declares,
 * redacted to its opaque id and execution backend only. The executable path,
 * roots, environment keys, discovery origin, and typed operation identifiers
 * deliberately never cross the wire — the server's future RelayBindingProvider
 * only needs to verify the capability id + backend the desktop relay bound
 * against, never to re-derive the compiled authority.
 */
export interface RelayWorkstationProfileCapabilityEntry {
  readonly id: string;
  readonly backend: ProfileCapabilityBackend;
}

/**
 * strict advisory Workstation Profile binding snapshot, advertised in
 * `RelayCapabilities` (desktop-agent profile only). It carries the minimum
 * redacted, non-secret profile state the server's future RelayBindingProvider
 * needs to verify an exact `profileId + profileRevision + grantIds +
 * capabilityRevision` binding — nothing more. Roots, environment values,
 * executable paths, filesystem identity, platform authorization, discovery
 * providers, profile name, timestamps, and raw profile data never cross the
 * wire. It is advisory: the desktop relay's live compiled-profile authority
 * remains final, so a stale or revoked binding here fails closed on the relay.
 * Only the Electron desktop relay advertises this; the headless relay does not.
 */
export interface RelayWorkstationProfileSnapshot {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly grantIds: readonly string[];
  readonly protectedPolicyVersion: number;
  readonly networkMode: ProfileNetworkMode;
  readonly capabilities: readonly RelayWorkstationProfileCapabilityEntry[];
}

/**
 * redacted advisory view of the single local Computer use grant.
 *
 * This is deliberately not a grant, policy, provider selection, PIN proof,
 * or execution authority.  It is the minimum server-discovery tuple needed
 * to bind a later admission to this installed Desktop.  Electron remains the
 * final authority and reloads its live local receipt before any effect.
 */
export interface RelayDesktopAutomationSnapshot {
  readonly enabled: true;
  readonly agentId: string;
  readonly installationEpoch: string;
  readonly grantGeneration: number;
  /** The one provider route Electron can execute at this exact revision. */
  readonly provider: "cua";
  /** Opaque local revision; stale route bindings are denied, never reselected. */
  readonly providerGeneration: string;
}

/**
 * Capability profile declared by a relay on connection.
 * The runtime uses this to decide whether a requested tool action
 * is allowed on the connected relay.
 */
export type RelayCapabilities = {
  profile: "device-relay" | "desktop-agent";
  /** Exact descriptors from the running attested Host; schemas remain server-owned. */
  computerUseHostContracts?: readonly import("@nautilo/computer-use-host-protocol").ComputerUseHostContract[] | undefined;
  /** semantic Computer protocol is installed, regardless of On/Off grant state. */
  computerUseSemanticVersion?: typeof COMPUTER_USE_SEMANTIC_VERSION | undefined;
  canDiscoverHue?: boolean | undefined;
  canControlHue?: boolean | undefined;
  canControlSonos?: boolean | undefined;
  canControlTV?: boolean | undefined;
  /** desktop-agent profile: the fresh atomic Cua route is ready for Computer Use. */
  canControlDesktop?: boolean | undefined;
  /** desktop-agent profile: agent-browser against embedded SaaS webviews. */
  canControlBrowser?: boolean | undefined;
  /** opaque identity of the exact active embedded Browser view. */
  browserSessionId?: string | undefined;
  /**
   * Electron-main-owned anonymous research target. This is deliberately
   * distinct from interactive browser control and is omitted by headless or
   * older Desktop relays.
   */
  canResearchWeb?: boolean | undefined;
  /** this Desktop relay implements fixed-host rendered search discovery. */
  canSearchResearchWeb?: boolean | undefined;
  /**
   * the relay can return a classified challenge without opening the
   * Human intervention flow. Search uses this to try adequate alternate
   * sources before revisiting one challenged URL for presentation.
   */
  canDeferResearchChallenges?: boolean | undefined;
  /** v12: Electron can retain immutable page snapshots for continuation. */
  canContinueBrowserPageRead?: boolean | undefined;
  /** v13: Electron may publish bounded references to retained page snapshots. */
  canInspectBrowserPageSnapshot?: boolean | undefined;
  /** v13: Electron can replay bounded consent labels in anonymous research pages. */
  canReplayResearchConsent?: boolean | undefined;
  /** Electron can retain and visually recover the exact anonymous consent target. */
  canRecoverResearchConsent?: boolean | undefined;
  /** desktop-agent profile: shared interactive PTY terminal. Only the
   *  Electron desktop relay advertises this — it hosts the PTY pool; the
   *  standalone relay can run shell but has no terminal host. */
  canUseTerminal?: boolean | undefined;
  /** Secret-free, transient notification that the Human explicitly handed
   * one Electron-local PTY to Genie. The exact session id never crosses the
   * relay wire; supported session-less terminal operations resolve it locally. */
  hasPendingTerminalHandoff?: boolean | undefined;
  /** desktop-agent profile: Google Workspace API via local gog/gogcli. */
  canUseGoogleWorkspace?: boolean | undefined;
  /** desktop-agent profile: screenshot/vision capture is currently operational. */
  canSeeDesktop?: boolean | undefined;
  canReadWorkspace?: boolean | undefined;
  canWriteWorkspace?: boolean | undefined;
  /** Electron-local, opaque, directory-only paired phone picker. */
  canBrowsePairedFilesystem?: boolean | undefined;
  canRunShell?: boolean | undefined;
  /** v16: read owner-bound retained SSH output without starting SSH. */
  canReadStructuredSshOutput?: boolean | undefined;
  /**
   * server-private canonical execution Workspace. Electron supplies
   * its always-present Finder-visible app Workspace; a headless relay supplies
   * its explicit configured Workspace. It is transport metadata, never public
   * remote-presence data and never filesystem authority by itself; the relay
   * still validates containment and local grants at use.
   */
  workspaceRoot?: string | undefined;
  /**
   * server-private canonical root of the Human's optional Current
   * Folder. Omitted means no Current Folder is selected. It must not be
   * inferred from `workspaceRoot`, and neither pairing nor relay restart
   * may write it. Like the Workspace root, it is binding metadata only and is
   * deliberately excluded from public remote presence.
   */
  currentFolderRoot?: string | undefined;
  /**
   * Generic active local-jail roots. This remains an execution containment
   * contract, not a fallback source for the named Workspace/Current Folder.
   */
  allowedRoots?: string[] | undefined;
  allowedHosts?: string[] | undefined;
  securityLevel?: "cautious" | "standard" | "permissive" | undefined;
  /**
   * Per-relay absolute path for sandbox data dir (the agent's
   * secret store / DB cache / scratch).
   * Reported at registration so the server\u0027s Policy Resolver can
   * build a sandboxProfile whose dataDir is masked via --tmpfs
   * (bubblewrap) / deny-subpath (seatbelt). Optional in v1; relay
   * clients that omit it cause the server to fall back to a
   * workspace-only profile (no broad RO home exposed), which is
   * safe but less ergonomic than desktop-permissive.
   */
  dataDir?: string | undefined;
  /**
   * Per-relay absolute path to the tools-bin directory (bun etc.)
   * prepended to PATH inside the sandbox.
   * Reported at registration — see dataDir above. Optional in v1.
   */
  toolsBin?: string | undefined;
  /**
   * User home directory on the relay\u0027s machine.
   * Required for the `desktop-permissive` deployment mode
   * (broad RO home). Server falls back to `desktop-locked` shape
   * if missing, since the permissive profile\u0027s inputs helper
   * throws on undefined userHome.
   */
  userHome?: string | undefined;
  /**
   * Slice A — MCP hosting summary the relay advertises at
   * register. Each entry names an MCP server the relay can host plus
   * the tool names it expects to expose. Optional; relays that don't
   * host MCP omit it and the server treats them as "no MCP tools".
   */
  mcpTools?: { serverName: string; toolNames: string[] }[] | undefined;
  /**
   * desktop-agent profile: relay can execute typed `local-file`
   * dispatches for `current`/`absolute` zones (protocol v4+). Only the
   * Electron desktop relay advertises this; headless `bin/nautilo-relay`
   * must not.
   */
  localFileExecution?: boolean | undefined;
  /**
   * desktop-agent profile: relay can execute the v1 typed
   * `local-file` `apply_patch` operation (protocol v9+). This is deliberately
   * distinct from `localFileExecution`: a relay that can serve ordinary
   * local-file commands is not implicitly trusted or provisioned to run the
   * packaged apply-patch runtime. Relays without that runtime omit it.
   */
  applyPatchExecution?: boolean | undefined;
  /**
   * desktop-agent profile: bundled OfficeCLI is present and the
   * relay can run structured local Office operations. Advertised only
   * after a successful packaged-binary probe; optional until Phase 3.
   */
  canRunOffice?: boolean | undefined;
  /**
   * advisory active-grant snapshot (desktop-agent profile only). Purely
   * a discovery hint for the server; it is never filesystem authority. The
   * relay-local resolver reloads the live local grant store and decides every
   * access, so stale/revoked entries here fail closed locally. Omitted by the
   * headless relay and by any desktop relay with no active grants. Malformed
   * snapshots are dropped by the registry per the strict parser, not enforced.
   */
  desktopFilesystemGrantSnapshot?: RelayDesktopFilesystemGrantSnapshot | undefined;
  /**
   * advisory Workstation Profile binding snapshot (desktop-agent profile
   * only). Redacted, non-secret profile state for the server's future
   * RelayBindingProvider to verify an exact `profileId + profileRevision +
   * grantIds + capabilityRevision` binding. Advisory only: the desktop relay's
   * live compiled-profile authority remains final. Omitted by the headless
   * relay and by any desktop relay with no bound profile. At registration a
   * malformed snapshot is dropped (relay stays registered); on
   * `relay:update-capabilities` a malformed snapshot rejects the full update
   * and leaves the prior capability/profile/grant state intact.
   */
  workstationProfileSnapshot?: RelayWorkstationProfileSnapshot | undefined;
  /**
   * redacted active Computer use receipt.  Omitted while Off, during
   * recovery, or when Electron cannot read exact local state.  No provider
   * policy, PIN/token, pairing/session data, or receipt timestamps cross the
   * relay wire.
   */
  desktopAutomation?: RelayDesktopAutomationSnapshot | undefined;
  /**
   * relay v8 — optional Codex host declaration. This advertises only an
   * actually injected Electron host port, never workspace/runtime readiness.
   */
  codex?: RelayCodexCapability | undefined;
  /** v17 — Electron has the injected Claude Agent SDK host seam. */
  claude?: RelayClaudeCapability | undefined;
  /** v18 — Electron has a locally injected Claude execution host. */
  claudeExecution?: RelayClaudeExecutionCapability | undefined;
  /**
   * secret-free local structured SSH readiness. This is discovery only:
   * it contains no managed-capability subject, grant, identity, host, user,
   * path, key, or execution authority.
   */
  structuredSsh?: RelayStructuredSshReadiness | undefined;
  /** v13 — Electron can answer bounded built-in ACP readiness checks. */
  acp?: RelayAcpCapability | undefined;
};

/**
 * Tool routing policy — how the graph's uniform tool interface
 * maps to cloud vs. relay execution.
 */
export type ToolPolicy = {
  executor: "cloud" | "relay";
  impact: "read-only" | "low" | "high" | "destructive";
  requiresApproval: boolean;
  allowedProfiles: Array<"device-relay" | "desktop-agent">;
};

/** v12 internal research-read contract includes immutable continuation fields. */
export const BROWSER_RESEARCH_READ_PROTOCOL_VERSION = 12;

export interface RelayBrowserResearchSearchRequest extends RelayBrowserResearchInvocationIdentity {
  readonly provider: "duckduckgo_html";
  readonly query: string;
  readonly maxResults: number;
}

export interface BrowserResearchSearchResult {
  readonly provider: "duckduckgo_html";
  readonly items: readonly import("./duckduckgo-html-search").DuckDuckGoHtmlResultItem[];
  readonly failure?: import("./duckduckgo-html-search").DuckDuckGoHtmlSearchFailureKind;
}

export type RelayBrowserResearchSearchRequestValidationResult =
  | { readonly ok: true; readonly request: RelayBrowserResearchSearchRequest }
  | { readonly ok: false; readonly error: string };
export type RelayBrowserResearchSearchResultValidationResult =
  | { readonly ok: true; readonly result: BrowserResearchSearchResult }
  | { readonly ok: false; readonly error: string };

interface RelayBrowserResearchInvocationIdentity {
  readonly toolCallId: string;
  readonly laneKey: string;
  readonly turnId?: string | undefined;
  readonly authorAgentId?: string | undefined;
}

export interface RelayBrowserResearchInitialReadRequest extends RelayBrowserResearchInvocationIdentity {
  readonly url: string;
  readonly maxChars?: number | undefined;
  readonly challengeBehavior?: "intervene" | "defer" | undefined;
  /** Ordered consent-control labels to replay in the fresh anonymous page before reading. */
  readonly consentActions?: readonly string[] | undefined;
}

export interface RelayBrowserResearchContinuationReadRequest extends RelayBrowserResearchInvocationIdentity {
  readonly continuation: {
    readonly version: 1;
    readonly reference: string;
    readonly offsetCharacters: number;
    readonly mode: "page" | "remainder";
  };
  readonly maxChars?: number | undefined;
}

export interface RelayBrowserResearchSnapshotInspectionRequest extends RelayBrowserResearchInvocationIdentity {
  readonly snapshot: BrowserPageSnapshotInspectionRequest;
}

export type BrowserResearchConsentRecoveryOperation =
  | "snapshot" | "screenshot" | "click_control" | "click_coordinates" | "wait" | "read" | "abandon";

export interface RelayBrowserResearchConsentRecoveryRequest extends RelayBrowserResearchInvocationIdentity {
  readonly consentRecovery: {
    readonly version: 1;
    readonly reference: string;
    readonly operation: BrowserResearchConsentRecoveryOperation;
    readonly label?: string | undefined;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
    readonly milliseconds?: number | undefined;
    readonly maxChars?: number | undefined;
  };
}

export interface BrowserResearchConsentRecoveryResult {
  readonly kind: "browser_research_consent_recovery";
  readonly operation: BrowserResearchConsentRecoveryOperation;
  readonly reference: string;
  readonly expiresAt: string;
  readonly state: "consent_wall" | "cleared" | "released";
  readonly snapshot?: string | undefined;
  readonly controls?: readonly { readonly reference: string; readonly label: string }[] | undefined;
  readonly viewport?: {
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly imageWidth: number;
    readonly imageHeight: number;
    readonly scale: number;
  } | undefined;
  readonly image?: { readonly mime: "image/png"; readonly base64: string } | undefined;
  readonly page?: BrowserPageReadResult | undefined;
}

export type RelayBrowserResearchConsentRecoveryRequestValidationResult =
  | { readonly ok: true; readonly request: RelayBrowserResearchConsentRecoveryRequest }
  | { readonly ok: false; readonly error: string };
export type RelayBrowserResearchConsentRecoveryResultValidationResult =
  | { readonly ok: true; readonly result: BrowserResearchConsentRecoveryResult }
  | { readonly ok: false; readonly error: string };

export type RelayBrowserResearchReadRequest =
  | RelayBrowserResearchInitialReadRequest
  | RelayBrowserResearchContinuationReadRequest;

export type RelayBrowserResearchReadRequestValidationResult =
  | { readonly ok: true; readonly request: RelayBrowserResearchReadRequest }
  | { readonly ok: false; readonly error: string };

export type RelayBrowserResearchReadResultValidationResult =
  | { readonly ok: true; readonly result: BrowserPageReadResult }
  | { readonly ok: false; readonly error: string };

export type RelayBrowserResearchSnapshotInspectionResultValidationResult =
  | { readonly ok: true; readonly result: BrowserPageSnapshotInspectionResult }
  | { readonly ok: false; readonly error: string };
export type RelayBrowserResearchSnapshotInspectionRequestValidationResult =
  | { readonly ok: true; readonly request: RelayBrowserResearchSnapshotInspectionRequest }
  | { readonly ok: false; readonly error: string };

const BROWSER_RESEARCH_READ_REQUEST_KEYS = new Set([
  "url", "continuation", "maxChars", "challengeBehavior", "consentActions", "toolCallId", "laneKey", "turnId", "authorAgentId",
]);
const BROWSER_RESEARCH_SNAPSHOT_REQUEST_KEYS = new Set([
  "snapshot", "toolCallId", "laneKey", "turnId", "authorAgentId",
]);
const BROWSER_RESEARCH_CONSENT_RECOVERY_REQUEST_KEYS = new Set([
  "consentRecovery", "toolCallId", "laneKey", "turnId", "authorAgentId",
]);
const BROWSER_RESEARCH_CONSENT_RECOVERY_KEYS = new Set([
  "version", "reference", "operation", "label", "x", "y", "milliseconds", "maxChars",
]);
const BROWSER_RESEARCH_SEARCH_REQUEST_KEYS = new Set([
  "provider", "query", "maxResults", "toolCallId", "laneKey", "turnId", "authorAgentId",
]);
const BROWSER_RESEARCH_SEARCH_RESULT_KEYS = new Set(["provider", "items", "failure"]);
const BROWSER_RESEARCH_SEARCH_ITEM_KEYS = new Set(["url", "title", "snippet"]);
const BROWSER_RESEARCH_CONTINUATION_KEYS = new Set(["version", "reference", "offsetCharacters", "mode"]);
const BROWSER_PAGE_READ_RESULT_KEYS = new Set([
  "targetRole", "requestedUrl", "finalUrl", "title", "content", "blocks",
  "totalCharacters", "totalCharactersCapped", "totalBytes", "estimatedTokens",
  "offsetCharacters", "nextOffsetCharacters", "returnedCharacters", "remainingCharacters",
  "eof", "truncated", "contextClamped", "continuation", "pageReference", "evictedPageReferences",
  "extraction", "timing", "quality", "challenge", "failure", "diagnostics", "consentRecovery",
]);
const BROWSER_PAGE_READ_BLOCK_KEYS = new Set(["kind", "text", "links"]);
const BROWSER_PAGE_READ_LINK_KEYS = new Set(["text", "href"]);
const BROWSER_PAGE_READ_EXTRACTION_KEYS = new Set(["method", "root", "iframeCount"]);
const BROWSER_PAGE_READ_TIMING_KEYS = new Set(["readiness", "extractionMs", "elapsedMs"]);
const BROWSER_PAGE_READ_CHALLENGE_KEYS = new Set(["detected", "confidence", "signals"]);
const BROWSER_PAGE_READ_CONTINUATION_KEYS = new Set(["version", "reference", "nextOffsetCharacters", "expiresAt"]);
const BROWSER_PAGE_READ_PAGE_REFERENCE_KEYS = new Set(["version", "reference", "expiresAt"]);
const BROWSER_PAGE_READ_EVICTED_PAGE_REFERENCE_KEYS = new Set(["version", "reference", "title", "finalUrl"]);
const BROWSER_PAGE_READ_CONSENT_RECOVERY_KEYS = new Set(["version", "reference", "expiresAt", "operations"]);

interface BrowserResearchReadRequestWire {
  url?: unknown; continuation?: unknown; maxChars?: unknown; challengeBehavior?: unknown; consentActions?: unknown; toolCallId?: unknown; laneKey?: unknown;
  turnId?: unknown; authorAgentId?: unknown;
}
interface BrowserPageReadWire {
  targetRole?: unknown; requestedUrl?: unknown; finalUrl?: unknown; title?: unknown;
  content?: unknown; blocks?: unknown; totalCharacters?: unknown; totalCharactersCapped?: unknown;
  totalBytes?: unknown; estimatedTokens?: unknown; offsetCharacters?: unknown; nextOffsetCharacters?: unknown;
  returnedCharacters?: unknown; remainingCharacters?: unknown; eof?: unknown; truncated?: unknown;
  contextClamped?: unknown; continuation?: unknown; pageReference?: unknown; evictedPageReferences?: unknown;
  extraction?: unknown; timing?: unknown;
  quality?: unknown; challenge?: unknown; failure?: unknown; diagnostics?: unknown; consentRecovery?: unknown;
}
interface BrowserPageReadBlockWire { kind?: unknown; text?: unknown; links?: unknown }
interface BrowserPageReadLinkWire { text?: unknown; href?: unknown }
interface BrowserPageReadExtractionWire { method?: unknown; root?: unknown; iframeCount?: unknown }
interface BrowserPageReadTimingWire { readiness?: unknown; extractionMs?: unknown; elapsedMs?: unknown }
interface BrowserPageReadChallengeWire { detected?: unknown; confidence?: unknown; signals?: unknown }

function isStrictRecord(value: unknown, keys: ReadonlySet<string>): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.has(key));
}

function isNoncredentialedHttpUrl(value: unknown, allowEmpty = false): value is string {
  if (typeof value !== "string") return false;
  if (allowEmpty && value === "") return true;
  if (value.length === 0 || value.length > BROWSER_PAGE_READ_MAX_URL_CHARS) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function hasBoundedResearchIdentity(value: Record<string, unknown>): boolean {
  return typeof value["toolCallId"] === "string" && value["toolCallId"].length >= 1 && value["toolCallId"].length <= 200 &&
    typeof value["laneKey"] === "string" && value["laneKey"].length >= 1 && value["laneKey"].length <= 300 &&
    (value["turnId"] === undefined || (typeof value["turnId"] === "string" && value["turnId"].length <= 200)) &&
    (value["authorAgentId"] === undefined || (typeof value["authorAgentId"] === "string" && value["authorAgentId"].length <= 200));
}

export function parseRelayBrowserResearchSearchRequest(value: unknown): RelayBrowserResearchSearchRequestValidationResult {
  if (!isStrictRecord(value, BROWSER_RESEARCH_SEARCH_REQUEST_KEYS) || !hasBoundedResearchIdentity(value) ||
    value["provider"] !== "duckduckgo_html" || typeof value["query"] !== "string" ||
    value["query"].trim().length < 1 || value["query"].trim().length > 512 ||
    typeof value["maxResults"] !== "number" || !Number.isSafeInteger(value["maxResults"]) ||
    value["maxResults"] < 1 || value["maxResults"] > 25) {
    return { ok: false, error: "browser research search request is malformed" };
  }
  return { ok: true, request: {
    provider: "duckduckgo_html", query: value["query"].trim(), maxResults: value["maxResults"],
    toolCallId: value["toolCallId"] as string, laneKey: value["laneKey"] as string,
    ...(value["turnId"] === undefined ? {} : { turnId: value["turnId"] as string }),
    ...(value["authorAgentId"] === undefined ? {} : { authorAgentId: value["authorAgentId"] as string }),
  } };
}

export function parseRelayBrowserResearchSearchResult(value: unknown): RelayBrowserResearchSearchResultValidationResult {
  if (!isStrictRecord(value, BROWSER_RESEARCH_SEARCH_RESULT_KEYS) || value["provider"] !== "duckduckgo_html" ||
    !Array.isArray(value["items"]) || value["items"].length > 25 ||
    !value["items"].every((item) => isStrictRecord(item, BROWSER_RESEARCH_SEARCH_ITEM_KEYS) &&
      isNoncredentialedHttpUrl(item["url"]) &&
      (item["title"] === undefined || (typeof item["title"] === "string" && item["title"].length <= 512)) &&
      (item["snippet"] === undefined || (typeof item["snippet"] === "string" && item["snippet"].length <= 2_000))) ||
    (value["failure"] !== undefined && (value["items"].length !== 0 || typeof value["failure"] !== "string" ||
      !["invalid_query", "challenge", "rate_limited", "markup_drift", "empty_parse", "navigation_error", "render_failed"].includes(value["failure"])))) {
    return { ok: false, error: "browser research search result is malformed" };
  }
  return { ok: true, result: value as unknown as BrowserResearchSearchResult };
}

/** Strict parser for only presently admitted internal research operation. */
export function parseRelayBrowserResearchReadRequest(value: unknown): RelayBrowserResearchReadRequestValidationResult {
  if (!isStrictRecord(value, BROWSER_RESEARCH_READ_REQUEST_KEYS)) {
    return { ok: false, error: "browser research read request is malformed" };
  }
  const request = value as BrowserResearchReadRequestWire;
  if (request.maxChars !== undefined &&
    (typeof request.maxChars !== "number" || !Number.isSafeInteger(request.maxChars) ||
      request.maxChars < 1 || request.maxChars > BROWSER_PAGE_READ_MAX_CHARS)) {
    return { ok: false, error: "browser research read maxChars is out of bounds" };
  }
  if (typeof request.toolCallId !== "string" || request.toolCallId.length < 1 || request.toolCallId.length > 200 ||
    typeof request.laneKey !== "string" || request.laneKey.length < 1 || request.laneKey.length > 300 ||
    (request.turnId !== undefined && (typeof request.turnId !== "string" || request.turnId.length > 200)) ||
    (request.authorAgentId !== undefined && (typeof request.authorAgentId !== "string" || request.authorAgentId.length > 200))) {
    return { ok: false, error: "browser research read requires bounded invocation identity" };
  }
  const identity = {
    toolCallId: request.toolCallId,
    laneKey: request.laneKey,
    ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
    ...(request.authorAgentId === undefined ? {} : { authorAgentId: request.authorAgentId }),
  };
  if (request.continuation !== undefined) {
    if (request.url !== undefined || request.challengeBehavior !== undefined || request.consentActions !== undefined ||
      !isStrictRecord(request.continuation, BROWSER_RESEARCH_CONTINUATION_KEYS)) {
      return { ok: false, error: "browser research continuation request is malformed" };
    }
    const continuation = request.continuation;
    if (continuation["version"] !== 1 ||
      typeof continuation["reference"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(continuation["reference"]) ||
      !isSafeNonnegativeInteger(continuation["offsetCharacters"]) ||
      (continuation["mode"] !== "page" && continuation["mode"] !== "remainder") ||
      (continuation["mode"] === "remainder" && request.maxChars !== undefined)) {
      return { ok: false, error: "browser research continuation request is malformed" };
    }
    return {
      ok: true,
      request: {
        continuation: {
          version: 1,
          reference: continuation["reference"],
          offsetCharacters: continuation["offsetCharacters"],
          mode: continuation["mode"],
        },
        ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
        ...identity,
      },
    };
  }
  if (!isNoncredentialedHttpUrl(request.url)) {
    return { ok: false, error: "browser research read requires a non-credentialed absolute HTTP or HTTPS url" };
  }
  if (request.challengeBehavior !== undefined &&
    request.challengeBehavior !== "intervene" && request.challengeBehavior !== "defer") {
    return { ok: false, error: "browser research read challengeBehavior is invalid" };
  }
  if (request.consentActions !== undefined &&
    (!Array.isArray(request.consentActions) || request.consentActions.length < 1 || request.consentActions.length > 12 ||
      !request.consentActions.every((label) => typeof label === "string" && label.trim().length >= 1 && label.trim().length <= 160))) {
    return { ok: false, error: "browser research consentActions are invalid" };
  }
  return {
    ok: true,
    request: {
      url: new URL(request.url).href,
      ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
      ...(request.challengeBehavior === undefined ? {} : { challengeBehavior: request.challengeBehavior }),
      ...(request.consentActions === undefined ? {} : {
        consentActions: (request.consentActions as string[]).map((label) => label.trim()),
      }),
      ...identity,
    },
  };
}

/** Separate v13 operation so ordinary research reads retain their v12 union. */
export function parseRelayBrowserResearchSnapshotInspectionRequest(
  value: unknown,
): RelayBrowserResearchSnapshotInspectionRequestValidationResult {
  if (!isStrictRecord(value, BROWSER_RESEARCH_SNAPSHOT_REQUEST_KEYS) || !hasBoundedResearchIdentity(value)) {
    return { ok: false, error: "browser research snapshot request is malformed" };
  }
  const snapshot = parseBrowserPageSnapshotInspectionRequest(value["snapshot"]);
  if (!snapshot.ok) return { ok: false, error: "browser research snapshot request is malformed" };
  return {
    ok: true,
    request: {
      snapshot: snapshot.request,
      toolCallId: value["toolCallId"] as string,
      laneKey: value["laneKey"] as string,
      ...(value["turnId"] === undefined ? {} : { turnId: value["turnId"] as string }),
      ...(value["authorAgentId"] === undefined ? {} : { authorAgentId: value["authorAgentId"] as string }),
    },
  };
}

export function parseRelayBrowserResearchConsentRecoveryRequest(
  value: unknown,
): RelayBrowserResearchConsentRecoveryRequestValidationResult {
  if (!isStrictRecord(value, BROWSER_RESEARCH_CONSENT_RECOVERY_REQUEST_KEYS) || !hasBoundedResearchIdentity(value) ||
    !isStrictRecord(value["consentRecovery"], BROWSER_RESEARCH_CONSENT_RECOVERY_KEYS)) {
    return { ok: false, error: "browser research consent recovery request is malformed" };
  }
  const recovery = value["consentRecovery"];
  const operation = recovery["operation"];
  if (recovery["version"] !== 1 || typeof recovery["reference"] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(recovery["reference"]) ||
    !["snapshot", "screenshot", "click_control", "click_coordinates", "wait", "read", "abandon"].includes(String(operation))) {
    return { ok: false, error: "browser research consent recovery request is malformed" };
  }
  const allowed = new Set<string>(["version", "reference", "operation"]);
  if (operation === "click_control") {
    allowed.add("label");
    if (typeof recovery["label"] !== "string" || recovery["label"].trim().length < 1 || recovery["label"].trim().length > 160) {
      return { ok: false, error: "browser research consent recovery request is malformed" };
    }
  } else if (operation === "click_coordinates") {
    allowed.add("x"); allowed.add("y");
    if (!isSafeNonnegativeInteger(recovery["x"]) || !isSafeNonnegativeInteger(recovery["y"]) ||
      recovery["x"] > 16_384 || recovery["y"] > 16_384) {
      return { ok: false, error: "browser research consent recovery request is malformed" };
    }
  } else if (operation === "wait") {
    allowed.add("milliseconds");
    if (!isSafeNonnegativeInteger(recovery["milliseconds"]) || recovery["milliseconds"] > 5_000) {
      return { ok: false, error: "browser research consent recovery request is malformed" };
    }
  } else if (operation === "read" && recovery["maxChars"] !== undefined) {
    allowed.add("maxChars");
    if (!isSafeNonnegativeInteger(recovery["maxChars"]) || recovery["maxChars"] < 1 || recovery["maxChars"] > BROWSER_PAGE_READ_MAX_CHARS) {
      return { ok: false, error: "browser research consent recovery request is malformed" };
    }
  }
  if (Object.keys(recovery).some((key) => !allowed.has(key))) {
    return { ok: false, error: "browser research consent recovery request is malformed" };
  }
  return { ok: true, request: {
    consentRecovery: {
      version: 1,
      reference: recovery["reference"],
      operation: operation as BrowserResearchConsentRecoveryOperation,
      ...(operation === "click_control" ? { label: (recovery["label"] as string).trim() } : {}),
      ...(operation === "click_coordinates" ? { x: recovery["x"] as number, y: recovery["y"] as number } : {}),
      ...(operation === "wait" ? { milliseconds: recovery["milliseconds"] as number } : {}),
      ...(operation === "read" && recovery["maxChars"] !== undefined ? { maxChars: recovery["maxChars"] as number } : {}),
    },
    toolCallId: value["toolCallId"] as string,
    laneKey: value["laneKey"] as string,
    ...(value["turnId"] === undefined ? {} : { turnId: value["turnId"] as string }),
    ...(value["authorAgentId"] === undefined ? {} : { authorAgentId: value["authorAgentId"] as string }),
  } };
}

const BROWSER_PAGE_SNAPSHOT_FIND_RESULT_KEYS = new Set([
  "version", "operation", "reference", "expiresAt", "caseSensitive", "totalMatches", "returnedMatches", "matchesOmitted", "matches",
]);
const BROWSER_PAGE_SNAPSHOT_FIND_MATCH_KEYS = new Set([
  "offsetCharacters", "matchCharacters", "previewOffsetCharacters", "preview", "startsMidBlock", "endsMidBlock", "truncatedBlock",
]);
const BROWSER_PAGE_SNAPSHOT_RANGE_RESULT_KEYS = new Set([
  "version", "operation", "reference", "expiresAt", "offsetCharacters", "startOffsetCharacters", "endOffsetCharacters", "content", "startsMidBlock", "endsMidBlock", "truncatedBlock",
]);

function hasBoundedSerializedSnapshotFindResult(value: Record<string, unknown>): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= BROWSER_PAGE_SNAPSHOT_FIND_MAX_RESPONSE_CHARACTERS;
  } catch {
    return false;
  }
}

/** Strict transport parser for inert v13 snapshot find/range responses. */
export function parseRelayBrowserResearchSnapshotInspectionResult(
  value: unknown,
): RelayBrowserResearchSnapshotInspectionResultValidationResult {
  if (!isStrictRecord(value, BROWSER_PAGE_SNAPSHOT_FIND_RESULT_KEYS) &&
    !isStrictRecord(value, BROWSER_PAGE_SNAPSHOT_RANGE_RESULT_KEYS)) {
    return { ok: false, error: "browser research snapshot result is malformed" };
  }
  const result = value;
  if (
    result["version"] !== 1 ||
    typeof result["reference"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result["reference"]) ||
    typeof result["expiresAt"] !== "string" || !Number.isFinite(Date.parse(result["expiresAt"]))
  ) return { ok: false, error: "browser research snapshot result is malformed" };
  if (result["operation"] === "find") {
    if (
      typeof result["caseSensitive"] !== "boolean" ||
      !isSafeNonnegativeInteger(result["totalMatches"]) ||
      !isSafeNonnegativeInteger(result["returnedMatches"]) ||
      !isSafeNonnegativeInteger(result["matchesOmitted"]) ||
      result["returnedMatches"] + result["matchesOmitted"] !== result["totalMatches"] ||
      !Array.isArray(result["matches"]) || result["matches"].length !== result["returnedMatches"] ||
      result["matches"].length > BROWSER_PAGE_SNAPSHOT_FIND_MAX_MATCHES ||
      !hasBoundedSerializedSnapshotFindResult(result) ||
      !(() => {
        let previousOffset = -1;
        let previousEnd = -1;
        return result["matches"].every((match) => {
          if (!isStrictRecord(match, BROWSER_PAGE_SNAPSHOT_FIND_MATCH_KEYS)) return false;
          if (!isSafeNonnegativeInteger(match["offsetCharacters"]) ||
            !isSafeNonnegativeInteger(match["matchCharacters"]) || match["matchCharacters"] === 0 ||
            !isSafeNonnegativeInteger(match["previewOffsetCharacters"]) ||
            typeof match["preview"] !== "string" ||
            typeof match["startsMidBlock"] !== "boolean" ||
            typeof match["endsMidBlock"] !== "boolean" ||
            typeof match["truncatedBlock"] !== "boolean" ||
            match["truncatedBlock"] !== (match["startsMidBlock"] || match["endsMidBlock"]) ||
            match["previewOffsetCharacters"] > match["offsetCharacters"] ||
            match["offsetCharacters"] > Number.MAX_SAFE_INTEGER - match["matchCharacters"] ||
            match["previewOffsetCharacters"] > Number.MAX_SAFE_INTEGER - match["preview"].length ||
            match["offsetCharacters"] + match["matchCharacters"] > match["previewOffsetCharacters"] + match["preview"].length ||
            match["offsetCharacters"] <= previousOffset || match["offsetCharacters"] < previousEnd
          ) return false;
          previousOffset = match["offsetCharacters"];
          previousEnd = match["offsetCharacters"] + match["matchCharacters"];
          return true;
        });
      })()
    ) return { ok: false, error: "browser research snapshot result is malformed" };
    return { ok: true, result: value as unknown as BrowserPageSnapshotInspectionResult };
  }
  if (result["operation"] === "range") {
    if (
      !isSafeNonnegativeInteger(result["offsetCharacters"]) ||
      !isSafeNonnegativeInteger(result["startOffsetCharacters"]) ||
      !isSafeNonnegativeInteger(result["endOffsetCharacters"]) ||
      result["startOffsetCharacters"] > result["offsetCharacters"] ||
      result["offsetCharacters"] > result["endOffsetCharacters"] ||
      typeof result["content"] !== "string" ||
      result["content"].length !== result["endOffsetCharacters"] - result["startOffsetCharacters"] ||
      result["content"].length > BROWSER_PAGE_SNAPSHOT_RANGE_MAX_BEFORE_CHARACTERS + BROWSER_PAGE_SNAPSHOT_RANGE_MAX_AFTER_CHARACTERS ||
      typeof result["startsMidBlock"] !== "boolean" ||
      typeof result["endsMidBlock"] !== "boolean" ||
      typeof result["truncatedBlock"] !== "boolean" ||
      result["truncatedBlock"] !== (result["startsMidBlock"] || result["endsMidBlock"])
    ) return { ok: false, error: "browser research snapshot result is malformed" };
    return { ok: true, result: value as unknown as BrowserPageSnapshotInspectionResult };
  }
  return { ok: false, error: "browser research snapshot result is malformed" };
}

/**
 * Strictly admits only the normalized, redacted shared page-read result. This
 * transport boundary rejects CDP endpoints, partitions, provider paths, and
 * every other relay-local field by construction.
 */
export function parseRelayBrowserResearchReadResult(value: unknown): RelayBrowserResearchReadResultValidationResult {
  if (!isStrictRecord(value, BROWSER_PAGE_READ_RESULT_KEYS)) {
    return { ok: false, error: "browser research read result is malformed" };
  }
  const result = value as BrowserPageReadWire;
  if (result.targetRole !== "research" ||
    (result.requestedUrl !== undefined && !isNoncredentialedHttpUrl(result.requestedUrl)) ||
    !isNoncredentialedHttpUrl(result.finalUrl, true) || typeof result.title !== "string" ||
    result.title.length > BROWSER_PAGE_READ_MAX_TITLE_CHARS || typeof result.content !== "string" ||
    result.content.length > BROWSER_PAGE_READ_MAX_CHARS || !Array.isArray(result.blocks) ||
    result.blocks.length > BROWSER_PAGE_READ_PROGRAM_MAX_BLOCKS ||
    typeof result.totalCharacters !== "number" || !Number.isSafeInteger(result.totalCharacters) || result.totalCharacters < 0 ||
    typeof result.totalCharactersCapped !== "boolean" ||
    !isSafeNonnegativeInteger(result.totalBytes) || !isSafeNonnegativeInteger(result.estimatedTokens) ||
    !isSafeNonnegativeInteger(result.offsetCharacters) || !isSafeNonnegativeInteger(result.nextOffsetCharacters) ||
    !isSafeNonnegativeInteger(result.returnedCharacters) || !isSafeNonnegativeInteger(result.remainingCharacters) ||
    result.returnedCharacters !== result.content.length ||
    result.nextOffsetCharacters - result.offsetCharacters !== result.returnedCharacters ||
    result.totalCharacters < result.nextOffsetCharacters ||
    result.remainingCharacters !== result.totalCharacters - result.nextOffsetCharacters ||
    typeof result.eof !== "boolean" || result.eof !== (result.remainingCharacters === 0) ||
    typeof result.truncated !== "boolean" || result.truncated !== !result.eof ||
    typeof result.contextClamped !== "boolean" ||
    !Array.isArray(result.diagnostics) || result.diagnostics.length > BROWSER_PAGE_READ_MAX_DIAGNOSTICS ||
    !result.diagnostics.every((diagnostic) =>
      typeof diagnostic === "string" && /^[a-z0-9-]{1,64}$/.test(diagnostic)) ||
    !["complete", "partial", "empty", "noisy", "visual-required", "challenge", "error"].includes(String(result.quality)) ||
    !["none", "navigation-error", "timeout", "evaluation-error", "empty-dom", "iframe-limited", "virtualized", "visual-required", "challenge", "consent-wall"].includes(String(result.failure)) ||
    !result.blocks.every(isBrowserPageReadBlock)) {
    return { ok: false, error: "browser research read result is malformed" };
  }
  if (!isStrictRecord(result.extraction, BROWSER_PAGE_READ_EXTRACTION_KEYS) ||
    !isStrictRecord(result.timing, BROWSER_PAGE_READ_TIMING_KEYS) ||
    !isStrictRecord(result.challenge, BROWSER_PAGE_READ_CHALLENGE_KEYS)) {
    return { ok: false, error: "browser research read result is malformed" };
  }
  if (result.continuation !== undefined) {
    if (!isStrictRecord(result.continuation, BROWSER_PAGE_READ_CONTINUATION_KEYS) ||
      result.eof || result.continuation["version"] !== 1 ||
      typeof result.continuation["reference"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.continuation["reference"]) ||
      result.continuation["nextOffsetCharacters"] !== result.nextOffsetCharacters ||
      typeof result.continuation["expiresAt"] !== "string" ||
      !Number.isFinite(Date.parse(result.continuation["expiresAt"]))) {
      return { ok: false, error: "browser research read result is malformed" };
    }
  }
  if (result.pageReference !== undefined) {
    if (!isStrictRecord(result.pageReference, BROWSER_PAGE_READ_PAGE_REFERENCE_KEYS) ||
      result.pageReference["version"] !== 1 ||
      typeof result.pageReference["reference"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.pageReference["reference"]) ||
      typeof result.pageReference["expiresAt"] !== "string" ||
      !Number.isFinite(Date.parse(result.pageReference["expiresAt"])) ||
      result.content.length === 0 || result.challenge["detected"] === true || result.quality === "challenge") {
      return { ok: false, error: "browser research read result is malformed" };
    }
  }
  if (result.evictedPageReferences !== undefined) {
    if (result.pageReference === undefined || !Array.isArray(result.evictedPageReferences) ||
      result.evictedPageReferences.length > 16 ||
      !result.evictedPageReferences.every((evicted) =>
        isStrictRecord(evicted, BROWSER_PAGE_READ_EVICTED_PAGE_REFERENCE_KEYS) &&
        evicted["version"] === 1 &&
        typeof evicted["reference"] === "string" && /^[A-Za-z0-9_-]{43}$/.test(evicted["reference"]) &&
        typeof evicted["title"] === "string" && evicted["title"].length <= BROWSER_PAGE_READ_MAX_TITLE_CHARS &&
        isNoncredentialedHttpUrl(evicted["finalUrl"], true))) {
      return { ok: false, error: "browser research read result is malformed" };
    }
  }
  if (
    result.continuation !== undefined &&
    result.pageReference !== undefined &&
    (result.continuation["reference"] !== result.pageReference["reference"] ||
      result.continuation["expiresAt"] !== result.pageReference["expiresAt"])
  ) {
    return { ok: false, error: "browser research read result is malformed" };
  }
  if (result.evictedPageReferences !== undefined && result.pageReference !== undefined) {
    const references = new Set<string>();
    for (const evicted of result.evictedPageReferences) {
      // Array.prototype.every does not narrow an untrusted wire array for the
      // loop below; retain the local guard before using its reference.
      if (!isStrictRecord(evicted, BROWSER_PAGE_READ_EVICTED_PAGE_REFERENCE_KEYS) ||
        typeof evicted["reference"] !== "string") {
        return { ok: false, error: "browser research read result is malformed" };
      }
      const reference = evicted["reference"];
      if (references.has(reference) || reference === result.pageReference["reference"]) {
        return { ok: false, error: "browser research read result is malformed" };
      }
      references.add(reference);
    }
  }
  if (result.consentRecovery !== undefined) {
    if (!isStrictRecord(result.consentRecovery, BROWSER_PAGE_READ_CONSENT_RECOVERY_KEYS) ||
      result.failure !== "consent-wall" || result.consentRecovery["version"] !== 1 ||
      typeof result.consentRecovery["reference"] !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(result.consentRecovery["reference"]) ||
      typeof result.consentRecovery["expiresAt"] !== "string" ||
      !Number.isFinite(Date.parse(result.consentRecovery["expiresAt"])) ||
      !Array.isArray(result.consentRecovery["operations"]) ||
      result.consentRecovery["operations"].join(",") !== "snapshot,screenshot,click_control,click_coordinates,wait,read,abandon") {
      return { ok: false, error: "browser research read result is malformed" };
    }
  }
  const extraction = result.extraction as BrowserPageReadExtractionWire;
  const timing = result.timing as BrowserPageReadTimingWire;
  const challenge = result.challenge as BrowserPageReadChallengeWire;
  if (![
    "fixed-dom-semantic-v1",
    "mozilla-readability-turndown-v1",
    "agent-browser-accessibility-snapshot-v1",
  ].includes(String(extraction.method)) ||
    !["article", "main", "body", "none"].includes(String(extraction.root)) ||
    typeof extraction.iframeCount !== "number" || !Number.isSafeInteger(extraction.iframeCount) || extraction.iframeCount < 0 ||
    !["loading", "interactive", "complete", "unknown"].includes(String(timing.readiness)) ||
    !isOptionalNonnegativeNumber(timing.extractionMs) || !isOptionalNonnegativeNumber(timing.elapsedMs) ||
    typeof challenge.detected !== "boolean" || !["none", "heuristic"].includes(String(challenge.confidence)) ||
    !Array.isArray(challenge.signals) || challenge.signals.length > 6 ||
    !challenge.signals.every((signal) => typeof signal === "string" &&
      ["captcha", "recaptcha", "hcaptcha", "turnstile", "cloudflare", "verify-human"].includes(signal))) {
    return { ok: false, error: "browser research read result is malformed" };
  }
  return { ok: true, result: value as unknown as BrowserPageReadResult };
}

const BROWSER_RESEARCH_CONSENT_RECOVERY_RESULT_KEYS = new Set([
  "kind", "operation", "reference", "expiresAt", "state", "snapshot", "controls", "viewport", "image", "page",
]);
const BROWSER_RESEARCH_CONSENT_RECOVERY_CONTROL_KEYS = new Set(["reference", "label"]);
const BROWSER_RESEARCH_CONSENT_RECOVERY_VIEWPORT_KEYS = new Set(["cssWidth", "cssHeight", "imageWidth", "imageHeight", "scale"]);
const BROWSER_RESEARCH_CONSENT_RECOVERY_IMAGE_KEYS = new Set(["mime", "base64"]);

export function parseRelayBrowserResearchConsentRecoveryResult(
  value: unknown,
): RelayBrowserResearchConsentRecoveryResultValidationResult {
  if (!isStrictRecord(value, BROWSER_RESEARCH_CONSENT_RECOVERY_RESULT_KEYS) ||
    value["kind"] !== "browser_research_consent_recovery" ||
    !["snapshot", "screenshot", "click_control", "click_coordinates", "wait", "read", "abandon"].includes(String(value["operation"])) ||
    typeof value["reference"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value["reference"]) ||
    typeof value["expiresAt"] !== "string" || !Number.isFinite(Date.parse(value["expiresAt"])) ||
    !["consent_wall", "cleared", "released"].includes(String(value["state"]))) {
    return { ok: false, error: "browser research consent recovery result is malformed" };
  }
  if (value["snapshot"] !== undefined && (typeof value["snapshot"] !== "string" || value["snapshot"].length > 64_000)) {
    return { ok: false, error: "browser research consent recovery result is malformed" };
  }
  if (value["controls"] !== undefined && (!Array.isArray(value["controls"]) || value["controls"].length > 32 ||
    !value["controls"].every((control) => isStrictRecord(control, BROWSER_RESEARCH_CONSENT_RECOVERY_CONTROL_KEYS) &&
      typeof control["reference"] === "string" && /^e\d+$/.test(control["reference"]) &&
      typeof control["label"] === "string" && control["label"].length >= 1 && control["label"].length <= 160))) {
    return { ok: false, error: "browser research consent recovery result is malformed" };
  }
  if (value["viewport"] !== undefined) {
    const viewport = value["viewport"];
    if (!isStrictRecord(viewport, BROWSER_RESEARCH_CONSENT_RECOVERY_VIEWPORT_KEYS) ||
      !["cssWidth", "cssHeight", "imageWidth", "imageHeight"].every((key) => isSafeNonnegativeInteger(viewport[key]) && viewport[key] > 0) ||
      typeof viewport["scale"] !== "number" || !Number.isFinite(viewport["scale"]) || viewport["scale"] <= 0) {
      return { ok: false, error: "browser research consent recovery result is malformed" };
    }
  }
  if (value["image"] !== undefined && (!isStrictRecord(value["image"], BROWSER_RESEARCH_CONSENT_RECOVERY_IMAGE_KEYS) ||
    value["image"]["mime"] !== "image/png" || typeof value["image"]["base64"] !== "string" ||
    value["image"]["base64"].length > 12_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value["image"]["base64"]))) {
    return { ok: false, error: "browser research consent recovery result is malformed" };
  }
  if (value["page"] !== undefined && !parseRelayBrowserResearchReadResult(value["page"]).ok) {
    return { ok: false, error: "browser research consent recovery result is malformed" };
  }
  if ((value["operation"] === "screenshot") !== (value["image"] !== undefined && value["viewport"] !== undefined) ||
    (value["operation"] === "snapshot") !== (value["snapshot"] !== undefined && value["controls"] !== undefined) ||
    (value["state"] === "cleared" && value["operation"] === "read") !== (value["page"] !== undefined)) {
    return { ok: false, error: "browser research consent recovery result is malformed" };
  }
  return { ok: true, result: value as unknown as BrowserResearchConsentRecoveryResult };
}

function isOptionalNonnegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBrowserPageReadBlock(value: unknown): boolean {
  if (!isStrictRecord(value, BROWSER_PAGE_READ_BLOCK_KEYS)) return false;
  const block = value as BrowserPageReadBlockWire;
  return ["heading", "paragraph", "list-item", "quote", "preformatted", "table"].includes(String(block.kind)) &&
    typeof block.text === "string" && block.text.length <= BROWSER_PAGE_READ_PROGRAM_MAX_BLOCK_TEXT_CHARS &&
    (block.links === undefined || (Array.isArray(block.links) &&
      block.links.length <= BROWSER_PAGE_READ_PROGRAM_MAX_LINKS_PER_BLOCK &&
      block.links.every(isBrowserPageReadLink)));
}

function isBrowserPageReadLink(value: unknown): boolean {
  if (!isStrictRecord(value, BROWSER_PAGE_READ_LINK_KEYS)) return false;
  const link = value as BrowserPageReadLinkWire;
  return typeof link.text === "string" && link.text.length <= 80 && isNoncredentialedHttpUrl(link.href);
}

/** Exact desktop-only admission; this is a gate, never a relay selector. */
export function canRelayExecuteBrowserResearchRead(protocolVersion: number, capabilities: RelayCapabilities): boolean {
  return Number.isSafeInteger(protocolVersion) && protocolVersion >= BROWSER_RESEARCH_READ_PROTOCOL_VERSION &&
    capabilities.profile === "desktop-agent" && capabilities.canResearchWeb === true;
}

export function canRelayExecuteBrowserResearchSearch(protocolVersion: number, capabilities: RelayCapabilities): boolean {
  return canRelayExecuteBrowserResearchRead(protocolVersion, capabilities) && capabilities.canSearchResearchWeb === true;
}

/**
 * v13: inspection is a separate, inert operation over an already-owned
 * Electron-memory page.  It deliberately does not inherit v12 continuation
 * merely because a Desktop can retain a non-EOF page.
 */
export function canRelayExecuteBrowserResearchSnapshotInspection(
  protocolVersion: number,
  capabilities: RelayCapabilities,
): boolean {
  return canRelayExecuteBrowserResearchRead(protocolVersion, capabilities) &&
    protocolVersion >= BROWSER_RESEARCH_SNAPSHOT_INSPECTION_PROTOCOL_VERSION &&
    capabilities.canInspectBrowserPageSnapshot === true;
}

export function canRelayExecuteBrowserResearchConsentRecovery(
  protocolVersion: number,
  capabilities: RelayCapabilities,
): boolean {
  return canRelayExecuteBrowserResearchRead(protocolVersion, capabilities) &&
    protocolVersion >= BROWSER_RESEARCH_SNAPSHOT_INSPECTION_PROTOCOL_VERSION &&
    capabilities.canRecoverResearchConsent === true;
}
