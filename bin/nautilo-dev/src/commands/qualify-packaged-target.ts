/**
 * Test-only packaged-target browser qualification.
 *
 * This command deliberately reuses D508's fresh-browser administrator proof:
 * a clean real-Logto browser signs in through the server guide and performs a
 * PIN-gated posture mutation. It accepts only a loopback disposable target and
 * a protected deploy TOML; credentials never enter argv, environment, logs,
 * or the redacted receipt.
 */
import { isAbsolute, resolve } from "node:path";
import {
  type DeployConfig,
  type ResolvedDeployConfig,
  parseDeployConfigFromPath,
  planAdminRedemption,
  resolveDeployConfig,
} from "@nautilo/deploy-config";
import { isLoopbackHostname } from "@nautilo/config/loopback-origin";
import {
  DEFAULT_D508_QUALIFICATION_TIMING,
  D508QualificationError,
  type D508FreshBrowserAdminEvidence,
  type D508FreshBrowserAdminQualificationInput,
  type D508QualificationTimingPolicy,
  D508_DISPOSABLE_INSTANCE_ID_RE,
  type RedactedNavigationObservation,
  type RedactedRequestObservation,
  runD508FreshBrowserAdminQualification,
} from "./qualify-owner-claim";

export type PackagedTargetQualificationArgs = Readonly<{
  disposable: true;
  serverUrl: string;
  ownerConfigPath: string;
  targetInstanceId: string;
}>;

export type PackagedTargetQualificationReceipt =
  | Readonly<{
    outcome: "passed";
    qualifier: "packaged-target-browser";
    evidence: Readonly<{
      explicitDisposableOptIn: true;
      loopbackCredentialFreeOrigin: true;
      protectedOwnerConfigResolvedWithoutEnvironment: true;
      setupStatusMatchedDisposableInstanceBeforePinMutation: true;
      freshBrowserAdmin: D508FreshBrowserAdminEvidence;
    }>;
    requests: readonly RedactedRequestObservation[];
    navigations: readonly RedactedNavigationObservation[];
  }>
  | Readonly<{
    outcome: "failed";
    qualifier: "packaged-target-browser";
    code: "invalid_arguments" | "protected_owner_config" | "setup_status" | "browser_qualification";
  }>;

class PackagedTargetQualificationError extends Error {
  constructor(readonly code: Extract<PackagedTargetQualificationReceipt, { outcome: "failed" }>["code"]) {
    super(`packaged-target qualification failed (${code})`);
  }
}

type SetupStatusResponse = Readonly<{
  status: number;
  json: () => Promise<unknown>;
}>;

export type PackagedTargetQualificationDeps = Readonly<{
  loadDeployConfig?: (path: string) => DeployConfig;
  resolveSecrets?: (config: DeployConfig) => ResolvedDeployConfig;
  planAdmin?: typeof planAdminRedemption;
  fetchSetupStatus?: (serverUrl: string) => Promise<SetupStatusResponse>;
  runFreshBrowserAdmin?: (
    input: D508FreshBrowserAdminQualificationInput,
    timing: D508QualificationTimingPolicy,
  ) => ReturnType<typeof runD508FreshBrowserAdminQualification>;
  timing?: D508QualificationTimingPolicy;
}>;

function invalidArguments(): never {
  throw new PackagedTargetQualificationError("invalid_arguments");
}

function assertRuntimePackagedTargetArgs(args: PackagedTargetQualificationArgs): void {
  if (
    args.disposable !== true
    || !isAbsolute(args.ownerConfigPath)
    || resolve(args.ownerConfigPath) !== args.ownerConfigPath
    || !D508_DISPOSABLE_INSTANCE_ID_RE.test(args.targetInstanceId)
  ) invalidArguments();
  let target: URL;
  try {
    target = new URL(args.serverUrl);
  } catch {
    invalidArguments();
  }
  if (
    target.origin !== args.serverUrl
    || (target.protocol !== "http:" && target.protocol !== "https:")
    || !isLoopbackHostname(target.hostname)
    || target.username !== "" || target.password !== ""
    || target.pathname !== "/" || target.search !== "" || target.hash !== ""
  ) invalidArguments();
}

/** Strict parser: this destructive test-only browser mutation needs an explicit opt-in. */
export function parsePackagedTargetQualificationArgs(argv: readonly string[]): PackagedTargetQualificationArgs {
  const values = new Map<string, string>();
  let disposable = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--disposable") {
      if (disposable) invalidArguments();
      disposable = true;
      continue;
    }
    if (item !== "--server" && item !== "--owner-config" && item !== "--target-instance") {
      invalidArguments();
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || values.has(item)) invalidArguments();
    values.set(item, value);
    index += 1;
  }
  const rawServerUrl = values.get("--server");
  const ownerConfigPath = values.get("--owner-config");
  const targetInstanceId = values.get("--target-instance");
  if (!disposable || rawServerUrl === undefined || ownerConfigPath === undefined || targetInstanceId === undefined) {
    invalidArguments();
  }
  if (!isAbsolute(ownerConfigPath) || !D508_DISPOSABLE_INSTANCE_ID_RE.test(targetInstanceId)) invalidArguments();
  let target: URL;
  try {
    target = new URL(rawServerUrl);
  } catch {
    invalidArguments();
  }
  if (
    (target.protocol !== "http:" && target.protocol !== "https:")
    || !isLoopbackHostname(target.hostname)
    || target.username !== "" || target.password !== ""
    || target.pathname !== "/" || target.search !== "" || target.hash !== ""
  ) invalidArguments();
  return {
    disposable: true,
    serverUrl: target.origin,
    ownerConfigPath: resolve(ownerConfigPath),
    targetInstanceId,
  };
}

/**
 * Never return setup-status content: the only usable facts are the exact
 * anonymous owner-bound projection and identity equality. An already-claimed
 * server has no authenticated viewer at this boundary, so it truthfully
 * reports `claimed-needs-auth`, not `ready`.
 */
export function assertPackagedTargetSetupStatus(value: unknown, targetInstanceId: string): void {
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>)["instanceId"] !== targetInstanceId
    || (value as Record<string, unknown>)["setupState"] !== "claimed-needs-auth"
    || (value as Record<string, unknown>)["claimRequired"] !== false
  ) throw new PackagedTargetQualificationError("setup_status");
}

async function defaultFetchSetupStatus(serverUrl: string): Promise<SetupStatusResponse> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/setup/status`, { method: "GET", redirect: "error" });
  } catch {
    throw new PackagedTargetQualificationError("setup_status");
  }
  return { status: response.status, json: () => response.json() };
}

function loadPackagedTargetCredentials(
  args: PackagedTargetQualificationArgs,
  deps: PackagedTargetQualificationDeps,
): Readonly<{ handle: string; password: string; pin: string }> {
  try {
    const config = (deps.loadDeployConfig ?? parseDeployConfigFromPath)(args.ownerConfigPath);
    // This focused browser proof accepts just an all-inline administrator
    // plan. It never resolves unrelated provider environment references.
    if (
      config.providers.length !== 0
      || !isInlineSecret(config.admin.password)
      || !isInlineSecret(config.admin.pin)
    ) throw new Error("packaged browser config must be all-inline admin only");
    // No environment lookup is permitted for this test-only command. A TOML
    // reference would fail closed instead of exposing an ambient secret.
    const resolved = (deps.resolveSecrets ?? ((value) => resolveDeployConfig(value, () => undefined)))(config);
    const plan = (deps.planAdmin ?? planAdminRedemption)(resolved);
    if (typeof plan.pin !== "string" || plan.pin.length === 0) {
      throw new Error("PIN required");
    }
    return { handle: plan.handle, password: plan.password, pin: plan.pin };
  } catch {
    throw new PackagedTargetQualificationError("protected_owner_config");
  }
}

function isInlineSecret(value: unknown): value is Readonly<{ value: string }> {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)["value"] === "string",
  );
}

async function verifyPackagedTargetSetupStatus(
  args: PackagedTargetQualificationArgs,
  fetchSetupStatus: (serverUrl: string) => Promise<SetupStatusResponse>,
): Promise<void> {
  let response: SetupStatusResponse;
  let body: unknown;
  try {
    response = await fetchSetupStatus(args.serverUrl);
    if (response.status !== 200) throw new Error("unexpected status");
    body = await response.json();
  } catch (error) {
    if (error instanceof PackagedTargetQualificationError) throw error;
    throw new PackagedTargetQualificationError("setup_status");
  }
  assertPackagedTargetSetupStatus(body, args.targetInstanceId);
}

export async function runPackagedTargetQualification(
  args: PackagedTargetQualificationArgs,
  deps: PackagedTargetQualificationDeps = {},
): Promise<Extract<PackagedTargetQualificationReceipt, { outcome: "passed" }>> {
  assertRuntimePackagedTargetArgs(args);
  const fetchSetupStatus = deps.fetchSetupStatus ?? defaultFetchSetupStatus;
  // Do not open the protected config or a browser until the target proves it
  // is exactly the requested anonymous, already-claimed disposable instance.
  await verifyPackagedTargetSetupStatus(args, fetchSetupStatus);
  const credentials = loadPackagedTargetCredentials(args, deps);
  const freshBrowser = deps.runFreshBrowserAdmin ?? runD508FreshBrowserAdminQualification;
  const result = await freshBrowser({
    serverUrl: args.serverUrl,
    ...credentials,
    beforePinMutation: () => verifyPackagedTargetSetupStatus(args, fetchSetupStatus),
  }, deps.timing ?? DEFAULT_D508_QUALIFICATION_TIMING);
  return {
    outcome: "passed",
    qualifier: "packaged-target-browser",
    evidence: {
      explicitDisposableOptIn: true,
      loopbackCredentialFreeOrigin: true,
      protectedOwnerConfigResolvedWithoutEnvironment: true,
      setupStatusMatchedDisposableInstanceBeforePinMutation: true,
      freshBrowserAdmin: result.evidence,
    },
    requests: result.requests,
    navigations: result.navigations,
  };
}

function redactedPackagedTargetFailure(error: unknown): Extract<PackagedTargetQualificationReceipt, { outcome: "failed" }> {
  const code = error instanceof PackagedTargetQualificationError
    ? error.code
    : error instanceof D508QualificationError
      ? "browser_qualification"
      : "browser_qualification";
  return { outcome: "failed", qualifier: "packaged-target-browser", code };
}

/** CLI surface emits exactly one redacted typed receipt on either outcome. */
export async function qualifyPackagedTargetCmd(argv: readonly string[]): Promise<number> {
  let receipt: PackagedTargetQualificationReceipt;
  try {
    receipt = await runPackagedTargetQualification(parsePackagedTargetQualificationArgs(argv));
  } catch (error) {
    receipt = redactedPackagedTargetFailure(error);
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return receipt.outcome === "passed" ? 0 : 2;
}
