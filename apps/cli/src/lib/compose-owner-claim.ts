import type { ComposeDriverProfile } from "@nautilo/compose-driver";
import {
  advanceComposeOwnerStage,
  prepareComposeOwnerStage,
  type ComposeOwnerClaimCustodyPort,
  type PreparedComposeOwnerStage,
} from "@nautilo/compose-lifecycle";
import {
  composeProjectName,
  remoteInstanceRootDir,
  shellQuote,
} from "@nautilo/compose-driver";
import { openUrlInDefaultBrowserChecked } from "@nautilo/cli-auth";
import {
  NautiloApiClient,
  OwnerClaimAmbiguousWriteError,
  OwnerClaimApiError,
  type RedeemInput,
  type RedeemOwnerClaimResponse,
} from "@nautilo/api-client";

import { bootstrapTokenPath, readBootstrapToken } from "./bootstrap-tokens.ts";
import {
  COMPOSE_OWNER_CLAIM_KEYRING_SERVICE,
  composeOwnerClaimControlFingerprint,
  composeOwnerClaimKeyringAccount,
  KeyringComposeOwnerClaimStore,
  type ComposeOwnerClaimIdentity,
} from "./compose-owner-claim-store.ts";
import { resolveOperatorServerUrl } from "./compose-driver-factory.ts";
import {
  createOwnerClaimBrowserHandoff,
  type OwnerClaimBrowserHandoff,
} from "./owner-claim-handoff.ts";
import {
  createOwnerClaimTarget,
  hashOwnerClaim,
  OwnerClaimControllerError,
  type OwnerClaimTarget,
  type OwnerClaimTargetTransportPolicy,
} from "./owner-claim-target.ts";
import {
  buildSshLocalFetch,
  resolveRemoteLoopbackBaseUrl,
} from "./remote-operator-transport.ts";
import {
  resolveServerCompletionDestinations,
  type ServerBrowserOutcome,
  type ServerFinishMode,
} from "./server-completion.ts";
import {
  durabilizeExistingOwnerSeedResult,
  OWNER_SEED_RESULT_SCHEMA,
  publishOwnerSeedResult,
  type OwnerSeedResult,
} from "./owner-seed-result.ts";

// Server accepts at most 15 minutes. Leave one minute for CLI/server skew and
// transport delay instead of submitting at the rejection boundary.
const CLAIM_TTL_MS = 14 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_ATTEMPTS = 180;

export type ComposeOwnerClaimOutcome =
  | "owner-bound"
  | "claim-active"
  | "install-unknown"
  | "target-unavailable"
  | "awaiting-owner"
  | "recovery-required"
  | "interrupted";

export interface ComposeOwnerClaimResult {
  readonly outcome: ComposeOwnerClaimOutcome;
  readonly serverUrl: string;
  readonly browser: ServerBrowserOutcome;
  readonly controllerFailure?: string | undefined;
  readonly ownerResultPath?: string | undefined;
}

export interface PreparedComposeOwnerClaim {
  readonly profileName: string;
  readonly identity: ComposeOwnerClaimIdentity;
  readonly stage: PreparedComposeOwnerStage;
}

const preparedStores = new WeakMap<PreparedComposeOwnerClaim, KeyringComposeOwnerClaimStore>();

function custodyPort(
  store: KeyringComposeOwnerClaimStore,
): ComposeOwnerClaimCustodyPort {
  return {
    getOrCreate: (identity) => store.getOrCreate(identity as ComposeOwnerClaimIdentity),
    rotate: (identity) => store.rotate(identity as ComposeOwnerClaimIdentity),
    clear: () => store.clear(),
  };
}

export interface ComposeOwnerClaimDependencies {
  readonly createStore?: (profileName: string) => Promise<KeyringComposeOwnerClaimStore>;
  readonly createTarget?: (input: {
    readonly transport: OwnerClaimTargetTransportPolicy;
    readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  }) => OwnerClaimTarget;
  readonly createHandoff?: typeof createOwnerClaimBrowserHandoff;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly readBootstrapToken?: (profileName: string, home: string) => string | null;
  readonly resolveServerUrl?: (profile: ComposeDriverProfile, home: string) => string;
  readonly resolveControlPlane?: (profile: ComposeDriverProfile, home: string) => {
    readonly targetUrl: string;
    readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    readonly transport: OwnerClaimTargetTransportPolicy;
  };
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly pollAttempts?: number;
  readonly interrupted?: () => boolean;
  readonly redeemOwner?: (
    serverUrl: string,
    claim: string,
    input: RedeemInput,
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  ) => Promise<RedeemOwnerClaimResponse>;
  readonly publishOwnerResult?: typeof publishOwnerSeedResult;
  readonly durabilizeOwnerResult?: typeof durabilizeExistingOwnerSeedResult;
}

let testDependencies: ComposeOwnerClaimDependencies | undefined;

/** Test-only seam. Production must leave this unset. */
export function setComposeOwnerClaimDependenciesForTests(
  dependencies: ComposeOwnerClaimDependencies | undefined,
): void {
  testDependencies = dependencies;
}

function effectiveDependencies(
  dependencies: ComposeOwnerClaimDependencies,
): ComposeOwnerClaimDependencies {
  return testDependencies === undefined
    ? dependencies
    : { ...testDependencies, ...dependencies };
}

function exactOriginPolicy(expected: string): OwnerClaimTargetTransportPolicy {
  const origin = new URL(expected);
  return {
    validateTargetUrl(value) {
      const parsed = new URL(value);
      if (parsed.origin !== origin.origin || parsed.pathname !== "/"
        || parsed.username !== "" || parsed.password !== ""
        || parsed.search !== "" || parsed.hash !== "") {
        throw new Error("Compose owner claim target is invalid");
      }
      return parsed;
    },
  };
}

function homeDirectory(): string {
  const home = process.env["HOME"]?.trim();
  if (!home) throw new Error("HOME is not set; owner claim custody is unavailable");
  return home;
}

function browserTarget(profile: ComposeDriverProfile, home: string): string {
  if (profile.transport === "remote") {
    if (profile.https !== "letsencrypt" || !profile.domain?.trim()) {
      throw new Error(
        "Hosted owner claim requires a remote Compose profile with https=letsencrypt and an exact domain. Protected config integration is not available in this release; no deployment was started.",
      );
    }
    const parsed = new URL(`https://${profile.domain.trim()}`);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      throw new Error("Remote hosted owner claim requires an exact credential-free HTTPS domain origin");
    }
    return parsed.origin;
  }
  const target = resolveOperatorServerUrl(profile, home);
  const parsed = new URL(target);
  if (parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "[::1]")) {
    throw new Error("Local hosted owner claim requires a loopback HTTP server URL");
  }
  return parsed.origin;
}

function identityFor(
  profile: ComposeDriverProfile,
  seedResultPath?: string,
): ComposeOwnerClaimIdentity {
  if (profile.lifecycle !== "compose") throw new Error("Owner claim requires a Compose lifecycle profile");
  if (profile.transport === "local" && "host" in profile) {
    const explicitHost = (profile as ComposeDriverProfile & { host?: string }).host?.trim();
    if (explicitHost && explicitHost !== "localhost" && explicitHost !== "127.0.0.1" && explicitHost !== "::1") {
      throw new Error("Local hosted owner claim requires a loopback host");
    }
  }
  const instanceId = profile.instance_id ?? "";
  if (profile.transport === "remote" && !profile.ssh) {
    throw new Error("Remote Compose owner claim requires SSH configuration");
  }
  const controlFingerprint = profile.transport === "remote"
    ? composeOwnerClaimControlFingerprint({
        transport: "remote",
        instanceId,
        projectName: composeProjectName(profile),
        sshHost: profile.ssh!.host,
        sshUser: profile.ssh!.user,
        sshPort: profile.ssh!.port ?? 22,
        remoteRoot: remoteInstanceRootDir({
          remote_path: profile.remote_path,
          instance_id: profile.instance_id,
        }),
      })
    : composeOwnerClaimControlFingerprint({
        transport: "local",
        instanceId,
        projectName: composeProjectName(profile),
      });
  return seedResultPath === undefined
    ? { profileName: profile.name, instanceId, controlFingerprint, mode: "claim" }
    : {
        profileName: profile.name,
        instanceId,
        controlFingerprint,
        mode: "owner-config",
        seedResultPath,
      };
}

export function composeOwnerConfigIdentity(
  profile: ComposeDriverProfile,
  seedResultPath: string,
): ComposeOwnerClaimIdentity {
  return identityFor(profile, seedResultPath);
}

function sameIdentity(
  left: ComposeOwnerClaimIdentity,
  right: ComposeOwnerClaimIdentity,
): boolean {
  return left.profileName === right.profileName
    && left.instanceId === right.instanceId
    && left.controlFingerprint === right.controlFingerprint
    && left.mode === right.mode
    && (left.mode === "claim"
      ? right.mode === "claim"
      : right.mode === "owner-config" && left.seedResultPath === right.seedResultPath);
}

async function defaultStore(profileName: string): Promise<KeyringComposeOwnerClaimStore> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new KeyringComposeOwnerClaimStore(new AsyncEntry(
    COMPOSE_OWNER_CLAIM_KEYRING_SERVICE,
    composeOwnerClaimKeyringAccount(profileName),
  ));
}

/**
 * Resolve the public handoff policy and durably create the plaintext claim
 * before a deployment driver exists. This function performs no target I/O.
 */
export async function prepareComposeOwnerClaim(
  profile: ComposeDriverProfile,
  dependencies: ComposeOwnerClaimDependencies = {},
): Promise<PreparedComposeOwnerClaim> {
  dependencies = effectiveDependencies(dependencies);
  const home = homeDirectory();
  // Fail before custody or Docker if the browser can never reach a safe target.
  if (profile.transport === "remote") browserTarget(profile, home);
  const identity = identityFor(profile);
  const store = await (dependencies.createStore ?? defaultStore)(profile.name);
  const stage = await prepareComposeOwnerStage({ identity, custody: custodyPort(store) });
  const prepared = { profileName: profile.name, identity, stage };
  preparedStores.set(prepared, store);
  return prepared;
}

export async function prepareComposeOwnerConfig(
  profile: ComposeDriverProfile,
  seedResultPath: string,
  dependencies: ComposeOwnerClaimDependencies = {},
): Promise<PreparedComposeOwnerClaim> {
  dependencies = effectiveDependencies(dependencies);
  const home = homeDirectory();
  if (profile.transport === "remote") browserTarget(profile, home);
  const identity = identityFor(profile, seedResultPath);
  const store = await (dependencies.createStore ?? defaultStore)(profile.name);
  const stage = await prepareComposeOwnerStage({ identity, custody: custodyPort(store) });
  const prepared = { profileName: profile.name, identity, stage };
  preparedStores.set(prepared, store);
  return prepared;
}

function exactOwnerResult(
  result: OwnerSeedResult | undefined,
  identity: ComposeOwnerClaimIdentity,
  handle: string,
): result is OwnerSeedResult {
  return result !== undefined
    && identity.mode === "owner-config"
    && result.schema === OWNER_SEED_RESULT_SCHEMA
    && result.profile === identity.profileName
    && result.targetFingerprint === identity.controlFingerprint
    && result.handle === handle;
}

function controlPlane(profile: ComposeDriverProfile, home: string): {
  targetUrl: string;
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  transport: OwnerClaimTargetTransportPolicy;
} {
  if (profile.transport === "remote") {
    if (!profile.ssh) throw new Error("Remote Compose owner claim requires SSH configuration");
    const targetUrl = resolveRemoteLoopbackBaseUrl(profile.ssh);
    const operatorFetch = buildSshLocalFetch({
      ssh: profile.ssh,
      composeProjectName: composeProjectName(profile),
    });
    return {
      targetUrl,
      fetchImpl: operatorFetch,
      transport: exactOriginPolicy(targetUrl),
    };
  }
  const targetUrl = browserTarget(profile, home);
  return { targetUrl, fetchImpl: fetch, transport: exactOriginPolicy(targetUrl) };
}

/**
 * Local Compose reaches the server through Docker's published host port, so
 * Fastify does not observe the request as loopback. Keep the body-only direct
 * seed protocol, but add the same bootstrap authority used by the protected
 * claim install. Remote Compose already executes inside the host over the
 * trusted SSH-loopback transport and must not receive a bearer header.
 */
function redeemTransport(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  authorization:
    | { readonly kind: "bearer"; readonly token: string }
    | { readonly kind: "trusted-loopback" },
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  if (authorization.kind === "trusted-loopback") return fetchImpl;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${authorization.token}`);
    return fetchImpl(input, { ...(init ?? {}), headers });
  };
}

async function clearBeforeComplete(
  store: KeyringComposeOwnerClaimStore,
  serverUrl: string,
  browser: ServerBrowserOutcome = "not-requested",
): Promise<ComposeOwnerClaimResult> {
  await store.clear();
  return { outcome: "owner-bound", serverUrl, browser };
}

/** Continue only the owner-claim protocol. It never starts or repairs Compose. */
export async function continueComposeOwnerClaim(input: {
  readonly profile: ComposeDriverProfile;
  readonly prepared?: PreparedComposeOwnerClaim;
  readonly finish: ServerFinishMode;
  readonly openBrowser: boolean;
  readonly dependencies?: ComposeOwnerClaimDependencies;
}): Promise<ComposeOwnerClaimResult> {
  const dependencies = effectiveDependencies(input.dependencies ?? {});
  const home = homeDirectory();
  const isResume = input.prepared === undefined;
  const expectedIdentity = identityFor(input.profile);
  if (input.prepared !== undefined
    && (input.prepared.profileName !== input.profile.name
      || !sameIdentity(input.prepared.identity, expectedIdentity))) {
    throw new Error("Compose owner claim custody failed");
  }
  const store = input.prepared === undefined
    ? await (dependencies.createStore ?? defaultStore)(input.profile.name)
    : preparedStores.get(input.prepared)
      ?? await (dependencies.createStore ?? defaultStore)(input.profile.name);
  const stage = input.prepared?.stage ?? {
    schemaVersion: 1 as const,
    identity: expectedIdentity,
  };
  const serverUrl = (dependencies.resolveServerUrl ?? browserTarget)(input.profile, home);
  const plane = (dependencies.resolveControlPlane ?? controlPlane)(input.profile, home);
  const target = (dependencies.createTarget ?? ((options) => createOwnerClaimTarget(options)))({
    transport: plane.transport,
    fetchImpl: plane.fetchImpl,
  });
  let authorization:
    | { readonly kind: "bearer"; readonly token: string }
    | { readonly kind: "trusted-loopback" }
    | undefined;
  const resolveAuthorization = () => {
    authorization ??= input.profile.transport === "remote"
      ? { kind: "trusted-loopback" as const }
      : (() => {
        const readBootstrap = dependencies.readBootstrapToken
          ?? ((profileName: string, tokenHome: string) => readBootstrapToken(profileName, { home: tokenHome }));
        const token = readBootstrap(input.profile.name, home);
        if (!token) throw new Error(
          `Local bootstrap authority is unavailable at ${bootstrapTokenPath(input.profile.name, home)}. Restore that exact credential from operator backup or authority, then rerun ${composeOwnerResumeCommand(input.profile.name, input.finish)}. The protected owner claim remains in the operating-system keychain.`,
        );
        return { kind: "bearer" as const, token };
      })();
    return authorization;
  };
  const coreResult = await advanceComposeOwnerStage({
    stage,
    resume: isResume,
    custody: custodyPort(store),
    control: {
      observe: () => target.status({ targetUrl: plane.targetUrl }),
      prepareInstall: () => {
        resolveAuthorization();
        return Promise.resolve();
      },
      install: ({ claimHash, expiresAt }) => target.install({
        targetUrl: plane.targetUrl,
        authorization: resolveAuthorization(),
        claimHash,
        expiresAt,
      }),
      classifyFailure: (error) =>
        error instanceof OwnerClaimControllerError ? error.failure : undefined,
    },
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  if (coreResult.outcome !== "claim-active") {
    return {
      outcome: coreResult.outcome,
      serverUrl,
      browser: "not-requested",
      ...(coreResult.controllerFailure === undefined
        ? {}
        : { controllerFailure: coreResult.controllerFailure }),
    };
  }

  const claim = await store.getOrCreate(expectedIdentity);

  if (!input.openBrowser) {
    return { outcome: "claim-active", serverUrl, browser: "not-requested" };
  }

  let handoff: OwnerClaimBrowserHandoff | undefined;
  try {
    handoff = await (dependencies.createHandoff ?? createOwnerClaimBrowserHandoff)({
      targetUrl: serverUrl,
      claim,
      finish: input.finish,
      transport: exactOriginPolicy(serverUrl),
    });
    await (dependencies.openBrowser ?? openUrlInDefaultBrowserChecked)(handoff.localUrl);
  } catch {
    await handoff?.close().catch(() => undefined);
    return { outcome: "claim-active", serverUrl, browser: "failed" };
  }

  let interrupted = false;
  process.stderr.write(
    `Finish owner setup in the browser. Ctrl-C or closing this command is safe; resume with ${composeOwnerResumeCommand(input.profile.name, input.finish)}.\n`,
  );
  const onInterrupt = (): void => { interrupted = true; };
  if (!dependencies.interrupted) {
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
  }
  const sleep = dependencies.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  try {
    const attempts = dependencies.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (interrupted || dependencies.interrupted?.()) {
        return { outcome: "interrupted", serverUrl, browser: "opened" };
      }
      if (attempt > 0) await sleep(dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      if (interrupted || dependencies.interrupted?.()) {
        return { outcome: "interrupted", serverUrl, browser: "opened" };
      }
      let status;
      try {
        status = await target.status({ targetUrl: plane.targetUrl });
      } catch (error) {
        return {
          outcome: "target-unavailable", serverUrl, browser: "opened",
          ...(error instanceof OwnerClaimControllerError ? { controllerFailure: error.failure } : {}),
        };
      }
      if (status.state === "owner-bound") return clearBeforeComplete(store, serverUrl, "opened");
      if (status.state === "awaiting-owner") {
        return { outcome: "awaiting-owner", serverUrl, browser: "opened" };
      }
    }
    return { outcome: "claim-active", serverUrl, browser: "opened" };
  } finally {
    if (!dependencies.interrupted) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
    }
    await handoff.close().catch(() => undefined);
  }
}

export interface ComposeOwnerConfigInput {
  readonly handle: string;
  readonly displayName: string;
  readonly password: string;
  readonly pin: string;
}

function configRecoveryResult(
  serverUrl: string,
  resultPath: string,
  failure: string,
  exposeResultPath = false,
): ComposeOwnerClaimResult {
  return {
    outcome: "recovery-required",
    serverUrl,
    browser: "not-requested",
    controllerFailure: failure,
    ...(exposeResultPath ? { ownerResultPath: resultPath } : {}),
  };
}

/** Seed one Compose owner only after health, then durably publish its one-shot recovery codes. */
export async function continueComposeOwnerConfig(input: {
  readonly profile: ComposeDriverProfile;
  readonly prepared: PreparedComposeOwnerClaim;
  readonly owner: ComposeOwnerConfigInput;
  readonly resultPath: string;
  readonly existingResult?: OwnerSeedResult | undefined;
  readonly serverRootPaths?: readonly string[] | undefined;
  readonly dependencies?: ComposeOwnerClaimDependencies;
}): Promise<ComposeOwnerClaimResult> {
  const dependencies = effectiveDependencies(input.dependencies ?? {});
  const home = homeDirectory();
  const expectedIdentity = identityFor(input.profile, input.resultPath);
  if (input.prepared.profileName !== input.profile.name
    || !sameIdentity(input.prepared.identity, expectedIdentity)) {
    throw new Error("Compose owner config custody failed");
  }
  const store = preparedStores.get(input.prepared)
    ?? await (dependencies.createStore ?? defaultStore)(input.profile.name);
  const claim = await store.getOrCreate(expectedIdentity);
  if (input.existingResult !== undefined
    && !exactOwnerResult(input.existingResult, expectedIdentity, input.owner.handle)) {
    throw new Error("Existing owner result does not match this exact Compose owner operation");
  }

  const serverUrl = (dependencies.resolveServerUrl ?? browserTarget)(input.profile, home);
  const plane = (dependencies.resolveControlPlane ?? controlPlane)(input.profile, home);
  const target = (dependencies.createTarget ?? ((options) => createOwnerClaimTarget(options)))({
    transport: plane.transport,
    fetchImpl: plane.fetchImpl,
  });
  const observe = async () => {
    try {
      return await target.status({ targetUrl: plane.targetUrl });
    } catch (error) {
      return error instanceof OwnerClaimControllerError ? error : new Error("target-unavailable");
    }
  };
  const completeExisting = async (): Promise<ComposeOwnerClaimResult> => {
    if (!exactOwnerResult(input.existingResult, expectedIdentity, input.owner.handle)) {
      return configRecoveryResult(serverUrl, input.resultPath, "recovery-result-missing");
    }
    let durable: OwnerSeedResult;
    try {
      durable = await (dependencies.durabilizeOwnerResult ?? durabilizeExistingOwnerSeedResult)({
        path: input.resultPath,
        ...(input.serverRootPaths === undefined ? {} : { serverRootPaths: input.serverRootPaths }),
      });
    } catch {
      return configRecoveryResult(serverUrl, input.resultPath, "recovery-result-sync-failed", true);
    }
    if (!exactOwnerResult(durable, expectedIdentity, input.owner.handle)) {
      return configRecoveryResult(serverUrl, input.resultPath, "recovery-result-mismatch", true);
    }
    await store.clear();
    return {
      outcome: "owner-bound",
      serverUrl,
      browser: "not-requested",
      ...(input.existingResult === undefined ? {} : { ownerResultPath: input.resultPath }),
    };
  };

  const initial = await observe();
  if (initial instanceof Error) {
    return {
      outcome: "target-unavailable",
      serverUrl,
      browser: "not-requested",
      controllerFailure: initial instanceof OwnerClaimControllerError
        ? initial.failure
        : "target-unavailable",
      ...(input.existingResult === undefined ? {} : { ownerResultPath: input.resultPath }),
    };
  }
  if (initial.state === "owner-bound") return completeExisting();
  if (input.existingResult !== undefined) {
    return {
      outcome: "install-unknown",
      serverUrl,
      browser: "not-requested",
      controllerFailure: "owner-state-result-inconsistent",
      ownerResultPath: input.resultPath,
    };
  }

  const authorization = input.profile.transport === "remote"
    ? { kind: "trusted-loopback" as const }
    : (() => {
        const readBootstrap = dependencies.readBootstrapToken
          ?? ((profileName: string, tokenHome: string) => readBootstrapToken(profileName, { home: tokenHome }));
        const token = readBootstrap(input.profile.name, home);
        if (!token) throw new Error(
          `Local bootstrap authority is unavailable at ${bootstrapTokenPath(input.profile.name, home)}. Restore that exact credential, then rerun the exact protected config deploy. Custody was retained.`,
        );
        return { kind: "bearer" as const, token };
      })();
  const claimHash = hashOwnerClaim(claim);
  const expiresAt = new Date((dependencies.now ?? Date.now)() + CLAIM_TTL_MS).toISOString();
  const install = async () => target.install({
    targetUrl: plane.targetUrl,
    authorization,
    claimHash,
    expiresAt,
  });
  try {
    const installed = await install();
    if (installed.state === "owner-bound") return completeExisting();
    if (installed.state !== "claim-active") {
      return { outcome: "install-unknown", serverUrl, browser: "not-requested" };
    }
  } catch (error) {
    if (!(error instanceof OwnerClaimControllerError)
      || error.failure !== "ambiguous-write") {
      return {
        outcome: "install-unknown", serverUrl, browser: "not-requested",
        controllerFailure: error instanceof OwnerClaimControllerError
          ? error.failure
          : "install-unknown",
      };
    }
    const after = await observe();
    if (!(after instanceof Error) && after.state === "owner-bound") return completeExisting();
    if (after instanceof Error || after.state !== "claim-active") {
      return {
        outcome: "install-unknown", serverUrl, browser: "not-requested",
        controllerFailure: error instanceof OwnerClaimControllerError ? error.failure : "install-unknown",
      };
    }
    try {
      const retried = await install();
      if (retried.state === "owner-bound") return completeExisting();
      if (retried.state !== "claim-active") {
        return { outcome: "install-unknown", serverUrl, browser: "not-requested" };
      }
    } catch (retryError) {
      return {
        outcome: "install-unknown", serverUrl, browser: "not-requested",
        controllerFailure: retryError instanceof OwnerClaimControllerError
          ? retryError.failure
          : "install-unknown",
      };
    }
  }

  const redeemInput: RedeemInput = {
    handle: input.owner.handle,
    displayName: input.owner.displayName,
    password: input.owner.password,
    pin: input.owner.pin,
  };
  const redeem = dependencies.redeemOwner ?? (async (targetUrl, claim, owner, fetchImpl) => {
    const api = new NautiloApiClient(targetUrl, { fetchImpl });
    return api.redeemOwnerClaim({ claim, ...owner });
  });
  const authorizedRedeemFetch = redeemTransport(plane.fetchImpl, authorization);
  let redeemed: RedeemOwnerClaimResponse;
  try {
    redeemed = await redeem(plane.targetUrl, claim, redeemInput, authorizedRedeemFetch);
  } catch (error) {
    if (!(error instanceof OwnerClaimAmbiguousWriteError)) {
      return {
        outcome: "claim-active",
        serverUrl,
        browser: "not-requested",
        controllerFailure: error instanceof OwnerClaimApiError ? error.code : "redeem-failed",
      };
    }
    const after = await observe();
    if (!(after instanceof Error) && after.state === "owner-bound") return completeExisting();
    if (after instanceof Error || after.state !== "claim-active") {
      return after instanceof OwnerClaimControllerError
        ? { outcome: "target-unavailable", serverUrl, browser: "not-requested", controllerFailure: after.failure }
        : { outcome: "install-unknown", serverUrl, browser: "not-requested", controllerFailure: "redeem-response-unknown" };
    }
    try {
      redeemed = await redeem(plane.targetUrl, claim, redeemInput, authorizedRedeemFetch);
    } catch (retryError) {
      if (!(retryError instanceof OwnerClaimAmbiguousWriteError)) {
        return {
          outcome: "claim-active",
          serverUrl,
          browser: "not-requested",
          controllerFailure: retryError instanceof OwnerClaimApiError ? retryError.code : "redeem-failed",
        };
      }
      const afterRetry = await observe();
      if (!(afterRetry instanceof Error) && afterRetry.state === "owner-bound") return completeExisting();
      return afterRetry instanceof OwnerClaimControllerError
        ? { outcome: "target-unavailable", serverUrl, browser: "not-requested", controllerFailure: afterRetry.failure }
        : { outcome: "claim-active", serverUrl, browser: "not-requested", controllerFailure: "ambiguous-write" };
    }
  }
  if (redeemed.state !== "owner-bound" || !Array.isArray(redeemed.recoveryCodes)
    || redeemed.recoveryCodes.length === 0) {
    return configRecoveryResult(serverUrl, input.resultPath, "recovery-codes-missing");
  }
  const ownerResult: OwnerSeedResult = {
    schema: OWNER_SEED_RESULT_SCHEMA,
    profile: input.profile.name,
    targetFingerprint: expectedIdentity.controlFingerprint,
    handle: input.owner.handle,
    recoveryCodes: [...redeemed.recoveryCodes],
  };
  try {
    await (dependencies.publishOwnerResult ?? publishOwnerSeedResult)({
      path: input.resultPath,
      ...(input.serverRootPaths === undefined ? {} : { serverRootPaths: input.serverRootPaths }),
      result: ownerResult,
    });
  } catch {
    return configRecoveryResult(serverUrl, input.resultPath, "recovery-result-publish-failed");
  }
  const final = await observe();
  if (final instanceof Error) {
    return {
      outcome: "target-unavailable", serverUrl, browser: "not-requested",
      controllerFailure: final instanceof OwnerClaimControllerError ? final.failure : "target-unavailable",
      ownerResultPath: input.resultPath,
    };
  }
  if (final.state !== "owner-bound") {
    return {
      outcome: "install-unknown",
      serverUrl,
      browser: "not-requested",
      controllerFailure: "owner-bind-not-observed",
      ownerResultPath: input.resultPath,
    };
  }
  await store.clear();
  return {
    outcome: "owner-bound",
    serverUrl,
    browser: "not-requested",
    ownerResultPath: input.resultPath,
  };
}

/** Open the requested post-claim destination without changing owner truth. */
export async function openComposeOwnerConfigDestination(
  result: ComposeOwnerClaimResult,
  finish: ServerFinishMode,
  dependencies: ComposeOwnerClaimDependencies = {},
): Promise<ComposeOwnerClaimResult> {
  if (result.outcome !== "owner-bound") return result;
  dependencies = effectiveDependencies(dependencies);
  const destination = resolveServerCompletionDestinations(result.serverUrl, finish).finalUrl;
  try {
    await (dependencies.openBrowser ?? openUrlInDefaultBrowserChecked)(destination);
    return { ...result, browser: "opened" };
  } catch {
    return { ...result, browser: "failed" };
  }
}

export async function clearComposeOwnerClaimCustody(profile: ComposeDriverProfile): Promise<void> {
  const dependencies = effectiveDependencies({});
  await (await (dependencies.createStore ?? defaultStore)(profile.name)).clear();
}

export function composeOwnerResumeCommand(
  profileName: string,
  finish: ServerFinishMode,
): string {
  return `nautilo claim resume --profile ${shellQuote(profileName)} --finish ${finish}`;
}
