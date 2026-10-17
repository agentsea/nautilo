import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_PAID_SERVICE_FUNDING_SOURCE_ALARM_LOCATORS =
  new Set<string>([
    "packages/cloudconvert/src/service.ts#network_processor:ce2c37599df86e21:1",
  ]);

export const REVIEWED_PAID_SERVICE_FUNDING_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  {
    locator:
      "packages/cloudconvert/src/client.ts#network_processor:e10a62d0aeee93ad:1",
    owner: "packages/cloudconvert",
    closure: "declaration",
    declarationId: "source.paid-service.cloudconvert-job-create",
    reason:
      "This exact abortable CloudConvert job-create request belongs to the existing plaintext provider processor boundary. It sends the admitted API key in the authorization header and the bounded conversion job configuration to the configured CloudConvert API endpoint; response bodies are parsed as provider job receipts and are not logged. This declaration does not make an encrypted-processing claim.",
  },
  {
    locator:
      "packages/cloudconvert/src/service.ts#network_processor:09f91d7fd88ab737:1",
    owner: "packages/cloudconvert",
    closure: "declaration",
    declarationId: "source.paid-service.cloudconvert-output-fetch",
    reason:
      "This exact manual-redirect fetch receives plaintext conversion output at the existing CloudConvert processor boundary. The initial URL and each of at most three redirects must use HTTPS on the cloudconvert.com domain, downloads are size-bounded, and provider URLs and response bytes are not logged; this declaration does not make an encrypted-processing claim.",
  },
  {
    locator:
      "packages/server/src/connected-apps/service.ts#log_emitter:89b81c36ea23316a:2",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.paid-service-funding.hosted-cost-settlement-warning",
    reason:
      "This exact warning emits one fixed hosted cost-settlement-unavailable literal. It includes no Human, Room, Agent, tool, provider, request, response, credential, URL, error object, or content value.",
  },
  {
    locator:
      "packages/server/src/lib/personal-llm-attempt-owner.ts#log_emitter:dd9ce09822966263:1",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.paid-service-funding.personal-attempt-owner-heartbeat-warning",
    reason:
      "This exact heartbeat warning emits one fixed operational literal and the fixed failureCode attempt_owner_heartbeat_failed. It includes no Human, Room, Agent, provider, attempt, owner token, credential, request, response, error object, URL, prompt, or content value; packages/encryption-invariants/tests/integration/reviewed-personal-attempt-owner-source-alarm.test.ts executable evidence fixes the complete emitted shape.",
  },
  {
    locator:
      "packages/agent/src/usage/service-embedding-attempt.ts#log_emitter:dd9ce09822966263:1",
    owner: "packages/agent",
    closure: "reviewed_exclusion",
    exclusionId:
      "exclusion.paid-service-funding.embedding-settlement-warning",
    reason:
      "This exact post-wire accounting warning emits one fixed service-embedding settlement-unavailable literal and the fixed failureCode attempt_settlement_failed. It includes no embedding input, vector, Human, Room, model, provider, attempt id, credential, request, response, caught error, or provider text; the durable pre-wire row remains the recovery authority.",
  },
];
