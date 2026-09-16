import type { CommandModule } from "yargs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildRegistryImageRef, localInstanceRootDir, shellQuote } from "@nautilo/compose-driver";
import { createComposeLifecycleFromDriver } from "@nautilo/compose-lifecycle";
import {
  planAdminRedemption,
  type AdminRedemptionPlan,
  type ResolvedDeployConfig,
} from "@nautilo/deploy-config";

import {
  composeOwnerConfigIdentity,
  continueComposeOwnerConfig,
  continueComposeOwnerClaim,
  composeOwnerResumeCommand,
  prepareComposeOwnerConfig,
  openComposeOwnerConfigDestination,
  prepareComposeOwnerClaim,
  type ComposeOwnerClaimResult,
  type PreparedComposeOwnerClaim,
} from "../lib/compose-owner-claim.ts";
import {
  buildFirstDeployProviderConsumeHook,
  resolveDeployConfigForCompose,
} from "../lib/compose-driver-factory.ts";
import { resolveComposeOwnerMode, type ComposeOwnerModeResolution } from "../lib/compose-owner-mode.ts";
import {
  preflightOwnerSeedResultDestination,
  type OwnerSeedResult,
} from "../lib/owner-seed-result.ts";
import { runComposeVerb } from "../lib/run-compose-verb.ts";
import {
  buildServerCompletionSummary,
  parseServerFinishMode,
  renderServerCompletionSummary,
} from "../lib/server-completion.ts";
import { resolveStableRuntimeImage } from "../lib/stable-runtime-image.ts";

export const deployModule: CommandModule = {
  command: "deploy",
  describe:
    "Deploy the active Docker Compose profile. This direct deploy has no backup or rollback; use `upgrade` for a protected update.",
  builder: (yargs) =>
    yargs
      .option("redeem", {
        type: "boolean",
        default: true,
        describe:
          "Require a complete first-owner path; --no-redeem is rejected for deploy",
      })
      .option("image", {
        type: "string",
        describe:
          "Exact ghcr.io/agentsea/nautilo-runtime-v2 manifest digest (default: latest signed stable release)",
      })
      .option("allow-artifact-loss", {
        type: "boolean",
        default: false,
        describe: "Override the artifact/media persistent-volume migration guard",
      })
      .option("finish", {
        type: "string",
        choices: ["guide", "product"] as const,
        default: "guide",
        describe: "Finish in the server guide or Nautilo product after first-owner setup",
      })
      .option("open-browser", {
        type: "boolean",
        describe: "Open first-owner setup or the final destination (defaults on for interactive terminals)",
      })
      .option("owner-mode", {
        type: "string",
        choices: ["claim", "config"] as const,
        describe: "Explicit first-owner path: hosted browser claim or protected owner config",
      })
      .option("owner-config", {
        type: "string",
        describe: "Absolute protected owner-config TOML path; selects config mode",
      })
      .option("owner-result", {
        type: "string",
        describe: "Absolute operator-owned recovery result path for config mode",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print a deterministic completion summary and never open a browser implicitly",
      })
      .example("$0 deploy", "Deploy the latest signed stable Nautilo image.")
      .example("$0 deploy --image <digest>", "Deploy a specific immutable Nautilo image.")
      .epilogue("If first-owner setup is unfinished, this command prints the exact resume command. Run it instead of deploying again. Guide: https://nautilo.ai/docs/operator/deploy/docker-compose"),
  handler: async (argv) => {
    if (argv["from-registry"] !== undefined) {
      process.stderr.write("Unknown argument: from-registry\n");
      process.exitCode = 2;
      return;
    }
    const noRedeem = argv["redeem"] === false;
    const imageRef =
      typeof argv["image"] === "string" && argv["image"].trim().length > 0
        ? argv["image"].trim()
        : undefined;
    const finish = parseServerFinishMode(argv["finish"]);
    const json = argv["json"] === true;
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    const shouldOpenBrowser = !json && (
      argv["open-browser"] === true ||
      (argv["open-browser"] !== false && interactive)
    );
    let ownerMode: ComposeOwnerModeResolution | undefined;
    let preparedClaim: PreparedComposeOwnerClaim | undefined;
    let ownerPlan: AdminRedemptionPlan | undefined;
    let resolvedOwnerConfig: ResolvedDeployConfig | undefined;
    let existingOwnerResult: OwnerSeedResult | undefined;
    let resolvedOwnerResultPath: string | undefined;
    let serverRootPaths: readonly string[] = [];
    let ownerResult: ComposeOwnerClaimResult | undefined;
    let selectedImageRef: string | undefined;
    await runComposeVerb(
      argv,
      async (profile, driver) => {
        if (selectedImageRef === undefined) {
          throw new Error("Deploy image selection did not complete before driver construction.");
        }
        const effectiveProfile = {
          ...profile,
          from_source: false,
          image_ref: selectedImageRef,
        };
        await createComposeLifecycleFromDriver({
          profile: effectiveProfile,
          driver,
        }).deploy({
          allowArtifactLoss: argv["allow-artifact-loss"] === true,
        });
        if ((ownerMode?.kind !== "claim" && ownerMode?.kind !== "config") || preparedClaim === undefined) {
          throw new Error("Compose deploy finished without a canonical first-owner result");
        }
        ownerResult = ownerMode.kind === "claim"
          ? await continueComposeOwnerClaim({
              profile: effectiveProfile,
              prepared: preparedClaim,
              finish,
              openBrowser: shouldOpenBrowser,
            })
          : await continueComposeOwnerConfig({
              profile: effectiveProfile,
              prepared: preparedClaim,
              owner: (() => {
                if (!ownerPlan?.pin) throw new Error("Protected owner config is missing a PIN");
                return {
                  handle: ownerPlan.handle,
                  displayName: ownerPlan.displayName,
                  password: ownerPlan.password,
                  pin: ownerPlan.pin,
                };
              })(),
              resultPath: resolvedOwnerResultPath ?? ownerMode.ownerResultPath,
              existingResult: existingOwnerResult,
              serverRootPaths,
            });
        if (ownerMode.kind === "config" && shouldOpenBrowser) {
          ownerResult = await openComposeOwnerConfigDestination(ownerResult, finish);
        }
        const recoveryCommand = ownerMode.kind === "claim"
          ? composeOwnerResumeCommand(effectiveProfile.name, finish)
          : `nautilo deploy --profile ${shellQuote(effectiveProfile.name)} --owner-mode config --owner-config ${shellQuote(ownerMode.ownerConfigPath)} --owner-result ${shellQuote(resolvedOwnerResultPath ?? ownerMode.ownerResultPath)} --finish ${finish}`;
        const complete = ownerResult.outcome === "owner-bound";
        const interrupted = ownerResult.outcome === "interrupted";
        const ownerSetup = ownerResult.outcome === "target-unavailable"
          ? "target-unavailable" as const
          : ownerResult.outcome === "install-unknown"
            ? "install-unknown" as const
            : ownerResult.outcome === "recovery-required"
              ? "recovery-required" as const
            : "awaiting-owner" as const;
        const base = {
          backend: "compose" as const,
          operation: "deploy" as const,
          outcome: complete ? "complete" as const : "action-required" as const,
          finish,
          serverUrl: ownerResult.serverUrl,
          profile: effectiveProfile.name,
          payer: "customer" as const,
        };
        const summary = buildServerCompletionSummary({
          ...base,
          browser: ownerResult.browser,
          ownerSetup: complete ? "owner-bound" : ownerSetup,
          ...(ownerResult.controllerFailure === undefined
            ? {}
            : { ownerSetupErrorCode: ownerResult.controllerFailure }),
          ...(!complete ? {
            recoveryCode: ownerMode.kind === "claim"
              ? "resume-compose-owner" as const
              : "recover-compose-owner-result" as const,
            ...(ownerResult.outcome === "recovery-required"
              ? {}
              : { recoveryCommand, nextCommand: recoveryCommand }),
          } : {}),
          ...(ownerResult.ownerResultPath === undefined
            ? {}
            : { ownerResultPath: ownerResult.ownerResultPath }),
        });
        process.stdout.write(json
          ? `${JSON.stringify(summary, null, 2)}\n`
          : renderServerCompletionSummary(summary));
        return { exitCode: interrupted ? 130 as const : complete ? 0 as const : 1 as const };
      },
      undefined,
      {
        beforeDriver: async (profile) => {
          // Resolve and verify the immutable artifact before claim/config
          // custody or any deployment state is prepared.
          selectedImageRef = imageRef === undefined
            ? await resolveStableRuntimeImage()
            : buildRegistryImageRef(imageRef);
          const defaultOwnerConfigPath = join(
            process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
            "nautilo",
            "deploy.toml",
          );
          ownerMode = resolveComposeOwnerMode({
            defaultOwnerConfigPath,
            protectedOwnerConfigPresent: existsSync(defaultOwnerConfigPath),
            requestedOwnerMode: argv["owner-mode"],
            requestedOwnerConfigPath: argv["owner-config"],
            requestedOwnerResultPath: argv["owner-result"],
            redeem: !noRedeem,
            interactive,
            json,
          });
          if (ownerMode.kind === "rejected") throw new Error(ownerMode.message);
          if (ownerMode.kind === "config") {
            const home = process.env["HOME"] ?? homedir();
            const instanceRoot = localInstanceRootDir(home, profile.instance_id);
            const resolved = resolveDeployConfigForCompose(ownerMode.ownerConfigPath, instanceRoot);
            const plan = planAdminRedemption(resolved);
            if (!plan.pin) {
              throw new Error("Protected owner config must provide an owner PIN. No deployment was started.");
            }
            serverRootPaths = [instanceRoot, join(instanceRoot, "backups")];
            const destination = await preflightOwnerSeedResultDestination({
              path: ownerMode.ownerResultPath,
              serverRootPaths,
            });
            const identity = composeOwnerConfigIdentity(profile, destination.path);
            if (destination.kind === "existing"
              && (destination.result.profile !== profile.name
                || destination.result.targetFingerprint !== identity.controlFingerprint
                || destination.result.handle !== plan.handle)) {
              throw new Error("Existing owner result does not match this exact Compose owner operation");
            }
            existingOwnerResult = destination.kind === "existing" ? destination.result : undefined;
            resolvedOwnerResultPath = destination.path;
            ownerPlan = plan;
            resolvedOwnerConfig = resolved;
            preparedClaim = await prepareComposeOwnerConfig(profile, destination.path);
            return;
          }
          preparedClaim = await prepareComposeOwnerClaim(profile);
        },
        factoryOptions: () => {
          const firstDeployConsume = ownerMode?.kind === "config" && resolvedOwnerConfig !== undefined
            ? buildFirstDeployProviderConsumeHook({ resolved: resolvedOwnerConfig })
            : undefined;
          return {
            ...(firstDeployConsume === undefined ? {} : { firstDeployConsume }),
          };
        },
      },
    );
  },
};
