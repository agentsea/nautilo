import { createHash, randomUUID } from "node:crypto";
import {
  acquireEncryptionConsumptionFence, contentAccessOperations, getSharedDirectDb,
  RoomAuthorityChangedError,
  rooms, actors, users, eq, inArray,
  type InviteSeedTx,
} from "@nautilo/db";
import { ContentAccessAuthorityError, lockContentAccessAuthorityInTx,
  type ContentAccessPrincipal } from "./content-access-authority";
import { ContentAccessPlanError, planContentAccessChange,
  type ContentAccessChange, type ContentAccessMutationPlan } from "./content-access-plan";
import { createContentAccessPreviewCodec } from "./content-access-preview";
import { ContentAccessReplayBindingError, findContentAccessReplayInTx,
  publishContentAccessPlanDetailedInTx,
  type ContentAccessReceipt, type DetailedContentAccessPublication } from "./content-access-publication";

export type ContentAccessCommand = Readonly<{
  operationId: string;
  object: Readonly<{ kind: "memory" | "artifact"; id: string }>;
  change:
    | Readonly<{ kind: "grant_people"; selectedActorIds: readonly string[] }>
    | Readonly<{ kind: "grant_room"; targetRoomId: string }>
    | Readonly<{ kind: "remove_person"; actorId: string }>
    | Readonly<{ kind: "detach_room"; targetRoomId: string }>
    | Readonly<{ kind: "make_private" }>;
}>;

export type ContentAccessAdmission = Readonly<{
  principal: ContentAccessPrincipal;
  /** Route/tool-owned contract, never a raw client/model audience override.
   * Frozen legacy personal grant routes alone select requester+recipient. */
  audienceContract: "invoking_room" | "legacy_personal_grant";
  /** Trusted adapter-owned sensitivity/ask/prove-it/PIN policy commitment.
   * Never derive this from raw request/model arguments. Preparing is not
   * consent: the caller must complete its current admission before commit. */
  approvalContext: string;
}>;

/** Fresh, committed ordinary Artifact-sharing facts for one trusted
 * post-transaction consumer. This is not a receipt, access proof, or wire DTO. */
export type CommittedArtifactShareEffect = Readonly<{
  operationId: string;
  requester:
    | Readonly<{ kind: "human"; userId: string; actorId: string }>
    | Readonly<{ kind: "agent"; userId: string; actorId: string; agentId: string }>;
  artifactId: string;
  target:
    | Readonly<{ kind: "people"; personActorIds: readonly string[] }>
    | Readonly<{ kind: "room"; roomId: string }>;
}>;

export type ObserveCommittedArtifactShareEffects = (
  effect: CommittedArtifactShareEffect,
) => void | Promise<void>;

export type ContentAccessCoordinatorOptions = Readonly<{
  observeCommittedArtifactShares?: ObserveCommittedArtifactShareEffects;
}>;

export type ContentAccessFailure = Readonly<{
  outcome: "denied" | "stale" | "failed";
  /** A connection failure can leave commit uncertain until receipt recovery. */
  stateChanged: false | "unknown";
  receiptPersisted: false;
  recovery: "prepare_again" | "retry_receipt" | "retry_operation";
}>;

export type ContentAccessPreparation = Readonly<{
  outcome: "prepared";
  previewToken: string;
  expiresAt: number;
  /** Normalized command, safe to carry with the signed preview. No Namespace IDs. */
  command: ContentAccessCommand;
  /** Authorized transient display from the exact signed object snapshot.
   * Adapters must explicitly project it; never persist raw Memory content in
   * an approval binding or include it in an HTTP response by spreading this. */
  display: Awaited<ReturnType<typeof lockContentAccessAuthorityInTx>>["display"];
  preview: Readonly<{
    humanActorIds: readonly string[];
    /** Labels for exactly the approved Actor set, read within preparation's transaction. */
    people: readonly Readonly<{ actorId: string; displayName: string; userHandle: string | null }>[];
    targetRoomId?: string;
    targetRoomLabel?: string;
    publicRoom: boolean;
    skippedAttachmentCount: number;
  }>;
}>;

export type LegacyHumanContentAccessResult =
  | Readonly<{
    kind: "completed";
    receipt: ContentAccessReceipt;
    /** Authorized transient facts for the exact frozen response adapter. */
    details: Readonly<{
      destinations: readonly (DetailedContentAccessPublication["destinations"][number] & Readonly<{ label: string }>)[];
      accounting: DetailedContentAccessPublication["accounting"];
    }>;
  }>
  | Readonly<{ kind: "receipt_only"; receipt: ContentAccessReceipt }>
  | ContentAccessFailure;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function canonicalCommand(input: ContentAccessCommand): ContentAccessCommand {
  if (!UUID.test(input.operationId) || !UUID.test(input.object.id)
    || !["memory", "artifact"].includes(input.object.kind)) {
    throw new ContentAccessAuthorityError("denied");
  }
  let change: ContentAccessCommand["change"];
  switch (input.change.kind) {
    case "grant_people": {
      const selectedActorIds = [...new Set(input.change.selectedActorIds)].sort();
      if (!selectedActorIds.length || selectedActorIds.some((id) => !UUID.test(id))) {
        throw new ContentAccessAuthorityError("denied");
      }
      change = { kind: "grant_people", selectedActorIds: Object.freeze(selectedActorIds) };
      break;
    }
    case "grant_room":
    case "detach_room":
      if (!UUID.test(input.change.targetRoomId)) throw new ContentAccessAuthorityError("denied");
      change = { kind: input.change.kind, targetRoomId: input.change.targetRoomId };
      break;
    case "remove_person":
      if (!UUID.test(input.change.actorId)) throw new ContentAccessAuthorityError("denied");
      change = { kind: "remove_person", actorId: input.change.actorId };
      break;
    case "make_private": change = { kind: "make_private" }; break;
    default: throw new ContentAccessAuthorityError("denied");
  }
  return Object.freeze({ operationId: input.operationId,
    object: Object.freeze({ kind: input.object.kind, id: input.object.id }),
    change: Object.freeze(change) });
}

function intentDigest(admission: ContentAccessAdmission, command: ContentAccessCommand) {
  const p = admission.principal;
  if (!admission.approvalContext || !UUID.test(p.userId) || !UUID.test(p.actorId)
    || !UUID.test(p.sourceRoomId) || !["human", "agent"].includes(p.kind)
    || (p.kind === "agent" && !p.agentId)
    || !["invoking_room", "legacy_personal_grant"].includes(admission.audienceContract)
    || (admission.audienceContract === "legacy_personal_grant"
      && (command.change.kind !== "grant_people" || p.kind !== "human"))) {
    throw new ContentAccessAuthorityError("denied");
  }
  return digest({ principal: { kind: p.kind, userId: p.userId, actorId: p.actorId,
    sourceRoomId: p.sourceRoomId, agentId: p.agentId ?? null },
  command, audienceContract: admission.audienceContract, approvalContext: admission.approvalContext });
}

async function currentPlan(tx: InviteSeedTx, admission: ContentAccessAdmission, command: ContentAccessCommand) {
  const authority = await lockContentAccessAuthorityInTx(tx, {
    principal: admission.principal, object: command.object,
    intent: {
      additive: command.change.kind === "grant_people" || command.change.kind === "grant_room",
      ...(command.change.kind === "grant_room" || command.change.kind === "detach_room"
        ? { targetRoomId: command.change.targetRoomId } : {}),
      ...(command.change.kind === "make_private" ? { makePrivate: true } : {}),
      ...(command.change.kind === "grant_people" ? {
        selectedActorIds: command.change.selectedActorIds,
        legacyPersonalGrant: admission.audienceContract === "legacy_personal_grant",
      } : {}),
    },
  });
  // Legacy routes have explicit requester+recipient semantics, while current
  // source authorization and its complete snapshot remain bound below.
  const planningContext = admission.audienceContract === "legacy_personal_grant"
    ? { roomId: authority.sourceContext.roomId, humanActorIds: [admission.principal.actorId] }
    : authority.sourceContext;
  let change: ContentAccessChange;
  const { target, humans } = authority;
  switch (command.change.kind) {
    case "grant_people":
      change = command.change;
      break;
    case "grant_room":
    case "detach_room":
      if (!target) throw new ContentAccessAuthorityError("stale");
      change = command.change.kind === "grant_room"
        ? { kind: "grant_room", targetRoom: target.destination }
        : { kind: "detach_room", targetRoomId: target.destination.roomId };
      break;
    case "remove_person":
      change = { kind: "remove_person", targetActorId: command.change.actorId };
      break;
    case "make_private":
      if (!target) throw new ContentAccessAuthorityError("stale");
      change = command.change;
      break;
  }
  const plan = planContentAccessChange({
    object: authority.object, requesterActorId: admission.principal.actorId,
    sourceContext: planningContext, attachments: authority.attachments,
    change, ...(command.change.kind === "make_private" && target
      ? { privateDestination: target.destination } : {}),
  });
  // Additive grants bind the approved audience, not unrelated attachments or
  // whether its exact immutable boundary happens to have been created already.
  // Removal must bind all inspected access facts, including preserved ones.
  const destructive = command.change.kind !== "grant_people" && command.change.kind !== "grant_room";
  return {
    plan,
    display: authority.display,
    requestDigest: digest({
      intentDigest: intentDigest(admission, command), object: authority.object,
      sourceAuthorityDigest: authority.sourceAuthorityDigest,
      sourceContext: authority.sourceContext, policyRevision: authority.policyRevision,
      target, humans,
      ...(destructive ? { attachments: [...authority.attachments]
        .sort((a, b) => a.namespaceId.localeCompare(b.namespaceId)),
      plan: semanticPlan(plan) } : {}),
    }),
    preview: Object.freeze({
      humanActorIds: Object.freeze(command.change.kind === "grant_people"
        ? [...new Set([...planningContext.humanActorIds, ...command.change.selectedActorIds])].sort()
        : target?.destination.humanActorIds ?? []),
      ...(target ? { targetRoomId: target.destination.roomId } : {}),
      publicRoom: target?.authority.ownerKind === "open",
      skippedAttachmentCount: plan.accounting.skippedAttachmentCount,
    }),
  };
}

function semanticPlan(plan: ContentAccessMutationPlan) {
  return { attach: plan.attachDestinations, detach: plan.detachNamespaceIds,
    accounting: plan.accounting };
}

function failure(error: unknown): ContentAccessFailure {
  if (isTransientTransactionAbort(error)) {
    return { outcome: "failed", stateChanged: false, receiptPersisted: false, recovery: "retry_operation" };
  }
  const outcome = error instanceof ContentAccessAuthorityError
    ? error.reason === "stale" || error.reason === "wrong_mode" ? "stale" : "denied"
    : error instanceof RoomAuthorityChangedError ? "stale"
    : error instanceof ContentAccessPlanError || error instanceof ContentAccessReplayBindingError ? "denied" : "failed";
  return { outcome, stateChanged: false, receiptPersisted: false, recovery: "prepare_again" };
}

function isTransientTransactionAbort(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const cause = current as { code?: unknown; cause?: unknown };
    if (cause.code === "40P01" || cause.code === "40001") return true;
    current = cause.cause;
  }
  return false;
}

function projectCommittedArtifactShareEffect(
  admission: ContentAccessAdmission,
  command: ContentAccessCommand,
  publication: DetailedContentAccessPublication,
): CommittedArtifactShareEffect | undefined {
  if (command.object.kind !== "artifact" || publication.freshDestinations.length === 0) {
    return undefined;
  }
  const principal = admission.principal;
  // Agent admission is authorized by the invoking Human Actor and proves the
  // participating Agent separately. Preserve both identities for attribution.
  const requester: CommittedArtifactShareEffect["requester"] = principal.kind === "agent"
    ? Object.freeze({ kind: "agent", userId: principal.userId,
      actorId: principal.actorId, agentId: principal.agentId })
    : Object.freeze({ kind: "human", userId: principal.userId, actorId: principal.actorId });
  if (command.change.kind === "grant_people") {
    return Object.freeze({
      operationId: command.operationId,
      requester,
      artifactId: command.object.id,
      target: Object.freeze({
        kind: "people" as const,
        personActorIds: Object.freeze([...command.change.selectedActorIds]),
      }),
    });
  }
  if (command.change.kind === "grant_room") {
    const targetRoomId = command.change.targetRoomId;
    if (!publication.freshDestinations.some((destination) =>
      destination.roomId === targetRoomId)) return undefined;
    return Object.freeze({
      operationId: command.operationId,
      requester,
      artifactId: command.object.id,
      target: Object.freeze({ kind: "room" as const, roomId: targetRoomId }),
    });
  }
  return undefined;
}

async function recoverContentAccessFailure(
  admission: ContentAccessAdmission, command: ContentAccessCommand, requestDigest: string, error: unknown,
): Promise<ContentAccessReceipt | ContentAccessFailure> {
  const rejected = failure(error);
  if (error instanceof ContentAccessReplayBindingError) return rejected;
  const replayInput = { operationId: command.operationId, requestDigest,
    requesterUserId: admission.principal.userId, requesterActorId: admission.principal.actorId };
  try {
    return await getSharedDirectDb().transaction(async (tx) => {
      await acquireEncryptionConsumptionFence(tx);
      const replay = await findContentAccessReplayInTx(tx, replayInput);
      if (replay) return replay;
      // A PostgreSQL abort already rolled back this attempt. Recover the
      // exact receipt first, then leave concurrency failures nonterminal.
      if (isTransientTransactionAbort(error)) return rejected;
      await tx.insert(contentAccessOperations).values({ ...replayInput,
        memoryId: command.object.kind === "memory" ? command.object.id : null,
        artifactId: command.object.kind === "artifact" ? command.object.id : null,
        outcome: rejected.outcome, changed: false, attachedCount: 0, detachedCount: 0, skippedCount: 0 });
      return { operationId: command.operationId, outcome: rejected.outcome,
        stateChanged: false, originalStateChanged: false, replayed: false,
        attachedCount: 0, detachedCount: 0, skippedCount: 0 };
    });
  } catch {
    return { ...rejected,
      stateChanged: isTransientTransactionAbort(error) ? false : rejected.outcome === "failed" ? "unknown" : false,
      recovery: isTransientTransactionAbort(error) ? "retry_operation"
        : rejected.outcome === "failed" ? "retry_receipt" : "prepare_again" };
  }
}

/** Ordinary-only transaction owner. Adapters own authentication and current
 * caller-specific consent. The codec is composed with a stable instance key.
 * Terminal receipts convey history, never a new permission or a fresh grant. */
export function createContentAccessCoordinator(
  codec: ReturnType<typeof createContentAccessPreviewCodec>,
  options: ContentAccessCoordinatorOptions = {},
) {
  const observeCommittedArtifactShare = async (effect: CommittedArtifactShareEffect | undefined) => {
    if (!effect || !options.observeCommittedArtifactShares) return;
    try {
      await options.observeCommittedArtifactShares(effect);
    } catch {
      // Sharing is already committed. Its optional best-effort consumer cannot
      // fail, roll back, or make the business result appear unsuccessful.
    }
  };
  return Object.freeze({
    async prepare(admission: ContentAccessAdmission, input: ContentAccessCommand): Promise<ContentAccessPreparation | ContentAccessFailure> {
      try {
        const command = canonicalCommand(input);
        const intent = intentDigest(admission, command);
        const prepared = await getSharedDirectDb().transaction(async (tx) => {
          const current = await currentPlan(tx, admission, command);
          const actorIds = current.preview.humanActorIds;
          const people = actorIds.length ? await tx.select({ actorId: actors.id,
            displayName: users.name, userHandle: users.handle }).from(actors)
            .innerJoin(users, eq(users.id, actors.ownerId)).where(inArray(actors.id, actorIds))
            .orderBy(actors.id) : [];
          if (people.length !== actorIds.length) throw new ContentAccessAuthorityError("stale");
          const targetRoomId = current.preview.targetRoomId;
          const [targetRoom] = targetRoomId ? await tx.select({ label: rooms.label }).from(rooms)
            .where(eq(rooms.id, targetRoomId)) : [];
          if (targetRoomId && !targetRoom) throw new ContentAccessAuthorityError("stale");
          return { ...current, preview: { ...current.preview, people,
            ...(targetRoom ? { targetRoomLabel: targetRoom.label } : {}) } };
        });
        const previewToken = codec.issue({ operationId: command.operationId,
          intentDigest: intent, requestDigest: prepared.requestDigest });
        const signed = codec.verify(previewToken);
        if (signed.status !== "valid") throw new ContentAccessAuthorityError("stale");
        return { outcome: "prepared", command, preview: prepared.preview, display: prepared.display,
          previewToken, expiresAt: signed.claims.expiresAt };
      } catch (error) { return failure(error); }
    },

    /** Frozen Human routes alone use this synchronous admission path. The
     * HTTP request already supplies its existing consent contract. Separate
     * old-client requests have separate identities; they do not acquire the
     * new preview protocol's cross-request exact-operation replay guarantee. */
    async executeLegacyHuman(
      admission: ContentAccessAdmission,
      input: Omit<ContentAccessCommand, "operationId">,
    ): Promise<LegacyHumanContentAccessResult> {
      let command: ContentAccessCommand;
      let requestDigest: string;
      try {
        if (admission.principal.kind !== "human") throw new ContentAccessAuthorityError("denied");
        command = canonicalCommand({ operationId: randomUUID(), object: input.object, change: input.change });
        requestDigest = digest({ legacyIntent: intentDigest(admission, command) });
      } catch (error) { return failure(error); }
      let candidate: Extract<LegacyHumanContentAccessResult, { kind: "completed" }> | undefined;
      let committedEffect: CommittedArtifactShareEffect | undefined;
      try {
        const result = await getSharedDirectDb().transaction(async (tx) => {
          await acquireEncryptionConsumptionFence(tx);
          const replay = await findContentAccessReplayInTx(tx, {
            operationId: command.operationId, requestDigest,
            requesterUserId: admission.principal.userId, requesterActorId: admission.principal.actorId,
          });
          if (replay) return { kind: "receipt_only" as const, receipt: replay };
          const current = await currentPlan(tx, admission, command);
          requestDigest = current.requestDigest;
          const published = await publishContentAccessPlanDetailedInTx(tx, {
            operationId: command.operationId, requestDigest,
            requesterUserId: admission.principal.userId, plan: current.plan,
          });
          // Destination identities are already authorized by this plan. Load
          // only their labels for the old DTO, inside the publishing transaction.
          const roomIds = [...new Set(published.destinations.map((destination) => destination.roomId))];
          const labels = roomIds.length ? await tx.select({ id: rooms.id, label: rooms.label }).from(rooms)
            .where(inArray(rooms.id, roomIds)) : [];
          const byId = new Map(labels.map((room) => [room.id, room.label]));
          const destinations = published.destinations.map((destination) => {
            const label = byId.get(destination.roomId);
            if (label === undefined) throw new ContentAccessAuthorityError("stale");
            return Object.freeze({ ...destination, label });
          });
          candidate = Object.freeze({ kind: "completed", receipt: published.receipt,
            details: Object.freeze({ destinations: Object.freeze(destinations), accounting: published.accounting }) });
          committedEffect = projectCommittedArtifactShareEffect(admission, command, published);
          return candidate;
        });
        await observeCommittedArtifactShare(committedEffect);
        return result;
      } catch (error) {
        const recovered = await recoverContentAccessFailure(admission, command, requestDigest, error);
        if (!("operationId" in recovered)) return recovered;
        // Invocation-local details are reusable only after the exact receipt
        // proves the original transaction committed. Never recreate missing
        // historical minted/label facts by planning or publishing again.
        if (candidate && recovered.replayed && recovered.outcome === candidate.receipt.outcome
          && recovered.originalStateChanged === candidate.receipt.originalStateChanged
          && recovered.attachedCount === candidate.receipt.attachedCount
          && recovered.detachedCount === candidate.receipt.detachedCount
          && recovered.skippedCount === candidate.receipt.skippedCount) {
          return Object.freeze({ ...candidate, receipt: recovered });
        }
        return { kind: "receipt_only", receipt: recovered };
      }
    },

    /** A historical success is not permission to send an Artifact card today.
     * Reuse the signed revision/audience and current locked planner facts, but
     * never publish, re-prepare, or extend an expired grant during this proof. */
    async verifyPreparedGrantForContact(admission: ContentAccessAdmission, input: ContentAccessCommand,
      previewToken: string): Promise<boolean> {
      try {
        const command = canonicalCommand(input);
        const verified = codec.verify(previewToken);
        if (admission.principal.kind !== "agent" || admission.audienceContract !== "invoking_room"
          || command.object.kind !== "artifact" || command.change.kind !== "grant_people"
          || verified.status === "invalid" || verified.claims.operationId !== command.operationId
          || verified.claims.intentDigest !== intentDigest(admission, command)) return false;
        return await getSharedDirectDb().transaction(async (tx) => {
          await acquireEncryptionConsumptionFence(tx);
          const receipt = await findContentAccessReplayInTx(tx, {
            operationId: command.operationId, requestDigest: verified.claims.requestDigest,
            requesterUserId: admission.principal.userId, requesterActorId: admission.principal.actorId,
          });
          if (!receipt || !["applied", "already_applied"].includes(receipt.outcome)) return false;
          const current = await currentPlan(tx, admission, command);
          return current.requestDigest === verified.claims.requestDigest && current.plan.alreadyApplied;
        });
      } catch { return false; }
    },

    async commit(admission: ContentAccessAdmission, input: ContentAccessCommand,
      previewToken: string): Promise<ContentAccessReceipt | ContentAccessFailure> {
      let command: ContentAccessCommand;
      const verified = codec.verify(previewToken);
      if (verified.status === "invalid") return failure(new ContentAccessAuthorityError("denied"));
      try {
        command = canonicalCommand(input);
        if (verified.claims.operationId !== command.operationId
          || verified.claims.intentDigest !== intentDigest(admission, command)) {
          throw new ContentAccessAuthorityError("denied");
        }
      } catch (error) { return failure(error); }
      const replayInput = { operationId: command.operationId,
        requestDigest: verified.claims.requestDigest,
        requesterUserId: admission.principal.userId, requesterActorId: admission.principal.actorId };
      const assertPreviewFresh = () => {
        if (codec.verify(previewToken).status !== "valid") {
          throw new ContentAccessAuthorityError("stale");
        }
      };
      let committedEffect: CommittedArtifactShareEffect | undefined;
      try {
        const result = await getSharedDirectDb().transaction(async (tx) => {
          // Policy lock always precedes operation and object locks. Receipt
          // recovery is allowed across a mode switch without invoking policy
          // dispatch, source authorization or fresh planning.
          await acquireEncryptionConsumptionFence(tx);
          const replay = await findContentAccessReplayInTx(tx, replayInput);
          if (replay) return replay;
          assertPreviewFresh();
          const current = await currentPlan(tx, admission, command);
          assertPreviewFresh();
          if (current.requestDigest !== verified.claims.requestDigest) {
            throw new ContentAccessAuthorityError("stale");
          }
          const publication = await publishContentAccessPlanDetailedInTx(tx, {
            ...replayInput, plan: current.plan,
          });
          committedEffect = projectCommittedArtifactShareEffect(admission, command, publication);
          // Destination resolution and publication can wait on further locks.
          // Expiry here rolls back their Room, junction and receipt writes.
          assertPreviewFresh();
          return publication.receipt;
        });
        await observeCommittedArtifactShare(committedEffect);
        return result;
      } catch (error) {
        return recoverContentAccessFailure(admission, command, verified.claims.requestDigest, error);
      }
    },
  });
}
