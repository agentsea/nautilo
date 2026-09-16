import {
  actors,
  and,
  contentReports,
  desc,
  eq,
  inArray,
  lt,
  messageAttachments,
  or,
  roomMembers,
  sessionMessages,
  sessions,
  users,
  type ContentReport,
  type DirectDatabase,
} from "@nautilo/db";
import type {
  ContentReportDto,
  ContentReportListResponse,
  CreateContentReportRequest,
  CreateContentReportResponse,
} from "@nautilo/types";

export type ContentReportFailureReason =
  | "not_found"
  | "forbidden"
  | "self_report"
  | "unsupported_target"
  | "idempotency_conflict";

export class ContentReportError extends Error {
  constructor(readonly reason: ContentReportFailureReason) {
    super(`ContentReportError:${reason}`);
    this.name = "ContentReportError";
  }
}

async function assertRoomMembership(
  db: DirectDatabase,
  roomId: string,
  userId: string,
): Promise<void> {
  const [membership] = await db
    .select({ actorId: roomMembers.actorId })
    .from(actors)
    .innerJoin(
      roomMembers,
      and(eq(roomMembers.actorId, actors.id), eq(roomMembers.roomId, roomId)),
    )
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "user")))
    .limit(1);
  if (!membership) throw new ContentReportError("not_found");
}

export async function createContentReport(
  db: DirectDatabase,
  reporterUserId: string,
  input: CreateContentReportRequest,
): Promise<CreateContentReportResponse> {
  const [existing] = await db
    .select({
      reporterUserId: contentReports.reporterUserId,
      createdAt: contentReports.createdAt,
    })
    .from(contentReports)
    .where(eq(contentReports.id, input.id))
    .limit(1);
  if (existing) {
    if (existing.reporterUserId !== reporterUserId) {
      throw new ContentReportError("idempotency_conflict");
    }
    return { id: input.id, receivedAt: existing.createdAt.toISOString() };
  }

  await assertRoomMembership(db, input.target.roomId, reporterUserId);

  let values: typeof contentReports.$inferInsert;
  if (input.target.type === "message") {
    const [message] = await db
      .select({
        id: sessionMessages.id,
        role: sessionMessages.role,
        content: sessionMessages.content,
        fingerprint: sessionMessages.fingerprint,
        roomId: sessions.roomId,
        ownerId: sessions.ownerId,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .where(
        and(
          eq(sessionMessages.id, input.target.messageId),
          eq(sessions.roomId, input.target.roomId),
        ),
      )
      .limit(1);
    if (!message) throw new ContentReportError("not_found");
    if (message.role !== "user" && message.role !== "assistant") {
      throw new ContentReportError("unsupported_target");
    }
    if (message.role === "user" && message.ownerId === reporterUserId) {
      throw new ContentReportError("self_report");
    }
    if (message.content === null) {
      throw new ContentReportError("unsupported_target");
    }

    const attachments = message.fingerprint
      ? await db
          .select({
            filename: messageAttachments.filename,
            mimeType: messageAttachments.mimeType,
            sizeBytes: messageAttachments.sizeBytes,
          })
          .from(messageAttachments)
          .where(
            and(
              eq(messageAttachments.turnId, message.fingerprint),
              eq(messageAttachments.status, "retained"),
            ),
          )
          .limit(10)
      : [];
    values = {
      id: input.id,
      reporterUserId,
      roomId: input.target.roomId,
      targetType: "message",
      targetMessageId: input.target.messageId,
      reason: input.reason,
      comment: input.comment?.trim() || null,
      previewText: message.content.slice(0, 4000),
      previewAttachments: attachments,
    };
  } else {
    if (input.target.userId === reporterUserId) {
      throw new ContentReportError("self_report");
    }
    const [target] = await db
      .select({
        userId: users.id,
        displayName: actors.displayName,
        handle: users.handle,
      })
      .from(actors)
      .innerJoin(users, eq(users.id, actors.ownerId))
      .innerJoin(
        roomMembers,
        and(
          eq(roomMembers.actorId, actors.id),
          eq(roomMembers.roomId, input.target.roomId),
        ),
      )
      .where(
        and(
          eq(actors.ownerId, input.target.userId),
          eq(actors.kind, "user"),
        ),
      )
      .limit(1);
    if (!target) throw new ContentReportError("not_found");
    values = {
      id: input.id,
      reporterUserId,
      roomId: input.target.roomId,
      targetType: "person",
      targetUserId: input.target.userId,
      reason: input.reason,
      comment: input.comment?.trim() || null,
      previewDisplayName: target.displayName.slice(0, 255),
      previewHandle: target.handle,
    };
  }

  const [created] = await db
    .insert(contentReports)
    .values(values)
    .onConflictDoNothing({ target: contentReports.id })
    .returning({
      id: contentReports.id,
      createdAt: contentReports.createdAt,
    });
  if (!created) {
    const [winner] = await db
      .select({
        reporterUserId: contentReports.reporterUserId,
        createdAt: contentReports.createdAt,
      })
      .from(contentReports)
      .where(eq(contentReports.id, input.id))
      .limit(1);
    if (!winner || winner.reporterUserId !== reporterUserId) {
      throw new ContentReportError("idempotency_conflict");
    }
    return { id: input.id, receivedAt: winner.createdAt.toISOString() };
  }
  return { id: created.id, receivedAt: created.createdAt.toISOString() };
}

type ReportCursor = Readonly<{ createdAt: string; id: string }>;

function encodeCursor(cursor: ReportCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): ReportCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ReportCursor).createdAt === "string" &&
      !Number.isNaN(Date.parse((parsed as ReportCursor).createdAt)) &&
      typeof (parsed as ReportCursor).id === "string"
    ) {
      return parsed as ReportCursor;
    }
  } catch {
    // Converted to a caller-safe input error below.
  }
  throw new TypeError("invalid_content_report_cursor");
}

async function loadPersonMap(
  db: DirectDatabase,
  userIds: readonly string[],
): Promise<Map<string, { userId: string; displayName: string; handle: string | null }>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: users.id, displayName: users.name, handle: users.handle })
    .from(users)
    .where(inArray(users.id, [...new Set(userIds)]));
  return new Map(rows.map((row) => [row.userId, row]));
}

async function loadSourceAvailability(
  db: DirectDatabase,
  reports: readonly ContentReport[],
): Promise<Set<string>> {
  const available = new Set<string>();
  const messageIds = reports.flatMap((report) =>
    report.targetType === "message" && report.targetMessageId !== null
      ? [report.targetMessageId]
      : [],
  );
  if (messageIds.length > 0) {
    const rows = await db
      .select({ id: sessionMessages.id, roomId: sessions.roomId })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
      .where(inArray(sessionMessages.id, messageIds));
    for (const row of rows) {
      if (row.roomId) available.add(`message:${row.roomId}:${row.id}`);
    }
  }
  const personIds = reports.flatMap((report) =>
    report.targetType === "person" && report.targetUserId !== null
      ? [report.targetUserId]
      : [],
  );
  if (personIds.length > 0) {
    const rows = await db
      .select({ userId: actors.ownerId, roomId: roomMembers.roomId })
      .from(actors)
      .innerJoin(roomMembers, eq(roomMembers.actorId, actors.id))
      .where(and(eq(actors.kind, "user"), inArray(actors.ownerId, personIds)));
    for (const row of rows) available.add(`person:${row.roomId}:${row.userId}`);
  }
  return available;
}

export async function listContentReports(
  db: DirectDatabase,
  input: {
    status: "open" | "closed";
    limit: number;
    cursor?: string | undefined;
  },
): Promise<ContentReportListResponse> {
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const where = cursor
    ? and(
        eq(contentReports.status, input.status),
        or(
          lt(contentReports.createdAt, new Date(cursor.createdAt)),
          and(
            eq(contentReports.createdAt, new Date(cursor.createdAt)),
            lt(contentReports.id, cursor.id),
          ),
        ),
      )
    : eq(contentReports.status, input.status);
  const rows = await db
    .select()
    .from(contentReports)
    .where(where)
    .orderBy(desc(contentReports.createdAt), desc(contentReports.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const people = await loadPersonMap(
    db,
    page.flatMap((report) => [report.reporterUserId, report.closedByUserId].filter(Boolean) as string[]),
  );
  const availability = await loadSourceAvailability(db, page);
  const reports: ContentReportDto[] = page.map((report) => {
    const reporter = people.get(report.reporterUserId) ?? {
      userId: report.reporterUserId,
      displayName: "Deleted Human",
      handle: null,
    };
    const closer = report.closedByUserId
      ? people.get(report.closedByUserId) ?? {
          userId: report.closedByUserId,
          displayName: "Former administrator",
          handle: null,
        }
      : null;
    const target = report.targetType === "message"
      ? { type: "message" as const, messageId: report.targetMessageId! }
      : { type: "person" as const, userId: report.targetUserId! };
    return {
      id: report.id,
      reporter,
      roomId: report.roomId,
      target,
      reason: report.reason,
      comment: report.comment,
      preview: {
        text: report.previewText,
        displayName: report.previewDisplayName,
        handle: report.previewHandle,
        attachments: report.previewAttachments,
      },
      status: report.status,
      createdAt: report.createdAt.toISOString(),
      sourceAvailable: availability.has(`${target.type}:${report.roomId}:${target.type === "message" ? target.messageId : target.userId}`),
      closedBy: closer,
      closedAt: report.closedAt?.toISOString() ?? null,
    };
  });
  const last = page.at(-1);
  return {
    reports,
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}

export async function getContentReport(
  db: DirectDatabase,
  reportId: string,
): Promise<ContentReport | null> {
  const [report] = await db
    .select()
    .from(contentReports)
    .where(eq(contentReports.id, reportId))
    .limit(1);
  return report ?? null;
}

/** Idempotent one-way close; a concurrent second close returns current state. */
export async function closeContentReport(
  db: DirectDatabase,
  reportId: string,
  administratorUserId: string,
): Promise<ContentReport> {
  const [closed] = await db
    .update(contentReports)
    .set({
      status: "closed",
      closedByUserId: administratorUserId,
      closedAt: new Date(),
    })
    .where(and(eq(contentReports.id, reportId), eq(contentReports.status, "open")))
    .returning();
  if (closed) return closed;
  const current = await getContentReport(db, reportId);
  if (!current) throw new ContentReportError("not_found");
  return current;
}
