/**
 * Desktop Relay broker — supervises the standalone Relay Host child.
 *
 * The onDispatch handler executes filesystem/shell operations locally.
 * This is the ONLY tool execution path for local tools.
 *
 * Path safety is delegated to `createWorkspaceGuard` from
 * `@nautilo/relay` (shared with `bin/nautilo-relay`). Electron supplies an
 * explicit, Finder-visible Genie Workspace as the always-present baseline and
 * keeps the Human's optional Current Folder separate. The relay never falls
 * back to hidden product state under `~/.nautilo` for execution.
 */

import {
  createWorkspaceGuard,
  guardDesktopFilesystemOperation,
  type RelayClient,
  type RelayCapabilities,
  type RelayDispatchRequest,
  type RelayDispatchResult,
  type RelayFsChangeEvent,
  type RelayStatus,
  type OpenHueExecutor,
  type WorkspaceGuard,
  type RelayDesktopFilesystemGrantSnapshot,
  type RelayDesktopFilesystemGrantSnapshotEntry,
  type RelayWorkstationProfileSnapshot,
  type RelayWorkstationShellBinding,
  type RelayWorkstationShellBindingSubject,
  type RelaySandboxProfile,
  type RelaySandboxConfig,
  type RelayNetworkPolicy,
  type RelayNetworkAllowRule,
  type RelayCodexHostPort,
  type RelaySshPrepareRequestV1,
  RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION,
  type RelayAcpHostPort,
  type RelayClaudeConnectionHostPort,
  type RelayClaudeExecutionHostPort,
  parseRelayWorkstationShellBinding,
} from "@nautilo/relay";
import {
  createDesktopRelaySidecarClient,
  resolveDesktopRelayHostLaunch,
} from "./relay-sidecar-client.ts";
import { sameComputerUseRuntimeIdentity } from "./computer-use/semantic-contracts.ts";
import type {
  ServerSession,
  ServerSessionRegistry,
} from "./server-sessions/registry";
import {
  createRelayCapabilityPublisher,
  type RelayCapabilityPublisher,
} from "./relay-capability-publisher";
import {
  DESKTOP_FILESYSTEM_ACCESS_OPERATIONS,
  isPathWithinDesktopFilesystemGrantRoot,
  type DesktopFilesystemAccessOperation,
  type DesktopFilesystemGrant,
  type DesktopFilesystemGrantFilesystemIdentity,
} from "@nautilo/desktop-filesystem-grants";
import {
  type ProfileNetworkPolicy,
  type ProfileNetworkRule,
} from "@nautilo/workstation-profiles";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import { buildProtectedPathPolicy, type ProtectedPathPolicy, type ProtectedPathCategory } from "@nautilo/security";
import {
  dispatchCurrentFolderFamily,
  type CurrentFolderAdoptionPort,
  type CurrentFolderSelectPort,
  type PairedFilesystemDirectoryPort,
} from "./relay-dispatch/current-folder.ts";
import {
  deriveDesktopFilesystemAccessOperation,
  dispatchFilesystem,
  preflightApplyPatch,
  prepareDesktopFilesystemAuthority,
  type DesktopFilesystemAuthority,
  type DesktopFilesystemGrantAuthorityResolver,
} from "./relay-dispatch/desktop-filesystem.ts";
import {
  createLocalFileHandlers,
  type ApplyPatchDispatchPreparation,
  type ApplyPatchTrustedIdentity,
  type CommitDesktopAgentContent,
  type CommitDesktopAgentStructural,
  type CommitDesktopApplyPatch,
  type CommitDesktopHistoryRestore,
  type CommitDesktopOfficeCli,
} from "./relay-dispatch/local-file.ts";
import { createTerminalDispatchHandler } from "./relay-dispatch/terminal.ts";
import {
  captureDesktopFilesystemGrantRootIdentity,
  revalidateDesktopFilesystemGrantRootIdentity,
} from "./desktop-filesystem-grants/identity.ts";
import { DesktopFilesystemGrantStore } from "./desktop-filesystem-grants/store.ts";
import { RunShellOutputArtifactStore } from "./run-shell-output-continuity.ts";
import {
  captureFilePath,
  pruneCaptures,
  visionResultFromPng,
} from "./relay-screen-capture";
import {
  applyPatchExecutionCapability,
} from "./apply-patch-dispatch.ts";
import {
  resolveElectronApplyPatchDesktopRuntime,
} from "./apply-patch-runtime.ts";
import { officeRuntimeCapabilities } from "./office-runtime.ts";
import {
  BrowserPageSnapshotStore,
  type BrowserPageSnapshotOwnerBinding,
} from "./browser-page-snapshot-store.ts";
import {
  BrowserResearchReadExecutor,
  type BrowserResearchReadExecutorDeps,
} from "./browser-research-read-executor.ts";
import { BrowserResearchSearchExecutor } from "./browser-research-search-executor.ts";
import type { BrowserResearchTargetManager } from "./browser-research-target-manager.ts";
import { probeDesktopRipgrep } from "./ripgrep-runtime.ts";
import {
  desktopFilesystemGrantsFilePath,
  desktopRelayIdentityFilePath,
  legacyDesktopFilesystemGrantsFilePath,
} from "./paths";
import {
  readPersistedRelayId,
  resolvePersistedRelayId,
} from "./relay-identity";
import { rebindLegacyLocalFileHistoryRelay } from "./local-file-history/relay-rebind.ts";
import type { ToolRuntimeName } from "./tool-runtime-config";
import {
  spawnSession,
  writeSession,
  readTerminalSince,
  getSessionControl,
  killSession,
  listSessions,
  peekAgentHandoffSession,
  peekBoundAgentTerminalSession,
  consumeAgentHandoffSession,
  acknowledgeAgentHandoffSession,
} from "./terminal-host";
import { resolveTerminalSpawnCwd } from "./terminal-spawn-cwd";
import {
  Sandbox,
  spawnSandboxed,
  type RelayDispatchSandboxFactory,
  hasSandboxCwdFailure,
  sandboxCurrentFolderError,
  unusableCurrentFolderError,
} from "@nautilo/sandbox";
import { createRelayMcpHost } from "@nautilo/mcp-client";
import { mintDesktopSessionId } from "./workstation-access/desktop-session";
import {
  createStructuredSshDispatchRuntime as createMovedStructuredSshDispatchRuntime,
  dispatchStructuredSshFamily,
  prepareStructuredSsh as prepareMovedStructuredSsh,
  resolveStructuredSshReadiness as resolveMovedStructuredSshReadiness,
  type StructuredSshDispatchRuntime,
} from "./relay-dispatch/structured-ssh.ts";
import { dispatchRunShellOutput } from "./relay-dispatch/run-shell-output.ts";
import {
  prepareLocalDispatchPolicy,
  type LocalDispatchPolicyPreparation,
} from "./relay-dispatch/local-dispatch-policy.ts";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  createFixedDesktopDispatchRouter,
  type FixedDesktopDispatchHandlers,
} from "./relay-dispatch/router.ts";
import { createBrowserResearchDispatchHandler } from "./relay-dispatch/browser-research.ts";
import { createInteractiveBrowserDispatchHandler } from "./relay-dispatch/interactive-browser.ts";
import { createGoogleWorkspaceDispatchHandler } from "./relay-dispatch/google-workspace.ts";
import {
  createMediaDispatchHandler,
  type MediaSessionsPort,
} from "./relay-dispatch/media.ts";
import {
  createHueDispatchHandler,
} from "./relay-dispatch/local-applications.ts";
import {
  createWorkstationHandlers,
  type RunShellGitBrokerFactory,
} from "./relay-dispatch/workstation.ts";
import { loginShellSpawnEnvBase } from "./augment-path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  securityScanRelayRequestSchema,
} from "@nautilo/types";
import { DesktopSecurityScanLedger } from "./security-scan/ledger.ts";
import { DesktopSecurityScanCoordinator } from "./security-scan/coordinator.ts";
import {
  createNodeSecurityScannerRuntimeHost,
  PRODUCTION_SECURITY_SCANNER_MANIFEST,
  SecurityScannerRuntimeManager,
} from "./security-scanner-runtime/index.ts";
import { fileURLToPath } from "node:url";
import type {
  ComputerUseHostDispatchResult,
  ComputerUseHostInvocation,
} from "./computer-use/host-dispatch.ts";
import { createDesktopHostedRelayAdapter } from "./relay-hosted-adapters.ts";
import { composeDesktopNonComputerUseCapabilities } from "./relay-capabilities.ts";
import {
  DesktopRelaySession,
  type BrowserCoordinateScalePort,
  type DesktopRelayGoogleOAuthContext,
} from "./desktop-relay-session.ts";
import {
  agentBrowserInstallHint,
  browserDispatchSession,
  browserRuntimeCapabilities,
  clearToolRuntimePath as clearProviderToolRuntimePath,
  ensureAgentBrowserConfig,
  ensureGoogleOAuthClientForDispatch,
  getToolRuntimeStatus as getProviderToolRuntimeStatus,
  gogInstallHint,
  googleWorkspaceRuntimeCapabilities,
  hasPublishedBrowserControlView,
  isGogAuthHealthy,
  openHueExecutor,
  openHueRuntimeCapabilities,
  parsePngIhdrDimensions,
  prepareGoogleWorkspaceKeyring,
  probeFfmpeg,
  refreshToolRuntimeStatus as refreshProviderToolRuntimeStatus,
  relayBinaryResolutionForTests,
  resolveAgentBrowserBin,
  resolveBrowserControlProviderPath,
  resolveElectronIsPackaged,
  resolveElectronPackagingState,
  resolveGogBin,
  resolveOpenHueBin,
  resolveOpenHueDispatchBin,
  resolvePluginRuntimeBin,
  resolveToolsBin,
  setToolRuntimePath as setProviderToolRuntimePath,
  waitForPublishedBrowserControlView,
  type ToolRuntimeStatus,
} from "./relay-provider-runtime.ts";

const execFileAsync = promisify(execFile);

const BROWSER_CAPTURE_DIR = path.join(os.tmpdir(), "nautilo-browser-shots");
const BROWSER_CAPTURE_PREFIX = "nautilo-browser-shot-";
const BROWSER_CAPTURE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const BROWSER_VISION_PNG_MAX_BYTES = 4 * 1024 * 1024;
const GOOGLE_WORKSPACE_EXEC_TIMEOUT_MS = 45_000;
let activeRelaySession: DesktopRelaySession | null = null;

function activeToolRuntimeContext(): {
  context: DesktopRelayGoogleOAuthContext | null;
  isClosed: () => boolean;
} {
  const session = activeRelaySession;
  return {
    context: session?.googleOAuthContext ?? null,
    isClosed: () => session?.closed ?? false,
  };
}

export async function getToolRuntimeStatus(): Promise<Record<ToolRuntimeName, ToolRuntimeStatus>> {
  const { context, isClosed } = activeToolRuntimeContext();
  return getProviderToolRuntimeStatus(context, isClosed);
}

export async function refreshToolRuntimeStatus(): Promise<Record<ToolRuntimeName, ToolRuntimeStatus>> {
  const { context, isClosed } = activeToolRuntimeContext();
  return refreshProviderToolRuntimeStatus(context, isClosed);
}

export async function setToolRuntimePath(
  tool: ToolRuntimeName,
  configuredPath: string,
): Promise<ToolRuntimeStatus> {
  const { context, isClosed } = activeToolRuntimeContext();
  return setProviderToolRuntimePath(tool, configuredPath, context, isClosed);
}

export async function clearToolRuntimePath(tool: ToolRuntimeName): Promise<ToolRuntimeStatus> {
  const { context, isClosed } = activeToolRuntimeContext();
  return clearProviderToolRuntimePath(tool, context, isClosed);
}
/**
 * Lifecycle coordination for a not-yet-connected candidate. This reference
 * publishes no runtime authority: it exists only so stop/handoff can retire
 * exact partially allocated handles and invalidate late connect completion.
 */
let pendingRelayCandidate: {
  readonly generation: number;
  readonly session: DesktopRelaySession;
} | null = null;
let relayLifecycleGeneration = 0;
/** Non-rejecting drain barrier for exact handles detached by overlapping stops. */
let relayRetirementBarrier: Promise<void> = Promise.resolve();

function assertRelayCandidateMayBegin(): void {
  if (activeRelaySession !== null) {
    throw new Error("The active Desktop relay must be stopped before starting another.");
  }
  if (pendingRelayCandidate !== null) {
    throw new Error("A Desktop relay candidate is already starting.");
  }
}

function beginPendingRelayCandidate(session: DesktopRelaySession): number {
  assertRelayCandidateMayBegin();
  const generation = ++relayLifecycleGeneration;
  pendingRelayCandidate = { generation, session };
  return generation;
}

function isCurrentRelayCandidate(
  session: DesktopRelaySession,
  generation: number,
): boolean {
  return !session.closed &&
    relayLifecycleGeneration === generation &&
    pendingRelayCandidate?.generation === generation &&
    pendingRelayCandidate.session === session;
}

function assertCurrentRelayCandidate(
  session: DesktopRelaySession,
  generation: number,
): void {
  if (!isCurrentRelayCandidate(session, generation)) {
    throw new Error("Desktop relay start was superseded.");
  }
}

async function connectAndActivateRelayCandidate(input: {
  readonly session: DesktopRelaySession;
  readonly generation: number;
  readonly connect: () => Promise<void>;
  readonly activate: () => void;
}): Promise<boolean> {
  await input.connect();
  if (!isCurrentRelayCandidate(input.session, input.generation)) return false;
  pendingRelayCandidate = null;
  input.activate();
  return true;
}

/**
 * Non-owning identity alias retained only for the byte-stable Computer Use
 * topology callbacks below. DesktopRelaySession owns and closes the publisher.
 */
let capabilityPublisher: RelayCapabilityPublisher | null = null;

/** Structural view of the redacted wire snapshot; the relay package owns its schema. */
export interface DesktopAutomationCapabilitySnapshot {
  readonly enabled: true;
  readonly agentId: string;
  readonly installationEpoch: string;
  readonly grantGeneration: number;
  readonly provider: "cua";
  readonly providerGeneration: string;
  readonly hostContracts?: RelayCapabilities["computerUseHostContracts"];
}

/**
 * One projection owns both the Cua readiness bit and the exact
 * semantic authority snapshot. This makes the invalid state
 * `canControlDesktop: true` without a current Cua snapshot unrepresentable by
 * the Desktop capability builder.
 */
export function projectComputerUseRelayCapabilities(
  snapshot: DesktopAutomationCapabilitySnapshot | undefined,
): Pick<RelayCapabilities, "canControlDesktop" | "desktopAutomation" | "computerUseHostContracts"> {
  return snapshot === undefined
    ? { canControlDesktop: false }
    : {
        canControlDesktop: true,
        desktopAutomation: {
          enabled: snapshot.enabled, agentId: snapshot.agentId,
          installationEpoch: snapshot.installationEpoch, grantGeneration: snapshot.grantGeneration,
          provider: snapshot.provider, providerGeneration: snapshot.providerGeneration,
        },
        ...(snapshot.hostContracts === undefined ? {} : { computerUseHostContracts: snapshot.hostContracts }),
      };
}

interface AuthenticatedDesktopTopology {
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly pairingGeneration: string;
  readonly desktopSessionId: string;
  readonly selectedProtocolVersion: number;
  readonly capabilityRevision: number;
}

/** exact current Electron relay topology.  This is not a grant. */
export interface ComputerUseDispatchRuntime {
  readonly instanceId: string;
  readonly humanUserId: string;
  readonly serverBindingId: string;
  readonly relayId: string;
  readonly pairingGeneration: string;
  readonly desktopSessionId: string;
}

export function projectComputerUseDispatchRuntime(input: {
  readonly topology: AuthenticatedDesktopTopology | null;
  readonly serverBindingId: string | null;
  readonly instanceId: string;
  readonly humanUserId: string;
}): ComputerUseDispatchRuntime | null {
  const { topology } = input;
  if (topology === null
    || input.serverBindingId === null
    || topology.selectedProtocolVersion < RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION) return null;
  return {
    instanceId: input.instanceId,
    humanUserId: input.humanUserId,
    serverBindingId: input.serverBindingId,
    relayId: topology.relayId,
    pairingGeneration: topology.pairingGeneration,
    desktopSessionId: topology.desktopSessionId,
  };
}

/**
 * A capability acknowledgement advances only the Relay capability revision;
 * it does not create a new Computer Use authority. Reconcile the durable
 * Computer Use receipt only when the authority identity itself changes.
 */
export function requiresComputerUseTopologyReconciliation(
  previous: ComputerUseDispatchRuntime | null,
  next: ComputerUseDispatchRuntime | null,
): boolean {
  return next !== null && !sameComputerUseRuntimeIdentity(previous, next);
}

let activeComputerUseRuntime: ComputerUseDispatchRuntime | null = null;

export function getActiveComputerUseRuntime(): ComputerUseDispatchRuntime | null {
  return activeComputerUseRuntime;
}

export interface ComputerUseOwnedWorkEntry {
  readonly installationEpoch: string;
  readonly grantGeneration: number;
  readonly abort: () => void;
}

export type ComputerUseOwnedWorkFence =
  | { readonly kind: "exact_grant"; readonly installationEpoch: string; readonly grantGeneration: number }
  | { readonly kind: "installation_epoch_reset"; readonly installationEpoch: string; readonly grantGeneration: number };

/**
 * revocation fence.  An installation-epoch reset follows corrupt or
 * foreign bytes, so the prior epoch is unknowable: every owned Computer use
 * operation must be aborted.  Exact revocation can remain narrowly scoped.
 */
export function cancelComputerUseOwnedWork(
  registry: Map<string, ComputerUseOwnedWorkEntry>,
  fence: ComputerUseOwnedWorkFence,
): void {
  for (const [id, work] of registry) {
    if (fence.kind === "exact_grant"
      && (work.installationEpoch !== fence.installationEpoch
        || work.grantGeneration > fence.grantGeneration)) continue;
    registry.delete(id);
    try { work.abort(); } catch { /* revocation cannot be blocked by provider teardown */ }
  }
}

export function getActiveStructuredSshRuntime(): StructuredSshDispatchRuntime | null {
  return activeRelaySession?.structuredSshRuntime ?? null;
}


/**
 * minimal surface the relay needs from the main-process
 * `ActiveWorkstationProfileController` to advertise the active profile
 * binding. The controller remains the sole owner of profile state; the
 * relay only reads the redacted advisory snapshot.
 */
export interface RelayWorkstationProfileSnapshotProvider {
  getProfileSnapshot(): Promise<RelayWorkstationProfileSnapshot | undefined>;
}

/**
 * minimal surface the relay needs from the
 * main-process `ActiveWorkstationProfileController` to source the COMPLETE
 * active-profile network policy for a plan-bound shell dispatch. Distinct from
 * {@link RelayWorkstationProfileSnapshotProvider}: the snapshot is the redacted
 * wire advertisement (only `networkMode`); this provider exposes the full
 * `mode + allow` policy that the relay converts into the sandbox envelope's
 * `networkPolicy`, REPLACING the server's value. The policy never crosses the
 * wire — it is consumed relay-local only. `null`/`undefined` when no profile is
 * bound; the shell-binding resolver fails closed in that case rather than
 * falling back to the server envelope's network posture.
 */
export interface RelayWorkstationProfileNetworkPolicyProvider {
  getActiveNetworkPolicy(): Promise<ProfileNetworkPolicy | null | undefined>;
}

/**
 * the shared main-process
 * `ActiveWorkstationProfileController` implements BOTH the redacted snapshot
 * provider and the complete network-policy provider. `StartRelayOptions` types
 * it as the snapshot provider (the wire-advertisement surface); this helper
 * narrows the SAME controller object to the network-policy provider when it
 * exposes `getActiveNetworkPolicy`, so the shell-binding resolver can source
 * the complete active-profile network policy without a second wiring seam or a
 * duplicate profile store. Returns `null` when the object is not a network
 * provider (headless relay / stubs that only advertise the snapshot).
 */
export function asRelayWorkstationProfileNetworkPolicyProvider(
  provider: RelayWorkstationProfileSnapshotProvider | null | undefined,
): RelayWorkstationProfileNetworkPolicyProvider | null {
  if (provider === null || provider === undefined) return null;
  if (
    typeof (provider as { getActiveNetworkPolicy?: unknown }).getActiveNetworkPolicy === "function"
  ) {
    return provider as unknown as RelayWorkstationProfileNetworkPolicyProvider;
  }
  return null;
}

/**
 * resolves the active-profile advertisement for the capability
 * builder. Returns `undefined` when no provider is bound or the provider
 * has no active profile, so the relay OMITS `workstationProfileSnapshot`
 * rather than advertising a partial or misleading binding. A provider that
 * throws is treated as "no snapshot" so a controller error never tears down
 * an otherwise-valid capability update — the binding simply disappears
 * until the controller recovers, and the live compiled-profile authority on
 * the relay remains final either way.
 */
export async function resolveDesktopProfileAdvertisement(
  provider: RelayWorkstationProfileSnapshotProvider | null | undefined,
): Promise<RelayWorkstationProfileSnapshot | undefined> {
  if (!provider) return undefined;
  try {
    return await provider.getProfileSnapshot();
  } catch {
    return undefined;
  }
}

/**
 * return the existing stable desktop relay id without creating one.
 *
 * Grant creation must bind to the same persisted id that `startRelay` uses,
 * but it must not manufacture relay identity before the relay has been
 * initialized. `null` therefore means the desktop relay identity is not
 * available yet.
 */
export function getPersistedDesktopRelayId(): string | null {
  return readPersistedRelayId(desktopRelayIdentityFilePath());
}

// ── local desktop-filesystem-grant authority resolution ────────────────────
//
// A dispatch may carry an optional `desktopFilesystemGrantRequest` (protocol v6).
// That field is an UNTRUSTED server mirror: its `requestedRoot`, policy
// reference, and (server-side) grant records can NEVER create local authority.
// This resolver reloads the live LOCAL grants for the subject, binds them to
// this relay's configured id, revalidates the selected root's filesystem
// identity immediately before use, authorizes the concrete operation via
// `guardDesktopFilesystemOperation`, and enforces the protected-path policy. Only the
// validated root(s) — plus explicit baseline authorities — become filesystem
// authority; the server's `allowedRoots` are dropped for the local grant path.

/** Minimal live-grant store surface the resolver depends on (see `DesktopFilesystemGrantStore.list`). */
export interface DesktopFilesystemGrantAuthorityStore {
  list(input: { userId: string; includeHistory?: boolean }): Promise<
    | {
        ok: true;
        data: {
          grants: ReadonlyArray<{
            grant: DesktopFilesystemGrant;
            status: "active" | "revoked" | "expired";
          }>;
          revision?: number;
        };
      }
    | { ok: false; code: string; message: string }
  >;
}

export async function resolveGitWritableGrantRoots(options: {
  readonly store: DesktopFilesystemGrantAuthorityStore;
  readonly expectedSubject: {
    readonly userId: string;
    readonly instanceId: string;
    readonly relayId: string;
    readonly agentScope: string;
  };
  readonly now?: () => Date;
}): Promise<readonly string[]> {
  const listed = await options.store.list({
    userId: options.expectedSubject.userId,
    includeHistory: false,
  });
  if (!listed.ok) return [];
  const now = options.now?.() ?? new Date();
  const roots: string[] = [];
  for (const item of listed.data.grants) {
    const grant = item.grant;
    if (
      item.status !== "active" ||
      grant.revokedAt !== undefined ||
      (grant.expiresAt !== undefined && new Date(grant.expiresAt) <= now) ||
      grant.subject.userId !== options.expectedSubject.userId ||
      grant.subject.instanceId !== options.expectedSubject.instanceId ||
      grant.subject.relayId !== options.expectedSubject.relayId ||
      grant.subject.agentScope !== options.expectedSubject.agentScope ||
      !grant.access.includes("create_modify") ||
      !grant.access.includes("delete") ||
      grant.filesystemIdentity === undefined
    ) {
      continue;
    }
    const identity = await revalidateDesktopFilesystemGrantRootIdentity(grant.filesystemIdentity);
    if (identity.ok) roots.push(grant.canonicalRoot);
  }
  return [...new Set(roots)].sort((a, b) => b.length - a.length);
}

export interface DesktopFilesystemGrantAuthorityResolverOptions {
  readonly store: DesktopFilesystemGrantAuthorityStore;
  /** Every requested and locally held grant must bind to this local identity. */
  readonly expectedSubject: {
    readonly userId: string;
    readonly instanceId: string;
    readonly relayId: string;
    readonly agentScope: string;
  };
  readonly protectedPathPolicy: ProtectedPathPolicy;
  /** Injected for tests; defaults to real filesystem identity revalidation. */
  readonly revalidateIdentity?: typeof revalidateDesktopFilesystemGrantRootIdentity;
  /** Injected clock keeps lifetime checks deterministic. */
  readonly now?: () => Date;
}

function protectedPathDenied(policy: ProtectedPathPolicy, candidate: string): boolean {
  return !policy.check(candidate).allowed;
}

/**
 * Builds a resolver bound to a live grant store + this relay's id + a
 * protected-path policy. Production wires this from the Electron
 * `DesktopFilesystemGrantStore`; tests inject an in-memory store or a stub.
 */
export function createDesktopFilesystemGrantAuthorityResolver(
  options: DesktopFilesystemGrantAuthorityResolverOptions,
): DesktopFilesystemGrantAuthorityResolver {
  const revalidateIdentity =
    options.revalidateIdentity ?? revalidateDesktopFilesystemGrantRootIdentity;

  return async function resolve(input) {
    const { request } = input;
    // No envelope means no local grant authority has been requested. In particular,
    // never turn the local grant list into authority merely because it exists.
    if (request === undefined) return { ok: true, hasAuthority: false, roots: [] };
    // Untrusted mirror: an undeterminable concrete operation must never default
    // to `read`. Reject rather than guess.
    const requestedOperations = input.concreteOperations === undefined
      ? input.concreteOperation === null
        ? []
        : [input.concreteOperation]
      : [...new Set(input.concreteOperations)];
    if (requestedOperations.length === 0 || requestedOperations.some((operation) => !DESKTOP_FILESYSTEM_ACCESS_OPERATIONS.includes(operation))) {
      return { ok: false, code: "DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID" };
    }
    // Bind the server reference to the complete local identity before touching
    // disk. A partial relay-id comparison would allow cross-user/agent replay.
    if (
      request.subject.userId !== options.expectedSubject.userId ||
      request.subject.instanceId !== options.expectedSubject.instanceId ||
      request.subject.relayId !== options.expectedSubject.relayId ||
      request.subject.agentScope !== options.expectedSubject.agentScope
    ) {
      return { ok: false, code: "SUBJECT_MISMATCH" };
    }
    if (
      (input.concreteOperations === undefined && request.operation !== input.concreteOperation) ||
      (input.concreteOperations !== undefined &&
        (request.requiredOperations === undefined ||
          request.requiredOperations.length !== requestedOperations.length ||
          requestedOperations.some((operation) => !request.requiredOperations!.includes(operation)) ||
          request.requiredOperations.some((operation) => !requestedOperations.includes(operation))))
    ) {
      return { ok: false, code: "OPERATION_UPGRADE" };
    }

    // Reload live LOCAL grants for the subject user. Server-sent grant records
    // are ignored; only locally held, schema-validated grants are authority.
    let listed: Awaited<ReturnType<DesktopFilesystemGrantAuthorityStore["list"]>>;
    try {
      listed = await options.store.list({
        userId: options.expectedSubject.userId,
        includeHistory: true,
      });
    } catch {
      return { ok: false, code: "DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID" };
    }
    if (!listed.ok) {
      return { ok: false, code: "DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID" };
    }

    // Every referenced grant id must still resolve locally; a missing id means
    // the server's reference is stale relative to local authority.
    const byId = new Map(
      listed.data.grants.map((item) => [item.grant.id, item] as const),
    );
    const selectedGrants: DesktopFilesystemGrant[] = [];
    const now = options.now?.() ?? new Date();
    for (const id of request.grantIds) {
      const item = byId.get(id);
      if (item === undefined) return { ok: false, code: "DESKTOP_FILESYSTEM_GRANT_STALE" };
      if (item.status === "revoked") return { ok: false, code: "REVOKED" };
      if (item.status === "expired") return { ok: false, code: "EXPIRED" };
      if (
        item.grant.subject.userId !== options.expectedSubject.userId ||
        item.grant.subject.instanceId !== options.expectedSubject.instanceId ||
        item.grant.subject.relayId !== options.expectedSubject.relayId ||
        item.grant.subject.agentScope !== options.expectedSubject.agentScope
      ) {
        return { ok: false, code: "SUBJECT_MISMATCH" };
      }
      if (item.grant.revokedAt !== undefined) return { ok: false, code: "REVOKED" };
      if (
        item.grant.expiresAt !== undefined &&
        Date.parse(item.grant.expiresAt) <= now.getTime()
      ) {
        return { ok: false, code: "EXPIRED" };
      }
      if (
        item.grant.policyVersion !== request.policy.policyVersion ||
        item.grant.lifetime !== request.policy.lifetime ||
        (item.grant.expiresAt ?? undefined) !== (request.policy.expiresAt ?? undefined)
      ) {
        return { ok: false, code: "DESKTOP_FILESYSTEM_GRANT_STALE" };
      }
      selectedGrants.push(item.grant);
    }

    // Authorize the concrete operation against the requested root using local
    // authority only. `guardDesktopFilesystemOperation` owns subject binding, expiry,
    // revocation, root-containment, and operation-subset checks.
    const guardResults = [] as Array<Extract<ReturnType<typeof guardDesktopFilesystemOperation>, { ok: true }>>;
    for (const operation of requestedOperations) {
      const guardResult = guardDesktopFilesystemOperation({
        candidatePath: request.requestedRoot,
        operation,
        grants: selectedGrants,
        subject: options.expectedSubject,
        now,
      });
      if (!guardResult.ok) {
        switch (guardResult.code) {
          case "SUBJECT_MISMATCH": return { ok: false, code: "SUBJECT_MISMATCH" };
          case "REVOKED": return { ok: false, code: "REVOKED" };
          case "EXPIRED": return { ok: false, code: "EXPIRED" };
          case "ROOT_EXPANSION": return { ok: false, code: "ROOT_EXPANSION" };
          case "OPERATION_UPGRADE": return { ok: false, code: "OPERATION_UPGRADE" };
          case "GRANT_NOT_FOUND": return { ok: false, code: "GRANT_NOT_FOUND" };
          default: return { ok: false, code: "DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID" };
        }
      }
      guardResults.push(guardResult);
    }

    // When a grant (not a baseline) is deciding authority, confirm every
    // selected grant identity immediately before use. A mixed patch cannot
    // inherit an unchecked operation from a different grant.
    for (const grantId of new Set(guardResults.map((result) => result.grantId).filter(Boolean))) {
      const grant = byId.get(grantId!)?.grant;
      if (grant === undefined) return { ok: false, code: "DESKTOP_FILESYSTEM_GRANT_STALE" };
      const identity: DesktopFilesystemGrantFilesystemIdentity | undefined = grant.filesystemIdentity;
      if (identity !== undefined && !(await revalidateIdentity(identity)).ok) {
        return { ok: false, code: "IDENTITY_MISMATCH" };
      }
    }

    // Resolve the concrete requested root after all reference/grant semantics
    // have been validated but before protected-path admission. A lexical path
    // inside a broad grant can be a symlink to a protected location; returning
    // the alias would let downstream realpath-based guards see authority this
    // local decision never approved.
    let canonicalRequestedRoot: string;
    try {
      canonicalRequestedRoot = fsSync.realpathSync(request.requestedRoot);
    } catch {
      return { ok: false, code: "DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID" };
    }
    for (const operation of requestedOperations) {
      const canonicalGuard = guardDesktopFilesystemOperation({
        candidatePath: canonicalRequestedRoot,
        operation,
        grants: selectedGrants,
        subject: options.expectedSubject,
        now,
      });
      if (!canonicalGuard.ok) {
        return {
          ok: false,
          code: canonicalGuard.code === "ROOT_EXPANSION"
            ? "ROOT_EXPANSION"
            : "DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID",
        };
      }
    }

    // Protected-path policy is a hard deny regardless of grant authority.
    // A broad grant root (including `/`) may contain both safe Current Folders
    // and protected descendants. Reject the concrete requested root when it
    // reaches or contains a protected path; do not reject an otherwise valid
    // safe target merely because its containing grant is broad. The sandbox
    // still compiles the complete protected-path deny mask after local grant
    // resolution, and apply_patch remains rooted at requestedRoot.
    if (protectedPathDenied(options.protectedPathPolicy, canonicalRequestedRoot)) {
      return { ok: false, code: "PROTECTED_PATH" };
    }

    return {
      ok: true,
      hasAuthority: true,
      // The broad local grant proves containment, but dispatch authority is
      // narrowed to the exact server-referenced root that was just checked
      // against protected paths. Generic fs/local-file callers therefore
      // cannot pair a safe requestedRoot with an operation elsewhere beneath
      // a broad grant, and apply_patch receives only its Current Folder.
      roots: [canonicalRequestedRoot],
      operation: requestedOperations[0]!,
      grantIds: [...new Set(guardResults.map((result) => result.grantId ?? result.authorityId))],
    };
  };
}

// ── local Current Folder shell authority ────────────────────────────
//
// A profile session intentionally binds only its compiled policy-pack grants.
// Once the plan binding itself has been locally revalidated, its exact Current
// Folder is a transient project baseline: it is not a second persisted grant.
// A matching *durable* additional grant still wins, however, so a more-specific
// read-only/revoked/foreign grant can never be bypassed by that baseline. The
// returned path is always the exact canonical folder, never a broad parent root.

export type LocalShellWorkspaceAuthorityResolution =
  | { readonly ok: true; readonly workspace: string }
  | {
      readonly ok: false;
      readonly code:
        | "WORKSTATION_SHELL_WORKSPACE_UNAVAILABLE"
        | "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED"
        | "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH"
        | "WORKSTATION_SHELL_WORKSPACE_PROTECTED";
    };

export type LocalShellWorkspaceAuthorityResolver = (
  candidate: string,
) => Promise<LocalShellWorkspaceAuthorityResolution>;

export interface LocalShellWorkspaceAuthorityResolverOptions {
  readonly store: DesktopFilesystemGrantAuthorityStore;
  readonly expectedSubject: {
    readonly userId: string;
    readonly instanceId: string;
    readonly relayId: string;
    readonly agentScope: string;
  };
  readonly protectedPathPolicy: ProtectedPathPolicy;
  readonly revalidateIdentity?: typeof revalidateDesktopFilesystemGrantRootIdentity;
}

export function createLocalShellWorkspaceAuthorityResolver(
  options: LocalShellWorkspaceAuthorityResolverOptions,
): LocalShellWorkspaceAuthorityResolver {
  const revalidateIdentity =
    options.revalidateIdentity ?? revalidateDesktopFilesystemGrantRootIdentity;
  // This is intentionally process-local and exact-root keyed. It is reachable
  // only after the handler has revalidated the binding/profile tuple, and is
  // never serialized into the Desktop Filesystem Grant store.
  let currentFolderBaseline:
    | {
        readonly canonicalRoot: string;
        readonly filesystemIdentity: DesktopFilesystemGrantFilesystemIdentity;
        /** Keeps the selected inode alive so an unlinked root cannot reuse it. */
        readonly pinnedDescriptor: number;
        readonly device: number;
        readonly inode: number;
      }
    | undefined;

  const pinWorkspace = (canonicalRoot: string) => {
    let descriptor: number | undefined;
    try {
      descriptor = fsSync.openSync(canonicalRoot, fsSync.constants.O_RDONLY);
      const stat = fsSync.fstatSync(descriptor);
      if (
        !stat.isDirectory() ||
        !Number.isSafeInteger(stat.dev) || stat.dev < 0 ||
        !Number.isSafeInteger(stat.ino) || stat.ino < 0
      ) {
        fsSync.closeSync(descriptor);
        return undefined;
      }
      return { pinnedDescriptor: descriptor, device: stat.dev, inode: stat.ino };
    } catch {
      if (descriptor !== undefined) {
        try { fsSync.closeSync(descriptor); } catch { /* already unavailable */ }
      }
      return undefined;
    }
  };

  const matchesPinnedWorkspace = (
    baseline: NonNullable<typeof currentFolderBaseline>,
  ): boolean => {
    try {
      const pinned = fsSync.fstatSync(baseline.pinnedDescriptor);
      const live = fsSync.statSync(baseline.canonicalRoot);
      return pinned.isDirectory() &&
        live.isDirectory() &&
        pinned.dev === baseline.device &&
        pinned.ino === baseline.inode &&
        live.dev === baseline.device &&
        live.ino === baseline.inode;
    } catch {
      return false;
    }
  };

  return async function resolve(candidate) {
    let workspace: string;
    try {
      workspace = fsSync.realpathSync(candidate);
      if (!fsSync.statSync(workspace).isDirectory()) {
        return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_UNAVAILABLE" };
      }
    } catch {
      return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_UNAVAILABLE" };
    }

    let listed: Awaited<ReturnType<DesktopFilesystemGrantAuthorityStore["list"]>>;
    try {
      listed = await options.store.list({
        userId: options.expectedSubject.userId,
        includeHistory: true,
      });
    } catch {
      return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED" };
    }
    if (!listed.ok) {
      return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED" };
    }

    // A broad durable root such as `/` may legitimately contain protected
    // descendants. The shell receives only `workspace`, so enforce the hard
    // deny against that exact canonical path rather than rejecting every
    // safe child of an otherwise broad user grant.
    if (protectedPathDenied(options.protectedPathPolicy, workspace)) {
      return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_PROTECTED" };
    }

    // An explicit *durable* grant containing the Current Folder constrains the
    // transient baseline. Keep the most-specific scope even when it only has
    // history, so revocation cannot fall back to a broader grant or baseline.
    // An active explicit grant at that same scope can restore access. Policy-pack
    // grants remain profile roots rather than duplicate project grants.
    const containingDurable = listed.data.grants.filter((item) =>
      item.grant.lifetime === "durable" &&
      isPathWithinDesktopFilesystemGrantRoot(item.grant.canonicalRoot, workspace),
    );
    const longestRootLength = containingDurable.reduce(
      (longest, item) => Math.max(longest, item.grant.canonicalRoot.length),
      -1,
    );
    const decisiveDurable = containingDurable.filter(
      (item) => item.grant.canonicalRoot.length === longestRootLength,
    );
    if (decisiveDurable.length > 0) {
      const now = new Date();
      const active = decisiveDurable.filter(({ grant, status }) =>
        status === "active" && grant.revokedAt === undefined &&
        (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now.getTime()),
      );
      if (active.length === 0) {
        return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED" };
      }
      for (const { grant } of active) {
        const subject = grant.subject;
        if (
          subject.userId !== options.expectedSubject.userId ||
          subject.instanceId !== options.expectedSubject.instanceId ||
          subject.relayId !== options.expectedSubject.relayId ||
          subject.agentScope !== options.expectedSubject.agentScope ||
          !grant.access.includes("create_modify") ||
          !grant.access.includes("execute") ||
          grant.filesystemIdentity === undefined
        ) {
          return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED" };
        }
        const identity = await revalidateIdentity(grant.filesystemIdentity);
        if (!identity.ok) {
          return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH" };
        }
      }
      for (const historical of decisiveDurable) {
        if (active.includes(historical)) continue;
        const old = historical.grant;
        // Revocation is per grant ID. It must not revoke an independently
        // active grant at the exact same root and complete subject, regardless
        // of creation order. A broader or foreign grant is not a replacement.
        const replaced = active.some(({ grant }) =>
          grant.canonicalRoot === old.canonicalRoot &&
          grant.subject.userId === old.subject.userId &&
          grant.subject.instanceId === old.subject.instanceId &&
          grant.subject.relayId === old.subject.relayId &&
          grant.subject.agentScope === old.subject.agentScope,
        );
        if (!replaced) {
          return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED" };
        }
      }
      return { ok: true, workspace };
    }

    // No explicit durable project grant contains this folder. Capture the
    // selected canonical Current Folder once, then revalidate that exact
    // identity immediately before every later privileged use. A replacement or
    // symlink swap cannot turn into a new baseline merely because `realpath`
    // now resolves somewhere else: when the selected canonical root is
    // unchanged, the prior identity must still validate first.
    if (currentFolderBaseline !== undefined && candidate === currentFolderBaseline.canonicalRoot) {
      const identity = await revalidateIdentity(currentFolderBaseline.filesystemIdentity);
      if (
        !identity.ok ||
        identity.canonicalRoot !== currentFolderBaseline.canonicalRoot ||
        !matchesPinnedWorkspace(currentFolderBaseline)
      ) {
        return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH" };
      }
      if (workspace !== currentFolderBaseline.canonicalRoot) {
        return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH" };
      }
      return { ok: true, workspace };
    }
    if (currentFolderBaseline !== undefined && workspace === currentFolderBaseline.canonicalRoot) {
      const identity = await revalidateIdentity(currentFolderBaseline.filesystemIdentity);
      if (
        !identity.ok ||
        identity.canonicalRoot !== currentFolderBaseline.canonicalRoot ||
        !matchesPinnedWorkspace(currentFolderBaseline)
      ) {
        return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH" };
      }
      return { ok: true, workspace };
    }
    const captured = await captureDesktopFilesystemGrantRootIdentity(candidate);
    if (!captured.ok || captured.canonicalRoot !== workspace) {
      return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH" };
    }
    const pinned = pinWorkspace(captured.canonicalRoot);
    if (pinned === undefined) {
      return { ok: false, code: "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH" };
    }
    if (currentFolderBaseline !== undefined) {
      try { fsSync.closeSync(currentFolderBaseline.pinnedDescriptor); } catch { /* already unavailable */ }
    }
    currentFolderBaseline = {
      canonicalRoot: captured.canonicalRoot,
      filesystemIdentity: captured.filesystemIdentity,
      ...pinned,
    };
    return { ok: true, workspace };
  };
}

// ── plan-bound shell-binding local revalidation ──────────
//
// A generic `run_shell` dispatch may carry an optional `workstationShellBinding`
// (protocol v7). The envelope is an UNTRUSTED server mirror of the plan binding
// tuple; it carries NO roots and NO filesystem authority — only the opaque
// ids / binding / operation metadata the desktop relay needs to prove the
// dispatch maps to the active profile/session grant authority. This resolver
// revalidates every provable field against the relay's live Electron state
// (relay id, per-launch desktop session id, last advertised capability
// revision, active profile binding, expected subject) and the live local grant
// store. Only on success may the dispatch use profile-bound roots (the live
// grants' canonical roots). A stale, revoked, foreign, or mismatched
// relay/profile/session reference fails closed with a stable denial code.
//
// `serverBindingId` and `toolCallId` are server-side correlation ids carried
// opaquely; the relay does not revalidate them locally (they are
// server-authoritative). The server's `allowedRoots` / `sandboxProfile` are
// never authority for the binding — they remain the sandbox envelope,
// unchanged. Non-Full-Mode dispatches (no envelope) skip this path entirely.

export type WorkstationShellBindingRevalidationFailureCode =
  | "WORKSTATION_SHELL_BINDING_INVALID"
  | "WORKSTATION_SHELL_BINDING_UNCONFIGURED"
  | "RELAY_MISMATCH"
  | "DESKTOP_SESSION_MISMATCH"
  | "CAPABILITY_REVISION_MISMATCH"
  | "PROFILE_BINDING_MISMATCH"
  | "CURRENT_FOLDER_MISMATCH"
  | "GRANT_REVISION_MISMATCH"
  | "PROTECTED_POLICY_VERSION_MISMATCH"
  | "SUBJECT_MISMATCH"
  | "OPERATION_MISMATCH"
  | "GRANT_STALE"
  | "GRANT_REVOKED"
  | "GRANT_EXPIRED"
  | "GRANT_SUBJECT_MISMATCH"
  | "GRANT_OPERATION_UPGRADE"
  | "IDENTITY_MISMATCH"
  | "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNAVAILABLE"
  | "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNREPRESENTABLE";

export type WorkstationShellBindingRevalidationResult =
  | {
      readonly ok: true;
      /** Profile-bound roots from the live, revalidated grants (most specific first). */
      readonly roots: readonly string[];
      /** Grant roots with read and/or execute access, mounted read-only. */
      readonly readOnlyRoots: readonly string[];
      /** Only create_modify/delete grants may produce writable roots. */
      readonly writableRoots: readonly string[];
      readonly grantIds: readonly string[];
    }
  | { readonly ok: false; readonly code: WorkstationShellBindingRevalidationFailureCode };

/**
 * the resolver-level resolution: the pure revalidation
 * result PLUS the complete network policy sourced from the Electron-main
 * active profile and converted to the wire/sandbox shape. The network policy
 * is ALWAYS present on a successful resolution (the resolver fails closed when
 * it cannot be sourced or converted); the dispatch handler REPLACES the
 * server envelope's `networkPolicy` with it when rebuilding the sandbox
 * envelope for the plan-bound shell.
 */
export type WorkstationShellBindingResolution =
  | {
      readonly ok: true;
      readonly roots: readonly string[];
      readonly readOnlyRoots: readonly string[];
      readonly writableRoots: readonly string[];
      readonly grantIds: readonly string[];
      readonly networkPolicy: RelayNetworkPolicy;
    }
  | { readonly ok: false; readonly code: WorkstationShellBindingRevalidationFailureCode };

export interface WorkstationShellBindingAuthorityResolverInput {
  readonly binding: RelayWorkstationShellBinding;
  /** Concrete operation derived from the dispatch (`"execute"` for run_shell). */
  readonly concreteOperation: DesktopFilesystemAccessOperation | null;
}

export type WorkstationShellBindingAuthorityResolver = (
  input: WorkstationShellBindingAuthorityResolverInput,
) => Promise<WorkstationShellBindingResolution>;

export interface WorkstationShellBindingAuthorityResolverOptions {
  /** Live local grant store (same store the grant-authority resolver reads). */
  readonly store: DesktopFilesystemGrantAuthorityStore;
  /** This relay's persisted id. */
  readonly expectedRelayId: string;
  /** This relay's per-launch desktop session id. */
  readonly expectedDesktopSessionId: string;
  /** This relay's last successfully advertised capability revision. */
  readonly getCapabilityRevision: () => number;
  /**
   * Electron's live selected Current Folder. A profile-bound
   * resolver without this provider fails closed; non-profile dispatches never
   * invoke this resolver and retain baseline compatibility.
   */
  readonly getCurrentFolder?: () => string | undefined;
  /** The shared main-process active-profile snapshot provider. */
  readonly profileProvider: RelayWorkstationProfileSnapshotProvider;
  /**
   * the shared main-process active-profile NETWORK
   * POLICY provider. The resolver sources the complete active-profile network
   * policy from here and converts it into the sandbox envelope's
   * `networkPolicy`, REPLACING the server's value. When omitted or unavailable
   * the resolver fails closed (`WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNAVAILABLE`)
   * rather than letting the server envelope's network posture stand.
   */
  readonly networkPolicyProvider?: RelayWorkstationProfileNetworkPolicyProvider;
  /** The expected local subject the binding must match exactly. */
  readonly expectedSubject: RelayWorkstationShellBindingSubject;
  /** Injected clock for deterministic expiry checks. */
  readonly now?: () => Date;
  /** Revalidates every selected grant's filesystem identity immediately before use. */
  readonly revalidateIdentity?: typeof revalidateDesktopFilesystemGrantRootIdentity;
}

/**
 * Pure revalidation of a plan-bound shell binding against the live Electron
 * authority/profile state. Exported for unit testing; production wires it via
 * {@link createWorkstationShellBindingAuthorityResolver}.
 */
export function revalidateWorkstationShellBinding(
  input: {
    readonly binding: RelayWorkstationShellBinding;
    readonly concreteOperation: DesktopFilesystemAccessOperation | null;
    readonly expectedRelayId: string;
    readonly expectedDesktopSessionId: string;
    readonly expectedCapabilityRevision: number;
    readonly liveProfile: {
      readonly profileId: string;
      readonly profileRevision: number;
      readonly protectedPolicyVersion?: number;
    } | null;
    readonly liveGrantRevision?: number;
    readonly expectedSubject: RelayWorkstationShellBindingSubject;
    readonly grants: ReadonlyArray<{
      grant: DesktopFilesystemGrant;
      status: "active" | "revoked" | "expired";
    }>;
    readonly now?: () => Date;
  },
): WorkstationShellBindingRevalidationResult {
  const { binding } = input;
  // An undeterminable concrete operation must never default to a value —
  // reject rather than guess.
  if (input.concreteOperation === null) {
    return { ok: false, code: "WORKSTATION_SHELL_BINDING_INVALID" };
  }
  if (binding.operation !== input.concreteOperation) {
    return { ok: false, code: "OPERATION_MISMATCH" };
  }
  if (binding.relayId !== input.expectedRelayId) {
    return { ok: false, code: "RELAY_MISMATCH" };
  }
  if (binding.desktopSessionId !== input.expectedDesktopSessionId) {
    return { ok: false, code: "DESKTOP_SESSION_MISMATCH" };
  }
  if (binding.capabilityRevision !== input.expectedCapabilityRevision) {
    return { ok: false, code: "CAPABILITY_REVISION_MISMATCH" };
  }
  if (
    input.liveProfile === null ||
    input.liveProfile.profileId !== binding.profileId ||
    input.liveProfile.profileRevision !== binding.profileRevision
  ) {
    return { ok: false, code: "PROFILE_BINDING_MISMATCH" };
  }
  const subj = binding.subject;
  const exp = input.expectedSubject;
  if (
    subj.userId !== exp.userId ||
    subj.instanceId !== exp.instanceId ||
    subj.relayId !== exp.relayId ||
    subj.agentScope !== exp.agentScope
  ) {
    return { ok: false, code: "SUBJECT_MISMATCH" };
  }

  const byId = new Map(input.grants.map((item) => [item.grant.id, item] as const));
  const now = input.now?.() ?? new Date();
  const readOnlyRoots: string[] = [];
  const writableRoots: string[] = [];
  for (const id of binding.grantIds) {
    const item = byId.get(id);
    if (item === undefined) return { ok: false, code: "GRANT_STALE" };
    if (item.status === "revoked" || item.grant.revokedAt !== undefined) {
      return { ok: false, code: "GRANT_REVOKED" };
    }
    if (
      item.status === "expired" ||
      (item.grant.expiresAt !== undefined &&
        Date.parse(item.grant.expiresAt) <= now.getTime())
    ) {
      return { ok: false, code: "GRANT_EXPIRED" };
    }
    const gs = item.grant.subject;
    if (
      gs.userId !== exp.userId ||
      gs.instanceId !== exp.instanceId ||
      gs.relayId !== exp.relayId ||
      gs.agentScope !== exp.agentScope
    ) {
      return { ok: false, code: "GRANT_SUBJECT_MISMATCH" };
    }
    // A profile binding is a policy pack, not a request to execute within
    // every mounted grant root. Preserve each grant's own read/write posture
    // below. The exact Current Folder is independently required to have
    // create_modify + execute authority by
    // createLocalShellWorkspaceAuthorityResolver immediately before spawn.
    const root = item.grant.canonicalRoot;
    if (item.grant.access.includes("read") || item.grant.access.includes("execute")) {
      readOnlyRoots.push(root);
    }
    if (
      item.grant.access.includes("create_modify") ||
      item.grant.access.includes("delete")
    ) {
      writableRoots.push(root);
    }
  }
  // Protocol-v2 coherence fields are mandatory on the binding and must be
  // supplied by live local state. Undefined live values fail closed just like
  // an explicit mismatch. These checks happen after grant validity checks so
  // existing stable grant-specific denial codes remain diagnostic.
  if (input.liveGrantRevision !== binding.grantRevision) {
    return { ok: false, code: "GRANT_REVISION_MISMATCH" };
  }
  if (input.liveProfile.protectedPolicyVersion !== binding.protectedPolicyVersion) {
    return { ok: false, code: "PROTECTED_POLICY_VERSION_MISMATCH" };
  }
  // Most specific (longest) root first so the shell cwd is the tightest bound.
  const roots = [...new Set([...readOnlyRoots, ...writableRoots])].sort((a, b) => b.length - a.length);
  return {
    ok: true,
    roots,
    readOnlyRoots: [...new Set(readOnlyRoots)].sort((a, b) => b.length - a.length),
    writableRoots: [...new Set(writableRoots)].sort((a, b) => b.length - a.length),
    grantIds: [...binding.grantIds],
  };
}

/**
 * convert the Electron-main active profile's complete
 * `ProfileNetworkPolicy` into the sandbox/wire `RelayNetworkPolicy` that the
 * per-turn shell sandbox envelope carries. The conversion is STRICT:
 *   - `host`     → `{ mode: "host" }` (exact).
 *   - `isolated` → `{ mode: "isolated" }` (exact).
 *   - `proxy_allowlist` → `{ mode: "proxy-allowlist", allow: [...] }` where
 *     each representable profile rule maps to a wire allow rule:
 *       · `kind: "host"`   → `{ type: "domain", host }` (exact host match).
 *       · `kind: "domain"` → `{ type: "domain", host }` (exact host match).
 *       · `kind: "cidr"`   → `{ type: "cidr", cidr }`.
 *       · `kind: "port"`   → NOT representable (the wire shape has no
 *         port-only allow rule; ports attach to host/domain/cidr rules).
 *         Fail closed rather than silently dropping or widening.
 * The server's `sandboxProfile.config.networkPolicy` is never consulted here —
 * the local profile is the sole authority for the rebuilt envelope's network
 * posture. Returns a typed failure so the resolver can surface a stable
 * fail-closed code without throwing across the dispatch boundary.
 */
export type ProfileNetworkPolicyConversionResult =
  | { readonly ok: true; readonly relay: RelayNetworkPolicy }
  | {
      readonly ok: false;
      readonly code: "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNREPRESENTABLE";
    };

export function profileNetworkPolicyToRelayNetworkPolicy(
  policy: ProfileNetworkPolicy,
): ProfileNetworkPolicyConversionResult {
  if (policy.mode === "host") return { ok: true, relay: { mode: "host" } };
  if (policy.mode === "isolated") return { ok: true, relay: { mode: "isolated" } };
  const allow: RelayNetworkAllowRule[] = [];
  for (const rule of policy.allow) {
    const converted = profileNetworkRuleToRelayNetworkAllowRule(rule);
    if (converted === null) {
      return { ok: false, code: "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNREPRESENTABLE" };
    }
    allow.push(converted);
  }
  return { ok: true, relay: { mode: "proxy-allowlist", allow } };
}

function profileNetworkRuleToRelayNetworkAllowRule(
  rule: ProfileNetworkRule,
): RelayNetworkAllowRule | null {
  switch (rule.kind) {
    case "host":
    case "domain":
      return { type: "domain", host: rule.value };
    case "cidr":
      return { type: "cidr", cidr: rule.value };
    case "port":
      // No wire shape for a port-only allow rule; fail closed.
      return null;
  }
}

/**
 * Builds a resolver bound to a live grant store + this relay's identity + the
 * shared active-profile controller. Production wires this from the Electron
 * `DesktopFilesystemGrantStore` + `ActiveWorkstationProfileController`; tests inject
 * an in-memory store or a stub.
 */
export function createWorkstationShellBindingAuthorityResolver(
  options: WorkstationShellBindingAuthorityResolverOptions,
): WorkstationShellBindingAuthorityResolver {
  const revalidateIdentity =
    options.revalidateIdentity ?? revalidateDesktopFilesystemGrantRootIdentity;
  return async function resolve(input) {
    const liveCurrentFolder = options.getCurrentFolder?.();
    if (
      liveCurrentFolder === undefined ||
      liveCurrentFolder !== input.binding.currentFolder
    ) {
      return { ok: false, code: "CURRENT_FOLDER_MISMATCH" };
    }
    let profile: RelayWorkstationProfileSnapshot | undefined;
    try {
      profile = await options.profileProvider.getProfileSnapshot();
    } catch {
      profile = undefined;
    }
    const liveProfile =
      profile === undefined
        ? null
        : {
            profileId: profile.profileId,
            profileRevision: profile.profileRevision,
            protectedPolicyVersion: profile.protectedPolicyVersion,
          };

    let listed: Awaited<ReturnType<DesktopFilesystemGrantAuthorityStore["list"]>>;
    try {
      listed = await options.store.list({
        userId: options.expectedSubject.userId,
        includeHistory: true,
      });
    } catch {
      return { ok: false, code: "WORKSTATION_SHELL_BINDING_INVALID" };
    }
    if (!listed.ok) {
      return { ok: false, code: "WORKSTATION_SHELL_BINDING_INVALID" };
    }

    const result = revalidateWorkstationShellBinding({
      binding: input.binding,
      concreteOperation: input.concreteOperation,
      expectedRelayId: options.expectedRelayId,
      expectedDesktopSessionId: options.expectedDesktopSessionId,
      expectedCapabilityRevision: options.getCapabilityRevision(),
      liveProfile,
      ...(listed.data.revision !== undefined
        ? { liveGrantRevision: listed.data.revision }
        : {}),
      expectedSubject: options.expectedSubject,
      grants: listed.data.grants,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    if (!result.ok) return result;

    const byId = new Map(listed.data.grants.map((item) => [item.grant.id, item.grant] as const));
    for (const id of result.grantIds) {
      const identity = byId.get(id)?.filesystemIdentity;
      if (identity !== undefined) {
        const revalidation = await revalidateIdentity(identity);
        if (!revalidation.ok) return { ok: false, code: "IDENTITY_MISMATCH" };
      }
    }

    // source the COMPLETE network policy from the
    // Electron-main active profile and convert it to the sandbox/wire shape.
    // The server's sandboxProfile.config.networkPolicy is never authority
    // here; the local profile is the sole source. Fail closed when the
    // provider is absent/unavailable or the policy carries a rule the wire
    // shape cannot represent — a plan-bound shell never falls back to the
    // server envelope's network posture.
    if (options.networkPolicyProvider === undefined) {
      return { ok: false, code: "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNAVAILABLE" };
    }
    let profileNetwork: ProfileNetworkPolicy | null | undefined;
    try {
      profileNetwork = await options.networkPolicyProvider.getActiveNetworkPolicy();
    } catch {
      return { ok: false, code: "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNAVAILABLE" };
    }
    if (profileNetwork === null || profileNetwork === undefined) {
      return { ok: false, code: "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNAVAILABLE" };
    }
    const converted = profileNetworkPolicyToRelayNetworkPolicy(profileNetwork);
    if (!converted.ok) return converted;

    return {
      ok: true,
      roots: result.roots,
      readOnlyRoots: result.readOnlyRoots,
      writableRoots: result.writableRoots,
      grantIds: result.grantIds,
      networkPolicy: converted.relay,
    };
  };
}

/**
 * durable desktop-grant subject scope. This means any Genie agent acting
 * for this already-bound desktop user, instance, and relay. It is not an
 * unbound wildcard: userId, instanceId, and relayId are all exact-match
 * subject fields enforced by the local resolver.
 */
export const DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE = "all_owned_agents";

/**
 * Startup wiring seam for local authority. Production uses the actual
 * Electron instance/grant-state paths; tests may supply only the local-store
 * and path/identity inputs needed to exercise this construction without
 * Electron or a persisted instance file.
 */
export interface StartRelayDesktopFilesystemGrantAuthorityOptions {
  readonly userId: string;
  readonly relayId: string;
  readonly store?: DesktopFilesystemGrantAuthorityStore;
  readonly instanceId?: string;
  readonly userHome?: string;
  readonly nautiloRoot?: string;
  readonly grantsFilePath?: string;
}

export function createStartRelayDesktopFilesystemGrantAuthority(
  options: StartRelayDesktopFilesystemGrantAuthorityOptions,
): DesktopFilesystemGrantAuthorityResolver {
  // Match the Electron app's instance convention (`resolveInstance()`), so
  // the store envelope and the grant's subject bind to the same local instance.
  const instanceId = options.instanceId ?? resolveInstance().instanceId;
  const store =
    options.store ??
    new DesktopFilesystemGrantStore({
      instanceId,
      filePath: options.grantsFilePath ?? desktopFilesystemGrantsFilePath(),
      legacyFilePath: legacyDesktopFilesystemGrantsFilePath(),
    });
  const userHome = options.userHome ?? os.homedir();
  const nautiloRoot = options.nautiloRoot ?? resolveNautiloRootDir();

  return createDesktopFilesystemGrantAuthorityResolver({
    store,
    expectedSubject: {
      userId: options.userId,
      instanceId,
      relayId: options.relayId,
      agentScope: DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE,
    },
    protectedPathPolicy: buildProtectedPathPolicy({
      homeDir: userHome,
      platform: process.platform,
      nautiloRoots: {
        privateRoot: path.join(nautiloRoot, "private"),
        dataRoot: path.join(nautiloRoot, "data"),
        auditRoot: path.join(nautiloRoot, "audit"),
      },
    }),
  });
}

/**
 * Minimal live-store surface the advisory snapshot builder needs. It mirrors
 * `DesktopFilesystemGrantStore.list`, which additionally returns the store `revision`
 * so the snapshot can advertise a monotonic generation.
 */
export interface DesktopFilesystemGrantSnapshotStore {
  list(input: { userId: string; includeHistory?: boolean }): Promise<
    | {
        ok: true;
        data: {
          grants: ReadonlyArray<{
            grant: DesktopFilesystemGrant;
            status: "active" | "revoked" | "expired";
          }>;
          revision: number;
        };
      }
    | { ok: false; code: string; message: string }
  >;
}

export interface BuildDesktopFilesystemGrantSnapshotOptions {
  readonly store: DesktopFilesystemGrantSnapshotStore;
  readonly userId: string;
  readonly instanceId: string;
  readonly relayId: string;
}

/**
 * build the advisory active-grant snapshot from the SAME local
 * `DesktopFilesystemGrantStore` the production resolver reads. The snapshot is
 * discovery data only and NEVER authority: the relay-local resolver reloads the
 * live store, revalidates subject/policy/lifetime/identity, and decides every
 * access, so a stale or revoked entry advertised here fails closed on the relay.
 *
 * It is deliberately narrow:
 *   - ACTIVE grants only (revoked/expired are dropped);
 *   - bound to this exact user / instance / relay / durable agent scope;
 *   - redacted to `{ id, canonicalRoot, access, policyVersion, lifetime,
 *     expiresAt? }` — platform authorization, filesystem identity, origin,
 *     createdBy, timestamps, lastUsedAt, and revoked history never cross the wire.
 *
 * Returns `undefined` when the store is unavailable so the relay simply omits
 * the advisory field rather than advertising a partial or misleading snapshot.
 */
export async function buildDesktopFilesystemGrantSnapshot(
  options: BuildDesktopFilesystemGrantSnapshotOptions,
): Promise<RelayDesktopFilesystemGrantSnapshot | undefined> {
  let listed: Awaited<ReturnType<DesktopFilesystemGrantSnapshotStore["list"]>>;
  try {
    listed = await options.store.list({ userId: options.userId, includeHistory: true });
  } catch {
    return undefined;
  }
  if (!listed.ok) return undefined;

  const grants: RelayDesktopFilesystemGrantSnapshotEntry[] = [];
  for (const item of listed.data.grants) {
    if (item.status !== "active") continue;
    const subject = item.grant.subject;
    // Advisory or not, only advertise grants that bind to this exact local
    // identity — never leak another user/instance/relay/agent-scope grant.
    if (
      subject.userId !== options.userId ||
      subject.instanceId !== options.instanceId ||
      subject.relayId !== options.relayId ||
      subject.agentScope !== DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE
    ) {
      continue;
    }
    grants.push({
      id: item.grant.id,
      canonicalRoot: item.grant.canonicalRoot,
      access: [...item.grant.access],
      policyVersion: item.grant.policyVersion,
      lifetime: item.grant.lifetime,
      ...(item.grant.expiresAt !== undefined ? { expiresAt: item.grant.expiresAt } : {}),
    });
  }

  return {
    revision: listed.data.revision,
    instanceId: options.instanceId,
    agentScope: DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE,
    grants,
  };
}

// ── compile the canonical protected-path policy into the
// per-turn sandbox envelope for a plan-bound `run_shell` dispatch ──────────
//
// When a `workstationShellBinding` is revalidated, the sandbox's read/write
// roots must DERIVE from the locally revalidated policy-pack grants (the
// live grants' canonical roots), and the canonical protected-path policy
// must be compiled into both Seatbelt and bubblewrap as deny-overrides
// emitted AFTER the allow rules. The server's `allowedRoots` /
// `sandboxProfile` are an untrusted mirror and are never authority; this
// augmentation is relay-local — the wire envelope is never widened and the
// roots are never exposed to the server.
//
// The protected-path descriptor set covers system-auth, network, virtual,
// boot, and home-relative secret/credential stores. Compiling ALL of it
// verbatim into a sandbox would deny paths the sandbox needs for tool
// operation (/proc, /dev, /etc/hosts for DNS, /etc/ssl for TLS trust,
// /etc/passwd for name resolution). The category allowlist below selects
// the home-relative secret/credential stores + Nautilo state + caller
// roots — exactly the "protected even if a parent directory has been
// granted" set in the protected-path policy (SSH/GPG/cloud credentials, browser
// and password-manager profiles, Keychains, Nautilo data/vault/audit).
// System paths stay gated by the sandbox's own base system-path allowlist.

const SANDBOX_COMPILED_PROTECTED_PATH_CATEGORIES = new Set<ProtectedPathCategory>([
  "ssh",
  "gpg",
  "cloud",
  "container",
  "package_manager_secret",
  "env_secret",
  "password_store",
  "keyring",
  "browser_store",
  "macos_keychain",
  "macos_system",
  "nautilo_private",
  "nautilo_data",
  "nautilo_audit",
  "caller_root",
]);
const SANDBOX_PROTECTED_SYSTEM_PATHS = new Set([
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/pam.d",
  "/etc/ssh",
  // Explicit: `/sys` is a kernel-control interface and is never required
  // by the shell sandbox's base mount profile; keep it denied.
  "/sys",
]);

/**
 * Select the protected-path descriptors the sandbox compiles as
 * deny-overrides. Returns canonical absolute paths, deduped, ordered by
 * insertion. Empty when no policy is configured (the augmented envelope
 * then carries no `protectedPaths` and the sandbox keeps its prior shape).
 */
export function selectSandboxProtectedPaths(
  policy: ProtectedPathPolicy | undefined,
): readonly string[] {
  if (policy === undefined) return [];
  const out: string[] = [];
  for (const descriptor of policy.descriptors) {
    if (
      !SANDBOX_COMPILED_PROTECTED_PATH_CATEGORIES.has(descriptor.category) &&
      !SANDBOX_PROTECTED_SYSTEM_PATHS.has(descriptor.canonicalPath)
    ) {
      continue;
    }
    if (!out.includes(descriptor.canonicalPath)) out.push(descriptor.canonicalPath);
  }
  return out;
}

/**
 * The categories this slice compiles into the sandbox. Exported for unit
 * tests so the allowlist is pinned (a future widening that admitted
 * `system_virtual` would deny /proc and break every sandboxed shell).
 */
export const SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES =
  Object.freeze([...SANDBOX_COMPILED_PROTECTED_PATH_CATEGORIES]) as readonly string[];
export const SANDBOX_PROTECTED_SYSTEM_PATH_NAMES =
  Object.freeze([...SANDBOX_PROTECTED_SYSTEM_PATHS]);

function dedupePaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p === "string" && p.length > 0 && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Create a locally trusted, private per-dispatch scratch directory. It is the
 * guarded shell's workspace when no locally revalidated grant can write: a
 * read/execute-only grant must never become writable merely because `Sandbox`
 * always writes its workspace. The zero-byte mask is overmounted on protected
 * files by bubblewrap; the child cannot change the read-only bind.
 */
function createGuardedShellScratch(): { readonly workspace: string; readonly protectedFileMaskPath: string } {
  const workspace = fsSync.mkdtempSync(path.join(os.tmpdir(), "nautilo-guarded-shell-"));
  fsSync.chmodSync(workspace, 0o700);
  const protectedFileMaskPath = path.join(workspace, ".protected-file-mask");
  fsSync.writeFileSync(protectedFileMaskPath, "", { mode: 0o400, flag: "wx" });
  return { workspace, protectedFileMaskPath };
}

/**
 * Rebuild the per-turn sandbox envelope so a revalidated plan-bound shell
 * dispatch executes inside a sandbox whose read/write roots derive from
 * the locally revalidated policy-pack grants, with the canonical
 * protected-path policy compiled in as deny-overrides. The server's
 * envelope is the starting shape (workspace / dataDir / toolsBin /
 * failIfNoBackend are preserved); only `writablePaths` and
 * `protectedPaths` are relay-derived. The shell still runs sandboxed via
 * the single `spawnSandboxed` path — there is no unsandboxed fallback.
 *
 * the envelope's `networkPolicy` is REPLACED, not
 * preserved, with the complete network policy sourced from the
 * Electron-main active profile (converted by
 * `profileNetworkPolicyToRelayNetworkPolicy`). The server's
 * `base.config.networkPolicy` is never authority for a plan-bound shell and
 * is dropped entirely. When no local network policy is supplied the envelope
 * carries no `networkPolicy` (the server's value is still not preserved) —
 * the dispatch handler always sources one from a successful revalidation
 * before reaching this builder.
 */
export function buildShellBindingSandboxEnvelope(
  base: RelaySandboxProfile,
  grantRoots: {
    readonly readOnlyRoots: readonly string[];
    readonly writableRoots: readonly string[];
  },
  protectedPathPolicy: ProtectedPathPolicy | undefined,
  trustedToolsBin = resolveToolsBin(),
  scratch = createGuardedShellScratch(),
  networkPolicy?: RelayNetworkPolicy,
  locallyAuthorizedWorkspace?: string,
): RelaySandboxProfile {
  const protectedPaths = selectSandboxProtectedPaths(protectedPathPolicy);
  const nextConfig: RelaySandboxConfig = {
    // Do not retain any server-origin filesystem authority. The only
    // filesystem roots in this guarded envelope come from live local grants.
    mode: "enabled",
    writablePaths: dedupePaths(grantRoots.writableRoots),
    projectPaths: [],
    ...(grantRoots.readOnlyRoots.length > 0
      ? { readOnlyPaths: dedupePaths(grantRoots.readOnlyRoots) }
      : {}),
    passthroughEnv: [],
    // REPLACE — never preserve — the server's network posture with the
    // locally sourced active-profile network policy. Omitted when no local
    // policy is supplied; the server's `base.config.networkPolicy` is
    // intentionally dropped either way.
    ...(networkPolicy !== undefined ? { networkPolicy } : {}),
    ...(protectedPaths.length > 0 ? { protectedPaths } : {}),
    ...(protectedPaths.length > 0
      ? { protectedFileMaskPath: scratch.protectedFileMaskPath }
      : {}),
  };
  return {
    // `locallyAuthorizedWorkspace` was independently authorized at dispatch
    // time from the local durable grant store. It is the exact selected folder,
    // never the broad grant root (which may be `/`). Server workspace data is
    // never retained as execution authority.
    workspace: locallyAuthorizedWorkspace ?? grantRoots.writableRoots[0] ?? scratch.workspace,
    dataDir: base.dataDir,
    // Never retain server-origin executable/PATH authority.
    toolsBin: trustedToolsBin,
    mode: base.mode,
    securityLevel: base.securityLevel,
    // Full-mode guarded shells must refuse without a real backend.
    failIfNoBackend: true,
    config: nextConfig,
  };
}

export type WorkstationRelativeCwdResolution =
  | { readonly ok: true; readonly workspace: string; readonly cwd: string }
  | {
      readonly ok: false;
      readonly errorCode:
        | "WORKSTATION_CURRENT_FOLDER_INVALID"
        | "WORKSTATION_CURRENT_FOLDER_PROTECTED"
        | "WORKSTATION_CWD_INVALID"
        | "WORKSTATION_CWD_ABSOLUTE"
        | "WORKSTATION_CWD_TRAVERSAL"
        | "WORKSTATION_CWD_MISSING"
        | "WORKSTATION_CWD_NOT_DIRECTORY"
        | "WORKSTATION_CWD_OUTSIDE_CURRENT_FOLDER"
        | "WORKSTATION_CWD_PROTECTED";
      readonly error: string;
    };

function isContainedWorkstationPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/**
 * Resolves only a server-requested relative directory beneath Electron main's
 * live Current Folder. The server path is intent, never host-path authority:
 * canonical containment is checked after realpath so symlink escapes fail
 * before the workstation host can request consent or spawn a process.
 */
export async function resolveWorkstationRelativeCwd(input: {
  readonly workspacePath: string;
  readonly requestedCwd: unknown;
  readonly protectedPathPolicy?: ProtectedPathPolicy | undefined;
}): Promise<WorkstationRelativeCwdResolution> {
  let workspace: string;
  try {
    workspace = await fsp.realpath(input.workspacePath);
    if (!(await fsp.stat(workspace)).isDirectory()) {
      return {
        ok: false,
        errorCode: "WORKSTATION_CURRENT_FOLDER_INVALID",
        error: "Current Folder is unavailable for workstation execution.",
      };
    }
  } catch {
    return {
      ok: false,
      errorCode: "WORKSTATION_CURRENT_FOLDER_INVALID",
      error: "Current Folder is unavailable for workstation execution.",
    };
  }

  if (input.protectedPathPolicy && !input.protectedPathPolicy.check(workspace).allowed) {
    return {
      ok: false,
      errorCode: "WORKSTATION_CURRENT_FOLDER_PROTECTED",
      error: "Current Folder is protected from workstation execution.",
    };
  }

  if (input.requestedCwd === undefined) return { ok: true, workspace, cwd: workspace };
  if (typeof input.requestedCwd !== "string" || input.requestedCwd.length === 0 || input.requestedCwd.includes("\0")) {
    return {
      ok: false,
      errorCode: "WORKSTATION_CWD_INVALID",
      error: "Workstation cwd must be a non-empty relative directory path.",
    };
  }
  // Preserve security invariant: a server-provided host path is never
  // authority. Absolute values are ignored and execution remains bound to
  // Electron's selected Current Folder; only relative values can select a
  // contained child directory.
  if (
    path.isAbsolute(input.requestedCwd) ||
    path.posix.isAbsolute(input.requestedCwd) ||
    path.win32.isAbsolute(input.requestedCwd) ||
    /^[A-Za-z]:/.test(input.requestedCwd)
  ) {
    return { ok: true, workspace, cwd: workspace };
  }
  const segments = input.requestedCwd.split(/[\\/]/);
  if (segments.includes("..")) {
    return {
      ok: false,
      errorCode: "WORKSTATION_CWD_TRAVERSAL",
      error: "Workstation cwd cannot contain traversal segments.",
    };
  }
  if (segments.some((segment) => segment === "" || segment === ".")) {
    return {
      ok: false,
      errorCode: "WORKSTATION_CWD_INVALID",
      error: "Workstation cwd must name a relative directory without dot segments.",
    };
  }

  const requestedPath = path.resolve(workspace, input.requestedCwd);
  let cwd: string;
  try {
    cwd = await fsp.realpath(requestedPath);
  } catch {
    return {
      ok: false,
      errorCode: "WORKSTATION_CWD_MISSING",
      error: "Requested workstation directory is unavailable.",
    };
  }
  if (!isContainedWorkstationPath(workspace, cwd)) {
    return {
      ok: false,
      errorCode: "WORKSTATION_CWD_OUTSIDE_CURRENT_FOLDER",
      error: "Requested workstation directory is outside the selected Current Folder.",
    };
  }
  try {
    if (!(await fsp.stat(cwd)).isDirectory()) {
      return {
        ok: false,
        errorCode: "WORKSTATION_CWD_NOT_DIRECTORY",
        error: "Requested workstation path is not a directory.",
      };
    }
  } catch {
    return {
      ok: false,
      errorCode: "WORKSTATION_CWD_MISSING",
      error: "Requested workstation directory is unavailable.",
    };
  }
  if (input.protectedPathPolicy && !input.protectedPathPolicy.check(cwd).allowed) {
    return {
      ok: false,
      errorCode: "WORKSTATION_CWD_PROTECTED",
      error: "Requested workstation directory is protected.",
    };
  }
  return { ok: true, workspace, cwd };
}

export interface DispatchHandlerOptions {
  readonly isProduction?: boolean;
  readonly createSandbox?: RelayDispatchSandboxFactory;
  /** Test seam for the fixed-schema OpenHue handler. */
  readonly openHueExecutor?: OpenHueExecutor;
  /** Test seam for OpenHue binary resolution. */
  readonly resolveOpenHueBin?: () => string;
  /** Test seam for managed FFmpeg resolution and health probing. */
  readonly probeFfmpeg?: typeof probeFfmpeg;
  /** Test seam for managed ripgrep resolution and integrity probing. */
  readonly probeRipgrep?: typeof probeDesktopRipgrep;
  readonly onFsChange?: ((event: RelayFsChangeEvent) => void) | undefined;
  readonly relayId?: string | undefined;
  /** Electron-owned security-research authority; absent means unavailable. */
  readonly securityScanCoordinator?: DesktopSecurityScanCoordinator | undefined;
  /**
   * Electron-local structured SSH authority. The relay receives only
   * a strict binding and exact public request fields; this runtime reloads the
   * local grant/trust state and invokes the fixed OpenSSH broker. It has no
   * relationship to Current Folder or the generic shell/sandbox paths.
   */
  readonly structuredSsh?: StructuredSshDispatchRuntime | undefined;
  /**
   * Electron-local final authority and semantic provider dispatcher.
   * The relay client has already parsed and topology-checked the binding;
   * this callback revalidates the durable local grant before any effect.
   */
  readonly computerUseDispatch?: ((
    invocation: ComputerUseHostInvocation,
  ) => Promise<ComputerUseHostDispatchResult>) | undefined;
  /** private-staging seam into the sole Desktop mutation coordinator. */
  readonly commitDesktopApplyPatch?: CommitDesktopApplyPatch | undefined;
  /** agent OfficeCLI's staged binary postimage commit seam. */
  readonly commitDesktopOfficeCli?: CommitDesktopOfficeCli | undefined;
  /** ordinary agent local-file content commit seam. */
  readonly commitDesktopAgentContent?: CommitDesktopAgentContent | undefined;
  /** structural agent local-file commit seam. */
  readonly commitDesktopAgentStructural?: CommitDesktopAgentStructural | undefined;
  /** canonical local history restore commit seam. */
  readonly commitDesktopHistoryRestore?: CommitDesktopHistoryRestore | undefined;
  /** Test seam for the structured OfficeCLI runner used by local dispatch. */
  readonly officeRun?: import("@nautilo/config/officecli").OfficeCreateRunFn | undefined;
  /** Trusted owner/agent binding is unavailable in the patch body. */
  readonly resolveApplyPatchTrustedIdentity?: (
    req: RelayDispatchRequest,
    preparation: ApplyPatchDispatchPreparation,
  ) => ApplyPatchTrustedIdentity | undefined | Promise<ApplyPatchTrustedIdentity | undefined>;
  /**
   * injected local authority resolver for dispatches carrying a
   * `desktopFilesystemGrantRequest`. When absent, any such dispatch fails closed:
   * the server envelope can never create filesystem authority on its own.
   */
  readonly desktopFilesystemGrantAuthority?: DesktopFilesystemGrantAuthorityResolver | undefined;
  /**
   * injected local authority resolver for `run_shell`
   * dispatches carrying a `workstationShellBinding`. When absent, any such
   * dispatch fails closed (`WORKSTATION_SHELL_BINDING_UNCONFIGURED`): the
   * server envelope can never create filesystem authority on its own.
   */
  readonly workstationShellBindingAuthority?: WorkstationShellBindingAuthorityResolver | undefined;
  /**
   * the canonical protected-path policy the relay compiles
   * into the per-turn sandbox envelope as deny-overrides after allows. When
   * a plan-bound shell binding is revalidated, the dispatch handler rebuilds
   * the sandbox envelope LOCALLY so its read/write roots derive from the
   * revalidated policy-pack grants and the protected-path descriptors below
   * are threaded into both Seatbelt and bubblewrap as deny-overrides. The
   * server's `allowedRoots` / `sandboxProfile` are never authority and are
   * never widened on the wire. Optional; absent ⇒ the augmented envelope
   * carries no `protectedPaths` (deny set is empty, prior sandbox shape).
   */
  readonly protectedPathPolicy?: ProtectedPathPolicy | undefined;
  /** Trusted local install path; guarded shells never retain server toolsBin. */
  readonly trustedToolsBin?: string | undefined;
  /** Test seam for private guarded-shell scratch construction. */
  readonly createGuardedShellScratch?: () => {
    readonly workspace: string;
    readonly protectedFileMaskPath: string;
  };
  /**
   * Locally selected Current Folder, falling back to the relay's local
   * workspace root. It is never server-provided. apply_patch treats this as
   * its sole root authority and uses the wire root only for stale detection.
   */
  readonly getLocalWorkspacePath?: (() => string | undefined) | undefined;
  /**
   * Always-present, Finder-visible Genie Workspace for raw workstation
   * dispatches when no optional Human Current Folder is selected. This is
   * Electron-owned baseline authority, never a server-provided cwd.
   */
  readonly workstationWorkspacePath?: string | undefined;
  /**
   * Independently authorizes the locally selected workspace from durable
   * grants. It is deliberately separate from profile-session binding grants.
   */
  readonly localShellWorkspaceAuthority?: LocalShellWorkspaceAuthorityResolver | undefined;
  /**
   * local authority-boundary correction — the shared main-process
   * active-profile snapshot provider (the SAME controller the capability
   * builder reads). When wired, the dispatch handler refuses a generic
   * `run_shell` that carries no `workstationShellBinding` while a locally
   * authoritative active workstation profile is bound, and refuses on
   * provider lookup failure — an unbound generic server sandbox is never
   * permitted while a local active profile is authoritative. Omitted ⇒
   * the gate is skipped (headless relay / tests preserve baseline behavior
   * byte-for-byte). The provider is read-only; the relay never duplicates
   * profile state.
   */
  readonly workstationProfileStateProvider?: RelayWorkstationProfileSnapshotProvider | undefined;
  /** Electron-owned home used only for the narrow contained identity projection. */
  readonly workstationIdentityHomePath?: string | undefined;
  /** Test seam for the fixed-argument GitHub credential read. */
  readonly readWorkstationGitHubToken?:
    | ((signal?: AbortSignal) => Promise<string | null>)
    | undefined;
  /**
   * test seam for the typed GitBroker the `run_shell` git
   * variant constructs. Production leaves this undefined so the relay uses
   * the real `GitBroker` with the fixed `/usr/bin/git` executable; tests
   * inject a fake so the authority flow + disposition return path can be
   * exercised without sandbox-exec or a live repository.
   */
  readonly createGitBroker?: RunShellGitBrokerFactory | undefined;
  /**
   * live acceptance — all independently revalidated local grants that
   * carry both create/modify and delete authority. Structured Git keeps its
   * repository pinned to the binding's Current Folder, but sibling worktree
   * targets may use these separately reviewed exact roots.
   */
  readonly gitWritableGrantRootsProvider?: (() => Promise<readonly string[]>) | undefined;
  /** Electron-owned executor for explicit `executionClass:"real_workstation"`. */
  readonly runWorkstationShell?: ((request: {
    readonly command: string;
    readonly cwd: string;
    /** Set only after Electron-owned live-session verification. */
    readonly consentMode?: "verified_uncontained_session" | undefined;
    /** Canonical Electron-selected Current Folder; never server-supplied. */
    readonly workspacePath?: string | undefined;
    /** Rechecks the Electron-owned Current Folder immediately before spawn. */
    readonly isCurrentWorkspace?: (() => boolean) | undefined;
    readonly timeoutMs?: number | undefined;
    readonly abortSignal?: AbortSignal | undefined;
    readonly onStdoutChunk?: ((chunk: Buffer) => void) | undefined;
    readonly onStderrChunk?: ((chunk: Buffer) => void) | undefined;
  }) => Promise<RelayDispatchResult>) | undefined;
  /**
   * Electron-owned pre-spawn check. The server never supplies this
   * fact: it verifies the relay-local owner tuple against the exact current
   * Desktop status before the existing host runner is entered.
   */
  readonly verifyUncontainedHostCommands?: ((binding: {
    readonly instanceId: string;
    readonly userId: string;
    readonly relayId: string;
    readonly desktopSessionId: string | null;
  }) => Promise<boolean>) | undefined;
  /** private, bounded Desktop-local continuation authority. */
  readonly runShellOutputArtifactStore?: RunShellOutputArtifactStore | undefined;
  /** private, bounded Electron-local semantic page continuation store. */
  readonly browserPageSnapshotStore?: BrowserPageSnapshotStore | undefined;
  /** Session-local media transfer owner; standalone handlers receive an isolated fallback. */
  readonly mediaSessions?: MediaSessionsPort | undefined;
  /** Session-local browser screenshot coordinate scale owner. */
  readonly browserCoordinateScales?: BrowserCoordinateScalePort | undefined;
  /** Exact immutable OAuth tuple captured by this relay session. */
  readonly googleOAuthContext?: DesktopRelayGoogleOAuthContext | null | undefined;
  /** Retirement fence checked before local credential side effects. */
  readonly isSessionClosed?: (() => boolean) | undefined;
  /** Candidate-session late-work fence; omitted by standalone handlers. */
  readonly settleBoundWork?: (<T>(work: Promise<T>) => Promise<T>) | undefined;
  /**
   * explicit Human mobile selection. The callback is owned by Electron
   * main so the relay/server never become Current Folder state owners.
   */
  readonly selectCurrentFolder?: CurrentFolderSelectPort | undefined;
  /** opaque, directory-only paired-phone location picker. */
  readonly pairedFilesystemDirectory?: PairedFilesystemDirectoryPort | undefined;
  /** Electron-owned, process-local exact-folder adoption authority. */
  readonly currentFolderAdoption?: CurrentFolderAdoptionPort | undefined;
  /** Ask the renderer to mount Browser and await manager-confirmed controllability. */
  readonly ensureBrowserSurface?: ((request: {
    readonly url: string;
    readonly timeoutMs: number;
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>) | undefined;
  /** Use Electron's adopted guest navigation instead of direct-page CDP history calls. */
  readonly controlBrowserNavigation?: ((request: {
    readonly action: "back" | "forward" | "reload";
  }) => Promise<{ ok: true } | { ok: false; error: string }>) | undefined;
  /** Electron-main-owned exact anonymous research target; absent fails closed. */
  readonly browserResearchRead?: ((
    request: import("@nautilo/relay").RelayBrowserResearchReadRequest,
    signal?: AbortSignal,
    options?: { readonly publishSnapshotReference?: boolean },
  ) => Promise<RelayDispatchResult>) | undefined;
  readonly browserResearchConsentRecovery?: ((
    request: import("@nautilo/relay").RelayBrowserResearchConsentRecoveryRequest,
    signal?: AbortSignal,
  ) => Promise<RelayDispatchResult>) | undefined;
  readonly browserResearchSearch?: ((
    request: import("@nautilo/relay").RelayBrowserResearchSearchRequest,
    signal?: AbortSignal,
  ) => Promise<RelayDispatchResult>) | undefined;
}

export function makeDispatchHandler(
  baseGuard: WorkspaceGuard,
  options: DispatchHandlerOptions = {},
): (req: RelayDispatchRequest, signal?: AbortSignal) => Promise<RelayDispatchResult> {
  if (options.settleBoundWork !== undefined) {
    const { settleBoundWork, ...unboundOptions } = options;
    const dispatch = makeDispatchHandler(baseGuard, unboundOptions);
    return (req, signal) => settleBoundWork(dispatch(req, signal));
  }
  const standaloneSession = options.mediaSessions === undefined ||
    options.browserCoordinateScales === undefined
    ? new DesktopRelaySession({ serverUrl: "" })
    : null;
  const mediaSessions = options.mediaSessions ?? standaloneSession!.mediaSessions;
  const browserCoordinateScales = options.browserCoordinateScales ??
    standaloneSession!.browserCoordinateScales;
  const googleOAuthContext = options.googleOAuthContext ?? null;
  const isSessionClosed = options.isSessionClosed ?? (() => false);
  const isProduction =
    options.isProduction ?? process.env["NODE_ENV"] === "production";
  const workstation = createWorkstationHandlers({
    relayId: options.relayId,
    runWorkstationShell: options.runWorkstationShell,
    verifyUncontainedHostCommands: options.verifyUncontainedHostCommands,
    getLocalWorkspacePath: options.getLocalWorkspacePath,
    workstationWorkspacePath: options.workstationWorkspacePath,
    protectedPathPolicy: options.protectedPathPolicy,
    resolveWorkstationRelativeCwd,
    outputArtifactStore: options.runShellOutputArtifactStore,
    workstationIdentityHomePath: options.workstationIdentityHomePath,
    readWorkstationGitHubToken: options.readWorkstationGitHubToken,
    createGitBroker: options.createGitBroker,
    gitWritableGrantRootsProvider: options.gitWritableGrantRootsProvider,
    selectSandboxProtectedPaths,
    spawnSandboxed,
    unusableCurrentFolderError,
    hasSandboxCwdFailure,
    sandboxCurrentFolderError,
  });
  const localFile = createLocalFileHandlers({
    relayId: options.relayId,
    baseRoots: baseGuard.roots,
    onFsChange: options.onFsChange,
    desktopFilesystemGrantAuthority: options.desktopFilesystemGrantAuthority,
    commitDesktopApplyPatch: options.commitDesktopApplyPatch,
    commitDesktopOfficeCli: options.commitDesktopOfficeCli,
    commitDesktopAgentContent: options.commitDesktopAgentContent,
    commitDesktopAgentStructural: options.commitDesktopAgentStructural,
    commitDesktopHistoryRestore: options.commitDesktopHistoryRestore,
    resolveApplyPatchTrustedIdentity: options.resolveApplyPatchTrustedIdentity,
    getLocalWorkspacePath: options.getLocalWorkspacePath,
    protectedPathPolicy: options.protectedPathPolicy,
    officeRun: options.officeRun,
    buildApplyPatchEnvelope: (input) => buildShellBindingSandboxEnvelope(
      input.base,
      { readOnlyRoots: [], writableRoots: [input.currentFolder] },
      input.protectedPathPolicy,
      path.dirname(input.runtime.binaryPath),
      input.scratch,
      undefined,
      input.currentFolder,
    ),
    resolveApplyPatchRuntime: async () => resolveElectronApplyPatchDesktopRuntime({
      isPackaged: await resolveElectronPackagingState(),
      resourcesPath: process.resourcesPath ?? null,
      devVendorRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor"),
    }),
    createGuardedScratch: options.createGuardedShellScratch ?? createGuardedShellScratch,
  });
  const terminal = createTerminalDispatchHandler({
    spawnSession,
    writeSession,
    readTerminalSince,
    getSessionControl,
    killSession,
    listSessions,
    peekAgentHandoffSession,
    peekBoundAgentTerminalSession,
    consumeAgentHandoffSession,
    acknowledgeAgentHandoffSession,
    resolveTerminalSpawnCwd,
  });
  const browserResearch = createBrowserResearchDispatchHandler({
    read: options.browserResearchRead,
    consentRecovery: options.browserResearchConsentRecovery,
    search: options.browserResearchSearch,
    snapshotStore: options.browserPageSnapshotStore,
  });
  const media = createMediaDispatchHandler({
    sessions: mediaSessions,
    probeFfmpeg: options.probeFfmpeg ?? probeFfmpeg,
  });
  const hue = createHueDispatchHandler({
    executor: options.openHueExecutor ?? openHueExecutor,
    resolveBinary: () =>
      options.resolveOpenHueBin?.() ?? resolveOpenHueDispatchBin(),
  });
  const interactiveBrowser = createInteractiveBrowserDispatchHandler({
    resolveBinary: resolveAgentBrowserBin,
    binaryInstallHint: agentBrowserInstallHint,
    ensureConfig: ensureAgentBrowserConfig,
    sessionFor: browserDispatchSession,
    hasPublishedView: hasPublishedBrowserControlView,
    waitForPublishedView: waitForPublishedBrowserControlView,
    ensureBrowserSurface: options.ensureBrowserSurface,
    controlBrowserNavigation: options.controlBrowserNavigation,
    snapshotStore: options.browserPageSnapshotStore,
    getCoordinateScale: browserCoordinateScales.get,
    setCoordinateScale: browserCoordinateScales.set,
    exec: async (binary, argv, execOptions) =>
      await execFileAsync(binary, argv, execOptions),
    pruneCaptures: () => {
      pruneCaptures(
        BROWSER_CAPTURE_DIR,
        BROWSER_CAPTURE_PREFIX,
        BROWSER_CAPTURE_MAX_AGE_MS,
      );
    },
    capturePath: () => captureFilePath(BROWSER_CAPTURE_DIR, BROWSER_CAPTURE_PREFIX),
    readCapturePng: (capturePath) => fsSync.readFileSync(capturePath),
    captureDimensions: parsePngIhdrDimensions,
    visionFromPng: (capturePath, text) => visionResultFromPng({
      path: capturePath,
      text,
      kind: "browser_screenshot_vision",
      maxBytes: BROWSER_VISION_PNG_MAX_BYTES,
    }),
  });
  const googleWorkspace = createGoogleWorkspaceDispatchHandler({
    resolveBinary: resolveGogBin,
    prepareKeyring: (binary) =>
      prepareGoogleWorkspaceKeyring(binary, googleOAuthContext, isSessionClosed),
    authHealthy: (binary) => isSessionClosed()
      ? Promise.resolve(false)
      : isGogAuthHealthy(binary),
    ensureOAuthClient: (binary) => ensureGoogleOAuthClientForDispatch(
      binary,
      googleOAuthContext,
      isSessionClosed,
    ),
    execFile: async (binary, argv, execOptions) => {
      if (isSessionClosed()) throw new Error("Desktop relay session retired");
      return await execFileAsync(binary, argv, execOptions);
    },
    timeoutMs: GOOGLE_WORKSPACE_EXEC_TIMEOUT_MS,
    installHint: gogInstallHint,
  });

  return async function handleDispatch(
    req: RelayDispatchRequest,
    signal?: AbortSignal,
  ): Promise<RelayDispatchResult> {
    // Security research has no server-provided root, sandbox, or shell
    // authority. A parsed security_scan envelope is dispatched before every
    // generic lane; malformed envelopes fail closed here as well.
    if (req.toolName === "security_scan") {
      if (securityScanRelayRequestSchema.safeParse(req.args).success === false) {
        return {
          status: "ok",
          result: {
            ok: false,
            operation: "status",
            error: { code: "invalid_request", retryable: false, message: "Security research request is invalid." },
          },
        };
      }
      if (options.securityScanCoordinator === undefined) {
        return {
          status: "ok",
          result: {
            ok: false,
            operation: "status",
            error: { code: "relay_unavailable", retryable: true, message: "Security research is unavailable on this desktop." },
          },
        };
      }
      return { status: "ok", result: await options.securityScanCoordinator.dispatch(req.args, signal, req.reportSecurityScanProgress) };
    }

    // Per-request guard composition. If the dispatch message widened
    // allowedRoots (e.g., an MCP tool that requested a specific root),
    // a fresh guard that unions base + request roots is built. Base
    // guard remains the fallback.
    const requestRoots = req.allowedRoots ?? [];
    const guard =
      requestRoots.length === 0
        ? baseGuard
        : createWorkspaceGuard({
            allowedRoots: [...baseGuard.roots, ...requestRoots],
          });

    type LowerDispatchPreparation =
      | {
          readonly ok: true;
          readonly applyPatchPreparation: ApplyPatchDispatchPreparation | undefined;
          readonly desktopFilesystemAuthority: DesktopFilesystemAuthority | undefined;
          readonly shellNetworkPolicy: RelayNetworkPolicy | undefined;
          readonly revalidatedShellBinding: RelayWorkstationShellBinding | undefined;
        }
      | { readonly ok: false; readonly result: RelayDispatchResult };

    let lowerDispatchPreparationPromise: Promise<LowerDispatchPreparation> | undefined;
    let localDispatchPolicyPreparationPromise: Promise<LocalDispatchPolicyPreparation> | undefined;
    let sandbox: Sandbox | null = null;

    const prepareLowerDispatch = async (): Promise<LowerDispatchPreparation> => {
      // resolve validated local authority ONCE for every request that
      // reaches the lower dispatch chain. The server envelope is an untrusted
      // mirror; only locally revalidated roots reach the adapters below.
      const applyPatchPreflight = preflightApplyPatch(req);
      if (!applyPatchPreflight.ok) return applyPatchPreflight;
      const applyPatchPreparation = applyPatchPreflight.preparation;
      const desktopFilesystemPreparation = await prepareDesktopFilesystemAuthority({
        request: req,
        baseRoots: baseGuard.roots,
        resolver: options.desktopFilesystemGrantAuthority,
        applyPatchPreparation,
      });
      if (!desktopFilesystemPreparation.ok) return desktopFilesystemPreparation;

      let desktopFilesystemAuthority = desktopFilesystemPreparation.authority;
      let shellNetworkPolicy: RelayNetworkPolicy | undefined;
      let revalidatedShellBinding: RelayWorkstationShellBinding | undefined;
      if (req.workstationShellBinding !== undefined) {
        const shellResolver = options.workstationShellBindingAuthority;
        if (shellResolver === undefined) {
          return {
            ok: false,
            result: {
              status: "error",
              errorCode: "WORKSTATION_SHELL_BINDING_UNCONFIGURED",
              error:
                "workstation shell binding received but no local shell-binding " +
                "authority resolver is configured; refusing to derive filesystem " +
                "authority from the server envelope",
            },
          };
        }
        const parsedBinding = parseRelayWorkstationShellBinding(req.workstationShellBinding);
        if (!parsedBinding.ok) {
          return {
            ok: false,
            result: {
              status: "error",
              errorCode: "WORKSTATION_SHELL_BINDING_INVALID",
              error: "workstation shell binding rejected: " + parsedBinding.error,
            },
          };
        }
        const shellResolution = await shellResolver({
          binding: parsedBinding.binding,
          concreteOperation: deriveDesktopFilesystemAccessOperation(req),
        });
        if (!shellResolution.ok) {
          return {
            ok: false,
            result: {
              status: "error",
              errorCode: shellResolution.code,
              error: "workstation shell binding rejected: " + shellResolution.code,
            },
          };
        }
        desktopFilesystemAuthority = {
          roots: shellResolution.roots,
          readOnlyRoots: shellResolution.readOnlyRoots,
          writableRoots: shellResolution.writableRoots,
        };
        shellNetworkPolicy = shellResolution.networkPolicy;
        revalidatedShellBinding = parsedBinding.binding;
      }

      return {
        ok: true,
        applyPatchPreparation,
        desktopFilesystemAuthority,
        shellNetworkPolicy,
        revalidatedShellBinding,
      };
    };
    const getLowerDispatchPreparation = (): Promise<LowerDispatchPreparation> => {
      lowerDispatchPreparationPromise ??= prepareLowerDispatch();
      return lowerDispatchPreparationPromise;
    };

    const prepareRequestLocalPolicy = async (): Promise<LocalDispatchPolicyPreparation> => {
      const lower = await getLowerDispatchPreparation();
      if (!lower.ok) return lower;
      const preparation = await prepareLocalDispatchPolicy({
        toolName: req.toolName,
        isProduction,
        desktopFilesystemAuthority: lower.desktopFilesystemAuthority,
        revalidatedShellBinding: lower.revalidatedShellBinding,
        shellNetworkPolicy: lower.shellNetworkPolicy,
        requestHasShellBinding: req.workstationShellBinding !== undefined,
        checkUnboundRunShell: async () => {
          if (
            req.toolName !== "run_shell" ||
            req.workstationShellBinding !== undefined ||
            options.workstationProfileStateProvider === undefined
          ) return undefined;
          let profileLookup: "active" | "none" | "lookup-failed";
          try {
            const snapshot = await options.workstationProfileStateProvider.getProfileSnapshot();
            profileLookup = snapshot === undefined ? "none" : "active";
          } catch {
            profileLookup = "lookup-failed";
          }
          if (profileLookup === "active") {
            console.warn(
              "[relay] run_shell refused: WORKSTATION_SHELL_BINDING_REQUIRED (req " +
                req.correlationId +
                ")",
            );
            return {
              status: "error" as const,
              errorCode: "WORKSTATION_SHELL_BINDING_REQUIRED",
              error:
                "workstation shell binding required: a local active workstation " +
                "profile is bound but the run_shell dispatch carries no locally " +
                "revalidated shell binding; refusing to execute an unbound generic " +
                "server sandbox",
            };
          }
          if (profileLookup === "lookup-failed") {
            console.warn(
              "[relay] run_shell refused: WORKSTATION_PROFILE_LOOKUP_FAILED (req " +
                req.correlationId +
                ")",
            );
            return {
              status: "error" as const,
              errorCode: "WORKSTATION_PROFILE_LOOKUP_FAILED",
              error:
                "workstation profile lookup failed: unable to determine local " +
                "active profile state for run_shell gating; refusing to execute",
            };
          }
          return undefined;
        },
        augmentEnvelope: async () => {
          let augmentedEnvelope = req.sandboxProfile;
          let authorizedWorkspace: string | undefined;
          if (
            lower.desktopFilesystemAuthority !== undefined &&
            req.workstationShellBinding !== undefined &&
            req.sandboxProfile !== undefined
          ) {
            try {
              if (
                options.getLocalWorkspacePath !== undefined &&
                options.localShellWorkspaceAuthority !== undefined
              ) {
                const localWorkspace = options.getLocalWorkspacePath();
                if (localWorkspace === undefined) {
                  return {
                    ok: false as const,
                    result: {
                      status: "error" as const,
                      errorCode: "WORKSTATION_SHELL_WORKSPACE_UNAVAILABLE",
                      error: "Current Folder is unavailable for the workstation shell",
                    },
                  };
                }
                const resolved = await options.localShellWorkspaceAuthority(localWorkspace);
                if (!resolved.ok) {
                  return {
                    ok: false as const,
                    result: {
                      status: "error" as const,
                      errorCode: resolved.code,
                      error: "Current Folder is not authorized for the workstation shell",
                    },
                  };
                }
                authorizedWorkspace = resolved.workspace;
              }
              augmentedEnvelope = buildShellBindingSandboxEnvelope(
                req.sandboxProfile,
                {
                  readOnlyRoots: [
                    ...(lower.desktopFilesystemAuthority.readOnlyRoots ?? []),
                    ...(authorizedWorkspace === undefined ? [] : [authorizedWorkspace]),
                  ],
                  writableRoots: [
                    ...(lower.desktopFilesystemAuthority.writableRoots ?? []),
                    ...(authorizedWorkspace === undefined ? [] : [authorizedWorkspace]),
                  ],
                },
                options.protectedPathPolicy,
                options.trustedToolsBin ?? resolveToolsBin(),
                (options.createGuardedShellScratch ?? createGuardedShellScratch)(),
                lower.shellNetworkPolicy,
                authorizedWorkspace,
              );
            } catch (error) {
              return {
                ok: false as const,
                result: {
                  status: "error" as const,
                  errorCode: "WORKSTATION_SHELL_SANDBOX_UNAVAILABLE",
                  error:
                    "workstation shell binding rejected: " +
                    (error instanceof Error ? error.message : String(error)),
                },
              };
            }
          }
          return {
            ok: true as const,
            sandboxEnvelope: augmentedEnvelope,
            locallyAuthorizedWorkspace: authorizedWorkspace,
          };
        },
        revalidateWorkspaceBeforeOperation: async (expectedWorkspace) => {
          if (
            req.workstationShellBinding === undefined ||
            options.getLocalWorkspacePath === undefined ||
            options.localShellWorkspaceAuthority === undefined
          ) return undefined;
          const liveWorkspace = options.getLocalWorkspacePath();
          if (liveWorkspace === undefined) {
            return {
              status: "error" as const,
              errorCode: "WORKSTATION_SHELL_WORKSPACE_UNAVAILABLE",
              error: "Current Folder is unavailable for the workstation shell",
            };
          }
          const revalidatedWorkspace = await options.localShellWorkspaceAuthority(liveWorkspace);
          if (
            !revalidatedWorkspace.ok ||
            revalidatedWorkspace.workspace !== expectedWorkspace
          ) {
            return {
              status: "error" as const,
              errorCode: revalidatedWorkspace.ok
                ? "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH"
                : revalidatedWorkspace.code,
              error: "Current Folder changed or is not authorized for the workstation shell",
            };
          }
          return undefined;
        },
        resolveLocalAuthority: (locallyAuthorizedWorkspace) =>
          req.toolName === "run_shell" &&
          lower.revalidatedShellBinding !== undefined &&
          locallyAuthorizedWorkspace !== undefined &&
          path.normalize(locallyAuthorizedWorkspace) ===
            path.normalize(lower.revalidatedShellBinding.currentFolder)
            ? { allowWorkspaceGovernanceWrites: true }
            : undefined,
        ...(options.createSandbox === undefined ? {} : { createSandbox: options.createSandbox }),
      });
      if (preparation.ok) sandbox = preparation.policy.sandbox;
      return preparation;
    };
    const getLocalDispatchPolicy = (): Promise<LocalDispatchPolicyPreparation> => {
      localDispatchPolicyPreparationPromise ??= prepareRequestLocalPolicy();
      return localDispatchPolicyPreparationPromise;
    };

    const fixedHandlers: FixedDesktopDispatchHandlers = {
      computerUse: async ({ request, signal: requestSignal }) => {
        if (request.executionClass !== "computer_use") {
          return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
        }
        if (
          request.desktopAutomationBinding === undefined ||
          options.computerUseDispatch === undefined
        ) {
          return {
            handled: true,
            result: {
              status: "error",
              errorCode: "desktop_automation_unavailable",
              error: "Computer Use is unavailable for this Desktop request.",
            },
          };
        }
        const semantic = await options.computerUseDispatch({
          binding: request.desktopAutomationBinding,
          toolName: request.toolName,
          args: request.args,
          ...(request.computerUseRequest === undefined
            ? {}
            : { computerUseRequest: request.computerUseRequest }),
          ...(requestSignal === undefined ? {} : { signal: requestSignal }),
        });
        if (
          semantic.ok &&
          "hostResult" in semantic &&
          semantic.visionImage !== undefined
        ) {
          return {
            handled: true,
            result: {
              status: "ok",
              result: {
                kind: "computer_use_host_vision",
                text: JSON.stringify(semantic.hostResult),
                image: semantic.visionImage,
              },
            },
          };
        }
        return {
          handled: true,
          result:
            semantic.ok && "hostResult" in semantic
              ? { status: "ok", result: semantic.hostResult }
              : { status: "ok", result: semantic },
        };
      },

      structuredSsh: async ({ request, signal: requestSignal }) =>
        await dispatchStructuredSshFamily({
          request,
          signal: requestSignal,
          runtime: options.structuredSsh,
          outputArtifactStore: options.runShellOutputArtifactStore,
        }),

      runShellOutput: async ({ request }) =>
        await dispatchRunShellOutput({
          request,
          outputArtifactStore: options.runShellOutputArtifactStore,
        }),

      currentFolder: async ({ request }) =>
        await dispatchCurrentFolderFamily({
          request,
          adoption: options.currentFolderAdoption,
          pairedDirectory: options.pairedFilesystemDirectory,
          selectCurrentFolder: options.selectCurrentFolder,
        }),

      browserResearch,

      realWorkstation: async ({ request, signal: requestSignal }) =>
        await workstation.dispatchRealWorkstation({
          request,
          signal: requestSignal,
        }),

      hue,

      media,

      interactiveBrowser,

      googleWorkspace,

      directLocalFile: async ({ request, signal: requestSignal, guard: requestGuard }) => {
        const preparation = await getLowerDispatchPreparation();
        if (!preparation.ok) {
          return { handled: true, result: preparation.result };
        }
        return await localFile.dispatchDirect({
          request,
          guard: requestGuard,
          signal: requestSignal,
          authority: preparation.desktopFilesystemAuthority,
          applyPatchPreparation: preparation.applyPatchPreparation,
        });
      },

      filesystem: async ({ request, guard: requestGuard }) => {
        const preparation = await getLowerDispatchPreparation();
        if (!preparation.ok) {
          return { handled: true, result: preparation.result };
        }
        return await dispatchFilesystem({
          request,
          guard: requestGuard,
          authority: preparation.desktopFilesystemAuthority,
          onFsChange: options.onFsChange,
        });
      },

      sandboxedLocalSearch: async ({
        request,
        signal: requestSignal,
        guard: requestGuard,
      }) => {
        const preparation = await getLocalDispatchPolicy();
        if (!preparation.ok) {
          return { handled: true, result: preparation.result };
        }
        return await localFile.dispatchSandboxedSearch({
          request,
          guard: requestGuard,
          signal: requestSignal,
          authority: preparation.policy.desktopFilesystemAuthority,
          sandbox,
          getRipgrepRuntime: async () =>
            await (options.probeRipgrep ?? probeDesktopRipgrep)({
              isPackaged: await resolveElectronIsPackaged(),
            }),
        });
      },

      sandboxedRunShell: async ({
        request,
        signal: requestSignal,
        guard: requestGuard,
      }) => {
        if (request.toolName !== "run_shell") {
          return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
        }
        const preparation = await getLocalDispatchPolicy();
        if (!preparation.ok) {
          return { handled: true, result: preparation.result };
        }
        const policy = preparation.policy;
        const decision = await workstation.dispatchSandboxedRunShell({
          request,
          signal: requestSignal,
          guardRoots: requestGuard.roots,
          policy: {
            desktopFilesystemAuthority: policy.desktopFilesystemAuthority,
            revalidatedShellBinding: policy.revalidatedShellBinding,
            sandboxEnvelopeWorkspace: policy.sandboxEnvelope?.workspace,
            locallyAuthorizedWorkspace: policy.locallyAuthorizedWorkspace,
            shellNetworkPolicy: policy.shellNetworkPolicy,
          },
          sandbox,
        });
        if (!decision.handled) {
          return {
            handled: true,
            result: {
              status: "error",
              error: "internal: run_shell dispatch was not handled",
            },
          };
        }
        if (sandbox !== null) {
          await sandbox.close();
          sandbox = null;
        }
        return decision;
      },

      terminal: async ({ request, guard: requestGuard }) => {
        if (request.toolName !== "terminal") {
          return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
        }
        const preparation = await getLocalDispatchPolicy();
        if (!preparation.ok) {
          return { handled: true, result: preparation.result };
        }
        const terminalDecision = await terminal({
          request,
          guardRoots: requestGuard.roots,
          sandboxEnvelopeWorkspace: preparation.policy.sandboxEnvelope?.workspace,
          sandbox,
        });
        if (terminalDecision.handled) return terminalDecision;
        return {
          handled: true,
          result: {
            status: "error",
            error: "internal: terminal dispatch was not handled",
          },
        };
      },
    };

    const routeDispatch = createFixedDesktopDispatchRouter(
      fixedHandlers,
      async ({ request }) => {
        const preparation = await getLocalDispatchPolicy();
        if (!preparation.ok) return preparation.result;
        return {
          status: "error",
          error: "Unknown tool: " + request.toolName,
        };
      },
    );

    try {
      return await routeDispatch({ request: req, signal, guard });
    } finally {
      await (sandbox as Sandbox | null)?.close();
    }
  };
}

/**
 * Stable only for one locally selected server origin. It is a local
 * storage namespace, not a grant field and never crosses the relay wire.
 * Selecting another server therefore starts with no local SSH authority,
 * including for the canonical default instance id (""). Re-pairing to the
 * same origin retains the durable grant but invalidates every in-flight
 * preparation through relay-session and pairing-generation checks.
 */
export function deriveStructuredSshServerBindingId(
  serverUrl: string,
): string | null {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    const canonical = url.toString().replace(/\/$/, "");
    return `ssh-server-binding-${createHash("sha256")
      .update("nautilo-d500-structured-ssh-server-binding\\0", "utf8")
      .update(canonical, "utf8")
      .digest("base64url")}`;
  } catch {
    return null;
  }
}

/** local storage namespace for one canonical selected server origin. */
export function deriveComputerUseServerBindingId(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    const canonical = url.toString().replace(/\/$/, "");
    return `computer-use-server-binding-${createHash("sha256")
      .update("nautilo-d516-computer-use-server-binding\\0", "utf8")
      .update(canonical, "utf8")
      .digest("base64url")}`;
  } catch {
    return null;
  }
}

export interface StartRelayOptions {
  serverUrl: string;
  userId: string;
  /** Stable relay-id file owned by this Desktop `(instance, profile)` tuple. */
  relayIdentityFilePath?: string | undefined;
  /** Default-tuple-only migration source for the historical shared relay id. */
  legacyRelayIdentityFilePath?: string | undefined;
  /** Desktop-only tuple journal root eligible for the legacy-id migration. */
  localFileHistoryRootDir?: string | undefined;
  /** Read-only proof of the relay id used by pre-tuple local history. */
  legacyLocalHistoryRelayIdentityFilePath?: string | undefined;
  /**
   * Always-present, Finder-visible Genie Workspace. Electron main provisions
   * it before relay boot; no hidden fallback is available when it is absent.
   */
  workspacePath: string;
  /**
   * Returns the locally selected Human Current Folder only. It intentionally
   * does not fall back to the Genie Workspace: Current-Folder-bound
   * operations must fail clearly when no project folder is selected.
   */
  currentFolderPathProvider?: (() => string | undefined) | undefined;
  /**
   * Electron Application Support directory for app-owned SSH trust/grant
   * state. It is explicit so headless relay callers cannot accidentally gain
   * structured SSH execution.
   */
  structuredSshAppDataDirectory?: string | undefined;
  /** Explicit Electron app-owned directory for durable security research. */
  securityResearchDataDirectory?: string | undefined;
  /**
   * Electron-owned redacted local Computer use snapshot; never a grant. The
   * builder supplies current Cua route readiness without spawning another
   * health probe.
   */
  computerUseSnapshotProvider?: (() => Promise<DesktopAutomationCapabilitySnapshot | undefined>) | undefined;
  /**
   * Reconcile a just-acknowledged topology before advertising a local receipt.
   * The supplied refresh continuation is bound to that exact relay session;
   * it returns false after handoff, stop, or failed start rather than reaching
   * a replacement relay.
   */
  onComputerUseTopologyChange?: ((
    refreshRelayCapabilities: (reason?: string) => Promise<boolean>,
  ) => void | Promise<void>) | undefined;
  /** Electron-main-owned semantic dispatcher over the durable local store. */
  computerUseDispatch?: DispatchHandlerOptions["computerUseDispatch"];
  googleOAuthStatusToken?: string | undefined;
  googleOAuthClientPath?: string | undefined;
  token?: string | undefined;
  onStatusChange?: ((status: RelayStatus) => void) | undefined;
  onFsChange?: ((event: RelayFsChangeEvent) => void) | undefined;
  /**
   * prerequisite — the single main-process grant authority, shared with
   * the IPC handlers. When provided, the relay's authority resolver and
   * advisory snapshot builder read this same source (durable grants plus the
   * in-memory overlay) instead of constructing a separate relay-local store
   * that could not see overlay grants. Omitted by tests / headless relay.
   */
  desktopFilesystemGrantAuthority?: DesktopFilesystemGrantSnapshotStore | undefined;
  /**
   * the single main-process active-profile controller, shared with
   * the relay so the capability builder advertises the controller's strict,
   * redacted `RelayWorkstationProfileSnapshot` (desktop-agent profile only).
   * The relay never constructs its own profile store; it reads the SAME
   * controller the main process owns, so there are no duplicate stores.
   * Omitted by tests / the headless relay, which never bind a profile.
   */
  workstationProfileController?: RelayWorkstationProfileSnapshotProvider | undefined;
  /** pre-spawn snapshot + post-attempt reconciliation seam. */
  commitDesktopApplyPatch?: CommitDesktopApplyPatch | undefined;
  /** agent OfficeCLI's staged binary postimage commit seam. */
  commitDesktopOfficeCli?: CommitDesktopOfficeCli | undefined;
  /** ordinary agent local-file content commit seam. */
  commitDesktopAgentContent?: CommitDesktopAgentContent | undefined;
  /** structural agent local-file commit seam. */
  commitDesktopAgentStructural?: CommitDesktopAgentStructural | undefined;
  /** canonical local history restore commit seam. */
  commitDesktopHistoryRestore?: CommitDesktopHistoryRestore | undefined;
  /** Source of authenticated owner/agent/turn identity absent from v9. */
  resolveApplyPatchTrustedIdentity?: DispatchHandlerOptions["resolveApplyPatchTrustedIdentity"] | undefined;
  /** Electron-owned, consent-gated real workstation executor. */
  runWorkstationShell?: DispatchHandlerOptions["runWorkstationShell"];
  /** local status/binding verifier for uncontained host commands. */
  verifyUncontainedHostCommands?: DispatchHandlerOptions["verifyUncontainedHostCommands"];
  /**
   * optional, Electron-owned Codex host only. No supervisor/runtime
   * is manufactured here; absent or not-ready ports leave the capability off.
   */
  codexHostPort?: RelayCodexHostPort | undefined;
  /** readiness-only Hermes ACP host; no execution route exists yet. */
  acpHostPort?: RelayAcpHostPort | undefined;
  /** Electron-owned parked Claude account/catalog discovery host. */
  claudeConnectionHostPort?: RelayClaudeConnectionHostPort | undefined;
  /** Electron-owned Current-Folder Claude execution host. */
  claudeExecutionHostPort?: RelayClaudeExecutionHostPort | undefined;
  /** Electron-main Current Folder selection and refresh seam for mobile. */
  selectCurrentFolder?: DispatchHandlerOptions["selectCurrentFolder"];
  /** Electron-owned opaque paired-directory browser/selection authority. */
  pairedFilesystemDirectory?: DispatchHandlerOptions["pairedFilesystemDirectory"];
  /** Electron-main exact-folder preparation/commit seam. */
  currentFolderAdoption?: DispatchHandlerOptions["currentFolderAdoption"];
  /** Electron-main → renderer seam used by cold-start browser_open. */
  ensureBrowserSurface?: DispatchHandlerOptions["ensureBrowserSurface"];
  /** Electron-main native navigation seam for the adopted Browser guest. */
  controlBrowserNavigation?: DispatchHandlerOptions["controlBrowserNavigation"];
  /** Single Electron-main-owned research target port; never interactive state. */
  browserResearchTargetPort?: Pick<BrowserResearchTargetManager,
    "createLease" | "getActiveLease" | "markChallenge" | "waitForDecision" | "prepareReobserve" | "release" |
    "retainConsentRecovery" | "getConsentRecovery" | "recordConsentRecoveryScreenshot"> | undefined;
  onBrowserResearchIntervention?: BrowserResearchReadExecutorDeps["onIntervention"];
}

export async function startRelay(options: StartRelayOptions): Promise<void> {
  // Reject direct overlap before constructing candidate-owned stores or
  // entering failure cleanup that is allowed to clear external CUA state.
  assertRelayCandidateMayBegin();
  const candidateSession = new DesktopRelaySession({
    serverUrl: options.serverUrl,
    ...(options.googleOAuthStatusToken === undefined
      ? {}
      : { token: options.googleOAuthStatusToken }),
    ...(options.googleOAuthClientPath === undefined
      ? {}
      : { clientPath: options.googleOAuthClientPath }),
    ...(options.onStatusChange === undefined
      ? {}
      : { onStatusChange: options.onStatusChange }),
  });
  let sessionClient: RelayClient | null = null;
  let candidatePublisher: RelayCapabilityPublisher | null = null;
  let candidateGeneration = -1;
  try {
  candidateGeneration = beginPendingRelayCandidate(candidateSession);
  await relayRetirementBarrier;
  assertCurrentRelayCandidate(candidateSession, candidateGeneration);
  // A reconnect or server switch must never leave the previous setup runtime
  // callable while the replacement relay is still authenticating.
  activeComputerUseRuntime = null;
  const hostedRelay = createDesktopHostedRelayAdapter({
    codexHostPort: options.codexHostPort,
    acpHostPort: options.acpHostPort,
    claudeConnectionHostPort: options.claudeConnectionHostPort,
    claudeExecutionHostPort: options.claudeExecutionHostPort,
  });

  // Workspace and Current Folder are distinct local surfaces. The
  // Workspace is provisioned by Electron before relay boot and is the safe
  // baseline for ordinary paired-mobile work. Current Folder is optional and
  // only augments the local jail when the Human has actually selected one.
  // Never revive the obsolete hidden product-data fallback here: it can be
  // denied by the sandbox and leaves a newly
  // paired computer unable to do basic work.
  const workspaceRoot = options.workspacePath;
  if (workspaceRoot.trim().length === 0) {
    throw new Error(
      "Desktop Genie Workspace is unavailable; create or repair the visible Workspace before starting the relay.",
    );
  }
  const currentFolderPathProvider = options.currentFolderPathProvider;
  const initialCurrentFolder = currentFolderPathProvider?.();
  const guard = createWorkspaceGuard({
    workspaceRoot,
    ...(initialCurrentFolder !== undefined ? { allowedRoots: [initialCurrentFolder] } : {}),
  });

  // report paths so the server\u0027s Policy
  // Resolver can build a sandboxProfile scoped to THIS machine.
  const userHome = os.homedir();
  const dataDir = path.join(userHome, ".nautilo");
  const toolsBin = resolveToolsBin();
  const isProduction = await resolveElectronIsPackaged();
  const browserCaps = await browserRuntimeCapabilities();
  const normalizeBrowserResearchScreenshot = async (bytes: Buffer<ArrayBufferLike>, width: number, height: number) => {
    const { nativeImage } = await import("electron");
    const image = nativeImage.createFromBuffer(bytes).resize({ width, height, quality: "best" });
    const size = image.getSize();
    if (image.isEmpty() || size.width !== width || size.height !== height) {
      throw new Error("Screenshot normalization failed.");
    }
    return { data: image.toPNG(), width: size.width, height: size.height };
  };
  const browserResearchRead = options.browserResearchTargetPort === undefined
    ? undefined
    : async (
      request: import("@nautilo/relay").RelayBrowserResearchReadRequest,
      signal?: AbortSignal,
      readOptions?: { readonly publishSnapshotReference?: boolean },
    ): Promise<RelayDispatchResult> => {
      // Continuations are consumed earlier by makeDispatchHandler and never
      // reach the lease-owning executor.
      if ("continuation" in request) {
        return { status: "error", error: "browser research continuation route is unavailable" };
      }
      const agentBrowserBin = resolveAgentBrowserBin();
      if (!agentBrowserBin) return { status: "error", error: "browser research read runtime is unavailable" };
      return new BrowserResearchReadExecutor({
        targetManager: options.browserResearchTargetPort!,
        agentBrowserBin,
        pluginRuntimeBin: resolvePluginRuntimeBin(),
        providerScriptPath: resolveBrowserControlProviderPath(),
        exec: (command, argv, execOptions) => execFileAsync(command, argv, execOptions),
        snapshotStore: candidateSession.browserPageSnapshotStore,
        ...(browserPageSnapshotOwner === undefined ? {} : { snapshotOwner: browserPageSnapshotOwner }),
        ...(readOptions?.publishSnapshotReference === true ? { publishSnapshotReference: true } : {}),
        ...(options.onBrowserResearchIntervention === undefined
          ? {}
          : { onIntervention: options.onBrowserResearchIntervention }),
      }).read(request, signal);
    };
  const browserResearchSearch = options.browserResearchTargetPort === undefined
    ? undefined
    : async (request: import("@nautilo/relay").RelayBrowserResearchSearchRequest, signal?: AbortSignal): Promise<RelayDispatchResult> => {
      const agentBrowserBin = resolveAgentBrowserBin();
      if (!agentBrowserBin) return { status: "error", error: "browser research search runtime is unavailable" };
      return new BrowserResearchSearchExecutor({
        targetManager: options.browserResearchTargetPort!,
        agentBrowserBin,
        pluginRuntimeBin: resolvePluginRuntimeBin(),
        providerScriptPath: resolveBrowserControlProviderPath(),
        exec: (command, argv, execOptions) => execFileAsync(command, argv, execOptions),
      }).search(request, signal);
    };
  const browserResearchConsentRecovery = options.browserResearchTargetPort === undefined
    ? undefined
    : async (request: import("@nautilo/relay").RelayBrowserResearchConsentRecoveryRequest, signal?: AbortSignal): Promise<RelayDispatchResult> => {
      const agentBrowserBin = resolveAgentBrowserBin();
      if (!agentBrowserBin) return { status: "error", error: "browser research consent recovery runtime is unavailable" };
      return new BrowserResearchReadExecutor({
        targetManager: options.browserResearchTargetPort!,
        agentBrowserBin,
        pluginRuntimeBin: resolvePluginRuntimeBin(),
        providerScriptPath: resolveBrowserControlProviderPath(),
        exec: (command, argv, execOptions) => execFileAsync(command, argv, execOptions),
        normalizeScreenshot: normalizeBrowserResearchScreenshot,
        snapshotStore: candidateSession.browserPageSnapshotStore,
        ...(browserPageSnapshotOwner === undefined ? {} : { snapshotOwner: browserPageSnapshotOwner }),
      }).recoverConsent(request, signal);
    };
  const googleWorkspaceCaps = await googleWorkspaceRuntimeCapabilities(
    candidateSession.googleOAuthContext,
    () => candidateSession.closed,
  );
  const hueCaps = await openHueRuntimeCapabilities();
  const officeCaps = await officeRuntimeCapabilities();
  // advertise only after the packaged/source-owned Darwin binary passes
  // exact manifest, architecture, integrity, and version/provenance handshake.
  // Unsupported, headless and old peers omit this optional capability.
  const applyPatchRuntime = resolveElectronApplyPatchDesktopRuntime({
    isPackaged: await resolveElectronPackagingState(),
    resourcesPath: process.resourcesPath ?? null,
    devVendorRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor"),
  });

  // stable relay id + relay-side MCP host so the
  // desktop app hosts the user's LOCAL MCPs (keyless-first; the manager's
  // default resolver reads env passthrough on this host).
  //
  // spawnEnvBase: GUI-launched Electron inherits a stripped env (no
  // ~/.zshrc PATH, no JAVA_HOME/ANDROID_HOME/...), and the MCP SDK's
  // safe-list would drop toolchain vars anyway. Pass the user's real
  // login-shell env as the child-spawn baseline — Claude Desktop/Cursor
  // parity on the user's own machine ("spawn maestro ENOENT" / "Unable to
  // locate a Java Runtime" class of failures).
  const relayId = resolvePersistedRelayId({
    identityFilePath: options.relayIdentityFilePath ?? path.join(dataDir, "relay-id"),
    ...(options.legacyRelayIdentityFilePath === undefined
      ? {}
      : { legacyIdentityFilePath: options.legacyRelayIdentityFilePath }),
  });
  if (
    options.localFileHistoryRootDir !== undefined &&
    options.legacyLocalHistoryRelayIdentityFilePath !== undefined
  ) {
    const previousRelayId = readPersistedRelayId(
      options.legacyLocalHistoryRelayIdentityFilePath,
    );
    if (previousRelayId !== null && previousRelayId !== relayId) {
      try {
        const migrated = await rebindLegacyLocalFileHistoryRelay({
          rootDir: options.localFileHistoryRootDir,
          previousRelayId,
          relayId,
        });
        if (migrated.status === "rebound") {
          console.info(
            `[desktop] rebound completed local mutation history from relay ${migrated.previousRelayId} to ${migrated.relayId}; backup: ${migrated.backupPath}`,
          );
        } else if (migrated.status === "refused") {
          console.warn(
            `[desktop] refused local mutation history relay rebind (${migrated.reason}); history remains bound to ${migrated.manifestRelayId}`,
          );
        }
      } catch (error) {
        console.warn(
          `[desktop] local mutation history relay rebind failed; history remains unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  // protocol v7 — one desktop session id per main-process launch, minted
  // outside startRelay (idempotent helper) so reconnects reuse the same id and
  // the server can bind capability updates to this exact session.
  const desktopSessionId = mintDesktopSessionId();
  // These local callbacks are captured by the session's security-sensitive
  // resolvers. A missing or disconnected client produces -1, which cannot
  // equal a protocol-valid non-negative capability revision, so every stale
  // binding fails closed without introducing a second revision owner.
  const getSessionAcknowledgedCapabilityRevision = (): number =>
    sessionClient?.getAcknowledgedCapabilityRevision() ?? -1;
  // prerequisite — use the shared main-process authority when the caller
  // (the Electron main process) provides one, so the resolver and snapshot
  // builder read the SAME durable + overlay source as the IPC handlers. The
  // fallback constructs a bare durable store for tests / the headless relay,
  // which never carry overlay grants.
  const desktopFilesystemGrantInstanceId = resolveInstance().instanceId;
  // the local broker runtime also owns the sole readiness probe used by
  // the strict, secret-free relay capability projection below.
  const structuredSshServerBindingId = deriveStructuredSshServerBindingId(
    options.serverUrl,
  );
  const computerUseServerBindingId = deriveComputerUseServerBindingId(options.serverUrl);
  const structuredSshRuntime = options.structuredSshAppDataDirectory === undefined || structuredSshServerBindingId === null
    ? null
    : createMovedStructuredSshDispatchRuntime({
        instanceId: desktopFilesystemGrantInstanceId,
        serverBindingId: structuredSshServerBindingId,
        userId: options.userId,
        relayId,
        desktopSessionId,
        appDataDirectory: options.structuredSshAppDataDirectory,
        workspaceRoot,
        getCapabilityRevision: getSessionAcknowledgedCapabilityRevision,
      });
  if (structuredSshRuntime !== null) {
    candidateSession.attachStructuredSshRuntime(structuredSshRuntime);
  }
  const browserPageSnapshotOwner: BrowserPageSnapshotOwnerBinding = {
    instanceId: desktopFilesystemGrantInstanceId,
    userId: options.userId,
    relayId,
    desktopSessionId,
  };
  const desktopFilesystemGrantStore: DesktopFilesystemGrantSnapshotStore =
    options.desktopFilesystemGrantAuthority ??
    new DesktopFilesystemGrantStore({
      instanceId: desktopFilesystemGrantInstanceId,
      filePath: desktopFilesystemGrantsFilePath(),
      legacyFilePath: legacyDesktopFilesystemGrantsFilePath(),
    });
  const desktopFilesystemGrantAuthority = createStartRelayDesktopFilesystemGrantAuthority({
    userId: options.userId,
    relayId,
    instanceId: desktopFilesystemGrantInstanceId,
    store: desktopFilesystemGrantStore,
  });
  const gitWritableGrantRootsProvider = () =>
    resolveGitWritableGrantRoots({
      store: desktopFilesystemGrantStore,
      expectedSubject: {
        userId: options.userId,
        instanceId: desktopFilesystemGrantInstanceId,
        relayId,
        agentScope: DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE,
      },
    });
  // capture the shared active-profile snapshot provider from the
  // single main-process controller BEFORE constructing the shell-binding
  // authority. Consumed directly from `options.workstationProfileController`
  // (not the module global) so a fresh `startRelay` constructs the resolver
  // even when the global was reset by a prior `stopRelay` — the global is
  // assigned from this local only for the capability builder / refresh
  // path. The relay never constructs its own profile store; it reads the
  // SAME controller the main process owns so there are no duplicate stores.
  // Null for the headless relay / tests that never bind a profile controller.
  const workstationProfileProvider = options.workstationProfileController ?? null;
  // build the plan-bound shell-binding authority resolver
  // from the SAME live grant store + shared active-profile controller the
  // grant-authority resolver reads, bound to this relay's identity + the
  // tracked capability revision. The dispatch handler revalidates a
  // `workstationShellBinding` against this live Electron state before a
  // `run_shell` dispatch may use profile-bound roots. Omitted resolver ⇒ the
  // dispatch handler fails closed (no server envelope is ever authority).
  const workstationShellBindingAuthority =
    workstationProfileProvider !== null
      ? createWorkstationShellBindingAuthorityResolver({
          store: desktopFilesystemGrantStore,
          expectedRelayId: relayId,
          expectedDesktopSessionId: desktopSessionId,
          getCapabilityRevision: getSessionAcknowledgedCapabilityRevision,
          getCurrentFolder: () => currentFolderPathProvider?.(),
          profileProvider: workstationProfileProvider,
          // source the COMPLETE active-profile network
          // policy from the SAME shared controller (it implements both the
          // snapshot + network-policy provider surfaces). The resolver
          // converts it and the dispatch handler REPLACES the server envelope's
          // network posture with it for a plan-bound shell. Conditionally
          // spread because the controller may be wired as a snapshot-only
          // provider (headless relay / stubs).
          ...(asRelayWorkstationProfileNetworkPolicyProvider(workstationProfileProvider) !==
          null
            ? {
                networkPolicyProvider:
                  asRelayWorkstationProfileNetworkPolicyProvider(workstationProfileProvider)!,
              }
            : {}),
          expectedSubject: {
            userId: options.userId,
            instanceId: desktopFilesystemGrantInstanceId,
            relayId,
            agentScope: DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE,
          },
        })
      : undefined;
  // compile the canonical protected-path policy once per
  // relay launch from the SAME `(home, platform, nautiloRoots)` inputs the
  // grant-authority resolver uses, and thread it into the dispatch handler.
  // When a plan-bound shell binding is revalidated, the handler rebuilds the
  // per-turn sandbox envelope LOCALLY so its read/write roots derive from
  // the revalidated policy-pack grants and this policy is compiled into
  // Seatbelt + bubblewrap as deny-overrides after allows. The server's
  // envelope is never authority and never widened on the wire.
  const nautiloRoot = resolveNautiloRootDir();
  const protectedPathPolicy = buildProtectedPathPolicy({
    homeDir: userHome,
    platform: process.platform,
    nautiloRoots: {
      privateRoot: path.join(nautiloRoot, "private"),
      dataRoot: path.join(nautiloRoot, "data"),
      auditRoot: path.join(nautiloRoot, "audit"),
    },
  });
  // The ledger's readers revalidate the current folder independently on every
  // durable access. Keep the closures local: request allowedRoots and server
  // paths never enter this authority construction.
  let securityScanCoordinator: DesktopSecurityScanCoordinator | undefined;
  if (options.securityResearchDataDirectory !== undefined) {
    const scannerRuntime = new SecurityScannerRuntimeManager(
      createNodeSecurityScannerRuntimeHost(path.join(options.securityResearchDataDirectory, "managed-security-scanners")),
      PRODUCTION_SECURITY_SCANNER_MANIFEST,
    );
    const resolveScanner = async (component: string, kind: "engine" | "rules", signal?: AbortSignal) => {
      const installed = await scannerRuntime.install(component, kind, signal ? { signal } : {});
      return { state: installed.details.state, internalPath: installed.internalPath };
    };
    const ledger = new DesktopSecurityScanLedger({
      userDataRoot: options.securityResearchDataDirectory,
      citationReader: {
        revalidateAndHash: async (citation, expectedRoot) => {
          if (securityScanCoordinator === undefined) throw new Error("Security research coordinator is unavailable.");
          return await securityScanCoordinator.revalidateAndHash(citation, expectedRoot);
        },
      },
      rootIdentityReader: {
        revalidate: async (expectedRoot) => {
          if (securityScanCoordinator === undefined) throw new Error("Security research coordinator is unavailable.");
          return await securityScanCoordinator.revalidateRoot(expectedRoot);
        },
      },
    });
    securityScanCoordinator = new DesktopSecurityScanCoordinator({
      ledger,
      getLocalWorkspacePath: () => currentFolderPathProvider?.(),
      protectedPathPolicy,
      localOwnerIdentity: `${options.serverUrl}\u0000${options.userId}`,
      probeDeps: {
        scratchRoot: path.join(options.securityResearchDataDirectory, "probe-scratch"),
        cacheRoot: path.join(options.securityResearchDataDirectory, "security-scanner-cache"),
        // Exact app-owned manifest identities only; never PATH, Homebrew, pip,
        // Docker, a server-provided URL, or a model-provided executable.
        resolveGitleaks: (signal) => resolveScanner("gitleaks", "engine", signal),
        resolveOsvScanner: (signal) => resolveScanner("osv-scanner", "engine", signal),
        resolveTrivy: (signal) => resolveScanner("trivy", "engine", signal),
        resolveSemgrep: (signal) => resolveScanner("semgrep", "engine", signal),
        resolveSemgrepRules: (signal) => resolveScanner("semgrep-nautilo-rules", "rules", signal),
      },
    });
  }
  const localShellWorkspaceAuthority =
    desktopFilesystemGrantStore !== undefined
      ? createLocalShellWorkspaceAuthorityResolver({
          store: desktopFilesystemGrantStore,
          expectedSubject: {
            userId: options.userId,
            instanceId: desktopFilesystemGrantInstanceId,
            relayId,
            agentScope: DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE,
          },
          protectedPathPolicy,
        })
      : undefined;
  // This builder belongs to this relay session. The publisher and reconnect
  // callback retain this exact closure, so a later stop/start cannot redirect
  // a refresh or reconnect toward another session's local authorities.
  const capabilitiesBuilder = async (): Promise<RelayCapabilities> => {
    const snapshot = await buildDesktopFilesystemGrantSnapshot({
      store: desktopFilesystemGrantStore,
      userId: options.userId,
      instanceId: desktopFilesystemGrantInstanceId,
      relayId,
    });
    const profileSnapshot = await resolveDesktopProfileAdvertisement(
      workstationProfileProvider,
    );
    const structuredSsh = structuredSshRuntime === null
      ? undefined
      : await resolveMovedStructuredSshReadiness(structuredSshRuntime);
    let desktopAutomation: DesktopAutomationCapabilitySnapshot | undefined;
    try {
      desktopAutomation = await options.computerUseSnapshotProvider?.();
    } catch {
      desktopAutomation = undefined;
    }
    const nonComputerUseCapabilities = composeDesktopNonComputerUseCapabilities({
      browserRuntime: browserCaps,
      hasResearchRead: browserResearchRead !== undefined,
      hasResearchConsentRecovery: browserResearchConsentRecovery !== undefined,
      hasResearchSearch: browserResearchSearch !== undefined,
      googleWorkspaceRuntime: googleWorkspaceCaps,
      hueRuntime: hueCaps,
      hosted: hostedRelay.capabilities(),
    });
    const currentFolderRoot = currentFolderPathProvider?.();
    return {
      profile: "desktop-agent",
      // Non-authoritative schema marker for the current Computer Use contract.
      // It is present whether Computer Use is On or Off; the separate exact
      // desktopAutomation snapshot below remains the sole execution authority.
      computerUseSemanticVersion: 2,
      // Readiness plus exact authority are projected atomically from the same
      // fresh, generation-bound Cua snapshot.
      ...projectComputerUseRelayCapabilities(desktopAutomation),
      canReadWorkspace: true,
      canWriteWorkspace: true,
      // Directory-only paired-phone selection is a separate capability from
      // generic workspace reads; it exposes no root paths or file reads.
      canBrowsePairedFilesystem: true,
      // M206 — typed local-file execution for current/absolute unified file tool.
      localFileExecution: true,
      ...applyPatchExecutionCapability(
        applyPatchRuntime,
        options.commitDesktopApplyPatch !== undefined &&
          options.resolveApplyPatchTrustedIdentity !== undefined,
      ),
      ...officeCaps,
      canRunShell: true,
      // this Electron relay hosts the PTY pool (terminal-host.ts),
      // so it advertises terminal capability; the standalone relay does not.
      canUseTerminal: true,
      ...(peekAgentHandoffSession() !== null
        ? { hasPendingTerminalHandoff: true }
        : {}),
      canReadStructuredSshOutput: true,
      ...nonComputerUseCapabilities,
      // named roots are server-private registration metadata for exact
      // host resolution. They are deliberately excluded from remote presence
      // projection and are never execution authority without local checks.
      workspaceRoot,
      ...(currentFolderRoot !== undefined
        ? { currentFolderRoot }
        : {}),
      // This is the generic relay jail contract. Keep the always-usable Genie
      // Workspace first; the optional Current Folder is an additional local
      // root, never a replacement baseline.
      allowedRoots: [...guard.roots],
      securityLevel: "standard",
      userHome,
      dataDir,
      toolsBin,
      // advisory active-grant discovery hint (desktop relay only; the
      // headless relay never advertises this). Omitted when the store is
      // unavailable so the server sees "no advisory snapshot" rather than a
      // partial one. Still advisory: the local resolver decides final authority.
      ...(snapshot ? { desktopFilesystemGrantSnapshot: snapshot } : {}),
      // advisory Workstation Profile binding snapshot (desktop relay
      // only). Redacted, non-secret profile state from the shared
      // main-process controller. Omitted when no profile is bound or the
      // controller is unavailable so the server sees "no binding" rather
      // than a partial one. Still advisory: the relay's live compiled-profile
      // authority remains final, so a stale or revoked binding fails closed.
      ...(profileSnapshot ? { workstationProfileSnapshot: profileSnapshot } : {}),
      ...(structuredSsh !== undefined ? { structuredSsh } : {}),
    };
  };
  const initialCapabilities = await capabilitiesBuilder();
  assertCurrentRelayCandidate(candidateSession, candidateGeneration);
  const candidateMcpHost = createRelayMcpHost({
    relayId,
    spawnEnvBase: loginShellSpawnEnvBase(),
  });
  candidateSession.attachMcpHost(candidateMcpHost);

  // Reconnects retain this session-local builder rather than consulting a
  // replaceable module global, so a later relay handoff cannot re-register
  // another session's grant or profile projection.
  let pendingComputerUseTopologyReconciliation = false;
  let candidateComputerUseRuntime: ComputerUseDispatchRuntime | null = null;
  const refreshCandidateCapabilities = (reason?: string): Promise<boolean> => {
    if (candidatePublisher === null || capabilityPublisher !== candidatePublisher) {
      return Promise.resolve(false);
    }
    return candidatePublisher.refresh(reason);
  };
  const applyCandidateComputerUseTopology = (
    topology: AuthenticatedDesktopTopology | null,
  ): boolean => {
    const next = projectComputerUseDispatchRuntime({
      topology,
      serverBindingId: computerUseServerBindingId,
      instanceId: desktopFilesystemGrantInstanceId,
      humanUserId: options.userId,
    });
    const requiresReconciliation = requiresComputerUseTopologyReconciliation(
      candidateComputerUseRuntime,
      next,
    );
    candidateComputerUseRuntime = next;
    activeComputerUseRuntime = next;
    return requiresReconciliation;
  };
  const reconcileCandidateComputerUseTopology = (
    topology: AuthenticatedDesktopTopology | null,
  ): void => {
    if (candidatePublisher === null || capabilityPublisher !== candidatePublisher) {
      // Registration can publish topology before `connect()` resolves. Keep
      // that first reconciliation local until this exact publisher becomes
      // active; retired or failed candidates cannot reach a replacement.
      if (topology !== null) pendingComputerUseTopologyReconciliation = true;
      return;
    }
    if (applyCandidateComputerUseTopology(topology)) {
      void options.onComputerUseTopologyChange?.(refreshCandidateCapabilities);
    }
  };
  const relayHostLaunch = resolveDesktopRelayHostLaunch({
    isPackaged: isProduction,
    resourcesPath: process.resourcesPath ?? null,
    devVendorRoot: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "vendor",
      "relay-host",
    ),
  });
  const candidateClient = createDesktopRelaySidecarClient({
    ...relayHostLaunch,
    expectedHostVersion: relayHostLaunch.hostVersion,
    serverUrl: options.serverUrl,
    relayId,
    userId: options.userId,
    runShellOwnerInstanceId: desktopFilesystemGrantInstanceId,
    browserPageOwnerInstanceId: desktopFilesystemGrantInstanceId,
    capabilities: initialCapabilities,
    desktopSessionId,
    initialCapabilityRevision: 0,
    getCapabilities: capabilitiesBuilder,
    onDesktopTopologyChange: reconcileCandidateComputerUseTopology,
    ...(options.token ? { token: options.token } : {}),
    ...(structuredSshRuntime !== null
      ? { onSshPrepare: (request: RelaySshPrepareRequestV1) => prepareMovedStructuredSsh(request, structuredSshRuntime) }
      : {}),
    onDispatch: makeDispatchHandler(guard, {
      isProduction,
      relayId,
      ...(options.computerUseDispatch !== undefined
        ? { computerUseDispatch: options.computerUseDispatch }
        : {}),
      ...(structuredSshRuntime !== null ? { structuredSsh: structuredSshRuntime } : {}),
      ...(options.commitDesktopApplyPatch
        ? { commitDesktopApplyPatch: options.commitDesktopApplyPatch }
        : {}),
      ...(options.commitDesktopOfficeCli
        ? { commitDesktopOfficeCli: options.commitDesktopOfficeCli }
        : {}),
      ...(options.commitDesktopAgentContent
        ? { commitDesktopAgentContent: options.commitDesktopAgentContent }
        : {}),
      ...(options.commitDesktopAgentStructural
        ? { commitDesktopAgentStructural: options.commitDesktopAgentStructural }
        : {}),
      ...(options.commitDesktopHistoryRestore
        ? { commitDesktopHistoryRestore: options.commitDesktopHistoryRestore }
        : {}),
      ...(options.resolveApplyPatchTrustedIdentity
        ? { resolveApplyPatchTrustedIdentity: options.resolveApplyPatchTrustedIdentity }
        : {}),
      desktopFilesystemGrantAuthority,
      ...(workstationShellBindingAuthority !== undefined
        ? { workstationShellBindingAuthority }
        : {}),
      protectedPathPolicy,
      ...(securityScanCoordinator !== undefined ? { securityScanCoordinator } : {}),
      trustedToolsBin: toolsBin,
      // apply_patch and profile-bound shells are explicitly Current-Folder
      // operations. Returning undefined preserves their fail-closed contract
      // instead of silently mutating/running in Genie Workspace.
      getLocalWorkspacePath: () => currentFolderPathProvider?.(),
      // raw workstation execution is distinct from Current-Folder-bound
      // operations: it may use the always-present visible Genie Workspace
      // when no optional Current Folder is selected.
      workstationWorkspacePath: workspaceRoot,
      ...(localShellWorkspaceAuthority !== undefined
        ? { localShellWorkspaceAuthority }
        : {}),
      // local authority-boundary correction — the dispatch handler
      // refuses an unbound generic run_shell while the shared
      // main-process controller reports a locally authoritative active
      // profile (and on lookup failure). Same provider the capability
      // builder reads; no duplicate profile state. Omitted for the
      // headless relay / tests that never bind a profile controller.
      ...(workstationProfileProvider !== null
        ? { workstationProfileStateProvider: workstationProfileProvider }
        : {}),
      workstationIdentityHomePath: userHome,
      gitWritableGrantRootsProvider,
      ...(options.runWorkstationShell !== undefined
        ? { runWorkstationShell: options.runWorkstationShell }
        : {}),
      ...(options.verifyUncontainedHostCommands !== undefined
        ? { verifyUncontainedHostCommands: options.verifyUncontainedHostCommands }
        : {}),
      runShellOutputArtifactStore: candidateSession.runShellOutputArtifactStore,
      browserPageSnapshotStore: candidateSession.browserPageSnapshotStore,
      mediaSessions: candidateSession.mediaSessions,
      browserCoordinateScales: candidateSession.browserCoordinateScales,
      googleOAuthContext: candidateSession.googleOAuthContext,
      isSessionClosed: () => candidateSession.closed,
      settleBoundWork: (work) => candidateSession.settleBoundWork(work),
      ...(options.selectCurrentFolder !== undefined
        ? { selectCurrentFolder: options.selectCurrentFolder }
        : {}),
      ...(options.pairedFilesystemDirectory !== undefined
        ? { pairedFilesystemDirectory: options.pairedFilesystemDirectory }
        : {}),
      ...(options.currentFolderAdoption !== undefined
        ? { currentFolderAdoption: options.currentFolderAdoption }
        : {}),
      ...(options.ensureBrowserSurface !== undefined
        ? { ensureBrowserSurface: options.ensureBrowserSurface }
        : {}),
      ...(options.controlBrowserNavigation !== undefined
        ? { controlBrowserNavigation: options.controlBrowserNavigation }
        : {}),
      ...(browserResearchRead !== undefined ? { browserResearchRead } : {}),
      ...(browserResearchConsentRecovery !== undefined ? { browserResearchConsentRecovery } : {}),
      ...(browserResearchSearch !== undefined ? { browserResearchSearch } : {}),
      ...(options.onFsChange ? { onFsChange: options.onFsChange } : {}),
    }),
    onStatusChange: (status: RelayStatus) => {
      candidateSession.statusCallback?.(status);
    },
    ...hostedRelay.clientPorts(candidateMcpHost),
  });

  sessionClient = candidateClient;
  candidatePublisher = createRelayCapabilityPublisher({
    client: candidateClient,
    capabilityBuilder: capabilitiesBuilder,
  });
  candidateSession.attachTransport(candidateClient, candidatePublisher);
  const activated = await connectAndActivateRelayCandidate({
    session: candidateSession,
    generation: candidateGeneration,
    connect: () => candidateClient.connect(),
    activate: () => {
      activeRelaySession = candidateSession;
      capabilityPublisher = candidatePublisher;
    },
  });
  if (!activated) throw new Error("Desktop relay start was superseded.");
  // The client only publishes topology after a server acknowledgement.  Keep
  // the setup route unavailable if an older relay protocol omitted it.
  const topology = candidateClient.getDesktopTopology();
  const requiresComputerUseReconciliation = applyCandidateComputerUseTopology(topology);
  if (pendingComputerUseTopologyReconciliation) {
    pendingComputerUseTopologyReconciliation = false;
    if (requiresComputerUseReconciliation) {
      void options.onComputerUseTopologyChange?.(refreshCandidateCapabilities);
    }
  }
  } catch (error) {
    sessionClient = null;
    if (pendingRelayCandidate?.session === candidateSession) {
      pendingRelayCandidate = null;
      relayLifecycleGeneration += 1;
    }
    if (activeRelaySession === candidateSession) activeRelaySession = null;
    if (capabilityPublisher === candidatePublisher) capabilityPublisher = null;
    activeComputerUseRuntime = null;
    const retired = candidateSession.retire();
    try {
      await retired.client?.disconnect();
    } catch {
      // A failed relay start must preserve the original start error.
    }
    try {
      await retired.mcpHost?.stop();
    } catch {
      // A failed relay start must preserve the original start error.
    }
    await candidateSession.finishRetirement();
    throw error;
  }
}

export async function stopRelay(): Promise<void> {
  relayLifecycleGeneration += 1;
  const pendingSessionToRetire = pendingRelayCandidate?.session ?? null;
  pendingRelayCandidate = null;
  const activeSessionToRetire = activeRelaySession;
  activeRelaySession = null;
  capabilityPublisher = null;
  activeComputerUseRuntime = null;
  const sessionsToRetire = pendingSessionToRetire === null
    ? activeSessionToRetire === null ? [] : [activeSessionToRetire]
    : activeSessionToRetire === null || activeSessionToRetire === pendingSessionToRetire
      ? [pendingSessionToRetire]
      : [pendingSessionToRetire, activeSessionToRetire];
  const retiredSessions = sessionsToRetire.map((session) => ({
    session,
    retired: session.retire(),
  }));
  const previousRetirement = relayRetirementBarrier;
  if (retiredSessions.length === 0) {
    await previousRetirement;
    return;
  }

  const shutdown = (async () => {
    await previousRetirement;
    let firstError: unknown;
    for (const { session, retired } of retiredSessions) {
      // LIFO: stop hosted MCP children before dropping the socket. Disconnect
      // precedes bound-work settlement so transport-dependent dispatch can end.
      try {
        await retired.mcpHost?.stop();
      } catch (error) {
        firstError ??= error;
      }
      try {
        await retired.client?.disconnect();
      } catch (error) {
        firstError ??= error;
      } finally {
        await session.finishRetirement();
      }
    }
    if (firstError !== undefined) {
      throw firstError instanceof Error ? firstError : new Error("Desktop relay shutdown failed.");
    }
  })();
  relayRetirementBarrier = shutdown.then(
    () => {},
    () => {},
  );
  await shutdown;
}

export function getRelayStatus(): RelayStatus {
  return activeRelaySession?.client?.getStatus() ?? "disconnected";
}

/**
 * protocol v7 — rebuild this relay's full advertised capability state
 * from local state and push it to the server via the atomic
 * `relay:update-capabilities` transport, WITHOUT a stop/start reconnect.
 *
 * Used by the desktop-filesystem-grant create/revoke re-advertisement path:
 * after a local grant mutation, the bridge calls this instead of tearing the
 * relay down and re-registering. The active session publisher rebuilds from
 * the SAME local store the resolver reads, so overlay grants are visible to
 * discovery. The snapshot stays advisory; the relay-local resolver still
 * decides every filesystem access, so stale/revoked entries fail closed.
 *
 * Returns `true` when an update was sent, `false` when the relay is not
 * connected (the snapshot will be rebuilt from local state at the next
 * register) or no active publisher is available. Never throws — publication
 * anomalies are logged by the publisher.
 */
export async function refreshDesktopRelayCapabilities(reason?: string): Promise<boolean> {
  return activeRelaySession?.publisher?.refresh(reason) ?? false;
}

/**
 * M161 Phase 2 — active-only relay handoff (stop-before-start).
 *
 * Relay ownership moves to the active session: exactly one relay client
 * is live at a time. `setActiveRelay` awaits `stopRelay()` for the
 * previous relay BEFORE `await startRelay(...)` for the target session,
 * so there is never more than one connected relay client and the
 * previous server's WS connection / Google OAuth context is torn down
 * before the next server's is established. `stopRelay` is awaited
 * unconditionally: when no relay is running it is a no-op (the
 * active session is null), so the ordering guarantee holds
 * without a "is anything running" check that could race a concurrent
 * status transition.
 *
 * After a successful start, the target session's `relayActive` flag is
 * set and every other session's is cleared via
 * `registry.setRelayActiveFor(session.scope)` — so a background
 * session always has `relayActive === false` after a handoff. The
 * `StartRelayOptions.serverUrl` MUST be the target session's canonical
 * URL; `startRelay` constructs a fresh exact Google OAuth context from it, so
 * background OAuth context does not leak across servers (issue safety
 * boundary #4).
 *
 * Phase 2 exercises this only through the boot path (one session) and
 * the test seam; Phase 3 calls it during real switching.
 */
export async function setActiveRelay(
  registry: ServerSessionRegistry,
  session: ServerSession,
  options: StartRelayOptions,
): Promise<void> {
  const handoffGeneration = ++relayHandoffGeneration;
  const previousStop = relayHandoffStopBarrier;
  const stopOperation = (async () => {
    await previousStop;
    await (stopRelayHook ? stopRelayHook() : stopRelay());
  })();
  relayHandoffStopBarrier = stopOperation.then(
    () => {},
    () => {},
  );
  await stopOperation;
  if (handoffGeneration !== relayHandoffGeneration) return;
  try {
    await (startRelayHook ? startRelayHook(options) : startRelay(options));
  } catch (error) {
    if (handoffGeneration !== relayHandoffGeneration) return;
    throw error;
  }
  if (handoffGeneration !== relayHandoffGeneration) return;
  registry.setRelayActiveFor(session.scope);
}

/**
 * M161 Phase 2 — test-only seam for `setActiveRelay`. Injects mock
 * start/stop hooks so the handoff ordering (stop awaited before start,
 * one client maximum) can be asserted without a live relay connection
 * or a real Electron runtime. Pass `null` to restore the real
 * `startRelay` / `stopRelay`.
 */
export const relayHandoffForTests = {
  setStartStopHooks(
    start: ((options: StartRelayOptions) => Promise<void>) | null,
    stop: (() => Promise<void>) | null,
  ): void {
    startRelayHook = start;
    stopRelayHook = stop;
  },
};

/** Narrow race seam over the same pending-candidate coordinator used above. */
export const relaySessionLifecycleForTests = {
  beginCandidate(session: DesktopRelaySession): number {
    return beginPendingRelayCandidate(session);
  },
  connectAndActivate(
    session: DesktopRelaySession,
    generation: number,
    connect: () => Promise<void>,
    activate: () => void,
  ): Promise<boolean> {
    return connectAndActivateRelayCandidate({
      session,
      generation,
      connect,
      activate,
    });
  },
  activateCandidate(session: DesktopRelaySession, generation: number): Promise<boolean> {
    return connectAndActivateRelayCandidate({
      session,
      generation,
      connect: async () => {},
      activate: () => {
        activeRelaySession = session;
        capabilityPublisher = session.publisher;
      },
    });
  },
};

let startRelayHook: ((options: StartRelayOptions) => Promise<void>) | null = null;
let stopRelayHook: (() => Promise<void>) | null = null;
/** Last-request-wins fence for overlapping public relay handoffs. */
let relayHandoffGeneration = 0;
/** Serializes overlapping public stop phases without delaying stale-start invalidation. */
let relayHandoffStopBarrier: Promise<void> = Promise.resolve();

export {
  isGogAuthHealthy,
  relayBinaryResolutionForTests,
  resolveGogBin,
  resolveOpenHueBin,
};
