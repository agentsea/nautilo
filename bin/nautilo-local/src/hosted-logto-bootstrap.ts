import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  ManagedWorkbenchOriginReplacementError,
  normalizeManagedWorkbenchOriginReplacement,
  runBootstrap,
  type LogtoConfig,
  type ManagedWorkbenchOriginReplacement,
} from "./bootstrap-logto";

export type HostedLogtoBootstrapEnvironment = Readonly<Record<string, string | undefined>>;

export interface HostedLogtoBootstrapOutput {
  readonly "logto-workbench-app-id": string;
  readonly "logto-tui-app-id": string;
  readonly "logto-tui-loopback-app-id": string;
  readonly "logto-desktop-app-id": string;
  readonly "logto-mobile-app-id": string;
  readonly "logto-mobile-web-app-id": string;
  readonly "logto-m2m-app-id": string;
  readonly "logto-m2m-app-secret": string;
  readonly "logto-resource": string;
}

export class HostedLogtoBootstrapInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostedLogtoBootstrapInputError";
  }
}

function required(environment: HostedLogtoBootstrapEnvironment, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new HostedLogtoBootstrapInputError(`missing-${key.toLowerCase().replaceAll("_", "-")}`);
  return value;
}

function port(environment: HostedLogtoBootstrapEnvironment): number {
  const value = Number(required(environment, "PORT"));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new HostedLogtoBootstrapInputError("invalid-port");
  }
  return value;
}

export function hostedOutput(config: LogtoConfig): HostedLogtoBootstrapOutput {
  return {
    "logto-workbench-app-id": config.workbenchAppId,
    "logto-tui-app-id": config.tuiAppId,
    "logto-tui-loopback-app-id": config.tuiLoopbackAppId,
    "logto-desktop-app-id": config.desktopAppId,
    "logto-mobile-app-id": config.mobileAppId,
    "logto-mobile-web-app-id": config.mobileWebAppId,
    "logto-m2m-app-id": config.m2mAppId,
    "logto-m2m-app-secret": config.m2mAppSecret,
    "logto-resource": config.resource,
  };
}

function authorized(request: IncomingMessage, token: string): boolean {
  const prefix = "Bearer ";
  const header = request.headers.authorization;
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

export async function reconcileHostedLogto(
  environment: HostedLogtoBootstrapEnvironment,
  reconcile: typeof runBootstrap = runBootstrap,
): Promise<{ readonly token: string; readonly port: number; readonly output: HostedLogtoBootstrapOutput }> {
  const token = required(environment, "NAUTILO_BOOTSTRAP_HANDOFF_TOKEN");
  const sourceOrigin = environment["NAUTILO_MANAGED_WORKBENCH_SOURCE_ORIGIN"];
  let managedWorkbenchOriginReplacement: ManagedWorkbenchOriginReplacement | undefined;
  if (sourceOrigin !== undefined) {
    const targetOrigin = environment["NAUTILO_PUBLIC_BASE_URL"];
    const targetRedirect = environment["NAUTILO_WORKBENCH_REDIRECT_URI"];
    try {
      managedWorkbenchOriginReplacement = normalizeManagedWorkbenchOriginReplacement({
        sourceOrigin,
        targetOrigin: targetOrigin ?? "",
      });
    } catch (error) {
      if (error instanceof ManagedWorkbenchOriginReplacementError) {
        throw new HostedLogtoBootstrapInputError("invalid-managed-workbench-origin-replacement");
      }
      throw error;
    }
    if (targetRedirect !== `${managedWorkbenchOriginReplacement.targetOrigin}/auth/callback`) {
      throw new HostedLogtoBootstrapInputError("invalid-managed-workbench-origin-replacement");
    }
  }
  let config: LogtoConfig | undefined;
  const result = await reconcile({
    endpoint: required(environment, "LOGTO_ENDPOINT_INTERNAL"),
    adminEndpoint: required(environment, "LOGTO_ADMIN_ENDPOINT_INTERNAL"),
    defaultTenantEndpoint: required(environment, "LOGTO_ENDPOINT_INTERNAL"),
    postgresUrl: required(environment, "LOGTO_POSTGRES_URL"),
    resource: required(environment, "LOGTO_RESOURCE"),
    extraWorkbenchRedirectUris: [required(environment, "NAUTILO_WORKBENCH_REDIRECT_URI")],
    extraWorkbenchPostLogoutUris: [required(environment, "NAUTILO_PUBLIC_BASE_URL")],
    ...(managedWorkbenchOriginReplacement === undefined
      ? {}
      : {
          managedWorkbenchOriginReplacement,
          // A populated restore must retain the restored tenant and expose
          // its exact pre-existing IDs through the request-memory handoff.
          preserveProvisionedState: true,
        }),
    extraMobileWebRedirectUris: [`${required(environment, "NAUTILO_PUBLIC_BASE_URL")}/mobile/callback`],
    extraMobileWebPostLogoutUris: [`${required(environment, "NAUTILO_PUBLIC_BASE_URL")}/mobile`],
    unknownSessionRedirectUrl: required(environment, "NAUTILO_PUBLIC_BASE_URL"),
    persistAdminCredential: false,
    persistConfig: (value) => {
      config = value;
      return Promise.resolve();
    },
  });
  config ??= result;
  if (!config) throw new HostedLogtoBootstrapInputError("missing-reconcile-output");
  return { token, port: port(environment), output: hostedOutput(config) };
}

export async function main(
  environment: HostedLogtoBootstrapEnvironment = process.env,
): Promise<void> {
  const ready = await reconcileHostedLogto(environment);
  const server = createHostedHandoffServer(ready.token, ready.output);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ready.port, "::", resolve);
  });
}

/**
 * The authenticated result remains replayable until the driver deletes this
 * transient service. That makes a lost client response safely retryable; only
 * possession of the 256-bit request-memory token authorizes a read.
 */
export function createHostedHandoffServer(
  token: string,
  output: HostedLogtoBootstrapOutput,
): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { ready: true });
      return;
    }
    if (request.method !== "GET" || request.url !== "/handoff") {
      json(response, 404, { error: "not-found" });
      return;
    }
    if (!authorized(request, token)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    json(response, 200, output);
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const code = error instanceof HostedLogtoBootstrapInputError ? error.code : "reconciliation-failed";
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
}
