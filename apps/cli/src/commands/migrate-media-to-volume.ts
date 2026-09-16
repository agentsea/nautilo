import type { CommandModule } from "yargs";

import { runComposeVerb } from "../lib/run-compose-verb.ts";

export const migrateMediaToVolumeModule: CommandModule = {
  command: "migrate-media-to-volume",
  describe:
    "One-time: copy custom avatar and server-icon bytes from a running pre-volume nautilo-server into the app_media volume (run BEFORE deploying the media-volume template)",
  handler: async (argv) => {
    await runComposeVerb(argv, async (profile, driver) => {
      await driver.migrateMediaToVolume(profile);
    });
  },
};
