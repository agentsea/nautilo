import type { CommandModule } from "yargs";

import { composeOwnerResumeCommand, continueComposeOwnerClaim } from "../lib/compose-owner-claim.ts";
import { runComposeProfileVerb } from "../lib/run-compose-verb.ts";
import {
  buildServerCompletionSummary,
  parseServerFinishMode,
  renderServerCompletionSummary,
} from "../lib/server-completion.ts";

export const claimModule: CommandModule = {
  command: "claim",
  describe: "Resume first-owner setup for a Compose server",
  builder: (yargs) => yargs.command({
    command: "resume",
    describe: "Observe and resume the protected first-owner claim for the active profile",
    builder: (resume) => resume
      .option("finish", {
        type: "string",
        choices: ["guide", "product"] as const,
        default: "guide",
        describe: "Finish in the server guide or Nautilo product",
      })
      .option("open-browser", {
        type: "boolean",
        describe: "Open first-owner setup (defaults on for interactive terminals)",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print deterministic state and never open a browser implicitly",
      })
      .example("$0 claim resume", "Continue the first-owner setup that a previous Compose deploy started.")
      .epilogue("Use the exact command printed by `nautilo deploy` when recovery is required."),
    handler: async (argv) => {
      const finish = parseServerFinishMode(argv["finish"]);
      const json = argv["json"] === true;
      const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
      const openBrowser = !json && (
        argv["open-browser"] === true
        || (argv["open-browser"] !== false && interactive)
      );
      await runComposeProfileVerb(argv, async (profile) => {
        const result = await continueComposeOwnerClaim({
          profile,
          finish,
          openBrowser,
        });
        const complete = result.outcome === "owner-bound";
        const interrupted = result.outcome === "interrupted";
        const nextCommand = composeOwnerResumeCommand(profile.name, finish);
        const ownerSetup = result.outcome === "target-unavailable"
          ? "target-unavailable" as const
          : result.outcome === "install-unknown"
            ? "install-unknown" as const
            : "awaiting-owner" as const;
        const summary = buildServerCompletionSummary({
          backend: "compose",
          operation: "resume",
          outcome: complete ? "complete" : "action-required",
          finish,
          serverUrl: result.serverUrl,
          browser: result.browser,
          profile: profile.name,
          payer: "customer",
          ownerSetup: complete ? "owner-bound" : ownerSetup,
          ...(result.controllerFailure === undefined
            ? {}
            : { ownerSetupErrorCode: result.controllerFailure }),
          ...(!complete ? {
            nextCommand,
            recoveryCommand: nextCommand,
            recoveryCode: "resume-compose-owner" as const,
          } : {}),
        });
        process.stdout.write(json
          ? `${JSON.stringify(summary, null, 2)}\n`
          : renderServerCompletionSummary(summary));
        if (result.outcome === "target-unavailable") process.stderr.write(
          `The server owner state could not be observed safely. Retry the exact resume command after restoring ordinary server reachability if needed: ${nextCommand}.\n`,
        );
        return { exitCode: interrupted ? 130 as const : complete ? 0 as const : 1 as const };
      });
    },
  }).demandCommand(1),
  handler: () => undefined,
};
