/**
 * @nautilo/cli-auth — shared administrator CLI authentication primitives.
 * Loopback-PKCE, device-flow, session, browser, and headless-detection code
 * lives here without coupling the CLI to an interactive client runtime.
 */

export {
  generatePkcePair,
  generateState,
  startLoopbackServer,
  runLoopbackPkce,
  type LoopbackPkceArgs,
  type LoopbackPkceResult,
  type LoopbackHandle,
  type StartLoopbackOptions,
} from "./loopback-pkce";

export {
  runDeviceFlow,
  refreshAccessToken,
  revokeRefreshToken,
  __setDeviceFlowFetch,
  __setDeviceFlowSleep,
  type DeviceCodeResponse,
  type TokenResponse,
  type DeviceFlowConfig,
  type DeviceFlowEvent,
  type RefreshOutcome,
  type RevokeArgs,
} from "./device-flow";

export {
  detectHeadless,
  detectHeadlessForPlatform,
  type HeadlessDecision,
} from "./headless-detect";

export { decideAuthMode } from "./auth-mode";

export { normalizeDeviceAuthorizationInstruction } from "./device-instruction";

export { openUrlInDefaultBrowser, openUrlInDefaultBrowserChecked } from "./browser";

// Session — Phase 0 ships a thin wrapper over @nautilo/api-client's
// existing single-file session store. Phase 1 adds per-profile helpers.
export {
  loadCliSession,
  saveCliSession,
  clearCliSession,
  requireSession,
  touchCliSessionObtainedAt,
  loadCliSessionForActiveProfile,
  saveCliSessionForActiveProfile,
  dropCliSessionForActiveProfile,
  requireSessionForActiveProfile,
  touchCliSessionObtainedAtForActiveProfile,
  setActiveProfileResolver,
  CliSessionMissingError,
  CliSessionExpiredError,
  CliSessionFileModeError,
  type CliSessionV1Payload,
  type ActiveProfileResolver,
} from "./session";
