import type { CommandModule } from "yargs";
import { NautiloApiClient } from "@nautilo/api-client";
import { detectHeadless, openUrlInDefaultBrowser } from "@nautilo/cli-auth";
import { apiClientOptionsFor, resolveServerForCommand } from "../lib/profile-aware-server.ts";

/**
 * `nautilo auth restore-password` — point the user at Logto's hosted
 * `/forgot-password` page in the browser (or print the URL on
 * `--remote` / headless). Uses the retained recovery endpoint at
 * retained password-recovery clients.
 *
 * The CLI does NOT accept a password from the user — Nautilo's policy
 * is that the terminal never sees credentials. Logto's hosted page
 * handles whatever recovery mechanism Logto OSS supports (operator-
 * minted reset URL with a one-time-token; SMTP-backed recovery if
 * wired). Validating Nautilo-side recovery codes and minting a Logto
 * reset URL on success is tracked separately in [M110].
 */
export const restorePasswordModule: CommandModule = {
  command: "restore-password",
  describe: "Open Logto's hosted password-reset page (no in-CLI password entry)",
  builder: (yargs) =>
    yargs
      .option("server", {
        type: "string",
        describe: "Server URL (overrides NAUTILO_SERVER_URL and active profile)",
      })
      .option("remote", {
        type: "boolean",
        default: false,
        describe: "Print the URL instead of opening a browser",
      }),
  handler: async (argv) => {
    try {
      const transport = await resolveServerForCommand({
        serverFlag: argv["server"] as string | undefined,
      });
      const api = new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport));
      const health = await api.getHealth();
      const endpoint = health.logtoEndpoint;
      if (!endpoint) {
        process.stderr.write("Server has no Logto endpoint configured.\n");
        process.exitCode = 2;
        return;
      }
      const url = new URL("/forgot-password", endpoint).toString();
      const remote = argv["remote"] === true;
      const headless = detectHeadless(process.env).headless;

      if (remote || headless) {
        process.stdout.write(`Open this URL on a device with a browser:\n\n  ${url}\n\n`);
      } else {
        openUrlInDefaultBrowser(url);
        process.stdout.write(`Opened Logto's password-reset page in your browser:\n\n  ${url}\n\n`);
      }
      process.stdout.write(
        "After resetting, run `nautilo login` to sign in with your new password.\n",
      );
      process.exitCode = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`${msg}\n`);
      process.exitCode = 2;
    }
  },
};
