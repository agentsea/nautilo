import {
  dualTaskPreparedCreateRequestV1Schema,
  dualTaskPreparedUpdateRequestV1Schema,
  protectedTaskDefinitionReadEnvelopeV1Schema,
  protectedTaskPreparedCreateRequestV1Schema,
  protectedTaskPreparedUpdateRequestV1Schema,
  protectedTaskPublicationPlanRequestV1Schema,
  protectedTaskPublicationPlanV1Schema,
  protectedTaskContentListV1Schema,
  taskContentSummaryV1Schema,
} from "@nautilo/api-client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ProtectedTaskRouteError,
  resolveProtectedTaskComposition,
  type ProtectedTaskComposition,
  type ProtectedTaskRouteAuthority,
} from "./task-protected-composition";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

function invalid(reply: FastifyReply) {
  return reply.code(400).send({ error: "Exact protected Task request required" });
}

async function protectedOperation<Value>(
  reply: FastifyReply,
  operation: () => Promise<Value>,
): Promise<Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false }>> {
  try {
    return Object.freeze({ ok: true as const, value: await operation() });
  } catch (error) {
    if (!(error instanceof ProtectedTaskRouteError)) throw error;
    reply.code(error.statusCode).send({ error: error.code, message: error.message });
    return Object.freeze({ ok: false as const });
  }
}

function counter(value: unknown, minimum: number): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

/** Exact protected Task transport for branded test or production composition. */
export function protectedTaskRoutes(app: FastifyInstance, input: Readonly<{
  composition: ProtectedTaskComposition;
  resolveAuthorizedRequest(
    request: FastifyRequest,
  ): Promise<ProtectedTaskRouteAuthority | null>;
}>): void {
  const resolve = async (request: FastifyRequest) => {
    const authority = await input.resolveAuthorizedRequest(request);
    if (authority === null) return null;
    const ports = resolveProtectedTaskComposition({
      composition: input.composition,
      authority,
    });
    return ports === null ? null : Object.freeze({ authority, ports });
  };
  const privateRead = (reply: FastifyReply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Vary", "Authorization");
  };

  app.get("/api/protected/tasks", async (request, reply) => {
    privateRead(reply);
    const parsed = z.object({
      status: z.string().optional(),
      includeTerminal: z.enum(["true", "false"]).optional(),
      recentTerminalLimit: z.coerce.number().int().nonnegative().safe().optional(),
    }).strict().safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const attempted = await protectedOperation(reply, () => authorized.ports.list({
      authority: authorized.authority,
      query: {
        ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
        ...(parsed.data.includeTerminal === undefined
          ? {} : { includeTerminal: parsed.data.includeTerminal === "true" }),
        ...(parsed.data.recentTerminalLimit === undefined
          ? {} : { recentTerminalLimit: parsed.data.recentTerminalLimit }),
      },
    }));
    if (!attempted.ok) return;
    const result = attempted.value;
    const projected = protectedTaskContentListV1Schema.safeParse(result);
    if (!projected.success) {
      throw new TypeError("Protected Task list returned non-protected content");
    }
    return reply.send(projected.data);
  });

  app.get("/api/protected/tasks/:taskId/definition", async (
    request: FastifyRequest<{
      Params: { taskId: string };
      Querystring: Record<string, unknown>;
    }>,
    reply,
  ) => {
    privateRead(reply);
    const fields = Object.keys(request.query);
    const objectId = request.query["objectId"];
    const contentRevision = counter(request.query["contentRevision"], 1);
    const cryptoAccessRevision = counter(request.query["cryptoAccessRevision"], 0);
    if (
      !UUID.test(request.params.taskId)
      || fields.length !== 3
      || fields.some((field) => ![
        "objectId", "contentRevision", "cryptoAccessRevision",
      ].includes(field))
      || typeof objectId !== "string"
      || !PORTABLE_ID.test(objectId)
      || contentRevision === null
      || cryptoAccessRevision === null
    ) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    if (cryptoAccessRevision !== 0) {
      return reply.send(protectedTaskDefinitionReadEnvelopeV1Schema.parse({
        readVersion: 1,
        status: "unavailable",
        taskId: request.params.taskId,
        objectId,
        contentRevision,
        cryptoAccessRevision,
        reason: "unsupported_crypto_access_revision",
      }));
    }
    const attempted = await protectedOperation(reply, () => authorized.ports.readDefinition({
      authority: authorized.authority,
      taskId: request.params.taskId,
      objectId,
      contentRevision,
      cryptoAccessRevision,
    }));
    if (!attempted.ok) return;
    const result = attempted.value;
    if (
      result.taskId !== request.params.taskId
      || result.objectId !== objectId
      || result.contentRevision !== contentRevision
      || result.cryptoAccessRevision !== cryptoAccessRevision
    ) throw new TypeError("Protected Task definition read was substituted");
    const projected = protectedTaskDefinitionReadEnvelopeV1Schema.safeParse(result);
    if (!projected.success || projected.data.status !== "ready") {
      throw new TypeError("Protected Task definition read is invalid");
    }
    return reply.send(projected.data);
  });

  const plan = async (
    request: FastifyRequest,
    reply: FastifyReply,
    taskId: string | null,
  ) => {
    const parsed = protectedTaskPublicationPlanRequestV1Schema.safeParse(request.body);
    if (!parsed.success
      || (taskId === null ? parsed.data.operation !== "create"
        : parsed.data.operation !== "update" || !UUID.test(taskId))) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const attempted = await protectedOperation(reply, () => authorized.ports.plan({
        authority: authorized.authority,
        taskId,
        request: parsed.data,
      }));
    if (!attempted.ok) return;
    const result = protectedTaskPublicationPlanV1Schema.parse(attempted.value);
    if (
      result.operation !== parsed.data.operation
      || result.operationId !== parsed.data.operationId
      || (taskId !== null && result.taskId !== taskId)
    ) throw new TypeError("Protected Task publication plan was substituted");
    return reply.send(result);
  };

  app.post("/api/protected/tasks/publication-plan", (request, reply) =>
    plan(request, reply, null));
  app.post("/api/protected/tasks/:taskId/publication-plan", (
    request: FastifyRequest<{ Params: { taskId: string } }>, reply,
  ) => plan(request, reply, request.params.taskId));

  app.post("/api/protected/tasks/publication", async (request, reply) => {
    const parsed = z.union([
      protectedTaskPreparedCreateRequestV1Schema,
      dualTaskPreparedCreateRequestV1Schema,
    ]).safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const attempted = await protectedOperation(reply, () => authorized.ports.publishCreate({
      authority: authorized.authority,
      prepared: parsed.data,
    }));
    if (!attempted.ok) return;
    const result = attempted.value;
    if (result.taskId !== parsed.data.taskId) {
      throw new TypeError("Protected Task creation receipt was substituted");
    }
    return reply.code(201).send(result);
  });

  app.patch("/api/protected/tasks/:taskId/publication", async (
    request: FastifyRequest<{ Params: { taskId: string } }>, reply,
  ) => {
    const parsed = z.union([
      protectedTaskPreparedUpdateRequestV1Schema,
      dualTaskPreparedUpdateRequestV1Schema,
    ]).safeParse(request.body);
    if (!UUID.test(request.params.taskId)
      || !parsed.success
      || parsed.data.taskId !== request.params.taskId) return invalid(reply);
    const authorized = await resolve(request);
    if (authorized === null) return reply.code(403).send({ error: "Forbidden" });
    const attempted = await protectedOperation(reply, () => authorized.ports.publishUpdate({
        authority: authorized.authority,
        taskId: request.params.taskId,
        prepared: parsed.data,
      }));
    if (!attempted.ok) return;
    const result = taskContentSummaryV1Schema.parse(attempted.value);
    if (
      result.id !== request.params.taskId
      || result.content.status !== "protected"
      || result.content.contentRevision !== parsed.data.nextContentRevision
    ) throw new TypeError("Protected Task update receipt was substituted");
    return reply.send(result);
  });
}
