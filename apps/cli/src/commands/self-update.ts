import type { Argv, CommandModule } from "yargs";
import { fetchStableCliRelease, installStableCliRelease, rollbackCliRelease } from "../lib/cli-release.ts";

type Args = { rollback?: boolean; check?: boolean; json?: boolean };
export const selfUpdateModule: CommandModule<object, Args> = {
  command: "self-update",
  describe: "Verify and install the latest signed standalone CLI release, or roll back one installed release.",
  builder: (yargs): Argv<Args> => yargs
    .option("check", { type: "boolean", describe: "Verify the stable manifest without changing the installation" })
    .option("rollback", { type: "boolean", describe: "Atomically activate the previous installed release" })
    .option("json", { type: "boolean", default: false, describe: "Print a machine-readable result" })
    .conflicts("check", "rollback")
    .example("$0 self-update --check", "Check the signed stable release without changing this installation.")
    .example("$0 self-update", "Install the latest signed stable CLI release.")
    .example("$0 self-update --rollback", "Activate the previous installed CLI release.") as Argv<Args>,
  handler: async (argv) => {
    const result = argv.rollback === true
      ? { outcome: "rolled-back", ...rollbackCliRelease() }
      : argv.check === true
        ? { outcome: "available", version: (await fetchStableCliRelease()).manifest.version }
        : { outcome: "installed", ...await installStableCliRelease() };
    process.stdout.write(argv.json === true ? `${JSON.stringify(result)}\n` : `Nautilo CLI ${result.version}: ${result.outcome}.\n`);
  },
};
