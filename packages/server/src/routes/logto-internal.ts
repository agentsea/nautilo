import type { FastifyInstance, FastifyRequest } from "fastify";
import { passwordRecoveryUsesOssRelay } from "@nautilo/config";
import {
  receiveLogtoHttpEmailWebhook,
  requestHasLogtoHttpEmailWebhookSecret,
} from "../lib/logto-http-email-webhook";
import type { SecurityAuditEvent } from "../lib/security-audit-log";

export interface LogtoInternalRouteDeps {
  /** M120 — JSONL security-audit sink. Omitted in tests / non-audited contexts. */
  auditEvent?: ((event: SecurityAuditEvent) => void | Promise<void>) | undefined;
}

export function logtoInternalRoutes(
  app: FastifyInstance,
  deps: LogtoInternalRouteDeps = {},
) {
  app.post("/api/internal/logto/email-webhook", async (request, reply) => {
    if (!passwordRecoveryUsesOssRelay()) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!hasWebhookSecret(request)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const result = receiveLogtoHttpEmailWebhook(request.body);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }

    // M120 spec: a delivered ForgotPassword code that matched no pending
    // recovery session is discarded; record only a redacted warning (never
    // the code itself). This is the sole forensic trace of an unmatched code.
    if (!result.bound) {
      void deps.auditEvent?.({
        kind: "recovery_relay_code_unmatched",
        ts: new Date().toISOString(),
        actorId: null,
        ip: request.ip,
        userAgent: requestUserAgentOf(request),
      });
    }

    // Deliberately no verification code, and no `bound` oracle, in the
    // response or logs. The relayed code is only readable through the
    // session-token-authenticated relay endpoint.
    return reply.code(202).send({ ok: true, ...result.redacted });
  });
}

function requestUserAgentOf(request: FastifyRequest): string | undefined {
  const ua = request.headers["user-agent"];
  return typeof ua === "string" ? ua : undefined;
}

function hasWebhookSecret(request: FastifyRequest): boolean {
  const authorization = request.headers.authorization;
  return requestHasLogtoHttpEmailWebhookSecret(
    typeof authorization === "string" ? authorization : undefined,
  );
}
