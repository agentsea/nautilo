import { describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import type { ContentReport, DirectDatabase } from "@nautilo/db";
import { MessageDeleteError } from "@nautilo/trust";
import type { CreateContentReportRequest } from "@nautilo/types";

import { contentReportRoutes } from "../../src/routes/content-reports";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";
const REPORTER_ID = "33333333-3333-4333-8333-333333333333";
const MODERATOR_ID = "44444444-4444-4444-8444-444444444444";

function reportFixture(overrides: Partial<ContentReport> = {}): ContentReport {
  return {
    id: REPORT_ID,
    reporterUserId: REPORTER_ID,
    roomId: ROOM_ID,
    targetType: "message",
    targetMessageId: 42,
    targetUserId: null,
    reason: "spam_scam",
    comment: null,
    previewText: "Reported message",
    previewDisplayName: null,
    previewHandle: null,
    previewAttachments: [],
    status: "open",
    createdAt: new Date("2026-08-27T10:00:00.000Z"),
    closedByUserId: null,
    closedAt: null,
    ...overrides,
  };
}

function buildApp(options: {
  moderator?: boolean;
  report?: ContentReport;
  deleteFailure?: Error;
  priorDeletion?: boolean;
} = {}) {
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const value = request.headers["x-test-user"];
    request.sessionUserId = typeof value === "string" ? value : null;
  });
  const createReport = mock(async (
    _db: DirectDatabase,
    _reporterUserId: string,
    _input: CreateContentReportRequest,
  ) => ({
    id: REPORT_ID,
    receivedAt: "2026-08-27T10:00:00.000Z",
  }));
  const listReports = mock(async () => ({ reports: [], nextCursor: null }));
  const getReport = mock(async () => options.report ?? reportFixture());
  const closeReport = mock(async () => reportFixture({
    status: "closed",
    closedByUserId: MODERATOR_ID,
    closedAt: new Date("2026-08-27T10:01:00.000Z"),
  }));
  const deleteMessage = mock(async (_input: {
    roomId: string;
    messageId: number;
    actorUserId: string;
    actorId: string | null;
    source: "room_message" | "content_report";
    authority: string;
    reportId?: string;
    logContext?: string;
  }) => {
    if (options.deleteFailure) throw options.deleteFailure;
  });
  contentReportRoutes(app, {
    db: {} as DirectDatabase,
    hasCapability: async (_userId, slug) =>
      options.moderator === true && slug === "moderate_content_reports",
    createReport,
    listReports,
    getReport,
    closeReport,
    deleteMessage,
    findDeletionReceipt: async () => options.priorDeletion
      ? { source: "content_report", reportId: REPORT_ID } as Awaited<ReturnType<typeof import("../../src/lib/message-deletion-receipts").findMessageDeletionReceiptByReportId>>
      : null,
  });
  return { app, createReport, listReports, getReport, closeReport, deleteMessage };
}

describe("content report routes", () => {
  test("requires authentication and validates report submission before persistence", async () => {
    const { app, createReport } = buildApp();
    expect((await app.inject({ method: "POST", url: "/api/content-reports", payload: {} })).statusCode).toBe(401);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/content-reports",
      headers: { "x-test-user": REPORTER_ID },
      payload: { id: REPORT_ID },
    });
    expect(invalid.statusCode).toBe(400);
    expect(createReport).not.toHaveBeenCalled();
  });

  test("accepts a bounded message report with a caller-supplied idempotency id", async () => {
    const { app, createReport } = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/content-reports",
      headers: { "x-test-user": REPORTER_ID },
      payload: {
        id: REPORT_ID,
        target: { type: "message", roomId: ROOM_ID, messageId: 42 },
        reason: "spam_scam",
        comment: "Repeated scam links",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(createReport).toHaveBeenCalledTimes(1);
    expect(createReport.mock.calls[0]?.[1]).toBe(REPORTER_ID);
    expect(createReport.mock.calls[0]?.[2]).toMatchObject({ id: REPORT_ID, reason: "spam_scam" });
  });

  test("uses moderate_content_reports as the sole admin queue gate", async () => {
    const unauthorized = buildApp();
    expect((await unauthorized.app.inject({
      method: "GET",
      url: "/api/admin/content-reports",
      headers: { "x-test-user": MODERATOR_ID },
    })).statusCode).toBe(403);

    const authorized = buildApp({ moderator: true });
    expect((await authorized.app.inject({
      method: "GET",
      url: "/api/admin/content-reports?status=open&limit=25",
      headers: { "x-test-user": MODERATOR_ID },
    })).statusCode).toBe(200);
    expect(authorized.listReports).toHaveBeenCalledTimes(1);
  });

  test("deletes through canonical convergence before closing", async () => {
    const { app, deleteMessage, closeReport } = buildApp({ moderator: true });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/content-reports/${REPORT_ID}/actions`,
      headers: { "x-test-user": MODERATOR_ID },
      payload: { action: "delete_message_and_close" },
    });
    expect(response.statusCode).toBe(200);
    expect(deleteMessage.mock.calls[0]?.[0]).toMatchObject({ roomId: ROOM_ID, messageId: 42 });
    expect(deleteMessage.mock.calls[0]?.[0]).toMatchObject({
      actorUserId: MODERATOR_ID,
      source: "content_report",
      authority: "report_action",
      reportId: REPORT_ID,
    });
    expect(closeReport).toHaveBeenCalledTimes(1);
  });

  test("leaves the report open when canonical deletion refuses a thread anchor", async () => {
    const { app, closeReport } = buildApp({
      moderator: true,
      deleteFailure: new MessageDeleteError("message_anchors_thread"),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/content-reports/${REPORT_ID}/actions`,
      headers: { "x-test-user": MODERATOR_ID },
      payload: { action: "delete_message_and_close" },
    });
    expect(response.statusCode).toBe(409);
    expect(closeReport).not.toHaveBeenCalled();
  });

  test("closes a report on retry when a prior delete already committed", async () => {
    const { app, closeReport } = buildApp({
      moderator: true,
      priorDeletion: true,
      deleteFailure: new MessageDeleteError("not_found"),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/content-reports/${REPORT_ID}/actions`,
      headers: { "x-test-user": MODERATOR_ID },
      payload: { action: "delete_message_and_close" },
    });
    expect(response.statusCode).toBe(200);
    expect(closeReport).toHaveBeenCalledTimes(1);
  });

  test("returns an already-closed report idempotently without repeating actions", async () => {
    const { app, deleteMessage, closeReport } = buildApp({
      moderator: true,
      report: reportFixture({
        status: "closed",
        closedByUserId: MODERATOR_ID,
        closedAt: new Date("2026-08-27T10:01:00.000Z"),
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/content-reports/${REPORT_ID}/actions`,
      headers: { "x-test-user": MODERATOR_ID },
      payload: { action: "delete_message_and_close" },
    });
    expect(response.statusCode).toBe(200);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(closeReport).not.toHaveBeenCalled();
  });
});
