import type { RelaySecurityScanProgressMessage, SecurityScanProgress } from "./security-scan-progress";
import {
  DESKTOP_FILESYSTEM_ACCESS_OPERATIONS,
  DESKTOP_FILESYSTEM_GRANT_LIFETIMES,
  type DesktopFilesystemAccessOperation,
  type DesktopFilesystemGrantLifetime,
  type DesktopFilesystemGrantSubject,
} from "@nautilo/desktop-filesystem-grants";
import {
  PROFILE_CAPABILITY_BACKENDS,
  PROFILE_NETWORK_MODES,
  type ProfileCapabilityBackend,
  type ProfileNetworkMode,
} from "@nautilo/workstation-profiles";
import { isCanonicalNautiloInstanceId } from "@nautilo/config";
import {
  parseComputerUseHostContract,
  type ComputerUseHostContract,
  type ComputerUseJson,
} from "@nautilo/computer-use-host-protocol";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import * as path from "node:path";
import {
  parseRelayClaudeExecutionCapability,
} from "./types";
import type {
  RelayCapabilities,
  RelayDesktopFilesystemGrantSnapshot,
  RelayDesktopFilesystemGrantSnapshotEntry,
  RelayWorkstationProfileSnapshot,
  RelayWorkstationProfileCapabilityEntry,
} from "./types";
import { DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE } from "./types";
import type { RelayGlobSearchArgs, RelayGrepSearchArgs } from "./search";
import type {
  RelayCodexCancelMessage,
  RelayCodexCommandMessage,
  RelayCodexCommandResponseMessage,
  RelayCodexCreditMessage,
  RelayCodexEventMessage,
  RelayCodexRequestMessage,
  RelayCodexRequestResponseMessage,
  RelayCodexStatusMessage,
  RelayRegisteredV8,
} from "./codex-protocol";
import type { RelayAcpClientMessage, RelayAcpServerMessage } from "./acp-protocol";
import {
  CLAUDE_CONNECTION_PROTOCOL_VERSION,
  type RelayClaudeConnectionDiscoverCommand,
  type RelayClaudeConnectionDiscoveryResult,
} from "./claude-connection-protocol";
import type {
  RelayClaudeExecutionCommand,
  RelayClaudeExecutionDesktopEvent,
} from "./claude-execution-protocol";

/**
 * Current relay protocol version the client advertises on register.
 *
 * **v2 (M174)** added the `fs` execution class (`executionClass:"fs"`)
 * so the server can proxy discrete filesystem primitives to the relay
 * for the unified `file` tool's `current`/`absolute` zones. A v2 relay
 * is the prerequisite for routing `file` fs ops to a connected machine.
 *
 * **v3 (D384 Phase 5 Slice A)** added MCP hosting messages:
 * `relay:configure-mcp` (server→relay) and `relay:advertise-mcp-tools`
 * (relay→server), plus the optional `RelayCapabilities.mcpTools`
 * summary advertised at register. A v3 relay is the prerequisite for
 * the server routing MCP tool calls through a connected machine.
 * Backward-compatible — v2 relays still register and operate.
 *
 * **v4 (M206 Slice A)** added the `local-file` execution class and
 * typed `RelayLocalFileRequest`/`RelayLocalFileResult` wire contract,
 * plus optional `RelayCapabilities.localFileExecution` and
 * `canRunOffice` advertisements. A v4 Electron desktop relay is the
 * prerequisite for local-zone file execution; v1–v3 relays still
 * register and operate without local-file dispatch.
 *
 * **v5 (D417)** adds bounded media chunk transport. It never places an
 * entire media file in one WebSocket message: each chunk is canonical base64
 * for at most 1 MiB decoded, while a transfer is capped at 64 MiB.
 *
 * **v6 (D418 task 3.1.1)** added the historical grant-envelope foundation.
 * The strict renamed `desktopFilesystemGrant*` request/snapshot fields are
 * v9-only; pre-v9 relays never receive or retain those fields.
 *
 * **v7 (D418 foundation)** adds desktop-session identity and an atomic
 * capability-replacement transport. The Electron desktop relay registers
 * with a per-main-process-launch `desktopSessionId` and a monotonic
 * `capabilityRevision`, and may later send `relay:update-capabilities`
 * (client→server) to atomically replace its full advertised capability
 * state — without a reconnect. The renamed advisory grant snapshot is gated
 * separately at protocol v9.
 * The server acknowledges with `relay:capabilities-updated`. Headless
 * relays omit `desktopSessionId` and never send the update; they continue
 * to register and operate as before. Backward-compatible — v1–v6 relays
 * still register and operate.
 *
 * **v8 (D453)** adds a separate optional Electron Codex host transport.
 * Codex work is never represented as `relay:dispatch`.
 *
 * **v9 (D448 Phase 5)** renames generic local filesystem grant request and
 * snapshot wire fields to `desktopFilesystemGrant*`, plus one strict,
 * high-level `local-file` `apply_patch` operation. The renamed strict fields
 * are not aliases, so the capability protocol version is bumped. Its
 * payload is patch text plus trusted routing metadata;
 * it never carries argv, shell text, environment values, or a server
 * Workspace storage path. A v9-capable desktop relay must still revalidate
 * live local Desktop filesystem authority before any future execution.
 *
 * **v10 (D458 Computer Files)** establishes bounded `fs.readdir` as a
 * protocol contract. The relay caps every listing at
 * `RELAY_FS_READDIR_MAX_ENTRIES`, reads only through the sentinel entry, and
 * returns `truncated` when there were more entries.
 * **v11 (D502 Stack 1)** adds a narrow `relay:run-shell-progress` envelope.
 * It is emitted only for paired Desktop raw-shell output; it is not a
 * general tool streaming facility. Final `relay:result` remains canonical.
 *
 * **v12 (D503 Wave 1 Unit 1)** adds the correlated local-MCP truth channel:
 * `relay:mcp-preflight` / result and an optional operation envelope on the
 * existing `relay:configure-mcp` / result. A v12 peer is required because
 * the server must never mistake a v11 relay's old fire-and-forget configure
 * behavior for a confirmed process outcome. The existing uncorrelated
 * configure frame remains valid for v3–v11 compatibility.
 *
 * **v13 (D452)** adds a separate Electron ACP readiness-only channel. It
 * carries no executable, path, environment, raw probe output, credentials,
 * ACP traffic, or task execution command.
 *
 * **v14 (D452 Task 4.2)** adds a typed prepared-workspace execution lane and
 * bounded semantic events. It still excludes raw ACP, local paths,
 * executable/environment data, provider/model controls, permission response,
 * and Stop.
 *
 * **v14 (D500 destination union)** changes the structured-SSH approved
 * request and prepare envelopes to reject stale host-only intent. It carries
 * either a named connection or an exact ad hoc endpoint, never both.
 *
 * **v15 (D500 Wave 1)** adds a narrow `relay:structured-ssh-progress`
 * envelope. It carries bounded process output observations or copy-transfer
 * counters for one already-dispatched structured SSH operation. It is not a
 * generic stream, cannot authorize, retry, or complete an operation, and the
 * final `relay:result` remains canonical.
 *
 * It also adds D504's optional `canContinueBrowserPageRead` and
 * `canSearchResearchWeb` capabilities and
 * installs an Electron-local owner binding for immutable browser-page
 * snapshots. The reference is never server authority and old relays retain
 * ordinary bounded page reads.
 *
 * **v13 (D504 1.5.1)** adds the separately negotiated
 * `canInspectBrowserPageSnapshot` capability. A v12 peer may retain and page
 * a non-EOF snapshot, but must never receive an EOF page reference or
 * eviction receipt.
 *
 * **v17 (D452)** adds a closed, correlated Claude Connections discovery
 * transport. It carries no task, session, credential, path, or cost data.
 *
 * **v18 (D452)** adds a distinct current-socket Claude execution transport.
 * It is only an Electron host forwarding seam; discovery remains v17.
 *
 * **v19 (D565)** binds hosted-MCP dispatch to the exact owning Relay. The
 * generic `hostedBy` provenance marker prevents a runtime-advertised MCP name
 * from shadowing a built-in dispatch lane.
 */
// v20 adds owner-private Claude permission detail; never sent to older peers.
export const RELAY_PROTOCOL_VERSION = 20;
/** Claude Connections discovery requires an exact v17 selected socket. */
const CLAUDE_CONNECTION_DISCOVERY_PROTOCOL_VERSION = CLAUDE_CONNECTION_PROTOCOL_VERSION;
/** Cua-only semantic Computer Use requires the complete v17 capability contract. */
export const RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION = 17;
/** The narrow raw-shell observation envelope first exists in protocol v11. */
export const RELAY_RUN_SHELL_PROGRESS_PROTOCOL_VERSION = 11;
/** D503's correlated local-MCP preflight/configure truth channel. */
export const RELAY_MCP_TRUTH_PROTOCOL_VERSION = 12;
/** Hosted MCP dispatch provenance is mandatory on an exact v19 socket. */
export const RELAY_MCP_DISPATCH_PROVENANCE_PROTOCOL_VERSION = 19;
/** D503 v12 ceiling for one bounded local-MCP truth frame. */
export const RELAY_MCP_TRUTH_MAX_FRAME_BYTES = 32 * 1024;
/** D500's correlated local structured-SSH preparation channel. */
export const RELAY_SSH_PREPARE_PROTOCOL_VERSION = 14;
export const RELAY_SSH_PREPARE_MAX_FRAME_BYTES = 16 * 1024;
/** D500 v15 bounded, provisional structured-SSH observations. */
export const RELAY_STRUCTURED_SSH_PROGRESS_PROTOCOL_VERSION = 15;
/** D500 v16 — owner-bound Structured SSH output continuation and explicit budgets. */
export const RELAY_STRUCTURED_SSH_CONTINUATION_PROTOCOL_VERSION = 16;
export const RELAY_STRUCTURED_SSH_PROGRESS_MAX_TEXT_BYTES = 4 * 1024;
export const RELAY_STRUCTURED_SSH_PROGRESS_MAX_FRAME_BYTES = 8 * 1024;
/** D502 v11 hard ceilings for provisional raw-shell observation frames. */
export const RELAY_RUN_SHELL_PROGRESS_MAX_TEXT_BYTES = 4 * 1024;
export const RELAY_RUN_SHELL_PROGRESS_MAX_FRAME_BYTES = 8 * 1024;
/** Immutable browser-page continuation is available from protocol v12. */
export const RELAY_BROWSER_PAGE_CONTINUATION_PROTOCOL_VERSION = 12;
/** Immutable browser-page reference publication is available from protocol v13. */
export const RELAY_BROWSER_PAGE_SNAPSHOT_REFERENCE_PROTOCOL_VERSION = 13;
/**
 * Oldest relay protocol the current client/server can intentionally
 * negotiate. v9 is the released pre-bounded-readdir contract and remains a
 * shell-capable compatibility floor; filesystem capabilities are removed
 * from v9 registrations so the v10 bounded listing contract never becomes
 * optional.
 */
export const RELAY_MIN_SUPPORTED_PROTOCOL_VERSION = 9;
/** M206 local-file and local-office payloads were introduced in protocol v4. */
export const LOCAL_FILE_PROTOCOL_VERSION = 4;
/** D417's constrained MP4-to-M4A payload was introduced in protocol v5. */
export const MEDIA_EXTRACTION_PROTOCOL_VERSION = 5;
/** D448's renamed desktop-filesystem-grant request and snapshot fields require v9. */
export const DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION = 9;
/** D448's coordinated local mutation identity and committed-revision receipt require v9. */
export const COORDINATED_LOCAL_MUTATION_PROTOCOL_VERSION = 9;
/** D418's atomic capability-update transport was introduced in protocol v7. */
export const CAPABILITY_UPDATE_PROTOCOL_VERSION = 7;
/** D448's typed relay-local apply-patch operation and renamed grant wire fields require v9. */
export const APPLY_PATCH_PROTOCOL_VERSION = 9;
export const RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION = 1 as const;
export const RELAY_LOCAL_APPLY_PATCH_VERSION = 1 as const;

/**
 * Fail closed when speaking a protocol older than v10's bounded Computer
 * Files contract. Shell and other pre-v10 capabilities remain available, but
 * neither peer may infer filesystem support from a v9 registration.
 */
export function projectRelayCapabilitiesForProtocol(
  capabilities: RelayCapabilities,
  protocolVersion: number,
): RelayCapabilities {
  const compatible = { ...capabilities };
  if (protocolVersion < RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION) {
    delete compatible.computerUseSemanticVersion;
    delete compatible.desktopAutomation;
    delete compatible.canControlDesktop;
  }
  if (protocolVersion < 13) {
    delete compatible.acp;
  } else if (protocolVersion < 15 && compatible.acp?.version === 2) {
    if (compatible.acp.registrations.some((registration) => registration === "hermes-acp")) {
      compatible.acp = {
        version: 1,
        hostKind: "electron",
        registrations: ["hermes-acp"],
      };
    } else {
      delete compatible.acp;
    }
  }
  if (protocolVersion < CLAUDE_CONNECTION_DISCOVERY_PROTOCOL_VERSION) {
    delete compatible.claude;
  }
  if (protocolVersion < 18) {
    delete compatible.claudeExecution;
  } else if (
    compatible.profile !== "desktop-agent" ||
    compatible.claudeExecution !== undefined &&
    !parseRelayClaudeExecutionCapability(compatible.claudeExecution).ok
  ) {
    delete compatible.claudeExecution;
  }
  if (protocolVersion < RELAY_STRUCTURED_SSH_CONTINUATION_PROTOCOL_VERSION) {
    delete compatible.canReadStructuredSshOutput;
  }
  if (protocolVersion < 10) {
    delete compatible.canReadWorkspace;
    delete compatible.canWriteWorkspace;
    delete compatible.workspaceRoot;
    delete compatible.currentFolderRoot;
  }
  if (protocolVersion < RELAY_BROWSER_PAGE_CONTINUATION_PROTOCOL_VERSION) {
    delete compatible.canContinueBrowserPageRead;
    delete compatible.canSearchResearchWeb;
  }
  if (protocolVersion < RELAY_BROWSER_PAGE_SNAPSHOT_REFERENCE_PROTOCOL_VERSION) {
    delete compatible.canInspectBrowserPageSnapshot;
    delete compatible.canReplayResearchConsent;
    delete compatible.canRecoverResearchConsent;
  }
  return compatible;
}

/**
 * Exact dispatch eligibility gate for D448's local apply-patch operation.
 * Neither generic local-file support nor a protocol-v9 registration alone is
 * sufficient; old peers and relays without the dedicated capability fail
 * closed before a dispatch can be constructed.
 */
export function canRelayExecuteApplyPatch(protocolVersion: number, capabilities: RelayCapabilities): boolean {
  return (
    Number.isSafeInteger(protocolVersion) &&
    protocolVersion >= APPLY_PATCH_PROTOCOL_VERSION &&
    capabilities.profile === "desktop-agent" &&
    capabilities.applyPatchExecution === true
  );
}
/**
 * D440 Phase 1 — version of the plan-bound `RelayWorkstationShellBinding`
 * envelope. The envelope rides as an additive optional field on protocol v7
 * `relay:dispatch` messages (no version bump — the field is optional and
 * backward-compatible; bumping `RELAY_PROTOCOL_VERSION` would break non-owned
 * version-assertion tests in this repo).
 */
export const RELAY_WORKSTATION_SHELL_BINDING_VERSION = 2 as const;
/** D500's strict, single-use structured SSH admission envelope version. */
export const RELAY_SSH_DISPATCH_BINDING_VERSION = 2 as const;
export const RELAY_SSH_PREPARE_VERSION = 2 as const;
/**
 * D516 Wave 1A — version of the exact desktop invocation binding. It is a
 * strict envelope on `executionClass:"computer_use"` within relay protocol v17.
 * Binding compatibility is versioned independently from the outer protocol.
 */
export const RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION = 12 as const;
/**
 * D418 Commit 3 — the only execution class the v2 shell-binding envelope
 * admits. A planned generic `run_shell` is a `profile_bound_sandbox`
 * dispatch (relay-dispatched, sandbox-contained); the strict parser rejects
 * any other value, and a future class would introduce a new envelope
 * version rather than widen this literal. This replaces the old six-value
 * operation taxonomy (`"shell"` literal).
 */
export const RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS = "profile_bound_sandbox" as const;
/** D417 media-only transfer limits; generic relay filesystem limits stay 16 MiB. */
export const RELAY_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
export const RELAY_MEDIA_CHUNK_BYTES = 1024 * 1024;
export const RELAY_MEDIA_TRANSFER_TTL_MS = 5 * 60 * 1000;

// ── Impact levels (matches ToolPolicy.impact) ──────────────────────────

export type RelayImpact = "read-only" | "low" | "high" | "destructive";

// ── Sandbox profile envelope (D060 Sprint 1 G5.4) ──────────────────────
//
// Per-turn sandbox shape the server attaches to every tool-call
// dispatch. Ship plan v3 §5.4: "relay is dumb — if the server
// didn\u0027t tell me how to sandbox, I don\u0027t execute." The relay
// validates this field is present + well-formed before calling
// `Sandbox.create(...)` + `spawnSandboxed(...)`.
//
// Wire-format is self-contained (literal unions mirroring
// `@nautilo/sandbox::SandboxConfig` + deployment-mode + security-level)
// so `@nautilo/relay` doesn\u0027t take a runtime dep on `@nautilo/sandbox`.
// The SandboxConfig shape could evolve across protocol versions;
// keeping the wire type local anchors the protocol and forces a
// conscious version bump if the shape diverges.

export type RelayDeploymentMode =
  | "server"
  | "desktop-permissive"
  | "desktop-locked";

export type RelaySecurityLevel =
  | "yolo"
  | "permissive"
  | "standard"
  | "cautious"
  | "paranoid";

export type RelaySandboxMode = "enabled" | "disabled";

export type RelayNetworkPolicy =
  | { readonly mode: "host" }
  | { readonly mode: "isolated" }
  | {
      readonly mode: "proxy-allowlist";
      readonly allow: readonly RelayNetworkAllowRule[];
      readonly defaultPort?: 443;
    };

export type RelayNetworkAllowRule =
  | {
      readonly type: "domain";
      readonly host: string;
      readonly ports?: readonly number[];
    }
  | {
      readonly type: "wildcard";
      readonly suffix: string;
      readonly ports?: readonly number[];
    }
  | {
      readonly type: "cidr";
      readonly cidr: string;
      readonly ports?: readonly number[];
    };

/**
 * Wire-format mirror of `@nautilo/sandbox::SandboxConfig`. Must stay
 * STRUCTURALLY EQUIVALENT — a runtime guard in the relay validates
 * the envelope then hands it to `Sandbox.create()` without coercion.
 * If you add a field to SandboxConfig, add it here too, bump the
 * protocol version, and update the validator.
 */
export interface RelaySandboxConfig {
  readonly mode: RelaySandboxMode;
  readonly writablePaths: readonly string[];
  readonly projectPaths: readonly string[];
  readonly readOnlyPaths?: readonly string[];
  /**
   * D418 task 3.2.1 — canonical protected-path subtrees the sandbox
   * must deny (read + write) after every allow. Optional + additive; the
   * server does NOT populate this field — the desktop relay compiles it
   * LOCALLY from its live `ProtectedPathPolicy` when it rebuilds the
   * envelope for a plan-bound shell dispatch (the server's envelope is
   * an untrusted mirror and is never authority for protected-path
   * enforcement). Absent on non-Full-Mode dispatches (byte-for-byte
   * prior behavior). Must stay structurally equivalent to
   * `@nautilo/sandbox::SandboxConfig.protectedPaths`.
   */
  readonly protectedPaths?: readonly string[];
  /** Local-only relay-created trusted empty-file mask for bubblewrap. */
  readonly protectedFileMaskPath?: string;
  readonly passthroughEnv: readonly string[];
  readonly networkPolicy?: RelayNetworkPolicy;
}

/**
 * Per-dispatch sandbox profile. Built by the server\u0027s Policy
 * Resolver from `resolveServerPosture()` + deployment profile helper
 * + runtime workspace inputs, attached to every `relay:dispatch`.
 *
 * `mode` + `securityLevel` echo the posture so the relay can log
 * what shape it ran under without re-deriving it. They are NOT used
 * for enforcement (the `config` field is the enforcement surface);
 * they\u0027re forensic + for debug UIs.
 */
export interface RelaySandboxProfile {
  readonly workspace: string;
  readonly dataDir: string;
  readonly toolsBin: string;
  readonly config: RelaySandboxConfig;
  readonly mode: RelayDeploymentMode;
  readonly securityLevel: RelaySecurityLevel;
  /**
   * Whether the relay must REFUSE to execute when the kernel
   * sandbox backend (bwrap / sandbox-exec) is unavailable. Mirrors
   * `SandboxCreateOptions.failIfNoBackend`. Encodes the paranoid
   * contract on the wire: `serverRestrictive` / `desktopLocked`
   * profiles set this true so a misconfigured host fails loudly
   * instead of silently passthrough-executing.
   *
   * REQUIRED on the wire — no default. Server\u0027s deployment-profile
   * helper owns the decision (currently `true` for server +
   * desktop-locked, `false` for desktop-permissive).
   */
  readonly failIfNoBackend: boolean;
}

// ── Client → Server ────────────────────────────────────────────────────

export type RelayRegisterMessage = {
  type: "relay:register";
  relayId: string;
  userId: string;
  capabilities: RelayCapabilities;
  /**
   * Version the connecting relay was built against. Typed as `number` so an
   * arbitrary wire payload can be parsed and rejected cleanly; pre-release
   * registration requires the exact current protocol.
   */
  protocolVersion: number;
  /**
   * Additive v10 negotiation offer. `protocolVersion` remains the legacy-safe
   * bootstrap version for pre-negotiation servers; aware servers select the
   * highest version in the intersection of this range and server policy.
   */
  protocolRange?: {
    minimum: number;
    maximum: number;
  } | undefined;
  /**
   * Capabilities projected for specific offered versions. This lets the
   * legacy `capabilities` field remain safe for a v9 server while a v10 server
   * immediately registers the full v10 capability set it selected.
   */
  capabilitiesByProtocolVersion?: Record<string, RelayCapabilities> | undefined;
  token?: string | undefined;
  /**
   * D418 protocol v7 — per Electron main-process-launch identity for the
   * desktop relay. Minted once per launch by a testable helper and carried
   * across reconnects so the server can bind capability updates to the
   * exact registered session. Desktop relays only; the headless relay
   * omits this. Required to send `relay:update-capabilities`.
   */
  desktopSessionId?: string | undefined;
  /**
   * D418 protocol v7 — monotonic revision of the advertised capability
   * state at register time. The desktop relay sends its current revision;
   * each subsequent `relay:update-capabilities` carries a strictly greater
   * revision, and the server rejects stale/duplicate revisions. Optional
   * on the wire for backward compatibility with pre-v7 relays.
   */
  capabilityRevision?: number | undefined;
};

export type RelayHeartbeatMessage = {
  type: "relay:heartbeat";
  relayId: string;
};

export type RelayResultMessage = {
  type: "relay:result";
  correlationId: string;
  status: "ok" | "error";
  result?: unknown;
  error?: string | undefined;
  /** Machine-readable error category (e.g. `google_auth_required`). */
  errorCode?: string | undefined;
  networkDeniedDestination?: RelayNetworkDeniedDestination | undefined;
  durationMs?: number | undefined;
};

/** D502 v1 — bounded, provisional observation of one Desktop raw-shell stream. */
export type RelayRunShellProgressMessage = {
  type: "relay:run-shell-progress";
  correlationId: string;
  /** Envelope revision. New semantics require a new value. */
  version: 1;
  /** Monotonic per process, across stdout and stderr. */
  sequence: number;
  stream: "stdout" | "stderr";
  /** First raw byte covered by this observation in this stream. */
  offsetBytes: number;
  /** First raw byte after this observation, including dropped bytes. */
  endOffsetBytes: number;
  /** UTF-8 display text, capped by the relay to 4 KiB. */
  text: string;
  /** Bytes omitted by relay coalescing after `text`, if any. */
  droppedBytes?: number | undefined;
  elapsedMs: number;
  phase: "running";
};

/**
 * D500 v1 — a secret-free, provisional observation for one structured SSH
 * dispatch. This intentionally has no destination, user, identity, command,
 * path, binding, approval, or retry metadata. The result receipt is the only
 * authoritative outcome.
 */
export type RelayStructuredSshProgressMessage =
  | {
      type: "relay:structured-ssh-progress";
      correlationId: string;
      version: 1;
      /** Monotonic per operation across output and transfer observations. */
      sequence: number;
      /** Bound to the exact prepared operation; auth never emits progress. */
      operation: "exec";
      kind: "exec-output";
      stream: "stdout" | "stderr";
      /** First raw byte covered by this observation in this stream. */
      offsetBytes: number;
      /** First raw byte after this observation, including dropped bytes. */
      endOffsetBytes: number;
      /** UTF-8 display text, capped by the relay to 4 KiB. */
      text: string;
      /** Bytes omitted after `text` by local coalescing. */
      droppedBytes?: number | undefined;
      elapsedMs: number;
      phase: "running";
    }
  | {
      type: "relay:structured-ssh-progress";
      correlationId: string;
      version: 1;
      /** Monotonic per operation across output and transfer observations. */
      sequence: number;
      /** Bound to the exact prepared operation; auth never emits progress. */
      operation: "copy-upload" | "copy-download";
      kind: "transfer";
      /** The transfer has begun or has made more observable progress. */
      phase: "starting" | "transferring";
      /** Bytes transferred at this observation; never a claim of completion. */
      transferredBytes: number;
      /** Known only when the local transfer source can determine it exactly. */
      totalBytes?: number | undefined;
      elapsedMs: number;
    };

/** Local callback payload; distributive omission preserves `kind` narrowing. */
export type RelayStructuredSshProgressObservation =
  RelayStructuredSshProgressMessage extends infer Message
    ? Message extends unknown
      ? Omit<Message, "type" | "correlationId">
      : never
    : never;

/** D502 v1 — the one canonical outcome for every raw shell process that starts. */
export type DesktopShellResult = {
  version: 1;
  execution: "sandboxed" | "workstation";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** A process was spawned, so filesystem/network effects may already exist. */
  sideEffectsMayHaveStarted: true;
  /** Profile-bound runs carry the locally revalidated revision; baseline is null. */
  profileRevision: number | null;
  /**
   * Opaque, short-lived Desktop-local continuation for output omitted from the
   * bounded inline streams. It is present only when at least one stream was
   * truncated and retention succeeded.
   */
  outputArtifact?: DesktopShellOutputArtifactReference | undefined;
};

/** D502 v1 — public metadata for a private Desktop-local output continuation. */
export type DesktopShellOutputArtifactReference = {
  version: 1;
  /** 256-bit opaque reference; it is not authority and host ownership is checked independently. */
  reference: string;
  expiresAt: string;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
};

/**
 * Relay-client-owned identity for Desktop-local continuation access. This is
 * never accepted from the server or serialized on the wire.
 */
export type RelayRunShellOwnerBinding = {
  readonly instanceId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string | null;
};

export type RelayDisconnectMessage = {
  type: "relay:disconnect";
  relayId: string;
};

/**
 * D384 Phase 5 (protocol v3) — relay→server: the relay advertises the MCP
 * tools it discovered from a configured server so the server can register
 * them in the catalog with `executor:"relay"` + `hostedBy:<relayId>`.
 * Additive; a v2 relay never sends this.
 */
export type RelayAdvertiseMcpToolsMessage = {
  type: "relay:advertise-mcp-tools";
  /** The MCP server (mcp_servers.name) whose tools these are. */
  serverName: string;
  tools: {
    name: string;
    description?: string | undefined;
    inputSchema: unknown;
    /** MCP tool hints — carried so the server derives impact/approval as it
     *  does for server-tier tools (readOnlyHint/destructiveHint/…). */
    annotations?: Record<string, unknown> | undefined;
  }[];
};

/**
 * Fixed relay-local MCP failure evidence. This protocol deliberately carries
 * no exception text, stderr, paths, URLs, exit text, or arbitrary diagnostics.
 * Humans map these stable categories to recovery copy on the server/UI.
 */
export type RelayMcpFailure = {
  code:
    | "invalid_request"
    | "missing_launcher"
    | "missing_environment"
    | "spawn_failed"
    | "protocol_failed"
    | "discovery_timeout"
    | "empty_toolset"
    | "internal";
};

export type RelayMcpEnvironmentStatus = {
  name: string;
  present: boolean;
};

export type RelayMcpLauncherStatus = "present" | "missing" | "not-applicable";

/**
 * Server → relay local-MCP prerequisite check. The `server` config contains
 * variable NAMES only; the relay evaluates values locally and returns only
 * booleans.
 */
export type RelayMcpPreflightMessage = {
  type: "relay:mcp-preflight";
  requestId: string;
  digest: string;
  server: RelayMcpServerConfig;
};

/** Relay → server result for one exact local-MCP preflight request. */
export type RelayMcpPreflightResultMessage = {
  type: "relay:mcp-preflight-result";
  requestId: string;
  digest: string;
  targetName: string;
  status: "ready" | "blocked";
  machineLabel: string;
  launcher: RelayMcpLauncherStatus;
  environment: RelayMcpEnvironmentStatus[];
  failure?: RelayMcpFailure | undefined;
};

/** D500 v14 server → Electron request for one local SSH capability preparation. */
export type RelaySshPrepareMessage = {
  type: "relay:ssh-prepare";
  request: RelaySshPrepareRequestV1;
};

export type RelaySshPrepareFailureCode =
  | "invalid_request"
  | "prepare_unavailable"
  | "capability_unavailable"
  | "capability_disabled"
  | "tool_disabled"
  | "destination_unavailable"
  | "connection_not_found"
  | "connection_ambiguous"
  | "remote_user_missing"
  | "invalid_destination"
  | "invalid_host"
  | "invalid_remote_user"
  | "invalid_port"
  | "connection_catalog_malformed"
  | "connection_catalog_unreadable"
  | "connection_catalog_overflow"
  | "connection_catalog_unavailable"
  | "openssh_connection_catalog_unreadable"
  | "openssh_connection_catalog_malformed"
  | "openssh_connection_catalog_overflow"
  | "openssh_connection_catalog_unsupported_match"
  | "openssh_connection_catalog_unsupported_source"
  | "resolve_aborted"
  | "resolve_spawn_failed"
  | "resolve_timed_out"
  | "resolve_output_limited"
  | "resolve_failed"
  | "config_output_invalid"
  | "config_required_value_missing"
  | "config_value_invalid"
  | "config_unsafe_directive"
  | "config_destination_mismatch"
  | "connection_source_drift"
  | "trust_store_unavailable"
  | "trust_store_corrupt"
  | "trust_store_instance_mismatch"
  | "scan_invalid_request"
  | "scan_failed"
  | "scan_timed_out"
  | "scan_aborted"
  | "scan_output_limited"
  | "scanner_output_invalid"
  | "host_key_missing"
  | "host_key_changed"
  | "host_key_ambiguous"
  | "lookup_invalid_request"
  | "observer_unavailable"
  | "lookup_failed"
  | "lookup_timed_out"
  | "lookup_aborted"
  | "lookup_output_limited"
  | "lookup_output_invalid"
  | "trust_unavailable"
  | "topology_mismatch"
  | "preparation_unavailable";

/** Bounded, secret-free facts for an Electron-local preparation refusal. */
export type RelaySshResolutionFailurePhase =
  | "intent"
  | "resolve"
  | "parse"
  | "policy"
  | "catalog"
  | "trust_store_lookup"
  | "host_key_scan"
  | "known_hosts_lookup"
  | "dispatch_reresolve";
export type RelaySshResolutionRecovery = "correct_destination" | "provide_remote_user" | "choose_connection" | "repair_connection_source" | "reduce_connection_catalog" | "retry";
export interface RelaySshResolutionFailure {
  readonly code: Exclude<RelaySshPrepareFailureCode,
    "invalid_request" | "prepare_unavailable" | "capability_unavailable" | "capability_disabled" | "tool_disabled" | "destination_unavailable" |
    "trust_unavailable" | "topology_mismatch" | "preparation_unavailable">;
  readonly phase: RelaySshResolutionFailurePhase;
  readonly retrySafe: true;
  readonly sideEffectStarted: false;
  readonly stateChanged: false;
  readonly recovery: RelaySshResolutionRecovery;
  /** Catalog source only; no path, local username, or identity material. */
  readonly source?: "openssh" | "nautilo-profile" | undefined;
  readonly observed?: { readonly files: number; readonly records: number; readonly bytes: number } | undefined;
  readonly configuredBounds?: { readonly files?: number; readonly records?: number; readonly bytes?: number; readonly includeDepth?: number } | undefined;
  readonly completeness?: false | undefined;
  readonly candidates?: readonly { readonly source: "openssh" | "nautilo-profile"; readonly name: string }[] | undefined;
}

/** D500 v14 Electron → server result. It contains no exception text. */
export type RelaySshPreparedMessage =
  | {
      type: "relay:ssh-prepared";
      requestId: string;
      status: "ok";
      response: RelaySshPrepareResponseV1;
    }
  | {
      type: "relay:ssh-prepared";
      requestId: string;
      status: "error";
      errorCode: RelaySshPrepareFailureCode;
      /** Required for every v14/v2 typed pre-effect preparation failure. */
      failure?: RelaySshResolutionFailure | undefined;
    };

/**
 * D418 protocol v7 — desktop relay→server: atomically REPLACE this relay's
 * full advertised capability state. Carries the complete `capabilities`
 * object (including the advisory grant snapshot); the server never merges
 * partial state across updates. `desktopSessionId` must exactly match the
 * id from `relay:register`, and `capabilityRevision` must be strictly
 * greater than the registered/last-applied revision or the server rejects
 * the update as stale. A narrower or empty snapshot applies immediately;
 * a malformed update leaves the prior state intact. Desktop relays only.
 */
export type RelayUpdateCapabilitiesMessage = {
  type: "relay:update-capabilities";
  relayId: string;
  /** Must match the `desktopSessionId` sent at register for this socket. */
  desktopSessionId: string;
  /** Strictly greater than the registered/last-applied revision. */
  capabilityRevision: number;
  /** Full replacement capability state. Never partially merged. */
  capabilities: RelayCapabilities;
};

export type RelayClientMessage =
  | RelayRegisterMessage
  | RelayHeartbeatMessage
  | RelayResultMessage
  | RelaySecurityScanProgressMessage
  | RelayRunShellProgressMessage
  | RelayStructuredSshProgressMessage
  | RelayDisconnectMessage
  | RelayAdvertiseMcpToolsMessage
  | RelayMcpPreflightResultMessage
  | RelaySshPreparedMessage
  | RelayMcpConfigureResultMessage
  | RelayUpdateCapabilitiesMessage
  | RelayCodexStatusMessage
  | RelayCodexCommandResponseMessage
  | RelayCodexRequestMessage
  | RelayCodexEventMessage
  | RelayAcpClientMessage
  | RelayClaudeConnectionDiscoveryResult
  | RelayClaudeExecutionDesktopEvent;

// ── Server → Client ────────────────────────────────────────────────────

export type RelayRegisteredMessage = {
  type: "relay:registered";
  relayId: string;
  /** Selected by a negotiation-aware server; absent means legacy bootstrap. */
  protocolVersion?: number | undefined;
};

export type RelayDispatchMessage = {
  type: "relay:dispatch";
  correlationId: string;
  toolName: string;
  args: Record<string, unknown>;
  timeout?: number | undefined;
  impact: RelayImpact;
  approvalObtained: boolean;
  /** v19: exact owning Relay for a server-catalogued hosted MCP tool. */
  hostedBy?: string | undefined;
  allowedRoots?: string[] | undefined;
  /**
   * D418 — optional grant reference for a future relay-local workstation
   * resolver. `allowedRoots` remains unchanged and is never authority for this
   * request. Relays before protocol v9 receive no envelope.
   */
  desktopFilesystemGrantRequest?: RelayDesktopFilesystemGrantRequest | undefined;
  /**
   * D418 task 3.1.3b — optional plan-bound shell-binding envelope for a generic
   * `run_shell` dispatch. Carries ONLY opaque ids / binding / operation metadata
   * the desktop relay needs to prove the dispatch maps to the active
   * profile/session grant authority — no roots, no paths, no filesystem
   * identity. The relay revalidates every field against its live Electron
   * authority/profile state and may use profile-bound roots only after that
   * revalidation succeeds; a stale/revoked/foreign/mismatched reference fails
   * closed with a stable denial. `allowedRoots` is never authority for this
   * request. Absent for non-Full-Mode dispatches (byte-for-byte prior behavior).
   * Additive optional field on protocol v7 — no version bump.
   */
  workstationShellBinding?: RelayWorkstationShellBinding | undefined;
  /** D538 server-owned marker: this real-workstation dispatch was admitted by the live uncontained session resolver. */
  uncontainedHostCommandsSession?: true | undefined;
  /**
   * D500 — strict, secret-free admission metadata for one structured SSH
   * operation. This is a one-use preparation reference, never SSH target or
   * key authority: Electron revalidates its capability revision and retains
   * the resolved destination plan privately. The client parses this envelope
   * at JSON ingress and never forwards the raw object to Electron.
   */
  sshBinding?: RelaySshDispatchBindingV1 | undefined;
  /**
   * D516 — strict, secret-free binding for one semantic `computer_*` desktop
   * invocation. It is issued by server admission, never model authored, and
   * Electron revalidates it before Cua effects.
   */
  desktopAutomationBinding?: DesktopAutomationInvocationBinding | undefined;
  computerUseRequest?: ComputerUseHostDispatchRequest | undefined;
  /**
   * Per-turn sandbox envelope (D060 Sprint 1 G5.4). OPTIONAL at the
   * TypeScript level for G5.4.a (foundation commit — existing
   * callsites don\u0027t yet construct one). Release builds will
   * REFUSE dispatches without it — see G5.4.c for the
   * production-build guard landed alongside the relay consumer
   * update. Development builds honor a dev-mode debug fallback
   * gated behind NAUTILO_RELAY_PROTOCOL_DEBUG=1 (ship plan v3 §5.4).
   */
  sandboxProfile?: RelaySandboxProfile | undefined;
  /**
   * D291 — explicit execution-class marker set by the server. When
   * `"computer_use"`, the request is the sandbox-exempt Computer Use class
   * and does NOT require a `sandboxProfile`. It is executable only with its
   * exact server-minted desktopAutomationBinding. `"desktop"` remains a
   * distinct local-operation class (including structured SSH output), so it
   * cannot accidentally acquire Computer Use authority.
   *
   * M174 — `"fs"` is the filesystem-primitive class: the server proxies
   * a single `RelayFsRequest` (read/write/readdir/stat/…) so the unified
   * `file` tool can reach the user's machine for `current`/`absolute`
   * zones. Like `"desktop"` it is sandbox-exempt (discrete `node:fs`
   * calls, not spawned processes) and jailed by the relay's
   * `WorkspaceGuard(allowedRoots)` instead of `spawnSandboxed`.
   *
   * M206 — `"local-file"` is the structured local execution class: the
   * server dispatches a typed `RelayLocalFileRequest` (file command,
   * history command, or office operation) so local-zone work executes
   * on the Electron relay without shipping whole-file byte primitives.
   * Sandbox-exempt like `"fs"`; jailed by `WorkspaceGuard(allowedRoots)`.
   */
  executionClass?: "computer_use" | "desktop" | "fs" | "browser" | "local-file" | "real_workstation" | "structured-ssh" | undefined;
};

export type RelayCancelMessage = {
  type: "relay:cancel";
  correlationId: string;
};

export type RelayErrorMessage = {
  type: "relay:error";
  message: string;
  /** Stable machine-readable category. Older relays safely ignore it. */
  code?: typeof import("./constants").RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE;
};

/**
 * D384 Phase 5 (protocol v3) — server→relay: the set of MCP servers this
 * relay should host (from `mcp_servers` rows with `host = 'relay-<id>'`).
 * Secrets are NOT sent — `envPassthrough` carries variable NAMES only; the
 * relay resolves values locally (relay host env / `~/.nautilo/relay/vault.enc`).
 * Additive; never sent to a v2 relay.
 */
export type RelayMcpServerConfig = {
  name: string;
  transportKind: "stdio" | "streamable-http" | "sse-legacy";
  transport: Record<string, unknown>;
  envPassthrough?: string[] | null | undefined;
  namespaceId?: string | null | undefined;
  includeTools?: string[] | null | undefined;
  excludeTools?: string[] | null | undefined;
  trustTier?: string | null | undefined;
};

export type RelayConfigureMcpMessage = {
  type: "relay:configure-mcp";
  servers: RelayMcpServerConfig[];
  /**
   * D503 v12: optional correlation for an initiating server that needs an
   * actual target outcome. Omitted for the pre-v12 fleet reconciliation path.
   */
  operation?: RelayMcpConfigureOperation | undefined;
};

export type RelayMcpConfigureOperation = {
  operationId: string;
  digest: string;
  targetName: string;
  phase: "start" | "rollback";
};

/** Relay → server outcome for a correlated `relay:configure-mcp` operation. */
export type RelayMcpConfigureResultMessage = {
  type: "relay:mcp-configure-result";
  operationId: string;
  digest: string;
  targetName: string;
  /** The target's observed state after this exact reconciliation. */
  state: "connected" | "failed" | "stopped";
  /** Exact discovered MCP tool names when `state === "connected"`. */
  toolNames: string[];
  failure?: RelayMcpFailure | undefined;
};

const RELAY_MCP_ID_MAX_BYTES = 160;
const RELAY_MCP_NAME_MAX_BYTES = 160;
const RELAY_MCP_MACHINE_LABEL_MAX_BYTES = 160;
const RELAY_MCP_ENVIRONMENT_MAX_ENTRIES = 64;
const RELAY_MCP_TOOL_NAMES_MAX_ENTRIES = 256;

function isBoundedRelayMcpString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function hasOnlyRelayMcpKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRelayMcpFailure(value: unknown): value is RelayMcpFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const allowedCodes = new Set<RelayMcpFailure["code"]>([
    "invalid_request",
    "missing_launcher",
    "missing_environment",
    "spawn_failed",
    "protocol_failed",
    "discovery_timeout",
    "empty_toolset",
    "internal",
  ]);
  return (
    hasOnlyRelayMcpKeys(raw, ["code"]) &&
    typeof raw["code"] === "string" &&
    allowedCodes.has(raw["code"] as RelayMcpFailure["code"])
  );
}

/** Strictly validates a v12 preflight result before the server resolves it. */
export function isRelayMcpPreflightResultMessage(
  value: unknown,
): value is RelayMcpPreflightResultMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const environment = raw["environment"];
  return (
    raw["type"] === "relay:mcp-preflight-result" &&
    isBoundedRelayMcpString(raw["requestId"], RELAY_MCP_ID_MAX_BYTES) &&
    isBoundedRelayMcpString(raw["digest"], RELAY_MCP_ID_MAX_BYTES) &&
    isBoundedRelayMcpString(raw["targetName"], RELAY_MCP_NAME_MAX_BYTES) &&
    (raw["status"] === "ready" || raw["status"] === "blocked") &&
    isBoundedRelayMcpString(raw["machineLabel"], RELAY_MCP_MACHINE_LABEL_MAX_BYTES) &&
    (raw["launcher"] === "present" || raw["launcher"] === "missing" || raw["launcher"] === "not-applicable") &&
    Array.isArray(environment) &&
    environment.length <= RELAY_MCP_ENVIRONMENT_MAX_ENTRIES &&
    environment.every((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      hasOnlyRelayMcpKeys(entry as Record<string, unknown>, ["name", "present"]) &&
      isBoundedRelayMcpString((entry as Record<string, unknown>)["name"], RELAY_MCP_NAME_MAX_BYTES) &&
      typeof (entry as Record<string, unknown>)["present"] === "boolean",
    ) &&
    ((raw["status"] === "ready" &&
      raw["failure"] === undefined &&
      raw["launcher"] !== "missing" &&
      environment.every((entry) => (entry as Record<string, unknown>)["present"] === true)) ||
      (raw["status"] === "blocked" && isRelayMcpFailure(raw["failure"]))) &&
    hasOnlyRelayMcpKeys(raw, [
      "type", "requestId", "digest", "targetName", "status", "machineLabel", "launcher", "environment", "failure",
    ])
  );
}

/** Strictly validates a v12 configure result before the server resolves it. */
export function isRelayMcpConfigureResultMessage(
  value: unknown,
): value is RelayMcpConfigureResultMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const toolNames = raw["toolNames"];
  return (
    raw["type"] === "relay:mcp-configure-result" &&
    isBoundedRelayMcpString(raw["operationId"], RELAY_MCP_ID_MAX_BYTES) &&
    isBoundedRelayMcpString(raw["digest"], RELAY_MCP_ID_MAX_BYTES) &&
    isBoundedRelayMcpString(raw["targetName"], RELAY_MCP_NAME_MAX_BYTES) &&
    (raw["state"] === "connected" || raw["state"] === "failed" || raw["state"] === "stopped") &&
    Array.isArray(toolNames) &&
    toolNames.length <= RELAY_MCP_TOOL_NAMES_MAX_ENTRIES &&
    toolNames.every((name) => isBoundedRelayMcpString(name, RELAY_MCP_NAME_MAX_BYTES)) &&
    ((raw["state"] === "connected" && raw["failure"] === undefined && toolNames.length > 0) ||
      (raw["state"] === "stopped" && raw["failure"] === undefined && toolNames.length === 0) ||
      (raw["state"] === "failed" && isRelayMcpFailure(raw["failure"]) && toolNames.length === 0)) &&
    hasOnlyRelayMcpKeys(raw, ["type", "operationId", "digest", "targetName", "state", "toolNames", "failure"])
  );
}

/**
 * D418 protocol v7 — server→desktop relay: acknowledgement of a
 * `relay:update-capabilities` frame. `capabilityRevision` echoes the
 * revision the server applied (or rejected). `status:"ok"` means the full
 * capability state was atomically replaced; `status:"rejected"` means the
 * update was refused (session mismatch, stale/duplicate revision, or
 * malformed capabilities) and the prior state is unchanged. `error` is
 * present on rejection for diagnostics.
 */
export type RelayCapabilitiesUpdatedMessage = {
  type: "relay:capabilities-updated";
  relayId: string;
  capabilityRevision: number;
  status: "ok" | "rejected";
  error?: string | undefined;
};

export type RelayServerMessage =
  | RelayRegisteredMessage
  | RelayRegisteredV8
  | RelayDispatchMessage
  | RelayCancelMessage
  | RelayErrorMessage
  | RelayConfigureMcpMessage
  | RelayMcpPreflightMessage
  | RelaySshPrepareMessage
  | RelayCapabilitiesUpdatedMessage
  | RelayCodexCommandMessage
  | RelayCodexCancelMessage
  | RelayCodexCreditMessage
  | RelayCodexRequestResponseMessage
  | RelayAcpServerMessage
  | RelayClaudeConnectionDiscoverCommand
  | RelayClaudeExecutionCommand;

// ── Shared types for dispatch handling ─────────────────────────────────

export type RelayDispatchRequest = {
  correlationId: string;
  toolName: string;
  args: Record<string, unknown>;
  timeout?: number | undefined;
  impact: RelayImpact;
  approvalObtained: boolean;
  /** See `RelayDispatchMessage.hostedBy`; never inferred from the tool name. */
  hostedBy?: string | undefined;
  allowedRoots?: string[] | undefined;
  /** See `RelayDispatchMessage.desktopFilesystemGrantRequest`. */
  desktopFilesystemGrantRequest?: RelayDesktopFilesystemGrantRequest | undefined;
  /** See `RelayDispatchMessage.workstationShellBinding` (D418 task 3.1.3b). */
  workstationShellBinding?: RelayWorkstationShellBinding | undefined;
  /** See `RelayDispatchMessage.uncontainedHostCommandsSession`. */
  uncontainedHostCommandsSession?: true | undefined;
  /** See `RelayDispatchMessage.sshBinding` (D500). */
  sshBinding?: RelaySshDispatchBindingV1 | undefined;
  /** See `RelayDispatchMessage.desktopAutomationBinding` (D516). */
  desktopAutomationBinding?: DesktopAutomationInvocationBinding | undefined;
  computerUseRequest?: ComputerUseHostDispatchRequest | undefined;
  /** See `RelayDispatchMessage.sandboxProfile`. */
  sandboxProfile?: RelaySandboxProfile | undefined;
  /** See `RelayDispatchMessage.executionClass` (D516 `"computer_use"` + D291 + M174 `"fs"` + D336 `"browser"` + M206 `"local-file"`). */
  executionClass?: "computer_use" | "desktop" | "fs" | "browser" | "local-file" | "real_workstation" | "structured-ssh" | undefined;
  /**
   * D502 local-only callback installed by the relay client. It is never sent
   * server→relay: the client serializes its bounded payload as the narrow
   * `relay:run-shell-progress` client message.
   */
  reportSecurityScanProgress?: ((progress: SecurityScanProgress) => void) | undefined;
  reportRunShellProgress?: ((progress: Omit<RelayRunShellProgressMessage, "type" | "correlationId">) => void) | undefined;
  /**
   * D500 v15 local-only callback for an already-authorized structured SSH
   * dispatch. It is never a generic progress hook and never travels back to
   * Electron as authority.
   */
  reportStructuredSshProgress?: ((progress: RelayStructuredSshProgressObservation) => void) | undefined;
  /** D502 local-only owner binding installed by the authenticated relay client. */
  runShellOwnerBinding?: RelayRunShellOwnerBinding | undefined;
  /** D500 v16 local-only owner binding for retained Structured SSH output. */
  structuredSshOutputOwnerBinding?: RelayRunShellOwnerBinding | undefined;
  /** D504 v12 local-only owner binding; never sent by the server/model. */
  browserPageOwnerBinding?: RelayBrowserPageOwnerBinding | undefined;
  /** D504 v13 local-only publication authority; never sent by the server/model. */
  browserPageSnapshotReferencePublication?: true | undefined;
};

export type RelayBrowserPageOwnerBinding = {
  readonly instanceId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string | null;
};

export type RelayDispatchResult = {
  status: "ok" | "error";
  result?: unknown;
  error?: string | undefined;
  /** Machine-readable error category (e.g. `google_auth_required`). */
  errorCode?: string | undefined;
  networkDeniedDestination?: RelayNetworkDeniedDestination | undefined;
  durationMs?: number | undefined;
};

// ── D448 — desktop-filesystem-grant request envelope (protocol v9) ────────────

/**
 * Stale-detection metadata copied from the selected local grant. It identifies
 * policy generation and lifetime without serializing a grant record, platform
 * authorization, bookmark, or filesystem identity.
 */
export interface RelayDesktopFilesystemGrantPolicyReference {
  readonly policyVersion: number;
  readonly lifetime: DesktopFilesystemGrantLifetime;
  readonly expiresAt?: string | undefined;
}

/**
 * Additive server→relay request for a locally held Desktop Filesystem Grant.
 *
 * This is a reference, not authorization: the future local resolver must
 * re-load the referenced grants, validate their subject/policy/lifetime, and
 * obtain platform authority immediately before filesystem access.
 */
export interface RelayDesktopFilesystemGrantRequest {
  readonly version: typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION;
  readonly grantIds: readonly string[];
  readonly requestedRoot: string;
  /** Legacy scalar operation retained for pre-D448 callers. */
  readonly operation: DesktopFilesystemAccessOperation;
  /**
   * D448 additive complete authorization set. This is never a "best
 * available" or maximum operation: every item is required. The v9
   * apply-patch operation rejects scalar-only grant envelopes.
   */
  readonly requiredOperations?: readonly DesktopFilesystemAccessOperation[] | undefined;
  readonly subject: DesktopFilesystemGrantSubject;
  readonly policy: RelayDesktopFilesystemGrantPolicyReference;
}

/** A parsed grant request suitable for the v9 apply-patch operation only. */
export type RelayApplyPatchDesktopFilesystemGrantRequest = RelayDesktopFilesystemGrantRequest & {
  readonly requiredOperations: readonly DesktopFilesystemAccessOperation[];
};

export type RelayDesktopFilesystemGrantRequestValidationResult =
  | { readonly ok: true; readonly request: RelayDesktopFilesystemGrantRequest }
  | { readonly ok: false; readonly error: string };

const DESKTOP_FILESYSTEM_GRANT_REQUEST_KEYS = new Set([
  "version",
  "grantIds",
  "requestedRoot",
  "operation",
  "requiredOperations",
  "subject",
  "policy",
]);
const DESKTOP_FILESYSTEM_GRANT_SUBJECT_KEYS = new Set(["userId", "instanceId", "relayId", "agentScope"]);
const DESKTOP_FILESYSTEM_GRANT_POLICY_KEYS = new Set(["policyVersion", "lifetime", "expiresAt"]);
// eslint-disable-next-line no-control-regex -- rejects control bytes in wire identifiers and paths
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

interface WireObject extends Record<string, unknown> {
  version?: unknown;
  grantIds?: unknown;
  requestedRoot?: unknown;
  operation?: unknown;
  requiredOperations?: unknown;
  // D448 apply-patch operation/result fields.
  kind?: unknown;
  patch?: unknown;
  routing?: unknown;
  zone?: unknown;
  turnId?: unknown;
  status?: unknown;
  partial?: unknown;
  operationCounts?: unknown;
  pathResults?: unknown;
  changedFiles?: unknown;
  revisionIds?: unknown;
  unifiedDiff?: unknown;
  runtimeVersion?: unknown;
  error?: unknown;
  fromPath?: unknown;
  path?: unknown;
  bytesTouched?: unknown;
  revisionId?: unknown;
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  add?: unknown;
  update?: unknown;
  move?: unknown;
  delete?: unknown;
  subject?: unknown;
  policy?: unknown;
  userId?: unknown;
  instanceId?: unknown;
  relayId?: unknown;
  agentScope?: unknown;
  policyVersion?: unknown;
  lifetime?: unknown;
  expiresAt?: unknown;
  // D418 advisory snapshot fields.
  revision?: unknown;
  grants?: unknown;
  id?: unknown;
  canonicalRoot?: unknown;
  access?: unknown;
  // D418 advisory Workstation Profile snapshot fields.
  profileId?: unknown;
  profileRevision?: unknown;
  protectedPolicyVersion?: unknown;
  networkMode?: unknown;
  capabilities?: unknown;
  backend?: unknown;
  // D418 task 3.1.3b — shell-binding envelope fields.
  toolCallId?: unknown;
  desktopSessionId?: unknown;
  serverBindingId?: unknown;
  pairingGeneration?: unknown;
  capabilityRevision?: unknown;
  executionClass?: unknown;
}

function isRecord(value: unknown): value is WireObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function hasExactKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).length === allowed.size && hasOnlyKeys(record, allowed);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !CONTROL_CHARACTER.test(value);
}

function parseUtcTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP.test(value)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const match = /^(.{19})(?:\.(\d{1,3}))?Z$/.exec(value);
  const expectedCanonical = match ? `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z` : undefined;
  return date.toISOString() === expectedCanonical ? date.toISOString() : undefined;
}

// ── D516 — desktop automation invocation binding ─────────────────────────

/**
 * This envelope contains only opaque runtime bindings. It contains no PIN,
 * approval, provider selection, browser authority, or model-authored value.
 */
export interface DesktopAutomationInvocationBinding {
  readonly version: typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION;
  readonly computerUseContextId: string;
  readonly computerUseInvocationId: string;
  readonly originHumanId: string;
  readonly originRunId: string;
  readonly originAgentId: string;
  readonly lineageId: string;
  readonly installationEpoch: string;
  readonly grantGeneration: number;
  readonly provider: "cua";
  readonly providerGeneration: string;
  readonly relayId: string;
  readonly pairingGeneration: string;
  readonly desktopSessionId: string;
}

/** Agent-admitted generic Host descriptor; Relay never interprets its semantics. */
export interface ComputerUseHostDispatchRequest {
  readonly contract: ComputerUseHostContract;
  readonly arguments: Readonly<Record<string, ComputerUseJson>>;
}

function isComputerUseJson(value: unknown, seen = new Set<object>()): value is ComputerUseJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((entry) => isComputerUseJson(entry, seen));
  }
  if (!isRecord(value) || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).every((entry) => isComputerUseJson(entry, seen));
}

/** Strict, semantic-free ingress parser for one generic Host request. */
export function parseComputerUseHostDispatchRequest(value: unknown): ComputerUseHostDispatchRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, new Set(["contract", "arguments"]))) return null;
  if (!isRecord(value["arguments"]) || !isComputerUseJson(value["arguments"])) return null;
  const argumentsRecord = value["arguments"] as Record<string, ComputerUseJson>;
  try {
    return Object.freeze({
      contract: parseComputerUseHostContract(value["contract"]),
      arguments: Object.freeze({ ...argumentsRecord }),
    });
  } catch { return null; }
}

export type DesktopAutomationInvocationBindingValidationResult =
  | { readonly ok: true; readonly binding: DesktopAutomationInvocationBinding }
  | { readonly ok: false; readonly error: string };

const DESKTOP_AUTOMATION_INVOCATION_BINDING_KEYS = new Set([
  "version",
  "computerUseContextId",
  "computerUseInvocationId",
  "originHumanId",
  "originRunId",
  "originAgentId",
  "lineageId",
  "installationEpoch",
  "grantGeneration",
  "provider",
  "providerGeneration",
  "relayId",
  "pairingGeneration",
  "desktopSessionId",
]);
const DESKTOP_AUTOMATION_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DESKTOP_AUTOMATION_MAX_GENERATION = 2 ** 31 - 1;

function isDesktopAutomationOpaqueId(value: unknown): value is string {
  return typeof value === "string" && DESKTOP_AUTOMATION_OPAQUE_ID.test(value);
}

function isDesktopAutomationGrantGeneration(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= DESKTOP_AUTOMATION_MAX_GENERATION
  );
}

/**
 * Strictly decode the desktop-only envelope at relay JSON ingress. Missing or
 * malformed binding is not downgraded to ordinary desktop execution.
 */
export function parseDesktopAutomationInvocationBinding(
  value: unknown,
): DesktopAutomationInvocationBindingValidationResult {
  if (!isRecord(value) || !hasExactKeys(value, DESKTOP_AUTOMATION_INVOCATION_BINDING_KEYS)) {
    return { ok: false, error: "desktop automation binding must be an exact object" };
  }
  if (value.version !== RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION) {
    return { ok: false, error: "desktop automation binding version is unsupported" };
  }
  if (
    !isDesktopAutomationOpaqueId(value["computerUseContextId"])
    || !isDesktopAutomationOpaqueId(value["computerUseInvocationId"])
    || !isDesktopAutomationOpaqueId(value["originHumanId"])
    || !isDesktopAutomationOpaqueId(value["originRunId"])
    || !isDesktopAutomationOpaqueId(value["originAgentId"])
    || !isDesktopAutomationOpaqueId(value["lineageId"])
    || !isDesktopAutomationOpaqueId(value["installationEpoch"])
    || !isDesktopAutomationGrantGeneration(value["grantGeneration"])
    || value["provider"] !== "cua"
    || !isDesktopAutomationOpaqueId(value["providerGeneration"])
    || !isDesktopAutomationOpaqueId(value.relayId)
    || !isDesktopAutomationOpaqueId(value.pairingGeneration)
    || !isDesktopAutomationOpaqueId(value.desktopSessionId)
  ) {
    return { ok: false, error: "desktop automation binding fields are invalid" };
  }
  return {
    ok: true,
    binding: {
      version: value.version,
      computerUseContextId: value["computerUseContextId"],
      computerUseInvocationId: value["computerUseInvocationId"],
      originHumanId: value["originHumanId"],
      originRunId: value["originRunId"],
      originAgentId: value["originAgentId"],
      lineageId: value["lineageId"],
      installationEpoch: value["installationEpoch"],
      grantGeneration: value["grantGeneration"],
      provider: value["provider"],
      providerGeneration: value["providerGeneration"],
      relayId: value.relayId,
      pairingGeneration: value.pairingGeneration,
      desktopSessionId: value.desktopSessionId,
    },
  };
}

/**
 * Strict, fail-closed parser for the v1 desktop-filesystem-grant request envelope.
 * The relay calls this at its JSON ingress boundary before exposing the request
 * to any dispatch handler. Missing envelopes are handled by the caller as the
 * backward-compatible baseline-only path.
 */
export function parseRelayDesktopFilesystemGrantRequest(value: unknown): RelayDesktopFilesystemGrantRequestValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, DESKTOP_FILESYSTEM_GRANT_REQUEST_KEYS)) {
    return { ok: false, error: "Desktop Filesystem Grant request must be a strict object" };
  }
  if (value.version !== RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION) {
    return { ok: false, error: "Desktop Filesystem Grant request has an unsupported version" };
  }
  if (
    !Array.isArray(value.grantIds) ||
    value.grantIds.length === 0 ||
    !value.grantIds.every(isNonBlankString) ||
    new Set(value.grantIds).size !== value.grantIds.length
  ) {
    return { ok: false, error: "Desktop Filesystem Grant request grantIds must be unique non-empty opaque ids" };
  }
  if (
    !isNonBlankString(value.requestedRoot) ||
    !path.isAbsolute(value.requestedRoot) ||
    path.normalize(value.requestedRoot) !== value.requestedRoot
  ) {
    return { ok: false, error: "Desktop Filesystem Grant request requestedRoot must be a canonical absolute path" };
  }
  if (
    typeof value.operation !== "string" ||
    !DESKTOP_FILESYSTEM_ACCESS_OPERATIONS.includes(value.operation as DesktopFilesystemAccessOperation)
  ) {
    return { ok: false, error: "Desktop Filesystem Grant request operation is unsupported" };
  }
  if (
    value.requiredOperations !== undefined &&
    (!Array.isArray(value.requiredOperations) ||
      value.requiredOperations.length === 0 ||
      !value.requiredOperations.every(
        (operation): operation is DesktopFilesystemAccessOperation =>
          typeof operation === "string" &&
          DESKTOP_FILESYSTEM_ACCESS_OPERATIONS.includes(operation as DesktopFilesystemAccessOperation),
      ) ||
      new Set(value.requiredOperations).size !== value.requiredOperations.length ||
      !value.requiredOperations.includes(value.operation as DesktopFilesystemAccessOperation))
  ) {
    return {
      ok: false,
      error: "Desktop Filesystem Grant request requiredOperations must be a unique supported set containing operation",
    };
  }
  if (
    !isRecord(value.subject) ||
    !hasOnlyKeys(value.subject, DESKTOP_FILESYSTEM_GRANT_SUBJECT_KEYS) ||
    !isNonBlankString(value.subject.userId) ||
    !isCanonicalNautiloInstanceId(value.subject.instanceId) ||
    !isNonBlankString(value.subject.relayId) ||
    !isNonBlankString(value.subject.agentScope)
  ) {
    return { ok: false, error: "Desktop Filesystem Grant request subject is invalid" };
  }
  if (
    !isRecord(value.policy) ||
    !hasOnlyKeys(value.policy, DESKTOP_FILESYSTEM_GRANT_POLICY_KEYS) ||
    !Number.isSafeInteger(value.policy.policyVersion) ||
    (value.policy.policyVersion as number) < 0 ||
    typeof value.policy.lifetime !== "string" ||
    !DESKTOP_FILESYSTEM_GRANT_LIFETIMES.includes(value.policy.lifetime as DesktopFilesystemGrantLifetime) ||
    (value.policy.expiresAt !== undefined && parseUtcTimestamp(value.policy.expiresAt) === undefined)
  ) {
    return { ok: false, error: "Desktop Filesystem Grant request policy reference is invalid" };
  }

  const policy: RelayDesktopFilesystemGrantPolicyReference = {
    policyVersion: value.policy.policyVersion as number,
    lifetime: value.policy.lifetime as DesktopFilesystemGrantLifetime,
    ...(value.policy.expiresAt !== undefined
      ? { expiresAt: parseUtcTimestamp(value.policy.expiresAt) as string }
      : {}),
  };
  return {
    ok: true,
    request: {
      version: RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION,
      grantIds: [...value.grantIds],
      requestedRoot: value.requestedRoot,
      operation: value.operation as DesktopFilesystemAccessOperation,
      ...(value.requiredOperations !== undefined
        ? { requiredOperations: [...value.requiredOperations] as DesktopFilesystemAccessOperation[] }
        : {}),
      subject: {
        userId: value.subject.userId,
        instanceId: value.subject.instanceId,
        relayId: value.subject.relayId,
        agentScope: value.subject.agentScope,
      },
      policy,
    },
  };
}

/**
 * Parse a grant envelope for the v9 apply-patch operation. Ordinary
 * local-file callers still use `parseRelayDesktopFilesystemGrantRequest`; this parser
 * refuses that downgrade because multi-file patches can require read,
 * create/modify, and delete together.
 */
export function parseRelayApplyPatchDesktopFilesystemGrantRequest(
  value: unknown,
):
  | { readonly ok: true; readonly request: RelayApplyPatchDesktopFilesystemGrantRequest }
  | { readonly ok: false; readonly error: string } {
  const parsed = parseRelayDesktopFilesystemGrantRequest(value);
  if (!parsed.ok) return parsed;
  if (parsed.request.requiredOperations === undefined) {
    return { ok: false, error: "apply-patch Desktop Filesystem Grant request requires requiredOperations" };
  }
  return {
    ok: true,
    request: parsed.request as RelayApplyPatchDesktopFilesystemGrantRequest,
  };
}

// ── D418 task 3.1.3b — plan-bound shell-binding envelope (protocol v7) ────
//
// A generic `run_shell` dispatch has no single bounded root a grant request can
// name, so the renamed `RelayDesktopFilesystemGrantRequest` shape (which requires a
// canonical `requestedRoot`) does not fit. Instead, a planned shell dispatch
// carries this opaque binding envelope: the exact plan binding tuple the
// active Full Workstation session was admitted with, plus the classified
// operation, and NOTHING else. There are no roots, no paths, no filesystem
// identity, no platform authorization, and no environment values — only the
// opaque ids / binding / operation metadata the desktop relay needs to prove
// the dispatch maps to the active profile/session grant authority.
//
// The envelope is a REFERENCE, not authority. The desktop relay revalidates
// every field against its live Electron state (relay id, desktop session id,
// capability revision, active profile binding, expected subject, and the live
// local grant store) and may use profile-bound roots only after that
// revalidation succeeds. A stale, revoked, foreign, or mismatched
// relay/profile/session reference fails closed with a stable denial. The
// server's `allowedRoots` / `sandboxProfile` are never authority for the
// binding; they remain the sandbox envelope, unchanged.

/**
 * The subject a shell binding is bound to. Mirrors the
 * `RelayDesktopFilesystemGrantRequest.subject` shape (the durable desktop agent
 * scope) so the relay can revalidate it against its expected local subject.
 */
export interface RelayWorkstationShellBindingSubject {
  readonly userId: string;
  readonly instanceId: string;
  readonly relayId: string;
  readonly agentScope: string;
}

/**
 * Plan-bound opaque binding metadata for a generic `run_shell` dispatch.
 *
 * Every field is either an opaque id the relay revalidates against its live
 * Electron state, or the classified operation. `serverBindingId` and
 * `toolCallId` are server-side correlation ids carried opaquely for audit /
 * log correlation; the relay cannot and does not revalidate them locally
 * (they are server-authoritative). The provable binding fields are
 * `relayId`, `desktopSessionId`, `capabilityRevision`, `profileId`,
 * `profileRevision`, `subject`, and `grantIds`.
 */
export interface RelayWorkstationShellBinding {
  readonly version: typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION;
  /** Server-side tool-call id this binding pins (audit / log correlation). */
  readonly toolCallId: string;
  /** Must match this relay's persisted id. */
  readonly relayId: string;
  /** Must match this relay's current per-launch desktop session id. */
  readonly desktopSessionId: string;
  /** Opaque server-side binding id (audit correlation; not relay-revalidated). */
  readonly serverBindingId: string;
  /**
   * D418 Commit 2 — the server-derived `pairingGeneration` the active Full
   * Workstation session was activated with (the validated relay-token row
   * id, never client-authored). The relay revalidates it against its live
   * pairing generation so a dispatch admitted under a prior generation
   * fails closed after a re-pair. Mandatory on the wire type; the strict
   * parser {@link parseRelayWorkstationShellBinding} requires it present +
   * non-blank.
   */
  readonly pairingGeneration: string;
  /** Must match the active profile's id. */
  readonly profileId: string;
  /** Must match the active profile's revision. */
  readonly profileRevision: number;
  /** Unique, non-empty opaque grant ids the session was activated with. */
  readonly grantIds: readonly string[];
  /** Monotonic capability revision at admission; must match the live revision. */
  readonly capabilityRevision: number;
  /**
   * D440 Phase 1 — exact Current Folder selected when the plan was admitted.
   * This is binding metadata, not authority: the desktop relay compares it
   * with its live Current Folder and independently reloads the durable grant.
   */
  readonly currentFolder: string;
  /** Durable grant-store revision at admission; must match the live store. */
  readonly grantRevision: number;
  /** Protected-path policy version at admission; must match the live profile. */
  readonly protectedPolicyVersion: number;
  readonly subject: RelayWorkstationShellBindingSubject;
  /** Concrete workstation operation (`"execute"` for `run_shell`). */
  readonly operation: DesktopFilesystemAccessOperation;
  /**
   * D418 Commit 3 — the execution class the admission reasons about
   * (`"profile_bound_sandbox"` for this envelope version). Replaces the old
   * six-value operation taxonomy; the concrete `operation` above stays
   * separate from this field.
   */
  readonly executionClass: typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;
}

export type RelayWorkstationShellBindingValidationResult =
  | { readonly ok: true; readonly binding: RelayWorkstationShellBinding }
  | { readonly ok: false; readonly error: string };

const WORKSTATION_SHELL_BINDING_KEYS = new Set([
  "version",
  "toolCallId",
  "relayId",
  "desktopSessionId",
  "serverBindingId",
  "pairingGeneration",
  "profileId",
  "profileRevision",
  "grantIds",
  "capabilityRevision",
  "currentFolder",
  "grantRevision",
  "protectedPolicyVersion",
  "subject",
  "operation",
  "executionClass",
]);
const WORKSTATION_SHELL_BINDING_SUBJECT_KEYS = new Set([
  "userId",
  "instanceId",
  "relayId",
  "agentScope",
]);

/**
 * Strict, fail-closed parser for the v2 plan-bound shell-binding envelope.
 * The relay calls this at its JSON ingress boundary before exposing the
 * binding to any dispatch handler. It admits ONLY the opaque binding fields
 * and rejects anything else — including roots, paths, filesystem identity,
 * platform authorization, environment values, or executable paths that must
 * never cross the wire. A missing envelope is handled by the caller as the
 * backward-compatible baseline-only (non-Full-Mode) path.
 */
export function parseRelayWorkstationShellBinding(
  value: unknown,
): RelayWorkstationShellBindingValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, WORKSTATION_SHELL_BINDING_KEYS)) {
    return { ok: false, error: "workstation shell binding must be a strict object" };
  }
  if (value.version !== RELAY_WORKSTATION_SHELL_BINDING_VERSION) {
    return { ok: false, error: "workstation shell binding has an unsupported version" };
  }
  if (
    !isNonBlankString(value.toolCallId) ||
    !isNonBlankString(value.relayId) ||
    !isNonBlankString(value.desktopSessionId) ||
    !isNonBlankString(value.serverBindingId) ||
    !isNonBlankString(value.pairingGeneration) ||
    !isNonBlankString(value.profileId)
  ) {
    return { ok: false, error: "workstation shell binding ids must be non-empty opaque strings" };
  }
  if (
    !Number.isSafeInteger(value.profileRevision) ||
    (value.profileRevision as number) < 1
  ) {
    return { ok: false, error: "workstation shell binding profileRevision must be a positive safe integer" };
  }
  if (
    !Array.isArray(value.grantIds) ||
    value.grantIds.length === 0 ||
    !value.grantIds.every(isNonBlankString) ||
    new Set(value.grantIds).size !== value.grantIds.length
  ) {
    return { ok: false, error: "workstation shell binding grantIds must be unique non-empty opaque ids" };
  }
  if (
    !Number.isSafeInteger(value.capabilityRevision) ||
    (value.capabilityRevision as number) < 0
  ) {
    return { ok: false, error: "workstation shell binding capabilityRevision must be a non-negative safe integer" };
  }
  if (
    !isNonBlankString(value["currentFolder"]) ||
    !path.isAbsolute(value["currentFolder"]) ||
    path.normalize(value["currentFolder"]) !== value["currentFolder"]
  ) {
    return { ok: false, error: "workstation shell binding currentFolder must be a normalized absolute path" };
  }
  if (
    !Number.isSafeInteger(value["grantRevision"]) ||
    (value["grantRevision"] as number) < 0
  ) {
    return { ok: false, error: "workstation shell binding grantRevision must be a non-negative safe integer" };
  }
  if (
    !Number.isSafeInteger(value["protectedPolicyVersion"]) ||
    (value["protectedPolicyVersion"] as number) < 1
  ) {
    return { ok: false, error: "workstation shell binding protectedPolicyVersion must be a positive safe integer" };
  }
  if (
    !isRecord(value.subject) ||
    !hasOnlyKeys(value.subject, WORKSTATION_SHELL_BINDING_SUBJECT_KEYS) ||
    !isNonBlankString(value.subject.userId) ||
    !isCanonicalNautiloInstanceId(value.subject.instanceId) ||
    !isNonBlankString(value.subject.relayId) ||
    !isNonBlankString(value.subject.agentScope)
  ) {
    return { ok: false, error: "workstation shell binding subject is invalid" };
  }
  if (
    typeof value.operation !== "string" ||
    !DESKTOP_FILESYSTEM_ACCESS_OPERATIONS.includes(value.operation as DesktopFilesystemAccessOperation)
  ) {
    return { ok: false, error: "workstation shell binding operation is unsupported" };
  }
  if (value.executionClass !== RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS) {
    return { ok: false, error: "workstation shell binding executionClass is unsupported" };
  }

  return {
    ok: true,
    binding: {
      version: RELAY_WORKSTATION_SHELL_BINDING_VERSION,
      toolCallId: value.toolCallId,
      relayId: value.relayId,
      desktopSessionId: value.desktopSessionId,
      serverBindingId: value.serverBindingId,
      pairingGeneration: value.pairingGeneration,
      profileId: value.profileId,
      profileRevision: value.profileRevision as number,
      grantIds: [...value.grantIds],
      capabilityRevision: value.capabilityRevision as number,
      currentFolder: value["currentFolder"],
      grantRevision: value["grantRevision"] as number,
      protectedPolicyVersion: value["protectedPolicyVersion"] as number,
      subject: {
        userId: value.subject.userId,
        instanceId: value.subject.instanceId,
        relayId: value.subject.relayId,
        agentScope: value.subject.agentScope,
      },
      operation: value.operation as DesktopFilesystemAccessOperation,
      executionClass: RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
    },
  };
}

// ── D500 — structured SSH dispatch binding ────────────────────────────────
//
// This envelope carries only the server-minted admission tuple needed for the
// desktop relay to select and revalidate an Electron-local SSH target grant.
// It intentionally contains no SSH hostname, account, fingerprint, identity
// handle, path, command, argv, environment, socket, root, or secret.

/** D500 V1 exposes fixed authentication, exec, and bounded SCP operations. */
export type RelaySshOperation = "auth" | "exec" | "copy-upload" | "copy-download";
export type RelaySshActorRole = "owner" | "admin";

/** Dynamic provenance authenticated by the relay/server transport. */
export interface RelaySshInvocationSubjectV1 {
  readonly userId: string;
  readonly actorId: string;
  readonly actorRole: RelaySshActorRole;
  readonly agentId: string;
  /** The admitted wire has exactly one eligible execution provenance. */
  readonly executionEntrypoint: "foreground.main";
  /** Canonical named instance, or the canonical empty default instance. */
  readonly instanceId: string;
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly desktopSessionId: string;
  readonly pairingGenerationRef: string;
  readonly capabilityRevision: number;
}

/** @deprecated Kept as an alias so callers name the dynamic-only subject. */
export type RelaySshDispatchBindingSubjectV1 = RelaySshInvocationSubjectV1;

/** Exact Human-visible destination facts resolved locally by Electron. */
export interface RelaySshApprovalSummaryV1 {
  /** The model/Human's approved input, retained to make alias expansion visible. */
  readonly requestedDestination: RelaySshDestinationIntentV1;
  /** The effective OpenSSH destination observed from the local config. */
  readonly host: string;
  readonly port: number;
  readonly remoteUser: string;
  readonly operation: RelaySshOperation;
  /** Exact key observed locally for this one-use Human approval. */
  readonly hostKeyFingerprint: string;
  /** A new pin, an existing pin, or an explicit replacement decision. */
  readonly hostTrust: "trusted" | "unknown" | "changed";
  /** Present only when the Human is replacing an existing exact pin. */
  readonly previousHostKeyFingerprint?: string | undefined;
}

/** Server → Electron request. It names approved intent but no local authority. */
export interface RelaySshPrepareRequestV1 {
  readonly version: typeof RELAY_SSH_PREPARE_VERSION;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly approvedRequestDigest: string;
  readonly operation: RelaySshOperation;
  /** Full canonical request Electron must reparse and digest-check before preparing. */
  readonly approvedRequest: RelaySshApprovedRequestV1;
  readonly subject: RelaySshInvocationSubjectV1;
}

/** Electron → server secret-free selection result. */
export interface RelaySshPrepareResponseV1 {
  readonly version: typeof RELAY_SSH_PREPARE_VERSION;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly approvedRequestDigest: string;
  readonly operation: RelaySshOperation;
  readonly subject: RelaySshInvocationSubjectV1;
  readonly preparationId: string;
  readonly approval: RelaySshApprovalSummaryV1;
}

export interface RelaySshDispatchBindingV1 {
  readonly version: typeof RELAY_SSH_DISPATCH_BINDING_VERSION;
  readonly admissionId: string;
  readonly toolCallId: string;
  /** Canonical lowercase SHA-256 digest of the exact approved request. */
  readonly approvedRequestDigest: string;
  readonly operation: RelaySshOperation;
  /** One-use opaque Electron-local handle issued by the prepare step. */
  readonly preparationId: string;
  readonly subject: RelaySshInvocationSubjectV1;
}

export type RelaySshDispatchBindingValidationResult =
  | { readonly ok: true; readonly binding: RelaySshDispatchBindingV1 }
  | { readonly ok: false; readonly error: string };

const SSH_DISPATCH_BINDING_KEYS = new Set([
  "version",
  "admissionId",
  "toolCallId",
  "approvedRequestDigest",
  "operation",
  "preparationId",
  "subject",
]);
const SSH_DISPATCH_BINDING_SUBJECT_KEYS = new Set([
  "userId",
  "actorId",
  "actorRole",
  "agentId",
  "executionEntrypoint",
  "instanceId",
  "relayId",
  "relaySessionId",
  "desktopSessionId",
  "pairingGenerationRef",
  "capabilityRevision",
]);
const SSH_DISPATCH_OPERATIONS = new Set<RelaySshOperation>([
  "auth",
  "exec",
  "copy-upload",
  "copy-download",
]);
const SSH_DISPATCH_ACTOR_ROLES = new Set<RelaySshActorRole>(["owner", "admin"]);
const SSH_DISPATCH_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,255}$/;
const SSH_DISPATCH_REQUEST_DIGEST = /^[a-f0-9]{64}$/;
const SSH_DISPATCH_MAX_REVISION = 2 ** 31 - 1;

function isSshDispatchOpaqueId(value: unknown): value is string {
  return typeof value === "string" && SSH_DISPATCH_OPAQUE_ID.test(value);
}

function isSshDispatchRevision(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= SSH_DISPATCH_MAX_REVISION
  );
}

function parseRelaySshInvocationSubject(value: unknown): RelaySshInvocationSubjectV1 | null {
  if (!isRecord(value) || !hasOnlyKeys(value, SSH_DISPATCH_BINDING_SUBJECT_KEYS)) return null;
  if (
    !isSshDispatchOpaqueId(value.userId) ||
    !isSshDispatchOpaqueId(value["actorId"]) ||
    !isSshDispatchOpaqueId(value["agentId"]) ||
    !isSshDispatchOpaqueId(value.relayId) ||
    !isSshDispatchOpaqueId(value["relaySessionId"]) ||
    !isSshDispatchOpaqueId(value.desktopSessionId) ||
    !isSshDispatchOpaqueId(value["pairingGenerationRef"]) ||
    typeof value["actorRole"] !== "string" ||
    !SSH_DISPATCH_ACTOR_ROLES.has(value["actorRole"] as RelaySshActorRole) ||
    value["executionEntrypoint"] !== "foreground.main" ||
    !isCanonicalNautiloInstanceId(value.instanceId) ||
    !isSshDispatchRevision(value.capabilityRevision)
  ) return null;
  return {
    userId: value.userId,
    actorId: value["actorId"],
    actorRole: value["actorRole"] as RelaySshActorRole,
    agentId: value["agentId"],
    executionEntrypoint: "foreground.main",
    instanceId: value.instanceId,
    relayId: value.relayId,
    relaySessionId: value["relaySessionId"],
    desktopSessionId: value.desktopSessionId,
    pairingGenerationRef: value["pairingGenerationRef"],
    capabilityRevision: value.capabilityRevision,
  };
}

const SSH_APPROVAL_SUMMARY_KEYS = new Set([
  "requestedDestination", "host", "port", "remoteUser", "operation", "hostKeyFingerprint", "hostTrust", "previousHostKeyFingerprint",
]);

function parseRelaySshApprovalSummary(value: unknown): RelaySshApprovalSummaryV1 | null {
  if (!isRecord(value)) return null;
  const expectedKeys = value["hostTrust"] === "changed"
    ? SSH_APPROVAL_SUMMARY_KEYS
    : new Set(["requestedDestination", "host", "port", "remoteUser", "operation", "hostKeyFingerprint", "hostTrust"]);
  if (!hasOnlyKeys(value, expectedKeys)) return null;
  const requestedDestination = value["requestedDestination"];
  if (
    !isSshApprovedDestination(requestedDestination) ||
    typeof value["host"] !== "string" || value["host"].length === 0 || value["host"].length > 253 ||
    !Number.isSafeInteger(value["port"]) || (value["port"] as number) < 1 || (value["port"] as number) > 65_535 ||
    typeof value["remoteUser"] !== "string" || value["remoteUser"].length === 0 || value["remoteUser"].length > 64 ||
    typeof value["hostKeyFingerprint"] !== "string" || !/^SHA256:[A-Za-z0-9+/]{20,86}$/.test(value["hostKeyFingerprint"]) ||
    typeof value.operation !== "string" || !SSH_DISPATCH_OPERATIONS.has(value.operation as RelaySshOperation) ||
    (value["hostTrust"] !== "trusted" && value["hostTrust"] !== "unknown" && value["hostTrust"] !== "changed") ||
    (value["hostTrust"] === "changed" && (typeof value["previousHostKeyFingerprint"] !== "string" || !/^SHA256:[A-Za-z0-9+/]{20,86}$/.test(value["previousHostKeyFingerprint"]) || value["previousHostKeyFingerprint"] === value["hostKeyFingerprint"]))
  ) return null;
  const hostTrust = value["hostTrust"];
  const previousHostKeyFingerprint = value["previousHostKeyFingerprint"] as string | undefined;
  return {
    requestedDestination,
    host: value["host"],
    port: value["port"] as number,
    remoteUser: value["remoteUser"],
    operation: value.operation as RelaySshOperation,
    hostKeyFingerprint: value["hostKeyFingerprint"],
    hostTrust,
    ...(hostTrust === "changed" ? { previousHostKeyFingerprint: previousHostKeyFingerprint! } : {}),
  };
}

/**
 * Strict, fail-closed parser for D500's structured SSH v1 binding. The
 * returned object is rebuilt from validated fields so raw JSON never crosses
 * the relay's dispatch boundary. A missing binding remains the additive,
 * backward-compatible ordinary dispatch path.
 */
export function parseRelaySshDispatchBinding(
  value: unknown,
): RelaySshDispatchBindingValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, SSH_DISPATCH_BINDING_KEYS)) {
    return { ok: false, error: "structured SSH binding must be a strict object" };
  }
  if (value.version !== RELAY_SSH_DISPATCH_BINDING_VERSION) {
    return { ok: false, error: "structured SSH binding has an unsupported version" };
  }
  if (
    !isSshDispatchOpaqueId(value["admissionId"]) ||
    !isSshDispatchOpaqueId(value.toolCallId) ||
    !isSshDispatchOpaqueId(value["preparationId"]) ||
    typeof value["approvedRequestDigest"] !== "string" ||
    !SSH_DISPATCH_REQUEST_DIGEST.test(value["approvedRequestDigest"])
  ) {
    return { ok: false, error: "structured SSH binding identifiers or digest are invalid" };
  }
  if (
    typeof value.operation !== "string" ||
    !SSH_DISPATCH_OPERATIONS.has(value.operation as RelaySshOperation)
  ) {
    return { ok: false, error: "structured SSH binding operation is invalid" };
  }
  const subject = parseRelaySshInvocationSubject(value.subject);
  if (subject === null) {
    return { ok: false, error: "structured SSH binding subject is invalid" };
  }

  return {
    ok: true,
    binding: {
      version: RELAY_SSH_DISPATCH_BINDING_VERSION,
      admissionId: value["admissionId"],
      toolCallId: value.toolCallId,
      approvedRequestDigest: value["approvedRequestDigest"],
      operation: value.operation as RelaySshOperation,
      preparationId: value["preparationId"],
      subject,
    },
  };
}

const SSH_PREPARE_REQUEST_KEYS = new Set([
  "version", "requestId", "toolCallId", "approvedRequestDigest", "operation", "approvedRequest", "subject",
]);
const SSH_PREPARE_RESPONSE_KEYS = new Set([
  "version", "requestId", "toolCallId", "approvedRequestDigest", "operation", "subject",
  "preparationId", "approval",
]);

export type RelaySshPrepareRequestValidationResult =
  | { readonly ok: true; readonly request: RelaySshPrepareRequestV1 }
  | { readonly ok: false; readonly error: string };
export type RelaySshPrepareResponseValidationResult =
  | { readonly ok: true; readonly response: RelaySshPrepareResponseV1 }
  | { readonly ok: false; readonly error: string };

export function parseRelaySshPrepareRequest(value: unknown): RelaySshPrepareRequestValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, SSH_PREPARE_REQUEST_KEYS) || value.version !== RELAY_SSH_PREPARE_VERSION || !isSshDispatchOpaqueId(value["requestId"]) || !isSshDispatchOpaqueId(value["toolCallId"]) || typeof value["approvedRequestDigest"] !== "string" || !SSH_DISPATCH_REQUEST_DIGEST.test(value["approvedRequestDigest"]) || typeof value.operation !== "string" || !SSH_DISPATCH_OPERATIONS.has(value.operation as RelaySshOperation)) return { ok: false, error: "structured SSH prepare request is invalid" };
  const subject = parseRelaySshInvocationSubject(value.subject);
  const approved = parseRelaySshApprovedRequestV1(value["approvedRequest"]);
  if (subject === null || !approved.ok) return { ok: false, error: "structured SSH prepare request is invalid" };
  const operation = approved.request.toolName === "structured_ssh_auth"
    ? "auth"
    : approved.request.toolName === "structured_ssh_exec"
      ? "exec"
      : approved.request.toolName === "structured_ssh_copy_upload"
        ? "copy-upload"
        : "copy-download";
  if (
    approved.request.toolCallId !== value["toolCallId"] ||
    operation !== value.operation ||
    computeRelaySshApprovedRequestDigestV1(approved.request) !== value["approvedRequestDigest"]
  ) return { ok: false, error: "structured SSH prepare request binding is invalid" };
  return { ok: true, request: { version: RELAY_SSH_PREPARE_VERSION, requestId: value["requestId"], toolCallId: value["toolCallId"], approvedRequestDigest: value["approvedRequestDigest"], operation, approvedRequest: approved.request, subject } };
}

export function parseRelaySshPrepareResponse(value: unknown): RelaySshPrepareResponseValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, SSH_PREPARE_RESPONSE_KEYS) || value.version !== RELAY_SSH_PREPARE_VERSION || !isSshDispatchOpaqueId(value["requestId"]) || !isSshDispatchOpaqueId(value["toolCallId"]) || typeof value["approvedRequestDigest"] !== "string" || !SSH_DISPATCH_REQUEST_DIGEST.test(value["approvedRequestDigest"]) || typeof value.operation !== "string" || !SSH_DISPATCH_OPERATIONS.has(value.operation as RelaySshOperation) || !isSshDispatchOpaqueId(value["preparationId"])) return { ok: false, error: "structured SSH prepare response is invalid" };
  const subject = parseRelaySshInvocationSubject(value.subject);
  const approval = parseRelaySshApprovalSummary(value["approval"]);
  if (subject === null || approval === null || approval.operation !== value.operation) return { ok: false, error: "structured SSH prepare response binding is invalid" };
  return { ok: true, response: { version: RELAY_SSH_PREPARE_VERSION, requestId: value["requestId"], toolCallId: value["toolCallId"], approvedRequestDigest: value["approvedRequestDigest"], operation: value.operation, subject, preparationId: value["preparationId"], approval } };
}

/** Strict ingress parser for Electron's correlated preparation result. */
export function isRelaySshPreparedMessage(value: unknown): value is RelaySshPreparedMessage {
  if (!isRecord(value) || value["type"] !== "relay:ssh-prepared" || !isSshDispatchOpaqueId(value["requestId"])) return false;
  if (value.status === "ok") {
    if (!hasOnlyKeys(value, new Set(["type", "requestId", "status", "response"]))) return false;
    const parsed = parseRelaySshPrepareResponse(value["response"]);
    return parsed.ok && parsed.response.requestId === value["requestId"];
  }
  const failureCodes = new Set<RelaySshPrepareFailureCode>([
    "invalid_request", "prepare_unavailable", "capability_unavailable", "capability_disabled", "tool_disabled", "destination_unavailable",
    "connection_not_found", "connection_ambiguous", "remote_user_missing", "invalid_destination", "invalid_host",
    "invalid_remote_user", "invalid_port", "connection_catalog_malformed", "connection_catalog_unreadable",
    "connection_catalog_overflow", "connection_catalog_unavailable", "openssh_connection_catalog_unreadable",
    "openssh_connection_catalog_malformed", "openssh_connection_catalog_overflow", "openssh_connection_catalog_unsupported_match",
    "openssh_connection_catalog_unsupported_source", "resolve_aborted", "resolve_spawn_failed", "resolve_timed_out",
    "resolve_output_limited", "resolve_failed", "config_output_invalid", "config_required_value_missing", "config_value_invalid",
    "config_unsafe_directive", "config_destination_mismatch", "connection_source_drift", "trust_store_unavailable",
    "trust_store_corrupt", "trust_store_instance_mismatch", "scan_invalid_request", "scan_failed", "scan_timed_out",
    "scan_aborted", "scan_output_limited", "scanner_output_invalid", "host_key_missing", "host_key_changed",
    "host_key_ambiguous", "lookup_invalid_request", "observer_unavailable", "lookup_failed", "lookup_timed_out",
    "lookup_aborted", "lookup_output_limited", "lookup_output_invalid", "trust_unavailable", "topology_mismatch", "preparation_unavailable",
  ]);
  if (!isRecord(value) || value.status !== "error" || typeof value["errorCode"] !== "string" || !failureCodes.has(value["errorCode"] as RelaySshPrepareFailureCode)) return false;
  const resolutionCode = isRelaySshResolutionFailureCode(value["errorCode"]);
  if (!hasOnlyKeys(value, new Set(resolutionCode ? ["type", "requestId", "status", "errorCode", "failure"] : ["type", "requestId", "status", "errorCode"]))) return false;
  return !resolutionCode || parseRelaySshResolutionFailure(value["failure"], value["errorCode"] as RelaySshResolutionFailure["code"]) !== null;
}

function isRelaySshResolutionFailureCode(value: unknown): value is RelaySshResolutionFailure["code"] {
  return typeof value === "string" && !new Set<RelaySshPrepareFailureCode>([
    "invalid_request", "prepare_unavailable", "capability_unavailable", "capability_disabled", "tool_disabled", "destination_unavailable",
    "trust_unavailable", "topology_mismatch", "preparation_unavailable",
  ]).has(value as RelaySshPrepareFailureCode);
}

function hasMatchingRelaySshPreparationFailurePhase(
  code: RelaySshResolutionFailure["code"],
  phase: unknown,
): boolean {
  const trustStoreCode = code === "trust_store_unavailable" || code === "trust_store_corrupt" || code === "trust_store_instance_mismatch";
  const scanCode = [
    "scan_invalid_request", "scan_failed", "scan_timed_out", "scan_aborted", "scan_output_limited",
    "scanner_output_invalid", "host_key_missing", "host_key_changed", "host_key_ambiguous",
  ].includes(code);
  const knownHostsCode = [
    "lookup_invalid_request", "observer_unavailable", "lookup_failed", "lookup_timed_out", "lookup_aborted",
    "lookup_output_limited", "lookup_output_invalid",
  ].includes(code);
  if (phase === "trust_store_lookup") return trustStoreCode;
  if (phase === "host_key_scan") return scanCode;
  if (phase === "known_hosts_lookup") return knownHostsCode;
  return !trustStoreCode && !scanCode && !knownHostsCode;
}

/** Strictly rebuild the secret-free failure facts accepted from Electron. */
export function parseRelaySshResolutionFailure(
  value: unknown,
  expectedCode?: RelaySshResolutionFailure["code"],
): RelaySshResolutionFailure | null {
  if (!isRecord(value)) return null;
  const code = value["code"];
  const phase = value["phase"];
  const hasCatalogFacts = value["source"] !== undefined || value["observed"] !== undefined || value["configuredBounds"] !== undefined || value["completeness"] !== undefined || value["candidates"] !== undefined;
  const expected = new Set(["code", "phase", "retrySafe", "sideEffectStarted", "stateChanged", "recovery", ...(hasCatalogFacts ? ["source", "observed", "configuredBounds", "completeness", "candidates"] : [])].filter((key) => value[key] !== undefined || ["code", "phase", "retrySafe", "sideEffectStarted", "stateChanged", "recovery"].includes(key)));
  if (!hasOnlyKeys(value, expected) || !isRelaySshResolutionFailureCode(code) || (expectedCode !== undefined && code !== expectedCode) ||
    (phase !== "intent" && phase !== "resolve" && phase !== "parse" && phase !== "policy" && phase !== "catalog" &&
      phase !== "trust_store_lookup" && phase !== "host_key_scan" && phase !== "known_hosts_lookup" && phase !== "dispatch_reresolve") ||
    !hasMatchingRelaySshPreparationFailurePhase(code, phase) ||
    value["retrySafe"] !== true || value["sideEffectStarted"] !== false || value["stateChanged"] !== false ||
    !["correct_destination", "provide_remote_user", "choose_connection", "repair_connection_source", "reduce_connection_catalog", "retry"].includes(value["recovery"] as string)) return null;
  if (!hasCatalogFacts) return { code, phase, retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: value["recovery"] as RelaySshResolutionRecovery };
  if ((value["source"] !== "openssh" && value["source"] !== "nautilo-profile") || value["completeness"] !== false || !isRecord(value["observed"])) return null;
  const observed = value["observed"];
  if (!["files", "records", "bytes"].every((key) => Number.isSafeInteger(observed[key]) && (observed[key] as number) >= 0) || !hasOnlyKeys(observed, new Set(["files", "records", "bytes"]))) return null;
  const bounds = value["configuredBounds"];
  if (bounds !== undefined && (!isRecord(bounds) || !hasOnlyKeys(bounds, new Set(["files", "records", "bytes", "includeDepth"])) || !Object.values(bounds).every((bound) => Number.isSafeInteger(bound) && (bound as number) > 0))) return null;
  const candidates = value["candidates"];
  if (candidates !== undefined && (!Array.isArray(candidates) || candidates.length > 16 || !candidates.every((candidate) => isRecord(candidate) && hasOnlyKeys(candidate, new Set(["source", "name"])) && (candidate["source"] === "openssh" || candidate["source"] === "nautilo-profile") && typeof candidate["name"] === "string" && candidate["name"].length > 0 && candidate["name"].length <= 253))) return null;
  const safeCandidates = candidates === undefined
    ? undefined
    : (candidates as Record<string, unknown>[]).map((candidate) => ({ source: candidate["source"] as "openssh" | "nautilo-profile", name: candidate["name"] as string }));
  return {
    code, phase, retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: value["recovery"] as RelaySshResolutionRecovery,
    source: value["source"], observed: { files: observed["files"] as number, records: observed["records"] as number, bytes: observed["bytes"] as number },
    ...(bounds === undefined ? {} : { configuredBounds: bounds as RelaySshResolutionFailure["configuredBounds"] }),
    completeness: false,
    ...(safeCandidates === undefined ? {} : { candidates: safeCandidates }),
  };
}

// ── D500 — canonical approved structured SSH request ──────────────────────
//
// The server mints a binding over the digest of this rebuilt request. Keeping
// the request grammar here gives both server and Electron exactly the same
// byte sequence to approve and verify. This grammar intentionally preserves
// argv elements as supplied; the broker owns the later POSIX quoting and its
// separate 4 KiB encoded-command limit.

export const RELAY_SSH_APPROVED_REQUEST_VERSION = 3 as const;
/** Bounds the wire payload only; it does not prove a later quoted command fits 4 KiB. */
export const RELAY_SSH_APPROVED_REQUEST_MAX_BYTES = 64 * 1024;
export const RELAY_SSH_APPROVED_REQUEST_MAX_ARGV_ENTRIES = 32;
export const RELAY_SSH_APPROVED_REQUEST_MAX_ARG_BYTES = 1024;
export const RELAY_SSH_APPROVED_REQUEST_MAX_PROGRAM_BYTES = 256;
/** Model-supplied destinations are exact intent, never Electron grant authority. */
const RELAY_SSH_APPROVED_REQUEST_MAX_HOST_BYTES = 253;
const RELAY_SSH_APPROVED_REQUEST_MAX_REMOTE_USER_BYTES = 64;
/** Paths are model intent, never local authority; Electron resolves them locally. */
export const RELAY_SSH_APPROVED_REQUEST_MAX_COPY_PATH_BYTES = 4096;
export const RELAY_SSH_DEFAULT_TIMEOUT_SECONDS = 5 * 60;
export const RELAY_SSH_SOFT_TIMEOUT_SECONDS = 30 * 60;
export const RELAY_SSH_HARD_TIMEOUT_SECONDS = 4 * 60 * 60;
export const RELAY_SSH_TIMEOUT_REASON_MIN_BYTES = 12;
export const RELAY_SSH_TIMEOUT_REASON_MAX_BYTES = 512;

/** A named authoritative connection. It cannot carry endpoint overrides. */
export interface RelaySshNamedDestinationIntentV1 {
  readonly connection: string;
  /** Compatibility properties for relay orchestration that is updated separately. */
  readonly host?: undefined;
  readonly user?: undefined;
  readonly port?: undefined;
}

/** An exact ad hoc endpoint. A remote user is mandatory on the public wire. */
export interface RelaySshAdHocDestinationIntentV1 {
  readonly host: string;
  readonly user: string;
  readonly port?: number | undefined;
  readonly connection?: undefined;
}

/** Strict model/wire destination intent; variants retain distinct canonical JSON. */
export type RelaySshDestinationIntentV1 =
  | RelaySshNamedDestinationIntentV1
  | RelaySshAdHocDestinationIntentV1;

export interface RelaySshApprovedAuthRequestV1 {
  readonly version: typeof RELAY_SSH_APPROVED_REQUEST_VERSION;
  readonly toolCallId: string;
  readonly toolName: "structured_ssh_auth";
  readonly args: {
    readonly destination: RelaySshDestinationIntentV1;
  };
}

export interface RelaySshApprovedExecRequestV1 {
  readonly version: typeof RELAY_SSH_APPROVED_REQUEST_VERSION;
  readonly toolCallId: string;
  readonly toolName: "structured_ssh_exec";
  readonly args: {
    readonly destination: RelaySshDestinationIntentV1;
    readonly program: string;
    readonly argv: readonly string[];
    readonly timeoutSeconds: number;
    readonly timeoutReason?: string | undefined;
  };
}

/** Upload from one Electron-confined local path to one literal remote path. */
export interface RelaySshApprovedCopyUploadRequestV1 {
  readonly version: typeof RELAY_SSH_APPROVED_REQUEST_VERSION;
  readonly toolCallId: string;
  readonly toolName: "structured_ssh_copy_upload";
  readonly args: {
    readonly destination: RelaySshDestinationIntentV1;
    readonly localPath: string;
    readonly remotePath: string;
    readonly timeoutSeconds: number;
    readonly timeoutReason?: string | undefined;
  };
}

/** Download from one literal remote path to one Electron-confined local path. */
export interface RelaySshApprovedCopyDownloadRequestV1 {
  readonly version: typeof RELAY_SSH_APPROVED_REQUEST_VERSION;
  readonly toolCallId: string;
  readonly toolName: "structured_ssh_copy_download";
  readonly args: {
    readonly destination: RelaySshDestinationIntentV1;
    readonly remotePath: string;
    readonly localPath: string;
    readonly timeoutSeconds: number;
    readonly timeoutReason?: string | undefined;
  };
}

export type RelaySshApprovedRequestV1 =
  | RelaySshApprovedAuthRequestV1
  | RelaySshApprovedExecRequestV1
  | RelaySshApprovedCopyUploadRequestV1
  | RelaySshApprovedCopyDownloadRequestV1;

export type RelaySshApprovedRequestValidationResult =
  | { readonly ok: true; readonly request: RelaySshApprovedRequestV1 }
  | { readonly ok: false; readonly error: string };

const SSH_APPROVED_REQUEST_KEYS = new Set(["version", "toolCallId", "toolName", "args"]);
const SSH_APPROVED_AUTH_ARGS_KEYS = new Set(["destination"]);
const SSH_APPROVED_EXEC_ARGS_KEYS = new Set(["destination", "program", "argv", "timeoutSeconds", "timeoutReason"]);
const SSH_APPROVED_COPY_ARGS_KEYS = new Set(["destination", "localPath", "remotePath", "timeoutSeconds", "timeoutReason"]);
const SSH_APPROVED_NAMED_DESTINATION_KEYS = new Set(["connection"]);
const SSH_APPROVED_AD_HOC_DESTINATION_KEYS = new Set(["host", "user", "port"]);
// eslint-disable-next-line no-control-regex -- strict program grammar rejects C0/C1 controls.
const SSH_APPROVED_REQUEST_PROGRAM_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- POSIX argv may contain line breaks; only NUL is impossible.
const SSH_APPROVED_REQUEST_ARG_FORBIDDEN = /\u0000/u;
// eslint-disable-next-line no-control-regex -- destinations and local paths remain single-line identifiers.
const SSH_APPROVED_REQUEST_TEXT_FORBIDDEN = /[\u0000\r\n]/u;
// Remote SCP paths are intentionally a narrow literal data grammar.  It is
// safe on current SFTP-default OpenSSH and remains non-interpretable if an
// older client ever selects the legacy protocol.
const SSH_APPROVED_REMOTE_COPY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function hasUtf8LengthAtMost(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximum;
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isSshApprovedProgram(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.charAt(0) !== "-" &&
    hasUtf8LengthAtMost(value, RELAY_SSH_APPROVED_REQUEST_MAX_PROGRAM_BYTES) &&
    !hasUnpairedUtf16Surrogate(value) &&
    !SSH_APPROVED_REQUEST_PROGRAM_CONTROLS.test(value)
  );
}

function isSshApprovedArg(value: unknown): value is string {
  return (
    typeof value === "string" &&
    hasUtf8LengthAtMost(value, RELAY_SSH_APPROVED_REQUEST_MAX_ARG_BYTES) &&
    !hasUnpairedUtf16Surrogate(value) &&
    !SSH_APPROVED_REQUEST_ARG_FORBIDDEN.test(value)
  );
}

function isSshApprovedDestination(value: unknown): value is RelaySshDestinationIntentV1 {
  if (!isRecord(value)) return false;
  if (hasOnlyKeys(value, SSH_APPROVED_NAMED_DESTINATION_KEYS)) {
    const connection = value["connection"];
    return typeof connection === "string" &&
      connection.length > 0 &&
      !connection.startsWith("-") &&
      hasUtf8LengthAtMost(connection, RELAY_SSH_APPROVED_REQUEST_MAX_HOST_BYTES) &&
      !hasUnpairedUtf16Surrogate(connection) &&
      !SSH_APPROVED_REQUEST_TEXT_FORBIDDEN.test(connection) &&
      (isIP(connection) !== 0 || /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(connection));
  }
  if (!hasOnlyKeys(value, SSH_APPROVED_AD_HOC_DESTINATION_KEYS)) return false;
  const host = value["host"];
  const user = value["user"];
  const port = value["port"];
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    !hasUtf8LengthAtMost(host, RELAY_SSH_APPROVED_REQUEST_MAX_HOST_BYTES) ||
    hasUnpairedUtf16Surrogate(host) ||
    SSH_APPROVED_REQUEST_TEXT_FORBIDDEN.test(host) ||
    !(isIP(host) !== 0 || /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(host))
  ) return false;
  if (
    typeof user !== "string" ||
      user.length === 0 ||
      !hasUtf8LengthAtMost(user, RELAY_SSH_APPROVED_REQUEST_MAX_REMOTE_USER_BYTES) ||
      hasUnpairedUtf16Surrogate(user) ||
      !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(user)
  ) return false;
  return port === undefined ||
    (typeof port === "number" && Number.isSafeInteger(port) && port >= 1 && port <= 65_535);
}

function isSshApprovedLocalCopyPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    !hasUtf8LengthAtMost(value, RELAY_SSH_APPROVED_REQUEST_MAX_COPY_PATH_BYTES) ||
    hasUnpairedUtf16Surrogate(value) ||
    SSH_APPROVED_REQUEST_TEXT_FORBIDDEN.test(value)
  ) return false;
  return value.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("-"),
  );
}

function isSshApprovedRemoteCopyPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || !hasUtf8LengthAtMost(value, RELAY_SSH_APPROVED_REQUEST_MAX_COPY_PATH_BYTES) || !/^[A-Za-z0-9/._-]+$/u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment, index) =>
    (index === 0 && segment === "") || (segment !== "." && segment !== ".." && SSH_APPROVED_REMOTE_COPY_SEGMENT.test(segment)),
  );
}

function isSshApprovedTimeout(
  timeoutSeconds: unknown,
  timeoutReason: unknown,
): timeoutReason is string | undefined {
  if (!Number.isSafeInteger(timeoutSeconds) || (timeoutSeconds as number) < 1 ||
    (timeoutSeconds as number) > RELAY_SSH_HARD_TIMEOUT_SECONDS) return false;
  if ((timeoutSeconds as number) <= RELAY_SSH_SOFT_TIMEOUT_SECONDS) {
    return timeoutReason === undefined;
  }
  return typeof timeoutReason === "string" &&
    Buffer.byteLength(timeoutReason.trim(), "utf8") >= RELAY_SSH_TIMEOUT_REASON_MIN_BYTES &&
    Buffer.byteLength(timeoutReason, "utf8") <= RELAY_SSH_TIMEOUT_REASON_MAX_BYTES &&
    !SSH_APPROVED_REQUEST_TEXT_FORBIDDEN.test(timeoutReason);
}

function sshApprovedOperationKeys(
  base: ReadonlySet<string>,
  timeoutReason: unknown,
): Set<string> {
  return new Set([...base].filter((key) => key !== "timeoutReason" || timeoutReason !== undefined));
}

/**
 * Serialize a parsed/rebuilt request in the sole D500 v1 order.
 * JSON.stringify intentionally preserves string code units without Unicode
 * normalization, so both peers hash the same UTF-8 bytes.
 */
function serializeRelaySshApprovedRequestV1(request: RelaySshApprovedRequestV1): string {
  const destination = (value: RelaySshDestinationIntentV1) => "connection" in value
    ? { connection: value.connection }
    : { host: value.host, user: value.user, ...(value.port === undefined ? {} : { port: value.port }) };
  const canonical = request.toolName === "structured_ssh_auth"
    ? {
        version: RELAY_SSH_APPROVED_REQUEST_VERSION,
        toolCallId: request.toolCallId,
        toolName: "structured_ssh_auth" as const,
        args: { destination: destination(request.args.destination) },
      }
    : request.toolName === "structured_ssh_exec"
      ? {
        version: RELAY_SSH_APPROVED_REQUEST_VERSION,
        toolCallId: request.toolCallId,
        toolName: "structured_ssh_exec" as const,
        args: {
          destination: destination(request.args.destination),
          program: request.args.program,
          argv: [...request.args.argv],
          timeoutSeconds: request.args.timeoutSeconds,
          ...(request.args.timeoutReason === undefined ? {} : { timeoutReason: request.args.timeoutReason }),
        },
      }
      : request.toolName === "structured_ssh_copy_upload"
        ? {
            version: RELAY_SSH_APPROVED_REQUEST_VERSION,
            toolCallId: request.toolCallId,
            toolName: "structured_ssh_copy_upload" as const,
            args: {
              destination: destination(request.args.destination),
              localPath: request.args.localPath,
              remotePath: request.args.remotePath,
              timeoutSeconds: request.args.timeoutSeconds,
              ...(request.args.timeoutReason === undefined ? {} : { timeoutReason: request.args.timeoutReason }),
            },
          }
        : {
            version: RELAY_SSH_APPROVED_REQUEST_VERSION,
            toolCallId: request.toolCallId,
            toolName: "structured_ssh_copy_download" as const,
            args: {
              destination: destination(request.args.destination),
              remotePath: request.args.remotePath,
              localPath: request.args.localPath,
              timeoutSeconds: request.args.timeoutSeconds,
              ...(request.args.timeoutReason === undefined ? {} : { timeoutReason: request.args.timeoutReason }),
            },
          };
  const json = JSON.stringify(canonical);
  if (typeof json !== "string") {
    throw new Error("structured SSH approved request could not be serialized");
  }
  return json;
}

/**
 * Strictly reparse an untrusted runtime value before serializing it. This
 * public boundary must not turn a cast, omitted field, or unknown tool into a
 * different approved operation.
 */
export function canonicalRelaySshApprovedRequestJsonV1(value: unknown): string {
  const parsed = parseRelaySshApprovedRequestV1(value);
  if (!parsed.ok) throw new Error("invalid structured SSH approved request");
  return serializeRelaySshApprovedRequestV1(parsed.request);
}

export function computeRelaySshApprovedRequestDigestV1(value: unknown): string {
  return createHash("sha256")
    .update(canonicalRelaySshApprovedRequestJsonV1(value), "utf8")
    .digest("hex");
}

/**
 * Strictly parse and rebuild one of the two D500 model-visible SSH requests.
 * The returned object, never the raw wire value, is the only input accepted by
 * canonicalization and digest binding.
 */
export function parseRelaySshApprovedRequestV1(
  value: unknown,
): RelaySshApprovedRequestValidationResult {
  if (!isRecord(value) || !hasExactKeys(value, SSH_APPROVED_REQUEST_KEYS)) {
    return { ok: false, error: "structured SSH approved request must be a strict object" };
  }
  const toolCallId = value["toolCallId"];
  const toolName = value["toolName"];
  const args = value["args"];
  if (
    value.version !== RELAY_SSH_APPROVED_REQUEST_VERSION ||
    !isSshDispatchOpaqueId(toolCallId) ||
    typeof toolName !== "string" ||
    !isRecord(args)
  ) {
    return { ok: false, error: "structured SSH approved request metadata is invalid" };
  }

  let request: RelaySshApprovedRequestV1;
  if (toolName === "structured_ssh_auth") {
    if (
      !hasExactKeys(args, SSH_APPROVED_AUTH_ARGS_KEYS) ||
      !isSshApprovedDestination(args["destination"])
    ) {
      return { ok: false, error: "structured SSH auth request arguments are invalid" };
    }
    request = {
      version: RELAY_SSH_APPROVED_REQUEST_VERSION,
      toolCallId,
      toolName: "structured_ssh_auth",
      args: { destination: args["destination"] },
    };
  } else if (toolName === "structured_ssh_exec") {
    if (
      !hasExactKeys(args, sshApprovedOperationKeys(SSH_APPROVED_EXEC_ARGS_KEYS, args["timeoutReason"])) ||
      !isSshApprovedDestination(args["destination"]) ||
      !isSshApprovedProgram(args["program"]) ||
      !Array.isArray(args["argv"]) ||
      args["argv"].length > RELAY_SSH_APPROVED_REQUEST_MAX_ARGV_ENTRIES ||
      !args["argv"].every(isSshApprovedArg) ||
      !isSshApprovedTimeout(args["timeoutSeconds"], args["timeoutReason"])
    ) {
      return { ok: false, error: "structured SSH exec request arguments are invalid" };
    }
    request = {
      version: RELAY_SSH_APPROVED_REQUEST_VERSION,
      toolCallId,
      toolName: "structured_ssh_exec",
      args: {
        destination: args["destination"],
        program: args["program"],
        argv: [...args["argv"]],
        timeoutSeconds: args["timeoutSeconds"] as number,
        ...(args["timeoutReason"] === undefined ? {} : { timeoutReason: args["timeoutReason"] }),
      },
    };
  } else if (toolName === "structured_ssh_copy_upload" || toolName === "structured_ssh_copy_download") {
    if (
      !hasExactKeys(args, sshApprovedOperationKeys(SSH_APPROVED_COPY_ARGS_KEYS, args["timeoutReason"])) ||
      !isSshApprovedDestination(args["destination"]) ||
      !isSshApprovedLocalCopyPath(args["localPath"]) ||
      !isSshApprovedRemoteCopyPath(args["remotePath"]) ||
      !isSshApprovedTimeout(args["timeoutSeconds"], args["timeoutReason"])
    ) {
      return { ok: false, error: "structured SSH copy request arguments are invalid" };
    }
    request = toolName === "structured_ssh_copy_upload"
      ? {
          version: RELAY_SSH_APPROVED_REQUEST_VERSION,
          toolCallId,
          toolName: "structured_ssh_copy_upload",
          args: {
            destination: args["destination"],
            localPath: args["localPath"],
            remotePath: args["remotePath"],
            timeoutSeconds: args["timeoutSeconds"] as number,
            ...(args["timeoutReason"] === undefined ? {} : { timeoutReason: args["timeoutReason"] }),
          },
        }
      : {
          version: RELAY_SSH_APPROVED_REQUEST_VERSION,
          toolCallId,
          toolName: "structured_ssh_copy_download",
          args: {
            destination: args["destination"],
            remotePath: args["remotePath"],
            localPath: args["localPath"],
            timeoutSeconds: args["timeoutSeconds"] as number,
            ...(args["timeoutReason"] === undefined ? {} : { timeoutReason: args["timeoutReason"] }),
          },
        };
  } else {
    return { ok: false, error: "structured SSH approved request tool is unsupported" };
  }

  if (Buffer.byteLength(serializeRelaySshApprovedRequestV1(request), "utf8") > RELAY_SSH_APPROVED_REQUEST_MAX_BYTES) {
    return { ok: false, error: "structured SSH approved request exceeds the wire byte limit" };
  }
  return { ok: true, request };
}

// ── D440 Phase 3 — structured Git operation variant for `run_shell` ─────
//
// `run_shell` admits exactly one of two mutually exclusive modes: a raw
// `command` string (unchanged baseline path through the ordinary sandbox) or
// a structured `git` operation. The structured variant is the only seam
// through which the typed GitBroker is reached; a raw `command: "git ..."` is
// NEVER parsed or allowlisted into the broker — it stays on the ordinary
// sandboxed shell path and receives no metadata/template exception.
//
// This parser is the strict ingress gate the desktop relay calls before
// constructing a `GitBroker`. It admits ONLY the six bounded operations the
// broker owns, with explicit `paths` / `message` / `ref` / `target` fields per
// operation. Anything else — extra keys, wrong types, pathspec magic, a
// missing required field — fails closed with a stable error. The agent-side
// Zod schema mirrors this shape for the model; the relay re-validates because
// the wire is untrusted.

export type RelayRunShellGitOperation =
  | { readonly operation: "status" }
  | { readonly operation: "diff"; readonly ref?: string | undefined }
  | { readonly operation: "add"; readonly paths: readonly string[] }
  | { readonly operation: "commit"; readonly message: string }
  | { readonly operation: "worktree-add"; readonly target: string; readonly ref: string }
  | { readonly operation: "worktree-remove"; readonly target: string };

export type RelayRunShellGitOperationValidationResult =
  | { readonly ok: true; readonly operation: RelayRunShellGitOperation }
  | { readonly ok: false; readonly error: string };

const RUN_SHELL_GIT_OPERATIONS = new Set([
  "status",
  "diff",
  "add",
  "commit",
  "worktree-add",
  "worktree-remove",
]);

/**
 * Reject pathspec magic defensively. The broker never accepts pathspecs that
 * could escape the granted target via Git's own magic (`:(...)`, `**`); the
 * relay rejects them at the ingress boundary so a malformed payload never
 * reaches the broker.
 */
function isBareGitPath(value: string): boolean {
  return value.length > 0 && !value.startsWith(":") && !value.includes("**") && !value.includes("\0");
}

export function parseRelayRunShellGitOperation(
  value: unknown,
): RelayRunShellGitOperationValidationResult {
  if (!isRecord(value) || typeof value["operation"] !== "string") {
    return { ok: false, error: "run_shell git operation must be a strict object with an `operation` discriminator" };
  }
  const operation = value["operation"];
  if (!RUN_SHELL_GIT_OPERATIONS.has(operation)) {
    return { ok: false, error: `run_shell git operation is not one of the bounded operations: ${operation}` };
  }
  if (operation === "status") {
    if (!hasOnlyKeys(value, new Set(["operation"]))) {
      return { ok: false, error: "run_shell git status admits only `operation`" };
    }
    return { ok: true, operation: { operation: "status" } };
  }
  if (operation === "diff") {
    if (!hasOnlyKeys(value, new Set(["operation", "ref"]))) {
      return { ok: false, error: "run_shell git diff admits only `operation` and optional `ref`" };
    }
    if (value["ref"] !== undefined) {
      if (!isNonBlankString(value["ref"]) || !isBareGitPath(value["ref"])) {
        return { ok: false, error: "run_shell git diff `ref` must be a bare ref/commit without pathspec magic" };
      }
      return { ok: true, operation: { operation: "diff", ref: value["ref"] } };
    }
    return { ok: true, operation: { operation: "diff" } };
  }
  if (operation === "add") {
    if (!hasOnlyKeys(value, new Set(["operation", "paths"]))) {
      return { ok: false, error: "run_shell git add admits only `operation` and `paths`" };
    }
    const paths = value["paths"];
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, error: "run_shell git add `paths` must be a non-empty array" };
    }
    for (const p of paths) {
      if (!isNonBlankString(p) || !isBareGitPath(p)) {
        return { ok: false, error: "run_shell git add `paths` must be bare relative paths without pathspec magic" };
      }
    }
    return { ok: true, operation: { operation: "add", paths: [...(paths as string[])] } };
  }
  if (operation === "commit") {
    if (!hasOnlyKeys(value, new Set(["operation", "message"]))) {
      return { ok: false, error: "run_shell git commit admits only `operation` and `message`" };
    }
    if (!isNonBlankString(value["message"])) {
      return { ok: false, error: "run_shell git commit `message` must be a non-blank string" };
    }
    return { ok: true, operation: { operation: "commit", message: value["message"] } };
  }
  if (operation === "worktree-add") {
    if (!hasOnlyKeys(value, new Set(["operation", "target", "ref"]))) {
      return { ok: false, error: "run_shell git worktree-add admits only `operation`, `target`, and `ref`" };
    }
    if (!isNonBlankString(value["target"]) || !path.isAbsolute(value["target"])) {
      return { ok: false, error: "run_shell git worktree-add `target` must be a non-blank absolute path" };
    }
    if (!isNonBlankString(value["ref"]) || !isBareGitPath(value["ref"])) {
      return { ok: false, error: "run_shell git worktree-add `ref` must be a bare ref/commit without pathspec magic" };
    }
    return { ok: true, operation: { operation: "worktree-add", target: value["target"], ref: value["ref"] } };
  }
  // operation === "worktree-remove"
  if (!hasOnlyKeys(value, new Set(["operation", "target"]))) {
    return { ok: false, error: "run_shell git worktree-remove admits only `operation` and `target`" };
  }
  if (!isNonBlankString(value["target"]) || !path.isAbsolute(value["target"])) {
    return { ok: false, error: "run_shell git worktree-remove `target` must be a non-blank absolute path" };
  }
  return { ok: true, operation: { operation: "worktree-remove", target: value["target"] } };
}

// ── D418 — advisory active-grant snapshot (RelayCapabilities) ──────────
//
// The snapshot is advertised at register as a DISCOVERY hint only. It never
// becomes filesystem authority: the relay-local resolver reloads the live local
// grant store and decides every access, so a stale or revoked snapshot entry
// fails closed there. This parser is the strict ingress gate — malformed
// snapshots are rejected here and dropped (ignored safely) by the registry, per
// the same fail-closed convention as `parseRelayDesktopFilesystemGrantRequest`.

const DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_KEYS = new Set(["revision", "instanceId", "agentScope", "grants"]);
const DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_ENTRY_KEYS = new Set([
  "id",
  "canonicalRoot",
  "access",
  "policyVersion",
  "lifetime",
  "expiresAt",
]);

export type RelayDesktopFilesystemGrantSnapshotValidationResult =
  | { readonly ok: true; readonly snapshot: RelayDesktopFilesystemGrantSnapshot }
  | { readonly ok: false; readonly error: string };

function parseSnapshotEntry(
  value: unknown,
): RelayDesktopFilesystemGrantSnapshotEntry | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_ENTRY_KEYS)) {
    return undefined;
  }
  if (!isNonBlankString(value.id)) return undefined;
  if (
    !isNonBlankString(value.canonicalRoot) ||
    !path.isAbsolute(value.canonicalRoot) ||
    path.normalize(value.canonicalRoot) !== value.canonicalRoot
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.access) ||
    value.access.length === 0 ||
    !value.access.every(
      (operation): operation is DesktopFilesystemAccessOperation =>
        typeof operation === "string" &&
        DESKTOP_FILESYSTEM_ACCESS_OPERATIONS.includes(operation as DesktopFilesystemAccessOperation),
    ) ||
    new Set(value.access).size !== value.access.length
  ) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(value.policyVersion) ||
    (value.policyVersion as number) < 1
  ) {
    return undefined;
  }
  if (
    typeof value.lifetime !== "string" ||
    !DESKTOP_FILESYSTEM_GRANT_LIFETIMES.includes(value.lifetime as DesktopFilesystemGrantLifetime)
  ) {
    return undefined;
  }
  let expiresAt: string | undefined;
  if (value.expiresAt !== undefined) {
    expiresAt = parseUtcTimestamp(value.expiresAt);
    if (expiresAt === undefined) return undefined;
  }
  return {
    id: value.id,
    canonicalRoot: value.canonicalRoot,
    access: [...(value.access)],
    policyVersion: value.policyVersion as number,
    lifetime: value.lifetime as DesktopFilesystemGrantLifetime,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/**
 * Strict, fail-closed parser for the advisory active-grant snapshot. It admits
 * ONLY the discovery fields (`revision`, `instanceId`, `agentScope`, and
 * redacted `grants`) and rejects anything else — including platform
 * authorization, filesystem identity, origin, createdBy, timestamps, or revoked
 * history that must never cross the wire. Success does not make the snapshot
 * authority; it remains advisory and the relay-local resolver decides access.
 */
export function parseRelayDesktopFilesystemGrantSnapshot(
  value: unknown,
): RelayDesktopFilesystemGrantSnapshotValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_KEYS)) {
    return { ok: false, error: "Desktop Filesystem Grant snapshot must be a strict object" };
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    return { ok: false, error: "Desktop Filesystem Grant snapshot revision must be a non-negative safe integer" };
  }
  if (!isCanonicalNautiloInstanceId(value.instanceId)) {
    return { ok: false, error: "Desktop Filesystem Grant snapshot instanceId is invalid" };
  }
  if (value.agentScope !== DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE) {
    return { ok: false, error: "Desktop Filesystem Grant snapshot agentScope is unsupported" };
  }
  if (!Array.isArray(value.grants)) {
    return { ok: false, error: "Desktop Filesystem Grant snapshot grants must be an array" };
  }
  const grants: RelayDesktopFilesystemGrantSnapshotEntry[] = [];
  const seenIds = new Set<string>();
  for (const rawEntry of value.grants) {
    const entry = parseSnapshotEntry(rawEntry);
    if (entry === undefined) {
      return { ok: false, error: "Desktop Filesystem Grant snapshot contains an invalid grant entry" };
    }
    if (seenIds.has(entry.id)) {
      return { ok: false, error: "Desktop Filesystem Grant snapshot grant ids must be unique" };
    }
    seenIds.add(entry.id);
    grants.push(entry);
  }
  return {
    ok: true,
    snapshot: {
      revision: value.revision as number,
      instanceId: value.instanceId,
      agentScope: DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
      grants,
    },
  };
}

// ── D418 — advisory Workstation Profile binding snapshot (RelayCapabilities) ─
//
// The snapshot is advertised at register (and replaced via
// `relay:update-capabilities`) as an advisory binding hint only. It never
// becomes compiled-profile authority: the desktop relay's live compiled
// profile remains final, so a stale or revoked binding here fails closed on
// the relay. This parser is the strict ingress gate — it admits ONLY the
// redacted binding fields (`profileId`, `profileRevision`, `grantIds`,
// `protectedPolicyVersion`, `networkMode`, and typed capability `id` +
// `backend` pairs) and rejects anything else, including roots, environment
// values, executable paths, filesystem identity, platform authorization,
// discovery providers, and raw profile data that must never cross the wire.
// A malformed snapshot is dropped (ignored safely) by the registry at
// registration, and rejects the full capability update on update, per the
// same fail-closed convention as `parseRelayDesktopFilesystemGrantSnapshot`.

const WORKSTATION_PROFILE_SNAPSHOT_KEYS = new Set([
  "profileId",
  "profileRevision",
  "grantIds",
  "protectedPolicyVersion",
  "networkMode",
  "capabilities",
]);
const WORKSTATION_PROFILE_SNAPSHOT_CAPABILITY_KEYS = new Set(["id", "backend"]);

export type RelayWorkstationProfileSnapshotValidationResult =
  | { readonly ok: true; readonly snapshot: RelayWorkstationProfileSnapshot }
  | { readonly ok: false; readonly error: string };

function parseProfileSnapshotCapability(
  value: unknown,
): RelayWorkstationProfileCapabilityEntry | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, WORKSTATION_PROFILE_SNAPSHOT_CAPABILITY_KEYS)) {
    return undefined;
  }
  if (!isNonBlankString(value.id)) return undefined;
  if (
    typeof value.backend !== "string" ||
    !PROFILE_CAPABILITY_BACKENDS.includes(value.backend as ProfileCapabilityBackend)
  ) {
    return undefined;
  }
  return { id: value.id, backend: value.backend as ProfileCapabilityBackend };
}

/**
 * Strict, fail-closed parser for the advisory Workstation Profile binding
 * snapshot. It admits ONLY the redacted binding fields and rejects anything
 * else — including roots, environment values, executable paths, filesystem
 * identity, platform authorization, discovery providers, and raw profile data
 * that must never cross the wire. Success does not make the snapshot
 * authority; it remains advisory and the desktop relay's live compiled
 * profile decides every access. An absent snapshot is handled by the caller
 * as the backward-compatible baseline-only path.
 */
export function parseRelayWorkstationProfileSnapshot(
  value: unknown,
): RelayWorkstationProfileSnapshotValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, WORKSTATION_PROFILE_SNAPSHOT_KEYS)) {
    return { ok: false, error: "workstation profile snapshot must be a strict object" };
  }
  if (!isNonBlankString(value.profileId)) {
    return { ok: false, error: "workstation profile snapshot profileId is invalid" };
  }
  if (
    !Number.isSafeInteger(value.profileRevision) ||
    (value.profileRevision as number) < 1
  ) {
    return { ok: false, error: "workstation profile snapshot profileRevision must be a positive safe integer" };
  }
  if (
    !Array.isArray(value.grantIds) ||
    !value.grantIds.every(isNonBlankString) ||
    new Set(value.grantIds).size !== value.grantIds.length
  ) {
    return { ok: false, error: "workstation profile snapshot grantIds must be unique non-empty opaque ids" };
  }
  if (
    !Number.isSafeInteger(value.protectedPolicyVersion) ||
    (value.protectedPolicyVersion as number) < 1
  ) {
    return { ok: false, error: "workstation profile snapshot protectedPolicyVersion must be a positive safe integer" };
  }
  if (
    typeof value.networkMode !== "string" ||
    !PROFILE_NETWORK_MODES.includes(value.networkMode as ProfileNetworkMode)
  ) {
    return { ok: false, error: "workstation profile snapshot networkMode is unsupported" };
  }
  if (!Array.isArray(value.capabilities)) {
    return { ok: false, error: "workstation profile snapshot capabilities must be an array" };
  }
  const capabilities: RelayWorkstationProfileCapabilityEntry[] = [];
  const seenCapabilityIds = new Set<string>();
  for (const rawEntry of value.capabilities) {
    const entry = parseProfileSnapshotCapability(rawEntry);
    if (entry === undefined) {
      return { ok: false, error: "workstation profile snapshot contains an invalid capability entry" };
    }
    if (seenCapabilityIds.has(entry.id)) {
      return { ok: false, error: "workstation profile snapshot capability ids must be unique" };
    }
    seenCapabilityIds.add(entry.id);
    capabilities.push(entry);
  }
  return {
    ok: true,
    snapshot: {
      profileId: value.profileId,
      profileRevision: value.profileRevision as number,
      grantIds: [...value.grantIds],
      protectedPolicyVersion: value.protectedPolicyVersion as number,
      networkMode: value.networkMode as ProfileNetworkMode,
      capabilities,
    },
  };
}

export interface RelayNetworkDeniedDestination {
  readonly host: string;
  readonly port: number;
  readonly reason: string;
}

export type RelayStatus = "connecting" | "connected" | "disconnected" | "error";

// ── M174 — filesystem execution class (`executionClass:"fs"`) ──────────
//
// The server keeps the unified `file` tool as `executor:"cloud"` (all
// matching / scanning / approval / revision logic stays server-side) and
// uses the relay purely as a byte-I/O transport for the `current` and
// `absolute` zones. Each `file` fs primitive maps to one `RelayFsRequest`
// that rides the existing `relay:dispatch` pipeline with
// `toolName:"fs"` + `executionClass:"fs"`. Bytes are base64 because the
// relay transport is JSON-over-WS.

export type RelayFsOp =
  | "readFile"
  | "writeFileAtomic"
  | "readdir"
  | "stat"
  | "lstat"
  | "mkdir"
  | "rename"
  | "unlink"
  | "rm"
  | "cp"
  | "realpath";

/**
 * D458 — hard upper bound for one paged typed Relay `readdir` response. The
 * phone/server must not turn an unbounded desktop directory into one WebSocket
 * payload. This is a per-request ceiling, not a maximum directory size.
 */
export const RELAY_FS_READDIR_MAX_ENTRIES = 2001;

export interface RelayFsRequest {
  op: RelayFsOp;
  /** Absolute path on the relay machine. */
  path: string;
  /** Second path for `rename` / `cp`. */
  destPath?: string;
  /** base64 payload for `writeFileAtomic`. */
  dataBase64?: string;
  /**
   * Op flags. Recognized keys per op:
   *   readdir  → { withFileTypes?: boolean, maxEntries?: positive safe integer,
   *                afterName?: prior page's final entry name,
   *                includeHidden?: boolean, nameQuery?: bounded string }
   *   mkdir    → { recursive?: boolean }
   *   rm       → { recursive?: boolean; force?: boolean }
   *   cp       → { recursive?: boolean; errorOnExist?: boolean }
   *   writeFileAtomic → { mode?: number, changeEvent?: RelayFsChangeEvent }
   */
  opts?: Record<string, unknown>;
  /**
   * Roots the relay MUST jail this op within (server-resolved from the
   * zone roots + relay-reported `allowedRoots`). The relay re-validates
   * every path (incl. `destPath`) against its own `WorkspaceGuard`; this
   * field lets the server narrow the jail to the specific zone in play.
   */
  allowedRoots: string[];
}

export interface RelayFsDirEntry {
  name: string;
  dir: boolean;
  file: boolean;
  symlink: boolean;
}

export interface RelayFsStat {
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  mode: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  isFIFO: boolean;
  isSocket: boolean;
}

export interface RelayFsOkResult {
  ok: true;
  /** base64 for `readFile`. */
  dataBase64?: string;
  /** `readdir` entries. */
  entries?: RelayFsDirEntry[];
  /** True when `readdir` had more entries than the bounded response includes. */
  truncated?: boolean;
  /** `stat` / `lstat` shape. */
  stat?: RelayFsStat;
  /** `realpath` result, or `null` on ENOENT (mirrors server `realpathOrNull`). */
  realpath?: string | null;
}

export interface RelayFsErrResult {
  ok: false;
  /** Node errno when available (ENOENT/EACCES/EISDIR/EXDEV/ENOTDIR/…). */
  code?: string;
  message: string;
}

export type RelayFsResult = RelayFsOkResult | RelayFsErrResult;

// ── M206 — local-file execution class (`executionClass:"local-file"`) ──
//
// The server dispatches one structured high-level operation per
// `relay:dispatch` with `toolName:"local-file"` +
// `executionClass:"local-file"`. Unlike the M174 `fs` byte-transport
// class, payloads are discriminated command shapes — not arbitrary argv
// or raw shell strings. The envelope carries correlationId, impact,
// allowedRoots, and approvalObtained; the args field holds
// `RelayLocalFileRequest`.

/** Zone scope for local `file` tool commands routed through the relay. */
export type RelayLocalFileZone = "current" | "absolute";

/**
 * Local unified-`file` command — command name plus command-specific args
 * (path, content, query, lineRange, …) excluding the routing fields.
 */
export interface RelayLocalFileCommandOp {
  readonly kind: "file";
  readonly command: string;
  readonly zone: RelayLocalFileZone;
  readonly args: Record<string, unknown>;
}

/**
 * Local revision/history commands (`undo`, `redo`, `undo_turn`,
 * `list_revisions`, `pin_revision`, `unpin_revision`, …).
 */
export interface RelayLocalFileHistoryOp {
  readonly kind: "history";
  readonly command: string;
  readonly args: Record<string, unknown>;
}

/**
 * D446 — strict native-search operation carried by the existing local-file
 * relay class. Search arguments stay typed and separate from relay routing
 * metadata so neither host accepts executable/argv-shaped escape hatches.
 */
export type RelayLocalSearchOp =
  | {
      readonly kind: "search";
      readonly command: "glob";
      readonly zone: RelayLocalFileZone;
      readonly args: RelayGlobSearchArgs;
      readonly routing: Record<string, unknown>;
    }
  | {
      readonly kind: "search";
      readonly command: "grep";
      readonly zone: RelayLocalFileZone;
      readonly args: RelayGrepSearchArgs;
      readonly routing: Record<string, unknown>;
    };

/**
 * Structured OfficeCLI operation for local-zone execution (Phase 3).
 * Carries a future-safe operation descriptor without shell argv.
 */
export interface RelayLocalFileOfficeOp {
  readonly kind: "office";
  readonly operation: Record<string, unknown>;
}

/**
 * M216 — bounded Writer document transport (`kind:"document"`).
 *
 * Separate from generic `kind:"file"` commands so arbitrary local-file
 * clients cannot bypass the 16 MiB read cap or raise it globally. Only
 * server-pinned live-document authority should emit these operations.
 */
export type RelayLocalDocumentCommand =
  | "read_meta"
  | "read_chunk"
  | "write_begin"
  | "write_chunk"
  | "write_commit"
  | "write_abort";

export interface RelayLocalDocumentTransferOp {
  readonly kind: "document";
  readonly command: RelayLocalDocumentCommand;
  readonly zone: RelayLocalFileZone;
  readonly args: Record<string, unknown>;
}

// ── D448 — typed relay-local apply_patch operation (protocol v9) ────────

/** Trusted routing metadata; it names a logical local zone, never a root path. */
export interface RelayLocalApplyPatchRouting {
  readonly zone: RelayLocalFileZone;
  /** Trusted turn correlation used by the normalized result; never model-authored. */
  readonly turnId: string;
  /** Authenticated graph agent identity, authored by the server. */
  readonly agentId: string;
}

/**
 * One high-level local-file operation. The patch's relative paths are input,
 * not authority. This operation deliberately has no argv, shell, environment,
 * allowedRoots, or physical Workspace path field.
 */
export interface RelayLocalApplyPatchOperation {
  readonly kind: "apply_patch";
  readonly version: typeof RELAY_LOCAL_APPLY_PATCH_VERSION;
  readonly patch: string;
  readonly routing: RelayLocalApplyPatchRouting;
}

/**
 * The apply-patch request deliberately has no `allowedRoots` mirror.
 * `expectedCurrentFolder` is a stale-context assertion only: Desktop compares
 * it with its locally selected Current Folder and never treats it as path
 * authority.
 */
export interface RelayLocalApplyPatchRequest {
  readonly operation: RelayLocalApplyPatchOperation;
  readonly expectedCurrentFolder: string;
}

export type RelayApplyPatchPathOperation = "add" | "update" | "move" | "delete";
export type RelayApplyPatchPathStatus = "applied" | "failed" | "not_applied" | "unknown";
export const RELAY_APPLY_PATCH_ERROR_CODES = [
  "invalid_request",
  "parse_error",
  "missing_context",
  "stale_context",
  "human_edit_conflict",
  "reapply_required",
  "unsupported_encoding_or_type",
  "denied_path",
  "runtime_unavailable",
  "runtime_corrupt",
  "cancelled",
  "partial_execution",
] as const;
export type RelayApplyPatchErrorCode = (typeof RELAY_APPLY_PATCH_ERROR_CODES)[number];

export interface RelayApplyPatchError {
  readonly code: RelayApplyPatchErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface RelayApplyPatchPathResult {
  readonly operation: RelayApplyPatchPathOperation;
  readonly path: string;
  readonly fromPath?: string | undefined;
  readonly status: RelayApplyPatchPathStatus;
  readonly bytesTouched?: number | null | undefined;
  readonly revisionId: string | null;
  readonly error?: RelayApplyPatchError | undefined;
}

/** Narrow relay-local mirror of the public normalized result contract. */
export interface RelayLocalApplyPatchResult {
  readonly status: "applied" | "partial";
  readonly partial: boolean;
  /** Present only when later authoritative human text was composed. */
  readonly rebased?: true;
  readonly operationCounts: Readonly<Record<RelayApplyPatchPathOperation, number>>;
  readonly pathResults: readonly RelayApplyPatchPathResult[];
  readonly changedFiles: readonly RelayApplyPatchPathResult[];
  readonly revisionIds: readonly string[];
  readonly unifiedDiff: string;
  readonly runtimeVersion: string;
  readonly turnId: string;
  readonly error?: RelayApplyPatchError | undefined;
}

export type RelayLocalApplyPatchRequestValidationResult =
  | { readonly ok: true; readonly request: RelayLocalApplyPatchRequest }
  | { readonly ok: false; readonly error: string };

export type RelayLocalApplyPatchResultValidationResult =
  | { readonly ok: true; readonly result: RelayLocalApplyPatchResult }
  | { readonly ok: false; readonly error: string };

const RELAY_LOCAL_APPLY_PATCH_OPERATION_KEYS = new Set(["kind", "version", "patch", "routing"]);
const RELAY_LOCAL_APPLY_PATCH_REQUEST_KEYS = new Set(["operation", "expectedCurrentFolder"]);
const RELAY_LOCAL_APPLY_PATCH_ROUTING_KEYS = new Set(["zone", "turnId", "agentId"]);
const RELAY_APPLY_PATCH_RESULT_KEYS = new Set([
  "status",
  "partial",
  "rebased",
  "operationCounts",
  "pathResults",
  "changedFiles",
  "revisionIds",
  "unifiedDiff",
  "runtimeVersion",
  "turnId",
  "error",
]);
const RELAY_APPLY_PATCH_COUNTS_KEYS = new Set(["add", "update", "move", "delete"]);
const RELAY_APPLY_PATCH_PATH_RESULT_KEYS = new Set([
  "operation",
  "path",
  "fromPath",
  "status",
  "bytesTouched",
  "revisionId",
  "error",
]);
const RELAY_APPLY_PATCH_ERROR_KEYS = new Set(["code", "message", "retryable"]);
const RELAY_APPLY_PATCH_PATH_OPERATIONS = new Set<RelayApplyPatchPathOperation>([
  "add",
  "update",
  "move",
  "delete",
]);
const RELAY_APPLY_PATCH_PATH_STATUSES = new Set<RelayApplyPatchPathStatus>([
  "applied",
  "failed",
  "not_applied",
  "unknown",
]);
const RELAY_APPLY_PATCH_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/;

function isWellFormedString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isRelayApplyPatchOpaqueId(value: unknown): value is string {
  return (
    isWellFormedString(value) &&
    RELAY_APPLY_PATCH_OPAQUE_ID.test(value)
  );
}

function isRelayApplyPatchPath(value: unknown): value is string {
  return (
    isWellFormedString(value) &&
    value.length > 0 &&
    !value.includes("\0")
  );
}

function parseRelayLocalApplyPatchOperation(
  value: unknown,
): { readonly ok: true; readonly operation: RelayLocalApplyPatchOperation } | { readonly ok: false; readonly error: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, RELAY_LOCAL_APPLY_PATCH_OPERATION_KEYS)) {
    return { ok: false, error: "apply-patch operation must be a strict object" };
  }
  if (value.kind !== "apply_patch" || value.version !== RELAY_LOCAL_APPLY_PATCH_VERSION) {
    return { ok: false, error: "apply-patch operation has an unsupported kind or version" };
  }
  if (
    !isWellFormedString(value.patch) ||
    value.patch.length === 0 ||
    value.patch.includes("\0")
  ) {
    return { ok: false, error: "apply-patch operation patch is invalid" };
  }
  if (
    !isRecord(value.routing) ||
    !hasOnlyKeys(value.routing, RELAY_LOCAL_APPLY_PATCH_ROUTING_KEYS) ||
    (value.routing.zone !== "current" && value.routing.zone !== "absolute") ||
    !isRelayApplyPatchOpaqueId(value.routing.turnId) ||
    !isRelayApplyPatchOpaqueId(value.routing["agentId"])
  ) {
    return { ok: false, error: "apply-patch operation routing is invalid" };
  }
  return {
    ok: true,
    operation: {
      kind: "apply_patch",
      version: RELAY_LOCAL_APPLY_PATCH_VERSION,
      patch: value.patch,
      routing: { zone: value.routing.zone, turnId: value.routing.turnId, agentId: value.routing["agentId"] },
    },
  };
}

/** Strict parser for the single v9 high-level relay-local apply-patch request. */
export function parseRelayLocalApplyPatchRequest(value: unknown): RelayLocalApplyPatchRequestValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, RELAY_LOCAL_APPLY_PATCH_REQUEST_KEYS)) {
    return { ok: false, error: "apply-patch request must contain only its operation and Current Folder assertion" };
  }
  const parsed = parseRelayLocalApplyPatchOperation(value.operation);
  if (!parsed.ok) return parsed;
  if (
    !isWellFormedString(value["expectedCurrentFolder"]) ||
    value["expectedCurrentFolder"].length === 0 ||
    value["expectedCurrentFolder"].includes("\0")
  ) {
    return { ok: false, error: "apply-patch Current Folder assertion is invalid" };
  }
  return {
    ok: true,
    request: {
      operation: parsed.operation,
      expectedCurrentFolder: value["expectedCurrentFolder"],
    },
  };
}

function parseRelayApplyPatchError(value: unknown): RelayApplyPatchError | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, RELAY_APPLY_PATCH_ERROR_KEYS) ||
    typeof value.code !== "string" ||
    !RELAY_APPLY_PATCH_ERROR_CODES.includes(value.code as RelayApplyPatchErrorCode) ||
    !isWellFormedString(value.message) ||
    typeof value.retryable !== "boolean"
  ) {
    return undefined;
  }
  return { code: value.code as RelayApplyPatchErrorCode, message: value.message, retryable: value.retryable };
}

function parseRelayApplyPatchPathResult(value: unknown): RelayApplyPatchPathResult | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, RELAY_APPLY_PATCH_PATH_RESULT_KEYS) ||
    typeof value.operation !== "string" ||
    !RELAY_APPLY_PATCH_PATH_OPERATIONS.has(value.operation as RelayApplyPatchPathOperation) ||
    !isRelayApplyPatchPath(value.path) ||
    typeof value.status !== "string" ||
    !RELAY_APPLY_PATCH_PATH_STATUSES.has(value.status as RelayApplyPatchPathStatus) ||
    (value.fromPath !== undefined && !isRelayApplyPatchPath(value.fromPath)) ||
    (value.operation === "move") !== (value.fromPath !== undefined) ||
    !(value.bytesTouched === undefined ||
      value.bytesTouched === null ||
      (typeof value.bytesTouched === "number" &&
        Number.isSafeInteger(value.bytesTouched) &&
        value.bytesTouched >= 0)
    ) ||
    !(value.revisionId === null || isRelayApplyPatchOpaqueId(value.revisionId))
  ) {
    return undefined;
  }
  const error = value.error === undefined ? undefined : parseRelayApplyPatchError(value.error);
  if ((value.error !== undefined && error === undefined) || (value.status === "applied" && error !== undefined)) {
    return undefined;
  }
  return {
    operation: value.operation as RelayApplyPatchPathOperation,
    path: value.path,
    ...(value.fromPath !== undefined ? { fromPath: value.fromPath } : {}),
    status: value.status as RelayApplyPatchPathStatus,
    ...(value.bytesTouched === undefined ? {} : { bytesTouched: value.bytesTouched }),
    revisionId: value.revisionId,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Strict, bounded parser for the relay's normalized public result mirror. */
export function parseRelayLocalApplyPatchResult(value: unknown): RelayLocalApplyPatchResultValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, RELAY_APPLY_PATCH_RESULT_KEYS)) {
    return { ok: false, error: "apply-patch result must be a strict object" };
  }
  if (
    (value.status !== "applied" && value.status !== "partial") ||
    typeof value.partial !== "boolean" ||
    value.partial !== (value.status === "partial") ||
    (value["rebased"] !== undefined && value["rebased"] !== true) ||
    !isRecord(value.operationCounts) ||
    !hasOnlyKeys(value.operationCounts, RELAY_APPLY_PATCH_COUNTS_KEYS) ||
    !Object.values(value.operationCounts).every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    ) ||
    !Array.isArray(value.pathResults) ||
    value.pathResults.length === 0 ||
    !Array.isArray(value.changedFiles) ||
    !Array.isArray(value.revisionIds) ||
    !value.revisionIds.every(isRelayApplyPatchOpaqueId) ||
    new Set(value.revisionIds).size !== value.revisionIds.length ||
    !isWellFormedString(value.unifiedDiff) ||
    !isWellFormedString(value.runtimeVersion) ||
    value.runtimeVersion.length === 0 ||
    !isRelayApplyPatchOpaqueId(value.turnId)
  ) {
    return { ok: false, error: "apply-patch result is malformed" };
  }
  const pathResults = value.pathResults.map(parseRelayApplyPatchPathResult);
  const changedFiles = value.changedFiles.map(parseRelayApplyPatchPathResult);
  const error = value.error === undefined ? undefined : parseRelayApplyPatchError(value.error);
  if (pathResults.some((result) => result === undefined) || changedFiles.some((result) => result === undefined)) {
    return { ok: false, error: "apply-patch result contains an invalid path result" };
  }
  if ((value.error !== undefined && error === undefined) || (value.status === "applied" && error !== undefined)) {
    return { ok: false, error: "apply-patch result has an invalid status error" };
  }
  const normalizedPathResults = pathResults as RelayApplyPatchPathResult[];
  const applied = normalizedPathResults.filter((result) => result.status === "applied");
  const operationCounts = value.operationCounts as Record<RelayApplyPatchPathOperation, number>;
  const revisionIds = value.revisionIds;
  if (
    Object.entries(operationCounts).some(
      ([operation, count]) => applied.filter((result) => result.operation === operation).length !== count,
    ) ||
    changedFiles.length !== applied.length ||
    revisionIds.length !== applied.length ||
    applied.some((result, index) =>
      result.revisionId !== revisionIds[index] ||
      JSON.stringify(result) !== JSON.stringify(changedFiles[index]),
    ) ||
    (value.status === "partial" && error?.code !== "partial_execution")
  ) {
    return { ok: false, error: "apply-patch result normalization invariants failed" };
  }
  return {
    ok: true,
    result: {
      status: value.status,
      partial: value.partial,
      ...(value["rebased"] === true ? { rebased: true } : {}),
      operationCounts,
      pathResults: normalizedPathResults,
      changedFiles: changedFiles as RelayApplyPatchPathResult[],
      revisionIds: [...revisionIds],
      unifiedDiff: value.unifiedDiff,
      runtimeVersion: value.runtimeVersion,
      turnId: value.turnId,
      ...(error !== undefined ? { error } : {}),
    },
  };
}

export type RelayLocalFileOperation =
  | RelayLocalFileCommandOp
  | RelayLocalSearchOp
  | RelayLocalDocumentTransferOp
  | RelayLocalFileHistoryOp
  | RelayLocalFileOfficeOp;

/**
 * Legacy/general local-file dispatch payload (rides in `relay:dispatch.args`).
 * D448 apply-patch dispatches use `RelayLocalApplyPatchRequest` instead so
 * they cannot carry this legacy `allowedRoots` mirror.
 */
export interface RelayLocalFileRequest {
  readonly operation: RelayLocalFileOperation;
  readonly allowedRoots: readonly string[];
}

export interface RelayLocalFileOkResult {
  ok: true;
  /** Operation-specific payload (content when explicitly requested, metadata otherwise). */
  result?: unknown;
}

export interface RelayLocalFileErrResult {
  ok: false;
  /** Node errno or machine-readable category when available. */
  code?: string;
  message: string;
}

export type RelayLocalFileResult = RelayLocalFileOkResult | RelayLocalFileErrResult;

/** Canonical lowercase SHA-256 hex for local-file optimistic-concurrency guards. */
export const RELAY_LOCAL_FILE_SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/** Parse optional local-file SHA-256 guards to canonical lowercase 64-hex. */
export function parseRelayLocalFileSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return RELAY_LOCAL_FILE_SHA256_HEX_RE.test(trimmed) ? trimmed : null;
}

/**
 * Optional write-time guards for accepted Current Folder Writer persistence (M216).
 * Additive keys inside `RelayLocalFileCommandOp.args`; old callers omit them.
 */
export interface RelayLocalFileWriteGuardArgs {
  /** Compare canonical bytes before mutation; null requires an absent destination.
   * Older relays reject null rather than silently overwriting an existing file. */
  expectedSha256?: string | null | undefined;
  /**
   * Host-only accepted-write correlation id. Forwarded on change events for
   * Workbench suppression; must never appear in tool text/diff payloads.
   */
  clientMutationId?: string | undefined;
}

/** Successful guarded local `write` metadata returned to the server (no raw content). */
export interface RelayLocalFileWriteAppliedResult {
  applied: true;
  revisionId: string;
  /** Post-write canonical SHA-256 (lowercase hex). */
  sha256: string;
  path: string;
  zone: RelayLocalFileZone;
  command: "write";
  stats: { additions: number; deletions: number };
  summary: string;
  unifiedDiff: string;
}

/** Stable non-mutating failure when `expectedSha256` does not match disk. */
export interface RelayLocalFileWriteStaleShaResult {
  error: "stale_sha256";
  message: string;
  expectedSha256: string;
  actualSha256: string;
}

/** `document.read_meta` — canonical metadata before ordered chunk reads. */
export interface RelayLocalDocumentReadMetaResult {
  sessionId: string;
  totalBytes: number;
  chunkCount: number;
  sha256: string;
}

/** One bounded slice from `document.read_chunk`. */
export interface RelayLocalDocumentReadChunkResult {
  sessionId: string;
  index: number;
  chunkCount: number;
  totalBytes: number;
  /** Canonical base64 for at most RELAY_LOCAL_DOCUMENT_CHUNK_BYTES decoded bytes. */
  data: string;
}

/** Staged write session opened by `document.write_begin`. */
export interface RelayLocalDocumentWriteBeginResult {
  sessionId: string;
  totalBytes: number;
  chunkCount: number;
}

/** Ack for an accepted ordered `document.write_chunk`. */
export interface RelayLocalDocumentWriteChunkResult {
  sessionId: string;
  index: number;
  receivedBytes: number;
}

// ── D417 — constrained chunked relay media transport ─────────────────────

/**
 * Fixed-schema payload for `toolName:"extract_audio_from_video"`.
 *
 * Source bytes are transferred only after the agent has resolved the
 * workspace/local authority boundary. The relay writes them to a private temp
 * file, invokes ffmpeg with its own fixed argv template, and returns complete
 * output bytes. No caller-selected filesystem path or process argument exists
 * in this contract.
 */
export interface RelayMediaTransferStart {
  readonly sessionId: string;
  readonly totalBytes: number;
  readonly chunkCount: number;
  readonly outputFormat?: "m4a";
}

export interface RelayMediaTransferChunk {
  readonly sessionId: string;
  readonly index: number;
  readonly chunkCount: number;
  /** Canonical base64 for no more than RELAY_MEDIA_CHUNK_BYTES decoded bytes. */
  readonly data: string;
}

export interface RelayMediaTransferResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly totalBytes?: number;
  readonly chunkCount?: number;
  readonly sha256?: string;
  readonly mimeType?: "audio/mp4";
}

/**
 * Renderer-facing local-file change event carried by successful mutating relay
 * fs operations. It intentionally mirrors Electron's `fs:directoryChanged`
 * payload while adding exact-file and optional patch metadata for open editors.
 */
export interface RelayFsChangeEvent {
  /** Current Folder / allowed root that scoped the local file operation. */
  rootPath: string;
  /** Directory containing the changed path; kept for Files-tree refresh. */
  path: string;
  /** Exact local file path when known. */
  changedPath?: string | undefined;
  source: "relay";
  op: RelayFsOp;
  /** True when the editor should full-resync instead of patch-applying. */
  reloadRequired?: boolean | undefined;
  sha256?: string | undefined;
  /**
   * Host-only correlation for suppressing own accepted-write watcher noise.
   * Never forwarded to sandboxed iframe payloads.
   */
  clientMutationId?: string | undefined;
  patchEvent?: {
    type: "document.patch.applied";
    target: {
      kind: "currentFile";
      currentFolderRef: string;
      relativePath: string;
      relayOwnerUserId?: string | undefined;
    };
    patchId: string;
    requestId?: string | undefined;
    revision: null;
    sha256: string;
    previousRevision: null;
    previousSha256: string;
    patch: {
      kind: "anchored_text";
      oldString: string;
      newString: string;
      replaceAll?: boolean | undefined;
      scope?: { from: number; to: number } | undefined;
    };
    author: {
      kind: "human" | "agent" | "app_tool";
      displayName: string;
    };
    clientMutationId?: string | undefined;
    rebased?: boolean | undefined;
  } | undefined;
}
