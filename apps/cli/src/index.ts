import { artifactsRelocateModule } from "./commands/artifacts-relocate.ts";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { setActiveProfileResolver } from "./lib/cli-session.ts";
import { readActiveProfileName, setCliProfileFlagOverride } from "./lib/profile-aware-server.ts";
import { VERSION, API_VERSION } from "./version.ts";
import { setupModule } from "./commands/setup.ts";
import { statusModule } from "./commands/status.ts";
import { authModule } from "./commands/auth.ts";
import { loginModule } from "./commands/login.ts";
import { logoutModule } from "./commands/logout.ts";
import { profileModule } from "./commands/profile.ts";
import { inviteModule } from "./commands/invite.ts";
import { doctorModule } from "./commands/doctor.ts";
import { deployModule } from "./commands/deploy.ts";
import { claimModule } from "./commands/claim.ts";
import { adoptModule } from "./commands/adopt.ts";
import { bootstrapLegacyModule } from "./commands/bootstrap.ts";
import { restartModule } from "./commands/restart.ts";
import { logsModule } from "./commands/logs.ts";
import { upgradeModule } from "./commands/upgrade.ts";
import { releaseModule } from "./commands/release.ts";
import { backupModule } from "./commands/backup.ts";
import { restoreModule } from "./commands/restore.ts";
import { destroyModule } from "./commands/destroy.ts";
import { migrateArtifactsToVolumeModule } from "./commands/migrate-artifacts-to-volume.ts";
import { migrateMediaToVolumeModule } from "./commands/migrate-media-to-volume.ts";
import { agentModule } from "./commands/agent.ts";
import { hostModule } from "./commands/host.ts";
import { selfUpdateModule } from "./commands/self-update.ts";

const versionString = `nautilo ${VERSION} (api ${API_VERSION})`;

async function main(): Promise<void> {
  setActiveProfileResolver(() => readActiveProfileName());

  const cli = yargs(hideBin(process.argv))
    .scriptName("nautilo")
    .version(versionString)
    .alias("v", "version")
    .strict()
    .option("server", {
      type: "string",
      global: true,
      describe: "Server URL (overrides NAUTILO_SERVER_URL)",
    })
    .option("profile", {
      type: "string",
      global: true,
      describe: "Profile name for session files (overrides ~/.nautilo/profiles/.active)",
    })
    .middleware((argv) => {
      const p = argv["profile"];
      setCliProfileFlagOverride(typeof p === "string" ? p : undefined);
    }, true)
    .command(setupModule)
    .command(statusModule)
    .command(authModule)
    .command(loginModule)
    .command(logoutModule)
    .command(profileModule)
    .command(inviteModule)
    .command(doctorModule)
    .command(deployModule)
    .command(claimModule)
    .command(adoptModule)
    .command(bootstrapLegacyModule)
    .command(restartModule)
    .command(logsModule)
    .command(upgradeModule)
    .command(releaseModule)
    .command(backupModule)
    .command(restoreModule)
    .command(destroyModule)
    .command(migrateArtifactsToVolumeModule)
    .command(artifactsRelocateModule)
    .command(migrateMediaToVolumeModule)
    .command(agentModule)
    .command(hostModule)
    .command(selfUpdateModule)
    .command(
      "$0",
      "Print administrator command help.",
      () => {},
      () => {
        cli.showHelp();
      },
    )
    .help()
    .alias("h", "help")
    .epilogue(versionString)
    .completion()
    .fail((msg, err) => {
      if (err) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`${msg}\n`);
      process.exitCode = 2;
    });

  await cli.parseAsync();
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
});
