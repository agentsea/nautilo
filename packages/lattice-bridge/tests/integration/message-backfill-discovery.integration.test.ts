import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@nautilo/db/schema";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  messageBackfillClaimSchema,
  type MessageBackfillClaim,
} from "@nautilo/api-client/browser";
import {
  actors,
  agents,
  createPostgresJsBridgeConnection,
  createPostgresJsCanonicalBridgeConnection,
  encryptionTransitionPolicy,
  messageBackfillFailures,
  messageBackfillScans,
  namespaces,
  roomMembers,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import {
  bindConversationProductCanonicalTransactionRunner,
  verifyConversationProductPostgresHandle,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import {
  MESSAGE_BACKFILL_CANDIDATE_PAGE_SIZE,
  readMessageBackfillCandidates,
} from "../../src/server/message/postgres-message-backfill-discovery.ts";
import {
  PostgresMessageBackfillScan,
  type MessageBackfillCandidate,
} from "../../src/server/message/postgres-message-backfill-scan.ts";
import { readMessageBackfillProgressAggregate } from
  "../../src/server/message/postgres-message-backfill-progress.ts";
import { classifyMessageBackfillState } from
  "../../src/message/message-backfill-state.ts";

const ROLLBACK = new Error("message backfill integration rollback");

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for this integration test`);
  }
  return value;
}

bootstrapTestDbInstance();

const adminUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL",
);
const productUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_APP_DATABASE_URL",
);

function assertSameClone(adminConnection: string, productConnection: string): void {
  const admin = new URL(adminConnection);
  const product = new URL(productConnection);
  if (
    admin.hostname !== product.hostname
    || admin.port !== product.port
    || admin.pathname !== product.pathname
    || product.username !== "nautilo"
  ) {
    throw new Error("Integration database URLs do not identify one product clone");
  }
}

assertSameClone(adminUrl, productUrl);

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

const CLAIM_DIGEST = Buffer.alloc(32).toString("base64url");

function expiredClaim(input: Readonly<{
  candidate: MessageBackfillCandidate;
  action: "encrypt" | "verify" | "restore";
  humanId: string;
  policyRevision: number;
  deviceId: string;
  now: number;
}>): MessageBackfillClaim {
  const { candidate } = input;
  return messageBackfillClaimSchema.parse({
    version: 1,
    claimId: randomUUID(),
    operationId: `m314-upgrade:${candidate.messageId}:${randomUUID()}`,
    coordinate: {
      sessionId: candidate.sessionId,
      messageId: candidate.messageId,
      revision: candidate.revision,
      roomId: candidate.sourceRoomId,
      namespaceId: candidate.namespaceId,
      role: candidate.role,
      logicalMessageKey: candidate.logicalMessageKey,
    },
    sourceRevision: candidate.role === "tool"
      ? candidate.messageSourceRevision
      : null,
    action: input.action,
    subjectHumanId: input.humanId,
    deviceId: input.deviceId,
    serverInstanceId: "m314-integration",
    deviceGeneration: 1,
    lineageGeneration: 0,
    membershipEpoch: 1,
    membershipSecurityRevision: 1,
    membershipHeadDigestBase64url: CLAIM_DIGEST,
    hostAuthorizationRevision: 1,
    policyRevision: input.policyRevision,
    keyClass: candidate.lifecycle?.keyClass ?? candidate.targetKeyClass,
    namespaceAccessRevision: candidate.namespaceAccessRevision,
    namespaceKeyGeneration: 1,
    namespaceHeadDigestBase64url: CLAIM_DIGEST,
    domainId: "m314-integration-domain",
    domainGeneration: 1,
    domainAuthorizationRevision: 1,
    domainHeadDigestBase64url: CLAIM_DIGEST,
    namespaceBundleRevision: 1,
    namespaceBundleDigestBase64url: CLAIM_DIGEST,
    repairIdentityDigestBase64url: CLAIM_DIGEST,
    createdAt: candidate.createdAt.getTime(),
    authorHumanTurnId: candidate.humanTurnId,
    sessionAgentId: candidate.sessionAgentId,
    cryptoObjectId: candidate.cryptoObjectId
      ?? `message:v2:m314-integration-${candidate.messageId}`,
    issuedAt: input.now - 60_000,
    expiresAt: input.now - 1,
  });
}

interface FixtureIds {
  readonly primaryHumanId: string;
  readonly outsiderHumanId: string;
  readonly privateRoomId: string;
  readonly groupRoomId: string;
  readonly openRoomId: string;
  readonly subthreadRoomId: string;
  readonly openSubthreadRoomId: string;
  readonly privateSessionId: string;
  readonly groupSessionId: string;
  readonly openSessionId: string;
  readonly subthreadSessionId: string;
  readonly privateLifecycleMessageId: number;
  readonly upgradeOpenMessageId: number;
  readonly openMessageId: number;
  readonly editedMessageId: number;
  readonly deletedMessageId: number;
  readonly parentSessionSubthreadMessageId: number;
  readonly openParentSessionSubthreadMessageId: number;
  readonly invalidCrossSessionMessageId: number;
  readonly maximumMessageId: number;
}

async function createFixture(
  database: CanonicalTranscriptTx,
): Promise<FixtureIds> {
  const primaryUserId = randomUUID();
  const outsiderUserId = randomUUID();
  const agentOwnerId = randomUUID();
  const primaryHumanId = randomUUID();
  const outsiderHumanId = randomUUID();
  const agentActorId = randomUUID();
  const agentId = randomUUID();
  const privateNamespaceId = randomUUID();
  const groupNamespaceId = randomUUID();
  const openNamespaceId = randomUUID();
  const privateRoomId = randomUUID();
  const groupRoomId = randomUUID();
  const openRoomId = randomUUID();
  const subthreadRoomId = randomUUID();
  const openSubthreadRoomId = randomUUID();
  const privateSessionId = randomUUID();
  const groupSessionId = randomUUID();
  const openSessionId = randomUUID();
  const subthreadSessionId = randomUUID();

  await database.insert(users).values([
    { id: primaryUserId, name: "M313 integration primary" },
    { id: outsiderUserId, name: "M313 integration outsider" },
    { id: agentOwnerId, name: "M313 integration agent owner" },
  ]);
  await database.insert(agents).values({
    id: agentId,
    handle: `m313-integration-${agentId}`,
  });
  await database.insert(actors).values([
    {
      id: primaryHumanId,
      ownerId: primaryUserId,
      displayName: "M313 integration primary",
      kind: "user",
      trustState: "verified",
    },
    {
      id: outsiderHumanId,
      ownerId: outsiderUserId,
      displayName: "M313 integration outsider",
      kind: "user",
      trustState: "verified",
    },
    {
      id: agentActorId,
      ownerId: agentOwnerId,
      displayName: "M313 integration Agent",
      kind: "agent",
      agentId,
      trustState: "verified",
    },
  ]);
  await database.insert(namespaces).values([
    { id: privateNamespaceId, scope: "room", label: "M313 private" },
    { id: groupNamespaceId, scope: "room", label: "M313 group" },
    { id: openNamespaceId, scope: "room", label: "M313 open" },
  ]);
  await database.insert(rooms).values([
    {
      id: privateRoomId,
      ownerId: primaryUserId,
      type: "private",
      label: "M313 private",
      graphThreadId: `m313:${privateRoomId}`,
      namespaceId: privateNamespaceId,
      kind: "private",
      createdBy: primaryHumanId,
    },
    {
      id: groupRoomId,
      ownerId: primaryUserId,
      type: "shared",
      label: "M313 group",
      graphThreadId: `m313:${groupRoomId}`,
      namespaceId: groupNamespaceId,
      kind: "group",
      createdBy: primaryHumanId,
    },
    {
      id: openRoomId,
      ownerId: primaryUserId,
      type: "shared",
      label: "M313 open",
      graphThreadId: `m313:${openRoomId}`,
      namespaceId: openNamespaceId,
      kind: "open",
      createdBy: primaryHumanId,
    },
  ]);
  await database.insert(roomMembers).values([
    { roomId: privateRoomId, actorId: primaryHumanId, roomRole: "admin" },
    {
      roomId: privateRoomId,
      actorId: agentActorId,
      roomRole: "member",
      agentResponseMode: "active",
    },
    { roomId: groupRoomId, actorId: primaryHumanId, roomRole: "admin" },
    { roomId: openRoomId, actorId: primaryHumanId, roomRole: "admin" },
  ]);
  await database.insert(sessions).values([
    {
      id: privateSessionId,
      threadId: `m313:${privateSessionId}`,
      ownerId: primaryUserId,
      personaId: "owner",
      agentId,
      roomId: privateRoomId,
      channel: "integration",
    },
    {
      id: groupSessionId,
      threadId: `m313:${groupSessionId}`,
      ownerId: primaryUserId,
      personaId: "owner",
      roomId: groupRoomId,
      channel: "integration",
    },
    {
      id: openSessionId,
      threadId: `m313:${openSessionId}`,
      ownerId: primaryUserId,
      personaId: "owner",
      roomId: openRoomId,
      channel: "integration",
    },
  ]);

  // Keep one public row before the deliberately multi-page private corpus so
  // cursor wrap and expired-lease continuation can assert the exact first and
  // next eligible coordinates without test-side candidate substitution.
  const [upgradeOpenMessage] = await database.insert(sessionMessages).values({
    sessionId: openSessionId,
    role: "system",
    content: "M313 cached unsupported public ordinary",
    fingerprint: `m314-upgrade-open-${randomUUID()}`,
  }).returning({ id: sessionMessages.id });
  if (upgradeOpenMessage === undefined) {
    throw new Error("Missing cached unsupported public Message fixture");
  }

  const roles = ["user", "assistant", "tool", "system"] as const;
  const privateMessages = await database.insert(sessionMessages).values(
    Array.from({ length: MESSAGE_BACKFILL_CANDIDATE_PAGE_SIZE + 4 }, (_, index) => ({
      sessionId: privateSessionId,
      role: roles[index % roles.length]!,
      content: `private fixture ${index}`,
      fingerprint: `m313-private-${index}-${randomUUID()}`,
      humanTurnId: index % roles.length === 0 ? `turn-${randomUUID()}` : null,
    })),
  ).returning({ id: sessionMessages.id });
  const privateLifecycleMessageId = privateMessages[0]!.id;

  const [threadRoot] = await database.insert(sessionMessages).values({
    sessionId: groupSessionId,
    role: "user",
    content: "subthread anchor",
    humanTurnId: `turn-${randomUUID()}`,
  }).returning({ id: sessionMessages.id });
  if (threadRoot === undefined) throw new Error("Missing Subthread root fixture");
  const [openThreadRoot] = await database.insert(sessionMessages).values({
    sessionId: openSessionId,
    role: "user",
    content: "public subthread anchor",
    humanTurnId: `turn-${randomUUID()}`,
  }).returning({ id: sessionMessages.id });
  if (openThreadRoot === undefined) {
    throw new Error("Missing public Subthread root fixture");
  }

  await database.insert(rooms).values([
    {
      id: subthreadRoomId,
      ownerId: primaryUserId,
      type: "shared",
      label: "M313 Subthread",
      graphThreadId: `m313:${subthreadRoomId}`,
      namespaceId: groupNamespaceId,
      kind: "subthread",
      parentRoomId: groupRoomId,
      threadRootMessageId: threadRoot.id,
      createdBy: primaryHumanId,
    },
    {
      id: openSubthreadRoomId,
      ownerId: primaryUserId,
      type: "shared",
      label: "M314 public Subthread",
      graphThreadId: `m314:${openSubthreadRoomId}`,
      namespaceId: openNamespaceId,
      kind: "subthread",
      parentRoomId: openRoomId,
      threadRootMessageId: openThreadRoot.id,
      createdBy: primaryHumanId,
    },
  ]);
  await database.insert(roomMembers).values([
    {
      roomId: subthreadRoomId,
      actorId: primaryHumanId,
      roomRole: "admin",
    },
    {
      roomId: openSubthreadRoomId,
      actorId: primaryHumanId,
      roomRole: "admin",
    },
  ]);
  await database.insert(sessions).values({
    id: subthreadSessionId,
    threadId: `m313:${subthreadSessionId}`,
    ownerId: primaryUserId,
    personaId: "owner",
    roomId: subthreadRoomId,
    channel: "integration",
  });

  const [editedMessage] = await database.insert(sessionMessages).values({
    sessionId: groupSessionId,
    role: "assistant",
    content: "edited current ordinary",
    fingerprint: `m313-edited-${randomUUID()}`,
    editRevision: 2,
  }).returning({ id: sessionMessages.id });
  const [deletedMessage] = await database.insert(sessionMessages).values({
    sessionId: groupSessionId,
    role: "tool",
    content: "deleted ordinary",
    fingerprint: `m313-deleted-${randomUUID()}`,
  }).returning({ id: sessionMessages.id });
  const [openMessage] = await database.insert(sessionMessages).values({
    sessionId: openSessionId,
    role: "system",
    content: "open ordinary",
    fingerprint: `m313-open-${randomUUID()}`,
  }).returning({ id: sessionMessages.id });
  const [subthreadMessage] = await database.insert(sessionMessages).values({
    sessionId: subthreadSessionId,
    role: "tool",
    content: "subthread ordinary",
    fingerprint: `m313-subthread-${randomUUID()}`,
    subthreadRoomId,
  }).returning({ id: sessionMessages.id });
  const [parentSessionSubthreadMessage] = await database.insert(sessionMessages)
    .values({
      sessionId: groupSessionId,
      role: "assistant",
      content: "parent Session Subthread ordinary",
      fingerprint: `m313-parent-session-subthread-${randomUUID()}`,
      subthreadRoomId,
    }).returning({ id: sessionMessages.id });
  const [openParentSessionSubthreadMessage] = await database
    .insert(sessionMessages).values({
      sessionId: openSessionId,
      role: "tool",
      content: "public parent Session Subthread ordinary",
      fingerprint: `m314-public-parent-session-subthread-${randomUUID()}`,
      subthreadRoomId: openSubthreadRoomId,
    }).returning({ id: sessionMessages.id });
  const [invalidCrossSessionMessage] = await database.insert(sessionMessages)
    .values({
      sessionId: openSessionId,
      role: "assistant",
      content: "invalid cross-Session Subthread ordinary",
      fingerprint: `m313-invalid-cross-session-${randomUUID()}`,
      subthreadRoomId,
    }).returning({ id: sessionMessages.id });
  if (
    editedMessage === undefined
    || deletedMessage === undefined
    || openMessage === undefined
    || subthreadMessage === undefined
    || parentSessionSubthreadMessage === undefined
    || openParentSessionSubthreadMessage === undefined
    || invalidCrossSessionMessage === undefined
  ) throw new Error("Missing Message fixture");

  await database.insert(sessionMessageCryptoRevisions).values([
    {
      sessionId: privateSessionId,
      messageId: privateLifecycleMessageId,
      editRevision: 0,
      roomId: privateRoomId,
      namespaceIdAtAllocation: privateNamespaceId,
      cryptoObjectId: `message:v2:m313-private-${randomUUID()}`,
      keyClass: "human",
      authorRole: "user",
      appendIdempotencyKey: `m313-private-${randomUUID()}`,
      allocationRequestDigest: digest(0x11),
      repairIdentityDigest: digest(0x12),
    },
    {
      sessionId: groupSessionId,
      messageId: editedMessage.id,
      editRevision: 1,
      roomId: groupRoomId,
      namespaceIdAtAllocation: groupNamespaceId,
      cryptoObjectId: `message:v2:m313-edit-old-${randomUUID()}`,
      keyClass: "human",
      authorRole: "assistant",
      allocationRequestDigest: digest(0x21),
    },
    {
      sessionId: groupSessionId,
      messageId: editedMessage.id,
      editRevision: 2,
      roomId: groupRoomId,
      namespaceIdAtAllocation: groupNamespaceId,
      cryptoObjectId: `message:v2:m313-edit-current-${randomUUID()}`,
      keyClass: "ai",
      authorRole: "assistant",
      allocationRequestDigest: digest(0x22),
      repairIdentityDigest: digest(0x23),
    },
    {
      sessionId: groupSessionId,
      messageId: deletedMessage.id,
      editRevision: 0,
      roomId: groupRoomId,
      namespaceIdAtAllocation: groupNamespaceId,
      cryptoObjectId: `message:v2:m313-deleted-${randomUUID()}`,
      keyClass: "human",
      authorRole: "tool",
      appendIdempotencyKey: `m313-deleted-${randomUUID()}`,
      allocationRequestDigest: digest(0x31),
    },
  ]);
  await database.delete(sessionMessages).where(eq(
    sessionMessages.id,
    deletedMessage.id,
  ));

  return {
    primaryHumanId,
    outsiderHumanId,
    privateRoomId,
    groupRoomId,
    openRoomId,
    subthreadRoomId,
    openSubthreadRoomId,
    privateSessionId,
    groupSessionId,
    openSessionId,
    subthreadSessionId,
    privateLifecycleMessageId,
    upgradeOpenMessageId: upgradeOpenMessage.id,
    openMessageId: openMessage.id,
    editedMessageId: editedMessage.id,
    deletedMessageId: deletedMessage.id,
    parentSessionSubthreadMessageId: parentSessionSubthreadMessage.id,
    openParentSessionSubthreadMessageId: openParentSessionSubthreadMessage.id,
    invalidCrossSessionMessageId: invalidCrossSessionMessage.id,
    maximumMessageId: Math.max(
      ...privateMessages.map(({ id }) => id),
      threadRoot.id,
      editedMessage.id,
      openMessage.id,
      subthreadMessage.id,
      parentSessionSubthreadMessage.id,
      openParentSessionSubthreadMessage.id,
      invalidCrossSessionMessage.id,
    ),
  };
}

describe("Message backfill PostgreSQL discovery", () => {
  test("plans progress queries for every nullable claim shape without writes", async () => {
    const client = postgres(productUrl, {
      max: 1,
      connection: { default_transaction_read_only: true },
      onnotice: () => undefined,
    });
    try {
      const executor = await verifyConversationProductPostgresHandle(
        createPostgresJsBridgeConnection({ $client: client }),
      );
      const input = { subjectHumanId: randomUUID(), policyRevision: 1 };
      const empty = {
        eligible: 0,
        pending: 0,
        alreadyAuthenticated: 0,
        independentlyParityVerified: 0,
        claimedRepairing: 0,
        repairedAndVerified: 0,
        unsupported: 0,
        failed: 0,
      };
      expect(await readMessageBackfillProgressAggregate(executor, input))
        .toEqual(empty);
      // The unknown Human has no rows, but PostgreSQL must still parse and
      // type every bound predicate. No fixture or policy mutation is needed.
      for (const action of ["encrypt", "verify", "restore"] as const) {
        for (const role of ["user", "assistant", "system", "tool"]) {
          for (const sourceRevision of [null, 1]) {
            expect(await readMessageBackfillProgressAggregate(executor, {
              ...input,
              claimed: {
                action,
                role,
                sourceRevision,
                messageId: 1,
                sessionId: randomUUID(),
                revision: 0,
                sourceRoomId: randomUUID(),
                namespaceId: randomUUID(),
                cryptoObjectId: randomUUID(),
              },
            })).toEqual(empty);
          }
        }
      }
    } finally {
      await client.end();
    }
  });

  test("reads bounded Human-authorized keyset pages with current structural state", async () => {
    const client = postgres(productUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    let rolledBackHumanId: string | undefined;
    try {
      const handle = await verifyConversationProductPostgresHandle(
        createPostgresJsBridgeConnection({ $client: client }),
      );
      const canonical = bindConversationProductCanonicalTransactionRunner(
        handle,
        createPostgresJsCanonicalBridgeConnection(drizzle(client, { schema })),
      );
      await canonical.transaction(async (database, canonicalExecutor) => {
        const fixture = await createFixture(database);
        rolledBackHumanId = fixture.primaryHumanId;
        const first = await readMessageBackfillCandidates(canonicalExecutor, {
          subjectHumanId: fixture.primaryHumanId,
          afterMessageId: 0,
          throughMessageId: fixture.maximumMessageId,
        });
        expect(first).toHaveLength(MESSAGE_BACKFILL_CANDIDATE_PAGE_SIZE);
        const second = await readMessageBackfillCandidates(canonicalExecutor, {
          subjectHumanId: fixture.primaryHumanId,
          afterMessageId: first.at(-1)!.messageId,
          throughMessageId: fixture.maximumMessageId,
        });
        expect(second.length).toBeGreaterThan(0);
        expect(second.length).toBeLessThanOrEqual(
          MESSAGE_BACKFILL_CANDIDATE_PAGE_SIZE,
        );

        const candidates = [...first, ...second];
        expect(candidates.map(({ messageId }) => messageId)).toEqual(
          [...candidates.map(({ messageId }) => messageId)].sort((a, b) => a - b),
        );
        expect(new Set(candidates.map(({ role }) => role))).toEqual(
          new Set(["user", "assistant", "tool", "system"]),
        );
        expect(candidates.find(({ messageId }) =>
          messageId === fixture.parentSessionSubthreadMessageId)).toMatchObject({
          sessionRoomId: fixture.groupRoomId,
          subthreadRoomId: fixture.subthreadRoomId,
          sourceRoomId: fixture.subthreadRoomId,
          authorityRoomId: fixture.groupRoomId,
          supportedTopology: true,
        });
        expect(candidates.find(({ messageId }) =>
          messageId === fixture.openParentSessionSubthreadMessageId)).toMatchObject({
          sessionRoomId: fixture.openRoomId,
          subthreadRoomId: fixture.openSubthreadRoomId,
          sourceRoomId: fixture.openSubthreadRoomId,
          authorityRoomId: fixture.openRoomId,
          supportedTopology: true,
          targetKeyClass: "human",
        });
        expect(candidates.some(({ sessionRoomId, sourceRoomId, authorityRoomId }) =>
          sessionRoomId === fixture.subthreadRoomId
          && sourceRoomId === fixture.subthreadRoomId
          && authorityRoomId === fixture.groupRoomId)).toBe(true);
        expect(candidates.find(({ messageId }) =>
          messageId === fixture.invalidCrossSessionMessageId)).toBeUndefined();
        expect(candidates.find(({ messageId }) =>
          messageId === fixture.deletedMessageId)).toBeUndefined();

        const privateLifecycle = candidates.find(({ messageId }) =>
          messageId === fixture.privateLifecycleMessageId);
        expect(privateLifecycle).toMatchObject({
          sourceRoomId: fixture.privateRoomId,
          supportedTopology: true,
          targetKeyClass: "ai",
          lifecycle: {
            revision: 0,
            keyClass: "human",
            completion: "pending",
            repairIdentityPresent: true,
          },
        });
        const edited = candidates.find(({ messageId }) =>
          messageId === fixture.editedMessageId);
        expect(edited).toMatchObject({
          sourceRoomId: fixture.groupRoomId,
          revision: 2,
          targetKeyClass: "human",
          lifecycle: {
            revision: 2,
            keyClass: "ai",
            completion: "pending",
            repairIdentityPresent: true,
          },
        });
        const openCandidateIndex = candidates.findIndex(({ messageId }) =>
          messageId === fixture.openMessageId);
        expect(candidates[openCandidateIndex]).toMatchObject({
          sourceRoomId: fixture.openRoomId,
          supportedTopology: true,
          targetKeyClass: "human",
        });
        expect(candidates.every((candidate) =>
          !("content" in candidate)
          && !("toolCalls" in candidate)
          && !("metadata" in candidate))).toBe(true);
        expect(candidates.every(({ createdAt }) =>
          createdAt instanceof Date && Number.isFinite(createdAt.getTime())
        )).toBe(true);

        const classifierStates = candidates.map(candidate =>
          classifyMessageBackfillState({
            message: {...candidate, roomId: candidate.sourceRoomId},
            lifecycle: candidate.lifecycle,
            supportedTopology: candidate.supportedTopology,
            ordinaryRestorationAccepted: candidate.ordinaryRestorationAccepted,
          }));
        expect(classifierStates[openCandidateIndex]).toEqual({
          action: "encrypt",
          evidence: "none",
          reason: null,
        });
        const aggregate = await readMessageBackfillProgressAggregate(
          canonicalExecutor,
          {subjectHumanId: fixture.primaryHumanId, policyRevision: 1},
        );
        expect(aggregate).toEqual({
          eligible: candidates.filter(({supportedTopology}) =>
            supportedTopology).length,
          pending: classifierStates.filter(({action}) => action !== "none").length,
          alreadyAuthenticated: classifierStates.filter(({evidence}) =>
            evidence === "authenticated").length,
          independentlyParityVerified: classifierStates.filter(({evidence}) =>
            evidence === "independent_parity").length,
          claimedRepairing: 0,
          repairedAndVerified: candidates.filter((candidate, index) =>
            classifierStates[index]?.evidence === "independent_parity"
            && candidate.ordinaryPresent
            && (candidate.lifecycle?.repairIdentityPresent === true
              || candidate.ordinaryRestorationAccepted)).length,
          unsupported: classifierStates.filter(({action}) =>
            action === "unsupported").length,
          failed: classifierStates.filter(({action}) =>
            action === "failed").length,
        });
        expect(aggregate.unsupported).toBe(0);

        const upgradeCandidate = candidates.find(({ messageId }) =>
          messageId === fixture.upgradeOpenMessageId);
        if (upgradeCandidate === undefined) {
          throw new Error("Missing cached unsupported public candidate");
        }
        const upgradeState = classifyMessageBackfillState({
          message: {...upgradeCandidate, roomId: upgradeCandidate.sourceRoomId},
          lifecycle: upgradeCandidate.lifecycle,
          supportedTopology: upgradeCandidate.supportedTopology,
          ordinaryRestorationAccepted:
            upgradeCandidate.ordinaryRestorationAccepted,
        });
        expect(upgradeState).toEqual({
          action: "encrypt",
          evidence: "none",
          reason: null,
        });
        const nextCandidate = candidates.find(({ messageId }, index) => {
          if (messageId <= upgradeCandidate.messageId) return false;
          const state = classifierStates[index];
          return state?.action === "encrypt"
            || state?.action === "verify"
            || state?.action === "restore";
        });
        if (nextCandidate === undefined) {
          throw new Error("Missing unrelated continuation candidate");
        }

        const [currentPolicy] = await database.select({
          mode: encryptionTransitionPolicy.mode,
          revision: encryptionTransitionPolicy.revision,
        }).from(encryptionTransitionPolicy).where(eq(
          encryptionTransitionPolicy.id,
          "server",
        ));
        if (currentPolicy === undefined) {
          throw new Error("Missing encryption transition policy");
        }
        const scanPolicy = currentPolicy.mode === "shadow_encryption"
          ? currentPolicy
          : (await database.update(encryptionTransitionPolicy).set({
              mode: "shadow_encryption",
              revision: sql`${encryptionTransitionPolicy.revision} + 1`,
              shadowEncryptionStartedAt:
                sql`coalesce(${encryptionTransitionPolicy.shadowEncryptionStartedAt}, CURRENT_TIMESTAMP)`,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            }).where(eq(encryptionTransitionPolicy.id, "server")).returning({
              mode: encryptionTransitionPolicy.mode,
              revision: encryptionTransitionPolicy.revision,
            }))[0];
        if (scanPolicy === undefined) {
          throw new Error("Could not establish Shadow scan policy");
        }
        const inTransactionRunner =
          bindConversationProductCanonicalTransactionRunner(handle, {
            transaction: callback => callback(database, canonicalExecutor),
          });
        const scan = new PostgresMessageBackfillScan(inTransactionRunner);
        const now = Date.now();
        const observedAt = new Date(now - 120_000);

        // This is the preserved M313 tuple. Nothing about the Message, Room,
        // membership or policy changes after it is written; only M314's
        // topology classifier now says the same public row is actionable.
        await database.insert(messageBackfillFailures).values({
          messageId: upgradeCandidate.messageId,
          editRevision: upgradeCandidate.revision,
          sourceRevision: null,
          namespaceAccessRevision: upgradeCandidate.namespaceAccessRevision,
          policyRevision: scanPolicy.revision,
          cryptoObjectId: upgradeCandidate.cryptoObjectId,
          reason: "unsupported",
          observedAt,
        });
        await database.insert(messageBackfillScans).values({
          humanActorId: fixture.primaryHumanId,
          cursorMessageId: fixture.maximumMessageId,
        });
        expect(await scan.select({
          humanId: fixture.primaryHumanId,
          deviceId: "m314-upgrade-device",
          now,
          resumeAt: now + 1,
        })).toEqual({ status: "swept", resumeAt: now + 1 });
        expect(await scan.select({
          humanId: fixture.primaryHumanId,
          deviceId: "m314-upgrade-device",
          now: now + 1,
          resumeAt: now + 60_000,
        })).toMatchObject({
          status: "candidate",
          action: "encrypt",
          cursor: 0,
          urgent: false,
          candidate: { messageId: upgradeCandidate.messageId },
        });
        const [preservedFailure] = await database.select()
          .from(messageBackfillFailures).where(eq(
            messageBackfillFailures.messageId,
            upgradeCandidate.messageId,
          ));
        expect(preservedFailure).toMatchObject({
          editRevision: upgradeCandidate.revision,
          sourceRevision: null,
          namespaceAccessRevision: upgradeCandidate.namespaceAccessRevision,
          policyRevision: scanPolicy.revision,
          cryptoObjectId: upgradeCandidate.cryptoObjectId,
          reason: "unsupported",
        });
        expect(preservedFailure?.observedAt.getTime()).toBe(
          observedAt.getTime(),
        );

        await database.delete(messageBackfillFailures).where(eq(
          messageBackfillFailures.messageId,
          upgradeCandidate.messageId,
        ));
        await database.delete(messageBackfillScans).where(eq(
          messageBackfillScans.humanActorId,
          fixture.primaryHumanId,
        ));

        // An ordinary expired missing-key lease skips only its exact row for
        // this sweep, allowing unrelated work through. End-of-sweep wrap then
        // revisits the skipped row; expiry records no completion or failure.
        const ordinaryExpired = expiredClaim({
          candidate: upgradeCandidate,
          action: "encrypt",
          humanId: fixture.primaryHumanId,
          policyRevision: scanPolicy.revision,
          deviceId: "m314-expired-ordinary",
          now,
        });
        await database.insert(messageBackfillScans).values({
          humanActorId: fixture.primaryHumanId,
          cursorMessageId: 0,
          claim: ordinaryExpired as unknown as Record<string, unknown>,
          leaseToken: ordinaryExpired.claimId,
          leaseDeviceId: ordinaryExpired.deviceId,
          leaseExpiresAt: new Date(ordinaryExpired.expiresAt),
          claimIsUrgent: 0,
        });
        expect(await scan.select({
          humanId: fixture.primaryHumanId,
          deviceId: "m314-next-device",
          now,
          resumeAt: now + 60_000,
        })).toMatchObject({
          status: "candidate",
          cursor: upgradeCandidate.messageId,
          urgent: false,
          candidate: { messageId: nextCandidate.messageId },
        });
        expect(await database.select().from(messageBackfillFailures).where(eq(
          messageBackfillFailures.messageId,
          upgradeCandidate.messageId,
        ))).toEqual([]);

        await database.update(messageBackfillScans).set({
          cursorMessageId: fixture.maximumMessageId,
        }).where(eq(
          messageBackfillScans.humanActorId,
          fixture.primaryHumanId,
        ));
        expect(await scan.select({
          humanId: fixture.primaryHumanId,
          deviceId: "m314-next-device",
          now: now + 1,
          resumeAt: now + 2,
        })).toEqual({ status: "swept", resumeAt: now + 2 });
        expect(await scan.select({
          humanId: fixture.primaryHumanId,
          deviceId: "m314-next-device",
          now: now + 2,
          resumeAt: now + 60_000,
        })).toMatchObject({
          status: "candidate",
          action: "encrypt",
          cursor: 0,
          urgent: false,
          candidate: { messageId: upgradeCandidate.messageId },
        });

        await database.delete(messageBackfillScans).where(eq(
          messageBackfillScans.humanActorId,
          fixture.primaryHumanId,
        ));
        const urgentLease = messageBackfillClaimSchema.parse({
          ...expiredClaim({
          candidate: upgradeCandidate,
          action: "encrypt",
          humanId: fixture.primaryHumanId,
          policyRevision: scanPolicy.revision,
          deviceId: "m314-expired-urgent",
          now,
          }),
          issuedAt: now,
          expiresAt: now + 60_000,
        });
        await database.insert(messageBackfillScans).values({
          humanActorId: fixture.primaryHumanId,
          cursorMessageId: upgradeCandidate.messageId,
          urgentMessageId: upgradeCandidate.messageId,
        });
        expect(await scan.install({
          claim: urgentLease,
          cursor: upgradeCandidate.messageId,
          urgent: true,
          now,
        })).toBe(true);
        expect(await scan.select({
          humanId: fixture.primaryHumanId,
          deviceId: "m314-next-device",
          now: urgentLease.expiresAt,
          resumeAt: urgentLease.expiresAt + 60_000,
        })).toMatchObject({
          status: "candidate",
          cursor: upgradeCandidate.messageId,
          urgent: false,
          candidate: { messageId: nextCandidate.messageId },
        });
        const [urgentContinuation] = await database.select({
          cursorMessageId: messageBackfillScans.cursorMessageId,
          urgentMessageId: messageBackfillScans.urgentMessageId,
          claim: messageBackfillScans.claim,
          leaseToken: messageBackfillScans.leaseToken,
        }).from(messageBackfillScans).where(eq(
          messageBackfillScans.humanActorId,
          fixture.primaryHumanId,
        ));
        expect(urgentContinuation).toEqual({
          cursorMessageId: upgradeCandidate.messageId,
          urgentMessageId: null,
          claim: null,
          leaseToken: null,
        });

        // A competing device's same-coordinate visible hint is a new signal,
        // even while the original urgent lease remains live. The first call
        // persists it before waiting; expiry must reoffer it without another hint.
        await database.delete(messageBackfillScans).where(eq(
          messageBackfillScans.humanActorId,
          fixture.primaryHumanId,
        ));
        const resignaledLease = messageBackfillClaimSchema.parse({
          ...urgentLease,
          claimId: randomUUID(),
          operationId: `m314-upgrade-resignaled:${upgradeCandidate.messageId}:${randomUUID()}`,
        });
        await database.insert(messageBackfillScans).values({
          humanActorId: fixture.primaryHumanId,
          cursorMessageId: upgradeCandidate.messageId,
          urgentMessageId: upgradeCandidate.messageId,
        });
        expect(await scan.install({
          claim: resignaledLease,
          cursor: upgradeCandidate.messageId,
          urgent: true,
          now,
        })).toBe(true);
        expect(await scan.select({
          humanId: fixture.primaryHumanId,
          deviceId: "m314-next-device",
          now: now + 1,
          resumeAt: resignaledLease.expiresAt,
          urgentMessageId: upgradeCandidate.messageId,
        })).toEqual({status: "waiting", resumeAt: resignaledLease.expiresAt});
        expect(await scan.select({
          humanId: fixture.primaryHumanId,
          deviceId: "m314-next-device",
          now: resignaledLease.expiresAt,
          resumeAt: resignaledLease.expiresAt + 60_000,
        })).toMatchObject({
          status: "candidate",
          cursor: upgradeCandidate.messageId,
          urgent: true,
          candidate: {messageId: upgradeCandidate.messageId},
        });

        const pendingTool = candidates.find((candidate, index) =>
          candidate.role === "tool"
          && candidate.supportedTopology
          && classifierStates[index]?.action === "encrypt");
        if (pendingTool === undefined) {
          throw new Error("Integration fixture needs one supported pending Tool");
        }
        await database.insert(messageBackfillFailures).values({
          messageId: pendingTool.messageId,
          editRevision: pendingTool.revision,
          sourceRevision: pendingTool.messageSourceRevision,
          namespaceAccessRevision: pendingTool.namespaceAccessRevision,
          policyRevision: 1,
          cryptoObjectId: pendingTool.cryptoObjectId,
          reason: "unsupported",
        });
        expect(await readMessageBackfillProgressAggregate(canonicalExecutor, {
          subjectHumanId: fixture.primaryHumanId,
          policyRevision: 1,
        })).toEqual(aggregate);
        await database.update(messageBackfillFailures).set({
          reason: "parity_mismatch",
        }).where(eq(messageBackfillFailures.messageId, pendingTool.messageId));
        expect(await readMessageBackfillProgressAggregate(canonicalExecutor, {
          subjectHumanId: fixture.primaryHumanId,
          policyRevision: 1,
        })).toEqual({...aggregate, failed: aggregate.failed + 1});
        await database.update(messageBackfillFailures).set({
          sourceRevision: pendingTool.messageSourceRevision + 1,
        }).where(eq(messageBackfillFailures.messageId, pendingTool.messageId));
        expect(await readMessageBackfillProgressAggregate(canonicalExecutor, {
          subjectHumanId: fixture.primaryHumanId,
          policyRevision: 1,
        })).toEqual(aggregate);

        const outsider = await readMessageBackfillCandidates(canonicalExecutor, {
          subjectHumanId: fixture.outsiderHumanId,
          afterMessageId: 0,
          throughMessageId: fixture.maximumMessageId,
        });
        expect(outsider).toEqual([]);

        const retained = await database.select({
          messageId: sessionMessageCryptoRevisions.messageId,
          editRevision: sessionMessageCryptoRevisions.editRevision,
        }).from(sessionMessageCryptoRevisions).where(inArray(
          sessionMessageCryptoRevisions.messageId,
          [fixture.editedMessageId, fixture.deletedMessageId],
        ));
        expect(retained.map(({ messageId, editRevision }) =>
          `${messageId}:${editRevision}`).sort()).toEqual([
          `${fixture.deletedMessageId}:0`,
          `${fixture.editedMessageId}:1`,
          `${fixture.editedMessageId}:2`,
        ].sort());

        throw ROLLBACK;
      }, { isolationLevel: "serializable" });
      throw new Error("Expected integration fixture rollback");
    } catch (error) {
      if (error !== ROLLBACK) throw error;
      if (rolledBackHumanId === undefined) {
        throw new Error("Integration fixture did not reach rollback proof");
      }
      const remaining = await client<{ count: number }[]>`
        SELECT count(*)::int AS count
          FROM actors
         WHERE id = ${rolledBackHumanId}
      `;
      expect(remaining[0]?.count).toBe(0);
    } finally {
      await client.end();
    }
  }, 60_000);

  test("keeps backfill coordination metadata product-only", async () => {
    const admin = postgres(adminUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    try {
      const rows = await admin<{
        table_name: string;
        agent_select: boolean;
        agent_update: boolean;
        crypto_select: boolean;
        crypto_update: boolean;
      }[]>`
        SELECT table_name,
               has_table_privilege(
                 'nautilo_agent', format('public.%I', table_name), 'SELECT'
               ) AS agent_select,
               has_table_privilege(
                 'nautilo_agent', format('public.%I', table_name), 'UPDATE'
               ) AS agent_update,
               has_table_privilege(
                 'nautilo_crypto', format('public.%I', table_name), 'SELECT'
               ) AS crypto_select,
               has_table_privilege(
                 'nautilo_crypto', format('public.%I', table_name), 'UPDATE'
               ) AS crypto_update
          FROM unnest(ARRAY[
            'message_backfill_scans',
            'message_backfill_failures'
          ]) AS table_name
      `;
      expect(rows).toHaveLength(2);
      expect(Array.from(rows)).toEqual([
        {
          table_name: "message_backfill_scans",
          agent_select: false,
          agent_update: false,
          crypto_select: false,
          crypto_update: false,
        },
        {
          table_name: "message_backfill_failures",
          agent_select: false,
          agent_update: false,
          crypto_select: false,
          crypto_update: false,
        },
      ]);
    } finally {
      await admin.end();
    }
  });
});
