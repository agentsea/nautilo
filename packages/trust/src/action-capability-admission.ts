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
  CAP_WRITE_ARTIFACTS,
} from "./capabilities";
import { getUserCapabilities } from "./queries";

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
}

export interface ArtifactWriteAdmissionInput {
  /** Canonical Human subject (`users.id`), never an Actor id or Role label. */
  readonly humanUserId: string;
  readonly roomId?: string;
  readonly namespaceId?: string;
  readonly artifactId?: string;
}

export interface ActionCapabilityAdmissionDeps {
  getUserCapabilities(humanUserId: string): Promise<string[]>;
}

const DEFAULT_DEPS: ActionCapabilityAdmissionDeps = {
  getUserCapabilities,
};

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

/** Trusted admission seam. Call only after every gate for the unit succeeds. */
export function createAcceptedInvocationAuthority(
  humanUserId: string,
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
  return Object.freeze(authority) as AcceptedInvocationAuthority;
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
  | "invoke_agents_required"
  | "write_artifacts_required";

interface ActionCapabilityDeniedErrorOptions {
  readonly code: ActionCapabilityDenialCode;
  readonly capability: CapabilitySlug;
  readonly humanUserId: string;
  readonly origin: AgentInvocationOrigin | "artifact_write";
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
  readonly origin: AgentInvocationOrigin | "artifact_write";
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
  override readonly name = "AgentInvocationDeniedError";

  constructor(input: AgentInvocationAdmissionInput) {
    super({
      code: "invoke_agents_required",
      capability: CAP_INVOKE_AGENTS,
      humanUserId: input.humanUserId,
      origin: input.origin,
      roomId: input.roomId,
      agentId: input.agentId,
    });
  }
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

/** Resolve current RBAC authority for one Human invocation. */
export async function assertCanInvokeAgent(
  input: AgentInvocationAdmissionInput,
  deps: ActionCapabilityAdmissionDeps = DEFAULT_DEPS,
): Promise<void> {
  if (!(await hasCapability(deps, input.humanUserId, CAP_INVOKE_AGENTS))) {
    throw new AgentInvocationDeniedError(input);
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
  readonly origin: AgentInvocationOrigin | "artifact_write";
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
