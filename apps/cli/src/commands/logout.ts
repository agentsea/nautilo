import type { CommandModule } from "yargs";
import {
  CliSessionFileModeError,
  CliSessionSecurityError,
} from "@nautilo/api-client";
import {
  dropCliSessionForActiveProfile,
  loadCliSessionForActiveProfile,
} from "../lib/cli-session.ts";
import { readActiveProfileName } from "../lib/profile-aware-server.ts";
import {
  writeServerAdminError,
  writeServerAdminSuccess,
  type ServerAdminFormat,
} from "../lib/server-admin-output.ts";

function formatOf(argv: Record<string, unknown>): ServerAdminFormat {
  return argv["format"] === "json" ? "json" : "human";
}

export const logoutModule: CommandModule = {
  command: "logout",
  describe: "Remove the selected profile's local Human session.",
  builder: (yargs) => yargs.option("format", {
    type: "string",
    choices: ["human", "json"] as const,
    default: "human",
    describe: "Output format",
  }),
  handler: async (argv) => {
    const format = formatOf(argv as Record<string, unknown>);
    const profile = readActiveProfileName();
    let had = false;
    let insecureMode = false;
    try {
      try {
        had = (await loadCliSessionForActiveProfile()) != null;
      } catch (error) {
        // An owned regular file with unsafe mode is still removable.  Do not
        // render its contents or leave it behind merely because it is unsafe.
        if (error instanceof CliSessionFileModeError) insecureMode = true;
        else throw error;
      }
      await dropCliSessionForActiveProfile();
      const message = insecureMode
        ? "Removed an insecure local session file."
        : had
          ? (profile ? `Signed out from ${profile}.` : "Signed out.")
          : "No active session.";
      writeServerAdminSuccess(
        format,
        { ...(profile ? { profile } : {}), removed: had || insecureMode, insecureMode },
        [message],
      );
      process.exitCode = 0;
    } catch (error) {
      const message = error instanceof CliSessionSecurityError
        ? "The local session file was unsafe and was not removed."
        : "The local session could not be removed safely.";
      writeServerAdminError(format, "session_removal_failed", message);
      process.exitCode = 2;
    }
  },
};
