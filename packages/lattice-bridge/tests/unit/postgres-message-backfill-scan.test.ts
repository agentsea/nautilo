import { describe, expect, test } from "bun:test";

import type { MessageBackfillClaim } from "@nautilo/api-client/browser";
import {
  encryptionTransitionPolicy,
  messageBackfillFailures,
  messageBackfillScans,
} from "@nautilo/db";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import { PostgresMessageBackfillScan } from
  "../../src/server/message/postgres-message-backfill-scan.ts";
import type {
  ConversationProductCanonicalTransactionRunner,
  ConversationProductDatabaseRow,
  ConversationProductPostgresExecutor,
  ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const NAMESPACE = "44444444-4444-4444-8444-444444444444";
const OWNER = "55555555-5555-4555-8555-555555555555";
const DEVICE_A = "device-a";
const DEVICE_B = "device-b";
const DIGEST = Buffer.alloc(32).toString("base64url");
const NOW = 1_800_000_000_000;

type ScanRow = typeof messageBackfillScans.$inferSelect;
type FailureRow = typeof messageBackfillFailures.$inferSelect;

function scanRow(overrides: Partial<ScanRow> = {}): ScanRow {
  return {
    humanActorId: HUMAN,
    cursorMessageId: 0,
    sweepStartedAt: new Date(NOW - 1_000),
    lastSweepAt: null,
    lastActiveAt: new Date(NOW - 1_000),
    resumeAt: null,
    leaseToken: null,
    leaseDeviceId: null,
    leaseExpiresAt: null,
    claim: null,
    urgentMessageId: null,
    claimIsUrgent: 0,
    ...overrides,
  };
}

function claim(
  deviceId: string,
  claimId: string,
  messageId = 5,
): MessageBackfillClaim {
  return {
    version: 1,
    claimId,
    operationId: `repair:${messageId}`,
    coordinate: {
      sessionId: SESSION,
      messageId,
      revision: 0,
      roomId: ROOM,
      namespaceId: NAMESPACE,
      role: "assistant",
      logicalMessageKey: `row:${messageId}`,
    },
    sourceRevision: null,
    action: "encrypt",
    subjectHumanId: HUMAN,
    deviceId,
    serverInstanceId: "server-1",
    deviceGeneration: 1,
    lineageGeneration: 0,
    membershipEpoch: 1,
    membershipSecurityRevision: 1,
    membershipHeadDigestBase64url: DIGEST,
    hostAuthorizationRevision: 1,
    policyRevision: 3,
    keyClass: "human",
    namespaceAccessRevision: 4,
    namespaceKeyGeneration: 1,
    namespaceHeadDigestBase64url: DIGEST,
    domainId: "domain-1",
    domainGeneration: 1,
    domainAuthorizationRevision: 1,
    domainHeadDigestBase64url: DIGEST,
    namespaceBundleRevision: 1,
    namespaceBundleDigestBase64url: DIGEST,
    repairIdentityDigestBase64url: DIGEST,
    createdAt: NOW - 10,
    authorHumanTurnId: null,
    sessionAgentId: null,
    cryptoObjectId: `message:v2:object-${messageId}`,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
  };
}

function candidateRow(
  messageId: number,
  overrides: ConversationProductDatabaseRow = {},
): ConversationProductDatabaseRow {
  return {
    message_id: messageId,
    session_id: SESSION,
    edit_revision: 0,
    role: "assistant",
    ordinary_present: true,
    crypto_object_id: null,
    session_room_id: ROOM,
    subthread_room_id: null,
    source_room_id: ROOM,
    authority_room_id: ROOM,
    namespace_id: NAMESPACE,
    namespace_access_revision: 4,
    message_source_revision: 0,
    session_owner_user_id: OWNER,
    session_agent_id: null,
    created_at: new Date(NOW - 100 + messageId),
    human_turn_id: null,
    fingerprint: null,
    supported_topology: true,
    target_key_class: "human",
    lifecycle_session_id: null,
    lifecycle_message_id: null,
    lifecycle_revision: null,
    lifecycle_crypto_object_id: null,
    key_class: null,
    completion: null,
    disposition: null,
    parity_status: null,
    repair_identity_present: false,
    ordinary_restoration_accepted: false,
    ...overrides,
  };
}

function candidateRowForAction(
  action: "encrypt" | "verify" | "restore",
  messageId = 5,
): ConversationProductDatabaseRow {
  if (action === "encrypt") return candidateRow(messageId);
  const cryptoObjectId = `message:v2:object-${messageId}`;
  return candidateRow(messageId, {
    ordinary_present: action === "verify",
    crypto_object_id: cryptoObjectId,
    lifecycle_session_id: SESSION,
    lifecycle_message_id: messageId,
    lifecycle_revision: 0,
    lifecycle_crypto_object_id: cryptoObjectId,
    key_class: "human",
    completion: "complete",
    disposition: "mapped",
    parity_status: "client_authenticated",
    repair_identity_present: false,
  });
}

function unsupportedFailureFor(
  action: "encrypt" | "verify" | "restore",
  messageId = 5,
): FailureRow {
  return {
    messageId,
    editRevision: 0,
    namespaceAccessRevision: 4,
    sourceRevision: null,
    policyRevision: 3,
    cryptoObjectId: action === "encrypt" ? null : `message:v2:object-${messageId}`,
    reason: "unsupported",
    observedAt: new Date(NOW - 1_000),
  };
}

function currentClaimCandidate(
  value: MessageBackfillClaim,
  overrides: ConversationProductDatabaseRow = {},
): ConversationProductDatabaseRow {
  return candidateRow(value.coordinate.messageId, {
    session_id: value.coordinate.sessionId,
    edit_revision: value.coordinate.revision,
    role: value.coordinate.role,
    source_room_id: value.coordinate.roomId,
    authority_room_id: value.coordinate.roomId,
    namespace_id: value.coordinate.namespaceId,
    namespace_access_revision: value.namespaceAccessRevision,
    created_at: new Date(value.createdAt),
    human_turn_id: value.authorHumanTurnId,
    session_agent_id: value.sessionAgentId,
    target_key_class: value.keyClass,
    fingerprint: value.coordinate.role === "user"
      && value.coordinate.logicalMessageKey.startsWith("turn:")
      ? value.coordinate.logicalMessageKey.slice("turn:".length)
      : null,
    ...overrides,
  });
}

class CandidateExecutor implements ConversationProductPostgresExecutor {
  calls = 0;
  rows: readonly ConversationProductDatabaseRow[] = [];

  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    _statement: string,
    _parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.calls += 1;
    return Promise.resolve(this.rows as readonly Row[]);
  }
}

class StatefulCanonicalRunner {
  readonly executor = new CandidateExecutor();
  scan: ScanRow | null = scanRow();
  failure: FailureRow | null = null;
  mutationCount = 0;
  policyMode: "plaintext_only" | "shadow_encryption" | "encrypted_only" =
    "shadow_encryption";
  policyRevision = 3;
  #tail: Promise<void> = Promise.resolve();

  transaction<Result>(
    callback: (
      transaction: CanonicalTranscriptTx,
      executor: ConversationProductPostgresExecutor,
    ) => Promise<Result>,
  ): Promise<Result> {
    const run = this.#tail.then(() => callback(this.tx(), this.executor));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  asRunner(): ConversationProductCanonicalTransactionRunner {
    return this as unknown as ConversationProductCanonicalTransactionRunner;
  }

  private tx(): CanonicalTranscriptTx {
    type Operation = "select" | "insert" | "update" | "delete";
    const chain = (operation: Operation, initialTable?: unknown): unknown => {
      let table = initialTable;
      let values: Record<string, unknown> | null = null;
      let changes: Record<string, unknown> | null = null;
      const query = {
        from(next: unknown): unknown {
          table = next;
          return query;
        },
        where(): unknown { return query; },
        for(): unknown { return query; },
        values(next: Record<string, unknown>): unknown {
          values = next;
          return query;
        },
        set(next: Record<string, unknown>): unknown {
          changes = next;
          return query;
        },
        onConflictDoNothing(): unknown { return query; },
        onConflictDoUpdate(input: Readonly<{
          set: Record<string, unknown>;
        }>): unknown {
          changes = input.set;
          return query;
        },
        then: (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ): Promise<unknown> => Promise.resolve().then(() => {
          if (operation === "select") {
            if (table === encryptionTransitionPolicy) {
              return [{
                mode: this.policyMode,
                shadowBehavior: "fallback",
                revision: this.policyRevision,
              }];
            }
            if (table === messageBackfillScans) {
              return this.scan === null ? [] : [this.scan];
            }
            if (table === messageBackfillFailures) {
              return this.failure === null ? [] : [this.failure];
            }
          }
          this.mutationCount += 1;
          if (table === messageBackfillScans) {
            if (operation === "insert" && this.scan === null) {
              this.scan = scanRow(values as Partial<ScanRow>);
            } else if (operation === "update" && this.scan !== null) {
              Object.assign(this.scan, changes);
            }
          }
          if (table === messageBackfillFailures) {
            if (operation === "delete") this.failure = null;
            if (operation === "insert") {
              const persisted = {
                ...(values as unknown as Partial<FailureRow>),
                ...(changes as Partial<FailureRow> | null ?? {}),
              };
              this.failure = {
                ...persisted,
                observedAt: persisted.observedAt ?? new Date(),
              } as FailureRow;
            }
          }
          return [];
        }).then(resolve, reject),
      };
      return query;
    };
    return {
      execute: () => Promise.resolve([]),
      select: () => chain("select"),
      insert: (table: unknown) => chain("insert", table),
      update: (table: unknown) => chain("update", table),
      delete: (table: unknown) => chain("delete", table),
    } as unknown as CanonicalTranscriptTx;
  }
}

describe("Postgres Message backfill scan", () => {
  test("serializes two competing claim installations through one scan CAS", async () => {
    const harness = new StatefulCanonicalRunner();
    const scan = new PostgresMessageBackfillScan(harness.asRunner());
    const claimA = claim(DEVICE_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const claimB = claim(DEVICE_B, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    const installed = await Promise.all([
      scan.install({ claim: claimA, cursor: 0, urgent: false, now: NOW }),
      scan.install({ claim: claimB, cursor: 0, urgent: false, now: NOW }),
    ]);
    expect(installed.filter(Boolean)).toHaveLength(1);
    const winner = installed[0] ? claimA : claimB;
    expect(harness.scan?.leaseToken).toBe(winner.claimId);
    expect(harness.scan?.leaseDeviceId).toBe(winner.deviceId);
  });

  test("an urgent claim installation consumes only its selected priority marker", async () => {
    const selected = claim(
      DEVICE_A,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({
      cursorMessageId: 20,
      urgentMessageId: selected.coordinate.messageId,
    });
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.install({
      claim: selected,
      cursor: 20,
      urgent: true,
      now: NOW,
    })).toBe(true);
    expect(harness.scan).toMatchObject({
      cursorMessageId: 20,
      urgentMessageId: null,
      claimIsUrgent: 1,
      leaseToken: selected.claimId,
    });
  });

  test("expires ordinary work past the current sweep without starving later IDs, then revisits it after wrap", async () => {
    const expired = claim(
      DEVICE_A,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({
      claim: expired,
      leaseToken: expired.claimId,
      leaseDeviceId: expired.deviceId,
      leaseExpiresAt: new Date(NOW - 1),
    });
    harness.executor.rows = [candidateRow(6)];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    const selected = await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_B,
      now: NOW,
      resumeAt: NOW + 60_000,
    });
    expect(selected).toMatchObject({ status: "candidate", cursor: 5 });
    expect(selected.status === "candidate" && selected.candidate.messageId)
      .toBe(6);
    expect(harness.scan?.cursorMessageId).toBe(5);
    expect(harness.scan?.claim).toBeNull();
    expect(harness.failure).toBeNull();

    await scan.defer({
      humanId: HUMAN, cursor: 5, messageId: 6, urgent: false, now: NOW,
    });
    harness.executor.rows = [];
    expect(await scan.select({
      humanId: HUMAN, deviceId: DEVICE_B, now: NOW + 1,
      resumeAt: NOW + 60_000,
    })).toEqual({status: "swept", resumeAt: NOW + 60_000});
    expect(harness.scan?.cursorMessageId).toBe(0);

    harness.executor.rows = [candidateRow(5)];
    expect(await scan.select({
      humanId: HUMAN, deviceId: DEVICE_B, now: NOW + 60_000,
      resumeAt: NOW + 120_000,
    })).toMatchObject({
      status: "candidate", cursor: 0, candidate: {messageId: 5},
    });
  });

  test("expires unresignaled urgent work into the background lane without starving later IDs", async () => {
    const expired = claim(
      DEVICE_A,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({
      cursorMessageId: 20,
      claim: expired,
      leaseToken: expired.claimId,
      leaseDeviceId: expired.deviceId,
      leaseExpiresAt: new Date(NOW - 1),
      urgentMessageId: null,
      claimIsUrgent: 1,
    });
    harness.executor.rows = [candidateRow(21)];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_B,
      now: NOW,
      resumeAt: NOW + 60_000,
    })).toMatchObject({
      status: "candidate",
      cursor: 20,
      urgent: false,
      candidate: { messageId: 21 },
    });
    expect(harness.scan?.cursorMessageId).toBe(20);
    expect(harness.scan?.claim).toBeNull();
    expect(harness.scan?.urgentMessageId).toBeNull();
    expect(harness.failure).toBeNull();
  });

  test.each([
    ["matching", 5],
    ["different", 7],
  ] as const)("a fresh %s priority written during a competing live lease survives its later expiry", async (
    _case,
    freshMessageId,
  ) => {
    const retained = claim(
      DEVICE_A,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({
      cursorMessageId: 20,
      claim: retained,
      leaseToken: retained.claimId,
      leaseDeviceId: retained.deviceId,
      leaseExpiresAt: new Date(retained.expiresAt),
      urgentMessageId: null,
      claimIsUrgent: 1,
    });
    harness.executor.rows = [currentClaimCandidate(retained)];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_B,
      now: NOW + 1,
      resumeAt: NOW + 60_000,
      urgentMessageId: freshMessageId,
    })).toEqual({status: "waiting", resumeAt: retained.expiresAt});
    expect(harness.scan?.urgentMessageId).toBe(freshMessageId);

    harness.executor.rows = [candidateRow(freshMessageId)];
    expect(await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_B,
      now: retained.expiresAt,
      resumeAt: retained.expiresAt + 60_000,
    })).toMatchObject({
      status: "candidate",
      cursor: 20,
      urgent: true,
      candidate: {messageId: freshMessageId},
    });
    expect(harness.scan?.urgentMessageId).toBe(freshMessageId);
    expect(harness.scan?.cursorMessageId).toBe(20);
  });

  test.each([
    ["matching", 5],
    ["different", 7],
  ] as const)("a fresh %s priority survives expiry of an urgent claim", async (
    _case,
    freshMessageId,
  ) => {
    const expired = claim(
      DEVICE_A,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({
      cursorMessageId: 20,
      claim: expired,
      leaseToken: expired.claimId,
      leaseDeviceId: expired.deviceId,
      leaseExpiresAt: new Date(NOW - 1),
      urgentMessageId: expired.coordinate.messageId,
      claimIsUrgent: 1,
    });
    harness.executor.rows = [candidateRow(freshMessageId)];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_B,
      now: NOW,
      resumeAt: NOW + 60_000,
      urgentMessageId: freshMessageId,
    })).toMatchObject({
      status: "candidate",
      cursor: 20,
      urgent: true,
      candidate: { messageId: freshMessageId },
    });
    expect(harness.scan?.urgentMessageId).toBe(freshMessageId);
    expect(harness.scan?.cursorMessageId).toBe(20);
  });

  test.each([
    ["matching", 5, null],
    ["different", 7, 7],
  ] as const)("urgent claim acknowledgement handles a fresh %s priority without moving the ordinary cursor", async (
    _case,
    freshMessageId,
    expectedPriority,
  ) => {
    const retained = claim(
      DEVICE_A,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({
      cursorMessageId: 20,
      claim: retained,
      leaseToken: retained.claimId,
      leaseDeviceId: retained.deviceId,
      leaseExpiresAt: new Date(retained.expiresAt),
      urgentMessageId: null,
      claimIsUrgent: 1,
    });
    harness.executor.rows = [currentClaimCandidate(retained)];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_B,
      now: NOW + 1,
      resumeAt: NOW + 60_000,
      urgentMessageId: freshMessageId,
    })).toEqual({status: "waiting", resumeAt: retained.expiresAt});
    expect(await scan.advance({claim: retained, now: NOW + 2})).toBe(true);
    expect(harness.scan?.urgentMessageId).toBe(expectedPriority);
    expect(harness.scan?.cursorMessageId).toBe(20);
  });

  test("an invalid expired claim cannot invent background cursor progress", async () => {
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({
      cursorMessageId: 20,
      claim: {version: 1},
      leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      leaseDeviceId: DEVICE_A,
      leaseExpiresAt: new Date(NOW - 1),
    });
    harness.executor.rows = [candidateRow(21)];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_B,
      now: NOW,
      resumeAt: NOW + 60_000,
    })).toMatchObject({
      status: "candidate",
      cursor: 20,
      candidate: {messageId: 21},
    });
    expect(harness.scan?.cursorMessageId).toBe(20);
    expect(harness.scan?.claim).toBeNull();
  });

  test("reoffers a live exact claim to its device and preserves it for competitors", async () => {
    const retained = claim(
      DEVICE_A,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({
      claim: retained,
      leaseToken: retained.claimId,
      leaseDeviceId: retained.deviceId,
      leaseExpiresAt: new Date(retained.expiresAt),
    });
    harness.executor.rows = [currentClaimCandidate(retained)];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_A,
      now: NOW + 1,
      resumeAt: NOW + 60_000,
    })).toEqual({ status: "claimed", claim: retained });
    expect(await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_B,
      now: NOW + 2,
      resumeAt: NOW + 60_000,
    })).toEqual({ status: "waiting", resumeAt: retained.expiresAt });
    expect(harness.scan?.leaseToken).toBe(retained.claimId);
    expect(harness.scan?.cursorMessageId).toBe(0);
  });

  test("invalidates a live claim when the policy revision changes and reconsiders its cursor", async () => {
    const retained = claim(
      DEVICE_A,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const harness = new StatefulCanonicalRunner();
    harness.policyRevision = retained.policyRevision + 1;
    harness.scan = scanRow({
      claim: retained,
      leaseToken: retained.claimId,
      leaseDeviceId: retained.deviceId,
      leaseExpiresAt: new Date(retained.expiresAt),
    });
    harness.executor.rows = [currentClaimCandidate(retained)];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_A,
      now: NOW + 1,
      resumeAt: NOW + 60_000,
    })).toMatchObject({
      status: "candidate",
      policyRevision: retained.policyRevision + 1,
      candidate: { messageId: retained.coordinate.messageId },
    });
    expect(harness.scan?.leaseToken).toBeNull();
    expect(harness.scan?.cursorMessageId).toBe(0);
  });

  test.each([
    ["edited", [currentClaimCandidate(claim(
      DEVICE_A,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ), { edit_revision: 1 })], "candidate"],
    ["deleted", [], "swept"],
  ] as const)("invalidates a live claim when its Message is %s", async (
    _case,
    rows,
    expectedStatus,
  ) => {
    const retained = claim(
      DEVICE_A,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({
      claim: retained,
      leaseToken: retained.claimId,
      leaseDeviceId: retained.deviceId,
      leaseExpiresAt: new Date(retained.expiresAt),
    });
    harness.executor.rows = rows;
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect((await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_A,
      now: NOW + 1,
      resumeAt: NOW + 60_000,
    })).status).toBe(expectedStatus);
    expect(harness.scan?.leaseToken).toBeNull();
    expect(harness.scan?.cursorMessageId).toBe(0);
  });

  test("defers unavailable work and continues without starving later IDs", async () => {
    const harness = new StatefulCanonicalRunner();
    const scan = new PostgresMessageBackfillScan(harness.asRunner());
    harness.executor.rows = [candidateRow(5)];
    const first = await scan.select({
      humanId: HUMAN, deviceId: DEVICE_A, now: NOW, resumeAt: NOW + 60_000,
    });
    expect(first).toMatchObject({ status: "candidate", cursor: 0 });
    await scan.defer({
      humanId: HUMAN, cursor: 0, messageId: 5, urgent: false, now: NOW,
    });
    expect(harness.scan?.cursorMessageId).toBe(5);

    harness.executor.rows = [candidateRow(6)];
    expect(await scan.select({
      humanId: HUMAN, deviceId: DEVICE_A, now: NOW + 1,
      resumeAt: NOW + 60_000,
    })).toMatchObject({
      status: "candidate", cursor: 5, candidate: { messageId: 6 },
    });
  });

  test("serves urgent work without moving the background sweep cursor", async () => {
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({ cursorMessageId: 20 });
    harness.executor.rows = [candidateRow(7)];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    const selected = await scan.select({
      humanId: HUMAN, deviceId: DEVICE_A, now: NOW,
      resumeAt: NOW + 60_000, urgentMessageId: 7,
    });
    expect(selected).toMatchObject({
      status: "candidate", cursor: 20, urgent: true,
    });
    await scan.defer({
      humanId: HUMAN, cursor: 20, messageId: 7, urgent: true, now: NOW,
    });
    expect(harness.scan?.cursorMessageId).toBe(20);
    expect(harness.scan?.urgentMessageId).toBeNull();
  });

  test("does not let a sparse failure suppress a changed edit revision", async () => {
    const harness = new StatefulCanonicalRunner();
    harness.failure = {
      messageId: 5,
      editRevision: 0,
      namespaceAccessRevision: 4,
      sourceRevision: null,
      policyRevision: 3,
      cryptoObjectId: null,
      reason: "integrity_failure",
      observedAt: new Date(NOW - 1_000),
    };
    harness.executor.rows = [candidateRow(5, { edit_revision: 1 })];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({
      humanId: HUMAN, deviceId: DEVICE_A, now: NOW,
      resumeAt: NOW + 60_000,
    })).toMatchObject({
      status: "candidate",
      candidate: { messageId: 5, revision: 1 },
    });
  });

  test.each(["encrypt", "verify", "restore"] as const)(
    "reconsiders cached unsupported history as %s after public topology becomes supported",
    async (action) => {
    const harness = new StatefulCanonicalRunner();
    harness.failure = unsupportedFailureFor(action);
    harness.executor.rows = [candidateRowForAction(action)];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());
    expect(await scan.select({humanId: HUMAN, deviceId: DEVICE_A, now: NOW,
      resumeAt: NOW + 60_000})).toMatchObject({status: "candidate", action,
      candidate: {messageId: 5, revision: 0}});
    },
  );

  test("revisits cached unsupported public history after a cursor-past sweep wraps", async () => {
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({cursorMessageId: 20});
    harness.failure = unsupportedFailureFor("encrypt");
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({humanId: HUMAN, deviceId: DEVICE_A, now: NOW,
      resumeAt: NOW + 60_000})).toEqual({
        status: "swept", resumeAt: NOW + 60_000,
      });
    expect(harness.scan).toMatchObject({
      cursorMessageId: 0,
      resumeAt: new Date(NOW + 60_000),
    });
    expect(harness.failure).toEqual(unsupportedFailureFor("encrypt"));

    harness.executor.rows = [candidateRowForAction("encrypt")];
    expect(await scan.select({humanId: HUMAN, deviceId: DEVICE_B,
      now: NOW + 60_000, resumeAt: NOW + 120_000})).toMatchObject({
        status: "candidate", action: "encrypt", cursor: 0,
        candidate: {messageId: 5},
      });
  });

  test("urgent selection revisits a cached unsupported public row behind the cursor", async () => {
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({cursorMessageId: 20, resumeAt: new Date(NOW + 60_000)});
    harness.failure = unsupportedFailureFor("verify");
    harness.executor.rows = [candidateRowForAction("verify")];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({humanId: HUMAN, deviceId: DEVICE_A, now: NOW,
      urgentMessageId: 5, resumeAt: NOW + 60_000})).toMatchObject({
        status: "candidate", action: "verify", cursor: 20, urgent: true,
        candidate: {messageId: 5},
      });
    expect(harness.scan?.cursorMessageId).toBe(20);
    expect(harness.failure).toEqual(unsupportedFailureFor("verify"));
  });

  test("a later device reconnect resumes a caught-up scan without clearing cached unsupported state", async () => {
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({
      cursorMessageId: 0,
      lastSweepAt: new Date(NOW - 1_000),
      resumeAt: new Date(NOW + 60_000),
    });
    harness.failure = unsupportedFailureFor("restore");
    harness.executor.rows = [candidateRowForAction("restore")];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({humanId: HUMAN, deviceId: DEVICE_A, now: NOW,
      resumeAt: NOW + 60_000})).toEqual({
        status: "waiting", resumeAt: NOW + 60_000,
      });
    expect(await scan.select({humanId: HUMAN, deviceId: DEVICE_B,
      now: NOW + 60_000, resumeAt: NOW + 120_000})).toMatchObject({
        status: "candidate", action: "restore", cursor: 0,
        candidate: {messageId: 5},
      });
    expect(harness.failure).toEqual(unsupportedFailureFor("restore"));
  });

  test("invalidates an exact live Tool claim after its predecessor generation changes", async () => {
    const harness = new StatefulCanonicalRunner();
    const retained = claim(DEVICE_A, "31300000-0000-4000-8000-000000000007");
    retained.coordinate.role = "tool";
    retained.sourceRevision = 7;
    harness.scan = scanRow({claim: retained, leaseToken: retained.claimId,
      leaseDeviceId: DEVICE_A, leaseExpiresAt: new Date(retained.expiresAt)});
    harness.executor.rows = [candidateRow(5, {role: "tool", message_source_revision: 8})];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());
    expect(await scan.select({humanId: HUMAN, deviceId: DEVICE_A, now: NOW,
      resumeAt: NOW + 60_000})).toMatchObject({status: "candidate", candidate: {messageSourceRevision: 8}});
    expect(harness.scan?.claim).toBeNull();
    expect(harness.failure).toBeNull();
  });

  test("failure persistence retains the claim's observed Tool generation instead of relabelling it", async () => {
    const harness = new StatefulCanonicalRunner();
    const retained = claim(DEVICE_A, "31300000-0000-4000-8000-000000000007");
    retained.coordinate.role = "tool";
    retained.sourceRevision = 7;
    harness.scan = scanRow({claim: retained, leaseToken: retained.claimId,
      leaseDeviceId: DEVICE_A, leaseExpiresAt: new Date(retained.expiresAt)});
    harness.executor.rows = [candidateRow(5, {role: "tool", message_source_revision: 8})];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());
    expect(await scan.advance({claim: retained, now: NOW, failure: "parity_mismatch"})).toBe(true);
    expect(harness.failure).toMatchObject({sourceRevision: 7, reason: "parity_mismatch"});
    expect(await scan.select({humanId: HUMAN, deviceId: DEVICE_A, now: NOW + 1,
      urgentMessageId: 5, resumeAt: NOW + 60_000})).toMatchObject({status: "candidate", candidate: {messageSourceRevision: 8}});
  });

  test("retries a Tool result when its predecessor source revision changes", async () => {
    const harness = new StatefulCanonicalRunner();
    harness.failure = {
      messageId: 5,
      editRevision: 0,
      sourceRevision: 0,
      namespaceAccessRevision: 4,
      policyRevision: 3,
      cryptoObjectId: null,
      reason: "integrity_failure",
      observedAt: new Date(NOW - 1_000),
    };
    harness.executor.rows = [candidateRow(5, {
      role: "tool",
      message_source_revision: 1,
    })];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());

    expect(await scan.select({
      humanId: HUMAN,
      deviceId: DEVICE_A,
      now: NOW,
      resumeAt: NOW + 60_000,
    })).toMatchObject({
      status: "candidate",
      candidate: { messageId: 5, messageSourceRevision: 1 },
    });
  });

  test("reports an exact urgent row already completed by another device without moving the sweep", async () => {
    const harness = new StatefulCanonicalRunner();
    harness.scan = scanRow({cursorMessageId: 20});
    harness.executor.rows = [candidateRow(5, {
      crypto_object_id: "message:v2:object-5", lifecycle_session_id: SESSION,
      lifecycle_message_id: 5, lifecycle_revision: 0, lifecycle_crypto_object_id: "message:v2:object-5",
      key_class: "human", completion: "complete", disposition: "mapped",
      parity_status: "client_verified", repair_identity_present: true,
    })];
    const scan = new PostgresMessageBackfillScan(harness.asRunner());
    expect(await scan.select({humanId: HUMAN, deviceId: DEVICE_B, now: NOW,
      urgentMessageId: 5, resumeAt: NOW + 60_000})).toMatchObject({status: "priority_resolved", candidate: {messageId: 5}});
    expect(harness.scan?.cursorMessageId).toBe(20);
    expect(harness.scan?.urgentMessageId).toBeNull();
    expect(harness.scan?.claim).toBeNull();
  });

  test("distinguishes original authentication from accepted restoration", async () => {
    const mapped = candidateRow(5, {
      crypto_object_id: "message:v2:object-5",
      lifecycle_session_id: SESSION,
      lifecycle_message_id: 5,
      lifecycle_revision: 0,
      lifecycle_crypto_object_id: "message:v2:object-5",
      key_class: "human",
      completion: "complete",
      disposition: "mapped",
      parity_status: "client_authenticated",
      repair_identity_present: true,
    });
    const harness = new StatefulCanonicalRunner();
    const scan = new PostgresMessageBackfillScan(harness.asRunner());
    harness.executor.rows = [mapped];
    expect(await scan.select({
      humanId: HUMAN, deviceId: DEVICE_A, now: NOW,
      resumeAt: NOW + 60_000,
    })).toMatchObject({ status: "candidate", action: "verify" });

    harness.executor.rows = [{
      ...mapped,
      ordinary_restoration_accepted: true,
    }];
    expect(await scan.select({
      humanId: HUMAN, deviceId: DEVICE_A, now: NOW + 1,
      resumeAt: NOW + 60_000,
    })).toMatchObject({ status: "more" });
    expect(harness.scan?.cursorMessageId).toBe(5);
  });

  test("Plain and Full policy modes do not discover or mutate scan state", async () => {
    for (const policyMode of ["plaintext_only", "encrypted_only"] as const) {
      const harness = new StatefulCanonicalRunner();
      harness.policyMode = policyMode;
      const scan = new PostgresMessageBackfillScan(harness.asRunner());
      expect(await scan.select({
        humanId: HUMAN, deviceId: DEVICE_A, now: NOW,
        resumeAt: NOW + 60_000,
      })).toEqual({ status: "disabled" });
      expect(harness.executor.calls).toBe(0);
      expect(harness.mutationCount).toBe(0);
      expect(harness.scan).toEqual(scanRow());
    }
  });
});
