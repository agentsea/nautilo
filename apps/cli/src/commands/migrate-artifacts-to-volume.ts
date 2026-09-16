import type { CommandModule } from "yargs";

import { runComposeVerb } from "../lib/run-compose-verb.ts";

export const migrateArtifactsToVolumeModule: CommandModule = {
  command: "migrate-artifacts-to-volume",
  describe:
    "One-time: copy artifact bytes from an older running server into the app_artifacts volume before deploying a volume-backed configuration",
  handler: async (argv) => {
    await runComposeVerb(argv, async (profile, driver) => {
      await driver.migrateArtifactsToVolume(profile);
    });
  },
};
