import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  protectedMemoryAccessPlanRequestV1Schema,
  protectedMemoryAccessPlanResponseV1Schema,
  protectedMemoryAccessUpdateResponseV1Schema,
  protectedMemoryArchiveRequestV1Schema,
  protectedMemoryArchiveResponseV1Schema,
  protectedMemoryPreparedAccessRequestV1Schema,
  protectedMemoryRestoreRequestV1Schema,
  protectedMemoryRestoreResponseV1Schema,
  protectedMemoryTierTransitionRequestV1Schema,
  protectedMemoryTierTransitionResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
  protectedMemoryRepairPlanRequestV1Schema,
  protectedMemoryRepairPlanResponseV1Schema,
  protectedMemoryPreparedRepairRequestV1Schema,
  protectedMemoryRepairResponseV1Schema,
} from "@nautilo/api-client";

import {
  resolveCurrentProtectedMemoryRoutePorts,
  type ProtectedMemoryCompositionSource,
  type ProtectedMemoryRouteTarget,
} from "./protected-memory-composition";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type MemoryRequest = FastifyRequest<{ Params: { id: string } }>;

function invalid(reply: FastifyReply) {
  return reply.code(400).send({ error: "Exact protected Memory mutation required" });
}

/**
 * Exact Human metadata/access transport. Current request authority and durable
 * publication/effect receipts belong to the composition, not these handlers.
 */
export function protectedMemoryRoutes(
  app: FastifyInstance,
  input: Readonly<{
    composition: ProtectedMemoryCompositionSource;
    resolveAuthorizedRequest(
      request: FastifyRequest,
    ): Promise<ProtectedMemoryRouteTarget | null>;
  }>,
): void {
  const resolve = async (request: FastifyRequest) => {
    const authority = await input.resolveAuthorizedRequest(request);
    if (authority === null) return null;
    return resolveCurrentProtectedMemoryRoutePorts({
      composition: input.composition,
      authority,
      envelope: request.memoryEnvelope ?? null,
    });
  };

  app.post("/api/protected/memories/:id/repair-plan", async (
    request: MemoryRequest, reply,
  ) => {
    if (!UUID.test(request.params.id)
      || !protectedMemoryRepairPlanRequestV1Schema.safeParse(request.body).success) return invalid(reply);
    const resolved = await resolve(request);
    if (resolved?.ports.repair === undefined) return reply.code(403).send({ error: "Forbidden" });
    const result = protectedMemoryRepairPlanResponseV1Schema.parse(await resolved.ports.repair.plan({
      authority: resolved.authority, memoryId: request.params.id,
    }));
    if ("memoryId" in result && result.memoryId !== request.params.id) {
      throw new TypeError("Protected Memory repair plan was substituted");
    }
    return reply.send(result);
  });

  app.post("/api/protected/memories/:id/repair", async (
    request: MemoryRequest, reply,
  ) => {
    const body = protectedMemoryPreparedRepairRequestV1Schema.safeParse(request.body);
    if (!UUID.test(request.params.id) || !body.success || body.data.memoryId !== request.params.id) return invalid(reply);
    const resolved = await resolve(request);
    if (resolved?.ports.repair === undefined) return reply.code(403).send({ error: "Forbidden" });
    const result = protectedMemoryRepairResponseV1Schema.parse(await resolved.ports.repair.commit({
      authority: resolved.authority, memoryId: request.params.id, prepared: body.data,
    }));
    if ("memoryId" in result && (result.memoryId !== request.params.id
      || result.operationId !== body.data.operationId || result.direction !== body.data.direction)) {
      throw new TypeError("Protected Memory repair receipt was substituted");
    }
    return reply.send(result);
  });

  app.post("/api/protected/memories/:id/archive", async (
    request: MemoryRequest,
    reply,
  ) => {
    const body = protectedMemoryArchiveRequestV1Schema.safeParse(request.body);
    if (!UUID.test(request.params.id) || !body.success) return invalid(reply);
    const resolved = await resolve(request);
    if (resolved === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await resolved.ports.archive({
      authority: resolved.authority,
      operationId: body.data.operationId,
      memoryId: request.params.id,
      expectedContentRevision: body.data.expectedContentRevision,
      expectedCryptoAccessRevision: body.data.expectedCryptoAccessRevision,
      expectedTier: body.data.expectedTier,
    });
    if ("dtoVersion" in result) {
      return reply.send(protectedMemoryUnavailableResponseV1Schema.parse(result));
    }
    return reply.send(protectedMemoryArchiveResponseV1Schema.parse({
      dtoVersion: 1,
      operationId: result.response.operationId,
      memoryId: result.memoryId,
      status: result.response.status,
      contentRevision: result.response.contentRevision,
      cryptoAccessRevision: result.response.cryptoAccessRevision,
      tier: result.response.nextTier,
      ...(result.followUpPending === true ? { followUpPending: true } : {}),
    }));
  });

  app.post("/api/protected/memories/:id/tier", async (
    request: MemoryRequest,
    reply,
  ) => {
    const body = protectedMemoryTierTransitionRequestV1Schema.safeParse(request.body);
    if (!UUID.test(request.params.id) || !body.success) return invalid(reply);
    const resolved = await resolve(request);
    if (resolved === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await resolved.ports.transitionTier({
      authority: resolved.authority,
      operationId: body.data.operationId,
      memoryId: request.params.id,
      action: body.data.action,
      expectedContentRevision: body.data.expectedContentRevision,
      expectedCryptoAccessRevision: body.data.expectedCryptoAccessRevision,
      expectedTier: body.data.expectedTier,
      nextTier: body.data.nextTier,
    });
    if ("dtoVersion" in result) {
      return reply.send(protectedMemoryUnavailableResponseV1Schema.parse(result));
    }
    return reply.send(protectedMemoryTierTransitionResponseV1Schema.parse({
      dtoVersion: 1,
      operationId: result.response.operationId,
      memoryId: result.memoryId,
      status: result.response.status,
      contentRevision: result.response.contentRevision,
      cryptoAccessRevision: result.response.cryptoAccessRevision,
      previousTier: result.response.previousTier,
      nextTier: result.response.nextTier,
      ...(result.followUpPending === true ? { followUpPending: true } : {}),
    }));
  });

  app.post("/api/protected/memories/:id/restore", async (
    request: MemoryRequest,
    reply,
  ) => {
    const body = protectedMemoryRestoreRequestV1Schema.safeParse(request.body);
    if (!UUID.test(request.params.id) || !body.success) return invalid(reply);
    const resolved = await resolve(request);
    if (resolved === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await resolved.ports.restore({
      authority: resolved.authority,
      operationId: body.data.operationId,
      memoryId: request.params.id,
      expectedContentRevision: body.data.expectedContentRevision,
      expectedCryptoAccessRevision: body.data.expectedCryptoAccessRevision,
      expectedTier: body.data.expectedTier,
      nextTier: body.data.nextTier,
    });
    if ("dtoVersion" in result) {
      return reply.send(protectedMemoryUnavailableResponseV1Schema.parse(result));
    }
    return reply.send(protectedMemoryRestoreResponseV1Schema.parse({
      dtoVersion: 1,
      operationId: result.response.operationId,
      memoryId: result.memoryId,
      status: result.response.status,
      contentRevision: result.response.contentRevision,
      cryptoAccessRevision: result.response.cryptoAccessRevision,
      previousTier: result.response.previousTier,
      nextTier: result.response.nextTier,
      ...(result.followUpPending === true ? { followUpPending: true } : {}),
    }));
  });

  app.post("/api/protected/memories/:id/access-plan", async (
    request: MemoryRequest,
    reply,
  ) => {
    const body = protectedMemoryAccessPlanRequestV1Schema.safeParse(request.body);
    if (!UUID.test(request.params.id) || !body.success) return invalid(reply);
    const resolved = await resolve(request);
    if (resolved === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await resolved.ports.planAccess({
      authority: resolved.authority,
      memoryId: request.params.id,
      operation: body.data.operation,
    });
    const response = result.status === "unavailable"
      ? protectedMemoryUnavailableResponseV1Schema.parse(result)
      : protectedMemoryAccessPlanResponseV1Schema.parse(result);
    if ("memoryId" in response && response.memoryId !== request.params.id) {
      throw new TypeError("Protected Memory access plan was substituted");
    }
    return reply.send(response);
  });

  app.post("/api/protected/memories/:id/access", async (
    request: MemoryRequest,
    reply,
  ) => {
    const body = protectedMemoryPreparedAccessRequestV1Schema.safeParse(request.body);
    if (
      !UUID.test(request.params.id)
      || !body.success
      || body.data.memoryId !== request.params.id
    ) return invalid(reply);
    const resolved = await resolve(request);
    if (resolved === null) return reply.code(403).send({ error: "Forbidden" });
    const result = await resolved.ports.commitAccess({
      authority: resolved.authority,
      memoryId: request.params.id,
      prepared: body.data,
    });
    const response = "reason" in result
      ? protectedMemoryUnavailableResponseV1Schema.parse(result)
      : protectedMemoryAccessUpdateResponseV1Schema.parse(result);
    if (
      "operationId" in response
      && (
        response.memoryId !== body.data.memoryId
        || response.operationId !== body.data.operationId
        || (response.status === "updated"
          && response.cryptoAccessRevision !== body.data.nextCryptoAccessRevision)
      )
    ) throw new TypeError("Protected Memory access receipt was substituted");
    return reply.send(response);
  });
}
