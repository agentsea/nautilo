import { createHash } from "node:crypto";
import type { CoverageSurface } from "../src/model";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_MAIN_2026_08_13_SOURCE_ALARM_LOCATORS =
  new Set<string>([
  "apps/cli/src/commands/whoami.ts#network_processor:5d1c6324712948b5:1",
  "apps/cli/src/commands/whoami.ts#network_processor:fe6bbf87fa9d9c22:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:352cf31e12ad0566:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:46d227f735d83897:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:5795a4a6fe8574c5:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:f6e9be34186cccf9:1"
]);

const RUNTIME_LOCATORS = [
  "apps/cli/src/lib/protected-handoff.ts#filesystem_write:bf7035716c6bbd17:1",
  "apps/cli/src/lib/railway-maintenance-state.ts#filesystem_write:26ce1bb8bd8590e8:1",
  "apps/cli/src/lib/railway-maintenance-state.ts#filesystem_write:a022fe8ea98c3354:1",
  "apps/mobile/src/components/shared-browser-viewer-pdf-qualification.web.tsx#network_processor:7dee09ce12b4c858:1",
  "apps/mobile/src/lib/artifact-byte-download.web.ts#network_processor:743d0710bd6acb03:1",
  "apps/mobile/src/lib/artifact-byte-download.web.ts#network_processor:797805819cb40388:1",
  "apps/mobile/src/lib/artifact-byte-download.web.ts#network_processor:d44b66bd51a9128e:1",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:468c68ed4723a1f2:9",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c467686340f4efc2:22",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c6d53eb0eb42455b:10",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c6d53eb0eb42455b:11",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c6d53eb0eb42455b:8",
  "bin/nautilo-dev/src/commands/dev-stack.ts#log_emitter:c6d53eb0eb42455b:9",
  "bin/nautilo-server/src/maintenance-job.ts#log_emitter:5393e661fc22a3bb:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:16c195d06b08224e:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:6293b9e3b2f9e231:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:a13ef6ef9584aad7:1",
  "packages/api-client/src/cli-session-store.ts#filesystem_write:a2ea9183aae8418c:1",
  "packages/railway-hosting/src/https-readiness.ts#network_processor:1bc3527864c7f101:1",
  "packages/server/src/app.ts#log_emitter:7ef703451e44cded:3",
  "packages/server/src/app.ts#log_emitter:7ef703451e44cded:4",
  "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:3",
  "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:4",
  "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:5",
  "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:6",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:0b436f978a28a1db:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:0f29bd4ad3353e63:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:14ab424489d55fa5:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:2dcc31d3a82d0aaf:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:3413ac2debd90a45:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:3fcb425a7026551d:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:793887acb38982a4:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:8e64a4137fe33d64:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:9575c7df38ba4ab0:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:9ecb63e84564275b:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:ad4fda6fab10c8bf:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:c480a84fec599d4d:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:c5880299886d9474:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:df729d8a835b148a:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:eb88936e1a1bb475:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:f87703f93eaca4c8:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#subprocess_processor:3e9ab7be18cf5742:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#temporary_storage:6811fae8bf6fa69f:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#temporary_storage:95f730bfd89839e2:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#temporary_storage:b66e502c864798be:1",
  "packages/server/src/maintenance/portable-recovery-job.ts#temporary_storage:de07dfd9020fe258:1",
  "packages/server/src/routes/admin-users.ts#log_emitter:89b81c36ea23316a:2",
  "packages/trust/src/logto-admin.ts#network_processor:ef993855494c1601:3"
] as const;
const BUILD_AND_PROBE_LOCATORS = [
  "apps/cli/scripts/build-standalone.ts#subprocess_processor:00636c0b4f2e6b42:1",
  "apps/mobile/scripts/export-mobile-web.ts#filesystem_write:8582964d4b211e72:1",
  "apps/mobile/scripts/export-mobile-web.ts#subprocess_processor:5400cfefaa31f017:1",
  "apps/mobile/scripts/export-mobile-web.ts#temporary_storage:1755b631a3ffa3bf:1",
  "apps/mobile/scripts/shared-browser-viewer-export-probe.ts#subprocess_processor:590ca2d5ea9d39f2:1",
  "apps/mobile/scripts/shared-browser-viewer-export-probe.ts#temporary_storage:5adb4d1c7a81a082:1",
  "apps/mobile/scripts/shared-browser-viewer-export-probe.ts#temporary_storage:f992a93edf8d43de:1"
] as const;

const DEBT_KIND = {
  filesystem_write: { surface: "file", marker: "filesystem-write alarm" },
  network_processor: { surface: "processor", marker: "network-processor alarm" },
  subprocess_processor: { surface: "processor", marker: "subprocess-processor alarm" },
  log_emitter: { surface: "log", marker: "log-emitter alarm" },
  temporary_storage: { surface: "cache", marker: "temporary-storage alarm" },
} as const satisfies Record<string, { surface: CoverageSurface; marker: string }>;

function owner(locator: string): string {
  return locator.split("#", 1)[0]!.split("/").slice(0, 2).join("/");
}

function unresolvedRuntimeDebt(locator: string): SourceAlarmReview {
  const kind = locator.split("#", 2)[1]!.split(":", 1)[0]! as keyof typeof DEBT_KIND;
  const { surface, marker } = DEBT_KIND[kind];
  const digest = createHash("sha256").update(locator).digest("hex").slice(0, 16);
  return {
    locator,
    owner: owner(locator),
    closure: "baseline_debt",
    debtId: `debt.source-alarm.${surface}.${kind}.${digest}`,
    surface,
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason:
      `${locator} is a current ${marker} whose exact payload classification and relationship to an encrypted semantic boundary remain untriaged.`,
    evidenceGap:
      `${locator} lacks executable evidence proving the exact fields, redaction or encryption contract, and plaintext-safety boundary for this ${marker}.`,
  };
}

export const REVIEWED_MAIN_2026_08_13_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  ...RUNTIME_LOCATORS.map(unresolvedRuntimeDebt),
  ...BUILD_AND_PROBE_LOCATORS.map((locator, index) => ({
    locator,
    owner: owner(locator),
    closure: "reviewed_exclusion" as const,
    exclusionId:
      `exclusion.main-2026-08-13.build-probe-${String(index + 1).padStart(2, "0")}`,
    reason:
      "This exact build or qualification-probe callsite handles generated application assets, compiler subprocesses, or isolated temporary fixtures and is not reachable from product data processing.",
  })),
];
