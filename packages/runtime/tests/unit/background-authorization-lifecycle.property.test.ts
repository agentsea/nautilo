import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT,
  BackgroundAuthorizationTransitionError,
  advanceBackgroundAuthorizationGeneration,
  attachBackgroundAuthorizationRecipient,
  createBackgroundAuthorizationRequest,
  parseBackgroundAuthorizationRequestSnapshot,
} from "../../src/protected-execution/background-authorization";

const RUNS = 300;
const RECIPIENT_PUBLIC_KEY = Buffer.alloc(65, 1).toString("base64url");

function nextSeed(value: number): number {
  return (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
}

describe("Wave 10 background authorization lifecycle properties", () => {
  test("generation is strictly monotonic and every delayed generation is rejected", () => {
    let seed = 0x4d323431;
    let now = 1_000;
    let request = createBackgroundAuthorizationRequest({
      requestId: "request-property",
      workId: "work-property",
      namespaceId: "namespace-property",
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
        authorizationRevision: 7,
      },
      now,
    });

    for (
      let index = 0;
      index < BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT * 4;
      index += 1
    ) {
      seed = nextSeed(seed);
      now += 1 + (seed % 5);
      request = attachBackgroundAuthorizationRecipient(request, {
        recipientGeneration: request.recipientGeneration,
        descriptorDigest: "cd".repeat(32),
        recipientKeyId: `key-${index}`,
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        expiresAt: now + 10,
        now,
      });
      const priorGeneration = request.recipientGeneration;
      now = request.recipient!.expiresAt;
      request = advanceBackgroundAuthorizationGeneration(request, {
        reason: "attempt_expired",
        now,
        nextAttemptAt: now,
      });

      expect(request.recipientGeneration).toBe(priorGeneration + 1);
      expect(request.retryCount).toBe(0);
      expect(() => attachBackgroundAuthorizationRecipient(request, {
        recipientGeneration: priorGeneration,
        descriptorDigest: "ef".repeat(32),
        recipientKeyId: `late-${index}`,
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        expiresAt: now + 10,
        now,
      })).toThrow(
        new BackgroundAuthorizationTransitionError("stale_generation"),
      );
      expect(parseBackgroundAuthorizationRequestSnapshot(request)).toEqual(
        request,
      );
    }
  });

  test("an arbitrary added field always fails exact-field parsing", () => {
    const request = createBackgroundAuthorizationRequest({
      requestId: "request-fields",
      workId: "work-fields",
      namespaceId: "namespace-fields",
      credentialSubject: {
        kind: "agent",
        agentId: "agent-1",
        runtimeGeneration: 1,
        authorizationRevision: 2,
      },
      now: 10,
    });
    let seed = 0xdeadbeef;

    for (let index = 0; index < RUNS; index += 1) {
      seed = nextSeed(seed);
      const field = `unknown_${seed.toString(16)}_${index}`;
      expect(() => parseBackgroundAuthorizationRequestSnapshot({
        ...request,
        [field]: seed,
      })).toThrow(TypeError);
    }
  });
});
