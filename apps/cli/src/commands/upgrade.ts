import type { CommandModule } from "yargs";
import { buildRegistryImageRef } from "@nautilo/compose-driver";

import { buildUpgradeDoctor } from "../lib/compose-driver-factory.ts";
import { runComposeVerb } from "../lib/run-compose-verb.ts";
import { resolveStableRuntimeImage } from "../lib/stable-runtime-image.ts";

const WAIT_FOR_RE = /^(\d+)(ms|s|m|h)$/;
const DEFAULT_WAIT_FOR_MS = 5 * 60 * 1000;

function parseWaitForMs(value: unknown): number {
  if (value === undefined) return DEFAULT_WAIT_FOR_MS;
  const raw = typeof value === "string" ? value.trim() : "";
  const match = WAIT_FOR_RE.exec(raw);
  if (!match) {
    throw new Error("--wait-for must be a positive duration such as 30s, 5m, or 1h.");
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("--wait-for must be a positive duration.");
  }
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1000 : match[2] === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}

export const upgradeModule: CommandModule = {
  command: "upgrade",
  describe:
    "Safe upgrade: drain -> stop -> consistent backup -> deploy -> health -> auto-rollback. Defaults to server-only ready-image replacement.",
  builder: (yargs) =>
    yargs
      .option("from-sources", {
        type: "boolean",
        default: false,
        describe: "Build the incoming server artifact from source",
      })
      .option("image", {
        type: "string",
        describe: "Approved ghcr.io/agentsea/nautilo-runtime-v2 manifest digest (mutually exclusive with --from-sources)",
      })
      .option("full", {
        type: "boolean",
        default: false,
        describe: "Replace the full Compose stack instead of only nautilo-server",
      })
      .option("wait-for", {
        type: "string",
        describe: "Drain deadline (default 5m; Wave 2 enforces the maintenance wait)",
      })
      .option("no-rollback", {
        type: "boolean",
        default: false,
        describe:
          "On failure, leave the broken stack + bundle for manual inspection (no auto-restore)",
      })
      .option("allow-artifact-loss", {
        type: "boolean",
        default: false,
        describe: "Override the artifact/media persistent-volume migration guard",
      })
      .option("backup-dir", {
        type: "string",
        describe:
          "Directory for the auto pre-upgrade backup bundle (default ~/.nautilo<suffix>/backups). A timestamped auto-pre-upgrade-<stamp>/ subdir is created inside it.",
      })
      .example("$0 upgrade", "Safely upgrade the server to the latest signed stable image.")
      .example("$0 upgrade --image <digest>", "Safely upgrade to a specific approved immutable image."),
  handler: async (argv) => {
    const backupDir =
      typeof argv["backup-dir"] === "string" ? argv["backup-dir"].trim() : "";
    const imageRef = typeof argv["image"] === "string" ? argv["image"].trim() : "";
    const fromSources = argv["from-sources"] === true;
    const waitForMs = parseWaitForMs(argv["wait-for"]);
    let selectedImageRef: string | undefined;
    await runComposeVerb(
      argv,
      async (_profile, _driver, lifecycle) => {
        await lifecycle.upgrade({
          artifact: fromSources ? "source" : "image",
          ...(selectedImageRef ? { imageRef: selectedImageRef } : {}),
          scope: argv["full"] === true ? "full" : "server-only",
          waitForMs,
          noRollback: argv["no-rollback"] === true,
          allowArtifactLoss: argv["allow-artifact-loss"] === true,
          ...(backupDir ? { backupDir } : {}),
        });
      },
      { doctor: buildUpgradeDoctor() },
      {
        beforeDriver: async () => {
          if (fromSources && imageRef) {
            throw new Error("--from-sources and --image cannot be used together.");
          }
          if (!fromSources) {
            selectedImageRef = imageRef
              ? buildRegistryImageRef(imageRef)
              : await resolveStableRuntimeImage();
          }
        },
      },
    );
  },
};
