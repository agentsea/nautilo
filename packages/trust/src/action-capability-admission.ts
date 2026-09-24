/**
 * M246/M254 — shared admission seams for community action Capabilities.
 *
 * Room and Namespace reachability remain independent checks owned by their
 * existing layers. M254 additionally introduces an in-process accepted-work
 * authority. It is deliberately not data: its Human binding lives only in a
 * private WeakMap, and payload serialization is rejected.
 */

import type { CapabilitySlug } from "./capabilities";
import {
  CAP_INVOKE_AGENTS,
  CAP_INVOKE_OTHER_AGENTS,
  CAP_USE_SERVER_PROVIDER_CREDENTIALS,
  CAP_WRITE_ARTIFACTS,
} from "./capabilities";
import { and, eq, getSharedDirectDb, isNull, moderationAccessAllowedSql, taskInvocationOriginAllowedSql, sql, users } from "@nautilo/db";
import { AmbiguousAgentOwnerError, findAgentOwnerUserId, getUserCapabilities } from "./queries";

export type AgentInvocationOrigin =
  | "room_message"
  | "background_job"
  | "task_create"
  | "task_update"
  | "task_unpause"
  | "task_dispatch"
  | "task_human_reply"
  | "foreground_resume";

export interface AgentInvocationAdmissionInput {
  /** Canonical Human subject (`users.id`), never an Agent Actor id. */
  readonly humanUserId: string;
  readonly origin: AgentInvocationOrigin;
  readonly roomId?: string;
  readonly agentId?: string;
  /** Existing durable Task identity; its stored ancestry owns source Rooms. */
  readonly taskId?: string;
  readonly originRoomId?: string;
  readonly originTaskId?: string;
}

export interface ArtifactWriteAdmissionInput {
  /** Canonical Human subject (`users.id`), never an Actor id or Role label. */
  readonly humanUserId: string;
  readonly roomId?: string;
  readonly namespaceId?: string;
  readonly artifactId?: string;
}

export type ServerProviderCredentialOrigin = string;

export interface ActionCapabilityAdmissionDeps {
  getUserCapabilities(humanUserId: string): Promise<string[]>;
  /** Resolve the canonical Human owner for one exact Genie target. */
  findAgentOwnerUserId(agentId: string): Promise<string | null>;
  isInvocationAccessAllowed(input: AgentInvocationAdmissionInput): Promise<boolean>;
}

const DEFAULT_DEPS: ActionCapabilityAdmissionDeps = {
  getUserCapabilities,
  findAgentOwnerUserId,
  isInvocationAccessAllowed,
};

/** Current access subtraction, also used when accepted runtime work starts. */
export async function isInvocationAccessAllowed(
  input: Pick<AgentInvocationAdmissionInput, "humanUserId" | "roomId" | "taskId" | "originRoomId" | "originTaskId">,
): Promise<boolean> {
  // Task delivery Rooms need not contain the initiating Human. Content owners
  // still authorize reads; this predicate only subtracts current sanctions.
  const [row] = await getSharedDirectDb().select({ id: users.id }).from(users).where(and(
    eq(users.id, input.humanUserId), isNull(users.disabledAt),
    moderationAccessAllowedSql(sql`${users.id}`, input.roomId ? sql`${input.roomId}::uuid` : undefined),
    input.taskId ? taskInvocationOriginAllowedSql(sql`${users.id}`, sql`${input.taskId}::uuid`) : undefined,
    input.originTaskId && input.originTaskId !== input.taskId
      ? taskInvocationOriginAllowedSql(sql`${users.id}`, sql`${input.originTaskId}::uuid`) : undefined,
    input.originRoomId ? sql`public.moderation_access_allowed(${users.id}, ${input.originRoomId}::uuid)
      AND EXISTS (SELECT 1 FROM room_members member JOIN actors actor ON actor.id = member.actor_id
        WHERE member.room_id = ${input.originRoomId}::uuid AND actor.kind = 'user' AND actor.owner_id = ${users.id})` : undefined,
  )).limit(1);
  return row !== undefined;
}

declare const acceptedInvocationAuthorityBrand: unique symbol;

/**
 * Opaque proof that one Agent-invoking unit crossed all of its server-owned
 * admission gates. The canonical Human subject is intentionally not exposed
 * as a property: continuations can present the proof, but cannot copy its
 * binding into a payload and reconstruct it later.
 */
export interface AcceptedInvocationAuthority {
  readonly [acceptedInvocationAuthorityBrand]: true;
}

const acceptedInvocationSubjects = new WeakMap<object, string>();
type AcceptedInvocationOrigin = Readonly<{ originRoomId?: string; originTaskId?: string }>;
const acceptedInvocationOrigins = new WeakMap<object, AcceptedInvocationOrigin>();

/** Trusted admission seam. Call only after every gate for the unit succeeds. */
export function createAcceptedInvocationAuthority(
  humanUserId: string,
  origin: AcceptedInvocationOrigin = {},
): AcceptedInvocationAuthority {
  if (humanUserId.length === 0) {
    throw new TypeError("Accepted invocation authority requires a Human subject");
  }
  const authority = Object.create(null) as object;
  Object.defineProperty(authority, "toJSON", {
    enumerable: false,
    configurable: false,
    value: () => {
      throw new TypeError("Accepted invocation authority cannot be serialized");
    },
  });
  acceptedInvocationSubjects.set(authority, humanUserId);
  acceptedInvocationOrigins.set(authority, Object.freeze({ ...origin }));
  return Object.freeze(authority) as AcceptedInvocationAuthority;
}

/** Origin is private proof state; continuations cannot replace it with Job input. */
export function getAcceptedInvocationAuthorityOrigin(authority: AcceptedInvocationAuthority): AcceptedInvocationOrigin {
  getAcceptedInvocationAuthoritySubject(authority);
  return acceptedInvocationOrigins.get(authority)!;
}

/** Trusted execution admission may bind a previously Room-less proof once.
 * Preserve the original proof and never replace an inherited source.
 */
export function bindAcceptedInvocationAuthorityOrigin(
  authority: AcceptedInvocationAuthority, origin: AcceptedInvocationOrigin,
): AcceptedInvocationAuthority {
  const existing = getAcceptedInvocationAuthorityOrigin(authority);
  if (!existing.originRoomId && !existing.originTaskId) {
    acceptedInvocationOrigins.set(authority, Object.freeze({ ...origin }));
  }
  return authority;
}

/** Reject forged, parsed, or cross-Human continuation authority. */
export function assertAcceptedInvocationAuthoritySubject(
  authority: AcceptedInvocationAuthority,
  humanUserId: string,
): void {
  if (
    typeof authority !== "object" ||
    authority === null ||
    acceptedInvocationSubjects.get(authority) !== humanUserId
  ) {
    throw new TypeError("Accepted invocation authority subject mismatch");
  }
}

/** Trusted runtime projection of the Human bound to an opaque authority. */
export function getAcceptedInvocationAuthoritySubject(
  authority: AcceptedInvocationAuthority,
): string {
  const humanUserId =
    typeof authority === "object" && authority !== null
      ? acceptedInvocationSubjects.get(authority)
      : undefined;
  if (!humanUserId) {
    throw new TypeError("Accepted invocation authority subject mismatch");
  }
  return humanUserId;
}

export type ActionCapabilityDenialCode =
  | "invocation_access_withdrawn"
  | "invoke_agents_required"
  | "invoke_other_agents_required"
  | "agent_target_unavailable"
  | "server_provider_credentials_required"
  | "write_artifacts_required";

interface ActionCapabilityDeniedErrorOptions {
  readonly code: ActionCapabilityDenialCode;
  readonly capability: CapabilitySlug;
  readonly humanUserId: string;
  readonly origin: string;
  readonly roomId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly namespaceId?: string | undefined;
  readonly artifactId?: string | undefined;
}

/** Shared typed base used only for stable adapter mapping. */
export abstract class ActionCapabilityDeniedError extends Error {
  abstract override readonly name: string;
  readonly code: ActionCapabilityDenialCode;
  readonly capability: CapabilitySlug;
  readonly humanUserId: string;
  readonly origin: string;
  readonly roomId: string | undefined;
  readonly agentId: string | undefined;
  readonly namespaceId: string | undefined;
  readonly artifactId: string | undefined;

  protected constructor(options: ActionCapabilityDeniedErrorOptions) {
    super(options.code);
    this.code = options.code;
    this.capability = options.capability;
    this.humanUserId = options.humanUserId;
    this.origin = options.origin;
    this.roomId = options.roomId;
    this.agentId = options.agentId;
    this.namespaceId = options.namespaceId;
    this.artifactId = options.artifactId;
  }
}

export class AgentInvocationDeniedError extends ActionCapabilityDeniedError {
  override readonly name: string = "AgentInvocationDeniedError";

  constructor(
    input: AgentInvocationAdmissionInput,
    denial:
      | typeof CAP_INVOKE_AGENTS
      | typeof CAP_INVOKE_OTHER_AGENTS
      | "agent_target_unavailable"
      | "invocation_access_withdrawn" =
      CAP_INVOKE_AGENTS,
  ) {
    super({
      code: denial === "invocation_access_withdrawn"
        ? "invocation_access_withdrawn"
        : denial === "agent_target_unavailable"
        ? "agent_target_unavailable"
        : denial === CAP_INVOKE_OTHER_AGENTS
          ? "invoke_other_agents_required"
          : "invoke_agents_required",
      capability: denial === "agent_target_unavailable" || denial === "invocation_access_withdrawn"
        ? CAP_INVOKE_AGENTS
        : denial,
      humanUserId: input.humanUserId,
      origin: input.origin,
      roomId: input.roomId,
      agentId: input.agentId,
    });
  }
}

/**
 * The caller supplied an exact Genie id, but current canonical ownership could
 * not resolve it. This is separate from a missing Capability: even a Human who
 * may invoke other Genies cannot authorize a nonexistent target.
 */
export class AgentInvocationTargetUnavailableError extends AgentInvocationDeniedError {
  override readonly name = "AgentInvocationTargetUnavailableError";

  constructor(input: AgentInvocationAdmissionInput & { readonly agentId: string }) {
    super(input, "agent_target_unavailable");
  }
}

export class ServerProviderCredentialsDeniedError extends ActionCapabilityDeniedError {
  override readonly name = "ServerProviderCredentialsDeniedError";

  constructor(humanUserId: string, origin?: ServerProviderCredentialOrigin) {
    super({
      code: "server_provider_credentials_required",
      capability: CAP_USE_SERVER_PROVIDER_CREDENTIALS,
      humanUserId,
      origin: origin ?? "server_provider_credentials",
    });
  }
}

export interface AgentInvocationTargetUnavailableHttpDenial {
  readonly error: "agent_target_unavailable";
  readonly code: "agent_target_unavailable";
}

export function toAgentInvocationTargetUnavailableHttpDenial(
  _error: AgentInvocationTargetUnavailableError,
): AgentInvocationTargetUnavailableHttpDenial {
  return {
    error: "agent_target_unavailable",
    code: "agent_target_unavailable",
  };
}

export class ArtifactWriteDeniedError extends ActionCapabilityDeniedError {
  override readonly name = "ArtifactWriteDeniedError";

  constructor(input: ArtifactWriteAdmissionInput) {
    super({
      code: "write_artifacts_required",
      capability: CAP_WRITE_ARTIFACTS,
      humanUserId: input.humanUserId,
      origin: "artifact_write",
      roomId: input.roomId,
      namespaceId: input.namespaceId,
      artifactId: input.artifactId,
    });
  }
}

async function hasCapability(
  deps: ActionCapabilityAdmissionDeps,
  humanUserId: string,
  capability: CapabilitySlug,
): Promise<boolean> {
  const capabilities = await deps.getUserCapabilities(humanUserId);
  return capabilities.includes(capability);
}

/** Resolve current capability and moderation admission for one Human invocation. */
export async function assertCanInvokeAgent(
  input: AgentInvocationAdmissionInput,
  deps: ActionCapabilityAdmissionDeps = DEFAULT_DEPS,
): Promise<void> {
  if (!input.humanUserId.trim()) throw new AgentInvocationDeniedError(input);
  const capabilities = await deps.getUserCapabilities(input.humanUserId);
  if (!capabilities.includes(CAP_INVOKE_AGENTS)) {
    throw new AgentInvocationDeniedError(input);
  }

  if (!(await deps.isInvocationAccessAllowed(input))) {
    throw new AgentInvocationDeniedError(input, "invocation_access_withdrawn");
  }

  // A pre-routing check intentionally omits agentId and establishes only the
  // base ability to invoke Genies. Once routing resolves an exact target, every
  // dispatch/resume seam presents it here so ownership cannot be inferred from
  // a Room, Agent actor, prior acceptance token, or the caller's highest Role.
  if (input.agentId === undefined) return;

  let ownerUserId: string | null;
  try {
    ownerUserId = await deps.findAgentOwnerUserId(input.agentId);
  } catch (error) {
    if (error instanceof AmbiguousAgentOwnerError) {
      throw new AgentInvocationTargetUnavailableError({ ...input, agentId: input.agentId });
    }
    throw error;
  }
  if (ownerUserId === null) {
    throw new AgentInvocationTargetUnavailableError({ ...input, agentId: input.agentId });
  }
  if (
    ownerUserId !== input.humanUserId &&
    !capabilities.includes(CAP_INVOKE_OTHER_AGENTS)
  ) {
    throw new AgentInvocationDeniedError(input, CAP_INVOKE_OTHER_AGENTS);
  }
}

/** Resolve current Human authority before any server-funded provider dispatch. */
export async function assertCanUseServerProviderCredentials(
  humanUserId: string,
  origin?: ServerProviderCredentialOrigin,
  deps: Pick<ActionCapabilityAdmissionDeps, "getUserCapabilities"> = DEFAULT_DEPS,
): Promise<void> {
  if (!humanUserId.trim()) {
    throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
  }
  if (
    !(await deps.getUserCapabilities(humanUserId)).includes(
      CAP_USE_SERVER_PROVIDER_CREDENTIALS,
    )
  ) {
    throw new ServerProviderCredentialsDeniedError(humanUserId, origin);
  }
}

/** Dormant in M246: resolve current RBAC authority for one Human Artifact write. */
export async function assertCanWriteArtifacts(
  input: ArtifactWriteAdmissionInput,
  deps: ActionCapabilityAdmissionDeps = DEFAULT_DEPS,
): Promise<void> {
  if (!(await hasCapability(deps, input.humanUserId, CAP_WRITE_ARTIFACTS))) {
    throw new ArtifactWriteDeniedError(input);
  }
}

export interface ActionCapabilityHttpDenial {
  readonly error: ActionCapabilityDenialCode;
  readonly code: ActionCapabilityDenialCode;
  readonly capability: CapabilitySlug;
}

/** Pure future HTTP-adapter mapping; it does not send a response. */
export function toActionCapabilityHttpDenial(
  error: ActionCapabilityDeniedError,
): ActionCapabilityHttpDenial {
  return {
    error: error.code,
    code: error.code,
    capability: error.capability,
  };
}

export interface ActionCapabilityDenialDiagnostic {
  readonly event: "action_capability_denied";
  readonly code: ActionCapabilityDenialCode;
  readonly capability: CapabilitySlug;
  readonly humanUserId: string;
  readonly origin: string;
  readonly occurredAt: string;
  readonly roomId?: string;
  readonly agentId?: string;
  readonly namespaceId?: string;
  readonly artifactId?: string;
}

/**
 * Pure future diagnostic/audit mapping. Only bounded routing identifiers are
 * admitted; content, tool arguments, credentials, and secrets have no input
 * field and therefore cannot be copied into the result.
 */
export function toActionCapabilityDenialDiagnostic(
  error: ActionCapabilityDeniedError,
  occurredAt: Date,
): ActionCapabilityDenialDiagnostic {
  return {
    event: "action_capability_denied",
    code: error.code,
    capability: error.capability,
    humanUserId: error.humanUserId,
    origin: error.origin,
    occurredAt: occurredAt.toISOString(),
    ...(error.roomId === undefined ? {} : { roomId: error.roomId }),
    ...(error.agentId === undefined ? {} : { agentId: error.agentId }),
    ...(error.namespaceId === undefined
      ? {}
      : { namespaceId: error.namespaceId }),
    ...(error.artifactId === undefined
      ? {}
      : { artifactId: error.artifactId }),
  };
}
