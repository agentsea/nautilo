import type { Arguments, CommandModule } from "yargs";
import { shellQuote } from "@nautilo/compose-driver";
import {
  ComposeCustodyCleanupError,
  createComposeLifecycleFromDriver,
  unwrapComposeLifecycleError,
} from "@nautilo/compose-lifecycle";

import { runComposeVerb } from "../lib/run-compose-verb.ts";
import { clearComposeOwnerClaimCustody } from "../lib/compose-owner-claim.ts";

/**
 * yargs 18 reports strict-mode unknown options after the command handler has
 * started. Destroy must fail before it can resolve a profile or construct a
 * driver, so its builder rejects unrecognised parsed keys in an early command
 * middleware. Camel-case expansion of `--keep-certs` is intentionally listed.
 */
const DESTROY_ALLOWED_ARGUMENT_KEYS = new Set([
  "_", "$0", "hard", "keep-certs", "keepCerts", "yes",
  "profile", "server", "help", "h", "version", "v",
]);

function assertDestroyArgumentsKnown(argv: Arguments): void {
  if (argv._.length !== 1 || argv._[0] !== "destroy") {
    const extra = argv._.slice(1).map(String).join(" ");
    throw new Error(`Unknown argument: ${extra || String(argv._[0] ?? "")}`);
  }
  const unknown = Object.keys(argv).find((key) => !DESTROY_ALLOWED_ARGUMENT_KEYS.has(key));
  if (unknown !== undefined) throw new Error(`Unknown argument: ${unknown}`);
}

export const destroyModule: CommandModule = {
  command: "destroy",
  describe: "Tear down the local-compose stack (soft down by default)",
  builder: (yargs) =>
    yargs.option("hard", {
      type: "boolean",
      default: false,
      describe: "docker compose down -v and remove .bootstrap/",
    }).option("yes", {
      type: "boolean",
      default: false,
      describe: "Explicit non-interactive acknowledgement (accepted for automation)",
    }).option("keep-certs", {
      type: "boolean",
      default: false,
      describe: "With --hard, preserve caddy_data/caddy_config volumes (keep LE certs across full reset)",
    }).middleware(assertDestroyArgumentsKnown, true)
      .example("$0 destroy", "Stop and remove the stack while preserving its volumes.")
      .example("$0 destroy --hard", "Remove the stack and its volumes. This permanently deletes server data."),
  handler: async (argv) => {
    const hard = argv["hard"] === true;
    const keepCerts = argv["keep-certs"] === true;
    await runComposeVerb(argv, async (profile, driver) => {
      if (!hard) {
        await driver.destroy(profile, { hard: false, keepCerts });
      } else {
        try {
          await createComposeLifecycleFromDriver({
            profile,
            driver,
            ports: { clearOwnerClaimCustody: clearComposeOwnerClaimCustody },
          }).destroyHard({ keepCerts });
        } catch (error) {
          const lifecycleCause = unwrapComposeLifecycleError(error);
          if (!(lifecycleCause instanceof ComposeCustodyCleanupError)) throw error;
          const cause = lifecycleCause.cause;
          throw new Error(
            `The server was destroyed, but its exact Compose owner-claim credential could not be removed from the operating-system keychain: ${cause instanceof Error ? cause.message : String(cause)}. Retry exact cleanup with: nautilo destroy --hard --profile ${shellQuote(profile.name)}${keepCerts ? " --keep-certs" : ""}`,
          );
        }
      }
    });
  },
};
