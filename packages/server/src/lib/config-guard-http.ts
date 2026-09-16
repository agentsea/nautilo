import type { FastifyReply } from "fastify";
import { error as logError } from "@nautilo/logger";
import { ConfigGuardError } from "@nautilo/config-guard";

/**
 * Maps config-guard failures to HTTP responses. Always logs the real message;
 * the client gets a stable code plus a message that is safe to show on localhost setup UIs.
 */
export function replyForConfigGuardError(reply: FastifyReply, err: ConfigGuardError): FastifyReply {
  logError("[config-guard]", err.code, err.message);

  switch (err.code) {
    case "VALIDATION":
      return reply.code(400).send({ error: err.message, code: err.code });
    case "RATE_LIMIT":
      return reply.code(429).send({ error: err.message, code: err.code });
    case "IO":
      return reply.code(500).send({
        error: "Could not write configuration files. Check disk space, permissions, and server logs.",
        code: err.code,
      });
    case "HEALTH":
      return reply.code(503).send({
        error: err.message,
        code: err.code,
      });
    default:
      logError("[config-guard] unmapped error code", err.code);
      return reply.code(500).send({
        error: "Unexpected configuration error.",
        code: err.code,
      });
  }
}
