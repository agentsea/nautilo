import type { CommandModule } from "yargs";

import { runComposeVerb } from "../lib/run-compose-verb.ts";

export const logsModule: CommandModule = {
  command: "logs",
  describe: "Tail docker compose logs for the local-compose stack",
  builder: (yargs) =>
    yargs
      .option("follow", {
        alias: "f",
        type: "boolean",
        default: false,
        describe: "Follow log output",
      })
      .option("service", {
        type: "string",
        describe: "Compose service name (optional)",
      }),
  handler: async (argv) => {
    const follow = argv["follow"] === true;
    const serviceRaw =
      typeof argv["service"] === "string" ? argv["service"].trim() : "";
    const logsOpts = serviceRaw
      ? { follow, service: serviceRaw }
      : { follow };
    await runComposeVerb(argv, async (profile, driver) => {
      await driver.logs(profile, logsOpts);
    });
  },
};
