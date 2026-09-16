/**
 * Pure planning for ordinary Memory and Artifact access changes.
 *
 * Every input is an already server-authorized snapshot. This module does not
 * authenticate, authorize, select an encryption representation, resolve a
 * Namespace, or mutate state. Callers must revalidate the bound snapshots and
 * apply the returned intent atomically through the owning persistence layer.
 */

export type ContentAccessPlanErrorCode =
  | "malformed_snapshot"
  | "self_revoke"
  | "missing_context"
  | "missing_private_destination"
  | "last_attachment";

export class ContentAccessPlanError extends Error {
  override readonly name = "ContentAccessPlanError";

  constructor(
    readonly code: ContentAccessPlanErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ContentObjectSnapshot = Readonly<{
  kind: "memory" | "artifact";
  id: string;
  /** Opaque revision binding supplied and revalidated by the caller. */
  revision: string;
}>;

export type AuthorizedContentAttachmentSnapshot = Readonly<{
  namespaceId: string;
  roomId: string;
  /** Access Rooms are immutable; dynamic Rooms follow future membership. */
  kind: "access" | "dynamic";
  humanActorIds: readonly string[];
  /** Whether this authorized operation may detach this attachment. */
  mutable: boolean;
}>;

export type AuthorizedRoomDestinationSnapshot = Readonly<{
  namespaceId: string;
  roomId: string;
  humanActorIds: readonly string[];
}>;

export type ContentAccessChange =
  | Readonly<{ kind: "grant_people"; selectedActorIds: readonly string[] }>
  | Readonly<{ kind: "grant_room"; targetRoom: AuthorizedRoomDestinationSnapshot }>
  | Readonly<{ kind: "remove_person"; targetActorId: string }>
  | Readonly<{ kind: "detach_room"; targetRoomId: string }>
  | Readonly<{ kind: "make_private" }>;

export type ContentAccessPlanInput = Readonly<{
  object: ContentObjectSnapshot;
  requesterActorId: string;
  sourceContext: Readonly<{
    roomId: string;
    humanActorIds: readonly string[];
  }>;
  attachments: readonly AuthorizedContentAttachmentSnapshot[];
  /** The caller-authorized personal destination, when one is available. */
  privateDestination?: AuthorizedRoomDestinationSnapshot;
  change: ContentAccessChange;
}>;

export type ContentAccessDestination =
  | Readonly<{
      kind: "immutable_human_set";
      humanActorIds: readonly string[];
      /** Present only when the snapshot already contains this exact access boundary. */
      existingNamespaceId?: string;
      existingRoomId?: string;
    }>
  | Readonly<{
      kind: "room_namespace";
      purpose: "grant" | "private";
      namespaceId: string;
      roomId: string;
      humanActorIds: readonly string[];
    }>;

/** Internal accounting. Adapters must sanitize it before any UI/API projection. */
export type ContentAccessPlanAccounting = Readonly<{
  removedAttachmentCount: number;
  skippedAttachmentCount: number;
  skippedNamespaceIds: readonly string[];
  /** Dynamic Rooms that still provide the removed person/Room-derived access. */
  residualDynamicRoomIds: readonly string[];
  /** Same locked attachment facts, for frozen Namespace-based response adapters. */
  residualDynamicNamespaceIds: readonly string[];
  /** Immutable, unmodifiable access facts that still provide access. */
  residualAccessNamespaceIds: readonly string[];
}>;

export type ContentAccessMutationPlan = Readonly<{
  object: ContentObjectSnapshot;
  requesterActorId: string;
  sourceContext: Readonly<{ roomId: string; humanActorIds: readonly string[] }>;
  change: ContentAccessChange;
  attachDestinations: readonly ContentAccessDestination[];
  detachNamespaceIds: readonly string[];
  /** True only when the requested attachment semantics are already present. */
  alreadyApplied: boolean;
  accounting: ContentAccessPlanAccounting;
}>;

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ContentAccessPlanError("malformed_snapshot", `${label} is required`);
  }
  return normalized;
}

function exactHumanSet(ids: readonly string[], label: string): readonly string[] {
  const normalized = [...new Set(ids.map((id) => requiredId(id, label)))].sort();
  if (normalized.length === 0) {
    throw new ContentAccessPlanError("malformed_snapshot", `${label} must not be empty`);
  }
  return Object.freeze(normalized);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function freezeRoom(
  room: AuthorizedRoomDestinationSnapshot,
  label: string,
): AuthorizedRoomDestinationSnapshot {
  return Object.freeze({
    namespaceId: requiredId(room.namespaceId, `${label}.namespaceId`),
    roomId: requiredId(room.roomId, `${label}.roomId`),
    humanActorIds: exactHumanSet(room.humanActorIds, `${label}.humanActorIds`),
  });
}

function immutableDestination(
  humanActorIds: readonly string[],
  attachments: readonly AuthorizedContentAttachmentSnapshot[],
  excludedNamespaceIds: ReadonlySet<string> = new Set(),
): ContentAccessDestination {
  const existing = attachments
    .filter((attachment) =>
      attachment.kind === "access"
      && !excludedNamespaceIds.has(attachment.namespaceId)
      && sameSet(attachment.humanActorIds, humanActorIds))
    .sort((left, right) => left.namespaceId.localeCompare(right.namespaceId)
      || left.roomId.localeCompare(right.roomId))[0];
  return Object.freeze({
    kind: "immutable_human_set" as const,
    humanActorIds,
    ...(existing === undefined
      ? {}
      : {
          existingNamespaceId: existing.namespaceId,
          existingRoomId: existing.roomId,
        }),
  });
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function freezeChange(change: ContentAccessChange): ContentAccessChange {
  switch (change.kind) {
    case "grant_people":
      return Object.freeze({
        kind: change.kind,
        selectedActorIds: exactHumanSet(change.selectedActorIds, "change.selectedActorIds"),
      });
    case "grant_room":
      return Object.freeze({
        kind: change.kind,
        targetRoom: freezeRoom(change.targetRoom, "change.targetRoom"),
      });
    case "remove_person":
      return Object.freeze({
        kind: change.kind,
        targetActorId: requiredId(change.targetActorId, "change.targetActorId"),
      });
    case "detach_room":
      return Object.freeze({
        kind: change.kind,
        targetRoomId: requiredId(change.targetRoomId, "change.targetRoomId"),
      });
    case "make_private":
      return Object.freeze({ kind: change.kind });
  }
}

function result(input: {
  object: ContentObjectSnapshot;
  requesterActorId: string;
  sourceContext: Readonly<{ roomId: string; humanActorIds: readonly string[] }>;
  change: ContentAccessChange;
  attachDestinations?: readonly ContentAccessDestination[];
  detachNamespaceIds?: readonly string[];
  alreadyApplied?: boolean;
  skippedNamespaceIds?: readonly string[];
  residualDynamicRoomIds?: readonly string[];
  residualDynamicNamespaceIds?: readonly string[];
  residualAccessNamespaceIds?: readonly string[];
}): ContentAccessMutationPlan {
  const detachNamespaceIds = uniqueSorted(input.detachNamespaceIds ?? []);
  const skippedNamespaceIds = uniqueSorted(input.skippedNamespaceIds ?? []);
  return Object.freeze({
    object: input.object,
    requesterActorId: input.requesterActorId,
    sourceContext: input.sourceContext,
    change: input.change,
    attachDestinations: Object.freeze([...(input.attachDestinations ?? [])]),
    detachNamespaceIds,
    alreadyApplied: input.alreadyApplied ?? false,
    accounting: Object.freeze({
      removedAttachmentCount: detachNamespaceIds.length,
      skippedAttachmentCount: skippedNamespaceIds.length,
      skippedNamespaceIds,
      residualDynamicRoomIds: uniqueSorted(input.residualDynamicRoomIds ?? []),
      residualDynamicNamespaceIds: uniqueSorted(input.residualDynamicNamespaceIds ?? []),
      residualAccessNamespaceIds: uniqueSorted(input.residualAccessNamespaceIds ?? []),
    }),
  });
}

export function planContentAccessChange(input: ContentAccessPlanInput): ContentAccessMutationPlan {
  const requesterActorId = requiredId(input.requesterActorId, "requesterActorId");
  const object = Object.freeze({
    kind: input.object.kind,
    id: requiredId(input.object.id, "object.id"),
    revision: requiredId(input.object.revision, "object.revision"),
  });
  if (object.kind !== "memory" && object.kind !== "artifact") {
    throw new ContentAccessPlanError("malformed_snapshot", "object.kind is invalid");
  }
  if (!input.sourceContext?.roomId || input.sourceContext.humanActorIds.length === 0) {
    throw new ContentAccessPlanError("missing_context", "invoking Room context is required");
  }
  const sourceContext = Object.freeze({
    roomId: requiredId(input.sourceContext.roomId, "sourceContext.roomId"),
    humanActorIds: exactHumanSet(
      input.sourceContext.humanActorIds,
      "sourceContext.humanActorIds",
    ),
  });
  if (!sourceContext.humanActorIds.includes(requesterActorId)) {
    throw new ContentAccessPlanError(
      "missing_context",
      "requester must belong to the invoking Human audience",
    );
  }
  if (input.attachments.length === 0) {
    throw new ContentAccessPlanError("last_attachment", "content must retain an attachment");
  }
  const namespaceIds = new Set<string>();
  const attachments = Object.freeze(input.attachments.map((attachment, index) => {
    const normalized = Object.freeze({
      namespaceId: requiredId(attachment.namespaceId, `attachments[${index}].namespaceId`),
      roomId: requiredId(attachment.roomId, `attachments[${index}].roomId`),
      kind: attachment.kind,
      humanActorIds: exactHumanSet(
        attachment.humanActorIds,
        `attachments[${index}].humanActorIds`,
      ),
      mutable: attachment.mutable,
    });
    if ((normalized.kind !== "access" && normalized.kind !== "dynamic")
      || typeof normalized.mutable !== "boolean"
      || namespaceIds.has(normalized.namespaceId)) {
      throw new ContentAccessPlanError("malformed_snapshot", "attachment snapshot is invalid");
    }
    namespaceIds.add(normalized.namespaceId);
    return normalized;
  }));
  const change = freezeChange(input.change);
  const base = { object, requesterActorId, sourceContext, change };

  if (change.kind === "grant_people") {
    const audience = exactHumanSet(
      [...sourceContext.humanActorIds, ...change.selectedActorIds],
      "person grant audience",
    );
    const destination = immutableDestination(audience, attachments);
    return result({
      ...base,
      attachDestinations: [destination],
      alreadyApplied: destination.kind === "immutable_human_set"
        && destination.existingNamespaceId !== undefined,
    });
  }

  if (change.kind === "grant_room") {
    const target = change.targetRoom;
    return result({
      ...base,
      attachDestinations: [Object.freeze({
        kind: "room_namespace" as const,
        purpose: "grant" as const,
        ...target,
      })],
      alreadyApplied: attachments.some((attachment) =>
        attachment.namespaceId === target.namespaceId),
    });
  }

  if (change.kind === "remove_person") {
    if (change.targetActorId === requesterActorId) {
      throw new ContentAccessPlanError("self_revoke", "requester cannot remove their own access");
    }
    const removable = attachments.filter((attachment) =>
      attachment.kind === "access"
      && attachment.mutable
      && attachment.humanActorIds.includes(change.targetActorId));
    const detachNamespaceIds = removable.map((attachment) => attachment.namespaceId);
    const excluded = new Set(detachNamespaceIds);
    const destinationByAudience = new Map<string, ContentAccessDestination>();
    for (const attachment of removable) {
      if (!attachment.humanActorIds.includes(requesterActorId)) {
        throw new ContentAccessPlanError(
          "malformed_snapshot",
          "mutable access attachment does not contain the requester",
        );
      }
      const remaining = exactHumanSet(
        attachment.humanActorIds.filter((id) => id !== change.targetActorId),
        "remaining access audience",
      );
      const key = JSON.stringify(remaining);
      if (!destinationByAudience.has(key)) {
        destinationByAudience.set(key, immutableDestination(remaining, attachments, excluded));
      }
    }
    const skippedAccess = attachments.filter((attachment) =>
      attachment.kind === "access"
      && !attachment.mutable
      && attachment.humanActorIds.includes(change.targetActorId));
    const residualDynamic = attachments.filter((attachment) =>
      attachment.kind === "dynamic"
      && attachment.humanActorIds.includes(change.targetActorId));
    return result({
      ...base,
      attachDestinations: [...destinationByAudience.values()],
      detachNamespaceIds,
      alreadyApplied: removable.length === 0
        && skippedAccess.length === 0
        && residualDynamic.length === 0,
      skippedNamespaceIds: skippedAccess.map((attachment) => attachment.namespaceId),
      residualAccessNamespaceIds: skippedAccess.map((attachment) => attachment.namespaceId),
      residualDynamicRoomIds: residualDynamic.map((attachment) => attachment.roomId),
      residualDynamicNamespaceIds: residualDynamic.map((attachment) => attachment.namespaceId),
    });
  }

  if (change.kind === "detach_room") {
    const matches = attachments.filter((attachment) => attachment.roomId === change.targetRoomId);
    if (matches.some((attachment) => attachment.kind === "access")) {
      throw new ContentAccessPlanError(
        "malformed_snapshot",
        "Room detach cannot remove an immutable access boundary",
      );
    }
    const removable = matches.filter((attachment) => attachment.mutable);
    const skipped = matches.filter((attachment) => !attachment.mutable);
    if (removable.length === attachments.length) {
      throw new ContentAccessPlanError("last_attachment", "Room detach would remove the last attachment");
    }
    return result({
      ...base,
      detachNamespaceIds: removable.map((attachment) => attachment.namespaceId),
      alreadyApplied: matches.length === 0,
      skippedNamespaceIds: skipped.map((attachment) => attachment.namespaceId),
      residualDynamicRoomIds: skipped
        .filter((attachment) => attachment.kind === "dynamic")
        .map((attachment) => attachment.roomId),
      residualDynamicNamespaceIds: skipped
        .filter((attachment) => attachment.kind === "dynamic")
        .map((attachment) => attachment.namespaceId),
      residualAccessNamespaceIds: skipped
        .filter((attachment) => attachment.kind === "access")
        .map((attachment) => attachment.namespaceId),
    });
  }

  if (input.privateDestination === undefined) {
    throw new ContentAccessPlanError(
      "missing_private_destination",
      "make-private requires an authorized personal destination",
    );
  }
  const privateDestination = freezeRoom(input.privateDestination, "privateDestination");
  if (!sameSet(privateDestination.humanActorIds, [requesterActorId])) {
    throw new ContentAccessPlanError(
      "malformed_snapshot",
      "private destination must contain only the requester",
    );
  }
  const privateAttached = attachments.some((attachment) =>
    attachment.namespaceId === privateDestination.namespaceId);
  const removable = attachments.filter((attachment) =>
    attachment.mutable
    && attachment.namespaceId !== privateDestination.namespaceId);
  const preserved = attachments.filter((attachment) =>
    !attachment.mutable
    && attachment.namespaceId !== privateDestination.namespaceId);
  return result({
    ...base,
    attachDestinations: !privateAttached
      ? [Object.freeze({
          kind: "room_namespace" as const,
          purpose: "private" as const,
          ...privateDestination,
        })]
      : [],
    detachNamespaceIds: removable.map((attachment) => attachment.namespaceId),
    alreadyApplied: privateAttached && removable.length === 0 && preserved.length === 0,
    skippedNamespaceIds: preserved.map((attachment) => attachment.namespaceId),
    residualDynamicRoomIds: preserved
      .filter((attachment) => attachment.kind === "dynamic")
      .map((attachment) => attachment.roomId),
    residualDynamicNamespaceIds: preserved
      .filter((attachment) => attachment.kind === "dynamic")
      .map((attachment) => attachment.namespaceId),
    residualAccessNamespaceIds: preserved
      .filter((attachment) => attachment.kind === "access")
      .map((attachment) => attachment.namespaceId),
  });
}
