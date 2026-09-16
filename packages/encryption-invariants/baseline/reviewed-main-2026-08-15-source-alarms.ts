import { createHash } from "node:crypto";

import type { CoverageSurface } from "../src/model";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";

function owner(locator: string): string {
  return locator.split("#", 1)[0]!.split("/").slice(0, 2).join("/");
}

function declaration(
  locator: string,
  declarationId: string,
  reason: string,
): SourceAlarmReview {
  return {
    locator,
    owner: owner(locator),
    closure: "declaration",
    declarationId,
    reason,
  };
}

function exclusion(
  locator: string,
  exclusionId: string,
  reason: string,
): SourceAlarmReview {
  return {
    locator,
    owner: owner(locator),
    closure: "reviewed_exclusion",
    exclusionId,
    reason,
  };
}

function debt(
  locator: string,
  surface: CoverageSurface,
  reason: string,
  evidenceGap: string,
  releaseImpact: "blocks_enabled_scope" | "blocks_whole_product_claim",
): SourceAlarmReview {
  const kind = locator.split("#", 2)[1]!.split(":", 1)[0]!;
  const digest = createHash("sha256").update(locator).digest("hex").slice(0, 16);
  const marker = kind === "filesystem_write"
    ? "filesystem-write alarm"
    : kind === "log_emitter"
      ? "log-emitter alarm"
      : "backup/export alarm";
  return {
    locator,
    owner: owner(locator),
    closure: "baseline_debt",
    debtId: `debt.source-alarm.${surface}.${kind}.${digest}`,
    surface,
    remediationState: "untriaged",
    releaseImpact,
    reason: `${locator} is a current ${marker}. ${reason}`,
    evidenceGap: `${locator} lacks complete closure evidence for this ${marker}. ${evidenceGap}`,
  };
}

export const SUPERSEDED_MAIN_2026_08_15_SOURCE_ALARM_LOCATORS =
  new Set<string>([
    "apps/cli/src/commands/backup.ts#backup_export:8aef6d94287388b2:1",
  ]);

export const REVIEWED_MAIN_2026_08_15_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  debt(
    "apps/cli/src/commands/backup.ts#backup_export:32617645b0b01ca2:1",
    "backup",
    "The refactored CLI still initiates the existing whole-instance Compose backup boundary, whose archive may contain every current plaintext content class and therefore remains explicit release-blocking backup debt.",
    "The encryption rollout must prove that backup creation, retention, restoration, and operator transfer preserve protected records without introducing plaintext exports before the whole-product encryption claim.",
    "blocks_whole_product_claim",
  ),
  declaration(
    "bin/nautilo-server/src/index.ts#log_emitter:7ef703451e44cded:15",
    "source.main-2026-08-15.log.server-mdns-announcement",
    "This boot diagnostic emits only the configured mDNS hostname and bounded instance display name after successful announcement; it contains no Human content, credential, key, prompt, Record, Memory, or Artifact payload.",
  ),
  declaration(
    "bin/nautilo-server/src/index.ts#log_emitter:7ef703451e44cded:16",
    "source.main-2026-08-15.log.server-listening-origin",
    "This boot diagnostic emits only the resolved server listening origin after readiness and contains no Human content, credential, key, prompt, Record, Memory, or Artifact payload.",
  ),
  debt(
    "packages/agent/src/media-generation/artifact-writer.ts#filesystem_write:d4aeedf8367a20dc:1",
    "file",
    "This atomic rename publishes generated video or music bytes into the current plaintext Workspace Artifact store. The bytes are Human-directed Artifact content and must remain visible as enabled-scope debt until Artifact encryption owns this writer.",
    "A later Artifact integration wave must route the staged media bytes through the protected Artifact writer and prove crash-safe cleanup without retaining a plaintext final file.",
    "blocks_enabled_scope",
  ),
  debt(
    "packages/agent/src/nodes/post-model.ts#log_emitter:89b81c36ea23316a:7",
    "log",
    "The share_artifact approval-preview fallback currently interpolates caught error text. That exception path is not yet proven to exclude Artifact identifiers, paths, Human content, or provider-derived text.",
    "Add executable redaction evidence or replace the interpolated exception with a fixed classifier before claiming the Artifact scope is fully protected.",
    "blocks_enabled_scope",
  ),
  debt(
    "packages/compose-lifecycle/src/lifecycle.ts#backup_export:9edc15f28c86b2a1:1",
    "backup",
    "The shared lifecycle wrapper invokes the same whole-instance Compose backup operation and can therefore export every current plaintext content class; refactoring ownership does not make that archive encrypted.",
    "The encryption rollout must prove protected backup and restore semantics at this shared lifecycle boundary before the whole-product encryption claim.",
    "blocks_whole_product_claim",
  ),
  declaration(
    "packages/compose-lifecycle/src/readiness.ts#network_processor:61f7a050dd0a026e:1",
    "source.main-2026-08-15.processor.compose-release-readiness",
    "This operator preflight performs one fixed release-readiness request. Local transport sends the existing bootstrap bearer only to the resolved Nautilo server endpoint; remote transport sends no bearer. The response is restricted to content-free active-work counts.",
  ),
  exclusion(
    "packages/compose-lifecycle/src/types.ts#backup_export:3b1e90e056a34fe5:1",
    "exclusion.main-2026-08-15.compose-backup-interface",
    "The scanner matched a TypeScript interface method declaration. This file executes no backup, reads no product data, and transports no archive bytes.",
  ),
  exclusion(
    "packages/db/scripts/finalize-m271-reflection-semantic-work.ts#filesystem_write:3dcc6339408547a4:1",
    "exclusion.main-2026-08-15.reflection-semantic-work-finalizer",
    "This exact build-time Drizzle finalizer writes only deterministic immutable migration SQL before commit and is not reachable from product runtime data processing.",
  ),
  declaration(
    "packages/runtime/src/reflection/semantic-sleep-worker.ts#log_emitter:beea086e1bde4b98:1",
    "source.main-2026-08-15.log.reflection-worker-warning-adapter",
    "This injected warning adapter receives only the worker's fixed lifecycle messages and content-free fields defined by resultLogFields; it receives no query, statement, source excerpt, prompt, provider body, identifier, key, audience, or evidence content.",
  ),
  declaration(
    "packages/runtime/src/reflection/semantic-sleep-worker.ts#log_emitter:6c54dafd09158e6d:1",
    "source.main-2026-08-15.log.reflection-worker-info-adapter",
    "This injected information adapter receives only fixed Reflection worker lifecycle messages and bounded aggregate counters, closed operation/failure counts, and booleans; it receives no semantic content or identity.",
  ),
  declaration(
    "packages/runtime/src/reflection/semantic-sleep-worker.ts#log_emitter:794aa27d55622eb3:1",
    "source.main-2026-08-15.log.reflection-worker-warn-adapter",
    "This injected warning adapter receives only fixed Reflection worker lifecycle messages and bounded aggregate counters, closed operation/failure counts, and booleans; it receives no semantic content or identity.",
  ),
  declaration(
    "packages/runtime/src/reflection/semantic-sleep-worker.ts#log_emitter:c7761f38ffc51ff7:1",
    "source.main-2026-08-15.log.reflection-worker-error-adapter",
    "This injected error adapter receives only the fixed semantic-poll failure message and fixed unexpected_failure classifier; caught exception text and semantic inputs are deliberately discarded.",
  ),
  declaration(
    "packages/server/src/app.ts#log_emitter:dd9ce09822966263:1",
    "source.main-2026-08-15.log.reflection-runtime-unavailable",
    "This startup warning is a fixed Reflection runtime-unavailable message with the fixed unexpected_failure code. The caught exception is discarded, so no query, statement, prompt, provider body, identifier, key, audience, or evidence content is logged.",
  ),
];
