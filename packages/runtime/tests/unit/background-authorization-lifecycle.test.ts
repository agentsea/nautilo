import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
  BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT,
  BACKGROUND_AUTHORIZATION_MAX_TTL_MS,
  BACKGROUND_AUTHORIZATION_TERMINAL_REASONS,
  BackgroundAuthorizationTransitionError,
  advanceBackgroundAuthorizationGeneration,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequestV2,
  failBackgroundAuthorizationRequest,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  markBackgroundAuthorizationPublicationReconciliation,
  parseBackgroundAuthorizationRequestSnapshot,
  restartBackgroundAuthorizationAfterUncommittedPublication,
  scheduleBackgroundAuthorizationPublicationRetry,
  type BackgroundAuthorizationCredentialSubject,
} from "../../src/protected-execution/background-authorization";

const NOW = 10_000;
const DIGEST = "ab".repeat(32);
const RESPONSE_DIGEST = "cd".repeat(32);
const CREDENTIAL_DIGEST = "ef".repeat(32);
const RECIPIENT_PUBLIC_KEY = Buffer.alloc(65, 1).toString("base64url");

const PROCESSOR_SUBJECT = Object.freeze({
  kind: "processor",
  processorKind: "stenographer",
  processorVersion: 1,
  authorizationRevision: 7,
} satisfies BackgroundAuthorizationCredentialSubject);

const AGENT_SUBJECT = Object.freeze({
  kind: "agent",
  agentId: "agent-genie",
  runtimeGeneration: 7,
  authorizationRevision: 11,
} satisfies BackgroundAuthorizationCredentialSubject);

function initial(
  subject: BackgroundAuthorizationCredentialSubject = PROCESSOR_SUBJECT,
) {
  return createBackgroundAuthorizationRequest({
    requestId: "request-1",
    workId: "batch-42",
    namespaceId: "room-1",
    credentialSubject: subject,
    now: NOW,
  });
}

function recipientReady(
  subject: BackgroundAuthorizationCredentialSubject = PROCESSOR_SUBJECT,
) {
  return attachBackgroundAuthorizationRecipient(initial(subject), {
    recipientKeyId: "recipient-key-1",
    recipientPublicKey: RECIPIENT_PUBLIC_KEY,
    descriptorDigest: DIGEST,
    expiresAt: NOW + 60_000,
    now: NOW + 1,
  });
}

function grantReady(
  subject: BackgroundAuthorizationCredentialSubject = PROCESSOR_SUBJECT,
  now = NOW + 2,
) {
  const waiting = recipientReady(subject);
  return markBackgroundAuthorizationGrantReady(waiting, {
    kind: subject.kind,
    requestId: waiting.requestId,
    descriptorDigest: waiting.descriptorDigest!,
    recipientKeyId: waiting.recipient!.recipientKeyId,
    recipientPublicKey: waiting.recipient!.recipientPublicKey,
    expiresAt: waiting.recipient!.expiresAt,
    responseDigest: RESPONSE_DIGEST,
    credentialDigest: CREDENTIAL_DIGEST,
    issuingHumanId: "human-alice",
    issuingDeviceId: "device-alice-1",
    recipientGeneration: 0,
    now,
  });
}

describe("Wave 10 background authorization lifecycle", () => {
  test("creates an exact frozen awaiting-recipient snapshot for either subject kind", () => {
    const processor = initial();
    const agent = initial(AGENT_SUBJECT);

    expect(processor).toEqual({
      formatVersion: 1,
      requestId: "request-1",
      workId: "batch-42",
      namespaceId: "room-1",
      descriptorDigest: null,
      credentialSubject: PROCESSOR_SUBJECT,
      recipientGeneration: 0,
      recipient: null,
      acceptedResponse: null,
      state: "awaiting_recipient",
      claimId: null,
      claimExpiresAt: null,
      requestRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
      retryCount: 0,
      lastRetryReason: null,
      nextAttemptAt: null,
      terminalReason: null,
    });
    expect(agent.credentialSubject).toEqual(AGENT_SUBJECT);
    expect(Object.isFrozen(processor)).toBe(true);
    expect(Object.isFrozen(processor.credentialSubject)).toBe(true);
  });

  test("runs the one-way happy path and keeps terminal snapshots secret-free", () => {
    const waiting = recipientReady();
    const ready = grantReady();
    const claimed = claimBackgroundAuthorizationRequest(
      ready,
      "claim-1",
      NOW + 3,
      NOW + 3 + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
    );
    const running = markBackgroundAuthorizationRunning(claimed, NOW + 4);
    const reconciling =
      markBackgroundAuthorizationPublicationReconciliation(
        running,
        NOW + 5,
      );
    const publicationRetry =
      scheduleBackgroundAuthorizationPublicationRetry(reconciling, {
        now: NOW + 6,
        nextAttemptAt: NOW + 50,
      });
    const completed = completeBackgroundAuthorizationRequest(
      publicationRetry,
      NOW + 50,
    );

    expect([
      waiting.state,
      ready.state,
      claimed.state,
      running.state,
      reconciling.state,
      publicationRetry.state,
      completed.state,
    ]).toEqual([
      "awaiting_device",
      "grant_ready",
      "claimed",
      "running",
      "publication_reconciliation",
      "publication_reconciliation",
      "completed",
    ]);
    expect(publicationRetry).toMatchObject({
      recipientGeneration: 0,
      recipient: null,
      claimId: null,
      retryCount: 1,
      lastRetryReason: "publication_pending",
      nextAttemptAt: NOW + 50,
    });
    expect(ready.acceptedResponse).toEqual({
      kind: "processor",
      responseDigest: RESPONSE_DIGEST,
      credentialDigest: CREDENTIAL_DIGEST,
      issuingHumanId: "human-alice",
      issuingDeviceId: "device-alice-1",
      recipientGeneration: 0,
      acceptedAt: NOW + 2,
    });
    expect(completed.recipient).toBeNull();
    expect(completed.claimId).toBeNull();
    expect(completed.terminalReason).toBeNull();
  });

  test("starts a new recipient generation only after a fenced publication proves no commit", () => {
    const running = markBackgroundAuthorizationRunning(
      claimBackgroundAuthorizationRequest(
        grantReady(),
        "claim-uncommitted",
        NOW + 3,
        NOW + 3 + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
      ),
      NOW + 4,
    );
    const fenced = markBackgroundAuthorizationPublicationReconciliation(
      running,
      NOW + 3 + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
    );
    const restarted =
      restartBackgroundAuthorizationAfterUncommittedPublication(
        fenced,
        {
          now: NOW + 4 + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
          nextAttemptAt:
            NOW + 4 + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
        },
      );

    expect(restarted).toMatchObject({
      state: "awaiting_recipient",
      recipientGeneration: 1,
      descriptorDigest: null,
      recipient: null,
      acceptedResponse: null,
      lastRetryReason: "claim_expired",
    });
  });

  test("advances the generation after recipient loss and rejects an old response", () => {
    const waiting = recipientReady();
    const advanced = advanceBackgroundAuthorizationGeneration(waiting, {
      reason: "recipient_lost",
      now: NOW + 2,
      nextAttemptAt: NOW + 3,
    });

    expect(advanced).toMatchObject({
      state: "awaiting_recipient",
      recipientGeneration: 1,
      descriptorDigest: null,
      recipient: null,
      retryCount: 0,
      lastRetryReason: "recipient_lost",
      nextAttemptAt: NOW + 3,
    });
    expect(() => attachBackgroundAuthorizationRecipient(advanced, {
      recipientGeneration: 0,
      descriptorDigest: "ef".repeat(32),
      recipientKeyId: "late-key",
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      expiresAt: NOW + 60_000,
      now: NOW + 3,
    })).toThrow(
      new BackgroundAuthorizationTransitionError("stale_generation"),
    );

    const replacement = attachBackgroundAuthorizationRecipient(advanced, {
      recipientGeneration: 1,
      descriptorDigest: "cd".repeat(32),
      recipientKeyId: "replacement-key",
      recipientPublicKey: Buffer.alloc(65, 2).toString("base64url"),
      expiresAt: NOW + 60_000,
      now: NOW + 3,
    });
    expect(replacement.recipientGeneration).toBe(1);
    expect(replacement.descriptorDigest).toBe("cd".repeat(32));
    expect(replacement.recipient?.recipientKeyId).toBe("replacement-key");
    expect(replacement.nextAttemptAt).toBeNull();
  });

  test("unused accepted grants and expired claims rotate without spending execution retries", () => {
    const ready = grantReady();
    const claimed = claimBackgroundAuthorizationRequest(
      ready, "claim-before-restart", NOW + 3, NOW + 30_000,
    );
    for (const snapshot of [ready, claimed]) {
      const next = advanceBackgroundAuthorizationGeneration(snapshot, {
        reason: "recipient_lost",
        now: NOW + 4,
        nextAttemptAt: NOW + 5,
      });
      expect(next).toMatchObject({
        state: "awaiting_recipient",
        recipientGeneration: 1,
        retryCount: 0,
        acceptedResponse: null,
        claimId: null,
      });
    }
    expect(advanceBackgroundAuthorizationGeneration(claimed, {
      reason: "claim_expired",
      now: NOW + 30_000,
      nextAttemptAt: NOW + 30_001,
    }).retryCount).toBe(0);

    const running = markBackgroundAuthorizationRunning(claimed, NOW + 4);
    expect(advanceBackgroundAuthorizationGeneration(running, {
      reason: "recipient_lost",
      now: NOW + 5,
      nextAttemptAt: NOW + 6,
    }).retryCount).toBe(1);
  });

  test("offline waiting preserves already spent retries without exhausting them", () => {
    const waiting = parseBackgroundAuthorizationRequestSnapshot({
      ...recipientReady(),
      retryCount: BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT,
      lastRetryReason: "provider_transient_failure",
    });
    const rotated = advanceBackgroundAuthorizationGeneration(waiting, {
      reason: "attempt_expired",
      now: NOW + 60_000,
      nextAttemptAt: NOW + 60_001,
    });
    expect(rotated.retryCount).toBe(BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT);
    expect(rotated.state).toBe("awaiting_recipient");
  });

  test("requires expiry to be real and rejects backward or illegal transitions", () => {
    const waiting = recipientReady();
    expect(() => advanceBackgroundAuthorizationGeneration(waiting, {
      reason: "attempt_expired",
      now: NOW + 59_999,
      nextAttemptAt: NOW + 60_000,
    })).toThrow(
      new BackgroundAuthorizationTransitionError("attempt_not_expired"),
    );
    expect(() => markBackgroundAuthorizationRunning(waiting, NOW + 2)).toThrow(
      new BackgroundAuthorizationTransitionError("illegal_transition"),
    );
    expect(() => markBackgroundAuthorizationGrantReady(
      waiting,
      {
        kind: "processor",
        requestId: waiting.requestId,
        descriptorDigest: waiting.descriptorDigest!,
        recipientKeyId: waiting.recipient!.recipientKeyId,
        recipientPublicKey: waiting.recipient!.recipientPublicKey,
        expiresAt: waiting.recipient!.expiresAt,
        responseDigest: RESPONSE_DIGEST,
        credentialDigest: CREDENTIAL_DIGEST,
        issuingHumanId: "human-alice",
        issuingDeviceId: "device-alice-1",
        recipientGeneration: 0,
        now: NOW,
      },
    )).toThrow(
      new BackgroundAuthorizationTransitionError("timestamp_regression"),
    );
  });

  test("records typed retry and terminal reasons rather than generic failure", () => {
    const running = markBackgroundAuthorizationRunning(
      claimBackgroundAuthorizationRequest(
        grantReady(),
        "claim-1",
        NOW + 3,
        NOW + 3 + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
      ),
      NOW + 4,
    );
    const retry = advanceBackgroundAuthorizationGeneration(running, {
      reason: "provider_transient_failure",
      now: NOW + 5,
      nextAttemptAt: NOW + 50,
    });
    const terminal = failBackgroundAuthorizationRequest(
      retry,
      "integrity_failure",
      NOW + 6,
    );

    expect(BACKGROUND_AUTHORIZATION_TERMINAL_REASONS).toContain(
      "integrity_failure",
    );
    expect(BACKGROUND_AUTHORIZATION_TERMINAL_REASONS).toContain(
      "provider_outcome_unknown",
    );
    expect(retry.lastRetryReason).toBe("provider_transient_failure");
    expect(terminal).toMatchObject({
      state: "terminal_failure",
      terminalReason: "integrity_failure",
      lastRetryReason: "provider_transient_failure",
    });
    expect(() => completeBackgroundAuthorizationRequest(
      terminal,
      NOW + 7,
    )).toThrow(
      new BackgroundAuthorizationTransitionError("terminal_state"),
    );

    const uncertain = failBackgroundAuthorizationRequest(
      running,
      "provider_outcome_unknown",
      NOW + 5,
    );
    expect(uncertain).toMatchObject({
      state: "terminal_failure",
      terminalReason: "provider_outcome_unknown",
      nextAttemptAt: null,
    });
  });

  test("bounds retry history at eight attempts", () => {
    expect(BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT).toBe(8);
    let request = initial();
    for (
      let retry = 0;
      retry < BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT;
      retry += 1
    ) {
      const now = NOW + 1 + retry * 3;
      const waiting = attachBackgroundAuthorizationRecipient(request, {
        recipientGeneration: retry,
        descriptorDigest: DIGEST,
        recipientKeyId: `recipient-key-${retry}`,
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        expiresAt: now + 60_000,
        now,
      });
      request = advanceBackgroundAuthorizationGeneration(waiting, {
        reason: "provider_transient_failure",
        now: now + 1,
        nextAttemptAt: now + 2,
      });
    }
    expect(request.retryCount).toBe(8);
    expect(() => parseBackgroundAuthorizationRequestSnapshot({
      ...request,
      retryCount: 9,
    })).toThrow(TypeError);

    const exhaustedAt = request.nextAttemptAt!;
    const waiting = attachBackgroundAuthorizationRecipient(request, {
      recipientGeneration: request.recipientGeneration,
      descriptorDigest: DIGEST,
      recipientKeyId: "recipient-key-exhausted",
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      expiresAt: exhaustedAt + 60_000,
      now: exhaustedAt,
    });
    expect(() => advanceBackgroundAuthorizationGeneration(waiting, {
      reason: "provider_transient_failure",
      now: waiting.updatedAt,
      nextAttemptAt: waiting.updatedAt,
    })).toThrow(
      new BackgroundAuthorizationTransitionError("counter_exhausted"),
    );
  });

  test("uses monotonic request revisions and a bounded restart-safe claim lease", () => {
    const ready = grantReady();
    expect(initial()).toMatchObject({
      requestRevision: 0,
      claimExpiresAt: null,
    });
    expect(ready.requestRevision).toBe(2);
    const claimedAt = NOW + 3;
    const claimExpiresAt =
      claimedAt + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS;
    const claimed = claimBackgroundAuthorizationRequest(
      ready,
      "claim-lease",
      claimedAt,
      claimExpiresAt,
    );
    expect(claimed).toMatchObject({
      requestRevision: 3,
      claimExpiresAt,
    });
    expect(() => markBackgroundAuthorizationRunning(
      claimed,
      claimExpiresAt,
    )).toThrow(
      new BackgroundAuthorizationTransitionError("claim_expired"),
    );
    expect(() => advanceBackgroundAuthorizationGeneration(claimed, {
      reason: "claim_expired",
      now: claimExpiresAt - 1,
      nextAttemptAt: claimExpiresAt,
    })).toThrow(
      new BackgroundAuthorizationTransitionError("claim_not_expired"),
    );
    expect(advanceBackgroundAuthorizationGeneration(claimed, {
      reason: "claim_expired",
      now: claimExpiresAt,
      nextAttemptAt: claimExpiresAt,
    })).toMatchObject({
      requestRevision: 4,
      recipientGeneration: 1,
      claimId: null,
      claimExpiresAt: null,
      state: "awaiting_recipient",
    });
    expect(() => claimBackgroundAuthorizationRequest(
      ready,
      "claim-too-long",
      claimedAt,
      claimExpiresAt + 1,
    )).toThrow(TypeError);
  });

  test("strict parsing rejects unknown fields, malformed digests, and inconsistent state", () => {
    const valid = recipientReady();
    expect(parseBackgroundAuthorizationRequestSnapshot(valid)).toEqual(valid);
    expect(() => parseBackgroundAuthorizationRequestSnapshot({
      ...valid,
      unexpected: true,
    })).toThrow(TypeError);
    expect(() => parseBackgroundAuthorizationRequestSnapshot({
      ...valid,
      descriptorDigest: "aa",
    })).toThrow(TypeError);
    expect(() => parseBackgroundAuthorizationRequestSnapshot({
      ...valid,
      recipient: null,
    })).toThrow(TypeError);
    expect(() => parseBackgroundAuthorizationRequestSnapshot({
      ...valid,
      credentialSubject: {
        ...PROCESSOR_SUBJECT,
        agentId: "not-allowed",
      },
    })).toThrow(TypeError);
    expect(() => parseBackgroundAuthorizationRequestSnapshot({
      ...valid,
      retryCount: 1,
    })).toThrow(TypeError);
  });

  test("pins one typed accepted response and rejects family or generation confusion", () => {
    expect(grantReady(AGENT_SUBJECT).acceptedResponse?.kind).toBe("agent");
    const waiting = recipientReady();
    const exactResponse = {
      requestId: waiting.requestId,
      descriptorDigest: waiting.descriptorDigest!,
      recipientKeyId: waiting.recipient!.recipientKeyId,
      recipientPublicKey: waiting.recipient!.recipientPublicKey,
      expiresAt: waiting.recipient!.expiresAt,
      responseDigest: RESPONSE_DIGEST,
      credentialDigest: CREDENTIAL_DIGEST,
      issuingHumanId: "human-alice",
      issuingDeviceId: "device-alice-1",
      recipientGeneration: 0,
      now: NOW + 2,
    } as const;
    expect(() => markBackgroundAuthorizationGrantReady(waiting, {
      ...exactResponse,
      kind: "agent",
    })).toThrow(TypeError);
    expect(() => markBackgroundAuthorizationGrantReady(waiting, {
      ...exactResponse,
      kind: "processor",
      recipientGeneration: 1,
    })).toThrow(
      new BackgroundAuthorizationTransitionError("stale_generation"),
    );
    expect(() => parseBackgroundAuthorizationRequestSnapshot({
      ...grantReady(),
      acceptedResponse: {
        ...grantReady().acceptedResponse,
        recipientPrivateKey: "forbidden",
      },
    })).toThrow(TypeError);
  });

  test("accepts only a verified response bound to this exact request and recipient", () => {
    const waiting = recipientReady();
    const exact = {
      kind: "processor" as const,
      requestId: waiting.requestId,
      descriptorDigest: waiting.descriptorDigest!,
      recipientKeyId: waiting.recipient!.recipientKeyId,
      recipientPublicKey: waiting.recipient!.recipientPublicKey,
      expiresAt: waiting.recipient!.expiresAt,
      responseDigest: RESPONSE_DIGEST,
      credentialDigest: CREDENTIAL_DIGEST,
      issuingHumanId: "human-alice",
      issuingDeviceId: "device-alice-1",
      recipientGeneration: waiting.recipientGeneration,
      now: NOW + 2,
    };
    expect(markBackgroundAuthorizationGrantReady(waiting, exact).state).toBe(
      "grant_ready",
    );
    for (const substitution of [
      { requestId: "request-foreign" },
      { descriptorDigest: "01".repeat(32) },
      { recipientKeyId: "recipient-key-foreign" },
      {
        recipientPublicKey:
          Buffer.alloc(65, 9).toString("base64url"),
      },
      { expiresAt: waiting.recipient!.expiresAt - 1 },
    ]) {
      expect(() => markBackgroundAuthorizationGrantReady(waiting, {
        ...exact,
        ...substitution,
      })).toThrow(TypeError);
    }
  });

  test("accepts only the exact canonical HPKE public-key size", () => {
    const initialRequest = initial();
    for (const length of [1, 32, 64, 66, 512]) {
      expect(() => attachBackgroundAuthorizationRecipient(initialRequest, {
        descriptorDigest: DIGEST,
        recipientKeyId: `recipient-key-${length}`,
        recipientPublicKey: Buffer.alloc(length, 1).toString("base64url"),
        expiresAt: NOW + 60_000,
        now: NOW + 1,
      })).toThrow(TypeError);
    }
    expect(recipientReady().recipient?.recipientPublicKey).toBe(
      RECIPIENT_PUBLIC_KEY,
    );
  });

  test("accepts the ten-minute recipient boundary and rejects one millisecond more", () => {
    const request = initial();
    expect(attachBackgroundAuthorizationRecipient(request, {
      descriptorDigest: DIGEST,
      recipientKeyId: "recipient-key-boundary",
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      expiresAt: NOW + 1 + BACKGROUND_AUTHORIZATION_MAX_TTL_MS,
      now: NOW + 1,
    }).recipient?.expiresAt).toBe(
      NOW + 1 + BACKGROUND_AUTHORIZATION_MAX_TTL_MS,
    );
    expect(() => attachBackgroundAuthorizationRecipient(request, {
      descriptorDigest: DIGEST,
      recipientKeyId: "recipient-key-too-long",
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      expiresAt: NOW + 2 + BACKGROUND_AUTHORIZATION_MAX_TTL_MS,
      now: NOW + 1,
    })).toThrow(TypeError);
  });

  test("publication reconciliation cannot reauthorize or re-run the transform", () => {
    const reconciling = markBackgroundAuthorizationPublicationReconciliation(
      markBackgroundAuthorizationRunning(
        claimBackgroundAuthorizationRequest(
          grantReady(),
          "claim-1",
          NOW + 3,
          NOW + 3 + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
        ),
        NOW + 4,
      ),
      NOW + 5,
    );
    expect(() => advanceBackgroundAuthorizationGeneration(reconciling, {
      reason: "recipient_lost",
      now: NOW + 6,
      nextAttemptAt: NOW + 7,
    })).toThrow(
      new BackgroundAuthorizationTransitionError("illegal_transition"),
    );
    expect(scheduleBackgroundAuthorizationPublicationRetry(reconciling, {
      now: NOW + 6,
      nextAttemptAt: NOW + 7,
    }).state).toBe("publication_reconciliation");

    const running = markBackgroundAuthorizationRunning(
      claimBackgroundAuthorizationRequest(
        grantReady(),
        "claim-2",
        NOW + 3,
        NOW + 3 + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
      ),
      NOW + 4,
    );
    expect(() => advanceBackgroundAuthorizationGeneration(running, {
      reason: "publication_pending",
      now: NOW + 5,
      nextAttemptAt: NOW + 6,
    })).toThrow(TypeError);
  });

  test("uses the canonical portable identifier grammar", () => {
    for (const invalid of [
      "",
      "é",
      "contains space",
      "_starts-with-punctuation",
      "a".repeat(129),
    ]) {
      expect(() => createBackgroundAuthorizationRequest({
        requestId: invalid,
        workId: "work-1",
        namespaceId: "room-1",
        credentialSubject: PROCESSOR_SUBJECT,
        now: NOW,
      })).toThrow(TypeError);
    }
  });
});

describe("Wave 11 additive Agent background authorization lifecycle", () => {
  test("creates an explicit v2 Agent snapshot while preserving the v1 shape", () => {
    const legacy = initial(AGENT_SUBJECT);
    const request = createBackgroundAuthorizationRequestV2({
      requestId: "request-v2",
      workId: "batch-v2",
      namespaceId: "anchor-namespace",
      credentialSubject: AGENT_SUBJECT,
      now: NOW,
    });

    expect(legacy.formatVersion).toBe(1);
    expect(request).toMatchObject({
      formatVersion: 2,
      requestId: "request-v2",
      workId: "batch-v2",
      namespaceId: "anchor-namespace",
      credentialSubject: AGENT_SUBJECT,
      state: "awaiting_recipient",
    });
    expect(Object.isFrozen(request)).toBe(true);

    const waiting = attachBackgroundAuthorizationRecipient(request, {
      descriptorDigest: DIGEST,
      recipientKeyId: "recipient-v2",
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      expiresAt: NOW + 60_000,
      now: NOW + 1,
    });
    expect(waiting.formatVersion).toBe(2);
  });

  test("rejects legacy processor subjects and unknown lifecycle versions", () => {
    expect(() => createBackgroundAuthorizationRequestV2({
      requestId: "request-v2",
      workId: "batch-v2",
      namespaceId: "anchor-namespace",
      credentialSubject: PROCESSOR_SUBJECT,
      now: NOW,
    })).toThrow(TypeError);

    expect(() => parseBackgroundAuthorizationRequestSnapshot({
      ...initial(AGENT_SUBJECT),
      formatVersion: 4,
    })).toThrow(TypeError);
  });
});

describe("current named processor background authorization lifecycle", () => {
  test("uses a strict processor v2 Stenographer subject without a permission revision", () => {
    const request = createBackgroundAuthorizationRequestV2({
      requestId: "request-processor-v2",
      workId: "work-processor-v2",
      namespaceId: "namespace-room-1",
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
      },
      now: NOW,
    });
    expect(request).toMatchObject({
      formatVersion: 2,
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
      },
      state: "awaiting_recipient",
    });
    expect(Object.keys(request.credentialSubject)).not.toContain(
      "authorizationRevision",
    );
    expect(() => parseBackgroundAuthorizationRequestSnapshot({
      ...request,
      credentialSubject: {
        ...request.credentialSubject,
        authorizationRevision: 1,
      },
    })).toThrow(TypeError);
  });
});
