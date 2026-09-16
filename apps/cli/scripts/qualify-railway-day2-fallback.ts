import { join } from "node:path";

import { openUrlInDefaultBrowserChecked } from "@nautilo/cli-auth";
import { resolveNautiloRootDir } from "@nautilo/config";
import {
  authorizeRailwayOAuth,
  RAILWAY_OAUTH_CLIENT_ID,
  type RailwayPlanTransport,
} from "@nautilo/railway-hosting";
import type { HostInterruptController } from "@nautilo/hosting";
import { AsyncEntry } from "@napi-rs/keyring";
import yargs from "yargs";

import { createHostModule, type HostPlanDependencies } from "../src/commands/host";
import {
  KeyringRailwayOAuthCredentialStore,
  RAILWAY_OAUTH_KEYRING_ACCOUNT,
  RAILWAY_OAUTH_KEYRING_SERVICE,
} from "../src/lib/railway-oauth-credential-store";
import {
  discoverRailwayMaintenanceStates,
  latestRailwayMaintenanceStates,
} from "../src/lib/railway-host-maintenance";
import { resolveRailwayRelease } from "../src/lib/railway-release-source";
import type { RailwayMaintenanceState } from "../src/lib/railway-maintenance-state";

const SENTINEL = "railway.day2-fallback-injection.v1 passed";

function eligibleCandidate(state: RailwayMaintenanceState, expectedLaunchId: string): boolean {
  return state.sourceLaunchId === expectedLaunchId
    && state.candidateUpgrade?.stage === "complete"
    && state.postUpgradeSourceState !== undefined
    && state.fallbackDecision === undefined
    && state.activeLaunch === undefined
    && state.restoreTargetPreparation === undefined;
}

export function shouldInjectRailwayCandidateFailure(input: {
  readonly state: RailwayMaintenanceState;
  readonly expectedLaunchId: string;
  readonly requestUrl: string;
}): boolean {
  if (!eligibleCandidate(input.state, input.expectedLaunchId)) return false;
  let request: URL;
  try { request = new URL(input.requestUrl); } catch { return false; }
  return request.protocol === "https:"
    && request.hostname === input.state.sourceManagedWorkbenchHostname
    && request.pathname === "/health/ready"
    && request.search === "";
}

async function main(): Promise<void> {
  if (process.env["NAUTILO_RAILWAY_FALLBACK_QUALIFICATION"] !== "1") {
    throw new Error("Railway fallback qualification is not explicitly authorized");
  }
  const expectedLaunchId = process.env["NAUTILO_QUALIFICATION_EXPECTED_SOURCE_LAUNCH"]?.trim();
  const expectedMaintenanceId = process.env["NAUTILO_QUALIFICATION_EXPECTED_MAINTENANCE"]?.trim();
  if (expectedLaunchId === undefined || !/^[A-Za-z0-9._-]{1,128}$/.test(expectedLaunchId)) {
    throw new Error("Railway fallback qualification source is invalid");
  }
  if (expectedMaintenanceId === undefined || !/^[A-Za-z0-9._-]{1,128}$/.test(expectedMaintenanceId)) {
    throw new Error("Railway fallback qualification operation is invalid");
  }
  const args = process.argv.slice(2);
  if (args[0] !== "host" || args[1] !== "resume" || !args.includes("--yes")
    || !args.includes("--backend") || !args.includes("railway") || !args.includes("--launch")
    || !args.includes(expectedLaunchId) || !args.includes("--recovery-config")) {
    throw new Error("Railway fallback qualification command is invalid");
  }

  const maintenanceRoot = join(resolveNautiloRootDir({ env: process.env }), "hosting", "railway", "maintenance");
  let injected = false;
  let checksAfterInjection = 0;
  let injectedMaintenanceId: string | undefined;
  const controller = new AbortController();
  const interruptController: HostInterruptController = {
    signal: controller.signal,
    interrupted: () => injected && ++checksAfterInjection >= 2,
    dispose: () => {},
  };
  const qualificationFetch = Object.assign(async (resource: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const requestUrl = typeof resource === "string" || resource instanceof URL ? resource.toString() : resource.url;
    if (!injected) {
      const candidates = latestRailwayMaintenanceStates(await discoverRailwayMaintenanceStates(maintenanceRoot))
        .filter((state) => state.maintenanceId === expectedMaintenanceId
          && shouldInjectRailwayCandidateFailure({ state, expectedLaunchId, requestUrl }));
      if (candidates.length > 1) throw new Error("Railway fallback qualification identity is ambiguous");
      if (candidates.length === 1) {
        injected = true;
        injectedMaintenanceId = candidates[0]!.maintenanceId;
        return new Response(null, { status: 401 });
      }
    }
    return fetch(resource, init);
  }, { preconnect: fetch.preconnect }) satisfies typeof fetch;

  const acquireRailwayAuthorization: HostPlanDependencies["acquireRailwayAuthorization"] = async ({ interactive }) => {
    const configuredClientId = process.env["NAUTILO_RAILWAY_OAUTH_CLIENT_ID"]?.trim();
    const credentialStore = new KeyringRailwayOAuthCredentialStore(
      new AsyncEntry(RAILWAY_OAUTH_KEYRING_SERVICE, RAILWAY_OAUTH_KEYRING_ACCOUNT),
      join(resolveNautiloRootDir({ env: process.env }), "auth", "railway-oauth.lock"),
    );
    const result = await authorizeRailwayOAuth({
      clientId: configuredClientId === undefined || configuredClientId.length === 0 ? RAILWAY_OAUTH_CLIENT_ID : configuredClientId,
      interactive,
      openBrowser: openUrlInDefaultBrowserChecked,
      credentialStore,
    });
    return result.outcome === "failure"
      ? { outcome: "authorization-required", failure: result.failure }
      : { outcome: "authorized", transport: result.transport as RailwayPlanTransport,
        authorization: { kind: "railway-oauth", mutationScope: "qualified" } };
  };
  const dependencies: HostPlanDependencies = {
    acquireRailwayAuthorization,
    resolveRailwayRelease: () => resolveRailwayRelease(process.env),
    environment: process.env,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value),
    fetch: qualificationFetch,
    createHostInterruptController: (): HostInterruptController => interruptController,
  };
  await yargs(args).scriptName("nautilo").strict().exitProcess(false).command(createHostModule(dependencies)).demandCommand(1).parseAsync();

  if (!injected || injectedMaintenanceId === undefined) throw new Error("Railway fallback qualification injection was not reached");
  const completed = latestRailwayMaintenanceStates(await discoverRailwayMaintenanceStates(maintenanceRoot))
    .filter((state) => state.maintenanceId === expectedMaintenanceId
      && state.maintenanceId === injectedMaintenanceId && state.sourceLaunchId === expectedLaunchId);
  if (completed.length !== 1
    || completed[0]!.fallbackDecision?.reason !== "candidate-verification"
    || completed[0]!.maintenanceReceipt.lastFailure?.operation !== "candidate-verification"
    || completed[0]!.maintenanceReceipt.lastFailure.retryable !== false
    || completed[0]!.restoreTargetPreparation !== undefined) {
    throw new Error("Railway fallback qualification decision was not durably isolated");
  }
  process.exitCode = 0;
  process.stdout.write(`${SENTINEL}\n`);
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write("Railway Day Two fallback qualification failed at a redacted stage.\n");
    process.exitCode = 2;
  });
}
