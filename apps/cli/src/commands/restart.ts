import type { CommandModule } from "yargs";

import { runComposeVerb } from "../lib/run-compose-verb.ts";

export const restartModule: CommandModule = {
  command: "restart",
  describe:
    "Restart nautilo-server. Use --full after a host reboot to resume existing images, then restart all services and refresh Docker DNS.",
  builder: (yargs) =>
    yargs.option("full", {
      type: "boolean",
      default: false,
      describe:
        "Recovery: resume existing auth + app images, then restart all services to refresh Docker DNS; no builds, pulls, backups, migrations, or image changes",
    })
      .example("$0 restart", "Restart the server service for the active profile.")
      .example("$0 restart --full", "After a host reboot, restart all existing services without changing images."),
  handler: async (argv) => {
    await runComposeVerb(argv, async (profile, driver) => {
      if (argv["full"] === true) {
        await driver.restart(profile, { full: true });
        return;
      }
      await driver.restart(profile);
    });
  },
};
