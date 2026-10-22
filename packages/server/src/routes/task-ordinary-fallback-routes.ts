import {
  taskContentSummaryV1Schema,
  taskOrdinaryFallbackCreatePlanV1Schema,
  taskOrdinaryFallbackUpdatePlanV1Schema,
  taskOrdinaryFallbackPlanCreateRequestV1Schema,
  taskOrdinaryFallbackPlanUpdateRequestV1Schema,
  taskOrdinaryFallbackPreparedCreateRequestV1Schema,
  taskOrdinaryFallbackPreparedUpdateRequestV1Schema,
} from "@nautilo/api-client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { LATTICE_LIMITS } from "@nautilo/lattice-crypto/wire-limits";
import { ProtectedTaskRouteError, type ProtectedTaskRouteAuthority } from "./task-protected-composition";
import type { TaskOrdinaryFallbackPorts } from "./task-ordinary-fallback-composition";
import { liveShadowLargeRequestRouteOptions } from "./live-shadow-request-boundary";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumId = "x".repeat(LATTICE_LIMITS.idBytes);
const maximumDigest = "A".repeat(43);
const maximumUuid = "00000000-0000-4000-8000-000000000000";
const encodedBytes = (bytes: number) => Math.ceil(bytes * 4 / 3);
const planBodyBytes = JSON.stringify({
  requestVersion: 1, operationId: maximumId, task: {},
}).length - JSON.stringify({}).length + LATTICE_LIMITS.plaintextBytes;
const publicationBodyBytes = JSON.stringify({
  requestVersion: 1,
  representation: "ordinary_fallback",
  operationId: maximumId,
  taskId: maximumUuid,
  authenticatedRequestDigestBase64url: maximumDigest,
  ordinaryPayloadBytesBase64url: "",
  signedOrdinaryFallbackRequestBytesBase64url: "",
  task: {},
}).length - JSON.stringify({}).length + LATTICE_LIMITS.plaintextBytes
  + 2 * encodedBytes(LATTICE_LIMITS.plaintextBytes);
const planRouteOptions = Object.freeze({
  ...liveShadowLargeRequestRouteOptions,
  bodyLimit: planBodyBytes,
});
const publicationRouteOptions = Object.freeze({
  ...liveShadowLargeRequestRouteOptions,
  bodyLimit: publicationBodyBytes,
});

export function taskOrdinaryFallbackRoutes(app: FastifyInstance, input: Readonly<{
  ports: TaskOrdinaryFallbackPorts;
  resolveAuthorizedRequest(request: FastifyRequest): Promise<ProtectedTaskRouteAuthority | null>;
}>): void {
  const run = async <Value>(request: FastifyRequest, reply: FastifyReply,
    use: (authority: ProtectedTaskRouteAuthority) => Promise<Value>): Promise<
      Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false }>
    > => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Vary", "Authorization");
    const authority = await input.resolveAuthorizedRequest(request);
    if (authority === null) {
      reply.code(403).send({ error: "Forbidden" });
      return { ok: false };
    }
    try { return { ok: true, value: await use(authority) }; }
    catch (error) {
      if (!(error instanceof ProtectedTaskRouteError)) throw error;
      reply.code(error.statusCode).send({ error: error.code, message: error.message });
      return { ok: false };
    }
  };
  const invalid = (reply: FastifyReply) => reply.code(400).send({ error: "Exact Task fallback request required" });
  app.post("/api/protected/tasks/ordinary-fallback-plan", planRouteOptions, async (request, reply) => {
    const parsed = taskOrdinaryFallbackPlanCreateRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const attempted = await run(request, reply, async authority => taskOrdinaryFallbackCreatePlanV1Schema.parse(
      await input.ports.planCreate({ authority, request: parsed.data }),
    ));
    if (!attempted.ok) return;
    return reply.send(attempted.value);
  });
  app.post("/api/protected/tasks/:taskId/ordinary-fallback-plan", planRouteOptions, async (
    request: FastifyRequest<{ Params: { taskId: string } }>, reply,
  ) => {
    const parsed = taskOrdinaryFallbackPlanUpdateRequestV1Schema.safeParse(request.body);
    if (!UUID.test(request.params.taskId) || !parsed.success) return invalid(reply);
    const attempted = await run(request, reply, async authority => taskOrdinaryFallbackUpdatePlanV1Schema.parse(
      await input.ports.planUpdate({ authority, taskId: request.params.taskId, request: parsed.data }),
    ));
    if (!attempted.ok) return;
    return reply.send(attempted.value);
  });
  app.post("/api/protected/tasks/ordinary-fallback", publicationRouteOptions, async (request, reply) => {
    const parsed = taskOrdinaryFallbackPreparedCreateRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const attempted = await run(request, reply, async authority => {
      const result = await input.ports.publishCreate({ authority, prepared: parsed.data });
      if (result.taskId !== parsed.data.taskId) throw new TypeError("Task fallback receipt was substituted");
      reply.code(201);
      return result;
    });
    if (!attempted.ok) return;
    return reply.send(attempted.value);
  });
  app.patch("/api/protected/tasks/:taskId/ordinary-fallback", publicationRouteOptions, async (
    request: FastifyRequest<{ Params: { taskId: string } }>, reply,
  ) => {
    const parsed = taskOrdinaryFallbackPreparedUpdateRequestV1Schema.safeParse(request.body);
    if (!UUID.test(request.params.taskId) || !parsed.success || parsed.data.taskId !== request.params.taskId) return invalid(reply);
    const attempted = await run(request, reply, async authority => taskContentSummaryV1Schema.parse(
      await input.ports.publishUpdate({ authority, taskId: request.params.taskId, prepared: parsed.data }),
    ));
    if (!attempted.ok) return;
    return reply.send(attempted.value);
  });
}
