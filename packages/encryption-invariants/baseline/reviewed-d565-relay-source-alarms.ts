import { createHash } from "node:crypto";

import type { CoverageSurface } from "../src/model";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/** Old relay coordinates retired by the D565 fixed-dispatch extraction. */
export const SUPERSEDED_D565_RELAY_SOURCE_ALARM_LOCATORS = new Set<string>([
  "apps/desktop/electron/relay.ts#filesystem_write:2d82d809fcc22db0:1",
  "apps/desktop/electron/relay.ts#filesystem_write:ed02bb847672e5fb:1",
  "apps/desktop/electron/relay.ts#filesystem_write:ed02bb847672e5fb:2",
  "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:3",
  "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:4",
  "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:5",
  "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:6",
  "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:7",
  "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:8",
  "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:9",
  "apps/desktop/electron/relay.ts#log_emitter:c4f22f3fb6bab4a7:1",
  "apps/desktop/electron/relay.ts#filesystem_write:290291cdd1e337fe:1",
  "apps/desktop/electron/relay.ts#filesystem_write:695601467b04e10b:1",
  "apps/desktop/electron/relay.ts#filesystem_write:b6bbd545081bc80d:1",
  "apps/desktop/electron/relay.ts#network_processor:e5e5ee185f521240:1",
  "apps/desktop/electron/relay.ts#temporary_storage:26b4c748d749a0f9:1",
  "apps/desktop/electron/relay.ts#temporary_storage:65e810a019e1a3d5:1",
  "bin/nautilo-relay/src/index.ts#log_emitter:3063c8a5d859deda:2",
  "bin/nautilo-relay/src/index.ts#log_emitter:a1436e7c26c240df:2",
  "bin/nautilo-relay/src/index.ts#log_emitter:a1436e7c26c240df:3",
]);

type AlarmDebt = {
  readonly locator: string;
  readonly owner?: string;
  readonly priorLocator?: string;
  readonly priorDebtId?: string;
};

export const D565_RELAY_SOURCE_ALARM_MIGRATIONS: readonly AlarmDebt[] = [
  {
    locator: "apps/desktop/electron/relay-provider-runtime.ts#filesystem_write:2ab717a89c28e663:1",
    priorLocator: "apps/desktop/electron/relay.ts#filesystem_write:290291cdd1e337fe:1",
    priorDebtId: "debt.source-alarm.file.filesystem_write.31c92d73229bb9ac",
  },
  {
    locator: "apps/desktop/electron/relay-provider-runtime.ts#filesystem_write:9b0253b42585ad49:1",
    priorLocator: "apps/desktop/electron/relay.ts#filesystem_write:695601467b04e10b:1",
    priorDebtId: "debt.source-alarm.file.filesystem_write.d87a94f0bf298bfa",
  },
  {
    locator: "apps/desktop/electron/relay-provider-runtime.ts#filesystem_write:b6bbd545081bc80d:1",
    priorLocator: "apps/desktop/electron/relay.ts#filesystem_write:2d82d809fcc22db0:1",
    priorDebtId: "debt.source-alarm.file.filesystem_write.c4f2e0534e0a1e34",
  },
  { locator: "apps/desktop/electron/relay-provider-runtime.ts#network_processor:e5e5ee185f521240:1" },
  { locator: "apps/desktop/electron/relay-sidecar-client.ts#subprocess_processor:7c8f560a96c15820:1" },
  { locator: "apps/desktop/electron/relay-dispatch/google-workspace.ts#subprocess_processor:b997f5479178a719:1" },
  { locator: "apps/desktop/electron/relay-dispatch/local-dispatch-policy.ts#log_emitter:074ef4cef51e3d96:1" },
  {
    locator: "apps/desktop/electron/relay-dispatch/local-file.ts#log_emitter:c4f22f3fb6bab4a7:1",
    priorLocator: "apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:5",
    priorDebtId: "debt.source-alarm.log.log_emitter.e132f8e75d9fbb9c",
  },
  {
    locator: "apps/desktop/electron/relay-dispatch/media.ts#filesystem_write:393d10341d31a33d:1",
    priorLocator: "apps/desktop/electron/relay.ts#filesystem_write:ed02bb847672e5fb:1",
    priorDebtId: "debt.source-alarm.file.filesystem_write.20ee5478e9c67234",
  },
  {
    locator: "apps/desktop/electron/relay-dispatch/media.ts#filesystem_write:ed02bb847672e5fb:1",
    priorLocator: "apps/desktop/electron/relay.ts#filesystem_write:ed02bb847672e5fb:2",
    priorDebtId: "debt.source-alarm.file.filesystem_write.fa8ecf3a9cc5b90c",
  },
  { locator: "apps/desktop/electron/relay-dispatch/media.ts#subprocess_processor:cb5077e1d470811a:1" },
  { locator: "apps/desktop/electron/relay-dispatch/media.ts#subprocess_processor:cb5077e1d470811a:2" },
  {
    locator: "apps/desktop/electron/relay-dispatch/media.ts#temporary_storage:171b4fee2fd5ecc4:1",
    priorLocator: "apps/desktop/electron/relay.ts#temporary_storage:65e810a019e1a3d5:1",
    priorDebtId: "debt.source-alarm.cache.temporary_storage.045dc682d8b0ceb1",
  },
  {
    locator: "apps/desktop/electron/relay-dispatch/media.ts#temporary_storage:26b4c748d749a0f9:1",
    priorLocator: "apps/desktop/electron/relay.ts#temporary_storage:26b4c748d749a0f9:1",
    priorDebtId: "debt.source-alarm.cache.temporary_storage.f308477d1751b3d9",
  },
  { locator: "apps/desktop/electron/relay-dispatch/media.ts#temporary_storage:72fdd4e295e83a2c:1" },
  {
    locator: "apps/desktop/electron/relay-dispatch/structured-ssh.ts#log_emitter:c4f22f3fb6bab4a7:1",
    priorLocator: "apps/desktop/electron/relay.ts#log_emitter:c4f22f3fb6bab4a7:1",
    priorDebtId: "debt.source-alarm.log.log_emitter.aa25149578a588cf",
  },
  {
    locator: "bin/nautilo-relay/src/index.ts#log_emitter:298c315648cf9898:1",
    owner: "bin/nautilo-relay",
  },
  {
    locator: "bin/nautilo-relay/src/index.ts#log_emitter:3bb1fac83b5e635e:1",
    owner: "bin/nautilo-relay",
  },
  {
    locator: "bin/nautilo-relay/src/index.ts#log_emitter:3bb1fac83b5e635e:2",
    owner: "bin/nautilo-relay",
  },
  {
    locator: "bin/nautilo-relay/src/index.ts#log_emitter:3bb1fac83b5e635e:3",
    owner: "bin/nautilo-relay",
  },
  {
    locator: "bin/nautilo-relay/src/index.ts#log_emitter:3bb1fac83b5e635e:4",
    owner: "bin/nautilo-relay",
  },
  {
    locator: "bin/nautilo-relay/src/index.ts#log_emitter:81dce5c37346bd89:1",
    owner: "bin/nautilo-relay",
  },
  {
    locator: "bin/nautilo-relay/src/index.ts#log_emitter:f619d618f64bfd82:1",
    owner: "bin/nautilo-relay",
  },
  {
    locator: "bin/nautilo-relay/src/pairing.ts#network_processor:2501bab67d5a1c71:1",
    owner: "bin/nautilo-relay",
  },
  {
    locator: "bin/nautilo-relay/src/pairing.ts#network_processor:2501bab67d5a1c71:2",
    owner: "bin/nautilo-relay",
  },
  {
    locator: "bin/nautilo-relay/src/pairing.ts#network_processor:2501bab67d5a1c71:3",
    owner: "bin/nautilo-relay",
  },
  {
    locator: "packages/server/src/mcp/relay-mcp-bridge.ts#log_emitter:a1436e7c26c240df:3",
    owner: "packages/server",
  },
];

/**
 * Exact old alarm rows whose call sites disappeared during extraction. Their
 * immutable source-review files remain the historical evidence; this record
 * prevents absence from being misreported as relocation or encryption work.
 */
export const RETIRED_D565_RELAY_SOURCE_ALARMS = [
  ["apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:3", "debt.source-alarm.log.log_emitter.2972aacf9b595789"],
  ["apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:4", "debt.source-alarm.log.log_emitter.6e0b97edd2f4eae3"],
  ["apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:6", "debt.source-alarm.log.log_emitter.486f63d1e45820fb"],
  ["apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:7", "debt.source-alarm.log.log_emitter.66ec86ffec5b4a01"],
  ["apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:8", "debt.source-alarm.log.log_emitter.5e5019d9c0999a3b"],
  ["apps/desktop/electron/relay.ts#log_emitter:02d6d32a757bab9d:9", "debt.source-alarm.log.log_emitter.7724cca547b1a03b"],
] as const;

function kind(locator: string): string {
  return locator.split("#", 2)[1]!.split(":", 1)[0]!.replaceAll("_", "-");
}

function surface(locator: string): CoverageSurface {
  switch (kind(locator)) {
    case "filesystem-write": return "file";
    case "subprocess-processor": return "processor";
    case "temporary-storage": return "cache";
    case "log-emitter": return "log";
    case "network-processor": return "processor";
    default: throw new Error(`unsupported D565 source alarm kind: ${locator}`);
  }
}

function debtId(locator: string, debtSurface: CoverageSurface): string {
  const alarmKind = locator.split("#", 2)[1]!.split(":", 1)[0]!;
  const digest = createHash("sha256").update(locator).digest("hex").slice(0, 16);
  return `debt.source-alarm.${debtSurface}.${alarmKind}.${digest}`;
}

function evidenceGap(locator: string, alarmKind: string): string {
  switch (alarmKind) {
    case "filesystem-write":
      return `${locator} lacks filesystem-write alarm evidence identifying the exact written bytes, destination, retention, cleanup, and encryption boundary after the D565 move.`;
    case "subprocess-processor":
      return `${locator} lacks subprocess-processor alarm evidence identifying the exact arguments, stdin, stdout, and file boundaries crossing the local program after the D565 move.`;
    case "temporary-storage":
      return `${locator} lacks temporary-storage alarm evidence identifying the exact stored bytes, device location, lifetime, cleanup, and encryption boundary after the D565 move.`;
    case "log-emitter":
      return `${locator} lacks log-emitter alarm evidence identifying the exact emitted fields, redaction contract, and plaintext-safety boundary after the D565 move.`;
    case "network-processor":
      return `${locator} lacks network-processor alarm evidence identifying the exact request and response fields, recipient boundary, and encryption bridge after the D565 move.`;
    default:
      throw new Error(`unsupported D565 source alarm kind: ${locator}`);
  }
}

const REVIEWED_D565_RELAY_RUNTIME_SOURCE_ALARMS: readonly SourceAlarmReview[] =
  D565_RELAY_SOURCE_ALARM_MIGRATIONS.map(({ locator, owner, priorLocator, priorDebtId }) => {
    const alarmKind = kind(locator);
    const debtSurface = surface(locator);
    return {
      locator,
      owner: owner ?? "apps/desktop",
      closure: "baseline_debt",
      debtId: debtId(locator, debtSurface),
      surface: debtSurface,
      remediationState: "planned",
      releaseImpact: "blocks_whole_product_claim",
      reason: `${locator} remains an explicit ${alarmKind} alarm after D565 ${priorLocator === undefined ? "made the exact adapter call scanner-visible" : `relocated the same untriaged review boundary from ${priorLocator} (${priorDebtId})`}; locator-derived debt identity changed, but no claim is made that its dynamic payload is encrypted today.`,
      evidenceGap: evidenceGap(locator, alarmKind),
    };
  });

const REVIEWED_D565_RELAY_BUILD_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    locator: "bin/nautilo-relay/src/credential-store.ts#filesystem_write:a0f84e5a669e0a65:1",
    owner: "bin/nautilo-relay",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.d565.relay-pairing-device-identity-write",
    reason: "This exclusive owner-only file write persists only schema version 1, a SHA-256 scope of the normalized server URL, and a random installation UUID. Relay tokens and user IDs remain in the operating-system keyring; symlinks, foreign ownership, broad permissions, malformed fields, partial writes, and mismatched server scopes fail closed.",
  },
  {
    locator: "apps/desktop/scripts/vendor-relay-host.ts#subprocess_processor:667e9587b804d4f5:1",
    owner: "apps/desktop",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.d565.relay-host-deterministic-bundle-build",
    reason: "This build-only subprocess invokes the repository-pinned Bun compiler against the reviewed Relay Host entrypoint and emits a local package resource; it receives no Human content, Relay credential, runtime environment payload, or encrypted product data.",
  },
  {
    locator: "apps/desktop/scripts/vendor-relay-host.ts#filesystem_write:0dabbfbd259109e8:1",
    owner: "apps/desktop",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.d565.relay-host-bundle-copy",
    reason: "This build-only copy writes the deterministic Relay Host JavaScript bundle into Desktop's generated vendor directory; it copies no runtime state, Human content, Relay credential, or encrypted product data.",
  },
  {
    locator: "apps/desktop/scripts/vendor-relay-host.ts#filesystem_write:2fea7bab3464f265:1",
    owner: "apps/desktop",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.d565.relay-host-manifest-write",
    reason: "This build-only write emits the closed Relay Host resource manifest containing only schema, component versions, byte count, filename, and SHA-256 digest; it contains no runtime state, Human content, Relay credential, or encrypted product data.",
  },
];

export const REVIEWED_D565_RELAY_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  ...REVIEWED_D565_RELAY_RUNTIME_SOURCE_ALARMS,
  ...REVIEWED_D565_RELAY_BUILD_SOURCE_ALARMS,
];
