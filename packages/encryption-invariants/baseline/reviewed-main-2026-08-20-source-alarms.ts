import { createHash } from "node:crypto";

import type { CoverageSurface } from "../src/model";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_MAIN_2026_08_20_SOURCE_ALARM_LOCATORS =
  new Set<string>([
    "apps/workbench/src/pages/settings/sections/integrations-section.tsx#network_processor:ef993855494c1601:2",
    "packages/server/src/routes/admin-users.ts#log_emitter:a1436e7c26c240df:1",
  ]);

const BUILD_AND_SCANNER_EXCLUSIONS = [
  "apps/cli/scripts/qualify-cloudflare-r2-oauth.ts#subprocess_processor:671b33aae8edcaca:1",
  "apps/cli/scripts/qualify-railway-day2-fallback.ts#network_processor:1712289ffe0e7e2c:1",
  "apps/desktop/electron/computer-use/contracts.ts#filesystem_write:cc3f45572e2a1485:1",
  "apps/desktop/electron/computer-use/contracts.ts#filesystem_write:776235558b548156:1",
  "apps/desktop/scripts/after-pack.cjs#subprocess_processor:9461b458eb044c55:1",
  "apps/desktop/scripts/after-pack.cjs#subprocess_processor:74c97233887bc193:1",
  "apps/desktop/scripts/after-sign.cjs#subprocess_processor:1b3373cfe2be228e:1",
  "apps/desktop/scripts/after-sign.cjs#subprocess_processor:8b617bd4cfce3c20:1",
  "apps/desktop/scripts/after-sign.cjs#subprocess_processor:e1b5fa82296c2f62:1",
  "apps/desktop/scripts/after-sign.cjs#subprocess_processor:207ceea34c695edc:1",
  "apps/desktop/scripts/after-sign.cjs#subprocess_processor:544e9d489b41e48a:1",
  "apps/desktop/scripts/build-electron.ts#filesystem_write:d005bf0747616ddb:3",
  "apps/desktop/scripts/build-electron.ts#filesystem_write:be38a5c635e9a7ee:4",
  "apps/desktop/scripts/build-screen-recording-permission.ts#subprocess_processor:c448dc931d1fcd0f:1",
  "apps/desktop/scripts/generate-cua-capability-ledger.ts#log_emitter:468c68ed4723a1f2:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#subprocess_processor:268775ec0da5b1f5:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#filesystem_write:307ba14f813d7d0b:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#filesystem_write:85cb63369bc68f48:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#filesystem_write:cdde7934c0bb6bb9:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#filesystem_write:1c391f45335c98af:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#temporary_storage:fe9db6bc859bd846:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#filesystem_write:0c909d7be06c2443:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#filesystem_write:15a916ba422d8e7d:1",
  "apps/desktop/scripts/vendor-cua-driver.ts#filesystem_write:b05554aebc28b06f:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#filesystem_write:dd7e5fddb0f7ba97:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#subprocess_processor:5e6b496195b39843:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#temporary_storage:2d0b3f7b1a3dea5b:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#subprocess_processor:fb613521c2a96aff:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#filesystem_write:1ffb38d5271871f0:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#filesystem_write:5f7ef3074f5d5064:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#filesystem_write:10e095581fe9fd62:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#temporary_storage:60aaa29f4615629c:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#filesystem_write:c33ccbe1e03b8056:1",
  "apps/desktop/scripts/vendor-sharp-darwin.ts#filesystem_write:d005bf0747616ddb:1",
  "packages/db/scripts/finalize-m274-encryption-transition.ts#filesystem_write:3dcc6339408547a4:1",
  "packages/db/scripts/finalize-m279-reflection-convergence.ts#filesystem_write:3dcc6339408547a4:1",
  "packages/lattice-bridge/src/server/device/production-additional-device.ts#network_processor:5dc8db15e59d75ed:1",
  "packages/query-invariants/src/node/cli.ts#filesystem_write:ae492cfa36dbbf08:1",
  "packages/query-invariants/src/node/cli.ts#log_emitter:468c68ed4723a1f2:1",
  "packages/query-invariants/src/node/cli.ts#log_emitter:70a4194050672095:1",
  "packages/query-invariants/src/node/cli.ts#log_emitter:468c68ed4723a1f2:2",
  "packages/query-invariants/src/node/cli.ts#log_emitter:70a4194050672095:2",
  "packages/query-invariants/src/node/cli.ts#log_emitter:468c68ed4723a1f2:3",
  "packages/query-invariants/src/node/cli.ts#log_emitter:468c68ed4723a1f2:4",
  "packages/query-invariants/src/node/cli.ts#log_emitter:140bdfe970af4e13:1",
  "packages/query-invariants/src/node/cli.ts#log_emitter:468c68ed4723a1f2:5",
  "packages/query-invariants/src/node/cli.ts#log_emitter:a120c7186b2830b9:1",
] as const;

const REVIEWED_DECLARATIONS = [
  "apps/desktop/electron/computer-use/contracts.ts#filesystem_write:2a6d981625a748c5:1",
  "apps/desktop/electron/computer-use/contracts.ts#filesystem_write:ca2059d9491a6a16:1",
  "apps/desktop/electron/computer-use/cua-supervisor.ts#subprocess_processor:9ee495cc05e1656a:1",
  "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:10",
  "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:11",
  "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:12",
  "apps/desktop/electron/main.ts#network_processor:0d2ab469d7540d61:5",
  "apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:13",
  "apps/desktop/electron/main.ts#network_processor:0d2ab469d7540d61:6",
  "apps/desktop/electron/main.ts#network_processor:0d2ab469d7540d61:7",
  "apps/desktop/electron/main.ts#log_emitter:9318a4d9f9cc61d8:13",
  "apps/desktop/electron/main.ts#network_processor:2608657ee0740162:4",
  "apps/desktop/electron/main.ts#network_processor:2608657ee0740162:5",
  "apps/desktop/electron/screen-recording-permission.ts#subprocess_processor:2f2c04580b8e58b2:1",
  "apps/workbench/src/pages/admin/sections/server-section.tsx#network_processor:ef993855494c1601:1",
  "apps/workbench/src/pages/admin/sections/server-section.tsx#network_processor:ef993855494c1601:2",
] as const;

const UNRESOLVED_DEBT = [
  ["apps/desktop/electron/main.ts#log_emitter:8eeb912856b5dd20:1", "log"],
  ["apps/desktop/electron/main.ts#log_emitter:f1eda34f3e6c9967:1", "log"],
  ["apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:28", "log"],
  ["apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:29", "log"],
  ["packages/agent/src/nodes/post-model.ts#log_emitter:a1436e7c26c240df:5", "log"],
] as const satisfies readonly (readonly [string, CoverageSurface])[];

function owner(locator: string): string {
  return locator.split("#", 1)[0]!.split("/").slice(0, 2).join("/");
}

function stableId(locator: string): string {
  return createHash("sha256").update(locator).digest("hex").slice(0, 16);
}

const exclusions: readonly SourceAlarmReview[] =
  BUILD_AND_SCANNER_EXCLUSIONS.map((locator) => ({
    locator,
    owner: owner(locator),
    closure: "reviewed_exclusion",
    exclusionId: `exclusion.main-2026-08-20.${stableId(locator)}`,
    reason: locator.includes("production-additional-device.ts")
      ? "The scanner matched the repository method named fetch; this call performs a local authenticated database read and creates no network processor or new transport boundary."
      : locator.includes("computer-use/contracts.ts")
      ? "The scanner matched a TypeScript filesystem interface signature; it executes no write and creates no persistence boundary."
      : "This exact build, qualification, packaging, generated-migration, or inventory-tool callsite handles only repository fixtures, generated binaries, deterministic SQL, fixed diagnostics, or synthetic infrastructure probes and is not reachable from product data processing.",
  }));

const declarations: readonly SourceAlarmReview[] =
  REVIEWED_DECLARATIONS.map((locator) => ({
    locator,
    owner: owner(locator),
    closure: "declaration",
    declarationId: `source.main-2026-08-20.${stableId(locator)}`,
    reason: locator.includes("local-compose-effects.ts")
      ? "This exact callsite delegates to the already inventoried whole-instance Compose backup boundary; its plaintext archive risk remains explicit in source.backup.compose-bundle and is not hidden as a new destination."
      : locator.includes("computer-use/contracts.ts")
      ? "This mode-0600 atomic writer persists only the bounded local Computer-use policy and non-secret installation receipt; it cannot accept a PIN, private key, recovery credential, desktop argument, screenshot, or captured content."
      : locator.includes("cua-supervisor.ts")
      ? "This local subprocess starts the pinned CUA driver with fixed arguments, a cleared environment, disabled telemetry and updates, ignored output, and no Human content, credential, key, or desktop command payload."
      : locator.includes("screen-recording-permission.ts")
      ? "This local subprocess invokes the fixed signed screen-permission helper and carries no captured pixels, Human content, credential, key, or dynamic shell input."
      : locator.includes("#log_emitter")
      ? "This exact diagnostic emits only a fixed lifecycle message or bounded status, presence, and endpoint metadata; it emits no Human content, prompt, key, token, ciphertext, desktop arguments, or captured desktop content."
      : "This exact authenticated control-plane or first-party server request carries only bounded identity, capability, transition, readiness, or infrastructure-routing fields; it sends no plaintext product content, prompt, private key, recovery credential, or captured desktop content.",
  }));

const debt: readonly SourceAlarmReview[] = UNRESOLVED_DEBT.map(
  ([locator, surface]) => {
    const kind = locator.split("#", 2)[1]!.split(":", 1)[0]!;
    const marker = kind === "log_emitter"
      ? "log-emitter alarm"
      : "filesystem-write alarm";
    return {
      locator,
      owner: owner(locator),
      closure: "baseline_debt",
      debtId: `debt.source-alarm.${surface}.${kind}.${stableId(locator)}`,
      surface,
      remediationState: "untriaged",
      releaseImpact: "blocks_whole_product_claim",
      reason:
        `${locator} is a current ${marker} whose exception text, tool coordinate, or local infrastructure-secret payload is not yet proven safe for the whole-product encryption claim.`,
      evidenceGap:
        `${locator} lacks executable evidence proving exact redaction or encrypted-at-rest handling for this ${marker}; it must remain explicit debt rather than being approved by inventory refresh.`,
    };
  },
);

export const REVIEWED_MAIN_2026_08_20_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
    ...exclusions,
    ...declarations,
    ...debt,
  ];
