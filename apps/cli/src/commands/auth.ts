/**
 * Legacy `nautilo auth` group: collects every identity-touching verb under
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
import { authPlanModule, authReconcileModule } from "./auth-maintenance.ts";

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
