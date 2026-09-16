import type { CommandModule } from "yargs";

import { runComposeVerb } from "../lib/run-compose-verb.ts";

export const adoptModule: CommandModule = {
  command: "adopt",
  describe:
    "Validate a running legacy remote source Compose install and optionally attach its deployment manifest",
  builder: (yargs) =>
    yargs
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "Inspect only; never write a deployment manifest",
      })
      .option("confirm", {
        type: "boolean",
        default: false,
        describe: "After successful validation, atomically write the v2 source-mode manifest",
      })
      .option("bundle", {
        type: "string",
        describe:
          "Path to a verified recovery bundle (required with --confirm; verified before any manifest write)",
      })
      .check((argv) => {
        if (argv["dry-run"] === true && argv["confirm"] === true) {
          throw new Error("--dry-run and --confirm cannot be used together");
        }
        return true;
      }),
  handler: async (argv) => {
    const bundlePath =
      typeof argv["bundle"] === "string" ? argv["bundle"].trim() : undefined;
    const confirm = argv["confirm"] === true;
    await runComposeVerb(argv, async (profile, driver) => {
      await driver.adopt(profile, {
        dryRun: argv["dry-run"] === true || confirm !== true,
        confirm,
        // --bundle is only meaningful for --confirm; dry-run never verifies
        // or reads the bundle (mutation-free).
        ...(confirm && bundlePath ? { bundlePath } : {}),
      });
    });
  },
};
