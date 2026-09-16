import { artifactsRelocateModule } from "./commands/artifacts-relocate.ts";
/**
 * Public server-administration entrypoint.
 *
 * This is deliberately a positive allowlist instead of a variation of the
 * ordinary client CLI. It owns lifecycle administration, narrow Human-session
 * plumbing, and explicitly reviewed server-domain commands. It is not an auth
 * namespace, raw identity-provider console, or TUI/client workflow.
 */
import type { Argv, CommandModule } from "yargs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { setActiveProfileResolver } from "./lib/cli-session.ts";
import { readActiveProfileName, setCliProfileFlagOverride } from "./lib/profile-aware-server.ts";
import { VERSION, API_VERSION } from "./version.ts";
import { adoptModule } from "./commands/adopt.ts";
import { accessModule } from "./commands/access.ts";
import { backupModule } from "./commands/backup.ts";
import { bootstrapLegacyModule } from "./commands/bootstrap.ts";
import { deployModule } from "./commands/deploy.ts";
import { claimModule } from "./commands/claim.ts";
import { changePasswordModule } from "./commands/change-password.ts";
import { destroyModule } from "./commands/destroy.ts";
import { hostModule } from "./commands/host.ts";
import { logsModule } from "./commands/logs.ts";
import { loginModule } from "./commands/login.ts";
import { logoutModule } from "./commands/logout.ts";
import { membersModule } from "./commands/members.ts";
import { migrateArtifactsToVolumeModule } from "./commands/migrate-artifacts-to-volume.ts";
import { migrateMediaToVolumeModule } from "./commands/migrate-media-to-volume.ts";
import { profileModule } from "./commands/profile.ts";
import { releaseModule } from "./commands/release.ts";
import { restartModule } from "./commands/restart.ts";
import { restoreModule } from "./commands/restore.ts";
import { statusModule } from "./commands/status.ts";
import { selfUpdateModule } from "./commands/self-update.ts";
import { securityModule } from "./commands/security.ts";
import { serverSettingsModule } from "./commands/server-settings.ts";
import { integrationsModule } from "./commands/integrations.ts";
import { upgradeModule } from "./commands/upgrade.ts";
import { whoamiModule } from "./commands/whoami.ts";
import { renderServerAdminError, type ServerAdminFormat } from "./lib/server-admin-output.ts";

/**
 * The public operator contract. Keep this list in command-registration order
 * so release review can compare help output and the executable surface.
 */
export const SERVER_ADMIN_COMMAND_ALLOWLIST = [
  "profile add|use|current|list|remove|set",
  "login",
  "logout",
  "whoami",
  "change-password",
  "members invite|provision|rollout plan|apply|status|resume|list|show|disable|enable|reset-password|remove",
  "access catalogue|effective|change plan|apply",
  "security posture|audit|approvals list|revoke",
  "settings models|context|stenographer|profile",
  "integrations providers|connections list|audit|set|remove|mcp list|tools|check|enable|disable|tool|google status|configure|remove",
  "status",
  "self-update",
  "deploy",
  "claim resume",
  "adopt",
  "bootstrap legacy",
  "restart",
  "logs",
  "upgrade",
  "release plan",
  "backup",
  "restore",
  "destroy",
  "migrate-artifacts-to-volume",
  "artifacts-relocate",
  "migrate-media-to-volume",
  "host adopt|plan|deploy|upgrade|resume|inspect|destroy",
] as const;

// yargs accepts a mutable module array even though this constant is never
// mutated after construction.
const SERVER_ADMIN_MODULES: CommandModule[] = [
  profileModule,
  loginModule,
  logoutModule,
  whoamiModule,
  changePasswordModule,
  membersModule,
  accessModule,
  securityModule,
  serverSettingsModule,
  integrationsModule,
  statusModule,
  selfUpdateModule,
  deployModule,
  claimModule,
  adoptModule,
  bootstrapLegacyModule,
  restartModule,
  logsModule,
  upgradeModule,
  releaseModule,
  backupModule,
  restoreModule,
  destroyModule,
  migrateArtifactsToVolumeModule,
  artifactsRelocateModule,
  migrateMediaToVolumeModule,
  hostModule,
];

export const SERVER_ADMIN_VERSION = `nautilo ${VERSION} (api ${API_VERSION})`;

export interface ServerAdminCliDependencies {
  /** Defaults to the process command line with the executable removed. */
  readonly argv?: readonly string[];
  /** Test seam; production uses the active profile resolver. */
  readonly readActiveProfileName?: () => string | undefined;
  /** Test seam; production writes ordinary CLI output. */
  readonly writeStdout?: (value: string) => void;
  /** Test seam; production writes ordinary CLI errors. */
  readonly writeStderr?: (value: string) => void;
  /** Test seam; production records a shell-compatible process exit code. */
  readonly setExitCode?: (code: number) => void;
}

class ServerAdminParseFailure extends Error {
  constructor() {
    super("server-admin-parse-failure");
    this.name = "ServerAdminParseFailure";
  }
}

function commandLine(input: ServerAdminCliDependencies): readonly string[] {
  return input.argv ?? hideBin(process.argv);
}

/** Read only the reviewed format switch; never reflect arbitrary argv text. */
export function requestedServerAdminFormat(argv: readonly string[]): ServerAdminFormat {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--format=json") return "json";
    if (value === "--format" && argv[index + 1] === "json") return "json";
    if (value === "--format=jsonl") return "jsonl";
    if (value === "--format" && argv[index + 1] === "jsonl") return "jsonl";
  }
  return "human";
}

/**
 * Build the parser without executing it. This makes the shipped command graph
 * auditable and lets release qualification exercise help/version/no-arg paths
 * without running an operator mutation.
 */
export function createServerAdminCli(
  input: ServerAdminCliDependencies = {},
): Argv {
  const writeStdout = input.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = input.writeStderr ?? ((value: string) => process.stderr.write(value));
  const setExitCode = input.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const format = requestedServerAdminFormat(commandLine(input));
  let parseFailed = false;

  setActiveProfileResolver(input.readActiveProfileName ?? readActiveProfileName);

  const cli = yargs(commandLine(input))
    .scriptName("nautilo")
    .version(SERVER_ADMIN_VERSION)
    .alias("v", "version")
    .strict()
    .exitProcess(false)
    .option("server", {
      type: "string",
      global: true,
      describe: "Server URL (overrides NAUTILO_SERVER_URL)",
    })
    .option("profile", {
      type: "string",
      global: true,
      describe: "Deployment profile name (overrides ~/.nautilo/profiles/.active)",
    })
    .middleware((argv) => {
      const profile = argv["profile"];
      setCliProfileFlagOverride(typeof profile === "string" ? profile : undefined);
    }, true)
    .command(SERVER_ADMIN_MODULES)
    .command(
      "$0",
      "Print server-administration help.",
      () => {},
      () => {
        if (parseFailed) return;
        cli.showHelp((help) => writeStdout(`${help}\n`));
        setExitCode(0);
      },
    )
    .help()
    .alias("h", "help")
    .epilogue(`${SERVER_ADMIN_VERSION}
Server administration for Nautilo Compose and hosting drivers.

Start here:
  Railway (hosted): run \`nautilo host plan --backend railway\`, review it, then run \`nautilo host deploy --backend railway --yes\`.
  Docker Compose: run \`nautilo profile add <name>\`, then \`nautilo deploy --profile <name>\` for the latest signed stable image. Pass \`--image <digest>\` only to select a specific immutable image.
  Quickstart: https://nautilo.ai/docs/operator/quickstart
  Recovery: when first-owner setup is unfinished, deploy prints the exact resume command. Run that command; do not start a second deployment.

Advanced and legacy commands remain available below.`)
    .completion()
    .fail(() => {
      parseFailed = true;
      const rendered = renderServerAdminError(
        format,
        "invalid_command",
        "The command could not be processed safely. Run nautilo --help.",
      );
      if (format === "json" || format === "jsonl") writeStdout(rendered);
      else writeStderr(rendered);
      setExitCode(2);
      // A yargs fail hook that returns normally can still enter the selected
      // async handler (for example, after an option conflict), producing a
      // second success/error document. Throw a private sentinel after the one
      // reviewed envelope so parsing stops without exposing yargs/Error text.
      throw new ServerAdminParseFailure();
    });

  return cli;
}

export async function runServerAdminCli(
  input: ServerAdminCliDependencies = {},
): Promise<void> {
  try {
    await createServerAdminCli(input).parseAsync();
  } catch (error) {
    if (error instanceof ServerAdminParseFailure) return;
    throw error;
  }
}

if (import.meta.main) {
  runServerAdminCli().catch(() => {
    const format = requestedServerAdminFormat(hideBin(process.argv));
    const rendered = renderServerAdminError(
      format,
      "invalid_command",
      "The command could not be processed safely. Run nautilo --help.",
    );
    if (format === "json" || format === "jsonl") process.stdout.write(rendered);
    else process.stderr.write(rendered);
    process.exitCode = 2;
  });
}
