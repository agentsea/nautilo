import type { CommandModule } from "yargs";

import { runComposeVerb } from "../lib/run-compose-verb.ts";

export const bootstrapLegacyModule: CommandModule = {
  command: "bootstrap legacy",
  describe:
    "Plan or explicitly convert a legacy remote Compose installation into the resumable registry deployment",
  builder: (yargs) =>
    yargs
      .option("plan", {
        type: "boolean",
        default: false,
        describe: "Read-only inspection (the default unless both confirmation flags are supplied)",
      })
      .option("confirm-adoption", {
        type: "boolean",
        default: false,
        describe: "Approve writing the verified legacy adoption manifest",
      })
      .option("confirm-deploy", {
        type: "boolean",
        default: false,
        describe: "Approve remote materialization and the pinned registry deployment",
      })
      .option("bundle", {
        type: "string",
        describe: "Path to the verified recovery bundle (required for confirmed conversion)",
      })
      .option("image", {
        type: "string",
        describe:
          "Full immutable registry reference (required for confirmed conversion; reported in plan mode)",
      })
      .check((argv) => {
        if (
          argv["plan"] === true &&
          (argv["confirm-adoption"] === true || argv["confirm-deploy"] === true)
        ) {
          throw new Error("--plan cannot be combined with confirmation flags");
        }
        return true;
      }),
  handler: async (argv) => {
    const confirmAdoption = argv["confirm-adoption"] === true;
    const confirmDeploy = argv["confirm-deploy"] === true;
    const plan = argv["plan"] === true || (!confirmAdoption && !confirmDeploy);
    const bundlePath = typeof argv["bundle"] === "string" ? argv["bundle"].trim() : undefined;
    const imageRef = typeof argv["image"] === "string" ? argv["image"].trim() : undefined;
    await runComposeVerb(argv, async (profile, driver) => {
      await driver.bootstrapLegacy(profile, {
        plan,
        confirmAdoption,
        confirmDeploy,
        ...(bundlePath ? { bundlePath } : {}),
        ...(imageRef ? { imageRef } : {}),
      });
    });
  },
};
