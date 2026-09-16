import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  protectedAdditionalDeviceAcknowledgementRequestV1Schema,
  protectedAdditionalDeviceActivationRequestV1Schema,
  protectedAdditionalDeviceApprovalRequestV1Schema,
  protectedAdditionalDeviceBeginRequestV1Schema,
  protectedAdditionalDeviceDeliveriesRequestV1Schema,
  protectedAdditionalDeviceJoinPackagesRequestV1Schema,
  protectedAdditionalDevicePendingListRequestV1Schema,
  protectedAdditionalDeviceTransitionPlanRequestV1Schema,
  protectedAdditionalDeviceTransitionsRequestV1Schema,
  protectedAdditionalDeviceBeginRequestV2Schema,
  protectedAdditionalDeviceJoinPackagesRequestV2Schema,
  protectedAdditionalDevicePendingListRequestV2Schema,
  protectedAdditionalDevicePlanPageRequestV2Schema,
  protectedAdditionalDeviceTransitionPlanRequestV2Schema,
  protectedAdditionalDeviceTransitionsRequestV2Schema,
  type ProtectedAdditionalDeviceActivationV1,
  type ProtectedAdditionalDeviceApprovalResponseV1,
  type ProtectedAdditionalDeviceDeliveriesV1,
  type ProtectedAdditionalDevicePlanV1,
  type ProtectedAdditionalDeviceTransitionPlanV1,
  type ProtectedAdditionalDevicePlanV2,
  type ProtectedAdditionalDeviceTransitionPlanV2,
} from "@nautilo/api-client";

interface AdditionalDeviceSessionAuthority {
  readonly userId: string;
  readonly humanActorId: string;
}

// The protocol admits at most 64 MiB of binary transfer material. Canonical
// base64url plus the closed JSON envelope remains below this route-local cap.
const ADDITIONAL_DEVICE_TRANSFER_BODY_LIMIT_BYTES = 96 * 1024 * 1024;

function signedInAuthority(
  request: FastifyRequest,
): AdditionalDeviceSessionAuthority | null {
  if (
    request.sessionUserId === null
    || request.sessionActorId === null
    || request.policyContext?.actorRole === "guest"
  ) return null;
  return Object.freeze({
    userId: request.sessionUserId,
    humanActorId: request.sessionActorId,
  });
}

export interface ProtectedAdditionalDeviceComposition {
  begin(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    request: ReturnType<typeof protectedAdditionalDeviceBeginRequestV1Schema.parse>;
  }>): Promise<ProtectedAdditionalDevicePlanV1>;
  pending(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    approverDeviceId: string;
  }>): Promise<readonly ProtectedAdditionalDevicePlanV1[]>;
  publishJoinPackages(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    request: ReturnType<
      typeof protectedAdditionalDeviceJoinPackagesRequestV1Schema.parse
    >;
  }>): Promise<Readonly<{ status: "published" | "duplicate" }>>;
  approve(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    request: ReturnType<typeof protectedAdditionalDeviceApprovalRequestV1Schema.parse>;
  }>): Promise<ProtectedAdditionalDeviceApprovalResponseV1>;
  transitionPlan(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    approverDeviceId: string;
  }>): Promise<ProtectedAdditionalDeviceTransitionPlanV1>;
  submitTransitions(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    request: ReturnType<typeof protectedAdditionalDeviceTransitionsRequestV1Schema.parse>;
  }>): Promise<ProtectedAdditionalDeviceApprovalResponseV1>;
  deliveries(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    request: ReturnType<typeof protectedAdditionalDeviceDeliveriesRequestV1Schema.parse>;
  }>): Promise<ProtectedAdditionalDeviceDeliveriesV1>;
  acknowledge(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    request: ReturnType<
      typeof protectedAdditionalDeviceAcknowledgementRequestV1Schema.parse
    >;
  }>): Promise<Readonly<{ status: "acknowledged" | "duplicate" }>>;
  activate(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    deviceId: string;
  }>): Promise<ProtectedAdditionalDeviceActivationV1>;
  beginV2(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    request: ReturnType<typeof protectedAdditionalDeviceBeginRequestV2Schema.parse>;
  }>): Promise<ProtectedAdditionalDevicePlanV2>;
  planPageV2(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    deviceId: string;
    pageStart: number;
  }>): Promise<ProtectedAdditionalDevicePlanV2>;
  pendingV2(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    approverDeviceId: string;
  }>): Promise<readonly ProtectedAdditionalDevicePlanV2[]>;
  publishJoinPackagesV2(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    request: ReturnType<
      typeof protectedAdditionalDeviceJoinPackagesRequestV2Schema.parse
    >;
  }>): Promise<Readonly<{ status: "published" | "duplicate" }>>;
  transitionPlanV2(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    approverDeviceId: string;
    pageStart: number;
  }>): Promise<ProtectedAdditionalDeviceTransitionPlanV2>;
  submitTransitionsV2(input: Readonly<{
    authority: AdditionalDeviceSessionAuthority;
    operationId: string;
    request: ReturnType<
      typeof protectedAdditionalDeviceTransitionsRequestV2Schema.parse
    >;
  }>): Promise<ProtectedAdditionalDeviceApprovalResponseV1>;
}

function operationId(request: FastifyRequest): string | null {
  const params = request.params as Readonly<{ operationId?: unknown }>;
  return typeof params.operationId === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(params.operationId)
    ? params.operationId
    : null;
}

export function protectedAdditionalDeviceRoutes(
  app: FastifyInstance,
  composition: ProtectedAdditionalDeviceComposition,
): void {
  app.post("/api/protected/devices/additional/begin", async (request, reply) => {
    const authority = signedInAuthority(request);
    if (authority === null) return reply.code(401).send({ error: "Authentication required" });
    const parsedV2 = protectedAdditionalDeviceBeginRequestV2Schema.safeParse(request.body);
    if (parsedV2.success) {
      try {
        return reply.send(await composition.beginV2({
          authority,
          request: parsedV2.data,
        }));
      } catch (error) {
        const code = error instanceof Error ? error.message : "additional_device_unavailable";
        return reply.code(code.includes("authorization") ? 403 : 409).send({ error: code });
      }
    }
    const parsed = protectedAdditionalDeviceBeginRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_additional_device_request" });
    try {
      return reply.send(await composition.begin({ authority, request: parsed.data }));
    } catch (error) {
      const code = error instanceof Error ? error.message : "additional_device_unavailable";
      return reply.code(code.includes("authorization") ? 403 : 409).send({ error: code });
    }
  });

  app.post("/api/protected/devices/additional/pending", async (request, reply) => {
    const authority = signedInAuthority(request);
    if (authority === null) return reply.code(401).send({ error: "Authentication required" });
    const parsedV2 = protectedAdditionalDevicePendingListRequestV2Schema.safeParse(request.body);
    if (parsedV2.success) {
      return reply.send(Object.freeze({
        formatVersion: 2 as const,
        pending: await composition.pendingV2({
          authority,
          approverDeviceId: parsedV2.data.approverDeviceId,
        }),
      }));
    }
    const parsed = protectedAdditionalDevicePendingListRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_additional_device_pending_request" });
    return reply.send(Object.freeze({
      formatVersion: 1 as const,
      pending: await composition.pending({
        authority,
        approverDeviceId: parsed.data.approverDeviceId,
      }),
    }));
  });

  app.post("/api/protected/devices/additional/:operationId/plan-page", async (request, reply) => {
    const authority = signedInAuthority(request);
    const id = operationId(request);
    if (authority === null) return reply.code(401).send({ error: "Authentication required" });
    if (id === null) return reply.code(400).send({ error: "invalid_additional_device_operation" });
    const parsed = protectedAdditionalDevicePlanPageRequestV2Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_additional_device_plan_page" });
    try {
      return reply.send(await composition.planPageV2({
        authority,
        operationId: id,
        deviceId: parsed.data.deviceId,
        pageStart: parsed.data.pageStart,
      }));
    } catch {
      return reply.code(409).send({ error: "additional_device_plan_page_unavailable" });
    }
  });

  app.post("/api/protected/devices/additional/:operationId/join-packages", {
    bodyLimit: ADDITIONAL_DEVICE_TRANSFER_BODY_LIMIT_BYTES,
  }, async (request, reply) => {
    const authority = signedInAuthority(request);
    const id = operationId(request);
    if (authority === null) return reply.code(401).send({ error: "Authentication required" });
    if (id === null) return reply.code(400).send({ error: "invalid_additional_device_operation" });
    const parsedV2 = protectedAdditionalDeviceJoinPackagesRequestV2Schema.safeParse(request.body);
    if (parsedV2.success) {
      try {
        return reply.send(await composition.publishJoinPackagesV2({
          authority,
          operationId: id,
          request: parsedV2.data,
        }));
      } catch {
        return reply.code(409).send({ error: "additional_device_join_unavailable" });
      }
    }
    const parsed = protectedAdditionalDeviceJoinPackagesRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_additional_device_join_packages" });
    try {
      return reply.send(await composition.publishJoinPackages({
        authority,
        operationId: id,
        request: parsed.data,
      }));
    } catch {
      return reply.code(409).send({ error: "additional_device_join_unavailable" });
    }
  });

  app.post("/api/protected/devices/additional/:operationId/approve", {
    bodyLimit: ADDITIONAL_DEVICE_TRANSFER_BODY_LIMIT_BYTES,
  }, async (request, reply) => {
    const authority = signedInAuthority(request);
    const id = operationId(request);
    if (authority === null) return reply.code(401).send({ error: "Authentication required" });
    if (id === null) return reply.code(400).send({ error: "invalid_additional_device_operation" });
    const parsed = protectedAdditionalDeviceApprovalRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_additional_device_approval" });
    try {
      return reply.send(await composition.approve({
        authority,
        operationId: id,
        request: parsed.data,
      }));
    } catch {
      return reply.code(409).send({ error: "additional_device_approval_unavailable" });
    }
  });

  app.post("/api/protected/devices/additional/:operationId/transition-plan", async (request, reply) => {
    const authority = signedInAuthority(request);
    const id = operationId(request);
    if (authority === null) return reply.code(401).send({ error: "Authentication required" });
    if (id === null) return reply.code(400).send({ error: "invalid_additional_device_operation" });
    const parsedV2 = protectedAdditionalDeviceTransitionPlanRequestV2Schema.safeParse(request.body);
    if (parsedV2.success) {
      try {
        return reply.send(await composition.transitionPlanV2({
          authority,
          operationId: id,
          approverDeviceId: parsedV2.data.approverDeviceId,
          pageStart: parsedV2.data.pageStart,
        }));
      } catch {
        return reply.code(409).send({ error: "additional_device_transition_unavailable" });
      }
    }
    const parsed = protectedAdditionalDeviceTransitionPlanRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_additional_device_transition_plan" });
    try {
      return reply.send(await composition.transitionPlan({
        authority,
        operationId: id,
        approverDeviceId: parsed.data.approverDeviceId,
      }));
    } catch {
      return reply.code(409).send({ error: "additional_device_transition_unavailable" });
    }
  });

  app.post("/api/protected/devices/additional/:operationId/transitions", {
    bodyLimit: ADDITIONAL_DEVICE_TRANSFER_BODY_LIMIT_BYTES,
  }, async (request, reply) => {
    const authority = signedInAuthority(request);
    const id = operationId(request);
    if (authority === null) return reply.code(401).send({ error: "Authentication required" });
    if (id === null) return reply.code(400).send({ error: "invalid_additional_device_operation" });
    const parsedV2 = protectedAdditionalDeviceTransitionsRequestV2Schema.safeParse(request.body);
    if (parsedV2.success) {
      try {
        return reply.send(await composition.submitTransitionsV2({
          authority,
          operationId: id,
          request: parsedV2.data,
        }));
      } catch {
        return reply.code(409).send({ error: "additional_device_transition_unavailable" });
      }
    }
    const parsed = protectedAdditionalDeviceTransitionsRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_additional_device_transitions" });
    try {
      return reply.send(await composition.submitTransitions({
        authority,
        operationId: id,
        request: parsed.data,
      }));
    } catch {
      return reply.code(409).send({ error: "additional_device_transition_unavailable" });
    }
  });

  app.post("/api/protected/devices/additional/:operationId/deliveries", async (request, reply) => {
    const authority = signedInAuthority(request);
    const id = operationId(request);
    if (authority === null) return reply.code(401).send({ error: "Authentication required" });
    if (id === null) return reply.code(400).send({ error: "invalid_additional_device_operation" });
    const parsed = protectedAdditionalDeviceDeliveriesRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_additional_device_delivery_request" });
    try {
      return reply.send(await composition.deliveries({
        authority,
        operationId: id,
        request: parsed.data,
      }));
    } catch {
      return reply.code(409).send({ error: "additional_device_delivery_unavailable" });
    }
  });

  app.post("/api/protected/devices/additional/:operationId/ack", async (request, reply) => {
    const authority = signedInAuthority(request);
    const id = operationId(request);
    if (authority === null) return reply.code(401).send({ error: "Authentication required" });
    if (id === null) return reply.code(400).send({ error: "invalid_additional_device_operation" });
    const parsed = protectedAdditionalDeviceAcknowledgementRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_additional_device_acknowledgement" });
    try {
      return reply.send(await composition.acknowledge({
        authority,
        operationId: id,
        request: parsed.data,
      }));
    } catch {
      return reply.code(409).send({ error: "additional_device_acknowledgement_unavailable" });
    }
  });

  app.post("/api/protected/devices/additional/:operationId/activate", async (request, reply) => {
    const authority = signedInAuthority(request);
    const id = operationId(request);
    if (authority === null) return reply.code(401).send({ error: "Authentication required" });
    if (id === null) return reply.code(400).send({ error: "invalid_additional_device_operation" });
    const parsed = protectedAdditionalDeviceActivationRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_additional_device_activation" });
    try {
      return reply.send(await composition.activate({
        authority,
        operationId: id,
        deviceId: parsed.data.deviceId,
      }));
    } catch {
      return reply.code(409).send({ error: "additional_device_activation_unavailable" });
    }
  });

}
