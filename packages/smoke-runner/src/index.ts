/**
 * @nautilo/smoke-runner — security smoke testing library.
 *
 * Public surface. Consumers:
 *   - bin/nautilo-smoke — CLI
 *   - nautilo-smoke serve — HTTP API
 *   - dev/tools/security-smoke — stdio MCP server
 *
 * Each consumer is a thin adapter over this library. Behavior lives
 * here; surfaces don't duplicate it.
 *
 * Phase 2 scope: types, driver interface, expectations loader, runner.
 * LimaDriver / TartDriver / Runner / Reporter land in subsequent tasks.
 */

export type {
  Platform,
  Mode,
  SecurityLevel,
  TestSpec,
  TestLayer,
  TestResult,
  TestOutcome,
  WatchdogEvent,
  ProbeName,
  RunReport,
  RunSummary,
  HealthProbeResult,
  ExecResult,
  ExecOptions,
  HoneypotVerifyReport,
  ToolCallResult,
  ToolCallRequest,
  ToolInvocationRequest,
  ToolInvocationResponse,
  ToolInvocationLayer,
} from "./types.ts";

export { ALL_PLATFORMS, ALL_SECURITY_LEVELS } from "./types.ts";

export type { VmDriver, VmStatus, HealthProbeOptions, DriverInfo } from "./driver.ts";

export { LimaDriver, type LimaDriverOptions } from "./lima-driver.ts";

export { TartDriver, type TartDriverOptions } from "./tart-driver.ts";

export {
  HealthWatchdog,
  type HealthWatchdogOptions,
  type WatchdogDeadHandler,
} from "./watchdog.ts";

export {
  VmScanClient,
  HttpScanClient,
  VmToolInvocationClient,
  HttpToolInvocationClient,
  type NautiloClient,
  type ToolInvocationClient,
  type VmToolInvocationClientOptions,
  type HttpToolInvocationClientOptions,
  type SecurityScanRequest,
  type SecurityScanResult,
  type VmScanClientOptions,
  type HttpScanClientOptions,
  type ScanLayer,
  type ResultScanPolicy,
} from "./nautilo-client.ts";

export { Expectations } from "./expectations.ts";

export {
  Runner,
  runHoneypotVerify,
  type RunnerOptions,
  type RunnerEvent,
  type RunFilter,
} from "./runner.ts";

export { runCommand, type RunCommandOptions, type RunCommandResult } from "./exec.ts";

export {
  formatJson,
  formatMarkdown,
  formatReport,
  type ReportFormat,
} from "./reporter.ts";

export {
  getOrCreateToken,
  rotateToken,
  readPersistedToken,
  maskToken,
  type TokenOptions,
} from "./token.ts";

export {
  createSmokeServer,
  matchPattern,
  sendJson,
  type SmokeServer,
  type SmokeServerOptions,
  type RouteHandler,
  type HandlerContext,
} from "./server.ts";

export {
  RunRegistry,
  type RunnerConfig,
  type RunRecord,
  type RunStatus,
  type RunProgress,
  type RunEventSubscriber,
  type RunRegistryOptions,
} from "./run-registry.ts";

export {
  stopAllDrivers,
  registerShutdownHandlers,
  type NamedDriver,
  type StopAllOptions,
  type ShutdownOptions,
} from "./shutdown.ts";
