import { requestExport, cancelExport } from "../jobs/exports.js";
import { exportStatus, downloadExport } from "../jobs/downloads.js";
import { requestPublication } from "../jobs/publisher.js";
import { createUpload, putUpload } from "../uploads/tickets.js";
import { completeUpload } from "../uploads/complete.js";

export function workRoutes(ctx, route) {
  route("POST", "/projects/:projectId/exports", (actor, p, body) => requestExport(ctx, actor, p.projectId, body));
  route("GET", "/exports/:jobId", (actor, p) => exportStatus(ctx, actor, p.jobId));
  route("GET", "/exports/:jobId/download", (actor, p) => downloadExport(ctx, actor, p.jobId));
  route("DELETE", "/exports/:jobId", (actor, p) => cancelExport(ctx, actor, p.jobId));
  route("POST", "/projects/:projectId/publications", (actor, p, body) => requestPublication(ctx, actor, p.projectId, body));
  route("POST", "/projects/:projectId/uploads", (actor, p, body) => createUpload(ctx, actor, p.projectId, body));
  route("PUT", "/uploads/:ticketId", (actor, p, body) => putUpload(ctx, actor, p.ticketId, body));
  route("POST", "/projects/:projectId/uploads/:ticketId/complete", (actor, p, body) => completeUpload(ctx, actor, p.projectId, p.ticketId, body));
}
