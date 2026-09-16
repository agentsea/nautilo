import type { CommandModule } from "yargs";
import { NautiloApiClient } from "@nautilo/api-client";
import {
  CliSessionExpiredError,
  CliSessionMissingError,
  requireSessionForActiveProfile,
} from "../lib/cli-session.ts";
import { readLine } from "../lib/prompts.ts";
import { apiClientOptionsFor, resolveServerForCommand } from "../lib/profile-aware-server.ts";

const statusModule: CommandModule = {
  command: "status",
  describe: "Show recovery-code status for the signed-in account",
  builder: (yargs) =>
    yargs
      .option("format", {
        type: "string",
        choices: ["human", "json"] as const,
        default: "human",
        describe: "Output format",
      })
      .option("server", {
        type: "string",
        describe: "Server URL (overrides NAUTILO_SERVER_URL and active profile)",
      }),
  handler: async (argv) => {
    try {
      const session = await requireSessionForActiveProfile();
      const transport = await resolveServerForCommand({
        serverFlag: argv["server"] as string | undefined,
      });
      const api = new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport));
      api.setToken(session.accessToken);
      const s = await api.getLogtoRecoveryCodeStatus();
      if (argv["format"] === "json") {
        process.stdout.write(`${JSON.stringify(s)}\n`);
      } else if (s.total === 0) {
        process.stdout.write(
          "Recovery codes: not configured. Run `nautilo recovery-codes regenerate` to mint a fresh set.\n",
        );
      } else {
        const last =
          s.lastGeneratedAt && s.lastGeneratedAt.length > 0 ? s.lastGeneratedAt : "never";
        process.stdout.write(
          `Recovery codes: configured (${s.remaining} of ${s.total} remaining)\n`,
        );
        process.stdout.write(`Last regenerated: ${last}\n`);
      }
      process.exitCode = 0;
    } catch (e) {
      if (e instanceof CliSessionMissingError || e instanceof CliSessionExpiredError) {
        process.stderr.write("Run `nautilo login` first.\n");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`${msg}\n`);
      }
      process.exitCode = 2;
    }
  },
};

const generateModule: CommandModule = {
  command: "generate",
  aliases: ["regenerate"],
  describe: "Mint a new set of recovery codes (invalidates any existing codes)",
  builder: (yargs) =>
    yargs
      .option("yes", {
        type: "boolean",
        default: false,
        describe: "Skip interactive confirmation",
      })
      .option("format", {
        type: "string",
        choices: ["human", "json"] as const,
        default: "human",
        describe: "Output format",
      })
      .option("server", {
        type: "string",
        describe: "Server URL (overrides NAUTILO_SERVER_URL and active profile)",
      }),
  handler: async (argv) => {
    try {
      const session = await requireSessionForActiveProfile();
      const transport = await resolveServerForCommand({
        serverFlag: argv["server"] as string | undefined,
      });
      const api = new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport));
      api.setToken(session.accessToken);

      if (argv["yes"] !== true) {
        if (!process.stdin.isTTY) {
          process.stderr.write("Refusing to regenerate non-interactively without --yes.\n");
          process.exitCode = 2;
          return;
        }
        process.stdout.write(
          "Warning: this invalidates any existing recovery codes. They will stop working immediately.\n",
        );
        const line = (await readLine("Continue? [y/N]: ")).trim().toLowerCase();
        const ok = line === "y" || line === "yes";
        if (!ok) {
          process.stderr.write("Aborted.\n");
          process.exitCode = 2;
          return;
        }
      }

      const result = await api.regenerateLogtoRecoveryCodes();
      if (argv["format"] === "json") {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        const codes = result.recoveryCodes;
        const n = codes.length;
        process.stdout.write(
          `Generated ${n} recovery codes. Save them now — they cannot be recovered:\n\n`,
        );
        codes.forEach((c, i) => {
          process.stdout.write(`  ${i + 1}. ${c}\n`);
        });
        process.stdout.write(
          "\nUse one with `nautilo restore-password` to set a new password. Each code is single-use.\n",
        );
      }
      process.exitCode = 0;
    } catch (e) {
      if (e instanceof CliSessionMissingError || e instanceof CliSessionExpiredError) {
        process.stderr.write("Run `nautilo login` first.\n");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`${msg}\n`);
      }
      process.exitCode = 2;
    }
  },
};

export const recoveryCodesModule: CommandModule = {
  command: "recovery-codes",
  describe: "Manage account recovery codes for the signed-in account",
  builder: (yargs) =>
    yargs
      .command(statusModule)
      .command(generateModule)
      .demandCommand(1, "Specify status or generate"),
  handler: () => {},
};
