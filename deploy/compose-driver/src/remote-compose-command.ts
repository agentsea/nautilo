import { posix } from "node:path";

import { shellQuote } from "./remote-exec.ts";

/** Supported Compose service names for remote lifecycle commands. */
export const REMOTE_COMPOSE_SERVICES = [
  "nautilo-server",
  "app-postgres",
  "logto-postgres",
  "logto",
  "caddy",
  "collabora",
  "office",
] as const;

export type RemoteComposeServiceName = (typeof REMOTE_COMPOSE_SERVICES)[number];

export type RemoteComposeOverlayFlags = {
  volumes?: boolean | undefined;
  caddy?: boolean | undefined;
  registry?: boolean | undefined;
  server?: boolean | undefined;
  restore?: boolean | undefined;
};

/** Allowlisted Compose profiles for remote deploy orchestration. */
export const REMOTE_COMPOSE_PROFILES = ["auth", "app", "office"] as const;

export type RemoteComposeProfileName = (typeof REMOTE_COMPOSE_PROFILES)[number];

export type RemoteComposeCommandRequest =
  | { verb: "ps" }
  | { verb: "config"; images?: boolean | undefined }
  | { verb: "build"; service: RemoteComposeServiceName }
  | { verb: "restart"; service: RemoteComposeServiceName }
  | { verb: "restart"; services: readonly RemoteComposeServiceName[] }
  | { verb: "start"; service: RemoteComposeServiceName }
  | { verb: "stop"; service: RemoteComposeServiceName }
  | { verb: "pull"; service: RemoteComposeServiceName }
  | { verb: "logs"; service?: RemoteComposeServiceName | undefined; follow?: boolean | undefined }
  | {
      verb: "up";
      service?: RemoteComposeServiceName | undefined;
      wait?: boolean | undefined;
      noBuild?: boolean | undefined;
      noDeps?: boolean | undefined;
      forceRecreate?: boolean | undefined;
    }
  | { verb: "down" };

export type RemoteComposeCommand = {
  command: "sh";
  args: ["-lc", string];
};

export type BuildRemoteComposeCommandInput = {
  remoteRoot: string;
  projectName: string;
  overlays?: RemoteComposeOverlayFlags | undefined;
  profiles?: readonly RemoteComposeProfileName[] | undefined;
  request: RemoteComposeCommandRequest;
};

const SERVICE_SET = new Set<string>(REMOTE_COMPOSE_SERVICES);
const PROFILE_SET = new Set<string>(REMOTE_COMPOSE_PROFILES);

export function validateRemoteComposeProjectName(projectName: string): string {
  const t = projectName.trim();
  if (t.length === 0) {
    throw new Error("projectName must not be empty");
  }
  if (t.length > 128) {
    throw new Error("projectName must be 128 characters or fewer");
  }
  if (t !== t.toLowerCase()) {
    throw new Error("projectName must be lowercase (docker compose project naming)");
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(t)) {
    throw new Error(
      "projectName must start with a letter and contain only a-z, 0-9, hyphen, underscore",
    );
  }
  return t;
}

export function validateRemoteComposeProfiles(
  profiles: readonly string[],
): RemoteComposeProfileName[] {
  const seen = new Set<string>();
  const validated: RemoteComposeProfileName[] = [];
  for (const profile of profiles) {
    if (!PROFILE_SET.has(profile)) {
      throw new Error(
        `unsupported compose profile '${profile}' (allowed: ${REMOTE_COMPOSE_PROFILES.join(", ")})`,
      );
    }
    if (!seen.has(profile)) {
      seen.add(profile);
      validated.push(profile as RemoteComposeProfileName);
    }
  }
  return validated;
}

export function validateRemoteComposeRoot(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("remoteRoot must be a non-empty absolute POSIX path");
  }
  if (raw.includes("\0")) {
    throw new Error("remoteRoot must not contain null bytes");
  }
  if (raw.startsWith("~")) {
    throw new Error("remoteRoot must be an absolute POSIX path");
  }
  if (!raw.startsWith("/")) {
    throw new Error("remoteRoot must be an absolute POSIX path");
  }
  if (/(^|\/)\.\.(\/|$)/.test(raw)) {
    throw new Error("remoteRoot must not contain '..' segments");
  }
  if (/(^|\/)\.(\/|$)/.test(raw)) {
    throw new Error("remoteRoot must not contain '.' segments");
  }
  const normalized = posix.normalize(raw);
  if (!normalized.startsWith("/")) {
    throw new Error("remoteRoot must be an absolute POSIX path");
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function assertSupportedService(service: string, verb: string): RemoteComposeServiceName {
  if (!SERVICE_SET.has(service)) {
    throw new Error(
      `remote compose ${verb}: unsupported service '${service}' (allowed: ${REMOTE_COMPOSE_SERVICES.join(", ")})`,
    );
  }
  return service as RemoteComposeServiceName;
}

function rejectUnexpectedService(
  request: RemoteComposeCommandRequest,
  field: "service",
): void {
  const value = (request as Record<string, unknown>)[field];
  if (value !== undefined) {
    throw new Error(`remote compose ${request.verb}: must not specify ${field}`);
  }
}

function buildVerbArgs(request: RemoteComposeCommandRequest): string[] {
  switch (request.verb) {
    case "ps":
      rejectUnexpectedService(request, "service");
      return ["ps", "--format", "json"];
    case "config":
      rejectUnexpectedService(request, "service");
      return request.images === true ? ["config", "--images"] : ["config"];
    case "build":
      return ["build", assertSupportedService(request.service, "build")];
    case "restart":
      if ("services" in request) {
        rejectUnexpectedService(request, "service");
        if (request.services.length === 0) {
          throw new Error("remote compose restart: services must not be empty");
        }
        const services = request.services.map((service) =>
          assertSupportedService(service, "restart")
        );
        if (new Set(services).size !== services.length) {
          throw new Error("remote compose restart: services must be unique");
        }
        return ["restart", ...services];
      }
      if (!("service" in request)) {
        throw new Error("remote compose restart: requires an allowlisted service");
      }
      return ["restart", assertSupportedService(request.service, "restart")];
    case "start":
      return ["start", assertSupportedService(request.service, "start")];
    case "stop":
      return ["stop", assertSupportedService(request.service, "stop")];
    case "pull":
      return ["pull", assertSupportedService(request.service, "pull")];
    case "logs": {
      const args = ["logs"];
      if (request.follow === true) args.push("-f");
      if (request.service !== undefined) {
        args.push(assertSupportedService(request.service, "logs"));
      }
      return args;
    }
    case "up":
      {
        const args = ["up", "-d"];
        if (request.wait === true) args.push("--wait");
        if (request.noBuild === true) args.push("--no-build");
        if (request.noDeps === true) args.push("--no-deps");
        if (request.forceRecreate === true) args.push("--force-recreate");
        if (request.service !== undefined) {
          args.push(assertSupportedService(request.service, "up"));
        }
        return args;
      }
    case "down":
      rejectUnexpectedService(request, "service");
      return ["down"];
    default: {
      const _exhaustive: never = request;
      throw new Error(`unsupported remote compose verb: ${String(_exhaustive)}`);
    }
  }
}

function remotePath(remoteRoot: string, relative: string): string {
  return posix.join(remoteRoot, relative);
}

export function buildRemoteComposeExecInvocation(input: {
  remoteRoot: string;
  projectName: string;
  overlays?: RemoteComposeOverlayFlags | undefined;
  profiles?: readonly RemoteComposeProfileName[] | undefined;
  service: RemoteComposeServiceName;
}): string {
  const remoteRoot = validateRemoteComposeRoot(input.remoteRoot);
  const projectName = validateRemoteComposeProjectName(input.projectName);
  const overlays = input.overlays ?? {};
  const profiles =
    input.profiles !== undefined
      ? validateRemoteComposeProfiles(input.profiles)
      : [];
  const service = assertSupportedService(input.service, "exec");
  const composeInvocation = buildComposeInvocation(
    remoteRoot,
    projectName,
    overlays,
    profiles,
    [],
  );
  // `buildComposeInvocation()` prefixes normal SSH-native commands with the
  // shell `exec` builtin. DB repair helpers embed this command in a pipeline,
  // where that prefix routes Docker's compose flags through the wrong command
  // parser on the remote shell. Use the plain compose invocation there.
  const plainComposeInvocation = composeInvocation.replace(/^exec /, "");
  return `${plainComposeInvocation} exec -T ${service} `;
}

function buildComposeInvocation(
  remoteRoot: string,
  projectName: string,
  overlays: RemoteComposeOverlayFlags,
  profiles: readonly RemoteComposeProfileName[],
  verbArgs: string[],
): string {
  const parts: string[] = [
    "exec docker compose",
    `--project-name ${shellQuote(projectName)}`,
    `-f ${shellQuote(remotePath(remoteRoot, "docker-compose.yml"))}`,
  ];
  if (overlays.volumes === true) {
    parts.push(`-f ${shellQuote(remotePath(remoteRoot, "deploy.volumes-overlay.yml"))}`);
  }
  if (overlays.caddy === true) {
    parts.push(`-f ${shellQuote(remotePath(remoteRoot, "deploy.caddy-overlay.yml"))}`);
  }
  if (overlays.registry === true) {
    parts.push(`-f ${shellQuote(remotePath(remoteRoot, "deploy.registry-overlay.yml"))}`);
  }
  if (overlays.server === true) {
    parts.push(`-f ${shellQuote(remotePath(remoteRoot, "deploy.server-overlay.yml"))}`);
  }
  if (overlays.restore === true) {
    parts.push(`-f ${shellQuote(remotePath(remoteRoot, "deploy.restore-overlay.yml"))}`);
  }
  parts.push(`--env-file ${shellQuote(remotePath(remoteRoot, "deploy.compose.env"))}`);
  for (const profile of profiles) {
    parts.push(`--profile ${shellQuote(profile)}`);
  }
  for (const arg of verbArgs) {
    parts.push(shellQuote(arg));
  }
  return parts.join(" ");
}

/**
 * Build an SSH-native remote shell command that runs `docker compose` on the
 * host using only remote absolute paths (no DOCKER_HOST / laptop staging).
 */
export function buildRemoteComposeCommand(
  input: BuildRemoteComposeCommandInput,
): RemoteComposeCommand {
  const remoteRoot = validateRemoteComposeRoot(input.remoteRoot);
  const projectName = validateRemoteComposeProjectName(input.projectName);
  const overlays = input.overlays ?? {};
  const profiles =
    input.profiles !== undefined
      ? validateRemoteComposeProfiles(input.profiles)
      : [];
  const verbArgs = buildVerbArgs(input.request);
  const composeInvocation = buildComposeInvocation(
    remoteRoot,
    projectName,
    overlays,
    profiles,
    verbArgs,
  );
  const script = `cd -- ${shellQuote(remoteRoot)} && ${composeInvocation}`;
  return { command: "sh", args: ["-lc", script] };
}
