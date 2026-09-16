import {
  actors,
  and,
  eq,
  roomMembers,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessageDirectedRecipients,
  sessionMessages,
  sessions,
  sql,
  subthreadNotificationParticipants,
  type DirectDatabase,
  type DirectedRecipientReason,
  type SubthreadParticipationReason,
} from "@nautilo/db";

export const MAX_STRUCTURED_HUMAN_MENTIONS = 32;

export interface AppendNotificationContext {
  mentionedHumanUserIds: string[];
  causalHumanUserId: string | null;
  causalHumanTurnId: string | null;
}

export interface ProtectedNotificationStructuralProjection {
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly transcriptOrigin: "main" | "subagent";
  readonly replyToMessageId: number | null;
  readonly eligibility: "eligible" | "excluded";
}

/**
 * The content-free boundary starts after this admission check. Legacy rows
 * retain their existing message-local exclusion rules; protected rows use
 * only their writer-supplied structural projection and never open content or
 * metadata. The result is the shared answer to whether a newly inserted row
 * needs durable notification follow-up.
 */
function isNotificationClassificationEligible(input: {
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  transcriptOrigin: "main" | "subagent";
  metadata: Record<string, unknown> | null;
  protectedProjection?: ProtectedNotificationStructuralProjection;
}): boolean {
  if (input.role !== "user" && input.role !== "assistant") return false;
  if (input.protectedProjection !== undefined) {
    return input.protectedProjection.eligibility === "eligible";
  }
  return input.transcriptOrigin === "main"
    && input.metadata?.["originatedBy"] !== "task"
    && input.metadata?.["originatedBy"] !== "connected_web_operation"
    && (input.role !== "assistant" || (input.content ?? "").trim().length > 0);
}

export type NotificationClassificationTx = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

export class NotificationClassificationError extends Error {
  constructor(readonly reason: string) {
    super(`NotificationClassificationError:${reason}`);
    this.name = "NotificationClassificationError";
  }
}

type DirectedFact = {
  recipientId: string;
  reason: DirectedRecipientReason;
};

type ParticipationFact = {
  userId: string;
  reason: SubthreadParticipationReason;
};

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function protectedOrLegacyEligibleHumanTarget(): ReturnType<typeof sql> {
  return sql`(
    exists (
      select 1
        from ${sessionMessageCryptoRevisions} as protected_lifecycle
       where protected_lifecycle.message_id = ${sessionMessages.id}
         and protected_lifecycle.edit_revision =
               ${sessionMessages.editRevision}
         and protected_lifecycle.subthread_reply_classification = 'counted'
    )
    or (
      not exists (
        select 1
          from ${sessionMessageCryptoRevisions} as protected_lifecycle
         where protected_lifecycle.message_id = ${sessionMessages.id}
           and protected_lifecycle.edit_revision =
                 ${sessionMessages.editRevision}
      )
      and (
        ${sessionMessages.metadata}->>'originatedBy'
      ) is distinct from 'task'
      and (${sessionMessages.metadata}->>'originatedBy')
        is distinct from 'connected_web_operation'
    )
  )`;
}

/**
 * M233 — classify one newly inserted transcript row inside its owning append
 * transaction. The caller must invoke this only for an actual RETURNING row.
 */
export async function persistNotificationClassification(
  tx: NotificationClassificationTx,
  input: {
    messageId: number;
    context: AppendNotificationContext;
    protectedProjection?: ProtectedNotificationStructuralProjection;
  },
): Promise<boolean> {
  const mentionedHumanUserIds = uniqueIds(input.context.mentionedHumanUserIds);
  if (mentionedHumanUserIds.length > MAX_STRUCTURED_HUMAN_MENTIONS) {
    throw new NotificationClassificationError("too_many_mentions");
  }

  let message: {
    role: "user" | "assistant" | "tool" | "system";
    content: string | null;
    replyToMessageId: number | null;
    transcriptOrigin: "main" | "subagent";
    metadata: Record<string, unknown> | null;
    roomId: string | null;
    sessionOwnerId: string;
    roomKind: string | null;
  } | undefined;
  if (input.protectedProjection === undefined) {
    const [legacyMessage] = await tx
      .select({
        role: sessionMessages.role,
        content: sessionMessages.content,
        replyToMessageId: sessionMessages.replyToMessageId,
        transcriptOrigin: sessionMessages.transcriptOrigin,
        metadata: sessionMessages.metadata,
        roomId: sessions.roomId,
        sessionOwnerId: sessions.ownerId,
        roomKind: rooms.kind,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .leftJoin(rooms, eq(sessions.roomId, rooms.id))
      .where(eq(sessionMessages.id, input.messageId))
      .limit(1);
    if (legacyMessage !== undefined) {
      message = {
        ...legacyMessage,
        role: legacyMessage.role as
          | "user"
          | "assistant"
          | "tool"
          | "system",
        transcriptOrigin:
          legacyMessage.transcriptOrigin === "subagent"
            ? "subagent"
            : "main",
        metadata: legacyMessage.metadata,
      };
    }
  } else {
    const [protectedMessage] = await tx
      .select({
        roomId: sessions.roomId,
        sessionOwnerId: sessions.ownerId,
        roomKind: rooms.kind,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .leftJoin(rooms, eq(sessions.roomId, rooms.id))
      .where(eq(sessionMessages.id, input.messageId))
      .limit(1);
    if (protectedMessage !== undefined) {
      message = {
        ...protectedMessage,
        role: input.protectedProjection.role,
        content: null,
        replyToMessageId: input.protectedProjection.replyToMessageId,
        transcriptOrigin: input.protectedProjection.transcriptOrigin,
        metadata: null,
      };
    }
  }

  if (!message?.roomId || !message.roomKind) return false;
  const role = message.role;
  const transcriptOrigin = message.transcriptOrigin;
  const replyToMessageId = message.replyToMessageId;
  if (!isNotificationClassificationEligible({
    role,
    content: message.content,
    transcriptOrigin,
    metadata: message.metadata,
    ...(input.protectedProjection
      ? { protectedProjection: input.protectedProjection }
      : {}),
  })) return false;

  const roster = await tx
    .select({
      actorId: actors.id,
      kind: actors.kind,
      userId: actors.ownerId,
    })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(eq(roomMembers.roomId, message.roomId));

  const currentHumanMembers = new Set(
    roster
      .filter(
        (member): member is typeof member & { userId: string } =>
          member.kind === "user" && typeof member.userId === "string",
      )
      .map((member) => member.userId),
  );
  if (
    mentionedHumanUserIds.some(
      (recipientId) => !currentHumanMembers.has(recipientId),
    )
  ) {
    throw new NotificationClassificationError("invalid_mention_recipient");
  }

  const directedFacts: DirectedFact[] = [];
  const participationFacts: ParticipationFact[] = [];
  const currentHumanAuthorId =
    role === "user" ? message.sessionOwnerId : null;
  const addDirected = (
    recipientId: string,
    reason: DirectedRecipientReason,
  ): void => {
    if (recipientId === currentHumanAuthorId) return;
    directedFacts.push({ recipientId, reason });
  };

  if (roster.length === 2) {
    for (const recipientId of currentHumanMembers) {
      addDirected(recipientId, "direct_room");
    }
  }

  for (const recipientId of mentionedHumanUserIds) {
    addDirected(recipientId, "mention");
    if (recipientId !== currentHumanAuthorId) {
      participationFacts.push({ userId: recipientId, reason: "mention" });
    }
  }

  let explicitReplyHumanUserId: string | null = null;
  if (replyToMessageId !== null) {
    const [replyTarget] = await tx
      .select({
        ownerId: sessions.ownerId,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .where(
        and(
          eq(sessionMessages.id, replyToMessageId),
          eq(sessionMessages.role, "user"),
          eq(sessionMessages.transcriptOrigin, "main"),
          eq(sessions.roomId, message.roomId),
          ...(input.protectedProjection === undefined
            ? [
              sql`(${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'task' AND (${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'`,
            ]
            : [protectedOrLegacyEligibleHumanTarget()]),
        ),
      )
      .limit(1);
    explicitReplyHumanUserId = replyTarget?.ownerId ?? null;
    if (explicitReplyHumanUserId) {
      addDirected(explicitReplyHumanUserId, "explicit_reply");
      if (explicitReplyHumanUserId !== currentHumanAuthorId) {
        participationFacts.push({
          userId: explicitReplyHumanUserId,
          reason: "explicit_reply",
        });
      }
    }
  }

  const hasCausalUser = input.context.causalHumanUserId !== null;
  const hasCausalTurn = input.context.causalHumanTurnId !== null;
  if (hasCausalUser !== hasCausalTurn) {
    throw new NotificationClassificationError("half_null_causal_pair");
  }
  if (role !== "assistant" && (hasCausalUser || hasCausalTurn)) {
    throw new NotificationClassificationError(
      "causal_pair_on_non_assistant",
    );
  }
  if (
    role === "assistant" &&
    input.context.causalHumanUserId &&
    input.context.causalHumanTurnId
  ) {
    const [causalTurn] = await tx
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .where(
        and(
          eq(sessionMessages.role, "user"),
          eq(sessionMessages.transcriptOrigin, "main"),
          eq(
            sessionMessages.humanTurnId,
            input.context.causalHumanTurnId,
          ),
          eq(sessions.ownerId, input.context.causalHumanUserId),
          eq(sessions.roomId, message.roomId),
          ...(input.protectedProjection === undefined
            ? [
              sql`(${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'task' AND (${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'`,
            ]
            : [protectedOrLegacyEligibleHumanTarget()]),
        ),
      )
      .limit(1);
    if (!causalTurn) {
      throw new NotificationClassificationError("invalid_causal_pair");
    }
    addDirected(input.context.causalHumanUserId, "agent_response");
  }

  if (message.roomKind === "subthread") {
    if (currentHumanAuthorId) {
      participationFacts.unshift({
        userId: currentHumanAuthorId,
        reason: "posted",
      });
    }
  } else {
    participationFacts.length = 0;
  }

  const distinctDirected = [
    ...new Map(
      directedFacts.map((fact) => [
        `${fact.recipientId}:${fact.reason}`,
        fact,
      ]),
    ).values(),
  ];
  if (distinctDirected.length > 0) {
    await tx
      .insert(sessionMessageDirectedRecipients)
      .values(
        distinctDirected.map((fact) => ({
          messageId: input.messageId,
          ...fact,
        })),
      )
      .onConflictDoNothing();
  }

  for (const fact of participationFacts) {
    await tx
      .insert(subthreadNotificationParticipants)
      .values({
        subthreadRoomId: message.roomId,
        userId: fact.userId,
        fromMessageId: input.messageId,
        reason: fact.reason,
      })
      .onConflictDoNothing();
  }

  return true;
}
