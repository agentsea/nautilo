import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_RELEASE_RECONCILIATION_SOURCE_ALARM_LOCATORS = new Set<string>([
  "apps/desktop/electron/github-broker/credentials.ts#subprocess_processor:e0860b0bb9ba56dd:1",
  "apps/desktop/electron/github-broker/git-transport.ts#filesystem_write:ebf4a3236bf7fa06:1",
  "apps/desktop/electron/github-broker/git-transport.ts#filesystem_write:ee2f23a152ca7d93:1",
  "apps/desktop/electron/github-broker/git-transport.ts#subprocess_processor:c853fd5a0355e1c4:1",
  "apps/desktop/electron/github-broker/git-transport.ts#temporary_storage:5e8b4802fb910cc5:1",
  "apps/desktop/electron/github-git-runtime.ts#subprocess_processor:f84b7610822c844f:1",
  "apps/desktop/electron/relay-dispatch/github.ts#network_processor:a66802550f09d2dd:1",
  "packages/agent/src/image-gen/google.ts#network_processor:5f38f95260427395:1",
  "packages/agent/src/image-gen/google.ts#network_processor:9491314392baee7b:1",
  "packages/agent/src/image-gen/openai.ts#network_processor:ef993855494c1601:1",
  "packages/agent/src/image-gen/openai.ts#network_processor:ef993855494c1601:2",
  "packages/agent/src/image-gen/openrouter.ts#network_processor:c7e5044b5f4126d9:1",
  "packages/agent/src/image-gen/venice.ts#network_processor:bdb97ea30e585f40:1",
  "packages/agent/src/tools/config/find-voice.ts#network_processor:c3de5b89228bea5a:1",
  "packages/agent/src/tools/media/generate-image.ts#filesystem_write:c07c9e85c7ed687d:1",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:0cfd5a6318acc19f:1",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:76e1564f17ff0ffe:1",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:7ef703451e44cded:8",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:dbdbad31f308a711:1",
  "packages/sandbox/src/git-broker/broker.ts#network_processor:dea009441a2ab912:1",
  "packages/sandbox/src/git-broker/execute.ts#subprocess_processor:a0c0c8f56ca79710:1",
  "packages/server/src/routes/voices.ts#filesystem_write:ade9f5fd49d9bb91:1",
  "packages/server/src/routes/voices.ts#network_processor:7907832a724bb197:1",
  "packages/server/src/routes/voices.ts#network_processor:e13447c78a55d6f5:1"
]);

export const REVIEWED_RELEASE_RECONCILIATION_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    locator: "packages/agent/src/tools/media/generate-image.ts#log_emitter:89b81c36ea23316a:2",
    owner: "packages/agent",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.release-reconciliation.image-provider-failure",
    reason:
      "This image-provider diagnostic emits only a fixed sentence and the literal IMAGE_PROVIDER_FAILED code. The caller-facing result may retain the provider error, but the log excludes prompts, generated media, provider responses, credentials, identifiers, and caught exceptions.",
  },
  {
    locator: "packages/agent/src/tools/media/generate-image.ts#log_emitter:89b81c36ea23316a:3",
    owner: "packages/agent",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.release-reconciliation.image-publication-failure",
    reason:
      "This generated-image publication diagnostic emits only a fixed sentence and the literal IMAGE_PUBLICATION_FAILED code. It excludes prompts, generated media, paths, provider responses, credentials, identifiers, and caught exceptions.",
  },
  {
    locator: "packages/agent/src/tools/media/generated-image-publication.ts#log_emitter:89b81c36ea23316a:1",
    owner: "packages/agent",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.release-reconciliation.image-retention-failure",
    reason:
      "This generated-image retention diagnostic emits only a fixed sentence and the literal IMAGE_RETENTION_FAILED code. It excludes prompts, generated media bytes, paths, provider responses, credentials, identifiers, and caught exceptions.",
  },
  {
    "locator": "packages/agent/src/image-gen/funded-attempt.ts#log_emitter:dd9ce09822966263:1",
    "owner": "packages/agent",
    "closure": "reviewed_exclusion",
    "exclusionId": "exclusion.release-reconciliation.1",
    "reason": "This settlement diagnostic emits a fixed sentence and the literal attempt_settlement_failed code only. It excludes prompts, generated media, provider responses, credentials, identifiers, and caught exceptions."
  },
  {
    "locator": "packages/agent/src/image-gen/funded-attempt.ts#log_emitter:dd9ce09822966263:2",
    "owner": "packages/agent",
    "closure": "reviewed_exclusion",
    "exclusionId": "exclusion.release-reconciliation.2",
    "reason": "This settlement diagnostic emits a fixed sentence and the literal attempt_settlement_failed code only. It excludes prompts, generated media, provider responses, credentials, identifiers, and caught exceptions."
  },
  {
    "locator": "packages/agent/src/image-gen/google.ts#network_processor:1f5d93d646b60133:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.3",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
  {
    "locator": "packages/agent/src/image-gen/google.ts#network_processor:7a5f2e49fb63950c:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.4",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
  {
    "locator": "packages/agent/src/image-gen/openai.ts#network_processor:178bb04f9824fabc:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.5",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
  {
    "locator": "packages/agent/src/image-gen/openai.ts#network_processor:178bb04f9824fabc:2",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.6",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
  {
    "locator": "packages/agent/src/image-gen/openai.ts#network_processor:178bb04f9824fabc:3",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.7",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
  {
    "locator": "packages/agent/src/image-gen/openrouter.ts#network_processor:208e4d51e478fcab:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.8",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
  {
    "locator": "packages/agent/src/image-gen/surplus-attempt.ts#log_emitter:dd9ce09822966263:1",
    "owner": "packages/agent",
    "closure": "reviewed_exclusion",
    "exclusionId": "exclusion.release-reconciliation.9",
    "reason": "This settlement diagnostic emits a fixed sentence and the literal attempt_settlement_failed code only. It excludes prompts, generated media, provider responses, credentials, identifiers, and caught exceptions."
  },
  {
    "locator": "packages/agent/src/image-gen/surplus-attempt.ts#log_emitter:dd9ce09822966263:2",
    "owner": "packages/agent",
    "closure": "reviewed_exclusion",
    "exclusionId": "exclusion.release-reconciliation.10",
    "reason": "This settlement diagnostic emits a fixed sentence and the literal attempt_settlement_failed code only. It excludes prompts, generated media, provider responses, credentials, identifiers, and caught exceptions."
  },
  {
    "locator": "packages/agent/src/image-gen/venice.ts#network_processor:acc2d46afc22cb60:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.11",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
  {
    "locator": "packages/agent/src/tools/config/find-voice.ts#network_processor:19aa5366c7d24f08:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.12",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
  {
    "locator": "packages/db/scripts/finalize-media-funding-binding.ts#filesystem_write:64bad91c2cb54890:1",
    "owner": "packages/db",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.16",
    "reason": "This developer-only migration finalizer writes only the deterministic reviewed SQL migration text back to the latest migration file; it never handles runtime Human content, provider payloads, credentials, or keys."
  },
  {
    "locator": "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:7ef703451e44cded:8",
    "owner": "packages/runtime",
    "closure": "reviewed_exclusion",
    "exclusionId": "exclusion.release-reconciliation.17",
    "reason": "This usage diagnostic emits only three nonnegative token counters parsed from provider metadata. It excludes prompts, model output, identifiers, credentials, provider responses, and caught exceptions."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:12",
    "owner": "packages/runtime",
    "closure": "reviewed_exclusion",
    "exclusionId": "exclusion.release-reconciliation.18",
    "reason": "This ordinary Task time-limit diagnostic emits only a bounded lifecycle status and one opaque Task UUID after the pause transition returns. It excludes Task content, result bodies, transcripts, checkpoint bytes, tool payloads, credentials, keys, and caught exceptions."
  },
  {
    "locator": "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:13",
    "owner": "packages/runtime",
    "closure": "reviewed_exclusion",
    "exclusionId": "exclusion.release-reconciliation.19",
    "reason": "This protected Task watchdog recovery diagnostic emits only the fixed pause-retry code. It emits no Task content, results, identifiers, tool payloads, credentials, keys, or caught exceptions."
  },
  {
    "locator": "packages/server/src/media-generation/production-runtime.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/server",
    "closure": "reviewed_exclusion",
    "exclusionId": "exclusion.release-reconciliation.20",
    "reason": "This media accounting diagnostic emits one fixed settlement-unavailable sentence. It excludes prompts, generated media, provider responses, receipt identifiers, credentials, and caught exceptions."
  },
  {
    "locator": "packages/server/src/routes/stt.ts#log_emitter:9f5e50d7116f471e:1",
    "owner": "packages/server",
    "closure": "reviewed_exclusion",
    "exclusionId": "exclusion.release-reconciliation.21",
    "reason": "This speech-accounting diagnostic emits a fixed sentence and the admitted provider enum only. It excludes audio, transcripts, credentials, provider responses, Human identifiers, and caught exceptions."
  },
  {
    "locator": "packages/server/src/routes/voices.ts#filesystem_write:8abd481f30d455e4:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.22",
    "reason": "This exact voice-preview cache boundary atomically writes provider-generated audio to a mode-0600 temporary file and renames it to the bounded server cache path. It makes no at-rest encryption claim and does not log the audio bytes or input text."
  },
  {
    "locator": "packages/server/src/routes/voices.ts#filesystem_write:f68b0e5d292e324e:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.23",
    "reason": "This exact voice-preview cache boundary atomically writes provider-generated audio to a mode-0600 temporary file and renames it to the bounded server cache path. It makes no at-rest encryption claim and does not log the audio bytes or input text."
  },
  {
    "locator": "packages/server/src/routes/voices.ts#network_processor:6a752f27d26973a7:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.24",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
  {
    "locator": "packages/server/src/routes/voices.ts#network_processor:c21c0a0826ecbb88:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.25",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
  {
    "locator": "packages/server/src/routes/voices.ts#network_processor:f631187145ff11af:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.release-reconciliation.26",
    "reason": "This exact provider boundary sends the user-requested media or voice input and admitted provider credential to the configured HTTPS provider endpoint, then reads a size-bounded response. It does not log provider payloads and makes no encrypted-processing claim."
  },
];
