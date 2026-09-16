import type { FastifyInstance } from "fastify";
import type {
  CodexUserInputRequest,
  CodexUserInputRequestTransitionResult,
} from "@nautilo/db";
import {
  createAcceptedInvocationAuthority,
  isUuidString,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import {
  codexPermissionSelectionResponseSchema,
  codexRequestResponseReceiptSchema,
  codexRequestResponseSchema,
  codexRoomRequestListSchema,
  type CodexUserInputRequestEvent,
  type CodexRequestResponse,
  type ServerEvent,
} from "@nautilo/types";
import {
  HarnessControlPlaneError,
  getMaintenanceGate,
  type HarnessControlPlane,
  type HarnessRequestResponse,
} from "@nautilo/runtime";
import { CODEX_HARNESS_ID } from "../codex/harness-driver";
import type { CodexUnavailableRequestTerminalizationPort } from "../codex/task-run-lifecycle";
import {
  requireAgentInvocation,
  type AssertCanInvokeAgent,
} from "../lib/agent-invocation-admission";
import {
  isMaintenanceDrainError,
  replyMaintenanceRejection,
} from "../lib/maintenance-rejection";

type AuthenticatedCodexRequest = {
  readonly sessionUserId: string | null;
  readonly policyContext?: { readonly actorRole?: string } | null;
};

type CodexUserInputRequestStore = {
  get(ownerId: string, requestRef: string): Promise<CodexUserInputRequest | undefined>;
  listRoom(ownerId: string, roomId: string): Promise<readonly CodexUserInputRequest[]>;
  claim(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly requestRef: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<CodexUserInputRequestTransitionResult>;
  settle(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly requestRef: string;
    readonly expectedRevision: number;
    readonly state: "expired" | "unavailable";
    readonly now: Date;
  }): Promise<CodexUserInputRequestTransitionResult>;
  markUnavailable(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly requestRef: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<CodexUserInputRequestTransitionResult>;
  markSubmitted(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly requestRef: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<CodexUserInputRequestTransitionResult>;
};

type CodexLiveRequestReader = {
  hasLiveRequest?(requestRef: string, ownerId: string): boolean;
  hasLiveUserInputRequest(requestRef: string, ownerId: string): boolean;
};

/** Provider-neutral live request seam; its implementation owns provider details. */
type EphemeralHarnessRequestPort = {
  hasLiveRequest(requestId: string, ownerId: string): boolean;
  respond(response: HarnessRequestResponse, authority: AcceptedInvocationAuthority): Promise<void>;
};

type PermissionSelectionResponse = ReturnType<typeof codexPermissionSelectionResponseSchema.parse>;
type BrowserRequestResponse = CodexRequestResponse | PermissionSelectionResponse;

export interface CodexRequestsRouteDeps {
  readonly controlPlane: HarnessControlPlane;
  readonly emit: (event: ServerEvent) => void;
  /** Required only for the durable Plan/user-input path; approvals remain ephemeral. */
  readonly userInputRequests?: CodexUserInputRequestStore;
  readonly liveRequests?: CodexLiveRequestReader;
  /** Live-only requests never pass through the durable Codex store. */
  readonly ephemeralRequests?: EphemeralHarnessRequestPort;
  readonly unavailableRequests: CodexUnavailableRequestTerminalizationPort;
  readonly assertCanInvokeAgent?: AssertCanInvokeAgent;
  readonly now?: () => Date;
}

/**
 * Owner-private response seam for native Codex requests. Approval requests
 * remain intentionally ephemeral. User-input requests add a narrow durable
 * fact boundary, but their answer values continue straight from this request
 * stack frame to the live Electron-owned closure and are never persisted.
 */
export function codexRequestsRoutes(app: FastifyInstance, deps: CodexRequestsRouteDeps): void {
  app.get<{ Params: { roomId: string } }>(
    "/api/codex/rooms/:roomId/requests",
    async (request, reply) => {
      const context = request as typeof request & AuthenticatedCodexRequest;
      if (!context.sessionUserId) return reply.code(401).send({ error: "Authentication required" });
      if (context.policyContext?.actorRole === "guest") {
        return reply.code(403).send({ code: "CODEX_FORBIDDEN" });
      }
      const roomId = typeof request.params.roomId === "string" ? request.params.roomId : "";
      if (!isUuidString(roomId) || !deps.userInputRequests || !deps.liveRequests) {
        return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
      }
      const now = (deps.now ?? (() => new Date()))();
      const rows = await deps.userInputRequests.listRoom(context.sessionUserId, roomId);
      const items: Array<{
        readonly availability: "actionable" | "unavailable";
        readonly event: CodexUserInputRequestEvent;
      }> = [];
      for (const row of rows) {
        // The explicit unavailable receipt is retained so a browser that lost
        // the first recovery response still gets a restart explanation.
        if (row.state === "unavailable") {
          await deps.unavailableRequests.terminalize(row);
          items.push({ availability: "unavailable", event: eventFor(row) });
          continue;
        }
        // The database recovery query intentionally excludes these states.
        // Keep this defensive guard so a future store implementation cannot
        // turn an answer already accepted by the broker into an unavailable
        // restart card between `respond()` and `markSubmitted()`.
        if (row.state !== "awaiting_human") continue;
        if (row.expiresAt.getTime() <= now.getTime()) {
          await makeUnavailableOrSettle(deps, row, "expired", now);
          continue;
        }
        const live = deps.liveRequests.hasLiveUserInputRequest(row.requestRef, context.sessionUserId);
        if (!live) {
          const unavailable = await makeUnavailableOrSettle(deps, row, "unavailable", now);
          if (isUnavailable(unavailable)) {
            items.push({ availability: "unavailable", event: eventFor(unavailable.request) });
          }
          continue;
        }
        items.push({ availability: "actionable", event: eventFor(row) });
      }
      return reply.code(200).send(codexRoomRequestListSchema.parse({ roomId, items }));
    },
  );

  app.post<{ Params: { requestRef: string }; Body: unknown }>(
    "/api/codex/requests/:requestRef/respond",
    async (request, reply) => {
      const context = request as typeof request & AuthenticatedCodexRequest;
      if (!context.sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const requestId = typeof request.params.requestRef === "string"
        ? request.params.requestRef
        : "";
      if (requestId.length === 0 || requestId.length > 512) {
        return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
      }
      const codexResponse = codexRequestResponseSchema.safeParse(request.body ?? {});
      let response: BrowserRequestResponse;
      if (codexResponse.success) {
        response = codexResponse.data;
      } else {
        const permissionSelection = codexPermissionSelectionResponseSchema.safeParse(request.body ?? {});
        if (!permissionSelection.success) {
          return reply.code(400).send({ code: "CODEX_INVALID_REQUEST" });
        }
        response = permissionSelection.data;
      }

      const ephemeralRequests = deps.ephemeralRequests;
      const liveEphemeralRequest = ephemeralRequests?.hasLiveRequest(requestId, context.sessionUserId) ?? false;
      if (liveEphemeralRequest) {
        if (!(await requireAgentInvocation(
          { humanUserId: context.sessionUserId, origin: "foreground_resume" },
          reply,
          deps.assertCanInvokeAgent,
        ))) return;
        try {
          await getMaintenanceGate().assertAcceptingNewWork();
        } catch (error) {
          if (isMaintenanceDrainError(error)) {
            return replyMaintenanceRejection(reply, error);
          }
          throw error;
        }
        if (!ephemeralRequests?.hasLiveRequest(requestId, context.sessionUserId)) {
          return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
        }
        try {
          await ephemeralRequests.respond(
            toHarnessResponse(requestId, context.sessionUserId, response),
            createAcceptedInvocationAuthority(context.sessionUserId),
          );
        } catch {
          return reply.code(409).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
        }
        deps.emit({ type: "codex.request.resolved", ownerId: context.sessionUserId, requestId });
        return reply.code(200).send(codexRequestResponseReceiptSchema.parse({ requestId }));
      }

      if (response.kind === "permission_selection_required") {
        return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
      }

      if (response.kind === "user_input_required") {
        return respondToDurableUserInput(requestId, context.sessionUserId, response, deps, reply);
      }

      // Exact owner/request liveness is non-mutating and precedes the current
      // RBAC decision. The subsequent broker response remains the claim.
      const liveRequest =
        deps.liveRequests?.hasLiveRequest?.(requestId, context.sessionUserId) ??
        deps.liveRequests?.hasLiveUserInputRequest(requestId, context.sessionUserId) ??
        false;
      if (!liveRequest) {
        return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
      }
      if (!(await requireAgentInvocation(
        { humanUserId: context.sessionUserId, origin: "foreground_resume" },
        reply,
        deps.assertCanInvokeAgent,
      ))) return;
      try {
        await getMaintenanceGate().assertAcceptingNewWork();
      } catch (error) {
        if (isMaintenanceDrainError(error)) {
          return replyMaintenanceRejection(reply, error);
        }
        throw error;
      }
      const invocationAuthority = createAcceptedInvocationAuthority(context.sessionUserId);

      // This is the established approval path. Do not make approvals durable:
      // their host grants are intentionally scoped to the live request only.
      try {
        const driver = await deps.controlPlane.requireOperation(
          CODEX_HARNESS_ID,
          "respond_to_request",
        );
        const harnessResponse = toHarnessResponse(requestId, context.sessionUserId, response);
        if (!driver.execution.respond) {
          return reply.code(409).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
        }
        await driver.execution.respond(harnessResponse, invocationAuthority);
      } catch (error) {
        if (isNotFoundResponseError(error)) {
          return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
        }
        return reply.code(409).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
      }
      deps.emit({ type: "codex.request.resolved", ownerId: context.sessionUserId, requestId });
      return reply.code(200).send(codexRequestResponseReceiptSchema.parse({ requestId }));
    },
  );
}

async function respondToDurableUserInput(
  requestId: string,
  ownerId: string,
  response: Extract<CodexRequestResponse, { readonly kind: "user_input_required" }>,
  deps: CodexRequestsRouteDeps,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
) {
  const store = deps.userInputRequests;
  const live = deps.liveRequests;
  if (!store || !live) return reply.code(409).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
  const current = await store.get(ownerId, requestId);
  if (!current) {
    return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
  }
  if (current.state === "unavailable") {
    await deps.unavailableRequests.terminalize(current);
    return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
  }
  if (current.state !== "awaiting_human") {
    return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
  }
  const now = (deps.now ?? (() => new Date()))();
  if (current.expiresAt.getTime() <= now.getTime()) {
    await makeUnavailableOrSettle(deps, current, "expired", now);
    return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
  }
  if (!live.hasLiveUserInputRequest(requestId, ownerId)) {
    await makeUnavailableOrSettle(deps, current, "unavailable", now);
    return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
  }
  if (!(await requireAgentInvocation(
    { humanUserId: ownerId, origin: "foreground_resume" },
    reply as import("fastify").FastifyReply,
    deps.assertCanInvokeAgent,
  ))) return;
  try {
    await getMaintenanceGate().assertAcceptingNewWork();
  } catch (error) {
    if (isMaintenanceDrainError(error)) {
      return replyMaintenanceRejection(reply as import("fastify").FastifyReply, error);
    }
    throw error;
  }
  const claimed = await store.claim({
    ownerId,
    agentId: current.sourceAgentId,
    requestRef: requestId,
    expectedRevision: current.revision,
    now,
  });
  if (claimed.status !== "transitioned") {
    if (claimed.status === "stale_binding") await makeUnavailableOrSettle(deps, current, "unavailable", now);
    return reply.code(404).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
  }
  const invocationAuthority = createAcceptedInvocationAuthority(ownerId);
  try {
    const driver = await deps.controlPlane.requireOperation(CODEX_HARNESS_ID, "respond_to_request");
    if (!driver.execution.respond) throw new Error("CODEX_REQUEST_UNAVAILABLE");
    // `response` is deliberately stack-only. Do not log, emit, or pass it to
    // a persistence port: the broker is the only boundary that sees it.
    await driver.execution.respond(
      toHarnessResponse(requestId, ownerId, response),
      invocationAuthority,
    );
  } catch {
    await makeUnavailableOrSettle(deps, claimed.request, "unavailable", now);
    return reply.code(409).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
  }
  const submitted = await store.markSubmitted({
    ownerId,
    agentId: current.sourceAgentId,
    requestRef: requestId,
    expectedRevision: claimed.request.revision,
    now,
  });
  if (submitted.status !== "transitioned") {
    if (submitted.status === "stale_binding") await makeUnavailableOrSettle(deps, claimed.request, "unavailable", now);
    return reply.code(409).send({ code: "CODEX_REQUEST_UNAVAILABLE" });
  }
  deps.emit({ type: "codex.request.resolved", ownerId, requestId });
  return reply.code(200).send(codexRequestResponseReceiptSchema.parse({ requestId }));
}

/**
 * Current bindings are terminalized by the regular binding-fenced CAS. The
 * special unavailable helper is only legal after that CAS proved the binding
 * no longer current, which is exactly what distinguishes a replacement from
 * a still-live but disconnected process.
 */
async function makeUnavailableOrSettle(
  deps: CodexRequestsRouteDeps,
  request: CodexUserInputRequest,
  state: "expired" | "unavailable",
  now: Date,
): Promise<CodexUserInputRequestTransitionResult> {
  const store = deps.userInputRequests;
  if (!store) return { status: "conflict" };
  const settled = await store.settle({
    ownerId: request.userId,
    agentId: request.sourceAgentId,
    requestRef: request.requestRef,
    expectedRevision: request.revision,
    state,
    now,
  });
  const result = settled.status !== "stale_binding"
    ? settled
    : await store.markUnavailable({
        ownerId: request.userId,
        agentId: request.sourceAgentId,
        requestRef: request.requestRef,
        expectedRevision: request.revision,
        now,
      });
  if (state === "unavailable" && isUnavailable(result)) {
    await deps.unavailableRequests.terminalize(result.request);
  }
  return result;
}

function isUnavailable(
  result: CodexUserInputRequestTransitionResult,
): result is Extract<CodexUserInputRequestTransitionResult, { readonly request: CodexUserInputRequest }> {
  return (result.status === "transitioned" || result.status === "already_terminal") &&
    result.request.state === "unavailable";
}

function eventFor(row: CodexUserInputRequest): CodexUserInputRequestEvent {
  return {
    type: "codex.request",
    ownerId: row.userId,
    requestId: row.requestRef,
    taskId: row.taskId,
    jobId: row.jobId,
    roomId: row.roomId,
    expiresAt: row.expiresAt.toISOString(),
    request: {
      kind: "user_input_required",
      questions: row.questions.map((question) => ({
        id: question.id,
        header: question.header,
        prompt: question.question,
        secret: question.isSecret,
        allowOther: question.isOther,
        options: question.options?.map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description,
        })) ?? null,
      })),
      autoResolutionMs: row.autoResolutionMs,
    },
  };
}

function toHarnessResponse(
  requestId: string,
  ownerId: string,
  response: BrowserRequestResponse,
): HarnessRequestResponse {
  if (
    response.kind === "command_approval_required" ||
    response.kind === "network_approval_required" ||
    response.kind === "file_change_approval_required"
  ) {
    return { kind: response.kind, requestId, ownerId, decision: response.decision };
  }
  if (response.kind === "permissions_approval_required") {
    return {
      kind: response.kind,
      requestId,
      ownerId,
      grants: { network: response.grants.network, fileSystem: response.grants.fileSystem },
      scope: response.scope,
    };
  }
  if (response.kind === "permission_selection_required") {
    return {
      kind: response.kind,
      requestId,
      ownerId,
      outcome: response.outcome.kind === "selected"
        ? { kind: "selected", optionId: response.outcome.optionId }
        : { kind: "cancelled" },
    };
  }
  return {
    kind: response.kind,
    requestId,
    ownerId,
    answers: Object.fromEntries(
      Object.entries(response.answers).map(([id, answers]) => [id, [...answers]]),
    ),
  };
}

/** Keep missing, foreign, stale, and replayed request responses indistinguishable. */
function isNotFoundResponseError(error: unknown): boolean {
  if (error instanceof HarnessControlPlaneError) return false;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "stale_scope" || code === "wrong_owner";
}
