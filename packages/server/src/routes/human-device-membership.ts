import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  humanDeviceMembershipAcknowledgementRequestV1Schema,
  humanDeviceMembershipAddRequestV1Schema,
  humanDeviceMembershipBeginRequestV1Schema,
  humanDeviceMembershipInitialRequestV1Schema,
  humanDeviceMembershipJoinRequestV1Schema,
  humanDeviceMembershipPendingRequestV1Schema,
  humanDeviceMembershipRemoveRequestV1Schema,
  humanDeviceMembershipRecoveryBeginRequestV1Schema,
  humanDeviceMembershipRecoveryCompleteRequestV1Schema,
  humanDeviceMembershipRosterRequestV1Schema,
  humanDeviceMembershipStatusRequestV1Schema,
  type HumanDeviceMembershipBeginV1,
  type HumanDeviceMembershipMutationV1,
  type HumanDeviceMembershipPendingV1,
  type HumanDeviceMembershipStatusV1,
  type HumanDeviceMembershipRosterV1,
  type HumanDeviceMembershipRecoveryBeginV1,
} from "@nautilo/api-client";

type Authority = Readonly<{ userId: string; humanActorId: string }>;

function authority(request: FastifyRequest): Authority | null {
  if (request.sessionUserId === null || request.sessionActorId === null
    || request.policyContext?.actorRole === "guest") return null;
  return Object.freeze({
    userId: request.sessionUserId,
    humanActorId: request.sessionActorId,
  });
}

function operationId(request: FastifyRequest): string | null {
  const value = (request.params as { operationId?: unknown }).operationId;
  return typeof value === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(value)
    ? value
    : null;
}

export interface HumanDeviceMembershipComposition {
  status(input: Readonly<{
    authority: Authority;
    request: ReturnType<typeof humanDeviceMembershipStatusRequestV1Schema.parse>;
  }>): Promise<HumanDeviceMembershipStatusV1>;
  establishInitial(input: Readonly<{
    authority: Authority;
    request: ReturnType<typeof humanDeviceMembershipInitialRequestV1Schema.parse>;
  }>): Promise<HumanDeviceMembershipMutationV1>;
  begin(input: Readonly<{
    authority: Authority;
    request: ReturnType<typeof humanDeviceMembershipBeginRequestV1Schema.parse>;
  }>): Promise<HumanDeviceMembershipBeginV1>;
  publishJoin(input: Readonly<{
    authority: Authority;
    operationId: string;
    request: ReturnType<typeof humanDeviceMembershipJoinRequestV1Schema.parse>;
  }>): Promise<HumanDeviceMembershipMutationV1>;
  pending(input: Readonly<{
    authority: Authority;
    request: ReturnType<typeof humanDeviceMembershipPendingRequestV1Schema.parse>;
  }>): Promise<HumanDeviceMembershipPendingV1>;
  roster(input: Readonly<{
    authority: Authority;
    request: ReturnType<typeof humanDeviceMembershipRosterRequestV1Schema.parse>;
  }>): Promise<HumanDeviceMembershipRosterV1>;
  publishAdd(input: Readonly<{
    authority: Authority;
    operationId: string;
    request: ReturnType<typeof humanDeviceMembershipAddRequestV1Schema.parse>;
  }>): Promise<HumanDeviceMembershipMutationV1>;
  publishRemove(input: Readonly<{
    authority: Authority;
    operationId: string;
    request: ReturnType<typeof humanDeviceMembershipRemoveRequestV1Schema.parse>;
  }>): Promise<HumanDeviceMembershipMutationV1>;
  beginRecovery(input: Readonly<{
    authority: Authority;
    request: ReturnType<
      typeof humanDeviceMembershipRecoveryBeginRequestV1Schema.parse
    >;
  }>): Promise<HumanDeviceMembershipRecoveryBeginV1>;
  completeRecovery(input: Readonly<{
    authority: Authority;
    operationId: string;
    request: ReturnType<
      typeof humanDeviceMembershipRecoveryCompleteRequestV1Schema.parse
    >;
  }>): Promise<HumanDeviceMembershipMutationV1>;
  acknowledge(input: Readonly<{
    authority: Authority;
    request: ReturnType<
      typeof humanDeviceMembershipAcknowledgementRequestV1Schema.parse
    >;
  }>): Promise<HumanDeviceMembershipMutationV1>;
}

export function humanDeviceMembershipRoutes(
  app: FastifyInstance,
  composition: HumanDeviceMembershipComposition,
): void {
  const run = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
    operation: (input: Authority, body: T) => Promise<unknown>,
  ) => {
    const current = authority(request);
    if (current === null) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_human_device_membership_request" });
    }
    try {
      return reply.send(await operation(current, parsed.data!));
    } catch (error) {
      const code = error instanceof Error
        ? error.message
        : "human_device_membership_unavailable";
      return reply.code(code.includes("unauthorized") ? 403 : 409).send({
        error: code,
      });
    }
  };

  app.post("/api/protected/devices/membership/status", (request, reply) =>
    run(request, reply, humanDeviceMembershipStatusRequestV1Schema,
      (current, body) => composition.status({ authority: current, request: body })));
  app.post("/api/protected/devices/membership/initial", (request, reply) =>
    run(request, reply, humanDeviceMembershipInitialRequestV1Schema,
      (current, body) => composition.establishInitial({ authority: current, request: body })));
  app.post("/api/protected/devices/membership/begin", (request, reply) =>
    run(request, reply, humanDeviceMembershipBeginRequestV1Schema,
      (current, body) => composition.begin({ authority: current, request: body })));
  app.post("/api/protected/devices/membership/pending", (request, reply) =>
    run(request, reply, humanDeviceMembershipPendingRequestV1Schema,
      (current, body) => composition.pending({ authority: current, request: body })));
  app.post("/api/protected/devices/membership/roster", (request, reply) =>
    run(request, reply, humanDeviceMembershipRosterRequestV1Schema,
      (current, body) => composition.roster({ authority: current, request: body })));
  app.post("/api/protected/devices/membership/recovery/begin", (request, reply) =>
    run(request, reply, humanDeviceMembershipRecoveryBeginRequestV1Schema,
      (current, body) => composition.beginRecovery({
        authority: current,
        request: body,
      })));
  app.post("/api/protected/devices/membership/acknowledge", (request, reply) =>
    run(request, reply, humanDeviceMembershipAcknowledgementRequestV1Schema,
      (current, body) => composition.acknowledge({ authority: current, request: body })));
  app.post("/api/protected/devices/membership/:operationId/join", async (request, reply) => {
    const id = operationId(request);
    if (id === null) return reply.code(400).send({ error: "invalid_human_device_operation" });
    return run(request, reply, humanDeviceMembershipJoinRequestV1Schema,
      (current, body) => composition.publishJoin({ authority: current, operationId: id, request: body }));
  });
  app.post("/api/protected/devices/membership/:operationId/add", async (request, reply) => {
    const id = operationId(request);
    if (id === null) return reply.code(400).send({ error: "invalid_human_device_operation" });
    return run(request, reply, humanDeviceMembershipAddRequestV1Schema,
      (current, body) => composition.publishAdd({ authority: current, operationId: id, request: body }));
  });
  app.post("/api/protected/devices/membership/:operationId/remove", async (request, reply) => {
    const id = operationId(request);
    if (id === null) return reply.code(400).send({ error: "invalid_human_device_operation" });
    return run(request, reply, humanDeviceMembershipRemoveRequestV1Schema,
      (current, body) => composition.publishRemove({ authority: current, operationId: id, request: body }));
  });
  app.post("/api/protected/devices/membership/:operationId/recovery", async (request, reply) => {
    const id = operationId(request);
    if (id === null) return reply.code(400).send({ error: "invalid_human_device_operation" });
    return run(request, reply, humanDeviceMembershipRecoveryCompleteRequestV1Schema,
      (current, body) => composition.completeRecovery({
        authority: current,
        operationId: id,
        request: body,
      }));
  });
}
