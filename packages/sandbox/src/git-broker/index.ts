/**
 * D440 Phase 2 — typed Git broker public surface.
 *
 * Re-exports the broker class, types, and preflight primitives.
 * The package-level `index.ts`
 * re-exports this module so consumers (relay, tests) import from
 * `@nautilo/sandbox`.
 */

export { GitBroker, GitPreflightError } from "./broker";
export {
  canonicalizeRepositoryIdentity,
  rejectAlternates,
  rejectSubmodules,
  rejectEscapingSymlinks,
  rejectLiveEnvPath,
  normalizePathspec,
  validateWorktreeTarget,
  auditLocalConfig,
  isUnderRoot,
} from "./preflight";
export { compileGitBrokerProfile } from "./profile";
export type { GitProfileInputs } from "./profile";
export {
  buildGitBrokerEnv,
  gitBrokerConfigOverrides,
} from "./execute";
export type {
  Manifest,
  ManifestEntry,
  WorktreeBlobMode,
} from "./materialize";
export type {
  GitOperation,
  GitBrokerDisposition,
  GitBrokerOptions,
  GitBrokerWorktreeLimits,
  GitBrokerAuthority,
  GitRepositoryIdentity,
  BrokerRegisteredWorktree,
  GitDispositionReason,
} from "./types";
