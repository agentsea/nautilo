import type { CommandModule } from "yargs";
import { runComposeVerb } from "../lib/run-compose-verb.ts";

export const authPlanModule: CommandModule = {
  command: "plan",
  describe: "Read-only auth compatibility plan for the selected compose profile",
  handler: async (argv) => {
    await runComposeVerb(argv, async (profile, driver) => {
      const plan = await driver.authPlan(profile);
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    });
  },
};

export const authReconcileModule: CommandModule = {
  command: "reconcile",
  describe:
    "Reconcile managed authentication after a full backup; requires session-impact confirmation",
  builder: (yargs) =>
    yargs.option("confirm-session-impact", {
      type: "boolean",
      default: false,
      describe: "Required acknowledgement: reconciliation may affect existing sessions",
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

/** Managed Compose maintenance only, not the legacy identity-provider console. */
export const authMaintenanceModule: CommandModule = {
  command: "auth",
  describe: "Plan and explicitly reconcile managed Compose authentication",
  builder: (yargs) => yargs
    .command(authPlanModule)
    .command(authReconcileModule)
    .demandCommand(1, "Specify an auth maintenance subcommand (plan / reconcile)"),
  handler: () => {},
};
