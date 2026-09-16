/**
 * D420 (Wave 2 task 2.2.1) — HTTP rendering of the typed maintenance rejection.
 *
 * The runtime gate throws {@link MaintenanceDrainError} when NEW executable
 * work is refused during an active durable maintenance state. This module
 * renders that error as a 503 {@link MaintenanceRejectionResponse} so every
 * ingress (chat dispatch, `POST /api/jobs`, the legacy `/api/chat` alias)
 * returns the SAME machine-readable, retryable body — a client polls on
 * `code === "maintenance_draining"` and `retryable === true` and re-sends
 * once the server clears maintenance. The work was never persisted/accepted,
 * so the retry is idempotent at the ingress layer.
 */
import type { FastifyReply } from "fastify";
import { MaintenanceDrainError } from "@nautilo/runtime";
import type { MaintenanceRejectionResponse } from "@nautilo/types";

/** Type guard for the typed maintenance rejection. */
export function isMaintenanceDrainError(err: unknown): err is MaintenanceDrainError {
  return err instanceof MaintenanceDrainError;
}

/** Build the canonical retryable rejection body from a typed error. */
function maintenanceRejectionBody(err: MaintenanceDrainError): MaintenanceRejectionResponse {
  return {
    error: "maintenance_draining",
    code: "maintenance_draining",
    message: err.message,
    retryable: true,
    maintenanceState: err.maintenanceState,
  };
}

/** Send a 503 typed retryable rejection from a {@link MaintenanceDrainError}. */
export function replyMaintenanceRejection(
  reply: FastifyReply,
  err: MaintenanceDrainError,
): void {
  reply.code(503).send(maintenanceRejectionBody(err));
}
