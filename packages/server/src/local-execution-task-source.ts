import { roomGraphThreadFromLaneThread } from "@nautilo/agent";
import { getEncryptionTransitionPolicy, getTaskById, type Task } from "@nautilo/db";
import { withInitialTaskRuntimeRecipientAuthority, type InitialTaskRuntimeRecipientAuthority } from "@nautilo/lattice-bridge/server";
import type { DelegatedTaskIdentity } from "@nautilo/runtime";
import { assertCanInvokeAgent, findActorByOwnerId, findRoomIdByGraphThreadIdForUser, getRoomDetailForMember, getUserCapabilities } from "@nautilo/trust";
import { parseLocalExecutionDelegation, type LocalExecutionDelegation } from "@nautilo/types";
import { getServerDirectDb } from "./lib/server-direct-db";

export type TaskLocalExecutionSourceRecord = DelegatedTaskIdentity & Pick<Task,
  "contentNamespaceId" | "cryptoObjectId" | "cryptoAccessRevision" | "cryptoRequiredNamespaceFingerprint" | "cryptoMappingState">;
export interface TaskLocalExecutionSourcePolicy {
  readonly mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  readonly shadowBehavior: "fallback" | "strict";
  readonly revision: number;
}
type PublicAuthorityInput = Omit<Parameters<typeof withInitialTaskRuntimeRecipientAuthority>[0], "use" | "signal">;
/** Original admitted public facts, loaded through the existing protected owner.
 * They must not be replaced with today's device/namespace revisions. No Task
 * plaintext, private key, or content-opening lease belongs in this proof. */
export interface ProtectedTaskLocalExecutionSourceProof {
  readonly task: TaskLocalExecutionSourceRecord;
  readonly delegation: LocalExecutionDelegation;
  readonly policy: TaskLocalExecutionSourcePolicy;
  readonly authority: PublicAuthorityInput;
  readonly device: InitialTaskRuntimeRecipientAuthority["device"];
}
interface SourceRoom {
  readonly id: string;
  readonly graphThreadId: string;
  readonly members: readonly { readonly kind: string; readonly agentId?: string | null; readonly actorId: string }[];
}
export interface TaskLocalExecutionSourceAssertionDeps {
  readonly signal?: AbortSignal;
  readTask?(this: void, id: string): Promise<TaskLocalExecutionSourceRecord | undefined>;
  readPolicy?(this: void): Promise<TaskLocalExecutionSourcePolicy>;
  assertInvocation?: typeof assertCanInvokeAgent;
  getCapabilities?(this: void, humanUserId: string): Promise<readonly string[]>;
  findHuman?(this: void, humanUserId: string): Promise<{ readonly id: string } | null>;
  findRoom?(this: void, roomId: string, humanActorId: string): Promise<SourceRoom | null>;
  findRoomByThread?(this: void, humanUserId: string, graphThreadId: string): Promise<string | null>;
  /** Freshly load the original metadata proof through its trusted owner.
   * Absence is a refusal, including dormant protected Task composition. */
  readProtectedSource?(task: TaskLocalExecutionSourceRecord): Promise<ProtectedTaskLocalExecutionSourceProof | null>;
  withProtectedAuthority?: typeof withInitialTaskRuntimeRecipientAuthority;
}
const unavailable = () => new Error("TASK_LOCAL_EXECUTION_SOURCE_UNAVAILABLE");
const canonical = (value: unknown): unknown => value instanceof Uint8Array ? [...value]
  : Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const definition = (task: DelegatedTaskIdentity) => ({ id: task.id, ownerId: task.ownerId, requestorId: task.requestorId,
  agentId: task.agentId, callingRoomId: task.callingRoomId, parentTaskId: task.parentTaskId, scheduleKind: task.scheduleKind,
  contentRepresentation: task.contentRepresentation, contentRevision: task.contentRevision, localExecutionDelegation: task.localExecutionDelegation });
const protectedDefinition = (task: TaskLocalExecutionSourceRecord) => ({ ...definition(task), contentNamespaceId: task.contentNamespaceId,
  cryptoObjectId: task.cryptoObjectId, cryptoAccessRevision: task.cryptoAccessRevision,
  cryptoRequiredNamespaceFingerprint: task.cryptoRequiredNamespaceFingerprint, cryptoMappingState: task.cryptoMappingState });

/** Operation-time source proof only. It neither starts protected Tasks nor
 * renews a recipient grant, and releases canonical locks before returning. */
export function createTaskLocalExecutionSourceAssertion(deps: TaskLocalExecutionSourceAssertionDeps = {}):
  (task: DelegatedTaskIdentity) => Promise<void> {
  const readTask = deps.readTask ?? (id => getTaskById(getServerDirectDb(), id));
  const readPolicy = deps.readPolicy ?? (() => getEncryptionTransitionPolicy(getServerDirectDb()));
  const assertInvocation = deps.assertInvocation ?? assertCanInvokeAgent;
  const getCapabilities = deps.getCapabilities ?? getUserCapabilities;
  const findHuman = deps.findHuman ?? findActorByOwnerId;
  const findRoom = deps.findRoom ?? getRoomDetailForMember;
  const findRoomByThread = deps.findRoomByThread ?? findRoomIdByGraphThreadIdForUser;
  const withAuthority = deps.withProtectedAuthority ?? withInitialTaskRuntimeRecipientAuthority;
  return async observed => {
    const task = structuredClone(observed);
    const delegation = parseLocalExecutionDelegation(task.localExecutionDelegation);
    if (!delegation || delegation.humanUserId !== task.requestorId || delegation.agentId !== task.agentId
      || !task.callingRoomId) throw unavailable();
    const inspect = async () => {
      deps.signal?.throwIfAborted();
      const policy = await readPolicy();
      const current = await readTask(task.id);
      if (!current || !same(definition(task), definition(current))) throw unavailable();
      await assertInvocation({ humanUserId: delegation.humanUserId, agentId: task.agentId,
        roomId: task.callingRoomId!, origin: "task_dispatch", taskId: task.id });
      if (!(await getCapabilities(delegation.humanUserId)).includes("use_workstation")) throw unavailable();
      const human = await findHuman(delegation.humanUserId);
      if (!human) throw unavailable();
      const source = await findRoom(delegation.sourceRoomId, human.id);
      const calling = task.callingRoomId === delegation.sourceRoomId ? source : await findRoom(task.callingRoomId!, human.id);
      const thread = roomGraphThreadFromLaneThread(delegation.sourceConversationId);
      if (!source || source.id !== delegation.sourceRoomId || source.graphThreadId !== thread
        || await findRoomByThread(delegation.humanUserId, thread) !== source.id
        || !calling || calling.id !== task.callingRoomId
        || !calling.members.some(member => member.kind === "agent" && member.agentId === task.agentId)) throw unavailable();
      deps.signal?.throwIfAborted();
      return { policy, current, human, source: { id: source.id, graphThreadId: source.graphThreadId },
        calling: { id: calling.id, graphThreadId: calling.graphThreadId,
          agentActorId: calling.members.find(member => member.kind === "agent" && member.agentId === task.agentId)!.actorId } };
    };
    const before = await inspect();
    if (before.current.contentRepresentation === "ordinary") {
      if (before.policy.mode !== "plaintext_only"
        && !(before.policy.mode === "shadow_encryption" && before.policy.shadowBehavior === "fallback")) throw unavailable();
    } else {
      const borrowed = await deps.readProtectedSource?.(before.current);
      if (!borrowed) throw unavailable();
      // Isolate public expected facts before the owner's asynchronous checks.
      const expected = structuredClone({ task: borrowed.task, delegation: borrowed.delegation, policy: borrowed.policy, device: borrowed.device });
      const authority: PublicAuthorityInput = { ...borrowed.authority,
        namespaceIds: [...borrowed.authority.namespaceIds],
        namespaceRequirements: structuredClone(borrowed.authority.namespaceRequirements),
        domainRequirements: structuredClone(borrowed.authority.domainRequirements) };
      if (!same(protectedDefinition(expected.task), protectedDefinition(before.current))
        || !same(expected.delegation, delegation) || !same(expected.policy, before.policy)
        || authority.taskId !== task.id || authority.requesterUserId !== delegation.humanUserId
        || authority.requesterHumanId !== before.human.id || authority.agentId !== task.agentId
        || authority.contentNamespaceId !== before.current.contentNamespaceId
        || authority.expectedPolicyRevision !== before.policy.revision
        || expected.device.userId !== delegation.humanUserId || expected.device.humanActorId !== before.human.id
        || authority.deviceId !== expected.device.deviceId || before.current.cryptoMappingState !== "verified"
        || (before.current.contentRepresentation === "dual" ? before.policy.mode !== "shadow_encryption" : before.policy.mode !== "encrypted_only")) throw unavailable();
      const current = await withAuthority({ ...authority, ...(deps.signal ? { signal: deps.signal } : {}),
        use: held => same(held.device, expected.device)
          && held.policyRevision === expected.policy.revision
          && held.sourceRoomId === authority.sourceRoomId && held.sourceNamespaceId === authority.contentNamespaceId
          && same(held.namespaceRequirements, authority.namespaceRequirements)
          && held.domains.every(domain => authority.domainRequirements.some(required => required.domainId === domain.domainId
            && required.expectedEpoch === domain.domainKeyGeneration && required.expectedAuthorizationRevision === domain.authorizationRevision))
          && held.domains.length === authority.domainRequirements.length });
      if (current !== true) throw unavailable();
    }
    const after = await inspect();
    if (!same(before.policy, after.policy) || !same(protectedDefinition(before.current), protectedDefinition(after.current))
      || !same(before.source, after.source) || !same(before.calling, after.calling) || before.human.id !== after.human.id) throw unavailable();
  };
}
