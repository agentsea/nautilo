import {
  and,
  eq,
  inArray,
  rooms,
  roomMembers,
  sql,
  subthreadUserFocus,
  type SubthreadUserFocus,
} from "@nautilo/db";
import type { AgentResponseMode } from "../queries";
import {
  resolveSubthreadAgentEligibility,
  listSubthreadRoomIdsForParent,
  type ResponderDb,
  type SubthreadResponderEligibilityStatus,
} from "../agent-response";

export type { AgentResponseMode, ResponderDb };

export type SubthreadResponderStatus = "active" | "cleared" | "invalidated";
export type SubthreadResponderSource =
  | "mention"
  | "reply"
  | "ui"
  | "inferred"
  | "affinity";

export interface SubthreadResponderRow {
  subthreadRoomId: string;
  userActorId: string;
  botActorId: string;
  status: SubthreadResponderStatus;
  source: SubthreadResponderSource | null;
  establishedMessageId: number | null;
  establishedAt: Date | null;
  revision: number;
  invalidatedReason: string | null;
  updatedAt: Date;
}

export type SubthreadResponderUnavailableReason =
  | "no_responder"
  | "not_subthread"
  | "not_member"
  | "cleared"
  | "invalidated"
  | "unavailable_archived"
  | "unavailable_no_parent"
  | "unavailable_not_member"
  | "unavailable_observe";

export interface SubthreadResponderRead {
  responder: SubthreadResponderRow | null;
  available: boolean;
  unavailableReason: SubthreadResponderUnavailableReason | null;
  /** Effective parent agent_response mode at read time (null when not resolvable). */
  effectiveMode: AgentResponseMode | null;
}

export class ResponderOpError extends Error {
  constructor(
    public readonly code:
      | "not_subthread"
      | "not_member"
      | "bot_not_eligible"
      | "archived",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ResponderOpError";
  }
}

function toRow(r: SubthreadUserFocus): SubthreadResponderRow {
  return {
    subthreadRoomId: r.subthreadRoomId,
    userActorId: r.userActorId,
    botActorId: r.botActorId,
    status: r.status as SubthreadResponderStatus,
    source: (r.source ?? null) as SubthreadResponderSource | null,
    establishedMessageId: r.establishedMessageId ?? null,
    establishedAt: r.establishedAt ?? null,
    revision: r.revision,
    invalidatedReason: r.invalidatedReason ?? null,
    updatedAt: r.updatedAt,
  };
}

interface SubthreadMembership {
  isSubthread: boolean;
  isArchived: boolean;
  isMember: boolean;
}

/**
 * Loads the Subthread Room row + the requester's membership in one round
 * trip. `isSubthread` is false when the room is missing or not `kind =
 * 'subthread'` — the responder substrate is a no-op for non-subthreads.
 */
async function loadSubthreadMembership(
  db: ResponderDb,
  subthreadRoomId: string,
  userActorId: string,
): Promise<SubthreadMembership> {
  const [room] = await db
    .select({ kind: rooms.kind, archivedAt: rooms.archivedAt })
    .from(rooms)
    .where(eq(rooms.id, subthreadRoomId))
    .limit(1);
  if (!room || room.kind !== "subthread") {
    return { isSubthread: false, isArchived: false, isMember: false };
  }
  const [member] = await db
    .select({ actorId: roomMembers.actorId })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, subthreadRoomId),
        eq(roomMembers.actorId, userActorId),
      ),
    )
    .limit(1);
  return {
    isSubthread: true,
    isArchived: room.archivedAt != null,
    isMember: Boolean(member),
  };
}

function mapEligibilityToReason(
  status: SubthreadResponderEligibilityStatus,
): SubthreadResponderUnavailableReason {
  switch (status) {
    case "unavailable_archived":
      return "unavailable_archived";
    case "unavailable_no_parent":
      return "unavailable_no_parent";
    case "unavailable_not_member":
      return "unavailable_not_member";
    case "unavailable_observe":
      return "unavailable_observe";
    default:
      return "invalidated";
  }
}

/**
 * D426 Phase 2.1 / 2.5 — read the requester-private Thread Responder for
 * `(subthread, human)`.
 *
 * Availability is DYNAMIC: a stored `active` responder is re-checked against
 * the parent Room's agent-response eligibility on every read. If the stored
 * Genie is no longer eligible (removed from the parent, parent flipped to
 * `observe`, subthread archived, or the subthread/user pair is no longer
 * valid), the row is LAZILY flipped to `invalidated` and the read returns
 * `available: false`. This mirrors the `focus_events` lazy-expiry-on-touch
 * pattern and guarantees `observe` cannot drift into child rooms even when
 * no eager invalidation hook has fired.
 *
 * Safe for non-members, non-subthreads, removed agents, and `observe` — all
 * return `available: false` with a precise `unavailableReason` and never
 * throw.
 */
export async function readSubthreadResponder(
  db: ResponderDb,
  args: {
    subthreadRoomId: string;
    userActorId: string;
    now: Date;
  },
): Promise<SubthreadResponderRead> {
  if (!args.subthreadRoomId || !args.userActorId) {
    return {
      responder: null,
      available: false,
      unavailableReason: "not_subthread",
      effectiveMode: null,
    };
  }

  const membership = await loadSubthreadMembership(
    db,
    args.subthreadRoomId,
    args.userActorId,
  );
  if (!membership.isSubthread) {
    return {
      responder: null,
      available: false,
      unavailableReason: "not_subthread",
      effectiveMode: null,
    };
  }
  if (!membership.isMember) {
    return {
      responder: null,
      available: false,
      unavailableReason: "not_member",
      effectiveMode: null,
    };
  }

  const [row] = await db
    .select()
    .from(subthreadUserFocus)
    .where(
      and(
        eq(subthreadUserFocus.subthreadRoomId, args.subthreadRoomId),
        eq(subthreadUserFocus.userActorId, args.userActorId),
      ),
    )
    .limit(1);
  if (!row) {
    return {
      responder: null,
      available: false,
      unavailableReason: "no_responder",
      effectiveMode: null,
    };
  }

  const stored = toRow(row);
  if (stored.status === "cleared") {
    return {
      responder: stored,
      available: false,
      unavailableReason: "cleared",
      effectiveMode: null,
    };
  }
  if (stored.status === "invalidated") {
    return {
      responder: stored,
      available: false,
      unavailableReason: "invalidated",
      effectiveMode: null,
    };
  }

  // status === "active" — re-check eligibility dynamically.
  const elig = await resolveSubthreadAgentEligibility(
    db,
    args.subthreadRoomId,
    stored.botActorId,
  );
  if (elig.status === "eligible") {
    return {
      responder: stored,
      available: true,
      unavailableReason: null,
      effectiveMode: elig.mode,
    };
  }

  // Lazy invalidation: stored active but the Genie is no longer eligible.
  const reason = mapEligibilityToReason(elig.status);
  const invalidatedReason = reason;
  await db
    .update(subthreadUserFocus)
    .set({
      status: "invalidated",
      source: null,
      invalidatedReason,
      revision: sql`${subthreadUserFocus.revision} + 1`,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(subthreadUserFocus.subthreadRoomId, args.subthreadRoomId),
        eq(subthreadUserFocus.userActorId, args.userActorId),
        eq(subthreadUserFocus.status, "active"),
      ),
    );

  const [refreshed] = await db
    .select()
    .from(subthreadUserFocus)
    .where(
      and(
        eq(subthreadUserFocus.subthreadRoomId, args.subthreadRoomId),
        eq(subthreadUserFocus.userActorId, args.userActorId),
      ),
    )
    .limit(1);

  return {
    responder: refreshed ? toRow(refreshed) : stored,
    available: false,
    unavailableReason: reason,
    effectiveMode: elig.mode,
  };
}

/**
 * D426 Phase 2.1 / 2.5 — establish or replace the requester-private Thread
 * Responder for `(subthread, human)`. Validates the room is a non-archived
 * Subthread, the requester is a member, and the selected Genie is currently
 * eligible (parent agent member, not `observe`). Idempotent: re-selecting
 * the same active Genie with the same source is a no-op that does NOT bump
 * the revision (avoids churn on the requester-private realtime delta).
 *
 * Throws `ResponderOpError` on any validation failure; never silently writes
 * an ineligible responder.
 */
export async function replaceSubthreadResponder(
  db: ResponderDb,
  args: {
    subthreadRoomId: string;
    userActorId: string;
    botActorId: string;
    source: SubthreadResponderSource;
    establishedMessageId?: number | null;
    now: Date;
  },
): Promise<SubthreadResponderRow> {
  if (!args.subthreadRoomId || !args.userActorId || !args.botActorId) {
    throw new ResponderOpError("not_subthread");
  }

  const membership = await loadSubthreadMembership(
    db,
    args.subthreadRoomId,
    args.userActorId,
  );
  if (!membership.isSubthread) {
    throw new ResponderOpError("not_subthread");
  }
  if (membership.isArchived) {
    throw new ResponderOpError("archived");
  }
  if (!membership.isMember) {
    throw new ResponderOpError("not_member");
  }

  const elig = await resolveSubthreadAgentEligibility(
    db,
    args.subthreadRoomId,
    args.botActorId,
  );
  if (elig.status !== "eligible") {
    throw new ResponderOpError(
      "bot_not_eligible",
      `bot ${args.botActorId} eligibility: ${elig.status}`,
    );
  }

  const [existing] = await db
    .select()
    .from(subthreadUserFocus)
    .where(
      and(
        eq(subthreadUserFocus.subthreadRoomId, args.subthreadRoomId),
        eq(subthreadUserFocus.userActorId, args.userActorId),
      ),
    )
    .limit(1);

  const establishedMessageId = args.establishedMessageId ?? null;

  // Idempotent: same active Genie + same source → no churn.
  if (
    existing &&
    existing.status === "active" &&
    existing.botActorId === args.botActorId &&
    (existing.source ?? null) === args.source &&
    (existing.establishedMessageId ?? null) === establishedMessageId
  ) {
    return toRow(existing);
  }

  const [row] = await db
    .insert(subthreadUserFocus)
    .values({
      subthreadRoomId: args.subthreadRoomId,
      userActorId: args.userActorId,
      botActorId: args.botActorId,
      status: "active",
      source: args.source,
      establishedMessageId,
      establishedAt: args.now,
      revision: 1,
      updatedAt: args.now,
    })
    .onConflictDoUpdate({
      target: [
        subthreadUserFocus.subthreadRoomId,
        subthreadUserFocus.userActorId,
      ],
      set: {
        botActorId: args.botActorId,
        status: "active",
        source: args.source,
        establishedMessageId,
        establishedAt: args.now,
        invalidatedReason: null,
        revision: sql`${subthreadUserFocus.revision} + 1`,
        updatedAt: args.now,
      },
    })
    .returning();

  if (!row) throw new ResponderOpError("not_subthread", "replace returned no row");
  return toRow(row);
}

/**
 * D426 Phase 2.1 / 2.5 — clear the requester-private Thread Responder.
 * Idempotent: clearing a row that is already `cleared` (or that never
 * existed) does NOT bump the revision. Validates the room is a Subthread
 * and the requester is a member; never throws on archived subthreads
 * (the responder is already unavailable there).
 */
export async function clearSubthreadResponder(
  db: ResponderDb,
  args: {
    subthreadRoomId: string;
    userActorId: string;
    now: Date;
  },
): Promise<SubthreadResponderRow | null> {
  if (!args.subthreadRoomId || !args.userActorId) {
    throw new ResponderOpError("not_subthread");
  }

  const membership = await loadSubthreadMembership(
    db,
    args.subthreadRoomId,
    args.userActorId,
  );
  if (!membership.isSubthread) {
    throw new ResponderOpError("not_subthread");
  }
  if (!membership.isMember) {
    throw new ResponderOpError("not_member");
  }

  const [existing] = await db
    .select()
    .from(subthreadUserFocus)
    .where(
      and(
        eq(subthreadUserFocus.subthreadRoomId, args.subthreadRoomId),
        eq(subthreadUserFocus.userActorId, args.userActorId),
      ),
    )
    .limit(1);

  if (!existing) return null;
  if (existing.status === "cleared") return toRow(existing);

  const [updated] = await db
    .update(subthreadUserFocus)
    .set({
      status: "cleared",
      source: null,
      invalidatedReason: null,
      revision: sql`${subthreadUserFocus.revision} + 1`,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(subthreadUserFocus.subthreadRoomId, args.subthreadRoomId),
        eq(subthreadUserFocus.userActorId, args.userActorId),
      ),
    )
    .returning();

  if (!updated) return toRow(existing);
  return toRow(updated);
}

/**
 * D426 Phase 2.2 — bulk-invalidate `active` Thread Responders. Flips
 * matching rows to `invalidated` with `invalidatedReason` and bumps their
 * revision. Only touches rows currently `active` (cleared/invalidated rows
 * are left untouched). Used by the membership-mutation hooks (parent
 * membership removal, parent `observe` flip) and safe to call inside a
 * transaction (pass the tx as `db`).
 *
 * Returns the number of rows invalidated.
 */
export async function invalidateSubthreadResponders(
  db: ResponderDb,
  args: {
    subthreadRoomIds: string[];
    botActorId?: string | null;
    reason: string;
    now: Date;
  },
): Promise<number> {
  if (args.subthreadRoomIds.length === 0) return 0;
  const result = await db
    .update(subthreadUserFocus)
    .set({
      status: "invalidated",
      source: null,
      invalidatedReason: args.reason,
      revision: sql`${subthreadUserFocus.revision} + 1`,
      updatedAt: args.now,
    })
    .where(
      and(
        inArray(subthreadUserFocus.subthreadRoomId, args.subthreadRoomIds),
        eq(subthreadUserFocus.status, "active"),
        ...(args.botActorId
          ? [eq(subthreadUserFocus.botActorId, args.botActorId)]
          : []),
      ),
    )
    .returning();
  return result.length;
}

/**
 * D426 Phase 2.2 — convenience wrapper: invalidate `active` responders for
 * one Genie across every child Subthread of a parent Room. Used when the
 * Genie is removed from the parent or flipped to `observe`. Safe inside a
 * transaction (pass the tx as `db`).
 */
export async function invalidateRespondersForBotInParentChildren(
  db: ResponderDb,
  args: {
    parentRoomId: string;
    botActorId: string;
    reason: string;
    now: Date;
  },
): Promise<number> {
  const childIds = await listSubthreadRoomIdsForParent(db, args.parentRoomId);
  if (childIds.length === 0) return 0;
  return invalidateSubthreadResponders(db, {
    subthreadRoomIds: childIds,
    botActorId: args.botActorId,
    reason: args.reason,
    now: args.now,
  });
}
