import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_MAIN_2026_08_21_SOURCE_ALARM_LOCATORS =
  new Set<string>([
    "packages/server/src/realtime/tts-service.ts#log_emitter:89b81c36ea23316a:4",
  ]);

export const REVIEWED_MAIN_2026_08_21_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  {
    locator:
      "packages/server/src/realtime/tts-service.ts#log_emitter:ca12f35ec09fcd0d:1",
    owner: "packages/server",
    closure: "declaration",
    declarationId: "source.main-2026-08-21.tts-missing-credential-warning",
    reason:
      "This branch emits one of two fixed warning literals selected by deployment mode. It interpolates no API key, provider response, sentence, Human identifier, voice setting, exception, prompt, or synthesized audio.",
  },
];
