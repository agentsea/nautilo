import type { CommandModule } from "yargs";
import type { SetupStatusResponse } from "@nautilo/api-client";
import {
  formatSetupStatusHuman,
  NautiloApiClient,
} from "@nautilo/api-client";
import {
  createComposeLifecycleFromDriver,
  unwrapComposeLifecycleError,
} from "@nautilo/compose-lifecycle";
import { createDriverForCli } from "../lib/compose-driver-factory.ts";
import { loadProfile } from "../lib/profile-schema.ts";
import {
  readActiveProfileName,
  resolveServerForCommand,
  withUnixSocket,
  buildAuthHeaders,
  type ResolvedServer,
} from "../lib/profile-aware-server.ts";

/**
 * Fetch setup status using the resolved transport.
 * Uses raw fetch for Unix socket support; falls back to NautiloApiClient for regular HTTP.
 */
async function fetchSetupStatus(
  transport: ResolvedServer,
): Promise<SetupStatusResponse> {
  const url = `${transport.baseUrl.replace(/\/$/, "")}/api/setup/status`;

  // For Unix socket or bearer auth, use raw fetch
  if (transport.unixSocketPath || transport.bearer) {
    const headers = buildAuthHeaders(transport, undefined);
    const init = withUnixSocket(transport, {
      headers,
    });
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as SetupStatusResponse;
  }

  // Use regular API client for plain HTTP
  const client = new NautiloApiClient(transport.baseUrl);
  return await client.getSetupStatus();
}

export const statusModule: CommandModule = {
  command: "status",
  describe:
    "Report Compose state plus best-effort HTTP health for Compose profiles",
  builder: (yargs) =>
    yargs
      .option("server", {
        type: "string",
        describe: "Server URL (overrides NAUTILO_SERVER_URL and active profile)",
      })
      .option("format", {
        type: "string",
        choices: ["human", "json"] as const,
        default: "human",
        describe: "Output format",
      })
      .example("$0 status", "Check the active Compose profile's services and HTTP health.")
      .example("$0 status --format json", "Print status for automation."),
  handler: async (argv) => {
    try {
      const serverFlag = argv["server"] as string | undefined;
      if (!serverFlag?.trim()) {
        const home = process.env["HOME"] ?? "";
        const profileName = readActiveProfileName(home);
        if (profileName) {
          const profile = loadProfile(profileName, home);
          if (profile.lifecycle === "compose") {
            await createComposeLifecycleFromDriver({
              profile,
              driver: createDriverForCli(profile),
            }).inspect();
            process.exitCode = 0;
            return;
          }
        }
      }

      const transport = await resolveServerForCommand({
        serverFlag,
      });

      const body = await fetchSetupStatus(transport);

      if (argv["format"] === "json") {
        process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      } else {
        process.stdout.write(formatSetupStatusHuman(transport.baseUrl, body));
      }
      process.exitCode = body.setupState === "ready" ? 0 : 2;
    } catch (e) {
      const error = unwrapComposeLifecycleError(e);
      const msg = error instanceof Error ? error.message : String(error);
      if (argv["format"] === "json") {
        process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
      } else {
        process.stderr.write(
          `Failed to fetch setup status: ${msg}\n`,
        );
      }
      process.exitCode = 2;
    }
  },
};
