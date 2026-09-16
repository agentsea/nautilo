import { dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { CommandModule } from "yargs";
import { relocationPlanSha256, type ArtifactRelocationPlan } from "@nautilo/compose-driver";
import { runComposeVerb } from "../lib/run-compose-verb.ts";

export const artifactsRelocateModule: CommandModule = {
  command: "artifacts-relocate <mode>",
  describe: "Plan, apply or roll back exact physical artifact references after storage relocation",
  builder: yargs => yargs
    .positional("mode", { choices: ["plan", "apply", "rollback"] as const, demandOption: true })
    .option("from-root", { type: "string", describe: "Original absolute artifact root (plan only)" })
    .option("backup", { type: "string", describe: "Verified original full recovery bundle (plan only)" })
    .option("plan", { type: "string", demandOption: true, describe: "Owner-only local plan file; plan creates it without overwriting" })
    .option("sha256", { type: "string", describe: "Exact reviewed plan digest (apply or rollback)" }),
  handler: async argv => {
    const mode = argv["mode"];
    const planPath = argv["plan"];
    if (typeof planPath !== "string") throw new Error("A plan file is required");
    await runComposeVerb(argv, async (profile, driver) => {
      if (mode === "plan") {
        if (typeof argv["from-root"] !== "string" || typeof argv["backup"] !== "string" || argv["sha256"] !== undefined) throw new Error("Plan requires --from-root and --backup without --sha256");
        const plan = await driver.relocateArtifacts(profile, { sourceRoot: argv["from-root"], backupPath: argv["backup"] }) as ArtifactRelocationPlan;
        const file = await open(planPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(JSON.stringify(plan, null, 2) + "\n"); await file.sync(); }
        finally { await file.close(); }
        const directory = await open(dirname(resolve(planPath)), constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
        process.stdout.write(JSON.stringify({ outcome: "planned", targetChanged: false, planSha256: relocationPlanSha256(plan), files: plan.files.length }) + "\n");
        return;
      }
      if ((mode !== "apply" && mode !== "rollback") || argv["from-root"] !== undefined || argv["backup"] !== undefined || typeof argv["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(argv["sha256"])) {
        throw new Error("Apply/rollback requires --sha256 and the existing --plan, without --from-root");
      }
      const file = await open(planPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let plan: ArtifactRelocationPlan;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error("Plan must be an owner-owned regular file with mode 0600");
        plan = JSON.parse(await file.readFile("utf8")) as ArtifactRelocationPlan;
      } finally { await file.close(); }
      const result = await driver.relocateArtifacts(profile, { plan, planSha256: argv["sha256"], rollback: mode === "rollback" });
      process.stdout.write(JSON.stringify(result) + "\n");
    });
  },
};
