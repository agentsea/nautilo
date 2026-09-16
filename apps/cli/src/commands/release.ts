import type { CommandModule } from "yargs";

import { runComposeVerb } from "../lib/run-compose-verb.ts";
import type { ComposeDriverProfile } from "@nautilo/compose-driver";
import { resolveStableRuntimeImage } from "../lib/stable-runtime-image.ts";

/**
 * `release plan` is a read-only preview of the canonical default upgrade
 * artifact: the immutable public image selected by the signed stable release
 * manifest. Artifact strategy is invocation-scoped (D420), so the plan surface
 * resolves a request-scoped profile rather than reading persisted strategy
 * state. It never mutates: no backup, deploy, health, or rollback.
 * The single mutation command is `nautilo upgrade` (D420 1.2.1).
 */
function planProfile(profile: ComposeDriverProfile, imageRef: string): ComposeDriverProfile {
  return { ...profile, from_source: false, image_ref: imageRef };
}

const releasePlanModule: CommandModule = {
  command: "plan",
  describe:
    "Read-only plan of the default server-only release artifact and its auth compatibility preflight",
  handler: async (argv) => {
    await runComposeVerb(argv, async (profile, driver) => {
      const imageRef = await resolveStableRuntimeImage();
      const plan = await driver.releasePlan(planProfile(profile, imageRef));
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    });
  },
};

/**
 * Read-only release planning surface. `plan` is the only subcommand: it
 * previews the incoming artifact and auth contract without mutating. The
 * `release apply` command was removed in D420 1.2.1 — the single mutation
 * path is `nautilo upgrade`.
 */
export const releaseModule: CommandModule = {
  command: "release",
  describe:
    "Read-only release planning surface (use `nautilo upgrade` to apply a release)",
  builder: (yargs) =>
    yargs
      .command(releasePlanModule)
      .demandCommand(1, "Specify a release subcommand (plan); use `nautilo upgrade` to apply a release"),
  handler: () => {},
};
