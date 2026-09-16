/**
 * `@nautilo/sandbox` — OS-level sandbox containment for LLM-emitted
 * shell commands.
 *
 * D060 Phase 1 (Linux bubblewrap) + Phase 2 (macOS Seatbelt). The
 * package is a leaf — depends on `@nautilo/logger` only. Consumers
 * are the agent's `run_shell` factory and the D063 smoke harness.
 *
 * Architecture and supported boundaries: `packages/sandbox/README.md`.
 * Primary reference: `EXTERNAL/spacebot/src/sandbox.rs` (ported 1:1
 * with TS adaptations).
 *
 * Phase 1 scope in this module:
 *   1.1 ✓ Package scaffold + core types + path helpers (this commit)
 *   1.2   Env var taxonomy (SAFE / RESERVED / DANGEROUS)
 *   1.3   Backend detection (bwrap probe + /proc check)
 *   1.4   Sandbox class base shape
 *   1.5   Bubblewrap arg builder
 *   1.6   Dispatcher (+ macOS stub for Phase 2)
 *   1.7   Security-level → sandbox-mode mapping
 *   1.8   run_shell integration (consumer-side)
 *   1.9   D063 SANDBOX-LINUX-* smoke matrix
 *
 * Public surface grows with each task; this index re-exports only
 * what's been implemented so typecheck catches missing pieces.
 */

export {
  type SandboxMode,
  type SandboxBackend,
  type SandboxConfig,
  type SpawnArgs,
  DEFAULT_SANDBOX_CONFIG,
} from "./types";

export {
  canonicalize,
  tryRealpath,
  pushUniquePath,
} from "./paths";

export {
  SAFE_ENV_VARS,
  RESERVED_ENV_VARS,
  DANGEROUS_ENV_VARS,
  isReservedEnvVar,
  isDangerousEnvVar,
} from "./env-vars";

export {
  detectBackend,
  detectBackendCore,
  realProber,
  type Prober,
} from "./detect";

export {
  LINUX_READ_ONLY_SYSTEM_PATHS,
  MACOS_READ_ONLY_SYSTEM_PATHS,
} from "./system-paths";

export { Sandbox, type SandboxCreateOptions } from "./sandbox";

export { buildBubblewrap, type BubblewrapBuildOptions } from "./bubblewrap";

export { buildPassthrough, type PassthroughBuildOptions } from "./passthrough";

export { buildSandboxExec, type SandboxExecBuildOptions } from "./seatbelt";

export {
  BASE_SEATBELT_PROFILE,
  NETWORK_ALLOW_RULES,
  GOVERNANCE_FILES,
  SECRET_FILES,
  buildSbplProfile,
  escapeSchemeString,
  escapeRegexForSchemeLiteral,
  type SbplProfileOptions,
} from "./seatbelt-profile";

export {
  sandboxPolicyForLevel,
  type SecurityLevel,
  type SandboxPolicy,
} from "./security-level";

export {
  serverRestrictive,
  desktopPermissive,
  desktopLocked,
  type DeploymentProfileInputs,
  type SandboxProfileSpec,
} from "./profiles";

export {
  createSandboxFromEnvelope,
  validateSandboxEnvelope,
  SandboxEnvelopeValidationError,
  type SandboxEnvelopeLike,
} from "./from-envelope";

export {
  resolveRelayDispatchSandbox,
  unusableCurrentFolderError,
  hasSandboxCwdFailure,
  sandboxCurrentFolderError,
  type RelayDispatchSandboxFactory,
  type RelayDispatchSandboxLocalAuthority,
  type RelayDispatchSandboxResolution,
  type ResolveRelayDispatchSandboxOptions,
} from "./relay-dispatch-policy";

export {
  spawnSandboxed,
  type SpawnSandboxedOptions,
  type SpawnSandboxedResult,
} from "./spawn";

export {
  DEFAULT_NETWORK_PORT,
  DnsResolutionError,
  HOST_NETWORK_POLICY,
  ISOLATED_NETWORK_POLICY,
  createDnsResolver,
  isPublicRoutableAddress,
  evaluateNetworkEgress,
  normalizeHost,
  startNetworkProxy,
  type DnsLookupFn,
  type DnsResolver,
  type DnsResolverOptions,
  type NetworkAllowRule,
  type NetworkDecision,
  type NetworkPolicy,
  type NetworkProxy,
  type NetworkProxyDecisionEvent,
  type NetworkProxyOptions,
} from "./network";

// D440 Phase 2 — typed Git broker (operation-aware sandbox
// defense-in-depth). See `git-broker/README` block in `broker.ts`.
export {
  GitBroker,
  GitPreflightError,
  canonicalizeRepositoryIdentity,
  rejectAlternates,
  rejectSubmodules,
  rejectEscapingSymlinks,
  rejectLiveEnvPath,
  normalizePathspec,
  validateWorktreeTarget,
  auditLocalConfig,
  isUnderRoot as gitBrokerIsUnderRoot,
  compileGitBrokerProfile,
  buildGitBrokerEnv,
  gitBrokerConfigOverrides,
  type GitOperation,
  type GitBrokerDisposition,
  type GitBrokerOptions,
  type GitBrokerAuthority,
  type GitRepositoryIdentity,
  type BrokerRegisteredWorktree,
  type GitDispositionReason,
  type GitProfileInputs,
} from "./git-broker";
