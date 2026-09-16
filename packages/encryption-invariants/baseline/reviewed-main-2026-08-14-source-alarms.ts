import type { SourceAlarmReview } from "../src/node/source-alarm-review";

function declaration(
  locator: string,
  declarationId: string,
  reason: string,
): SourceAlarmReview {
  return {
    locator,
    owner: locator.split("/").slice(0, 2).join("/"),
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
    owner: locator.split("/").slice(0, 2).join("/"),
    closure: "reviewed_exclusion",
    exclusionId,
    reason,
  };
}

export const REVIEWED_MAIN_2026_08_14_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  declaration(
    "packages/agent/src/image-gen/openrouter.ts#network_processor:c7e5044b5f4126d9:1",
    "source.processor.image-generation.openrouter-network",
    "This exact provider call is part of the existing image-generation processor boundary: it discloses the authorized prompt to OpenRouter and receives generated image bytes under the same explicit provider-processing contract.",
  ),
  declaration(
    "packages/agent/src/image-gen/venice.ts#network_processor:bdb97ea30e585f40:1",
    "source.processor.image-generation.venice-network",
    "This exact provider call is part of the existing image-generation processor boundary: it discloses the authorized prompt to Venice and receives generated image bytes under the same explicit provider-processing contract.",
  ),
  declaration(
    "packages/agent/src/utils/chat-model-invocation.ts#log_emitter:7ef703451e44cded:10",
    "source.log.generic",
    "This fallback-transition diagnostic emits only canonical model identifiers and a fixed transition label; it contains no prompt, response, Human content, credential, or provider error body.",
  ),
  exclusion(
    "packages/db/scripts/finalize-m264-reflection-search.ts#filesystem_write:3dcc6339408547a4:1",
    "exclusion.main-2026-08-14.reflection-search-migration-finalizer",
    "This exact build-time Drizzle finalizer writes only deterministic immutable migration SQL before commit and is not reachable from product runtime data processing.",
  ),
  declaration(
    "packages/lattice-bridge/src/artifact/filesystem-blob-store.ts#filesystem_write:ca701904b80d822f:2",
    "source.main-2026-08-14.file.encrypted-artifact-staged-blob",
    "This hard-link atomically publishes an already authenticated encrypted Artifact blob from its repository-confined temporary name; plaintext and keys never cross the file boundary.",
  ),
  exclusion(
    "packages/lattice-bridge/src/client/artifact/authorized-human-artifact-client.ts#filesystem_write:691255064083f0a9:1",
    "exclusion.main-2026-08-14.artifact-client-rename-method",
    "The scanner matched the product client's rename method name; the method revises encrypted Artifact control state through the API and performs no filesystem operation.",
  ),
  declaration(
    "packages/lattice-bridge/src/client/artifact/file-prepared-artifact-ciphertext-sidecar.ts#filesystem_write:cddbf2b81e5af93f:1",
    "source.main-2026-08-14.file.prepared-artifact-ciphertext-stage",
    "This private sidecar stream contains only prepared authenticated Artifact ciphertext while a restart-safe client mutation is pending; plaintext and keys are never written.",
  ),
  declaration(
    "packages/lattice-bridge/src/client/artifact/file-prepared-artifact-ciphertext-sidecar.ts#filesystem_write:51f8ff9b9b4d0aa6:1",
    "source.main-2026-08-14.file.prepared-artifact-ciphertext-publish",
    "This atomic rename publishes the already-written private Artifact ciphertext sidecar and introduces no plaintext or key material.",
  ),
  declaration(
    "packages/lattice-bridge/src/client/artifact/file-prepared-artifact-ciphertext-sidecar.ts#filesystem_write:cddbf2b81e5af93f:2",
    "source.main-2026-08-14.file.prepared-artifact-ciphertext-copy",
    "This private sidecar copy contains only prepared authenticated Artifact ciphertext validated against its declared length and digest; plaintext and keys are never written.",
  ),
  declaration(
    "packages/lattice-bridge/src/client/artifact/file-prepared-artifact-ciphertext-sidecar.ts#filesystem_write:51f8ff9b9b4d0aa6:2",
    "source.main-2026-08-14.file.prepared-artifact-ciphertext-copy-publish",
    "This atomic rename publishes the validated private Artifact ciphertext sidecar copy and introduces no plaintext or key material.",
  ),
  exclusion(
    "packages/runtime/src/durable-tool-result-lifecycle.ts#log_emitter:c4f22f3fb6bab4a7:1",
    "exclusion.main-2026-08-14.durable-tool-observer-fixed-warning",
    "This observer-failure warning is a fixed literal deliberately containing no content, identifier, target, exception, or structured payload.",
  ),
  exclusion(
    "packages/runtime/src/foreground-turn-lifecycle.ts#log_emitter:c4f22f3fb6bab4a7:1",
    "exclusion.main-2026-08-14.foreground-observer-fixed-warning",
    "This eligibility-observer warning is a fixed literal deliberately containing no content, identifier, target, exception, or structured payload.",
  ),
];

export const SUPERSEDED_MAIN_2026_08_14_SOURCE_ALARM_LOCATORS = new Set<string>([
  "packages/agent/src/config/assistant-models.ts#log_emitter:dd1e11e579dcff10:1",
  "packages/agent/src/config/assistant-models.ts#log_emitter:dd1e11e579dcff10:2",
  "packages/agent/src/config/assistant-models.ts#log_emitter:dd1e11e579dcff10:3",
  "packages/server/src/routes/ws.ts#log_emitter:89b81c36ea23316a:1",
  "packages/server/src/routes/ws.ts#log_emitter:89b81c36ea23316a:2",
  "packages/server/src/routes/ws.ts#log_emitter:89b81c36ea23316a:3",
  "packages/server/src/routes/ws.ts#log_emitter:a1436e7c26c240df:1",
]);
