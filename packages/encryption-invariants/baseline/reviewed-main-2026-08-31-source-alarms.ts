import { createHash } from "node:crypto";

import type { CoverageSurface } from "../src/model";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_MAIN_2026_08_31_SOURCE_ALARM_LOCATORS = new Set<string>([
  "apps/desktop/electron/computer-use/cua-supervisor.ts#subprocess_processor:9ee495cc05e1656a:1",
  "apps/desktop/electron/main.ts#log_emitter:4c91318a6d584bcd:28",
  "apps/desktop/electron/relay.ts#temporary_storage:665181a131b0d314:1",
  "apps/desktop/electron/relay.ts#temporary_storage:f811011aee08f128:1",
  "packages/agent/src/providers/factory.ts#network_processor:133d49604823081b:1",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:0ae25e725db4e950:5",
]);

const RUNTIME_DECLARATIONS = [
  "apps/desktop/electron/computer-use-host-runtime/broker.ts#subprocess_processor:9bd1b67f70157a14:1",
  "apps/desktop/electron/computer-use-host-runtime/macos-attestor.ts#subprocess_processor:531d9c2af2aac784:1",
  "apps/desktop/electron/computer-use-host-runtime/node-storage.ts#filesystem_write:6e11be9077be0037:1",
  "apps/desktop/electron/computer-use-host-runtime/node-storage.ts#filesystem_write:b6183aa23ad6ffbb:1",
  "apps/desktop/electron/computer-use-host-runtime/node-storage.ts#filesystem_write:d3a44a09c43f0db0:1",
  "apps/desktop/electron/computer-use-host-runtime/node-storage.ts#filesystem_write:b0746453f290ea39:1",
  "apps/desktop/electron/computer-use-host-runtime/node-storage.ts#filesystem_write:2c9610b6d778675a:1",
  "apps/desktop/electron/computer-use-host-runtime/node-storage.ts#filesystem_write:1e024c8bc774ced6:1",
  "apps/desktop/electron/computer-use-host-runtime/node-storage.ts#filesystem_write:9383873ca525d7e4:1",
  "apps/desktop/electron/computer-use-host-runtime/node-storage.ts#filesystem_write:70c91570dba9e587:1",
  "packages/agent/src/config/computer-use-catalogue/remote-catalogue.ts#filesystem_write:218d9aef59bafcd0:1",
  "packages/agent/src/config/computer-use-catalogue/remote-catalogue.ts#filesystem_write:2a6b552fc2c8ad57:1",
  "packages/computer-use-host/src/cua-client.ts#subprocess_processor:85a9df0846333bc0:1",
  "packages/computer-use-host/src/native-cua-supervisor.ts#subprocess_processor:9ee495cc05e1656a:1",
] as const;

const BUILD_AND_CONTENT_FREE_EXCLUSIONS = [
  "apps/desktop/electron/main.ts#log_emitter:ae27fd70f90d5f14:11",
  "apps/desktop/scripts/after-sign.cjs#subprocess_processor:3cc09054be92063e:1",
  "apps/desktop/scripts/after-sign.cjs#subprocess_processor:718781925b7f0518:2",
  "apps/desktop/scripts/vendor-computer-use-host.ts#subprocess_processor:020c6548ac70549e:1",
  "apps/desktop/scripts/vendor-computer-use-host.ts#subprocess_processor:4a55206e047a2a55:1",
  "apps/desktop/scripts/vendor-computer-use-host.ts#filesystem_write:0dabbfbd259109e8:1",
  "apps/desktop/scripts/vendor-computer-use-host.ts#filesystem_write:2fea7bab3464f265:1",
  "apps/desktop/scripts/verify-packaged-computer-use-host.ts#temporary_storage:cf1417649298efe1:1",
  "bin/nautilo-server/src/index.ts#log_emitter:0ae25e725db4e950:4",
  "packages/agent/scripts/export-computer-use-contract-catalogue.ts#filesystem_write:c0bf3235d13025d7:1",
  "packages/computer-use-host/src/main.ts#filesystem_write:47338bc2312c9b1e:1",
] as const;

const UNRESOLVED_DEBT = [
  ["apps/desktop/electron/main.ts#log_emitter:c88b9bfe0560c022:15", "log"],
  ["apps/desktop/scripts/verify-packaged-computer-use-host.ts#log_emitter:c467686340f4efc2:1", "log"],
  ["packages/agent/src/providers/factory.ts#network_processor:3d308d8f2b9b2170:1", "processor"],
] as const satisfies readonly (readonly [string, CoverageSurface])[];

function owner(locator: string): string {
  return locator.split("#", 1)[0]!.split("/").slice(0, 2).join("/");
}

function kind(locator: string): string {
  return locator.split("#", 2)[1]!.split(":", 1)[0]!.replaceAll("_", "-");
}

function debtId(locator: string, surface: CoverageSurface): string {
  const alarmKind = locator.split("#", 2)[1]!.split(":", 1)[0]!;
  const digest = createHash("sha256").update(locator).digest("hex").slice(0, 16);
  return `debt.source-alarm.${surface}.${alarmKind}.${digest}`;
}

const declarations: readonly SourceAlarmReview[] = RUNTIME_DECLARATIONS.map(
  (locator, index) => ({
    locator,
    owner: owner(locator),
    closure: "declaration",
    declarationId: `source.main-2026-08-31.${String(index + 1).padStart(3, "0")}`,
    reason: locator.includes("node-storage.ts")
      ? "The managed Host store writes only digest-addressed signed executable releases, bounded release metadata, ownership markers, and active/rollback records beneath a mode-0700 device-local root; it never persists Human conversation content."
      : locator.includes("remote-catalogue.ts")
      ? "The atomic device-local cache contains only a size-bounded, signature-verified public Computer Use contract catalogue and its signed pointer; it contains no Human content or operator credentials."
      : locator.includes("macos-attestor.ts")
      ? "The macOS attestor invokes only absolute /usr/bin codesign and lipo tools with a closed argv, fixed environment, shell disabled, and bounded output to verify the signed Host artifact."
      : locator.includes("broker.ts")
      ? "The Desktop broker launches one exact attested Computer Use Host artifact with a closed argv and pipe contract; tests reject shell execution, alternate binaries, unbounded output, and malformed protocol frames."
      : "The Host launches only its pinned CUA driver with the closed MCP argv and pipe contract; tests reject alternate commands, malformed protocol frames, unbounded output, and post-attestation identity drift.",
  }),
);

const exclusions: readonly SourceAlarmReview[] =
  BUILD_AND_CONTENT_FREE_EXCLUSIONS.map((locator, index) => ({
    locator,
    owner: owner(locator),
    closure: "reviewed_exclusion",
    exclusionId: `exclusion.main-2026-08-31.${String(index + 1).padStart(3, "0")}`,
    reason: locator.includes("main.ts#log_emitter:ae27")
      ? "This diagnostic emits only closed cold-boot enum values, generation counters, durations, and booleans; the adjacent contract forbids URLs, identities, response bodies, providers, tokens, certificates, and error text."
      : locator.startsWith("bin/nautilo-server/")
      ? "This moved boot diagnostic emits only the bounded protected-background lifecycle status and contains no prompt, response, identifier, credential, key material, or thrown error text."
      : locator.startsWith("packages/computer-use-host/src/main.ts")
      ? "This creates a stream over the already-open inherited attachment file descriptor using /dev/null only as a Node path placeholder; it does not create or persist a filesystem file."
      : "This exact build, signing, publication, or verification operation handles only deterministic executables, signatures, hashes, public catalogue metadata, release manifests, and temporary proof directories with explicit cleanup; it does not process Human content or credentials into durable output.",
  }));

const debt: readonly SourceAlarmReview[] = UNRESOLVED_DEBT.map(
  ([locator, surface]) => {
    const marker = `${kind(locator)} alarm`;
    return {
      locator,
      owner: owner(locator),
      closure: "baseline_debt",
      debtId: debtId(locator, surface),
      surface,
      remediationState: "planned",
      releaseImpact: "blocks_whole_product_claim",
      reason: `${locator} remains an explicit ${marker} because its dynamic diagnostic or provider payload can include identifiers, paths, endpoints, exception text, prompts, or responses; no claim is made that this text is encrypted today.`,
      evidenceGap: `${locator} needs ${marker} evidence proving the exact dynamic fields are content-free or cross a protected boundary before this debt can close.`,
    };
  },
);

export const REVIEWED_MAIN_2026_08_31_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [...declarations, ...exclusions, ...debt];
