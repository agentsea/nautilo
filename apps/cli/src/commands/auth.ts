/**
 * M108 — `nautilo auth` group: collects every identity-touching verb under
 * a single namespace. `login` and `logout` are ALSO registered at the
 * top level (in `src/index.ts`) for muscle-memory ergonomics; every other
 * verb lives only here.
 */
import type { CommandModule } from "yargs";
import { loginModule } from "./login.ts";
import { logoutModule } from "./logout.ts";
import { whoamiModule } from "./whoami.ts";
import { changePasswordModule } from "./change-password.ts";
import { restorePasswordModule } from "./restore-password.ts";
import { recoveryCodesModule } from "./recovery-codes.ts";
import { runComposeVerb } from "../lib/run-compose-verb.ts";

const authPlanModule: CommandModule = {
  command: "plan",
  describe:
    "Read-only auth compatibility plan for the selected compose profile",
  handler: async (argv) => {
    await runComposeVerb(argv, async (profile, driver) => {
      const plan = await driver.authPlan(profile);
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    });
  },
};

const authReconcileModule: CommandModule = {
  command: "reconcile",
  describe:
    "Explicitly reconcile managed Logto state after a full backup; requires session-impact confirmation",
  builder: (yargs) =>
    yargs.option("confirm-session-impact", {
      type: "boolean",
      default: false,
      describe:
        "Required acknowledgement: reconciliation may affect existing sessions",
    }),
  handler: async (argv) => {
    await runComposeVerb(argv, async (profile, driver) => {
      const result = await driver.authReconcile(profile, {
        confirmSessionImpact: argv["confirm-session-impact"] === true,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
  },
};

export const authModule: CommandModule = {
  command: "auth",
  describe:
    "Identity: login, logout, whoami, change/restore password, recovery codes, auth plans",
  builder: (yargs) =>
    yargs
      .command(loginModule)
      .command(logoutModule)
      .command(whoamiModule)
      .command(changePasswordModule)
      .command(restorePasswordModule)
      .command(recoveryCodesModule)
      .command(authPlanModule)
      .command(authReconcileModule)
      .demandCommand(
        1,
        "Specify an auth subcommand (login / logout / whoami / change-password / restore-password / recovery-codes / plan / reconcile)",
      ),
  handler: () => {},
};
