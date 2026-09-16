import type { CommandModule } from "yargs";
import { ApiError } from "@nautilo/api-client";
import { detectHeadless, openUrlInDefaultBrowserChecked } from "@nautilo/cli-auth";
import {
  AuthenticatedAdminClientError,
  createRestrictedPasswordChangeClient,
  type RestrictedPasswordChangeClient,
} from "../lib/authenticated-admin-client.ts";
import { readHiddenLine } from "../lib/host-provider-prompt.ts";
import {
  writeServerAdminError,
  writeServerAdminSuccess,
  type ServerAdminFormat,
} from "../lib/server-admin-output.ts";

function logtoPasswordUrl(endpoint: string): string {
  // Logto OSS serves password management at `/account/password`. Validate and
  // normalize the configured origin before exposing it to the operator.
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AuthenticatedAdminClientError("invalid_server_response");
  }
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname)))
  ) {
    throw new AuthenticatedAdminClientError("invalid_server_response");
  }
  return new URL("/account/password", url.origin).toString();
}

async function waitForEnter(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.on("data", onData);
  });
}

export interface ChangePasswordDependencies {
  authenticate(input: { serverFlag?: string | undefined }): Promise<RestrictedPasswordChangeClient>;
  readHidden(prompt: string): Promise<string>;
  isStdinTty(): boolean;
  isStderrTty(): boolean;
  isHeadless(): boolean;
  openUrl(url: string): void | Promise<void>;
  waitForEnter(): Promise<void>;
}

const DEFAULT_DEPENDENCIES: ChangePasswordDependencies = {
  authenticate: (input) => createRestrictedPasswordChangeClient(input),
  readHidden: readHiddenLine,
  isStdinTty: () => process.stdin.isTTY === true,
  isStderrTty: () => process.stderr.isTTY === true,
  isHeadless: () => detectHeadless(process.env).headless,
  openUrl: openUrlInDefaultBrowserChecked,
  waitForEnter,
};

function stableError(error: unknown): { code: string; message: string } {
  if (error instanceof AuthenticatedAdminClientError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ApiError && error.status === 422) {
    return { code: "wrong_current_password", message: "The current password was rejected." };
  }
  if (error instanceof ApiError && error.status === 400) {
    return { code: "password_policy_rejected", message: "The new password does not satisfy server policy." };
  }
  return { code: "password_change_failed", message: "The password change could not be completed safely." };
}

export function createChangePasswordModule(
  overrides: Partial<ChangePasswordDependencies> = {},
): CommandModule {
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return {
    command: "change-password",
    describe: "Complete a required temporary-password rotation or open Logto account settings.",
    builder: (yargs) => yargs
    .option("server", {
      type: "string",
      describe: "Server URL (overrides NAUTILO_SERVER_URL and active profile)",
    })
    .option("remote", {
      type: "boolean",
      default: false,
      describe: "Print the hosted Logto URL instead of opening a browser when no forced change is pending",
    })
    .option("format", {
      type: "string",
      choices: ["human", "json"] as const,
      default: "human",
    }),
    handler: async (argv) => {
    const format: ServerAdminFormat = argv["format"] === "json" ? "json" : "human";
    try {
      const client = await deps.authenticate({
        serverFlag: argv["server"] as string | undefined,
      });

      if (client.whoami.mustChangePassword) {
        if (!deps.isStdinTty() || !deps.isStderrTty()) {
          writeServerAdminError(
            format,
            "interactive_required",
            "A terminal is required to change a temporary password securely.",
          );
          process.exitCode = 2;
          return;
        }
        const currentPassword = await deps.readHidden("Temporary password (input hidden): ");
        const newPassword = await deps.readHidden("New password (input hidden): ");
        const confirmPassword = await deps.readHidden("Confirm new password (input hidden): ");
        if (newPassword !== confirmPassword) {
          writeServerAdminError(format, "password_confirmation_mismatch", "The new password confirmation did not match.");
          process.exitCode = 2;
          return;
        }
        await client.api.changePassword({ currentPassword, newPassword, confirmPassword });
        writeServerAdminSuccess(
          format,
          { passwordChanged: true, restrictionCleared: true },
          ["Password changed. The restricted first-use gate is cleared."],
        );
        process.exitCode = 0;
        return;
      }

      if (format === "json") {
        writeServerAdminError(
          format,
          "interactive_required",
          "Hosted password settings are an interactive Human flow.",
        );
        process.exitCode = 2;
        return;
      }

      const health = await client.api.getHealth();
      const endpoint = health.logtoEndpoint;
      if (!endpoint) throw new Error("logto_unavailable");
      const url = logtoPasswordUrl(endpoint);
      const remote = argv["remote"] === true || deps.isHeadless();
      if (remote) {
        process.stdout.write(`Open this URL on a device with a browser:\n\n  ${url}\n\n`);
      } else {
        await deps.openUrl(url);
        process.stdout.write("Opened Logto password settings in your browser.\n");
      }
      if (deps.isStdinTty()) {
        process.stdout.write("Press Enter when done, or Ctrl-C to cancel.\n");
        await deps.waitForEnter();
      }
      writeServerAdminSuccess(format, { hostedPasswordSettingsOpened: true }, ["Password settings flow completed."]);
      process.exitCode = 0;
    } catch (error) {
      const stable = stableError(error);
      writeServerAdminError(format, stable.code, stable.message);
      process.exitCode = 2;
    }
    },
  };
}

export const changePasswordModule = createChangePasswordModule();
