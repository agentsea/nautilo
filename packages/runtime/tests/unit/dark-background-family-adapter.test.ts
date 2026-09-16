import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_AUTHORIZATION_FORMAT_VERSION,
  attachBackgroundAuthorizationRecipient,
  markBackgroundAuthorizationGrantReady,
  type BackgroundAuthorizationRequestSnapshot,
} from "../../src/protected-execution/background-authorization";
import {
  DARK_BACKGROUND_ENTRYPOINT_INVENTORY,
  DARK_BACKGROUND_MAX_PENDING_DELAY_MS,
  DARK_BACKGROUND_MAX_SYNTHETIC_PAYLOAD_BYTES,
  planDarkBackgroundSyntheticWork,
  runDarkBackgroundSyntheticWork,
  type DarkBackgroundSyntheticAgentCredential,
  type DarkBackgroundSyntheticPlan,
} from "../../src/protected-execution/background-authorization/dark-background-family-adapter";

const NOW = 1_000_000;
const PAYLOAD = new TextEncoder().encode("synthetic dark payload");
const PAYLOAD_FINGERPRINT = createHash("sha256").update(PAYLOAD).digest();
const RECIPIENT_PUBLIC_KEY = Buffer.alloc(65, 7).toString("base64url");

const AGENT_SUBJECT = Object.freeze({
  kind: "agent" as const,
  agentId: "agent-genie",
  runtimeGeneration: 4,
  authorizationRevision: 9,
});

function plan(
  entrypointId:
    | "memory.review.main"
    | "memory.review.fork"
    | "memory.exit_flush"
    | "task.dispatch.now"
    | "task.dispatch.one_shot"
    | "task.dispatch.recurring"
    | "task.dispatch.async"
    | "task.dispatch.retry"
    | "task.execute"
    | "task.resume.unpause"
    | "task.resume.approval" = "memory.review.main",
): DarkBackgroundSyntheticPlan {
  return planDarkBackgroundSyntheticWork({
    entrypointId,
    requestId: "request-1",
    workId: "work-1",
    namespaceId: "namespace-1",
    domainId: "domain-1",
    syntheticPayloadId: "synthetic-object-1",
    syntheticPayloadGeneration: 3,
    syntheticPayloadFingerprint: PAYLOAD_FINGERPRINT,
    maximumPlaintextBytes: 128,
    maximumCiphertextBytes: 256,
    expectedDomainEpoch: 5,
    expectedNamespaceAccessRevision: 6,
    expectedPolicyRevision: 7,
    subject: AGENT_SUBJECT,
    now: NOW,
  });
}

function readySnapshot(
  value: DarkBackgroundSyntheticPlan,
  subject: "agent" | "processor" = "agent",
): BackgroundAuthorizationRequestSnapshot {
  const initial = subject === "agent"
    ? value.request
    : {
      ...value.request,
      formatVersion: BACKGROUND_AUTHORIZATION_FORMAT_VERSION,
      credentialSubject: {
        kind: "processor" as const,
        processorKind: "stenographer" as const,
        processorVersion: 1 as const,
        authorizationRevision: 9,
      },
    };
  const waiting = attachBackgroundAuthorizationRecipient(initial, {
    descriptorDigest: value.descriptorDigest,
    recipientKeyId: "recipient-key-1",
    recipientPublicKey: RECIPIENT_PUBLIC_KEY,
    expiresAt: NOW + 60_000,
    now: NOW + 1,
  });
  return markBackgroundAuthorizationGrantReady(waiting, {
    kind: subject,
    requestId: waiting.requestId,
    descriptorDigest: waiting.descriptorDigest!,
    recipientKeyId: waiting.recipient!.recipientKeyId,
    recipientPublicKey: waiting.recipient!.recipientPublicKey,
    expiresAt: waiting.recipient!.expiresAt,
    responseDigest: "ab".repeat(32),
    credentialDigest: "cd".repeat(32),
    issuingHumanId: "human-1",
    issuingDeviceId: "device-1",
    recipientGeneration: 0,
    now: NOW + 2,
  });
}

function agentCredential(
  value: DarkBackgroundSyntheticPlan,
): DarkBackgroundSyntheticAgentCredential {
  return Object.freeze({
    family: "agent",
    requestId: value.request.requestId,
    workId: value.request.workId,
    namespaceId: value.request.namespaceId,
    descriptorDigest: value.descriptorDigest,
    agentId: AGENT_SUBJECT.agentId,
    runtimeGeneration: AGENT_SUBJECT.runtimeGeneration,
    authorizationRevision: AGENT_SUBJECT.authorizationRevision,
    expiresAt: NOW + 60_000,
  });
}

describe("Wave 10 dark background-family adapters", () => {
  test("Wave 12 replaces every Memory synthetic adapter with real protected work", () => {
    expect(DARK_BACKGROUND_ENTRYPOINT_INVENTORY
      .filter((entrypoint) => entrypoint.entrypointId.startsWith("memory."))
      .map((entrypoint): string => entrypoint.adapterStatus)).toEqual([
        "protected_adapter",
        "protected_adapter",
        "protected_adapter",
      ]);
  });

  test("keeps every inventory row grounded in its real source anchor", () => {
    const repositoryRoot = resolve(import.meta.dir, "../../../..");
    for (const entrypoint of DARK_BACKGROUND_ENTRYPOINT_INVENTORY) {
      const source = readFileSync(
        resolve(repositoryRoot, entrypoint.sourcePath),
        "utf8",
      );
      expect(source).toContain(entrypoint.sourceAnchor);
    }
  });

  test("grounds every supported real entrypoint and records unresolved Job/await-reply gaps without inventing actors", () => {
    expect(DARK_BACKGROUND_ENTRYPOINT_INVENTORY).toEqual([
      expect.objectContaining({
        entrypointId: "memory.review.main",
        workKind: "memory.review",
        purpose: "memory.review",
        subjectKind: "agent",
        deferredOwningWave: "wave12_memory",
      }),
      expect.objectContaining({
        entrypointId: "memory.review.fork",
        workKind: "memory.review",
        purpose: "memory.review",
        subjectKind: "agent",
      }),
      expect.objectContaining({
        entrypointId: "memory.exit_flush",
        productionCaller: "absent",
        workKind: "memory.exit_flush",
        subjectKind: "agent",
      }),
      expect.objectContaining({
        entrypointId: "task.dispatch.now",
        workKind: "task.dispatch",
        subjectKind: "agent",
      }),
      expect.objectContaining({
        entrypointId: "task.dispatch.one_shot",
        workKind: "task.dispatch",
        subjectKind: "agent",
      }),
      expect.objectContaining({
        entrypointId: "task.dispatch.recurring",
        workKind: "task.dispatch",
        subjectKind: "agent",
      }),
      expect.objectContaining({
        entrypointId: "task.dispatch.async",
        workKind: "task.dispatch",
        subjectKind: "agent",
      }),
      expect.objectContaining({
        entrypointId: "task.dispatch.retry",
        workKind: "task.dispatch",
        subjectKind: "agent",
      }),
      expect.objectContaining({
        entrypointId: "task.execute",
        workKind: "task.execute",
        subjectKind: "agent",
      }),
      expect.objectContaining({
        entrypointId: "task.resume.unpause",
        workKind: "task.dispatch",
        subjectKind: "agent",
      }),
      expect.objectContaining({
        entrypointId: "task.resume.approval",
        workKind: "task.approval_resume",
        subjectKind: "agent",
      }),
      expect.objectContaining({
        entrypointId: "task.resume.await_reply",
        adapterStatus: "inventory_only",
        subjectKind: "agent",
        workKind: null,
      }),
      expect.objectContaining({
        entrypointId: "job.background.generic",
        adapterStatus: "inventory_only",
        subjectKind: null,
        workKind: null,
      }),
      expect.objectContaining({
        entrypointId: "job.background.deep_research",
        adapterStatus: "inventory_only",
        subjectKind: null,
        workKind: null,
      }),
    ]);

    expect(new Set(DARK_BACKGROUND_ENTRYPOINT_INVENTORY
      .filter((entrypoint) => entrypoint.entrypointId.startsWith("memory."))
      .map((entrypoint) => entrypoint.deferredOwningWave))).toEqual(
        new Set(["wave12_memory"]),
      );
    expect(new Set(DARK_BACKGROUND_ENTRYPOINT_INVENTORY
      .filter((entrypoint) =>
        entrypoint.entrypointId.startsWith("task.")
        || entrypoint.entrypointId.startsWith("job.")
      )
      .map((entrypoint) => entrypoint.deferredOwningWave))).toEqual(
        new Set(["wave14_agent_task_job_content"]),
      );
  });

  test("maps every supported Memory and Task seam to an Agent subject and strict content-free coordinates", () => {
    for (const entrypoint of DARK_BACKGROUND_ENTRYPOINT_INVENTORY) {
      if (entrypoint.adapterStatus !== "synthetic_adapter") continue;
      const value = plan(entrypoint.entrypointId);
      expect(value.descriptor.workKind).toBe(entrypoint.workKind);
      expect(value.descriptor.purpose).toBe(entrypoint.purpose);
      expect(value.descriptor.subject).toEqual(AGENT_SUBJECT);
      expect(value.descriptor.source).toEqual({
        kind: "synthetic_payload",
        payloadId: "synthetic-object-1",
        generation: 3,
        fingerprint: PAYLOAD_FINGERPRINT.toString("hex"),
      });
      expect(value.descriptor.operations).toEqual(["decrypt"]);
      expect(value.descriptor.bounds).toEqual({
        maximumInputObjectCount: 1,
        maximumOutputObjectCount: 0,
        maximumPlaintextBytes: 128,
        maximumCiphertextBytes: 256,
      });
      expect(value.request.state).toBe("awaiting_recipient");
      expect(value.request.credentialSubject).toEqual(AGENT_SUBJECT);
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.descriptor)).toBe(true);
    }
  });

  test("rejects a foreground session/handle or any other unknown planning input", () => {
    expect(() =>
      planDarkBackgroundSyntheticWork({
        entrypointId: "task.execute",
        requestId: "request-1",
        workId: "work-1",
        namespaceId: "namespace-1",
        domainId: "domain-1",
        syntheticPayloadId: "synthetic-object-1",
        syntheticPayloadGeneration: 3,
        syntheticPayloadFingerprint: PAYLOAD_FINGERPRINT,
        maximumPlaintextBytes: 128,
        maximumCiphertextBytes: 256,
        expectedDomainEpoch: 5,
        expectedNamespaceAccessRevision: 6,
        expectedPolicyRevision: 7,
        subject: AGENT_SUBJECT,
        now: NOW,
        foregroundSession: { sessionId: "forbidden" },
      } as never)
    ).toThrow("invalid field set");

    expect(() =>
      planDarkBackgroundSyntheticWork({
        ...({
          entrypointId: "task.execute",
          requestId: "request-1",
          workId: "work-1",
          namespaceId: "namespace-1",
          domainId: "domain-1",
          syntheticPayloadId: "synthetic-object-1",
          syntheticPayloadGeneration: 3,
          syntheticPayloadFingerprint: PAYLOAD_FINGERPRINT,
          maximumPlaintextBytes: 128,
          maximumCiphertextBytes: 256,
          expectedDomainEpoch: 5,
          expectedNamespaceAccessRevision: 6,
          expectedPolicyRevision: 7,
          subject: AGENT_SUBJECT,
          now: NOW,
        }),
        foregroundHandle: { invocationId: "forbidden" },
      } as never)
    ).toThrow("invalid field set");
  });

  test("rejects a foreground session/handle smuggled into synthetic execution", async () => {
    const value = plan("task.execute");
    let rejection: unknown = null;
    try {
      await runDarkBackgroundSyntheticWork({
        plan: value,
        now: NOW + 5,
        claimId: "claim-1",
        claimExpiresAt: NOW + 10_000,
        resolveAuthority: async () => ({
          status: "unavailable",
          reason: "no_eligible_device",
        }),
        readSyntheticPayload: async () => PAYLOAD,
        execute: () => "never",
        foregroundHandle: { invocationId: "forbidden" },
      } as never);
    } catch (cause) {
      rejection = cause;
    }
    expect(rejection).toBeInstanceOf(TypeError);
    expect((rejection as Error).message).toContain("invalid field set");
  });

  test("does not accept a reconstructed or extended plan as authority-bearing input", async () => {
    const value = plan("task.execute");
    let authorityCalls = 0;
    const result = await runDarkBackgroundSyntheticWork({
      plan: Object.freeze({
        ...value,
        foregroundSession: { sessionId: "forbidden" },
      }) as never,
      now: NOW + 5,
      claimId: "claim-1",
      claimExpiresAt: NOW + 10_000,
      resolveAuthority: async () => {
        authorityCalls += 1;
        return {
          status: "unavailable",
          reason: "no_eligible_device",
        };
      },
      readSyntheticPayload: async () => PAYLOAD,
      execute: () => "never",
    });
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") throw new Error("expected skip");
    expect(result.reason).toBe("authority_invalid");
    expect(authorityCalls).toBe(0);
  });

  test("rejects unsupported/unresolved entrypoints and payload or coordinate bounds", () => {
    expect(() =>
      planDarkBackgroundSyntheticWork({
        ...({
          entrypointId: "job.background.deep_research",
          requestId: "request-1",
          workId: "work-1",
          namespaceId: "namespace-1",
          domainId: "domain-1",
          syntheticPayloadId: "synthetic-object-1",
          syntheticPayloadGeneration: 3,
          syntheticPayloadFingerprint: PAYLOAD_FINGERPRINT,
          maximumPlaintextBytes: 128,
          maximumCiphertextBytes: 256,
          expectedDomainEpoch: 5,
          expectedNamespaceAccessRevision: 6,
          expectedPolicyRevision: 7,
          subject: AGENT_SUBJECT,
          now: NOW,
        }),
      } as never)
    ).toThrow("does not have a Wave 10 synthetic adapter");

    expect(() =>
      planDarkBackgroundSyntheticWork({
        ...({
          entrypointId: "task.execute",
          requestId: "request-1",
          workId: "work-1",
          namespaceId: "namespace-1",
          domainId: "domain-1",
          syntheticPayloadId: "synthetic-object-1",
          syntheticPayloadGeneration: 3,
          syntheticPayloadFingerprint: PAYLOAD_FINGERPRINT,
          maximumPlaintextBytes:
            DARK_BACKGROUND_MAX_SYNTHETIC_PAYLOAD_BYTES + 1,
          maximumCiphertextBytes: 256,
          expectedDomainEpoch: 5,
          expectedNamespaceAccessRevision: 6,
          expectedPolicyRevision: 7,
          subject: AGENT_SUBJECT,
          now: NOW,
        }),
      })
    ).toThrow("plaintext byte bound");

    expect(() =>
      planDarkBackgroundSyntheticWork({
        ...({
          entrypointId: "task.execute",
          requestId: "request-1",
          workId: "work-1",
          namespaceId: "namespace-1",
          domainId: "domain-1",
          syntheticPayloadId: "synthetic-object-1",
          syntheticPayloadGeneration: 3,
          syntheticPayloadFingerprint: new Uint8Array(31),
          maximumPlaintextBytes: 128,
          maximumCiphertextBytes: 256,
          expectedDomainEpoch: 5,
          expectedNamespaceAccessRevision: 6,
          expectedPolicyRevision: 7,
          subject: AGENT_SUBJECT,
          now: NOW,
        }),
      })
    ).toThrow("fingerprint");
  });

  test("leaves work pending with a clamped retry and never opens a synthetic payload when authority is unavailable", async () => {
    const value = plan("task.execute");
    let payloadReads = 0;
    const result = await runDarkBackgroundSyntheticWork({
      plan: value,
      now: NOW + 5,
      claimId: "claim-1",
      claimExpiresAt: NOW + 10_000,
      resolveAuthority: async () => ({
        status: "unavailable",
        reason: "no_eligible_device",
        retryAfterMs: DARK_BACKGROUND_MAX_PENDING_DELAY_MS * 10,
      }),
      readSyntheticPayload: async () => {
        payloadReads += 1;
        return PAYLOAD;
      },
      execute: () => "should-not-run",
    });

    expect(result).toEqual({
      status: "pending",
      reason: "no_eligible_device",
      snapshot: value.request,
      nextAttemptAt: NOW + 5 + DARK_BACKGROUND_MAX_PENDING_DELAY_MS,
    });
    expect(payloadReads).toBe(0);
  });

  test("uses the shared claim/run/complete lifecycle for one bounded synthetic payload and wipes its owned copy", async () => {
    const value = plan("task.execute");
    const source = new Uint8Array(PAYLOAD);
    let observedAfterRun: Uint8Array | null = null;
    const result = await runDarkBackgroundSyntheticWork({
      plan: value,
      now: NOW + 3,
      claimId: "claim-1",
      claimExpiresAt: NOW + 20_000,
      resolveAuthority: async () => ({
        status: "ready",
        snapshot: readySnapshot(value),
        credential: agentCredential(value),
      }),
      readSyntheticPayload: async () => source,
      execute: (payload) => {
        observedAfterRun = payload;
        return new TextDecoder().decode(payload);
      },
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completion");
    expect(result.value).toBe("synthetic dark payload");
    expect(result.snapshot.state).toBe("completed");
    expect(observedAfterRun as unknown).toEqual(
      new Uint8Array(PAYLOAD.length),
    );
    expect(source).toEqual(PAYLOAD);
  });

  test("fails closed before payload access when a processor credential crosses into Agent work", async () => {
    const value = plan("task.dispatch.now");
    let payloadReads = 0;
    const result = await runDarkBackgroundSyntheticWork({
      plan: value,
      now: NOW + 3,
      claimId: "claim-1",
      claimExpiresAt: NOW + 20_000,
      resolveAuthority: async () => ({
        status: "ready",
        snapshot: readySnapshot(value, "processor"),
        credential: {
          family: "processor",
          requestId: value.request.requestId,
          workId: value.request.workId,
          namespaceId: value.request.namespaceId,
          descriptorDigest: value.descriptorDigest,
          processorKind: "stenographer",
          processorVersion: 1,
          authorizationRevision: 9,
          expiresAt: NOW + 60_000,
        },
      }),
      readSyntheticPayload: async () => {
        payloadReads += 1;
        return PAYLOAD;
      },
      execute: () => "should-not-run",
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "credential_family_mismatch",
      snapshot: value.request,
    });
    expect(payloadReads).toBe(0);
  });

  test("rejects an extended/malformed authority result before payload access", async () => {
    const value = plan("task.execute");
    let payloadReads = 0;
    const result = await runDarkBackgroundSyntheticWork({
      plan: value,
      now: NOW + 3,
      claimId: "claim-1",
      claimExpiresAt: NOW + 20_000,
      resolveAuthority: async () => ({
        status: "ready",
        snapshot: readySnapshot(value),
        credential: agentCredential(value),
        foregroundHandle: { invocationId: "forbidden" },
      }) as never,
      readSyntheticPayload: async () => {
        payloadReads += 1;
        return PAYLOAD;
      },
      execute: () => "never",
    });
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") throw new Error("expected skip");
    expect(result.reason).toBe("authority_invalid");
    expect(payloadReads).toBe(0);
  });

  test("fails closed on Agent subject, descriptor, payload substitution, or expiry", async () => {
    const value = plan("task.resume.approval");
    const base = {
      plan: value,
      now: NOW + 3,
      claimId: "claim-1",
      claimExpiresAt: NOW + 20_000,
      readSyntheticPayload: async () => PAYLOAD,
      execute: () => "never",
    } as const;

    for (const credential of [
      { ...agentCredential(value), agentId: "agent-other" },
      { ...agentCredential(value), descriptorDigest: "ef".repeat(32) },
      { ...agentCredential(value), expiresAt: NOW + 2 },
    ]) {
      let payloadReads = 0;
      const result = await runDarkBackgroundSyntheticWork({
        ...base,
        resolveAuthority: async () => ({
          status: "ready",
          snapshot: readySnapshot(value),
          credential,
        }),
        readSyntheticPayload: async () => {
          payloadReads += 1;
          return PAYLOAD;
        },
      });
      expect(result.status).toBe("skipped");
      expect(payloadReads).toBe(0);
    }

    let executed = false;
    const substitutedPayload = await runDarkBackgroundSyntheticWork({
      ...base,
      resolveAuthority: async () => ({
        status: "ready",
        snapshot: readySnapshot(value),
        credential: agentCredential(value),
      }),
      readSyntheticPayload: async () =>
        new TextEncoder().encode("different payload"),
      execute: () => {
        executed = true;
        return "never";
      },
    });
    expect(substitutedPayload.status).toBe("skipped");
    if (substitutedPayload.status !== "skipped") {
      throw new Error("expected payload substitution to be skipped");
    }
    expect(substitutedPayload.reason).toBe("payload_fingerprint_mismatch");
    expect(substitutedPayload.snapshot.state).toBe("running");
    expect(executed).toBe(false);
  });
});
