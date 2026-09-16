import type { CommandModule } from "yargs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  createHostProgressCoordinator,
  HOST_PROGRESS_SCHEMA_VERSION,
  pollHostProgress,
  resolveProviderCapabilities,
  type HostInterruptController,
  type HostProgressMode,
  type HostProgressScheduler,
  type HostProgressSink,
  type HostingNotice,
  type ProviderCredentialReference,
  type SignedReleaseManifest,
} from "@nautilo/hosting";
import { resolveNautiloRootDir } from "@nautilo/config";
import { openUrlInDefaultBrowserChecked } from "@nautilo/cli-auth";
import { KEY_REGISTRY, type KeyDefinition } from "@nautilo/config-guard";
import {
  authorizeRailwayOAuth,
  auditRailwayTemplateAdoption,
  buildRailwayTopology,
  destroyRailwayDeployment,
  inspectRailwayDeployment,
  RailwayGraphqlDestroyExecutor,
  RailwayGraphqlReconcileExecutor,
  RailwayGraphqlTemplateAdoptionDiscovery,
  planRailwayDeployment,
  prepareRailwayTemplateAdoption,
  RAILWAY_OAUTH_CLIENT_ID,
  RAILWAY_PROJECT_NAME_PATTERN,
  RAILWAY_PROVISIONAL_V0_COST_DISCLOSURE,
  type RailwayDeploymentPlan,
  type RailwayPlanAuthorizationInput,
  type RailwayPlanReleaseInput,
  type RailwayPlanTransport,
  type RailwayTemplateAdoptionAuditResult,
  type RailwayTemplateAdoptionDiscovery,
  type RailwayTemplateAdoptionObservation,
  type RailwayOAuthFailure,
  type RailwayVariableProjectionInputs,
} from "@nautilo/railway-hosting";
import {
  KeyringRailwayOAuthCredentialStore,
  RAILWAY_OAUTH_KEYRING_ACCOUNT,
  RAILWAY_OAUTH_KEYRING_SERVICE,
} from "../lib/railway-oauth-credential-store";
import { resolveRailwayRelease } from "../lib/railway-release-source";
import {
  createRailwayDeploymentDriverState,
  mergeRailwayBootstrapCleanupResources,
  parseRailwayDeploymentDriverState,
  runRailwayDeploymentDriver,
  type RailwayDeploymentDriverState,
  type RailwayTemplateAdoptionDriverCheckpoint,
} from "../lib/railway-deployment-runner";
import {
  KeyringRailwayLaunchSecretStore,
  RAILWAY_LAUNCH_SECRET_KEYRING_SERVICE,
  type RailwayBootstrapOutputBinding,
} from "../lib/railway-launch-secret-store";
import { discoverRailwayLaunchStates, RailwayLaunchStateStore } from "../lib/railway-launch-state-store";
import {
  authorizeRailwayRestoreTargetDiscard,
  cleanupAuthorizedRailwayRestoreTarget,
  discoverRailwayMaintenanceStates,
  latestRailwayMaintenanceStates,
  railwayFailedMaintenanceCleanupComplete,
  runRailwayHostMaintenance,
  verifyRailwayMaintenanceRecoveryBinding,
  type RailwayHostMaintenanceResult,
} from "../lib/railway-host-maintenance";
import { resolveRailwayRecoveryConfig } from "../lib/railway-recovery-config";
import { readRailwayMaintenanceState, type RailwayMaintenanceState } from "../lib/railway-maintenance-state";
import {
  RAILWAY_RUNTIME_PROVIDERS,
  resolveRailwayProviderConfig,
  type ProviderConfigFailureCode,
  type RailwayRuntimeProvider,
} from "../lib/host-provider-config";
import {
  createProcessHostProviderPrompter,
  type HostProviderPrompter,
} from "../lib/host-provider-prompt";
import {
  KeyringRailwayProviderCustodyStore,
  providerCustodyHasExactly,
  providerCustodyMayBeErased,
  RAILWAY_PROVIDER_CUSTODY_KEYRING_SERVICE,
  type RailwayProviderCustody,
} from "../lib/railway-provider-custody";
import {
  createScopedHostInterruptController,
} from "../lib/host-progress";
import {
  createRailwayOwnerClaimBrowserHandoff,
  type RailwayOwnerClaimBrowserHandoff,
} from "../lib/railway-owner-claim-handoff";
import {
  buildServerCompletionSummary,
  parseServerFinishMode,
  type ServerBrowserOutcome,
  type ServerCompletionSummary,
  type ServerFinishMode,
} from "../lib/server-completion";
import {
  KeyringRailwayOwnerClaimStore,
  RAILWAY_OWNER_CLAIM_KEYRING_SERVICE,
} from "../lib/railway-owner-claim-store";
import {
  createRailwayOwnerClaimTarget,
  hashRailwayOwnerClaim,
  RailwayOwnerClaimControllerError,
  type RailwayOwnerClaimControllerErrorCode,
  type RailwayOwnerClaimTarget,
} from "../lib/railway-owner-claim-target";

export const HOST_PLAN_ERROR_SCHEMA_VERSION = 1 as const;

export interface HostPlanAuthorizationRequired {
  readonly schemaVersion: typeof HOST_PLAN_ERROR_SCHEMA_VERSION;
  readonly operation: "plan";
  readonly backend: "railway";
  readonly outcome: "authorization-required";
  readonly mutationAuthorized: false;
  readonly error: {
    readonly code: "railway.plan.authorization-required";
    readonly message: string;
    readonly reason: RailwayOAuthFailure["kind"];
    readonly nextAction: RailwayOAuthFailure["repair"];
  };
}

export interface HostPlanInputFailure {
  readonly schemaVersion: typeof HOST_PLAN_ERROR_SCHEMA_VERSION;
  readonly operation: "plan";
  readonly backend: "railway";
  readonly outcome: "input-failure";
  readonly mutationAuthorized: false;
  readonly error: {
    readonly code:
      | "railway.plan.provider-config-unreadable"
      | "railway.plan.provider-config-unsafe"
      | "railway.plan.provider-config-too-large"
      | "railway.plan.provider-config-invalid"
      | "railway.plan.project-name-invalid"
      | "railway.plan.release-unavailable";
    readonly message: string;
    readonly nextAction: "repair-provider-config" | "repair-project-name" | "repair-release-source";
  };
}

export type RailwayAuthorizationAcquisition =
  | {
      readonly outcome: "authorized";
      readonly transport: RailwayPlanTransport;
      readonly authorization: RailwayPlanAuthorizationInput;
    }
  | { readonly outcome: "authorization-required"; readonly failure: RailwayOAuthFailure };

export interface RailwayAuthorizationRequest {
  readonly interactive: boolean;
}

export interface HostPlanDependencies {
  readonly acquireRailwayAuthorization: (
    request: RailwayAuthorizationRequest,
  ) => Promise<RailwayAuthorizationAcquisition>;
  readonly resolveRailwayRelease: (retainedManifest?: SignedReleaseManifest) => Promise<RailwayPlanReleaseInput>;
  readonly environment: NodeJS.ProcessEnv;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
  readonly fetch?: typeof fetch | undefined;
  /** Test seam; production uses a named OS-keyring entry per launch. */
  readonly createRailwayProviderCustodyStore?: (
    launchId: string,
  ) => Promise<KeyringRailwayProviderCustodyStore>;
  /** Test seams; production renders progress locally and scopes SIGINT per operation. */
  readonly createHostProgressSink?: (input: {
    readonly mode: HostProgressMode;
    readonly finalJson: boolean;
  }) => HostProgressSink | undefined;
  readonly hostProgressScheduler?: HostProgressScheduler | undefined;
  readonly createHostInterruptController?: () => HostInterruptController;
  /** Test seam; production prompts only when both terminal streams are TTYs. */
  readonly isInteractiveTerminal?: () => boolean;
  /** Test seam; production uses a narrowly scoped no-echo provider prompt. */
  readonly createHostProviderPrompter?: () => HostProviderPrompter;
  /** Test seams for the target-side first-owner protocol and browser handoff. */
  readonly railwayOwnerClaimTarget?: RailwayOwnerClaimTarget;
  readonly createRailwayOwnerClaimStore?: (launchId: string) => Promise<KeyringRailwayOwnerClaimStore>;
  /** Test seam; production uses the per-launch generated-secret Keychain item. */
  readonly createRailwayLaunchSecretStore?: (launchId: string) => Promise<KeyringRailwayLaunchSecretStore>;
  readonly createRailwayOwnerClaimBrowserHandoff?: (input: {
    readonly targetUrl: string;
    readonly claim: string;
    readonly finish: ServerFinishMode;
  }) => Promise<RailwayOwnerClaimBrowserHandoff>;
  readonly openRailwayOwnerClaimBrowser?: (localUrl: string) => Promise<void>;
  /** Read-only Gate 3 seam; production walks the consented OAuth inventory. */
  readonly createRailwayTemplateAdoptionDiscovery?: (
    transport: RailwayPlanTransport,
  ) => RailwayTemplateAdoptionDiscovery;
}

export interface RailwayHostPlanInput {
  readonly workspaceId?: string | undefined;
  readonly projectName?: string | undefined;
  readonly providerConfigPath?: string | undefined;
  readonly allProviders: boolean;
  readonly includeProviders: readonly string[];
  readonly excludeProviders: readonly string[];
  readonly allowCoreDegraded: boolean;
  readonly interactiveAuthorization?: boolean | undefined;
  /** In-memory values collected by the interactive prompt; never serialized. */
  readonly promptedProviderSecrets?: ReadonlyMap<RailwayRuntimeProvider, string> | undefined;
  /** Manual/skip prompt choices intentionally bypass ambient file/environment discovery. */
  readonly ignoreProviderConfiguration?: boolean | undefined;
}

export type RailwayHostPlanExecution =
  | {
      readonly outcome: "planned";
      readonly plan: RailwayDeploymentPlan;
      readonly transport: RailwayPlanTransport;
      readonly signedManifest?: SignedReleaseManifest | undefined;
    }
  | { readonly outcome: "authorization-required"; readonly error: HostPlanAuthorizationRequired }
  | { readonly outcome: "input-failure"; readonly error: HostPlanInputFailure };

export type ProviderReferenceDiscovery =
  | { readonly outcome: "resolved"; readonly references: readonly ProviderCredentialReference[] }
  | {
      readonly outcome: "failure";
      readonly code: HostPlanInputFailure["error"]["code"];
    };

export type ProviderSecretDiscovery =
  | { readonly outcome: "resolved"; readonly secrets: ReadonlyMap<string, string> }
  | { readonly outcome: "failure"; readonly code: HostPlanInputFailure["error"]["code"] };

const railwayRuntimeProviderSet = new Set<string>(RAILWAY_RUNTIME_PROVIDERS);

function referenceForValue(
  definition: KeyDefinition,
  value: string | undefined,
  source: ProviderCredentialReference["source"],
): ProviderCredentialReference | undefined {
  if (!railwayRuntimeProviderSet.has(definition.id) || value === undefined || value.length === 0) {
    return undefined;
  }
  return {
    provider: definition.id as ProviderCredentialReference["provider"],
    source,
    state: value.trim() === value && definition.formatCheck(value)
      ? "configured"
      : "invalid",
  };
}

export async function discoverProviderReferences(
  environment: NodeJS.ProcessEnv,
  providerConfigPath?: string,
  promptedProviderSecrets?: ReadonlyMap<RailwayRuntimeProvider, string>,
  ignoreProviderConfiguration = false,
): Promise<ProviderReferenceDiscovery> {
  const resolved = ignoreProviderConfiguration
    ? { outcome: "resolved" as const, providers: new Map<RailwayRuntimeProvider, { value: string; source: "environment" | "documented-config" }>() }
    : await resolveRailwayProviderConfig({ environment, providerConfigPath });
  if (resolved.outcome === "failure") return resolved;
  const references = KEY_REGISTRY.flatMap((definition): readonly ProviderCredentialReference[] => {
    if (!railwayRuntimeProviderSet.has(definition.id)) return [];
    const id = definition.id as RailwayRuntimeProvider;
    const prompted = promptedProviderSecrets?.get(id);
    const provider = prompted === undefined
      ? resolved.providers.get(id)
      : { value: prompted, source: "documented-config" as const };
    const reference = provider === undefined
      ? undefined
      : referenceForValue(definition, provider.value, provider.source);
    return reference === undefined ? [] : [reference];
  });
  return { outcome: "resolved", references };
}

/** Values exist only in the deployment request and are never returned by plan. */
async function discoverProviderSecrets(
  environment: NodeJS.ProcessEnv,
  selectedProviders: ReadonlySet<string>,
  providerConfigPath?: string,
  promptedProviderSecrets?: ReadonlyMap<RailwayRuntimeProvider, string>,
  ignoreProviderConfiguration = false,
): Promise<ProviderSecretDiscovery> {
  const resolved = ignoreProviderConfiguration
    ? { outcome: "resolved" as const, providers: new Map<RailwayRuntimeProvider, { value: string; source: "environment" | "documented-config" }>() }
    : await resolveRailwayProviderConfig({ environment, providerConfigPath });
  if (resolved.outcome === "failure") return resolved;
  const secrets = new Map<string, string>();
  for (const definition of KEY_REGISTRY) {
    if (!railwayRuntimeProviderSet.has(definition.id) || !selectedProviders.has(definition.id)) continue;
    const id = definition.id as RailwayRuntimeProvider;
    const value = promptedProviderSecrets?.get(id) ?? resolved.providers.get(id)?.value;
    if (value !== undefined && value.trim() === value && definition.formatCheck(value)) {
      secrets.set(`${definition.id}:${definition.id}-api-key`, value);
    }
  }
  return { outcome: "resolved", secrets };
}

function custodyFromProviderSecrets(
  secrets: ReadonlyMap<string, string>,
  providers: ReadonlySet<string>,
): RailwayProviderCustody | undefined {
  const custody = new Map<RailwayRuntimeProvider, string>();
  for (const provider of providers) {
    if (!railwayRuntimeProviderSet.has(provider)) return undefined;
    const value = secrets.get(`${provider}:${provider}-api-key`);
    if (value === undefined) return undefined;
    custody.set(provider as RailwayRuntimeProvider, value);
  }
  return custody;
}

function externalProviderSecretsFromCustody(custody: RailwayProviderCustody): Map<string, string> {
  return new Map([...custody].map(([provider, value]) => [`${provider}:${provider}-api-key`, value]));
}

async function defaultProviderCustodyStore(launchId: string): Promise<KeyringRailwayProviderCustodyStore> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new KeyringRailwayProviderCustodyStore(
    new AsyncEntry(RAILWAY_PROVIDER_CUSTODY_KEYRING_SERVICE, launchId),
  );
}

async function providerCustodyStore(
  dependencies: HostPlanDependencies,
  launchId: string,
): Promise<KeyringRailwayProviderCustodyStore> {
  return dependencies.createRailwayProviderCustodyStore?.(launchId)
    ?? defaultProviderCustodyStore(launchId);
}

/** Both local custodians must be attempted; one failure cannot retain the other. */
export async function clearRailwayLaunchCustody(input: {
  readonly clearGenerated: () => Promise<void>;
  readonly clearProviders: () => Promise<void>;
  readonly clearOwnerClaim?: () => Promise<void>;
}): Promise<{ readonly cleanupFailed: boolean }> {
  let cleanupFailed = false;
  try {
    await input.clearGenerated();
  } catch {
    cleanupFailed = true;
  }
  try {
    await input.clearProviders();
  } catch {
    cleanupFailed = true;
  }
  try {
    await input.clearOwnerClaim?.();
  } catch {
    cleanupFailed = true;
  }
  return { cleanupFailed };
}

function authorizationRequired(failure: RailwayOAuthFailure): HostPlanAuthorizationRequired {
  const message = failure.kind === "reauthorization-required"
      ? "Railway authorization requires an interactive terminal; JSON and non-TTY runs never open a browser."
      : failure.kind === "callback-port-unavailable"
        ? "The exact registered Railway callback port 43877 is unavailable."
        : failure.kind === "refresh-revoked"
          ? "Railway revoked or expired the saved authorization; fresh consent is required."
        : "Railway authorization did not complete safely.";
  return {
    schemaVersion: HOST_PLAN_ERROR_SCHEMA_VERSION,
    operation: "plan",
    backend: "railway",
    outcome: "authorization-required",
    mutationAuthorized: false,
    error: {
      code: "railway.plan.authorization-required",
      message,
      reason: failure.kind,
      nextAction: failure.repair,
    },
  };
}

function inputFailure(
  code: HostPlanInputFailure["error"]["code"] | ProviderConfigFailureCode,
): HostPlanInputFailure {
  const releaseFailure = code === "railway.plan.release-unavailable";
  const projectNameFailure = code === "railway.plan.project-name-invalid";
  const message = releaseFailure
    ? "The immutable Nautilo release source could not be resolved safely."
    : projectNameFailure
      ? "The Railway project name must use 1-64 lowercase letters, digits, or hyphens and cannot begin or end with a hyphen."
    : code === "railway.plan.provider-config-too-large"
      ? "The documented provider configuration exceeds the 1 MiB planning limit."
    : code === "railway.plan.provider-config-unsafe"
      ? "The documented provider configuration is not a safe regular file."
      : code === "railway.plan.provider-config-invalid"
        ? "The documented provider configuration does not match the provider-only schema."
      : "The documented provider configuration exists but could not be read.";
  return {
    schemaVersion: HOST_PLAN_ERROR_SCHEMA_VERSION,
    operation: "plan",
    backend: "railway",
    outcome: "input-failure",
    mutationAuthorized: false,
    error: {
      code,
      message,
      nextAction: releaseFailure
        ? "repair-release-source"
        : projectNameFailure
          ? "repair-project-name"
          : "repair-provider-config",
    },
  };
}

function interactiveTerminal(dependencies: HostPlanDependencies): boolean {
  return dependencies.isInteractiveTerminal?.()
    ?? (process.stdin.isTTY === true && process.stdout.isTTY === true && process.stderr.isTTY === true);
}

function hostProviderPrompter(dependencies: HostPlanDependencies): HostProviderPrompter {
  return dependencies.createHostProviderPrompter?.() ?? createProcessHostProviderPrompter();
}

interface ProviderCliInput {
  readonly providerConfigPath?: string | undefined;
  readonly allProviders: boolean;
  readonly includeProviders: readonly string[];
  readonly excludeProviders: readonly string[];
  readonly allowCoreDegraded: boolean;
}

type ResolvedProviderCliInput =
  | { readonly outcome: "resolved"; readonly input: RailwayHostPlanInput }
  | { readonly outcome: "cancelled" };

/**
 * Interactive provider choice is opt-in only when the caller did not already
 * express a source/selection in flags. JSON and non-terminal invocations stay
 * completely deterministic and perform the ordinary documented discovery.
 */
async function resolveProviderCliInput(
  input: ProviderCliInput,
  dependencies: HostPlanDependencies,
  promptEligible: boolean,
): Promise<ResolvedProviderCliInput> {
  const base = {
    ...(input.providerConfigPath === undefined ? {} : { providerConfigPath: input.providerConfigPath }),
    allProviders: input.allProviders,
    includeProviders: input.includeProviders,
    excludeProviders: input.excludeProviders,
    allowCoreDegraded: input.allowCoreDegraded,
  } as const;
  const explicitProviderSelection = input.providerConfigPath !== undefined
    || input.allProviders
    || input.includeProviders.length > 0
    || input.excludeProviders.length > 0;
  if (!promptEligible || explicitProviderSelection) return { outcome: "resolved", input: base };

  let detectedProviders: readonly RailwayRuntimeProvider[] = [];
  const discovered = await discoverProviderReferences(dependencies.environment);
  if (discovered.outcome === "resolved") {
    detectedProviders = discovered.references
      .filter((reference) => reference.state === "configured" && railwayRuntimeProviderSet.has(reference.provider))
      .map((reference) => reference.provider);
  }
  try {
    const choice = await hostProviderPrompter(dependencies).choose({ detectedProviders });
    if (choice.kind === "detected") {
      return { outcome: "resolved", input: { ...base, allProviders: true } };
    }
    if (choice.kind === "toml") {
      return {
        outcome: "resolved",
        input: {
          ...base,
          providerConfigPath: choice.providerConfigPath,
          allProviders: true,
        },
      };
    }
    if (choice.kind === "manual") {
      return {
        outcome: "resolved",
        input: {
          ...base,
          allProviders: true,
          includeProviders: [],
          excludeProviders: [],
          promptedProviderSecrets: choice.providers,
          ignoreProviderConfiguration: true,
        },
      };
    }
    return {
      outcome: "resolved",
      input: {
        ...base,
        allProviders: false,
        includeProviders: [],
        excludeProviders: [],
        ignoreProviderConfiguration: true,
      },
    };
  } catch {
    return { outcome: "cancelled" };
  }
}

function writeProviderPromptCancelled(dependencies: HostPlanDependencies): void {
  const message = "Provider setup was cancelled. Retry interactively, use --provider-config, or select supported providers with flags.";
  dependencies.writeStderr(`${message}\n`);
  process.exitCode = 2;
}

async function executeRailwayHostPlan(
  input: RailwayHostPlanInput,
  dependencies: HostPlanDependencies,
): Promise<RailwayHostPlanExecution> {
  let release: RailwayPlanReleaseInput;
  try {
    release = await dependencies.resolveRailwayRelease();
  } catch {
    return {
      outcome: "input-failure",
      error: inputFailure("railway.plan.release-unavailable"),
    };
  }
  const discovery = await discoverProviderReferences(
    dependencies.environment,
    input.providerConfigPath,
    input.promptedProviderSecrets,
    input.ignoreProviderConfiguration,
  );
  if (discovery.outcome === "failure") {
    return { outcome: "input-failure", error: inputFailure(discovery.code) };
  }
  let acquisition: RailwayAuthorizationAcquisition;
  try {
    acquisition = await dependencies.acquireRailwayAuthorization({
      interactive: input.interactiveAuthorization === true,
    });
  } catch {
    return {
      outcome: "authorization-required",
      error: authorizationRequired({
        kind: "reauthorization-required",
        repair: "retry-browser-authorization",
      }),
    };
  }
  if (acquisition.outcome !== "authorized") {
    return { outcome: "authorization-required", error: authorizationRequired(acquisition.failure) };
  }
  const plan = await planRailwayDeployment(acquisition.transport, {
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.projectName === undefined ? {} : { projectName: input.projectName }),
    authorization: acquisition.authorization,
    release,
    cost: RAILWAY_PROVISIONAL_V0_COST_DISCLOSURE,
    providerSelection: {
      references: discovery.references,
      allProviders: input.allProviders,
      includeProviders: input.includeProviders,
      excludeProviders: input.excludeProviders,
      qualifiedBaselineCapabilities: [],
      infrastructure: "planned",
      coreDegradedConsent: input.allowCoreDegraded,
    },
  });
  return { outcome: "planned", plan, transport: acquisition.transport,
    ...(release.state === "verified" && release.signedManifest !== undefined ? { signedManifest: release.signedManifest } : {}) };
}

function renderRailwayAdoptionAuditTty(result: RailwayTemplateAdoptionAuditResult): string {
  if (result.outcome === "ready") {
    return [
      "Nautilo Railway adoption check (read-only)",
      "Outcome: ready",
      `Project: ${result.projectName}`,
      "Verified: signed images, held startup, template provenance, five services, three volumes, two domains, and generated credentials ready for protected custody.",
      "Railway changes: none",
      "Next action: review this adoption plan. This check has not adopted or changed the server.",
    ].join("\n") + "\n";
  }
  const repair = ({
    "railway.template-adoption.release-invalid": "The signed Nautilo release is unavailable or invalid.",
    "railway.template-adoption.discovery-failed": "Railway inventory could not be read completely. Reauthorize and retry.",
    "railway.template-adoption.no-match": "No held Nautilo template deployment is visible in the consented workspaces.",
    "railway.template-adoption.ambiguous": "More than one held Nautilo deployment is visible. Remove the abandoned copy before adoption.",
    "railway.template-adoption.provenance-mismatch": "The project is not bound to one exact Railway template source.",
    "railway.template-adoption.digest-mismatch": "A deployed image does not match the signed Nautilo release.",
    "railway.template-adoption.hold-mismatch": "A service is not in the required safe pre-adoption state.",
    "railway.template-adoption.resource-mismatch": "The project has a missing, duplicate, or foreign Railway resource.",
    "railway.template-adoption.variable-mismatch": "The exact generated-credential or safe-literal variable contract does not match.",
  } as const)[result.code];
  return [
    "Nautilo Railway adoption check (read-only)",
    "Outcome: blocked",
    repair,
    "Railway changes: none",
  ].join("\n") + "\n";
}

async function executeRailwayHostAdoptAudit(input: {
  readonly json: boolean;
  readonly providerConfigPath?: string | undefined;
  readonly interactiveAuthorization: boolean;
  readonly confirmed?: boolean | undefined;
  readonly progress?: HostProgressMode | undefined;
  readonly finish?: ServerFinishMode | undefined;
  readonly openBrowser?: boolean | undefined;
}, dependencies: HostPlanDependencies): Promise<void> {
  // Only an explicitly supplied file opts template adoption into provider setup.
  // An ordinary audit/adopt must not import ambient workstation credentials.
  const supplied = input.providerConfigPath === undefined ? undefined
    : await resolveRailwayProviderConfig({ environment: dependencies.environment, providerConfigPath: input.providerConfigPath });
  if (supplied?.outcome === "failure") {
    writeHostPlanInputFailure(inputFailure(supplied.code), input.json, dependencies);
    return;
  }
  const suppliedProviders = supplied === undefined ? undefined
    : new Map([...supplied.providers].map(([provider, entry]) => [provider, entry.value]));
  let release: RailwayPlanReleaseInput;
  try {
    release = await dependencies.resolveRailwayRelease();
  } catch {
    release = { state: "invalid" };
  }
  if (release.state !== "verified") {
    const result: RailwayTemplateAdoptionAuditResult = {
      schemaVersion: 1,
      operation: "adopt-audit",
      backend: "railway",
      outcome: "blocked",
      code: "railway.template-adoption.release-invalid",
      nextAction: "repair-or-remove-held-project",
      mutationAuthorized: false,
    };
    (input.json ? dependencies.writeStdout : dependencies.writeStderr)(
      input.json ? `${JSON.stringify(result, null, 2)}\n` : renderRailwayAdoptionAuditTty(result),
    );
    process.exitCode = 2;
    return;
  }
  let acquisition: RailwayAuthorizationAcquisition;
  try {
    acquisition = await dependencies.acquireRailwayAuthorization({ interactive: input.interactiveAuthorization });
  } catch {
    acquisition = { outcome: "authorization-required", failure: { kind: "reauthorization-required", repair: "retry-browser-authorization" } };
  }
  if (acquisition.outcome !== "authorized") {
    const result: RailwayTemplateAdoptionAuditResult = {
      schemaVersion: 1,
      operation: "adopt-audit",
      backend: "railway",
      outcome: "blocked",
      code: "railway.template-adoption.discovery-failed",
      nextAction: "repair-or-remove-held-project",
      mutationAuthorized: false,
    };
    (input.json ? dependencies.writeStdout : dependencies.writeStderr)(
      input.json ? `${JSON.stringify(result, null, 2)}\n` : renderRailwayAdoptionAuditTty(result),
    );
    process.exitCode = 2;
    return;
  }
  const discovery = dependencies.createRailwayTemplateAdoptionDiscovery?.(acquisition.transport)
    ?? new RailwayGraphqlTemplateAdoptionDiscovery({ transport: acquisition.transport });
  let observations: readonly RailwayTemplateAdoptionObservation[];
  let discoveryFailed = false;
  try {
    observations = structuredClone(await discovery.discoverNautiloShapedProjects());
  } catch {
    observations = [];
    discoveryFailed = true;
  }
  const snapshotDiscovery: RailwayTemplateAdoptionDiscovery = {
    discoverNautiloShapedProjects: () => discoveryFailed
      ? Promise.reject(new Error("Railway template adoption discovery failed"))
      : Promise.resolve(observations),
  };
  const result = await auditRailwayTemplateAdoption({ manifest: release.manifest, discovery: snapshotDiscovery });
  if (result.outcome === "ready" && input.confirmed === true) {
    if (acquisition.authorization.mutationScope !== "qualified") {
      dependencies.writeStderr("Railway authorization must be renewed before confirmed adoption can change the held project.\n");
      process.exitCode = 2;
      return;
    }
    const candidate = observations[0]!;
    const nautiloRoot = resolveNautiloRootDir({ env: dependencies.environment });
    const stateRoot = join(nautiloRoot, "hosting", "railway");
    let saved;
    try {
      saved = await discoverRailwayLaunchStates({
        root: stateRoot,
        validate: parseRailwayDeploymentDriverState,
        identity: (state) => state.launchId,
      });
    } catch {
      dependencies.writeStderr("Saved Railway launch custody could not be inspected safely.\n");
      process.exitCode = 2;
      return;
    }
    const matches = saved.filter(({ state }) => state.reconcile.receipt.resources.some((entry) => (
      entry.kind === "railway.project" && entry.id === candidate.projectId
    )) && state.lifecycle?.state !== "destroyed");
    if (matches.length > 1) {
      dependencies.writeStderr("More than one saved launch claims this Railway project. Adoption stopped without changing it.\n");
      process.exitCode = 2;
      return;
    }
    const launchId = matches[0]?.launchId ?? randomUUID();
    const existing = matches[0]?.state;
    if (existing !== undefined && suppliedProviders !== undefined
      && !providerCustodyHasExactly(suppliedProviders, existing.providers)) {
      dependencies.writeStderr("The provider file differs from this saved adoption. Resume the saved launch; change provider keys in the Server Guide after setup.\n");
      process.exitCode = 2;
      return;
    }
    const stateStore = railwayStateStore(dependencies.environment, launchId);
    let launchSecrets: KeyringRailwayLaunchSecretStore;
    try {
      launchSecrets = await railwayLaunchSecretStore(dependencies, launchId);
      const prepared = await prepareRailwayTemplateAdoption({
        manifest: release.manifest,
        discovery: snapshotDiscovery,
        launchId,
        now: new Date().toISOString(),
        persistReceipt: async (receipt, target) => {
          const heldDeploymentIds = Object.fromEntries(
            (["logto-seed", "logto", "nautilo-server"] as const).map((service) => {
              const id = receipt.resources.find((entry) => entry.kind === "railway.deployment" && entry.name === service)?.id;
              if (id === undefined) throw new Error("template adoption receipt incomplete");
              return [service, id];
            }),
          ) as RailwayTemplateAdoptionDriverCheckpoint["heldDeploymentIds"];
          const initial = parseRailwayDeploymentDriverState({
            schemaVersion: 1,
            launchId,
            releaseId: release.manifest.releaseId,
            ...(release.signedManifest === undefined ? {} : { releaseManifest: release.signedManifest }),
            providers: [...(suppliedProviders?.keys() ?? [])],
            target,
            reconcile: { receipt },
            templateAdoption: { schemaVersion: 1, releaseId: release.manifest.releaseId, heldDeploymentIds, releases: {},
              setupImage: candidate.services.find(({ name }) => name === "nautilo-server")?.image },
          });
          if (existing === undefined) {
            await stateStore.write(initial);
            return;
          }
          const existingResources = JSON.stringify(existing.reconcile.receipt.resources);
          const initialResources = JSON.stringify(initial.reconcile.receipt.resources);
          if (existing.releaseId !== initial.releaseId || existing.templateAdoption === undefined
            || JSON.stringify(existing.target) !== JSON.stringify(initial.target)
            || existing.reconcile.receipt.launchId !== initial.reconcile.receipt.launchId
            || existing.reconcile.receipt.backend !== initial.reconcile.receipt.backend
            || existing.reconcile.receipt.stage !== initial.reconcile.receipt.stage
            || existingResources !== initialResources) {
            throw new Error("saved template adoption identity mismatch");
          }
        },
        storeGeneratedSecrets: (binding, secrets) => launchSecrets.storeGeneratedSecrets({ ...binding, secrets }),
      });
      if (prepared.outcome !== "ready") {
        dependencies.writeStderr(renderRailwayAdoptionAuditTty(prepared));
        process.exitCode = 1;
        return;
      }
      if (suppliedProviders !== undefined && suppliedProviders.size > 0
        && !providerCustodyMayBeErased(existing?.workflow?.stage)) {
        const custody = await providerCustodyStore(dependencies, launchId);
        await custody.writeOrConfirm({ launchId, releaseId: release.manifest.releaseId, providers: suppliedProviders });
      }
    } catch {
      dependencies.writeStderr("Template adoption could not secure its receipt and generated credentials. Railway remains held.\n");
      process.exitCode = 2;
      return;
    }
    await executeRailwayHostResume({
      launchId,
      publicOperation: "adopt",
      ...(input.providerConfigPath === undefined ? {} : { providerConfigPath: input.providerConfigPath }),
      json: input.json,
      interactiveAuthorization: input.interactiveAuthorization,
      progress: input.progress ?? "auto",
      finish: input.finish ?? "guide",
      openBrowser: input.openBrowser ?? input.interactiveAuthorization,
    }, dependencies);
    return;
  }
  (input.json || result.outcome === "ready" ? dependencies.writeStdout : dependencies.writeStderr)(
    input.json ? `${JSON.stringify(result, null, 2)}\n` : renderRailwayAdoptionAuditTty(result),
  );
  process.exitCode = result.outcome === "ready" ? 0 : 1;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function renderRailwayPlanTty(plan: RailwayDeploymentPlan): string {
  const selectedProviders = plan.providerPlan.providers
    .filter((provider) => provider.selected)
    .map((provider) => `${provider.name} (${provider.state})`);
  const workspace = plan.identity.selectedWorkspace;
  const cost = plan.cost.state === "estimated"
    ? `${dollars(plan.cost.monthlyBillCents)}/month provisional (${plan.cost.workload}, captured ${plan.cost.capturedAt})`
    : plan.cost.state === "measured"
      ? `${dollars(plan.cost.monthlyBillCents.minimum)}–${dollars(plan.cost.monthlyBillCents.maximum)}/month measured range`
      : "not yet measured";
  const lines = [
    "Nautilo Railway plan (read-only)",
    `Outcome: ${plan.outcome}`,
    `Next action: ${plan.nextAction}`,
    `Workspace: ${workspace === undefined ? "selection required" : `${workspace.name} (${workspace.id})`}`,
    `Payer: ${plan.payer.state === "resolved" ? `${plan.payer.workspaceName} (${plan.payer.workspaceId})` : "unresolved"}`,
    `Project: ${plan.target.projectName}${plan.target.nameAvailable === undefined ? "" : plan.target.nameAvailable ? " (name available)" : " (name collision)"}`,
    `Release: ${plan.release.state}${plan.release.releaseId === undefined ? "" : ` (${plan.release.releaseId})`}`,
    `Core readiness: ${plan.providerPlan.readiness.coreReadiness}`,
    `Providers: ${selectedProviders.length === 0 ? "none selected" : selectedProviders.join(", ")}`,
    `Cost: ${cost}`,
    "Cost basis: explicit average billable CPU/RAM, volume, and egress assumptions; actual Railway usage may differ.",
    "Mutation authorized: no (plan never creates or changes Railway resources)",
  ];
  if (plan.topology !== undefined) {
    lines.push(`Services: ${plan.topology.finalServices.map((service) => service.name).join(", ")}`);
  }
  if (plan.notices.length > 0) {
    lines.push("Notices:");
    for (const item of plan.notices) {
      lines.push(`  [${item.severity.toUpperCase()}] ${item.code}: ${item.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderAuthorizationRequiredTty(error: HostPlanAuthorizationRequired): string {
  return [
    "Nautilo Railway plan could not start.",
    `Authorization required: ${error.error.message}`,
    `Next action: ${error.error.nextAction}. Do not create a PAT or use Railway CLI credentials.`,
  ].join("\n") + "\n";
}

function renderHostPlanInputFailureTty(error: HostPlanInputFailure): string {
  return [
    "Nautilo Railway plan could not start.",
    `Input failure: ${error.error.message}`,
    `Repair: ${error.error.nextAction}`,
  ].join("\n") + "\n";
}

function strings(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return typeof value === "string" ? [value] : [];
}

function resolveRailwayProjectName(value: unknown):
  | { readonly outcome: "resolved"; readonly projectName?: string | undefined }
  | { readonly outcome: "failure"; readonly error: HostPlanInputFailure } {
  if (value === undefined) return { outcome: "resolved" };
  const projectName = typeof value === "string" ? value.trim() : "";
  return RAILWAY_PROJECT_NAME_PATTERN.test(projectName)
    ? { outcome: "resolved", projectName }
    : { outcome: "failure", error: inputFailure("railway.plan.project-name-invalid") };
}

function writeHostPlanInputFailure(
  failure: HostPlanInputFailure,
  json: boolean,
  dependencies: HostPlanDependencies,
): void {
  if (json) dependencies.writeStdout(`${JSON.stringify(failure, null, 2)}\n`);
  else dependencies.writeStderr(renderHostPlanInputFailureTty(failure));
  process.exitCode = 2;
}

interface RailwayDeployInput extends RailwayHostPlanInput {
  readonly confirmed: boolean;
  readonly json: boolean;
  readonly progress: HostProgressMode;
  readonly finish: ServerFinishMode;
  readonly openBrowser: boolean;
}

interface RailwayResumeInput {
  readonly launchId: string;
  readonly publicOperation?: "adopt" | "resume" | undefined;
  readonly providerConfigPath?: string | undefined;
  readonly json: boolean;
  readonly interactiveAuthorization: boolean;
  readonly progress: HostProgressMode;
  readonly finish: ServerFinishMode;
  readonly openBrowser: boolean;
}

interface RailwayDestroyInput {
  readonly launchId: string;
  readonly confirmProjectId: string;
  readonly json: boolean;
  readonly interactiveAuthorization: boolean;
}

interface RailwayInspectInput {
  readonly launchId: string;
  readonly json: boolean;
  readonly interactiveAuthorization: boolean;
}

const LAUNCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isRailwayLaunchSelector(value: string): boolean {
  return LAUNCH_UUID.test(value) || (value.startsWith("restore-") && LAUNCH_UUID.test(value.slice("restore-".length)));
}

const defaultHostProgressScheduler: HostProgressScheduler = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  every: (milliseconds, callback) => {
    const timer = setInterval(callback, milliseconds);
    return () => clearInterval(timer);
  },
};

function renderHostProgressEvent(event: {
  readonly elapsedMs: number;
  readonly stage: string;
  readonly kind: string;
  readonly messageCode: string;
}): string {
  return `[${Math.floor(event.elapsedMs / 1000)}s] ${event.kind} ${event.stage} (${event.messageCode})`;
}

export interface HostProgressOutputOptions {
  readonly progress: HostProgressMode;
  readonly json: boolean;
}

export function createHostProgressSink(
  input: HostProgressOutputOptions,
  dependencies: HostPlanDependencies,
): HostProgressSink | undefined {
  if (input.progress === "none" || (input.progress === "auto" && input.json)) return undefined;
  if (dependencies.createHostProgressSink !== undefined) {
    return dependencies.createHostProgressSink({ mode: input.progress, finalJson: input.json });
  }
  if (input.progress === "jsonl") {
    return { emit: (event) => dependencies.writeStderr(`${JSON.stringify(event)}\n`) };
  }
  const tty = input.progress === "auto" && process.stderr.isTTY === true;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerIndex = 0;
  return {
    emit: (event) => {
      const line = renderHostProgressEvent(event);
      if (!tty) {
        dependencies.writeStderr(`${line}\n`);
        return;
      }
      const frame = spinnerFrames[spinnerIndex % spinnerFrames.length];
      spinnerIndex += 1;
      dependencies.writeStderr(`\r${frame} ${line}\x1b[K${event.kind === "terminal" ? "\n" : ""}`);
    },
  };
}

function railwayRecovery(launchId: string, state: RailwayDeploymentDriverState): {
  readonly resumeCommand: string;
  readonly inspectCommand: string;
  readonly destroyCommand?: string | undefined;
  readonly destroyStatus?: "not-created" | undefined;
} {
  const project = state.reconcile.receipt.resources.find((resource) => resource.kind === "railway.project");
  return {
    resumeCommand: `nautilo host resume --backend railway --launch ${launchId}`,
    inspectCommand: `nautilo host inspect --backend railway --launch ${launchId}`,
    ...(project === undefined
      ? { destroyStatus: "not-created" as const }
      : { destroyCommand: `nautilo host destroy --backend railway --launch ${launchId} --confirm-project ${project.id}` }),
  };
}

function renderRailwayRecovery(recovery: ReturnType<typeof railwayRecovery>): readonly string[] {
  return [
    `Resume: ${recovery.resumeCommand}`,
    `Inspect: ${recovery.inspectCommand}`,
    ...(recovery.destroyCommand === undefined
      ? ["Destroy: no Railway project is recorded by this checkpoint."]
      : [`Destroy: ${recovery.destroyCommand}`]),
  ];
}

function writeRailwayRecoverableFailure(input: {
  readonly operation: "deploy" | "resume";
  readonly json: boolean;
  readonly progress: HostProgressMode;
  readonly message: string;
  readonly state: RailwayDeploymentDriverState;
  readonly dependencies: HostPlanDependencies;
}): void {
  const recovery = railwayRecovery(input.state.launchId, input.state);
  const output = {
    schemaVersion: 1,
    operation: input.operation,
    backend: "railway",
    outcome: "failure",
    launchId: input.state.launchId,
    stage: input.state.reconcile.receipt.stage,
    recovery,
  } as const;
  if (input.progress === "jsonl") {
    input.dependencies.writeStderr(`${JSON.stringify({
      schemaVersion: HOST_PROGRESS_SCHEMA_VERSION,
      launchId: input.state.launchId,
      stage: input.state.reconcile.receipt.stage,
      kind: "terminal",
      elapsedMs: 0,
      messageCode: "hosting.preflight.failed",
    })}\n`);
    if (input.json) input.dependencies.writeStdout(`${JSON.stringify(output, null, 2)}\n`);
    else input.dependencies.writeStdout([
      input.message,
      `Launch: ${input.state.launchId}`,
      ...renderRailwayRecovery(recovery),
    ].join("\n") + "\n");
  } else if (input.json) {
    input.dependencies.writeStderr(`${input.message}\n`);
    input.dependencies.writeStdout(`${JSON.stringify(output, null, 2)}\n`);
  } else input.dependencies.writeStderr([
    input.message,
    `Launch: ${input.state.launchId}`,
    `Stage: ${input.state.reconcile.receipt.stage}`,
    ...renderRailwayRecovery(recovery),
  ].join("\n") + "\n");
  process.exitCode = 2;
}

function railwayStateStore(environment: NodeJS.ProcessEnv, launchId: string): RailwayLaunchStateStore<RailwayDeploymentDriverState> {
  const stateRoot = join(resolveNautiloRootDir({ env: environment }), "hosting", "railway");
  return new RailwayLaunchStateStore({
    root: stateRoot,
    path: join(stateRoot, "launches", launchId, "state.json"),
    validate: parseRailwayDeploymentDriverState,
  });
}

async function railwayOwnerClaimStore(
  dependencies: HostPlanDependencies,
  launchId: string,
): Promise<KeyringRailwayOwnerClaimStore> {
  if (dependencies.createRailwayOwnerClaimStore !== undefined) {
    return dependencies.createRailwayOwnerClaimStore(launchId);
  }
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new KeyringRailwayOwnerClaimStore(
    new AsyncEntry(RAILWAY_OWNER_CLAIM_KEYRING_SERVICE, launchId),
  );
}

async function railwayLaunchSecretStore(
  dependencies: HostPlanDependencies,
  launchId: string,
): Promise<KeyringRailwayLaunchSecretStore> {
  if (dependencies.createRailwayLaunchSecretStore !== undefined) {
    return dependencies.createRailwayLaunchSecretStore(launchId);
  }
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new KeyringRailwayLaunchSecretStore(
    new AsyncEntry(RAILWAY_LAUNCH_SECRET_KEYRING_SERVICE, launchId),
  );
}

function railwayBootstrapOutputBinding(state: RailwayDeploymentDriverState): RailwayBootstrapOutputBinding {
  const resource = (kind: string): string | undefined => state.reconcile.receipt.resources.find((item) => item.kind === kind)?.id;
  const projectId = resource("railway.project"); const environmentId = resource("railway.environment");
  const serviceId = state.logtoBootstrap?.serviceId; const domainId = state.logtoBootstrap?.handoffDomainId;
  if (projectId === undefined || environmentId === undefined || serviceId === undefined || domainId === undefined) {
    throw new Error("Railway bootstrap output custody failed");
  }
  return { launchId: state.launchId, releaseId: state.releaseId, projectId, environmentId, serviceId, domainId };
}

async function resolveRailwayNautiloTargetUrl(input: {
  readonly state: RailwayDeploymentDriverState;
  readonly resources: RailwayGraphqlReconcileExecutor;
}): Promise<string | undefined> {
  const project = input.state.reconcile.receipt.resources.find((entry) => entry.kind === "railway.project");
  const environment = input.state.reconcile.receipt.resources.find((entry) => entry.kind === "railway.environment");
  const domainReceipt = input.state.reconcile.receipt.resources.find((entry) => (
    entry.kind === "railway.domain" && entry.name === "nautilo-public"
  ));
  if (project === undefined || environment === undefined || domainReceipt === undefined) return undefined;
  try {
    const services = await input.resources.listServices({ projectId: project.id });
    for (const service of services) {
      const domains = await input.resources.listDomains({
        projectId: project.id,
        environmentId: environment.id,
        serviceId: service.id,
      });
      const exactDomain = domains.find((domain) => domain.id === domainReceipt.id);
      if (exactDomain !== undefined) return `https://${exactDomain.domain}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

type RailwayOwnerResumeOutcome =
  | "owner-bound"
  | "claim-active"
  | "install-unknown"
  | "unavailable";

interface RailwayOwnerResumeResult {
  readonly outcome: RailwayOwnerResumeOutcome;
  readonly controllerErrorCode?: RailwayOwnerClaimControllerErrorCode | undefined;
  readonly completion?: ServerCompletionSummary | undefined;
}

function ownerResumeResult(
  outcome: RailwayOwnerResumeOutcome,
  error?: unknown,
): RailwayOwnerResumeResult {
  return {
    outcome,
    ...(error instanceof RailwayOwnerClaimControllerError ? { controllerErrorCode: error.code } : {}),
  };
}

const RAILWAY_OWNER_STATUS_STARTUP_ATTEMPTS = 6;
const RAILWAY_OWNER_STATUS_STARTUP_INTERVAL_MS = 2_000;

function isTransientRailwayOwnerStatusFailure(error: unknown): boolean {
  return error instanceof RailwayOwnerClaimControllerError
    && (error.code === "railway.owner-claim.unreachable" || error.code === "railway.owner-claim.timeout");
}

async function observeRailwayOwnerStatusAfterStartup(input: {
  readonly target: RailwayOwnerClaimTarget;
  readonly targetUrl: string;
  readonly scheduler: HostProgressScheduler;
}) {
  for (let attempt = 0; attempt < RAILWAY_OWNER_STATUS_STARTUP_ATTEMPTS; attempt += 1) {
    try {
      return await input.target.status({ targetUrl: input.targetUrl });
    } catch (error) {
      if (!isTransientRailwayOwnerStatusFailure(error)
        || attempt === RAILWAY_OWNER_STATUS_STARTUP_ATTEMPTS - 1) throw error;
      await input.scheduler.sleep(RAILWAY_OWNER_STATUS_STARTUP_INTERVAL_MS);
    }
  }
  throw new Error("Railway owner status retry exhausted unexpectedly");
}

async function continueRailwayOwnerSetup(input: {
  readonly operation: "deploy" | "resume";
  readonly state: RailwayDeploymentDriverState;
  readonly transport: RailwayPlanTransport;
  /** Fresh deploy passes its exact in-memory launch custody; exact resume loads it. */
  readonly generatedSecrets?: ReadonlyMap<string, string>;
  readonly progress: HostProgressMode;
  readonly json: boolean;
  readonly finish: ServerFinishMode;
  /** Browser handoff is interactive-only; JSON/automation remains resumable. */
  readonly openBrowser: boolean;
  readonly dependencies: HostPlanDependencies;
}): Promise<RailwayOwnerResumeResult> {
  const resources = new RailwayGraphqlReconcileExecutor({ transport: input.transport });
  const targetUrl = await resolveRailwayNautiloTargetUrl({ state: input.state, resources });
  if (targetUrl === undefined) {
    input.dependencies.writeStderr("The exact receipt-owned Nautilo endpoint is unavailable; inspect the launch before retrying owner setup.\n");
    return ownerResumeResult("unavailable");
  }
  const targetResult = (
    result: RailwayOwnerResumeOutcome,
    error?: unknown,
    browser: ServerBrowserOutcome = "not-requested",
  ): RailwayOwnerResumeResult => ({
    ...ownerResumeResult(result, error),
    completion: buildServerCompletionSummary({
      backend: "railway",
      operation: input.operation,
      outcome: result === "owner-bound"
        ? "complete"
        : result === "claim-active"
          ? "action-required"
          : "recoverable",
      finish: input.finish,
      serverUrl: targetUrl,
      browser,
      launchId: input.state.launchId,
      payer: "customer",
      ...(result === "claim-active"
        ? { recoveryCode: "resume-exact-launch" as const }
        : result === "install-unknown"
          ? { recoveryCode: "resume-exact-launch" as const }
          : {}),
    }),
  });
  const markOwnerBound = async (): Promise<void> => {
    const store = railwayStateStore(input.dependencies.environment, input.state.launchId);
    const updatedAt = new Date().toISOString();
    const ownerBound = { ...input.state, lifecycle: { state: "owner-bound" as const, updatedAt } };
    await store.write(ownerBound);
    await store.write({ ...ownerBound, lifecycle: { state: "active" as const, updatedAt } });
  };
  const target = input.dependencies.railwayOwnerClaimTarget
    ?? createRailwayOwnerClaimTarget(input.dependencies.fetch ?? fetch);
  const scheduler = input.dependencies.hostProgressScheduler ?? defaultHostProgressScheduler;
  let targetStatus;
  try {
    targetStatus = await observeRailwayOwnerStatusAfterStartup({ target, targetUrl, scheduler });
  } catch (error) {
    input.dependencies.writeStderr("The Nautilo owner-setup status could not be observed safely; no claim was installed.\n");
    return targetResult("unavailable", error);
  }
  let store: KeyringRailwayOwnerClaimStore;
  try {
    store = await railwayOwnerClaimStore(input.dependencies, input.state.launchId);
  } catch {
    input.dependencies.writeStderr("The operating-system keychain cannot safely access this launch's temporary owner claim.\n");
    return targetResult("unavailable");
  }
  if (targetStatus.state === "owner-bound") {
    await store.clear().catch(() => undefined);
    await markOwnerBound();
    return targetResult("owner-bound");
  }

  let claim: string;
  try {
    // `awaiting-owner` includes a previous claim which expired while the
    // operator was away. Replace it before the network write; an existing
    // `claim-active` status instead reuses the same local claim after a lost
    // install response.
    claim = targetStatus.state === "awaiting-owner"
      ? await store.rotate({ launchId: input.state.launchId, releaseId: input.state.releaseId })
      : await store.getOrCreate({ launchId: input.state.launchId, releaseId: input.state.releaseId });
  } catch {
    input.dependencies.writeStderr("The operating-system keychain cannot safely prepare a temporary owner claim.\n");
    return targetResult("unavailable");
  }
  let bootstrapToken = input.generatedSecrets?.get("nautilo-bootstrap-token");
  if (bootstrapToken === undefined) {
    try {
      // Exact resume may never mint replacement credentials: the bootstrap
      // authority must be the original launch/release-bound Keychain value.
      const stored = await (await railwayLaunchSecretStore(input.dependencies, input.state.launchId)).load({
        launchId: input.state.launchId,
        releaseId: input.state.releaseId,
      });
      bootstrapToken = stored?.get("nautilo-bootstrap-token");
    } catch {
      bootstrapToken = undefined;
    }
  }
  if (bootstrapToken === undefined) {
    input.dependencies.writeStderr("The receipt-backed bootstrap authority is unavailable; do not create another launch.\n");
    return targetResult("unavailable");
  }
  let installed;
  try {
    installed = await target.install({
      targetUrl,
      bootstrapToken,
      claimHash: hashRailwayOwnerClaim(claim),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  } catch (error) {
    // A failed PUT can mean either a rejected request or a committed write
    // whose response was lost. Re-observe the redacted target before naming
    // an outcome; never manufacture `claim-active` from transport failure.
    try {
      const observed = await target.status({ targetUrl });
      if (observed.state === "owner-bound") {
        await store.clear().catch(() => undefined);
        await markOwnerBound();
        return targetResult("owner-bound");
      }
      if (observed.state === "claim-active") {
        input.dependencies.writeStderr("The owner claim is active, although its install response was lost. Resume this exact launch to continue.\n");
        return targetResult("claim-active", error);
      }
    } catch {
      // Fall through to an explicitly unknown/unavailable result.
    }
    input.dependencies.writeStderr("The owner claim install result could not be verified. Resume this exact launch; it will reuse the protected local claim without asserting that the server accepted it.\n");
    return targetResult("install-unknown", error);
  }
  if (installed.state === "owner-bound") {
    await store.clear().catch(() => undefined);
    await markOwnerBound();
    return targetResult("owner-bound");
  }

  if (!input.openBrowser) {
    input.dependencies.writeStderr("A protected owner claim is active. Run the exact resume command from an interactive terminal to open first-owner setup.\n");
    return targetResult("claim-active");
  }

  let handoff: RailwayOwnerClaimBrowserHandoff | undefined;
  try {
    handoff = await (input.dependencies.createRailwayOwnerClaimBrowserHandoff
      ?? createRailwayOwnerClaimBrowserHandoff)({ targetUrl, claim, finish: input.finish });
    await (input.dependencies.openRailwayOwnerClaimBrowser ?? openUrlInDefaultBrowserChecked)(handoff.localUrl);
  } catch {
    await handoff?.close().catch(() => undefined);
    input.dependencies.writeStderr("The owner browser handoff could not open. Resume this exact launch to retry; the protected claim remains recoverable.\n");
    return targetResult("claim-active", undefined, "failed");
  }
  input.dependencies.writeStderr("Complete first-owner setup in the browser. This command is waiting; Ctrl+C is safe and exact resume will continue.\n");
  const interruption = input.dependencies.createHostInterruptController?.()
    ?? createScopedHostInterruptController(process);
  const progress = createHostProgressSink({ progress: input.progress, json: input.json }, input.dependencies);
  const startedAt = scheduler.now();
  try {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (interruption.interrupted()) return targetResult("claim-active", undefined, "opened");
      if (attempt > 0) await scheduler.sleep(5_000);
      if (interruption.interrupted()) return targetResult("claim-active", undefined, "opened");
      progress?.emit({
        schemaVersion: HOST_PROGRESS_SCHEMA_VERSION,
        launchId: input.state.launchId,
        stage: "owner-setup",
        kind: attempt === 0 ? "started" : "heartbeat",
        elapsedMs: Math.max(0, scheduler.now() - startedAt),
        messageCode: attempt === 0 ? "hosting.owner-setup.waiting" : "hosting.owner-setup.heartbeat",
      });
      try {
        const observed = await target.status({ targetUrl });
        if (observed.state === "owner-bound") {
          await store.clear().catch(() => undefined);
          await markOwnerBound();
          progress?.emit({
            schemaVersion: HOST_PROGRESS_SCHEMA_VERSION,
            launchId: input.state.launchId,
            stage: "owner-setup",
            kind: "completed",
            elapsedMs: Math.max(0, scheduler.now() - startedAt),
            messageCode: "hosting.owner-setup.complete",
          });
          return targetResult("owner-bound", undefined, "opened");
        }
      } catch (error) {
        // A transient target read is recoverable: retain the claim and give
        // exact resume rather than guessing whether the browser completed.
        return targetResult("claim-active", error, "opened");
      }
    }
    return targetResult("claim-active", undefined, "opened");
  } finally {
    interruption.dispose();
    await handoff.close().catch(() => undefined);
  }
}

async function executeRailwayHostInspect(
  input: RailwayInspectInput,
  dependencies: HostPlanDependencies,
): Promise<void> {
  if (!isRailwayLaunchSelector(input.launchId)) {
    dependencies.writeStderr("Railway inspect requires the exact saved launch selector.\n");
    process.exitCode = 2;
    return;
  }
  const stateStore = railwayStateStore(dependencies.environment, input.launchId);
  let state: RailwayDeploymentDriverState | undefined;
  try {
    state = await stateStore.read();
  } catch {
    state = undefined;
  }
  if (state === undefined) {
    dependencies.writeStderr("No safe Railway launch checkpoint exists for that launch UUID.\n");
    process.exitCode = 2;
    return;
  }

  const references = await discoverProviderReferences(dependencies.environment);
  if (references.outcome === "failure") {
    dependencies.writeStderr("Provider readiness could not be inspected from documented config.\n");
    process.exitCode = 2;
    return;
  }
  const authorization = await dependencies.acquireRailwayAuthorization({
    interactive: input.interactiveAuthorization,
  });
  if (authorization.outcome !== "authorized") {
    dependencies.writeStderr("Railway authorization must be restored before receipt-backed inspection.\n");
    process.exitCode = 2;
    return;
  }

  const resources = new RailwayGraphqlReconcileExecutor({ transport: authorization.transport });
  const providerPlan = resolveProviderCapabilities({
    references: references.references,
    allProviders: false,
    includeProviders: state.providers,
    excludeProviders: [],
    qualifiedBaselineCapabilities: [],
    infrastructure: state.reconcile.receipt.stage === "claimable" ? "claimable" : "provisioning",
    // Inspection reports actual degradation; it never uses a missing optional
    // provider to suppress the infrastructure observation.
    coreDegradedConsent: true,
  });

  const environment = state.reconcile.receipt.resources.find((entry) => entry.kind === "railway.environment");
  const project = state.reconcile.receipt.resources.find((entry) => entry.kind === "railway.project");
  // The topology has two generated public domains. Inspection must expose and
  // probe only the server domain recorded under this canonical logical name;
  // using the first domain can select Logto because it is reconciled first.
  const domainReceipt = state.reconcile.receipt.resources.find((entry) => (
    entry.kind === "railway.domain" && entry.name === "nautilo-public"
  ));
  let publicDomain: string | undefined;
  if (project !== undefined && environment !== undefined && domainReceipt !== undefined) {
    try {
      const services = await resources.listServices({ projectId: project.id });
      for (const service of services) {
        const domains = await resources.listDomains({
          projectId: project.id,
          environmentId: environment.id,
          serviceId: service.id,
        });
        const exactDomain = domains.find((domain) => domain.id === domainReceipt.id);
        if (exactDomain !== undefined) {
          publicDomain = exactDomain.domain;
          break;
        }
      }
    } catch {
      publicDomain = undefined;
    }
  }

  let runtimeReady = false;
  if (state.reconcile.receipt.stage === "claimable" && publicDomain !== undefined) {
    try {
      const response = await (dependencies.fetch ?? fetch)(`https://${publicDomain}/health/ready`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      runtimeReady = response.status === 200;
    } catch {
      runtimeReady = false;
    }
  }
  const readinessNotices: HostingNotice[] = [...providerPlan.readiness.notices];
  if (!runtimeReady) {
    readinessNotices.push({
      severity: state.reconcile.receipt.stage === "claimable" ? "error" : "warning",
      code: "hosting.operation-failed",
      message: state.reconcile.receipt.stage === "claimable"
        ? "The receipt-owned Nautilo public endpoint did not pass its bounded readiness probe."
        : "The Railway launch is still provisioning and is not yet runtime-ready.",
      repairTarget: { kind: "authenticated-provider-api" },
    });
  }

  const inspection = await inspectRailwayDeployment({
    receipt: state.reconcile.receipt,
    executor: {
      getProject: async ({ projectId }) => {
        const projects = await resources.listProjects({ workspaceId: state.target.workspaceId });
        return projects.find((candidate) => candidate.id === projectId) ?? null;
      },
      getEnvironment: (request) => resources.getEnvironment(request),
      listServices: (request) => resources.listServices(request),
      getVolume: (request) => resources.getVolume(request),
      listVolumeInstances: (request) => resources.listVolumeInstances(request),
      listDomains: (request) => resources.listDomains(request),
      getDeployment: (request) => resources.getDeployment(request),
    },
    readiness: {
      coreReadiness: runtimeReady ? providerPlan.readiness.coreReadiness : "blocked",
      capabilities: providerPlan.capabilities,
      notices: readinessNotices,
    },
  });
  const output = {
    schemaVersion: 1,
    launchId: state.launchId,
    runtimeReady,
    ...(publicDomain === undefined ? {} : { url: `https://${publicDomain}` }),
    ...inspection,
  } as const;
  dependencies.writeStdout(input.json
    ? `${JSON.stringify(output, null, 2)}\n`
    : [
        `Nautilo Railway inspect: ${inspection.snapshot.infrastructure}`,
        `Launch: ${state.launchId}`,
        `Runtime ready: ${runtimeReady ? "yes" : "no"}`,
        `Core readiness: ${inspection.snapshot.coreReadiness}`,
        ...(publicDomain === undefined ? [] : [`URL: https://${publicDomain}`]),
        `Resources: ${inspection.resources.filter((entry) => entry.state === "present").length} present, ${inspection.resources.filter((entry) => entry.state === "missing" || entry.state === "drifted").length} unhealthy`,
      ].join("\n") + "\n");
  process.exitCode = inspection.snapshot.infrastructure === "failed" || !runtimeReady ? 1 : 0;
}

async function executeRailwayHostDeploy(
  input: RailwayDeployInput,
  dependencies: HostPlanDependencies,
): Promise<void> {
  const execution = await executeRailwayHostPlan(input, dependencies);
  if (execution.outcome !== "planned") {
    if (input.json) dependencies.writeStdout(`${JSON.stringify(execution.error, null, 2)}\n`);
    else if (execution.outcome === "authorization-required") {
      dependencies.writeStderr(renderAuthorizationRequiredTty(execution.error));
    } else {
      dependencies.writeStderr(renderHostPlanInputFailureTty(execution.error));
    }
    process.exitCode = 2;
    return;
  }
  const plan = execution.plan;
  const railwayTopology = plan.topology;
  if (!input.confirmed || plan.outcome !== "ready-for-confirmation"
    || railwayTopology === undefined || plan.identity.selectedWorkspace === undefined
    || plan.release.releaseId === undefined) {
    const result = {
      schemaVersion: 1,
      operation: "deploy",
      backend: "railway",
      outcome: "blocked",
      mutationAuthorized: false,
      nextAction: !input.confirmed ? "confirm-billable-mutation" : "resolve-plan-blockers",
      notices: plan.notices,
    } as const;
    if (input.json) dependencies.writeStdout(`${JSON.stringify(result, null, 2)}\n`);
    else {
      dependencies.writeStderr(renderRailwayPlanTty(plan));
      if (!input.confirmed) dependencies.writeStderr("Deployment requires --yes after reviewing this plan.\n");
    }
    process.exitCode = 1;
    return;
  }

  const selectedProviders = new Set(plan.providerPlan.providers
    .filter((provider) => provider.selected && provider.state === "configured")
    .map((provider) => provider.provider));
  const providerSecrets = await discoverProviderSecrets(
    dependencies.environment,
    selectedProviders,
    input.providerConfigPath,
    input.promptedProviderSecrets,
    input.ignoreProviderConfiguration,
  );
  if (providerSecrets.outcome === "failure") {
    const failure = inputFailure(providerSecrets.code);
    if (input.json) dependencies.writeStdout(`${JSON.stringify(failure, null, 2)}\n`);
    else dependencies.writeStderr(renderHostPlanInputFailureTty(failure));
    process.exitCode = 2;
    return;
  }
  const providerCustody = custodyFromProviderSecrets(providerSecrets.secrets, selectedProviders);
  if (providerCustody === undefined) {
    dependencies.writeStderr("Selected provider credentials changed before Railway deployment could begin. Review the plan and retry.\n");
    process.exitCode = 2;
    return;
  }

  const launchId = randomUUID();
  const nautiloRoot = resolveNautiloRootDir({ env: dependencies.environment });
  const stateRoot = join(nautiloRoot, "hosting", "railway");
  const stateStore = new RailwayLaunchStateStore({
    root: stateRoot,
    path: join(stateRoot, "launches", launchId, "state.json"),
    validate: parseRailwayDeploymentDriverState,
  });
  let state = createRailwayDeploymentDriverState({
    launchId,
    releaseId: plan.release.releaseId,
    ...(execution.signedManifest === undefined ? {} : { releaseManifest: execution.signedManifest }),
    providers: [...selectedProviders],
    target: {
      workspaceId: plan.identity.selectedWorkspace.id,
      projectName: plan.target.projectName,
      environmentName: "production",
    },
    now: new Date().toISOString(),
  });
  await stateStore.write(state);

  let generatedSecrets; let launchSecrets: KeyringRailwayLaunchSecretStore;
  try {
    launchSecrets = await railwayLaunchSecretStore(dependencies, launchId);
    generatedSecrets = await launchSecrets.getOrCreate({
      launchId,
      releaseId: plan.release.releaseId,
    });
  } catch {
    writeRailwayRecoverableFailure({
      operation: "deploy",
      json: input.json,
      progress: input.progress,
      message: "Railway deployment could not secure generated credentials in the operating-system keychain.",
      state,
      dependencies,
    });
    return;
  }

  let custodyStore: KeyringRailwayProviderCustodyStore | undefined;
  let externalProviderSecrets = new Map<string, string>();
  if (providerCustody.size > 0) {
    try {
      custodyStore = await providerCustodyStore(dependencies, launchId);
      const confirmed = await custodyStore.writeOrConfirm({
        launchId,
        releaseId: plan.release.releaseId,
        providers: providerCustody,
      });
      externalProviderSecrets = externalProviderSecretsFromCustody(confirmed);
    } catch {
      writeRailwayRecoverableFailure({
        operation: "deploy",
        json: input.json,
        progress: input.progress,
        message: "Railway deployment could not secure provider credentials in the operating-system keychain.",
        state,
        dependencies,
      });
      return;
    }
  }

  const projectionInputs = {
    generatedSecrets,
    generatedPublicDomains: new Map(),
    bootstrapOutputs: new Map(),
    externalProviderSecrets,
  } as const;
  const scheduler = dependencies.hostProgressScheduler ?? defaultHostProgressScheduler;
  const coordinator = createHostProgressCoordinator({
    clock: scheduler,
    sink: createHostProgressSink(input, dependencies),
    launchId,
  });
  const interruption = dependencies.createHostInterruptController?.() ?? createScopedHostInterruptController(process);
  let polling;
  try {
    polling = await pollHostProgress({
      initialState: state,
      stage: (candidate) => candidate.workflow?.stage ?? candidate.reconcile.receipt.stage,
      coordinator,
      scheduler,
      interruption,
      maxAttempts: 180,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async (candidate) => {
        let durableStageTransitions = false;
        let observedStage = candidate.workflow?.stage ?? candidate.reconcile.receipt.stage;
        const result = await runRailwayDeploymentDriver({
          state: candidate,
          topology: railwayTopology,
          projectionInputs,
          transport: execution.transport,
          persistState: (next) => stateStore.write(next),
          now: () => new Date().toISOString(),
          persistLogtoBootstrapOutput: ({ state: durable, output }) => launchSecrets.storeBootstrapOutputs(
            railwayBootstrapOutputBinding(durable), output,
          ),
          onWorkflowStageTransition: ({ previous, next }) => {
            durableStageTransitions = true;
            coordinator.emit({
              stage: previous ?? observedStage,
              kind: "completed",
              messageCode: "hosting.stage.completed",
            });
            coordinator.emit({ stage: next, kind: "started", messageCode: "hosting.stage.started" });
            observedStage = next;
          },
        });
        if (custodyStore !== undefined && providerCustodyMayBeErased(result.state.workflow?.stage)) {
          try {
            await custodyStore.clear();
            custodyStore = undefined;
            externalProviderSecrets.clear();
          } catch {
            coordinator.emit({
              stage: result.state.workflow?.stage ?? result.state.reconcile.receipt.stage,
              kind: "warning",
              messageCode: "hosting.provider-custody.cleanup-failed",
            });
          }
        }
        return {
          state: result.state,
          outcome: result.outcome,
          ...(durableStageTransitions ? { durableStageTransitions: true } : {}),
          ...(result.outcome === "failure" ? { failureCode: result.failureCode } : {}),
        };
      },
    });
  } finally {
    interruption.dispose();
  }
  state = polling.state;
  const outcome = polling.outcome;
  const failureCode = polling.failureCode;
  const ownerSetup = outcome === "complete" && state.reconcile.receipt.stage === "claimable"
    ? await continueRailwayOwnerSetup({
      operation: "deploy",
      state,
      transport: execution.transport,
      generatedSecrets,
      progress: input.progress,
      json: input.json,
      openBrowser: input.openBrowser,
      finish: input.finish,
      dependencies,
    })
    : undefined;
  const recovery = outcome === "complete" && ownerSetup?.outcome === "owner-bound"
    ? undefined
    : railwayRecovery(launchId, state);

  const output = {
    schemaVersion: 1,
    operation: "deploy",
    backend: "railway",
    outcome: outcome === "complete" && ownerSetup !== undefined && ownerSetup.outcome !== "owner-bound"
      ? ownerSetup.outcome
      : outcome,
    launchId,
    stage: state.reconcile.receipt.stage,
    resources: state.reconcile.receipt.resources,
    mutationAuthorized: true,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(ownerSetup === undefined ? {} : { ownerSetup: ownerSetup.outcome }),
    ...(ownerSetup?.controllerErrorCode === undefined ? {} : { ownerSetupErrorCode: ownerSetup.controllerErrorCode }),
    ...(ownerSetup?.completion === undefined ? {} : { completion: ownerSetup.completion }),
    ...(recovery === undefined ? {} : { recovery }),
  } as const;
  dependencies.writeStdout(input.json
    ? `${JSON.stringify(output, null, 2)}\n`
    : [
        `Nautilo Railway deployment: ${outcome === "complete" && ownerSetup !== undefined && ownerSetup.outcome !== "owner-bound" ? ownerSetup.outcome : outcome}`,
        `Launch: ${launchId}`,
        `Stage: ${state.reconcile.receipt.stage}`,
        ...(ownerSetup === undefined ? [] : [`Owner setup: ${ownerSetup.outcome}`]),
        ...(ownerSetup?.completion === undefined ? [] : [`Destination: ${ownerSetup.completion.destinations.finalUrl}`]),
        ...(ownerSetup?.controllerErrorCode === undefined ? [] : [`Owner controller: ${ownerSetup.controllerErrorCode}`]),
        ...(ownerSetup !== undefined && ownerSetup.outcome !== "owner-bound"
          ? ["Railway remains billable until you finish owner setup or run the exact destroy command below."]
          : []),
        ...(recovery === undefined ? [] : renderRailwayRecovery(recovery)),
      ].join("\n") + "\n");
  process.exitCode = outcome === "complete" && (ownerSetup === undefined || ownerSetup.outcome === "owner-bound")
    ? 0
    : outcome === "interrupted" ? 130 : 1;
}

async function executeRailwayHostResume(
  input: RailwayResumeInput,
  dependencies: HostPlanDependencies,
): Promise<void> {
  const publicOperation = input.publicOperation ?? "resume";
  const publicLabel = publicOperation === "adopt" ? "adoption" : "resume";
  if (!isRailwayLaunchSelector(input.launchId)) {
    dependencies.writeStderr("Railway resume requires the exact saved launch selector.\n");
    process.exitCode = 2;
    return;
  }
  const stateStore = railwayStateStore(dependencies.environment, input.launchId);
  let state: RailwayDeploymentDriverState | undefined;
  try {
    state = await stateStore.read();
  } catch {
    dependencies.writeStderr("The Railway launch checkpoint is unreadable or unsafe.\n");
    process.exitCode = 2;
    return;
  }
  if (state === undefined) {
    dependencies.writeStderr("No Railway launch checkpoint exists for that launch UUID.\n");
    process.exitCode = 2;
    return;
  }

  if (state.lifecycle?.state === "active" || state.lifecycle?.state === "superseded" || state.lifecycle?.state === "destroyed") {
    const phase = state.lifecycle.state === "destroyed" ? "destroyed" : "complete";
    const output = { schemaVersion: 1, operation: publicOperation, backend: "railway", outcome: "complete", phase } as const;
    dependencies.writeStdout(input.json ? `${JSON.stringify(output)}\n`
      : `Nautilo Railway ${publicLabel}: complete\nPhase: ${phase}\n`);
    process.exitCode = 0;
    return;
  }

  // Infrastructure has already reached its terminal Railway stage. Do not
  // replay the reconciler merely to continue first-owner setup; it would add
  // needless provider calls and weakens the exact-resume story.
  if (state.reconcile.receipt.stage === "claimable") {
    const authorization = await dependencies.acquireRailwayAuthorization({
      interactive: input.interactiveAuthorization,
    });
    if (authorization.outcome !== "authorized" || authorization.authorization.mutationScope !== "qualified") {
      dependencies.writeStderr("Railway authorization must be restored before exact owner setup can resume.\n");
      process.exitCode = 2;
      return;
    }
    const ownerSetup = await continueRailwayOwnerSetup({
      operation: "resume",
      state,
      transport: authorization.transport,
      progress: input.progress,
      json: input.json,
      openBrowser: input.openBrowser,
      finish: input.finish,
      dependencies,
    });
    const reportedOutcome = ownerSetup.outcome === "owner-bound" ? "complete" : ownerSetup.outcome;
    const recovery = ownerSetup.outcome === "owner-bound" ? undefined : railwayRecovery(state.launchId, state);
    const output = {
      schemaVersion: 1,
      operation: "resume",
      backend: "railway",
      outcome: reportedOutcome,
      launchId: state.launchId,
      stage: state.reconcile.receipt.stage,
      ownerSetup: ownerSetup.outcome,
      resources: state.reconcile.receipt.resources,
      ...(ownerSetup.controllerErrorCode === undefined ? {} : { ownerSetupErrorCode: ownerSetup.controllerErrorCode }),
      ...(ownerSetup.completion === undefined ? {} : { completion: ownerSetup.completion }),
      ...(recovery === undefined ? {} : { recovery }),
    } as const;
    dependencies.writeStdout(input.json
      ? `${JSON.stringify(output, null, 2)}\n`
      : [
          `Nautilo Railway ${publicLabel}: ${reportedOutcome}`,
          `Launch: ${state.launchId}`,
          `Stage: ${state.reconcile.receipt.stage}`,
          `Owner setup: ${ownerSetup.outcome}`,
          ...(ownerSetup.completion === undefined ? [] : [`Destination: ${ownerSetup.completion.destinations.finalUrl}`]),
          ...(ownerSetup.controllerErrorCode === undefined ? [] : [`Owner controller: ${ownerSetup.controllerErrorCode}`]),
          ...(ownerSetup.outcome !== "owner-bound"
            ? ["Railway remains billable until you finish owner setup or run the exact destroy command below."]
            : []),
          ...(recovery === undefined ? [] : renderRailwayRecovery(recovery)),
        ].join("\n") + "\n");
    process.exitCode = ownerSetup.outcome === "owner-bound" ? 0 : 1;
    return;
  }

  let release;
  try {
    release = await dependencies.resolveRailwayRelease(state.releaseManifest);
  } catch {
    release = { state: "invalid" } as const;
  }
  if (release.state !== "verified" || release.manifest.releaseId !== state.releaseId) {
    writeRailwayRecoverableFailure({
      operation: "resume",
      json: input.json,
      progress: input.progress,
      message: "Resume requires the same verified immutable release used by the launch.",
      state,
      dependencies,
    });
    return;
  }
  const topology = buildRailwayTopology(release.manifest);
  if (!topology.ok) {
    writeRailwayRecoverableFailure({
      operation: "resume",
      json: input.json,
      progress: input.progress,
      message: "The verified release no longer compiles to a Railway topology.",
      state,
      dependencies,
    });
    return;
  }
  let custodyStore: KeyringRailwayProviderCustodyStore | undefined;
  let externalProviderSecrets = new Map<string, string>();
  if (state.providers.length > 0 && !providerCustodyMayBeErased(state.workflow?.stage)) {
    try {
      custodyStore = await providerCustodyStore(dependencies, state.launchId);
      const retained = await custodyStore.load({ launchId: state.launchId, releaseId: state.releaseId });
      if (retained !== undefined) {
        if (!providerCustodyHasExactly(retained, state.providers)) {
          throw new Error("provider custody does not match launch selection");
        }
        if (input.providerConfigPath !== undefined) {
          const supplied = await discoverProviderSecrets(
            dependencies.environment,
            new Set(state.providers),
            input.providerConfigPath,
          );
          if (supplied.outcome === "failure") {
            const failure = inputFailure(supplied.code);
            if (input.json) dependencies.writeStdout(`${JSON.stringify(failure, null, 2)}\n`);
            else dependencies.writeStderr(renderHostPlanInputFailureTty(failure));
            process.exitCode = 2;
            return;
          }
          const candidate = custodyFromProviderSecrets(supplied.secrets, new Set(state.providers));
          if (candidate === undefined) {
            dependencies.writeStderr("The explicit provider configuration does not contain every provider selected by this launch.\n");
            process.exitCode = 2;
            return;
          }
          custodyStore.assertCompatible(retained, candidate);
        }
        externalProviderSecrets = externalProviderSecretsFromCustody(retained);
      } else {
        let repaired: RailwayProviderCustody | undefined;
        if (input.providerConfigPath !== undefined) {
          const repair = await discoverProviderSecrets(
            dependencies.environment,
            new Set(state.providers),
            input.providerConfigPath,
          );
          if (repair.outcome === "failure") {
            const failure = inputFailure(repair.code);
            if (input.json) dependencies.writeStdout(`${JSON.stringify(failure, null, 2)}\n`);
            else dependencies.writeStderr(renderHostPlanInputFailureTty(failure));
            process.exitCode = 2;
            return;
          }
          repaired = custodyFromProviderSecrets(repair.secrets, new Set(state.providers));
        } else if (input.interactiveAuthorization && interactiveTerminal(dependencies)) {
          try {
            const selected = state.providers.filter((provider): provider is RailwayRuntimeProvider =>
              railwayRuntimeProviderSet.has(provider));
            if (selected.length !== state.providers.length) throw new Error("unsupported provider in launch state");
            const prompted = await hostProviderPrompter(dependencies).repair({ providers: selected });
            if (prompted !== undefined && providerCustodyHasExactly(prompted, state.providers)) {
              repaired = prompted;
            }
          } catch {
            repaired = undefined;
          }
        } else {
          dependencies.writeStderr("This interrupted Railway launch needs its original provider custody repaired with --provider-config or an interactive terminal.\n");
          process.exitCode = 2;
          return;
        }
        if (repaired === undefined) {
          dependencies.writeStderr("This interrupted Railway launch needs every originally selected provider credential before it can resume.\n");
          process.exitCode = 2;
          return;
        }
        const confirmed = await custodyStore.writeOrConfirm({
          launchId: state.launchId,
          releaseId: state.releaseId,
          providers: repaired,
        });
        externalProviderSecrets = externalProviderSecretsFromCustody(confirmed);
      }
    } catch {
      writeRailwayRecoverableFailure({
        operation: "resume",
        json: input.json,
        progress: input.progress,
        message: "The operating-system provider credential custody cannot safely resume this Railway launch.",
        state,
        dependencies,
      });
      return;
    }
  }
  const authorization = await dependencies.acquireRailwayAuthorization({
    interactive: input.interactiveAuthorization,
  });
  if (authorization.outcome !== "authorized" || authorization.authorization.mutationScope !== "qualified") {
    writeRailwayRecoverableFailure({
      operation: "resume",
      json: input.json,
      progress: input.progress,
      message: "Railway authorization must be restored before this launch can resume.",
      state,
      dependencies,
    });
    return;
  }
  let generatedSecrets; let launchSecrets: KeyringRailwayLaunchSecretStore;
  try {
    launchSecrets = await railwayLaunchSecretStore(dependencies, state.launchId);
    generatedSecrets = await launchSecrets.getOrCreate({
      launchId: state.launchId,
      releaseId: state.releaseId,
    });
  } catch {
    writeRailwayRecoverableFailure({
      operation: "resume",
      json: input.json,
      progress: input.progress,
      message: "The operating-system keychain cannot recover this launch's generated credentials.",
      state,
      dependencies,
    });
    return;
  }

  const scheduler = dependencies.hostProgressScheduler ?? defaultHostProgressScheduler;
  const coordinator = createHostProgressCoordinator({
    clock: scheduler,
    sink: createHostProgressSink(input, dependencies),
    launchId: state.launchId,
  });
  const interruption = dependencies.createHostInterruptController?.() ?? createScopedHostInterruptController(process);
  let polling;
  try {
    polling = await pollHostProgress({
      initialState: state,
      stage: (candidate) => candidate.workflow?.stage ?? candidate.reconcile.receipt.stage,
      coordinator,
      scheduler,
      interruption,
      maxAttempts: 180,
      retryDelayMs: 5_000,
      heartbeatIntervalMs: 15_000,
      execute: async (candidate) => {
        let durableStageTransitions = false;
        let observedStage = candidate.workflow?.stage ?? candidate.reconcile.receipt.stage;
        const result = await runRailwayDeploymentDriver({
          state: candidate,
          topology: topology.topology,
          projectionInputs: {
            generatedSecrets,
            generatedPublicDomains: new Map(),
            bootstrapOutputs: new Map(),
            externalProviderSecrets,
          },
          transport: authorization.transport,
          persistState: (next) => stateStore.write(next),
          now: () => new Date().toISOString(),
          persistLogtoBootstrapOutput: ({ state: durable, output }) => launchSecrets.storeBootstrapOutputs(
            railwayBootstrapOutputBinding(durable), output,
          ),
          onWorkflowStageTransition: ({ previous, next }) => {
            durableStageTransitions = true;
            coordinator.emit({
              stage: previous ?? observedStage,
              kind: "completed",
              messageCode: "hosting.stage.completed",
            });
            coordinator.emit({ stage: next, kind: "started", messageCode: "hosting.stage.started" });
            observedStage = next;
          },
        });
        if (custodyStore !== undefined && providerCustodyMayBeErased(result.state.workflow?.stage)) {
          try {
            await custodyStore.clear();
            custodyStore = undefined;
            externalProviderSecrets.clear();
          } catch {
            coordinator.emit({
              stage: result.state.workflow?.stage ?? result.state.reconcile.receipt.stage,
              kind: "warning",
              messageCode: "hosting.provider-custody.cleanup-failed",
            });
          }
        }
        return {
          state: result.state,
          outcome: result.outcome,
          ...(durableStageTransitions ? { durableStageTransitions: true } : {}),
          ...(result.outcome === "failure" ? { failureCode: result.failureCode } : {}),
        };
      },
    });
  } finally {
    interruption.dispose();
  }
  state = polling.state;
  const outcome = polling.outcome;
  const failureCode = polling.failureCode;
  const ownerSetup = outcome === "complete" && state.reconcile.receipt.stage === "claimable"
    ? await continueRailwayOwnerSetup({
      operation: "resume",
      state,
      transport: authorization.transport,
      generatedSecrets,
      progress: input.progress,
      json: input.json,
      openBrowser: input.openBrowser,
      finish: input.finish,
      dependencies,
    })
    : undefined;
  const reportedOutcome = outcome === "complete" && ownerSetup !== undefined && ownerSetup.outcome !== "owner-bound"
    ? ownerSetup.outcome
    : outcome;
  const recovery = outcome === "complete" && ownerSetup?.outcome === "owner-bound"
    ? undefined
    : railwayRecovery(state.launchId, state);
  const output = {
    schemaVersion: 1,
    operation: publicOperation,
    backend: "railway",
    outcome: reportedOutcome,
    launchId: state.launchId,
    stage: state.reconcile.receipt.stage,
    resources: state.reconcile.receipt.resources,
    ...(ownerSetup === undefined ? {} : { ownerSetup: ownerSetup.outcome }),
    ...(ownerSetup?.controllerErrorCode === undefined ? {} : { ownerSetupErrorCode: ownerSetup.controllerErrorCode }),
    ...(ownerSetup?.completion === undefined ? {} : { completion: ownerSetup.completion }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(recovery === undefined ? {} : { recovery }),
  } as const;
  dependencies.writeStdout(input.json
    ? `${JSON.stringify(output, null, 2)}\n`
    : [
        `Nautilo Railway ${publicLabel}: ${reportedOutcome}`,
        `Launch: ${state.launchId}`,
        `Stage: ${state.reconcile.receipt.stage}`,
        ...(ownerSetup === undefined ? [] : [`Owner setup: ${ownerSetup.outcome}`]),
        ...(ownerSetup?.completion === undefined ? [] : [`Destination: ${ownerSetup.completion.destinations.finalUrl}`]),
        ...(ownerSetup?.controllerErrorCode === undefined ? [] : [`Owner controller: ${ownerSetup.controllerErrorCode}`]),
        ...(ownerSetup !== undefined && ownerSetup.outcome !== "owner-bound"
          ? ["Railway remains billable until you finish owner setup or run the exact destroy command below."]
          : []),
        ...(recovery === undefined ? [] : renderRailwayRecovery(recovery)),
      ].join("\n") + "\n");
  process.exitCode = outcome === "complete" && (ownerSetup === undefined || ownerSetup.outcome === "owner-bound")
    ? 0
    : outcome === "interrupted" ? 130 : 1;
}

interface RailwayMaintenanceCommandInput {
  readonly operation: "upgrade" | "resume";
  readonly launchId?: string | undefined;
  readonly recoveryConfigPath?: string | undefined;
  readonly providerConfigPath?: string | undefined;
  readonly confirmed: boolean;
  readonly discardReplacement?: boolean | undefined;
  readonly discardConfirmed?: boolean | undefined;
  readonly json: boolean;
}

export function railwayMaintenanceProjectionComplete(
  state: RailwayMaintenanceState,
  launches: readonly { readonly launchId: string; readonly state: RailwayDeploymentDriverState }[],
): boolean {
  if (state.maintenanceReceipt.stage !== "complete" || state.activeLaunch === undefined) return false;
  const source = launches.find(({ launchId }) => launchId === state.sourceLaunchId)?.state;
  const selected = launches.find(({ launchId }) => launchId === state.activeLaunch!.launchId)?.state;
  const selectedLifecycle = selected?.lifecycle;
  if (selectedLifecycle?.state === "active"
    && selectedLifecycle.maintenanceId !== undefined
    && selectedLifecycle.maintenanceId !== state.maintenanceId
    && Date.parse(selectedLifecycle.updatedAt) >= Date.parse(state.activeLaunch.selectedAt)) {
    return true;
  }
  if (state.activeLaunch.kind === "source") {
    return source?.releaseId === state.activeLaunch.releaseId
      && source.lifecycle?.state === "active" && source.lifecycle.maintenanceId === state.maintenanceId;
  }
  return selected?.releaseId === state.activeLaunch.releaseId
    && selected.lifecycle?.state === "active" && selected.lifecycle.maintenanceId === state.maintenanceId
    && source?.lifecycle?.state === "superseded" && source.lifecycle.maintenanceId === state.maintenanceId
    && source.lifecycle.supersededByLaunchId === state.activeLaunch.launchId;
}

export function railwayMaintenanceCustodyProjection(
  state: RailwayMaintenanceState | undefined,
): RailwayDeploymentDriverState | undefined {
  if (state === undefined) return undefined;
  const candidate = state.candidateUpgrade;
  const projection = state.postUpgradeSourceState;
  return candidate?.stage === "complete"
    && projection?.launchId === state.sourceLaunchId
    && projection.releaseId === state.maintenanceReceipt.targetReleaseId
    ? projection
    : undefined;
}

function publicRailwayMaintenancePhase(stage: string, state?: RailwayMaintenanceState): string {
  if (state?.restoreTargetDisposition !== undefined || stage.includes("cleanup")) return "cleaning-up";
  if (stage.includes("quiesc")) return "quiescing";
  if (stage.includes("backup")) return state?.portableExport === undefined ? "backing-up" : "exporting";
  if (stage.includes("export")) return state?.candidateUpgrade === undefined ? "exporting" : "updating";
  if (stage.includes("candidate") || stage.includes("upgrade") || stage === "release" || stage === "migration") return "updating";
  if (stage.includes("verif")) return "verifying";
  if (stage === "restore" && state?.restoredTargetActivation !== undefined) return "activating";
  if (stage.includes("prepar") || stage.includes("restore")) return "restoring";
  if (stage.includes("activ")) return "activating";
  return "preparing";
}

export async function advanceRailwayMaintenanceUntilBlocked(input: {
  readonly initialState: RailwayMaintenanceState | null;
  readonly run: () => Promise<RailwayHostMaintenanceResult>;
  readonly readState: () => Promise<RailwayMaintenanceState | null>;
  readonly reportPhase: (phase: string) => void;
  readonly interrupted: () => boolean;
}): Promise<{ readonly result: RailwayHostMaintenanceResult; readonly state: RailwayMaintenanceState | null }> {
  let state = input.initialState;
  let lastReportedPhase: string | undefined;
  let result: RailwayHostMaintenanceResult;
  do {
    const beforeRevision = state?.revision ?? -1;
    result = await input.run();
    state = await input.readState();
    const phase = publicRailwayMaintenancePhase(result.outcome === "complete" ? "complete" : result.phase, state ?? undefined);
    if (result.outcome === "pending" && phase !== lastReportedPhase) {
      input.reportPhase(phase);
      lastReportedPhase = phase;
    }
    if (result.outcome !== "pending" || state === null || state.revision <= beforeRevision) break;
  } while (!input.interrupted());
  return { result, state };
}

async function executeRailwayMaintenanceCommand(
  input: RailwayMaintenanceCommandInput,
  dependencies: HostPlanDependencies,
): Promise<boolean> {
  const nautiloRoot = resolveNautiloRootDir({ env: dependencies.environment });
  const railwayRoot = join(nautiloRoot, "hosting", "railway");
  const maintenanceRoot = join(railwayRoot, "maintenance");
  let maintenance: readonly RailwayMaintenanceState[];
  let launches: readonly { readonly launchId: string; readonly state: RailwayDeploymentDriverState }[];
  try {
    launches = await discoverRailwayLaunchStates({ root: railwayRoot, validate: parseRailwayDeploymentDriverState,
      identity: (state) => state.launchId });
    maintenance = latestRailwayMaintenanceStates((await discoverRailwayMaintenanceStates(maintenanceRoot))
      .filter((state) => !railwayMaintenanceProjectionComplete(state, launches)
        && !railwayFailedMaintenanceCleanupComplete(state)));
  } catch {
    dependencies.writeStderr("Saved Railway maintenance state is unreadable or unsafe.\n"); process.exitCode = 2; return true;
  }
  const exactMaintenance = input.launchId === undefined ? maintenance : maintenance.filter((state) => state.sourceLaunchId === input.launchId);
  if (input.operation === "resume" && exactMaintenance.length === 0) return false;
  if (exactMaintenance.length > 1) {
    dependencies.writeStderr("More than one unfinished Railway maintenance operation is eligible; specify its source launch.\n"); process.exitCode = 2; return true;
  }
  let selectedMaintenance = exactMaintenance[0];
  const selectedMaintenanceSourceLaunchId = selectedMaintenance?.sourceLaunchId;
  const eligibleLaunches = launches.filter(({ state }) => state.destroy === undefined && (state.lifecycle?.state === "active"
    || (state.lifecycle === undefined && state.reconcile.receipt.stage === "claimable")));
  const selected = selectedMaintenanceSourceLaunchId === undefined
    ? (input.launchId === undefined ? eligibleLaunches : eligibleLaunches.filter(({ launchId }) => launchId === input.launchId))
    : launches.filter(({ launchId }) => launchId === selectedMaintenanceSourceLaunchId);
  if (selected.length !== 1) {
    dependencies.writeStderr(selected.length === 0 ? "No eligible saved Railway server exists for maintenance.\n"
      : "More than one saved Railway server is eligible; specify --launch.\n"); process.exitCode = 2; return true;
  }
  if (!input.confirmed) {
    const output = { schemaVersion: 1, operation: input.operation, backend: "railway", outcome: "unconfirmed", phase: "confirmation" } as const;
    (input.json ? dependencies.writeStdout : dependencies.writeStderr)(input.json ? `${JSON.stringify(output)}\n`
      : "Railway maintenance is ready for confirmation. Re-run with --yes after reviewing the target release and recovery custody.\n");
    process.exitCode = 1; return true;
  }
  if (input.discardReplacement === true && input.discardConfirmed !== true) {
    dependencies.writeStderr("Discarding the retained Railway replacement requires --discard-replacement --yes. Ordinary resume never deletes it.\n");
    process.exitCode = 1; return true;
  }
  if (input.recoveryConfigPath === undefined) {
    dependencies.writeStderr("Railway maintenance requires the explicit protected recovery configuration.\n"); process.exitCode = 2; return true;
  }
  const recovery = await resolveRailwayRecoveryConfig({ recoveryConfigPath: input.recoveryConfigPath, environment: dependencies.environment });
  if (recovery.outcome === "failure") {
    dependencies.writeStderr("Railway recovery custody is unavailable or invalid.\n"); process.exitCode = 2; return true;
  }
  if (selectedMaintenance !== undefined) {
    try {
      verifyRailwayMaintenanceRecoveryBinding({ state: selectedMaintenance, recoveryConfig: recovery.config,
        authorityGenerationId: recovery.authorityGenerationId });
    } catch {
      dependencies.writeStderr("Saved Railway maintenance recovery binding is invalid.\n"); process.exitCode = 2; return true;
    }
  }
  if (input.discardReplacement === true) {
    if (input.operation !== "resume" || selectedMaintenance === undefined) {
      dependencies.writeStderr("No retained Railway replacement is available to discard.\n"); process.exitCode = 2; return true;
    }
    try {
      selectedMaintenance = await authorizeRailwayRestoreTargetDiscard({ stateRoot: maintenanceRoot,
        statePath: join(maintenanceRoot, selectedMaintenance.maintenanceId), operationId: selectedMaintenance.maintenanceId,
        now: () => new Date().toISOString() });
    } catch {
      dependencies.writeStderr("The retained Railway replacement cannot be authorized for discard.\n"); process.exitCode = 2; return true;
    }
    const authorization = await dependencies.acquireRailwayAuthorization({ interactive: !input.json && interactiveTerminal(dependencies) });
    if (authorization.outcome !== "authorized" || authorization.authorization.mutationScope !== "qualified") {
      dependencies.writeStderr("Railway authorization must be restored before failed replacement cleanup.\n"); process.exitCode = 2; return true;
    }
    const targetCustody = selectedMaintenance.restoreTargetState ?? selectedMaintenance.restoreTargetPreparation;
    if (targetCustody === undefined) {
      dependencies.writeStderr("Saved Railway replacement custody is invalid.\n"); process.exitCode = 2; return true;
    }
    const targetReceipt = targetCustody.reconcile.receipt;
    const project = targetReceipt.resources.filter((resource) => resource.kind === "railway.project");
    const environment = targetReceipt.resources.filter((resource) => resource.kind === "railway.environment");
    if (project.length !== 1 || environment.length !== 1) {
      dependencies.writeStderr("Saved Railway replacement custody is invalid.\n"); process.exitCode = 2; return true;
    }
    const result = await cleanupAuthorizedRailwayRestoreTarget({ stateRoot: maintenanceRoot,
      statePath: join(maintenanceRoot, selectedMaintenance.maintenanceId), operationId: selectedMaintenance.maintenanceId,
      executor: new RailwayGraphqlDestroyExecutor({ transport: authorization.transport,
        workspaceId: targetCustody.target.workspaceId, environmentId: environment[0]!.id }),
      poll: { maxAttempts: 60, beforeAttempt: () => (dependencies.hostProgressScheduler ?? defaultHostProgressScheduler).sleep(1_000) },
      now: () => new Date().toISOString() });
    const outcome = result.outcome === "complete" ? "recovery-ready" : result.outcome === "pending" ? "cleanup-pending" : "cleanup-blocked";
    const output = { schemaVersion: 1, operation: input.operation, backend: "railway", outcome, phase: "cleaning-up" } as const;
    dependencies.writeStdout(input.json ? `${JSON.stringify(output)}\n` : result.outcome === "complete"
      ? "The failed Railway replacement was removed safely. Run the upgrade command again to start a fresh protected attempt.\n"
      : result.outcome === "pending" ? "Railway is still removing the failed replacement. Run resume again.\n"
        : "Failed replacement cleanup stopped because exact receipt custody could not be proven.\n");
    process.exitCode = result.outcome === "failure" ? 2 : 1;
    return true;
  }
  if (selectedMaintenance?.restoreTargetDisposition !== undefined) {
    dependencies.writeStderr("This Railway replacement is retained under an explicit discard decision. Re-run resume with --discard-replacement --yes to continue its receipt-verified cleanup.\n");
    process.exitCode = 1; return true;
  }
  let targetTopology = selectedMaintenance?.targetTopology;
  if (targetTopology === undefined) {
    const release = await dependencies.resolveRailwayRelease().catch(() => ({ state: "invalid" } as const));
    if (release.state !== "verified") {
      dependencies.writeStderr("The target Railway release is unavailable.\n"); process.exitCode = 2; return true;
    }
    const topology = buildRailwayTopology(release.manifest);
    if (!topology.ok) { dependencies.writeStderr("The target Railway release cannot be deployed.\n"); process.exitCode = 2; return true; }
    targetTopology = topology.topology;
  }
  const source = selected[0]!.state;
  let launchSecrets: KeyringRailwayLaunchSecretStore | undefined;
  let generatedSecrets;
  let bootstrapOutput;
  const custodyProjection = railwayMaintenanceCustodyProjection(selectedMaintenance);
  try {
    launchSecrets = await railwayLaunchSecretStore(dependencies, source.launchId);
    try {
      generatedSecrets = await launchSecrets.load({ launchId: source.launchId, releaseId: source.releaseId });
      if (generatedSecrets !== undefined) bootstrapOutput = await launchSecrets.loadBootstrapOutputs(railwayBootstrapOutputBinding(source));
    } catch {
      if (custodyProjection?.launchId !== source.launchId) throw new Error("missing generated custody");
      generatedSecrets = await launchSecrets.load({ launchId: source.launchId, releaseId: custodyProjection.releaseId });
      if (generatedSecrets !== undefined) bootstrapOutput = await launchSecrets.loadBootstrapOutputs(railwayBootstrapOutputBinding(custodyProjection));
    }
    if (generatedSecrets === undefined) throw new Error("missing generated custody");
  } catch { generatedSecrets = undefined; bootstrapOutput = undefined; }
  if (generatedSecrets === undefined || launchSecrets === undefined) {
    dependencies.writeStderr("The original Railway launch custody is unavailable.\n"); process.exitCode = 2; return true;
  }
  if (bootstrapOutput === undefined) {
    dependencies.writeStderr("This legacy launch has no retained Logto bootstrap-output custody. Upgrade requires credential migration or a replacement deployment before any maintenance mutation can start.\n");
    process.exitCode = 2;
    return true;
  }
  let externalProviderSecrets = new Map<string, string>();
  let sourceProviderStore: KeyringRailwayProviderCustodyStore | undefined;
  if (source.providers.length > 0) {
    try {
      sourceProviderStore = await providerCustodyStore(dependencies, source.launchId);
      let retained;
      try { retained = await sourceProviderStore.load({ launchId: source.launchId, releaseId: source.releaseId }); }
      catch {
        if (custodyProjection?.launchId !== source.launchId) throw new Error("missing provider custody");
        retained = await sourceProviderStore.load({ launchId: source.launchId, releaseId: custodyProjection.releaseId });
      }
      if (retained === undefined && input.providerConfigPath !== undefined) {
        const supplied = await discoverProviderSecrets(dependencies.environment, new Set(source.providers), input.providerConfigPath);
        if (supplied.outcome === "failure") throw new Error("invalid provider recovery");
        const candidate = custodyFromProviderSecrets(supplied.secrets, new Set(source.providers));
        if (candidate === undefined) throw new Error("incomplete provider recovery");
        retained = await sourceProviderStore.writeOrConfirm({ launchId: source.launchId, releaseId: source.releaseId, providers: candidate });
      }
      if (retained === undefined || !providerCustodyHasExactly(retained, source.providers)) throw new Error("missing provider custody");
      externalProviderSecrets = externalProviderSecretsFromCustody(retained);
    } catch { dependencies.writeStderr("The exact provider custody is unavailable; supply the protected provider recovery configuration.\n"); process.exitCode = 2; return true; }
  }
  const bootstrapOutputs = new Map(Object.entries(bootstrapOutput ?? {})) as RailwayVariableProjectionInputs["bootstrapOutputs"];
  const operationId = selectedMaintenance?.maintenanceId ?? randomUUID();
  let result: RailwayHostMaintenanceResult;
  let observedState: RailwayMaintenanceState | null = selectedMaintenance ?? null;
  if (selectedMaintenance?.maintenanceReceipt.stage === "complete" && selectedMaintenance.activeLaunch !== undefined) {
    result = { outcome: "complete", active: selectedMaintenance.activeLaunch.kind };
  } else {
    const authorization = await dependencies.acquireRailwayAuthorization({ interactive: !input.json && interactiveTerminal(dependencies) });
    if (authorization.outcome !== "authorized" || authorization.authorization.mutationScope !== "qualified") {
      dependencies.writeStderr("Railway authorization must be restored before maintenance.\n"); process.exitCode = 2; return true;
    }
    const interruption = dependencies.createHostInterruptController?.() ?? createScopedHostInterruptController(process);
    try {
      if (interruption.interrupted()) {
        dependencies.writeStderr("Railway maintenance was interrupted before the next durable phase. Resume the exact operation.\n");
        process.exitCode = 130;
        return true;
      }
      const advanced = await advanceRailwayMaintenanceUntilBlocked({
        initialState: observedState,
        run: () => runRailwayHostMaintenance({ stateRoot: maintenanceRoot, source, targetTopology,
          projectionInputs: { generatedSecrets, generatedPublicDomains: new Map(), bootstrapOutputs, externalProviderSecrets },
          recoveryConfig: recovery.config, authorityGenerationId: recovery.authorityGenerationId, transport: authorization.transport,
          backupNames: { "application-postgres": `${operationId} application database`, "logto-postgres": `${operationId} identity database`,
            "server-volume": `${operationId} server data` }, confirmed: true, operationId, now: () => new Date().toISOString(), fetch: dependencies.fetch,
          wait: async (milliseconds) => {
            if (interruption.interrupted()) throw new Error("Railway maintenance interrupted");
            await (dependencies.hostProgressScheduler ?? defaultHostProgressScheduler).sleep(milliseconds);
            if (interruption.interrupted()) throw new Error("Railway maintenance interrupted");
          }, interrupted: interruption.interrupted, signal: interruption.signal }),
        readState: () => readRailwayMaintenanceState(maintenanceRoot, join(maintenanceRoot, operationId)),
        reportPhase: (phase) => { if (!input.json) dependencies.writeStderr(`Railway maintenance: ${phase}\n`); },
        interrupted: interruption.interrupted,
      });
      result = advanced.result;
      observedState = advanced.state;
    } catch {
      if (interruption.interrupted()) {
        dependencies.writeStderr("Railway maintenance was interrupted after its last durable checkpoint. Resume the exact operation.\n");
        process.exitCode = 130;
        return true;
      }
      dependencies.writeStderr("Railway maintenance could not safely continue.\n"); process.exitCode = 2; return true;
    } finally {
      interruption.dispose();
    }
    if (interruption.interrupted()) {
      dependencies.writeStderr("Railway maintenance was interrupted after its last durable checkpoint. Resume the exact operation.\n");
      process.exitCode = 130;
      return true;
    }
  }
  if (result.outcome === "complete") {
    const finalState = observedState ?? await readRailwayMaintenanceState(maintenanceRoot, join(maintenanceRoot, operationId));
    if (finalState === null || finalState.activeLaunch === undefined) throw new Error("Railway maintenance promotion failed");
    const now = new Date().toISOString();
    const custodySource = custodyProjection?.launchId === source.launchId ? custodyProjection : source;
    if (finalState.activeLaunch.kind === "source") {
      const active = { ...finalState.postUpgradeSourceState!, lifecycle: { state: "active" as const, updatedAt: now, maintenanceId: operationId } };
      await launchSecrets.promoteTo({ source: railwayBootstrapOutputBinding(custodySource), target: railwayBootstrapOutputBinding(active), targetStore: launchSecrets });
      await sourceProviderStore?.promoteTo({ source: { launchId: custodySource.launchId, releaseId: custodySource.releaseId },
        target: { launchId: active.launchId, releaseId: active.releaseId }, targetStore: sourceProviderStore });
      await railwayStateStore(dependencies.environment, active.launchId).write(active);
    } else {
      const restoredBootstrap = finalState.restoredLogtoBootstrap?.lifecycle;
      const active = { ...finalState.restoreTargetState!, logtoBootstrap: restoredBootstrap,
        lifecycle: { state: "active" as const, updatedAt: now, maintenanceId: operationId } };
      const projectId = active.reconcile.receipt.resources.find(({ kind }) => kind === "railway.project")?.id;
      const environmentId = active.reconcile.receipt.resources.find(({ kind }) => kind === "railway.environment")?.id;
      if (projectId === undefined || environmentId === undefined || restoredBootstrap?.serviceId === undefined
        || restoredBootstrap.handoffDomainId === undefined) throw new Error("Railway maintenance promotion failed");
      const targetBinding = { launchId: active.launchId, releaseId: active.releaseId, projectId, environmentId,
        serviceId: restoredBootstrap.serviceId, domainId: restoredBootstrap.handoffDomainId };
      const targetSecrets = await railwayLaunchSecretStore(dependencies, active.launchId);
      await launchSecrets.promoteTo({ source: railwayBootstrapOutputBinding(custodySource), target: targetBinding, targetStore: targetSecrets });
      if (sourceProviderStore !== undefined) {
        const targetProviders = await providerCustodyStore(dependencies, active.launchId);
        await sourceProviderStore.promoteTo({ source: { launchId: custodySource.launchId, releaseId: custodySource.releaseId },
          target: { launchId: active.launchId, releaseId: active.releaseId }, targetStore: targetProviders });
      }
      await railwayStateStore(dependencies.environment, active.launchId).write(active);
      if (finalState.sourceTeardown === undefined) throw new Error("Railway maintenance promotion failed");
      await railwayStateStore(dependencies.environment, source.launchId).write({ ...source,
        reconcile: { receipt: finalState.sourceTeardown.receipt }, destroy: finalState.sourceTeardown,
        lifecycle: { state: "superseded", updatedAt: now, supersededByLaunchId: active.launchId, maintenanceId: operationId } });
    }
  }
  const output = { schemaVersion: 1, operation: input.operation, backend: "railway", outcome: result.outcome,
    phase: result.outcome === "complete" ? "complete" : publicRailwayMaintenancePhase(result.phase, observedState ?? undefined) } as const;
  dependencies.writeStdout(input.json ? `${JSON.stringify(output)}\n`
    : `Nautilo Railway maintenance: ${result.outcome}\nPhase: ${output.phase}\n`);
  process.exitCode = result.outcome === "complete" ? 0 : result.outcome === "pending" ? 1 : 2;
  externalProviderSecrets.clear();
  return true;
}

async function discoverSingleRailwayDeployResumeLaunch(dependencies: HostPlanDependencies): Promise<string | undefined> {
  const railwayRoot = join(resolveNautiloRootDir({ env: dependencies.environment }), "hosting", "railway");
  const launches = await discoverRailwayLaunchStates({ root: railwayRoot, validate: parseRailwayDeploymentDriverState,
    identity: (state) => state.launchId });
  const eligible = launches.filter(({ state }) => state.destroy === undefined
    && (state.lifecycle === undefined || state.lifecycle.state === "owner-bound"));
  return eligible.length === 1 ? eligible[0]!.launchId : undefined;
}

async function executeRailwayHostDestroy(
  input: RailwayDestroyInput,
  dependencies: HostPlanDependencies,
): Promise<void> {
  if (!isRailwayLaunchSelector(input.launchId)) {
    dependencies.writeStderr("Railway destroy requires the exact saved launch selector.\n");
    process.exitCode = 2;
    return;
  }
  const stateStore = railwayStateStore(dependencies.environment, input.launchId);
  let state: RailwayDeploymentDriverState | undefined;
  try {
    state = await stateStore.read();
  } catch {
    state = undefined;
  }
  if (state === undefined) {
    dependencies.writeStderr("No safe Railway launch checkpoint exists for that launch UUID.\n");
    process.exitCode = 2;
    return;
  }
  const project = state.reconcile.receipt.resources.find((resource) => resource.kind === "railway.project");
  const environment = state.reconcile.receipt.resources.find((resource) => resource.kind === "railway.environment");
  if (project === undefined || environment === undefined || input.confirmProjectId !== project.id) {
    dependencies.writeStderr("Destroy confirmation must exactly match the Railway project ID in the launch receipt.\n");
    process.exitCode = 2;
    return;
  }
  const authorization = await dependencies.acquireRailwayAuthorization({
    interactive: input.interactiveAuthorization,
  });
  if (authorization.outcome !== "authorized" || authorization.authorization.mutationScope !== "qualified") {
    dependencies.writeStderr("Railway authorization must be restored before exact receipt teardown.\n");
    process.exitCode = 2;
    return;
  }
  const executor = new RailwayGraphqlDestroyExecutor({
    transport: authorization.transport,
    workspaceId: state.target.workspaceId,
    environmentId: environment.id,
  });
  const cleanupReceipt = mergeRailwayBootstrapCleanupResources(
    state.destroy?.receipt ?? state.reconcile.receipt,
    state,
  );
  const checkpoint = state.destroy === undefined ? {
    schemaVersion: 1 as const,
    receipt: cleanupReceipt,
    stage: "validate" as const,
  } : { ...state.destroy, receipt: cleanupReceipt };
  const result = await destroyRailwayDeployment({
    checkpoint,
    confirmProjectId: input.confirmProjectId,
    executor,
    now: () => new Date().toISOString(),
    poll: {
      // Railway project deletion is eventually consistent. Live qualification
      // observed the workspace inventory converge only after the former 30-second
      // window, so keep one bounded minute before returning pending.
      maxAttempts: 60,
      beforeAttempt: () => new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
    },
    persistCheckpoint: async (destroy) => {
      if (state === undefined) throw new Error("Railway destroy state was lost");
      const { lifecycle: _lifecycle, ...withoutLifecycle } = state;
      state = parseRailwayDeploymentDriverState({
        ...withoutLifecycle,
        destroy,
        reconcile: { receipt: destroy.receipt },
      });
      await stateStore.write(state);
    },
  });
  if (state === undefined) throw new Error("Railway destroy state was lost");
  const { lifecycle: _lifecycle, ...withoutLifecycle } = state;
  state = parseRailwayDeploymentDriverState({
    ...withoutLifecycle,
    destroy: result.checkpoint,
    reconcile: { receipt: result.checkpoint.receipt },
  });
  let localCustodyCleanup: "complete" | "failed" | undefined;
  if (result.outcome === "complete") {
    state = parseRailwayDeploymentDriverState({ ...state, lifecycle: { state: "destroyed", updatedAt: new Date().toISOString() } });
    await stateStore.write(state);
    const completedLaunchId = state.launchId;
    const { cleanupFailed } = await clearRailwayLaunchCustody({
      clearGenerated: async () => {
        await (await railwayLaunchSecretStore(dependencies, completedLaunchId)).clear();
      },
      clearProviders: async () => (await providerCustodyStore(dependencies, completedLaunchId)).clear(),
      clearOwnerClaim: async () => (await railwayOwnerClaimStore(dependencies, completedLaunchId)).clear(),
    });
    localCustodyCleanup = cleanupFailed ? "failed" : "complete";
    if (cleanupFailed) {
      dependencies.writeStderr("Railway resources are gone, but local keyring cleanup needs manual attention.\n");
    }
  }
  const output = {
    schemaVersion: 1,
    operation: "destroy",
    backend: "railway",
    outcome: result.outcome,
    launchId: state.launchId,
    cleanup: result.checkpoint.receipt.cleanup,
    remainingResources: result.checkpoint.receipt.resources,
    ...(localCustodyCleanup === undefined ? {} : { localCustodyCleanup }),
  } as const;
  dependencies.writeStdout(input.json
    ? `${JSON.stringify(output, null, 2)}\n`
    : `Nautilo Railway destroy: ${result.outcome}\nLaunch: ${state.launchId}\nCleanup: ${result.checkpoint.receipt.cleanup.state}${localCustodyCleanup === undefined ? "" : `\nLocal custody: ${localCustodyCleanup}`}\n`);
  process.exitCode = result.outcome === "complete" ? 0 : 1;
}

const defaultDependencies: HostPlanDependencies = {
  acquireRailwayAuthorization: async ({ interactive }) => {
    const configuredClientId = process.env["NAUTILO_RAILWAY_OAUTH_CLIENT_ID"]?.trim();
    let credentialStore: KeyringRailwayOAuthCredentialStore | undefined;
    if (process.env["NAUTILO_RAILWAY_OAUTH_PERSISTENCE"] !== "memory") {
      try {
        const { AsyncEntry } = await import("@napi-rs/keyring");
        credentialStore = new KeyringRailwayOAuthCredentialStore(
          new AsyncEntry(RAILWAY_OAUTH_KEYRING_SERVICE, RAILWAY_OAUTH_KEYRING_ACCOUNT),
          join(resolveNautiloRootDir({ env: process.env }), "auth", "railway-oauth.lock"),
        );
      } catch {
        return {
          outcome: "authorization-required",
          failure: {
            kind: "credential-store-failed",
            repair: "repair-credential-store",
          },
        };
      }
    }
    const result = await authorizeRailwayOAuth({
      // The public Nautilo CLI client ships in every build. This override is a
      // development/test seam and never accepts a client secret.
      clientId: configuredClientId === undefined || configuredClientId.length === 0
        ? RAILWAY_OAUTH_CLIENT_ID
        : configuredClientId,
      interactive,
      openBrowser: openUrlInDefaultBrowserChecked,
      ...(credentialStore === undefined ? {} : { credentialStore }),
    });
    if (result.outcome === "failure") {
      return { outcome: "authorization-required", failure: result.failure };
    }
    return {
      outcome: "authorized",
      transport: result.transport,
      authorization: { kind: "railway-oauth", mutationScope: "qualified" },
    };
  },
  resolveRailwayRelease: (retainedManifest) => resolveRailwayRelease(process.env, {}, retainedManifest),
  environment: process.env,
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

export function createHostModule(
  dependencies: HostPlanDependencies = defaultDependencies,
): CommandModule {
  const adoptModule: CommandModule = {
    command: "adopt",
    describe: "Verify or adopt one held Railway template deployment",
    builder: (yargs) => yargs
      .option("provider-config", {
        type: "string",
        describe: "Protected provider TOML; apply supplied keys during confirmed adoption",
      })
      .option("backend", {
        type: "string",
        choices: ["railway"] as const,
        demandOption: true,
        describe: "Hosting backend to inspect",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print deterministic redacted JSON and never prompt",
      })
      .option("yes", {
        type: "boolean",
        default: false,
        describe: "Confirm adoption after the read-only verification passes",
      })
      .option("progress", {
        type: "string",
        choices: ["auto", "plain", "jsonl", "none"] as const,
        default: "auto",
        describe: "Progress on stderr: auto (TTY/plain), plain, JSONL, or none",
      })
      .option("finish", {
        type: "string",
        choices: ["guide", "product"] as const,
        default: "guide",
        describe: "Finish first-owner setup in the server guide or Nautilo product",
      })
      .option("open-browser", {
        type: "boolean",
        describe: "Open first-owner setup (defaults on for interactive terminals)",
      })
      .example("$0 host adopt --backend railway", "Find and verify the one held Nautilo project; never change Railway.")
      .example("$0 host adopt --backend railway \\\n  --yes", "")
      .epilogue("Run without --yes to verify only. With --yes, adopt that exact held project and stay attached through first-owner setup using the existing resumable Railway lifecycle. Do not copy provider IDs."),
    handler: async (argv) => executeRailwayHostAdoptAudit({
      json: argv["json"] === true,
      ...(typeof argv["provider-config"] === "string" ? { providerConfigPath: argv["provider-config"] } : {}),
      interactiveAuthorization: argv["json"] !== true && interactiveTerminal(dependencies),
      confirmed: argv["yes"] === true,
      progress: argv["progress"] as HostProgressMode,
      finish: parseServerFinishMode(argv["finish"]),
      openBrowser: argv["json"] !== true && (
        argv["open-browser"] === true || (argv["open-browser"] !== false && interactiveTerminal(dependencies))
      ),
    }, dependencies),
  };

  const planModule: CommandModule = {
    command: "plan",
    describe: "Build a read-only hosting plan; never create or change resources",
    builder: (yargs) => yargs
      .option("backend", {
        type: "string",
        choices: ["railway"] as const,
        demandOption: true,
        describe: "Hosting backend to inspect",
      })
      .option("workspace", {
        type: "string",
        describe: "Railway workspace you selected (required when more than one is visible)",
      })
      .option("project-name", {
        type: "string",
        describe: "Name for the new Railway project (defaults to nautilo)",
      })
      .option("provider-config", {
        type: "string",
        describe: "Provider-only TOML input; values and its path are never persisted or printed",
      })
      .option("all-providers", {
        type: "boolean",
        default: false,
        describe: "Select every recognized credential in documented config or the environment",
      })
      .option("include-provider", {
        type: "string",
        array: true,
        describe: "Select one provider by slug; repeat for additional providers",
      })
      .option("exclude-provider", {
        type: "string",
        array: true,
        describe: "Exclude one provider by slug; repeat for additional providers",
      })
      .option("allow-core-degraded", {
        type: "boolean",
        default: false,
        describe: "Explicitly consent to planning with unresolved core capabilities",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print deterministic JSON and never prompt",
      })
      .example("$0 host plan --backend railway", "Review the Railway deployment plan before creating anything.")
      .epilogue("Railway guide: https://nautilo.ai/docs/operator/deploy/railway"),
    handler: async (argv) => {
      const workspace = typeof argv["workspace"] === "string"
        ? argv["workspace"].trim()
        : "";
      const providerConfigPath = typeof argv["provider-config"] === "string"
        ? argv["provider-config"]
        : undefined;
      const json = argv["json"] === true;
      const projectName = resolveRailwayProjectName(argv["project-name"]);
      if (projectName.outcome === "failure") {
        writeHostPlanInputFailure(projectName.error, json, dependencies);
        return;
      }
      const providers = await resolveProviderCliInput({
        ...(providerConfigPath === undefined ? {} : { providerConfigPath }),
        allProviders: argv["all-providers"] === true,
        includeProviders: strings(argv["include-provider"]),
        excludeProviders: strings(argv["exclude-provider"]),
        allowCoreDegraded: argv["allow-core-degraded"] === true,
      }, dependencies, !json && interactiveTerminal(dependencies));
      if (providers.outcome === "cancelled") {
        writeProviderPromptCancelled(dependencies);
        return;
      }
      const execution = await executeRailwayHostPlan({
        ...(workspace.length === 0 ? {} : { workspaceId: workspace }),
        ...(projectName.projectName === undefined ? {} : { projectName: projectName.projectName }),
        ...providers.input,
        interactiveAuthorization:
          !json && interactiveTerminal(dependencies),
      }, dependencies);

      if (execution.outcome !== "planned") {
        if (json) {
          dependencies.writeStdout(`${JSON.stringify(execution.error, null, 2)}\n`);
        } else {
          dependencies.writeStderr(
            execution.outcome === "authorization-required"
              ? renderAuthorizationRequiredTty(execution.error)
              : renderHostPlanInputFailureTty(execution.error),
          );
        }
        process.exitCode = 2;
        return;
      }

      dependencies.writeStdout(
        json
          ? `${JSON.stringify(execution.plan, null, 2)}\n`
          : renderRailwayPlanTty(execution.plan),
      );
      process.exitCode = execution.plan.outcome === "blocked" ? 1 : 0;
    },
  };

  const deployModule: CommandModule = {
    command: "deploy",
    describe: "Deploy a verified Nautilo release into the Railway workspace you selected",
    builder: (yargs) => yargs
      .option("backend", {
        type: "string",
        choices: ["railway"] as const,
        demandOption: true,
      })
      .option("workspace", {
        type: "string",
        describe: "Railway workspace you selected",
      })
      .option("project-name", {
        type: "string",
        describe: "Name for the new Railway project (defaults to nautilo)",
      })
      .option("provider-config", {
        type: "string",
        describe: "Provider-only TOML input; values and its path are never persisted or printed",
      })
      .option("all-providers", {
        type: "boolean",
        default: false,
        describe: "Deploy every supported provider credential already present in documented config",
      })
      .option("include-provider", {
        type: "string",
        array: true,
        describe: "Deploy one supported provider credential; repeat for additional providers",
      })
      .option("exclude-provider", {
        type: "string",
        array: true,
        describe: "Exclude one supported provider credential; repeat for additional providers",
      })
      .option("allow-core-degraded", {
        type: "boolean",
        default: false,
        describe: "Consent to deployment without a baseline chat/embedding provider",
      })
      .option("yes", {
        type: "boolean",
        default: false,
        describe: "Confirm the reviewed customer-paid Railway mutation",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print deterministic JSON and never prompt",
      })
      .option("progress", {
        type: "string",
        choices: ["auto", "plain", "jsonl", "none"] as const,
        default: "auto",
        describe: "Progress on stderr: auto (TTY/plain), plain, JSONL, or none",
      })
      .option("finish", {
        type: "string",
        choices: ["guide", "product"] as const,
        default: "guide",
        describe: "Finish first-owner setup in the server guide or Nautilo product",
      })
      .option("open-browser", {
        type: "boolean",
        describe: "Open first-owner setup (defaults on for interactive terminals)",
      })
      .example("$0 host deploy --backend railway --yes", "")
      .epilogue("If this deployment needs recovery, it prints the exact `nautilo host resume` command. Run that command; do not start a second deployment. Guide: https://nautilo.ai/docs/operator/deploy/railway"),
    handler: async (argv) => {
      const workspace = typeof argv["workspace"] === "string" ? argv["workspace"].trim() : "";
      const providerConfigPath = typeof argv["provider-config"] === "string"
        ? argv["provider-config"]
        : undefined;
      const json = argv["json"] === true;
      const projectName = resolveRailwayProjectName(argv["project-name"]);
      if (projectName.outcome === "failure") {
        writeHostPlanInputFailure(projectName.error, json, dependencies);
        return;
      }
      const finish = parseServerFinishMode(argv["finish"]);
      const providers = await resolveProviderCliInput({
        ...(providerConfigPath === undefined ? {} : { providerConfigPath }),
        allProviders: argv["all-providers"] === true,
        includeProviders: strings(argv["include-provider"]),
        excludeProviders: strings(argv["exclude-provider"]),
        allowCoreDegraded: argv["allow-core-degraded"] === true,
      }, dependencies, !json && interactiveTerminal(dependencies));
      if (providers.outcome === "cancelled") {
        writeProviderPromptCancelled(dependencies);
        return;
      }
      await executeRailwayHostDeploy({
        ...(workspace.length === 0 ? {} : { workspaceId: workspace }),
        ...(projectName.projectName === undefined ? {} : { projectName: projectName.projectName }),
        ...providers.input,
        interactiveAuthorization:
          !json && interactiveTerminal(dependencies),
        confirmed: argv["yes"] === true,
        json,
        progress: argv["progress"] as HostProgressMode,
        finish,
        openBrowser: !json && (
          argv["open-browser"] === true ||
          (argv["open-browser"] !== false && interactiveTerminal(dependencies))
        ),
      }, dependencies);
    },
  };

  const resumeModule: CommandModule = {
    command: "resume",
    describe: "Resume the one eligible Railway deployment or maintenance operation",
    builder: (yargs) => yargs
      .option("backend", {
        type: "string",
        choices: ["railway"] as const,
        demandOption: true,
      })
      .option("launch", {
        type: "string",
        describe: "Exact saved launch; unfinished maintenance takes precedence",
      })
      .option("recovery-config", {
        type: "string",
        describe: "Protected recovery configuration; its path and contents are never printed or persisted",
      })
      .option("provider-config", {
        type: "string",
        describe: "Provider-only TOML input; values and its path are never persisted or printed",
      })
      .option("discard-replacement", {
        type: "boolean",
        default: false,
        describe: "Explicitly abandon the retained replacement; requires --yes and exact receipt custody",
      })
      .option("yes", {
        type: "boolean",
        default: false,
        describe: "Confirm the explicit replacement discard; ordinary resume needs no confirmation",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print deterministic JSON and never prompt",
      })
      .option("progress", {
        type: "string",
        choices: ["auto", "plain", "jsonl", "none"] as const,
        default: "auto",
        describe: "Progress on stderr: auto (TTY/plain), plain, JSONL, or none",
      })
      .option("finish", {
        type: "string",
        choices: ["guide", "product"] as const,
        default: "guide",
        describe: "Finish first-owner setup in the server guide or Nautilo product",
      })
      .option("open-browser", {
        type: "boolean",
        describe: "Open first-owner setup (defaults on for interactive terminals)",
      })
      .example("$0 host resume --backend railway --recovery-config <absolute-path>", "")
      .epilogue("The command stays attached while safe checkpoints advance. Ordinary resume never deletes a retained replacement. Use --launch only when discovery is ambiguous."),
    handler: async (argv) => {
      const json = argv["json"] === true;
      let launchId = typeof argv["launch"] === "string" ? argv["launch"].trim() : undefined;
      if (await executeRailwayMaintenanceCommand({ operation: "resume", launchId,
        ...(typeof argv["recovery-config"] === "string" ? { recoveryConfigPath: argv["recovery-config"] } : {}),
        ...(typeof argv["provider-config"] === "string" ? { providerConfigPath: argv["provider-config"] } : {}),
        confirmed: true, discardReplacement: argv["discard-replacement"] === true,
        discardConfirmed: argv["yes"] === true, json }, dependencies)) return;
      if (launchId === undefined) {
        try { launchId = await discoverSingleRailwayDeployResumeLaunch(dependencies); } catch { launchId = undefined; }
        if (launchId === undefined) {
          dependencies.writeStderr("No single unfinished Railway operation can be resumed; specify --launch.\n"); process.exitCode = 2; return;
        }
      }
      await executeRailwayHostResume({
        launchId,
        ...(typeof argv["provider-config"] === "string"
          ? { providerConfigPath: argv["provider-config"] }
          : {}),
        json,
        progress: argv["progress"] as HostProgressMode,
        finish: parseServerFinishMode(argv["finish"]),
        openBrowser: !json && (
          argv["open-browser"] === true ||
          (argv["open-browser"] !== false && interactiveTerminal(dependencies))
        ),
        interactiveAuthorization: !json && interactiveTerminal(dependencies),
      }, dependencies);
    },
  };

  const upgradeModule: CommandModule = {
    command: "upgrade",
    describe: "Upgrade one saved active Railway server with portable recovery",
    builder: (yargs) => yargs
      .option("backend", { type: "string", choices: ["railway"] as const, demandOption: true })
      .option("recovery-config", { type: "string", demandOption: true,
        describe: "Protected recovery configuration; its path and contents are never printed or persisted" })
      .option("launch", { type: "string", describe: "Exact saved active launch; omit only when one is eligible" })
      .option("provider-config", { type: "string",
        describe: "Protected provider credential recovery; its path and values are never persisted or printed" })
      .option("yes", { type: "boolean", default: false, describe: "Confirm the reviewed customer-paid maintenance mutation" })
      .option("json", { type: "boolean", default: false, describe: "Print deterministic redacted JSON and never prompt" })
      .example(`$0 host upgrade --backend railway \\
  --recovery-config <absolute-path> --yes`, "")
      .epilogue("The command stays attached while durable checkpoints advance. If it is interrupted or returns pending, continue the same operation with `nautilo host resume`; do not start another upgrade."),
    handler: async (argv) => {
      await executeRailwayMaintenanceCommand({ operation: "upgrade",
        ...(typeof argv["launch"] === "string" ? { launchId: argv["launch"].trim() } : {}),
        ...(typeof argv["provider-config"] === "string" ? { providerConfigPath: argv["provider-config"] } : {}),
        recoveryConfigPath: String(argv["recovery-config"]), confirmed: argv["yes"] === true, json: argv["json"] === true }, dependencies);
    },
  };

  const inspectModule: CommandModule = {
    command: "inspect",
    describe: "Inspect one Railway deployment without changing provider state",
    builder: (yargs) => yargs
      .option("backend", {
        type: "string",
        choices: ["railway"] as const,
        demandOption: true,
      })
      .option("launch", {
        type: "string",
        demandOption: true,
        describe: "Deployment ID printed by host deploy",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print deterministic JSON and never prompt",
      })
      .example("$0 host inspect --backend railway --launch <launch-id>", ""),
    handler: async (argv) => executeRailwayHostInspect({
      launchId: String(argv["launch"]).trim(),
      json: argv["json"] === true,
      interactiveAuthorization:
        argv["json"] !== true && process.stdin.isTTY === true && process.stdout.isTTY === true,
    }, dependencies),
  };

  const destroyModule: CommandModule = {
    command: "destroy",
    describe: "Delete only the Railway resources for one saved deployment",
    builder: (yargs) => yargs
      .option("backend", {
        type: "string",
        choices: ["railway"] as const,
        demandOption: true,
      })
      .option("launch", {
        type: "string",
        demandOption: true,
        describe: "Deployment ID printed by host deploy",
      })
      .option("confirm-project", {
        type: "string",
        demandOption: true,
        describe: "Exact Railway project ID shown for that deployment",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print deterministic JSON and never prompt",
      })
      .example(`$0 host destroy --backend railway --launch <launch-id> \\
  --confirm-project <project-id>`, ""),
    handler: async (argv) => executeRailwayHostDestroy({
      launchId: String(argv["launch"]).trim(),
      confirmProjectId: String(argv["confirm-project"]).trim(),
      json: argv["json"] === true,
      interactiveAuthorization:
        argv["json"] !== true && process.stdin.isTTY === true && process.stdout.isTTY === true,
    }, dependencies),
  };

  return {
    command: "host",
    describe: "Railway hosting commands. Start with `host plan --backend railway`; Compose commands are listed separately in the main help.",
    builder: (yargs) => yargs
      .command(adoptModule)
      .command(planModule)
      .command(deployModule)
      .command(upgradeModule)
      .command(resumeModule)
      .command(inspectModule)
      .command(destroyModule)
      .example("$0 host plan --backend railway", "Start the Railway route with a read-only plan.")
      .epilogue("For Docker Compose, return to the main help and start with `nautilo profile add <name>`. Guide: https://nautilo.ai/docs/operator/deploy/docker-compose")
      .demandCommand(1, "Specify a host subcommand."),
    handler: () => {},
  };
}

export const hostModule = createHostModule();
