import type { FastifyInstance, FastifyReply } from "fastify";
import { getSharedDirectDb, type DirectDatabase } from "@nautilo/db";
import {
  CAP_MODERATE_CONTENT_REPORTS,
  isUuidString,
  MessageDeleteError,
  userHasCapability,
} from "@nautilo/trust";
import {
  contentReportAdminActionSchema,
  contentReportListQuerySchema,
  createContentReportRequestSchema,
} from "@nautilo/types";

import {
  closeContentReport,
  ContentReportError,
  createContentReport,
  getContentReport,
  listContentReports,
} from "../lib/content-reports";
import { deleteMessageWithConvergence } from "../messaging/message-deletion";

export type ContentReportRoutesDeps = Readonly<{
  db?: DirectDatabase;
  hasCapability?: typeof userHasCapability;
  deleteMessage?: typeof deleteMessageWithConvergence;
  createReport?: typeof createContentReport;
  listReports?: typeof listContentReports;
  getReport?: typeof getContentReport;
  closeReport?: typeof closeContentReport;
}>;

function sendContentReportError(error: unknown, reply: FastifyReply) {
  if (error instanceof ContentReportError) {
    switch (error.reason) {
      case "not_found":
        return reply.code(404).send({ error: "content_report_target_not_found" });
      case "forbidden":
        return reply.code(403).send({ error: "forbidden" });
      case "self_report":
        return reply.code(400).send({ error: "content_report_self_target" });
      case "unsupported_target":
        return reply.code(400).send({ error: "content_report_target_unsupported" });
      case "idempotency_conflict":
        return reply.code(409).send({ error: "content_report_id_conflict" });
    }
  }
  throw error;
}

export function contentReportRoutes(
  app: FastifyInstance,
  deps: ContentReportRoutesDeps = {},
): void {
  const db = deps.db ?? getSharedDirectDb();
  const hasCapability = deps.hasCapability ?? userHasCapability;
  const deleteMessage = deps.deleteMessage ?? deleteMessageWithConvergence;
  const createReport = deps.createReport ?? createContentReport;
  const listReports = deps.listReports ?? listContentReports;
  const getReport = deps.getReport ?? getContentReport;
  const closeReport = deps.closeReport ?? closeContentReport;

  async function requireModerator(userId: string): Promise<boolean> {
    return hasCapability(userId, CAP_MODERATE_CONTENT_REPORTS);
  }

  app.post("/api/content-reports", async (request, reply) => {
    const callerUserId = request.sessionUserId;
    if (!callerUserId) return reply.code(401).send({ error: "Unauthorized" });
    const parsed = createContentReportRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_content_report" });
    }
    try {
      return reply.code(201).send(await createReport(db, callerUserId, parsed.data));
    } catch (error) {
      return sendContentReportError(error, reply);
    }
  });

  app.get("/api/admin/content-reports", async (request, reply) => {
    const callerUserId = request.sessionUserId;
    if (!callerUserId) return reply.code(401).send({ error: "Unauthorized" });
    if (!(await requireModerator(callerUserId))) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const parsed = contentReportListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_content_report_query" });
    }
    try {
      return reply.send(await listReports(db, parsed.data));
    } catch (error) {
      if (error instanceof TypeError && error.message === "invalid_content_report_cursor") {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { reportId: string } }>(
    "/api/admin/content-reports/:reportId/actions",
    async (request, reply) => {
      const callerUserId = request.sessionUserId;
      if (!callerUserId) return reply.code(401).send({ error: "Unauthorized" });
      if (!(await requireModerator(callerUserId))) {
        return reply.code(403).send({ error: "forbidden" });
      }
      if (!isUuidString(request.params.reportId)) {
        return reply.code(404).send({ error: "content_report_not_found" });
      }
      const parsed = contentReportAdminActionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_content_report_action" });
      }
      try {
        const report = await getReport(db, request.params.reportId);
        if (!report) return reply.code(404).send({ error: "content_report_not_found" });
        if (report.status === "closed") {
          return reply.send({ reportId: report.id, status: "closed" });
        }
        if (parsed.data.action === "delete_message_and_close") {
          if (report.targetType !== "message" || report.targetMessageId === null) {
            return reply.code(400).send({ error: "content_report_target_not_message" });
          }
          await deleteMessage({
            roomId: report.roomId,
            messageId: report.targetMessageId,
            logContext: "content report",
          });
        }
        const closed = await closeReport(db, report.id, callerUserId);
        return reply.send({ reportId: closed.id, status: "closed" });
      } catch (error) {
        if (error instanceof MessageDeleteError) {
          if (error.reason === "message_anchors_thread") {
            return reply.code(409).send({ error: "message_anchors_thread" });
          }
          return reply.code(404).send({ error: "reported_message_not_found" });
        }
        return sendContentReportError(error, reply);
      }
    },
  );
}
