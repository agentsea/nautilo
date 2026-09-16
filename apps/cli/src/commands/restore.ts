import type { CommandModule } from "yargs";

import { runComposeVerb } from "../lib/run-compose-verb.ts";

export const restoreModule: CommandModule = {
  command: "restore [path]",
  describe: "Restore a bundle directory or legacy postgres backup artifact",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        describe: "Path to a backup bundle directory or legacy .sql.gz",
      })
      .option("from", {
        type: "string",
        describe: "Alias for <path> (kept for legacy scripts)",
      })
      .option("force", {
        type: "boolean",
        default: false,
        describe: "Overwrite a healthy setupState=ready stack",
      })
      .option("data-only", {
        type: "boolean",
        default: false,
        describe: "Skip disaster-recovery bring-up and load only databases",
      })
      .option("artifacts-only", {
        type: "boolean",
        default: false,
        describe: "Load only persistent byte volumes (artifacts and durable media) from the bundle",
      })
      .option("stream", {
        type: "boolean",
        default: false,
        describe: "Remote restore fallback: stream instead of rsync staging",
      })
      .example("$0 restore ./nautilo-backup", "Restore a full recovery bundle.")
      .example("$0 restore ./nautilo-backup --force", "Replace an otherwise healthy server from a recovery bundle."),
  handler: async (argv) => {
    const positionalPath =
      typeof argv["path"] === "string" ? argv["path"].trim() : "";
    const from = typeof argv["from"] === "string" ? argv["from"].trim() : "";
    const path = positionalPath || from;
    if (!path) {
      process.stderr.write("restore requires <path> or --from <path>\n");
      process.exitCode = 2;
      return;
    }
    const force = argv["force"] === true;
    const mode =
      argv["artifacts-only"] === true
        ? "artifacts-only"
        : argv["data-only"] === true
          ? "data-only"
          : "full";
    const stream = argv["stream"] === true;
    await runComposeVerb(argv, async (_profile, _driver, lifecycle) => {
      await lifecycle.restore({ fromPath: path, force, mode, stream });
    });
  },
};
