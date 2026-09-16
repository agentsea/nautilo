/**
 * D453 task 2.2 persistence boundary.
 *
 * These helpers accept only server-internal values. They do not authenticate a
 * browser request: callers must first derive the actor, owner, canonical
 * Task/Room tuple, and live paired-host scope in the server authority service.
 * Every operation still runs under forced RLS as defense in depth.
 */
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { getSharedDirectAgentDb } from "../config/agent-database";
import type { DirectDatabase } from "../config/direct-database";
import { withTrustContext } from "../connection/with-trust-context";
import {
  codexAccountProfiles,
  codexUserPreferences,
  codexUserInputRequests,
  codexThreadBindings,
} from "../schema/codex";
import type {
  CodexUsageSnapshot,
  CodexUserInputQuestion,
  CodexUserInputRequestState,
} from "../schema/codex";

type CodexDb = ReturnType<typeof getSharedDirectAgentDb>;
type CodexTx = Parameters<Parameters<CodexDb["transaction"]>[0]>[0];

/** Global Connections profiles are owned by a Human, not an Agent. */
export type CodexOwnerContext = {
  userId: string;
};
/** Preferences and bindings remain exact Human×Agent operations. */
export type CodexAgentContext = CodexOwnerContext & {
  agentId: string;
};
export type CodexInternalProfileInsert = {
  /** Server-minted UUID shared with the host as its opaque profile handle. */
  id?: string;
  relayId: string;
  homeHandle: string;
  label: string;
  profileGeneration?: number;
  accountGeneration?: number;
  authState?:
    | "signed_out"
    | "login_pending"
    | "signed_in"
    | "expired"
    | "error";
  registrationState?: "provisional" | "registered";
};
export type CodexInternalBindingInsert = Omit<
  typeof codexThreadBindings.$inferInsert,
  "id" | "createdAt" | "updatedAt" | "archivedAt" | "userId"
>;
export type CodexBindingOperationalState =
  | "opening"
  | "active"
  | "queued"
  | "awaiting_approval"
  | "awaiting_input"
  | "needs_rebind"
  | "completed"
  | "cancelled"
  | "errored"
  | "recovery_required";
export type CodexInternalBindingLocator = {
  id: string;
  taskId: string;
  taskRunId: string;
  jobId: string;
  roomId: string;
  laneKey: string;
};

export type CodexProfileRemovalIdentity = {
  id: string;
  relayId: string;
  homeHandle: string;
  profileGeneration: number;
  accountGeneration: number;
};

export type BeginCodexProfileRemovalResult =
  | { status: "begun"; profile: typeof codexAccountProfiles.$inferSelect }
  | { status: "already_removing"; profile: typeof codexAccountProfiles.$inferSelect }
  | { status: "already_removed"; profile: typeof codexAccountProfiles.$inferSelect }
  | { status: "conflict" };

export type FinalizeCodexProfileRemovalResult =
  | { status: "finalized"; profile: typeof codexAccountProfiles.$inferSelect }
  | { status: "already_removed"; profile: typeof codexAccountProfiles.$inferSelect }
  | {
      status: "blocked";
      selectingPreferenceCount: number;
      unarchivedBindingCount: number;
    }
  | { status: "conflict" };

/**
 * The host has already proven the exact private home removed before this
 * archive runs. The rows remain as immutable history, but can no longer be
 * resumed or selected as live bindings.
 */
export type ArchiveCodexProfileBindingsForRemovalResult =
  | { status: "archived"; count: number }
  | { status: "conflict" };

export class CodexProfileSelectionRejectedError extends Error {
  readonly code = "CODEX_PROFILE_SELECTION_REJECTED";

  constructor() {
    super("Codex profile selection requires an owned active profile");
    this.name = "CodexProfileSelectionRejectedError";
  }
}

const handle = (): CodexDb => getSharedDirectAgentDb();

function scoped<T>(
  db: CodexDb,
  ctx: CodexOwnerContext,
  fn: (tx: CodexTx) => Promise<T>,
): Promise<T> {
  return withTrustContext(ctx, fn, db);
}

export function listCodexProfilesWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
) {
  return scoped(db, ctx, (tx) =>
    tx
      .select()
      .from(codexAccountProfiles)
      .where(
        and(
          eq(codexAccountProfiles.userId, ctx.userId),
          ne(codexAccountProfiles.removalState, "removed"),
        ),
      )
      // Duplicate human labels are disambiguated by position in Connections.
      // Keep that position stable across login/status revision writes.
      .orderBy(codexAccountProfiles.createdAt, codexAccountProfiles.id),
  );
}
export const listCodexProfiles = (ctx: CodexOwnerContext) =>
  listCodexProfilesWith(handle(), ctx);

export async function getCodexUserPreferenceWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
) {
  const [row] = await scoped(db, ctx, (tx) =>
    tx
      .select()
      .from(codexUserPreferences)
      .where(eq(codexUserPreferences.userId, ctx.userId))
      .limit(1),
  );
  return (
    row ?? {
      userId: ctx.userId,
      enabled: false,
      accountProfileId: null,
      defaultPosture: "codex_default" as const,
      revision: 0,
    }
  );
}

export async function upsertCodexUserPreferenceWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  input: {
    profileId: string | null;
    posture:
      | "codex_default"
      | "prompted_workspace"
      | "full_access_headless";
    enabled: boolean;
    expectedRevision: number;
  },
) {
  return scoped(db, ctx, async (tx) => {
    if (input.enabled && input.profileId === null) {
      throw new CodexProfileSelectionRejectedError();
    }
    if (input.profileId !== null) {
      const [profile] = await tx
        .select({ id: codexAccountProfiles.id })
        .from(codexAccountProfiles)
        .where(
          and(
            eq(codexAccountProfiles.id, input.profileId),
            eq(codexAccountProfiles.userId, ctx.userId),
            eq(codexAccountProfiles.removalState, "active"),
            eq(codexAccountProfiles.registrationState, "registered"),
          ),
        )
        .for("key share");
      if (!profile) throw new CodexProfileSelectionRejectedError();
    }

    const [current] = await tx
      .select({ revision: codexUserPreferences.revision })
      .from(codexUserPreferences)
      .where(eq(codexUserPreferences.userId, ctx.userId))
      .for("update");
    if (!current) {
      if (input.expectedRevision !== 0) return undefined;
      const [inserted] = await tx
        .insert(codexUserPreferences)
        .values({
          userId: ctx.userId,
          accountProfileId: input.profileId,
          defaultPosture: input.posture,
          enabled: input.enabled,
          revision: 1,
        })
        .onConflictDoNothing()
        .returning();
      return inserted;
    }
    if (current.revision !== input.expectedRevision) return undefined;
    const [updated] = await tx
      .update(codexUserPreferences)
      .set({
        accountProfileId: input.profileId,
        defaultPosture: input.posture,
        enabled: input.enabled,
        revision: input.expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(codexUserPreferences.userId, ctx.userId),
          eq(codexUserPreferences.revision, input.expectedRevision),
        ),
      )
      .returning();
    return updated;
  });
}

export async function getCodexProfileWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  id: string,
) {
  const [row] = await scoped(db, ctx, (tx) =>
    tx
      .select()
      .from(codexAccountProfiles)
      .where(
        and(
          eq(codexAccountProfiles.id, id),
          eq(codexAccountProfiles.userId, ctx.userId),
          ne(codexAccountProfiles.removalState, "removed"),
        ),
      )
      .limit(1),
  );
  return row;
}

export async function insertCodexProfileWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  input: CodexInternalProfileInsert,
) {
  const [row] = await scoped(db, ctx, (tx) =>
    tx
      .insert(codexAccountProfiles)
      .values({ ...input, userId: ctx.userId })
      .returning(),
  );
  return row;
}

export async function renameCodexProfileWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  id: string,
  label: string,
  expectedRevision: number,
) {
  const [row] = await scoped(db, ctx, (tx) =>
    tx
      .update(codexAccountProfiles)
      .set({
        label,
        revision: expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(codexAccountProfiles.id, id),
          eq(codexAccountProfiles.userId, ctx.userId),
          eq(codexAccountProfiles.revision, expectedRevision),
          eq(codexAccountProfiles.removalState, "active"),
        ),
      )
      .returning(),
  );
  return row;
}

export async function updateCodexProfileStatusWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  input: {
    id: string;
    authState: "signed_out" | "login_pending" | "signed_in" | "expired" | "error";
    profileGeneration: number;
    accountGeneration: number;
    accountEmail?: string | null;
    planType?: string | null;
    lastErrorCode?: string | null;
    expectedRegistrationState?: "provisional" | "registered";
    expectedRevision: number;
  },
) {
  const [row] = await scoped(db, ctx, (tx) =>
    tx
      .update(codexAccountProfiles)
      .set({
        authState: input.authState,
        profileGeneration: input.profileGeneration,
        accountGeneration: input.accountGeneration,
        ...(input.accountEmail !== undefined ? { accountEmail: input.accountEmail } : {}),
        ...(input.planType !== undefined ? { planType: input.planType } : {}),
        ...(input.lastErrorCode !== undefined
          ? { lastErrorCode: input.lastErrorCode }
          : {}),
        revision: input.expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(codexAccountProfiles.id, input.id),
          eq(codexAccountProfiles.userId, ctx.userId),
          eq(codexAccountProfiles.revision, input.expectedRevision),
          eq(codexAccountProfiles.removalState, "active"),
          input.expectedRegistrationState === undefined
            ? sql`true`
            : eq(codexAccountProfiles.registrationState, input.expectedRegistrationState),
        ),
      )
      .returning(),
  );
  return row;
}

/**
 * Commit the first provider-proven registration and, only when no established
 * signed-in account/default exists, make it the Human's enabled default in the
 * same transaction. Official account/read is the sole caller of this CAS.
 */
export async function registerCodexProfileFromOfficialAccountWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  input: {
    id: string;
    profileGeneration: number;
    accountGeneration: number;
    accountEmail?: string | null;
    planType?: string | null;
    expectedRevision: number;
  },
) {
  return scoped(db, ctx, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.userId}, 491))`);
    const [current] = await tx
      .select()
      .from(codexAccountProfiles)
      .where(and(
        eq(codexAccountProfiles.id, input.id),
        eq(codexAccountProfiles.userId, ctx.userId),
        eq(codexAccountProfiles.profileGeneration, input.profileGeneration),
        eq(codexAccountProfiles.revision, input.expectedRevision),
        eq(codexAccountProfiles.removalState, "active"),
      ))
      .for("update");
    if (!current) return undefined;
    if (input.accountGeneration < current.accountGeneration) return undefined;

    const alreadyRegistered = current.registrationState === "registered";
    const providerEmail = input.accountEmail?.trim();
    if (!alreadyRegistered && (!providerEmail || providerEmail.length < 3 || providerEmail.length > 320)) return undefined;
    const [profile] = await tx
      .update(codexAccountProfiles)
      .set({
        registrationState: "registered",
        authState: "signed_in",
        accountGeneration: input.accountGeneration,
        ...(providerEmail !== undefined ? { accountEmail: providerEmail } : {}),
        ...(input.planType !== undefined ? { planType: input.planType } : {}),
        revision: input.expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(codexAccountProfiles.id, input.id),
        eq(codexAccountProfiles.userId, ctx.userId),
        eq(codexAccountProfiles.profileGeneration, input.profileGeneration),
        eq(codexAccountProfiles.revision, input.expectedRevision),
        eq(codexAccountProfiles.removalState, "active"),
      ))
      .returning();
    if (!profile) return undefined;

    if (!alreadyRegistered) {
      const [preference] = await tx
        .select()
        .from(codexUserPreferences)
        .where(eq(codexUserPreferences.userId, ctx.userId))
        .for("update");
      const [priorRegistered] = await tx
        .select({ id: codexAccountProfiles.id })
        .from(codexAccountProfiles)
        .where(and(
          eq(codexAccountProfiles.userId, ctx.userId),
          eq(codexAccountProfiles.registrationState, "registered"),
          eq(codexAccountProfiles.removalState, "active"),
          ne(codexAccountProfiles.id, input.id),
        ))
        .limit(1);
      if (!priorRegistered && (!preference || preference.accountProfileId === null)) {
        await tx
          .insert(codexUserPreferences)
          .values({
            userId: ctx.userId,
            enabled: true,
            accountProfileId: input.id,
            defaultPosture: "codex_default",
            revision: 1,
          })
          .onConflictDoUpdate({
            target: codexUserPreferences.userId,
            set: {
              enabled: true,
              accountProfileId: input.id,
              revision: sql`${codexUserPreferences.revision} + 1`,
              updatedAt: new Date(),
            },
            setWhere: isNull(codexUserPreferences.accountProfileId),
          });
      }
    }
    return profile;
  });
}

/**
 * D453 task 2.4's only persisted provider-usage write.
 *
 * The paired host has already converted upstream responses into the schema's
 * bounded safe projection.  This store deliberately accepts no account data,
 * raw response envelope, or selector hint.  It locks the exact active owner
 * profile and fences both host generations and the optimistic revision before
 * sparse-merging independently refreshed halves.
 */
export type CodexUsageSnapshotPatch = {
  readonly rateLimits?: NonNullable<CodexUsageSnapshot["rateLimits"]>;
  readonly usage?: NonNullable<CodexUsageSnapshot["usage"]>;
};

export async function updateCodexProfileUsageSnapshotWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  input: {
    readonly id: string;
    readonly profileGeneration: number;
    readonly accountGeneration: number;
    readonly expectedRevision: number;
    readonly patch: CodexUsageSnapshotPatch;
    /** Local receipt time, not a provider timestamp or account identifier. */
    readonly observedAt: Date;
  },
) {
  if (input.patch.rateLimits === undefined && input.patch.usage === undefined) {
    return undefined;
  }
  return scoped(db, ctx, async (tx) => {
    const [current] = await tx
      .select()
      .from(codexAccountProfiles)
      .where(
        and(
          eq(codexAccountProfiles.id, input.id),
          eq(codexAccountProfiles.userId, ctx.userId),
          eq(codexAccountProfiles.profileGeneration, input.profileGeneration),
          eq(codexAccountProfiles.accountGeneration, input.accountGeneration),
          eq(codexAccountProfiles.revision, input.expectedRevision),
          eq(codexAccountProfiles.removalState, "active"),
        ),
      )
      .for("update");
    if (!current) return undefined;

    const snapshot = mergeCodexUsageSnapshot(current.usageSnapshot, input.patch);
    const [updated] = await tx
      .update(codexAccountProfiles)
      .set({
        usageSnapshot: snapshot,
        usageObservedAt: input.observedAt,
        // A plan is a display field only.  It follows a successful rate-limit
        // projection and never participates in account selection.
        ...(input.patch.rateLimits !== undefined
          ? { planType: input.patch.rateLimits.plan }
          : {}),
        revision: input.expectedRevision + 1,
        updatedAt: input.observedAt,
      })
      .where(
        and(
          eq(codexAccountProfiles.id, input.id),
          eq(codexAccountProfiles.userId, ctx.userId),
          eq(codexAccountProfiles.profileGeneration, input.profileGeneration),
          eq(codexAccountProfiles.accountGeneration, input.accountGeneration),
          eq(codexAccountProfiles.revision, input.expectedRevision),
          eq(codexAccountProfiles.removalState, "active"),
        ),
      )
      .returning();
    return updated;
  });
}

/** Missing/unavailable halves retain the last safe projection independently. */
export function mergeCodexUsageSnapshot(
  existing: CodexUsageSnapshot | null,
  patch: CodexUsageSnapshotPatch,
): CodexUsageSnapshot {
  const rateLimits = patch.rateLimits ?? existing?.rateLimits;
  const usage = patch.usage ?? existing?.usage;
  if (rateLimits === undefined && usage === undefined) {
    throw new Error("Codex usage patch must contain a safe projection");
  }
  return {
    schemaVersion: 1,
    ...(rateLimits === undefined ? {} : { rateLimits }),
    ...(usage === undefined ? {} : { usage }),
  } as CodexUsageSnapshot;
}

/**
 * D453 task 4.7's durable facts for the one supported native request type.
 * The type intentionally contains neither answer values nor an upstream
 * JSON-RPC request id: both remain in the exact Electron request closure.
 */
export type CodexUserInputRequestInsert = {
  readonly requestRef: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly roomId: string;
  readonly taskId: string;
  readonly taskRunId: string;
  readonly jobId: string;
  readonly codexThreadId: string;
  readonly codexTurnId: string;
  readonly codexItemId: string;
  readonly questions: readonly CodexUserInputQuestion[];
  /** Generated `autoResolutionMs`, bounded by the relay/browser contract. */
  readonly autoResolutionMs: number | null;
  readonly expiresAt: Date;
};

export type CreateCodexUserInputRequestResult =
  | { readonly status: "created" | "existing"; readonly request: typeof codexUserInputRequests.$inferSelect }
  | { readonly status: "stale_binding" | "conflict" | "expired" };

export type CodexUserInputRequestFinalState = Extract<
  CodexUserInputRequestState,
  "expired" | "cancelled" | "unavailable" | "terminal"
>;

export type CodexUserInputRequestTransitionResult =
  | { readonly status: "transitioned"; readonly request: typeof codexUserInputRequests.$inferSelect }
  | { readonly status: "already_terminal"; readonly request: typeof codexUserInputRequests.$inferSelect }
  | { readonly status: "stale_binding" | "conflict" | "expired" };

/**
 * Inserts one owner-Human request fact only after the source Agent's forced
 * RLS binding tuple has been proven. A duplicate delivery is idempotent only
 * when every persisted semantic fact is identical; a new requestRef for the
 * same binding/turn/item remains a conflict under the database unique index.
 */
export async function createCodexUserInputRequestWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  input: CodexUserInputRequestInsert,
  now = new Date(),
): Promise<CreateCodexUserInputRequestResult> {
  if (input.expiresAt.getTime() <= now.getTime()) return { status: "expired" };
  return scoped(db, ctx, async (tx) => {
    const binding = await lockExactCodexUserInputBinding(tx, ctx, input, [
      "active",
      "awaiting_input",
    ]);
    if (!binding) return { status: "stale_binding" };

    const [inserted] = await tx
      .insert(codexUserInputRequests)
      .values({
        requestRef: input.requestRef,
        userId: ctx.userId,
        sourceAgentId: ctx.agentId,
        roomId: input.roomId,
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        jobId: input.jobId,
        bindingId: input.bindingId,
        bindingGeneration: input.bindingGeneration,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        codexItemId: input.codexItemId,
        questions: input.questions,
        autoResolutionMs: input.autoResolutionMs,
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { status: "created", request: inserted };

    const [existing] = await tx
      .select()
      .from(codexUserInputRequests)
      .where(
        and(
          eq(codexUserInputRequests.requestRef, input.requestRef),
          eq(codexUserInputRequests.userId, ctx.userId),
        ),
      )
      .limit(1)
      .for("update");
    if (!existing) return { status: "conflict" };
    return sameCodexUserInputRequest(existing, ctx, input)
      ? { status: "existing", request: existing }
      : { status: "conflict" };
  });
}

export async function getCodexUserInputRequestWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  requestRef: string,
) {
  const [request] = await scoped(db, ctx, (tx) =>
    tx
      .select()
      .from(codexUserInputRequests)
      .where(
        and(
          eq(codexUserInputRequests.requestRef, requestRef),
          eq(codexUserInputRequests.userId, ctx.userId),
        ),
      )
      .limit(1),
  );
  return request;
}

/**
 * Owner-scoped recovery read for the Room currently being rendered. This
 * returns pending requests plus the explicit unavailable receipt. The broker
 * removes its live closure immediately after accepting an answer, before the
 * durable row is marked submitted, so dispatching/submitted must never be
 * treated as a restart loss. Retaining unavailable lets a browser retry after
 * its first HTTP recovery response was lost, without re-opening the answer.
 * Answer values and upstream request ids never enter this table or this
 * projection path.
 */
export function listCodexUserInputRequestsForRoomWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  input: { readonly roomId: string; readonly limit: number },
) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 16) {
    throw new Error("Codex user-input Room read limit must be between 1 and 16");
  }
  return scoped(db, ctx, (tx) =>
    tx
      .select()
      .from(codexUserInputRequests)
      .where(
        and(
          eq(codexUserInputRequests.userId, ctx.userId),
          eq(codexUserInputRequests.roomId, input.roomId),
          inArray(codexUserInputRequests.state, ["awaiting_human", "unavailable"]),
        ),
      )
      // Newer requests win a bounded recovery page; an old in-flight row can
      // never starve the prompt that is currently at the bottom of a Room.
      .orderBy(sql`${codexUserInputRequests.createdAt} DESC`, sql`${codexUserInputRequests.requestRef} DESC`)
      .limit(input.limit),
  );
}

/**
 * Claims a request immediately before the server relays an in-memory answer.
 * It re-locks the current binding generation and live state; the caller must
 * never treat a persisted question as permission to resume an old child.
 */
export async function claimCodexUserInputRequestDispatchWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  input: { readonly requestRef: string; readonly expectedRevision: number; readonly now?: Date },
): Promise<CodexUserInputRequestTransitionResult> {
  const now = input.now ?? new Date();
  return transitionCodexUserInputRequestWith(db, ctx, { ...input, now }, {
    from: ["awaiting_human"],
    to: "dispatching",
    requireUnexpired: true,
    bindingStates: ["active", "awaiting_input"],
  });
}

/** Records only that the in-memory answer was accepted for relay delivery. */
export async function markCodexUserInputRequestSubmittedWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  input: { readonly requestRef: string; readonly expectedRevision: number; readonly now?: Date },
): Promise<CodexUserInputRequestTransitionResult> {
  return transitionCodexUserInputRequestWith(db, ctx, input, {
    from: ["dispatching"],
    to: "submitted",
    requireUnexpired: true,
    bindingStates: ["active", "awaiting_input"],
  });
}

/**
 * Records a terminal fact without creating Task/TaskRun lifecycle ownership.
 * A stale binding cannot be settled as a normal terminal; callers use the
 * unavailable result to make restart/replacement fail closed.
 */
export async function settleCodexUserInputRequestWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  input: {
    readonly requestRef: string;
    readonly expectedRevision: number;
    readonly state: CodexUserInputRequestFinalState;
    readonly now?: Date;
  },
): Promise<CodexUserInputRequestTransitionResult> {
  return transitionCodexUserInputRequestWith(db, ctx, input, {
    from: ["awaiting_human", "dispatching", "submitted"],
    to: input.state,
    requireUnexpired: false,
    bindingStates: [
      "active",
      "awaiting_input",
      "completed",
      "cancelled",
      "errored",
      "recovery_required",
    ],
  });
}

/**
 * A restart/replacement can mark a request unavailable after proving that the
 * original binding is no longer current. This never resumes a request, and
 * stores only the stable product code enforced by the schema.
 */
export async function markCodexUserInputRequestUnavailableWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  input: { readonly requestRef: string; readonly expectedRevision: number; readonly now?: Date },
): Promise<CodexUserInputRequestTransitionResult> {
  const now = input.now ?? new Date();
  return scoped(db, ctx, async (tx) => {
    const [request] = await tx
      .select()
      .from(codexUserInputRequests)
      .where(
        and(
          eq(codexUserInputRequests.requestRef, input.requestRef),
          eq(codexUserInputRequests.userId, ctx.userId),
          eq(codexUserInputRequests.sourceAgentId, ctx.agentId),
        ),
      )
      .limit(1)
      .for("update");
    if (!request || request.revision !== input.expectedRevision) {
      return { status: "conflict" };
    }
    if (isCodexUserInputRequestTerminal(request.state)) {
      return { status: "already_terminal", request };
    }
    const binding = await lockExactCodexUserInputBinding(tx, ctx, request, [
      "active",
      "awaiting_input",
      "completed",
      "cancelled",
      "errored",
      "recovery_required",
    ]);
    if (binding) return { status: "conflict" };
    const [updated] = await tx
      .update(codexUserInputRequests)
      .set({
        state: "unavailable",
        failureCode: "CODEX_REQUEST_UNAVAILABLE",
        terminalAt: now,
        revision: input.expectedRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(codexUserInputRequests.requestRef, input.requestRef),
          eq(codexUserInputRequests.userId, ctx.userId),
          eq(codexUserInputRequests.sourceAgentId, ctx.agentId),
          eq(codexUserInputRequests.revision, input.expectedRevision),
          inArray(codexUserInputRequests.state, ["awaiting_human", "dispatching", "submitted"]),
        ),
      )
      .returning();
    return updated ? { status: "transitioned", request: updated } : { status: "conflict" };
  });
}

/** Explicit bounded-retention affordance; an operations job supplies policy. */
export async function deleteExpiredCodexUserInputRequestFactsWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  input: { readonly before: Date; readonly limit: number },
) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
    throw new Error("Codex user-input cleanup limit must be between 1 and 1000");
  }
  return scoped(db, ctx, async (tx) => {
    const stale = await tx
      .select({ requestRef: codexUserInputRequests.requestRef })
      .from(codexUserInputRequests)
      .where(
        and(
          eq(codexUserInputRequests.userId, ctx.userId),
          isNotNull(codexUserInputRequests.terminalAt),
          lt(codexUserInputRequests.terminalAt, input.before),
        ),
      )
      .limit(input.limit)
      .for("update");
    if (stale.length === 0) return [];
    return tx
      .delete(codexUserInputRequests)
      .where(
        and(
          eq(codexUserInputRequests.userId, ctx.userId),
          inArray(codexUserInputRequests.requestRef, stale.map((row) => row.requestRef)),
        ),
      )
      .returning();
  });
}

async function transitionCodexUserInputRequestWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  input: { readonly requestRef: string; readonly expectedRevision: number; readonly now?: Date },
  transition: {
    readonly from: readonly CodexUserInputRequestState[];
    readonly to: "dispatching" | "submitted" | CodexUserInputRequestFinalState;
    readonly requireUnexpired: boolean;
    readonly bindingStates: readonly CodexBindingOperationalState[];
  },
): Promise<CodexUserInputRequestTransitionResult> {
  const now = input.now ?? new Date();
  return scoped(db, ctx, async (tx) => {
    const [request] = await tx
      .select()
      .from(codexUserInputRequests)
      .where(
        and(
          eq(codexUserInputRequests.requestRef, input.requestRef),
          eq(codexUserInputRequests.userId, ctx.userId),
          eq(codexUserInputRequests.sourceAgentId, ctx.agentId),
        ),
      )
      .limit(1)
      .for("update");
    if (!request || request.revision !== input.expectedRevision) {
      return { status: "conflict" };
    }
    if (isCodexUserInputRequestTerminal(request.state)) {
      return { status: "already_terminal", request };
    }
    if (!transition.from.includes(request.state)) return { status: "conflict" };
    if (transition.requireUnexpired && request.expiresAt.getTime() <= now.getTime()) {
      return { status: "expired" };
    }
    const binding = await lockExactCodexUserInputBinding(tx, ctx, request, transition.bindingStates);
    if (!binding) return { status: "stale_binding" };

    const final = isCodexUserInputRequestTerminal(transition.to);
    const [updated] = await tx
      .update(codexUserInputRequests)
      .set({
        state: transition.to,
        ...(transition.to === "dispatching" ? { dispatchingAt: now } : {}),
        ...(transition.to === "submitted" ? { submittedAt: now } : {}),
        ...(final
          ? {
              terminalAt: now,
              failureCode: failureCodeFor(transition.to as CodexUserInputRequestFinalState),
            }
          : {}),
        revision: input.expectedRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(codexUserInputRequests.requestRef, input.requestRef),
          eq(codexUserInputRequests.userId, ctx.userId),
          eq(codexUserInputRequests.sourceAgentId, ctx.agentId),
          eq(codexUserInputRequests.revision, input.expectedRevision),
          inArray(codexUserInputRequests.state, [...transition.from]),
          ...(transition.requireUnexpired ? [gt(codexUserInputRequests.expiresAt, now)] : []),
        ),
      )
      .returning();
    return updated ? { status: "transitioned", request: updated } : { status: "conflict" };
  });
}

async function lockExactCodexUserInputBinding(
  tx: CodexTx,
  ctx: CodexAgentContext,
  input: Pick<
    CodexUserInputRequestInsert,
    "bindingId" | "bindingGeneration" | "roomId" | "taskId" | "taskRunId" | "jobId" | "codexThreadId"
  >,
  states: readonly CodexBindingOperationalState[],
) {
  const [binding] = await tx
    .select({ id: codexThreadBindings.id })
    .from(codexThreadBindings)
    .where(
      and(
        eq(codexThreadBindings.id, input.bindingId),
        eq(codexThreadBindings.userId, ctx.userId),
        eq(codexThreadBindings.sourceAgentId, ctx.agentId),
        eq(codexThreadBindings.bindingGeneration, input.bindingGeneration),
        eq(codexThreadBindings.roomId, input.roomId),
        eq(codexThreadBindings.taskId, input.taskId),
        eq(codexThreadBindings.taskRunId, input.taskRunId),
        eq(codexThreadBindings.jobId, input.jobId),
        eq(codexThreadBindings.codexThreadId, input.codexThreadId),
        inArray(codexThreadBindings.state, [...states]),
        isNull(codexThreadBindings.archivedAt),
      ),
    )
    .limit(1)
    .for("update");
  return binding;
}

function sameCodexUserInputRequest(
  existing: typeof codexUserInputRequests.$inferSelect,
  ctx: CodexAgentContext,
  input: CodexUserInputRequestInsert,
): boolean {
  return existing.userId === ctx.userId &&
    existing.sourceAgentId === ctx.agentId &&
    existing.bindingId === input.bindingId &&
    existing.bindingGeneration === input.bindingGeneration &&
    existing.roomId === input.roomId &&
    existing.taskId === input.taskId &&
    existing.taskRunId === input.taskRunId &&
    existing.jobId === input.jobId &&
    existing.codexThreadId === input.codexThreadId &&
    existing.codexTurnId === input.codexTurnId &&
    existing.codexItemId === input.codexItemId &&
    existing.autoResolutionMs === input.autoResolutionMs &&
    existing.expiresAt.getTime() === input.expiresAt.getTime() &&
    stableJson(existing.questions) === stableJson(input.questions);
}

function isCodexUserInputRequestTerminal(state: CodexUserInputRequestState): boolean {
  return state === "expired" || state === "cancelled" || state === "unavailable" || state === "terminal";
}

function failureCodeFor(state: CodexUserInputRequestFinalState): string | null {
  if (state === "expired") return "CODEX_REQUEST_EXPIRED";
  if (state === "cancelled") return "CODEX_REQUEST_CANCELLED";
  if (state === "unavailable") return "CODEX_REQUEST_UNAVAILABLE";
  return null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function getActiveCodexBindingForTaskWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  taskId: string,
) {
  const [row] = await scoped(db, ctx, (tx) =>
    tx
      .select()
      .from(codexThreadBindings)
      .where(
        and(
          eq(codexThreadBindings.userId, ctx.userId),
          eq(codexThreadBindings.taskId, taskId),
          eq(codexThreadBindings.bindingKind, "task"),
          isNull(codexThreadBindings.archivedAt),
        ),
      )
      .limit(1),
  );
  return row;
}

/**
 * The server-owned profile-removal coordinator's exact worklist.  Every
 * retained binding has a canonical Task, including direct Room work, so this
 * intentionally does not filter by binding kind.  It is owner/profile scoped
 * and returns no prompt, Room content, path, or provider payload.
 *
 * Bindings from an older account generation are included deliberately: they
 * remain retained live rows until profile removal archives them, and excluding
 * them would let finalization get stuck behind history the coordinator never
 * terminalized.
 */
export type CodexProfileRemovalTaskBindingWork = {
  readonly taskId: string;
  readonly jobId: string;
};

export function listCodexProfileRemovalTaskBindingWorkWith(
  db: DirectDatabase,
  ctx: CodexOwnerContext,
  profileId: string,
): Promise<readonly CodexProfileRemovalTaskBindingWork[]> {
  return withTrustContext(ctx, async (tx) => {
    const rows = resultRows<{ task_id: string; job_id: string }>(await tx.execute(sql`
      SELECT task_id, job_id
      FROM public.app_list_codex_profile_removal_work(${ctx.userId}::uuid, ${profileId}::uuid)
    `));
    return rows.map((row) => ({ taskId: row.task_id, jobId: row.job_id }));
  }, db);
}

export async function insertCodexBindingWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  input: CodexInternalBindingInsert,
) {
  const [row] = await scoped(db, ctx, (tx) =>
    tx
      .insert(codexThreadBindings)
      .values({ ...input, userId: ctx.userId })
      .returning(),
  );
  return row;
}

/**
 * Starts the two-phase removal while serializing every preference selection
 * against it. The returned statuses deliberately distinguish safe retries
 * from an active-profile stale revision conflict.
 */
export function beginCodexProfileRemovalWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  input: { id: string; expectedRevision: number },
): Promise<BeginCodexProfileRemovalResult> {
  return scoped(db, ctx, async (tx) => {
    const [profile] = await tx
      .select()
      .from(codexAccountProfiles)
      .where(
        and(
          eq(codexAccountProfiles.id, input.id),
          eq(codexAccountProfiles.userId, ctx.userId),
        ),
      )
      .for("update");
    if (!profile) return { status: "conflict" };
    if (profile.removalState === "removing") {
      return { status: "already_removing", profile };
    }
    if (profile.removalState === "removed") {
      return { status: "already_removed", profile };
    }
    if (profile.revision !== input.expectedRevision) {
      return { status: "conflict" };
    }

    const now = new Date();
    const [started] = await tx
      .update(codexAccountProfiles)
      .set({
        removalState: "removing",
        revision: input.expectedRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(codexAccountProfiles.id, input.id),
          eq(codexAccountProfiles.userId, ctx.userId),
          eq(codexAccountProfiles.removalState, "active"),
          eq(codexAccountProfiles.revision, input.expectedRevision),
        ),
      )
      .returning();
    if (!started) return { status: "conflict" };

    await tx
      .update(codexUserPreferences)
      .set({
        enabled: false,
        accountProfileId: null,
        revision: sql`${codexUserPreferences.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(codexUserPreferences.userId, ctx.userId),
          eq(codexUserPreferences.accountProfileId, input.id),
        ),
      );
    return { status: "begun", profile: started };
  });
}

/**
 * Finalizes only the exact removal operation the caller started. Archived
 * bindings remain valid history; live bindings and any selecting preference
 * deliberately hold finalization until their own workflows have completed.
 */
export function finalizeCodexProfileRemovalWith(
  db: CodexDb,
  ctx: CodexOwnerContext,
  input: CodexProfileRemovalIdentity & { expectedRevision: number },
): Promise<FinalizeCodexProfileRemovalResult> {
  return scoped(db, ctx, async (tx) => {
    const [profile] = await tx
      .select()
      .from(codexAccountProfiles)
      .where(
        and(
          eq(codexAccountProfiles.id, input.id),
          eq(codexAccountProfiles.userId, ctx.userId),
        ),
      )
      .for("update");
    if (!profile) return { status: "conflict" };
    const exactIdentity =
      profile.relayId === input.relayId &&
      profile.homeHandle === input.homeHandle &&
      profile.profileGeneration === input.profileGeneration &&
      profile.accountGeneration === input.accountGeneration;
    if (!exactIdentity) return { status: "conflict" };
    if (profile.removalState === "removed") {
      return profile.revision === input.expectedRevision + 1
        ? { status: "already_removed", profile }
        : { status: "conflict" };
    }
    if (
      profile.removalState !== "removing" ||
      profile.revision !== input.expectedRevision
    ) {
      return { status: "conflict" };
    }

    const userPreferences = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(codexUserPreferences)
      .where(
        and(
          eq(codexUserPreferences.userId, ctx.userId),
          eq(codexUserPreferences.accountProfileId, input.id),
        ),
      );
    const bindings = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(codexThreadBindings)
      .where(
        and(
          eq(codexThreadBindings.userId, ctx.userId),
          eq(codexThreadBindings.accountProfileId, input.id),
          isNull(codexThreadBindings.archivedAt),
        ),
      );
    const selectingPreferenceCount = userPreferences[0]?.count ?? 0;
    const unarchivedBindingCount = bindings[0]?.count ?? 0;
    if (selectingPreferenceCount !== 0 || unarchivedBindingCount !== 0) {
      return { status: "blocked", selectingPreferenceCount, unarchivedBindingCount };
    }

    const now = new Date();
    const [finalized] = await tx
      .update(codexAccountProfiles)
      .set({
        removalState: "removed",
        removedAt: now,
        authState: "signed_out",
        revision: input.expectedRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(codexAccountProfiles.id, input.id),
          eq(codexAccountProfiles.userId, ctx.userId),
          eq(codexAccountProfiles.removalState, "removing"),
          eq(codexAccountProfiles.revision, input.expectedRevision),
          eq(codexAccountProfiles.relayId, input.relayId),
          eq(codexAccountProfiles.homeHandle, input.homeHandle),
          eq(codexAccountProfiles.profileGeneration, input.profileGeneration),
          eq(codexAccountProfiles.accountGeneration, input.accountGeneration),
        ),
      )
      .returning();
    return finalized
      ? { status: "finalized", profile: finalized }
      : { status: "conflict" };
  });
}

/**
 * Archives every still-live binding for one exact tombstoned profile. This is
 * deliberately owner/profile scoped rather than derived from a caller-owned
 * Agent or Room: profile removal spans all of the owner's optional Genie
 * overrides and retained bindings. It may only run while the same
 * `removing` revision is locked, after the paired host has completed its
 * logout/drain/reap/private-home proof.
 */
export function archiveCodexProfileBindingsForRemovalWith(
  db: DirectDatabase,
  ctx: CodexOwnerContext,
  input: CodexProfileRemovalIdentity & { expectedRevision: number },
): Promise<ArchiveCodexProfileBindingsForRemovalResult> {
  return withTrustContext(ctx, async (tx) => {
    const rows = resultRows<{ count: number | string | null }>(await tx.execute(sql`
      SELECT public.app_archive_codex_profile_removal_bindings(
        ${ctx.userId}::uuid,
        ${input.id}::uuid,
        ${input.relayId},
        ${input.homeHandle},
        ${input.profileGeneration},
        ${input.accountGeneration},
        ${input.expectedRevision}
      ) AS count
    `));
    const count = rows[0]?.count;
    if (count === null || count === undefined) return { status: "conflict" };
    const parsed = typeof count === "number" ? count : Number(count);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error("invalid Codex profile-removal archive count");
    }
    return { status: "archived", count: parsed };
  }, db);
}

function resultRows<T>(result: unknown): readonly T[] {
  if (Array.isArray(result)) return result as readonly T[];
  if (
    result !== null &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: readonly T[] }).rows;
  }
  throw new Error("invalid Codex profile-removal database result");
}

export async function updateCodexBindingStateWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  binding: CodexInternalBindingLocator,
  state: CodexBindingOperationalState,
  expectedRevision: number,
  cursor?: { lastTurnId?: string | null; lastItemCursor?: string | null },
) {
  const [row] = await scoped(db, ctx, (tx) =>
    tx
      .update(codexThreadBindings)
      .set({
        state,
        ...cursor,
        revision: expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(codexThreadBindings.id, binding.id),
          eq(codexThreadBindings.userId, ctx.userId),
          eq(codexThreadBindings.sourceAgentId, ctx.agentId),
          eq(codexThreadBindings.taskId, binding.taskId),
          eq(codexThreadBindings.taskRunId, binding.taskRunId),
          eq(codexThreadBindings.jobId, binding.jobId),
          eq(codexThreadBindings.roomId, binding.roomId),
          eq(codexThreadBindings.laneKey, binding.laneKey),
          eq(codexThreadBindings.revision, expectedRevision),
          isNull(codexThreadBindings.archivedAt),
        ),
      )
      .returning(),
  );
  return row;
}

export async function archiveCodexBindingWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  binding: CodexInternalBindingLocator,
  expectedRevision: number,
) {
  const now = new Date();
  const [row] = await scoped(db, ctx, (tx) =>
    tx
      .update(codexThreadBindings)
      .set({
        state: "archived",
        archivedAt: now,
        revision: expectedRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(codexThreadBindings.id, binding.id),
          eq(codexThreadBindings.userId, ctx.userId),
          eq(codexThreadBindings.sourceAgentId, ctx.agentId),
          eq(codexThreadBindings.taskId, binding.taskId),
          eq(codexThreadBindings.taskRunId, binding.taskRunId),
          eq(codexThreadBindings.jobId, binding.jobId),
          eq(codexThreadBindings.roomId, binding.roomId),
          eq(codexThreadBindings.laneKey, binding.laneKey),
          eq(codexThreadBindings.revision, expectedRevision),
          isNull(codexThreadBindings.archivedAt),
        ),
      )
      .returning(),
  );
  return row;
}

/**
 * Archive-and-insert is one transaction. Any RLS, FK, uniqueness, or check
 * failure on the successor rolls the archive back, leaving the original live.
 */
export function replaceCodexBindingWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  input: {
    current: CodexInternalBindingLocator;
    expectedRevision: number;
    replacement: CodexInternalBindingInsert;
  },
) {
  return scoped(db, ctx, async (tx) => {
    const [current] = await tx
      .select()
      .from(codexThreadBindings)
      .where(
        and(
          eq(codexThreadBindings.id, input.current.id),
          eq(codexThreadBindings.userId, ctx.userId),
          eq(codexThreadBindings.sourceAgentId, ctx.agentId),
          eq(codexThreadBindings.taskId, input.current.taskId),
          eq(codexThreadBindings.taskRunId, input.current.taskRunId),
          eq(codexThreadBindings.jobId, input.current.jobId),
          eq(codexThreadBindings.roomId, input.current.roomId),
          eq(codexThreadBindings.laneKey, input.current.laneKey),
          eq(codexThreadBindings.revision, input.expectedRevision),
          isNull(codexThreadBindings.archivedAt),
        ),
      )
      .for("update");
    if (!current) return undefined;

    const archivedAt = new Date();
    const [archived] = await tx
      .update(codexThreadBindings)
      .set({
        state: "archived",
        archivedAt,
        revision: input.expectedRevision + 1,
        updatedAt: archivedAt,
      })
      .where(
        and(
          eq(codexThreadBindings.id, current.id),
          eq(codexThreadBindings.revision, input.expectedRevision),
          isNull(codexThreadBindings.archivedAt),
        ),
      )
      .returning();
    if (!archived) return undefined;

    const [replacement] = await tx
      .insert(codexThreadBindings)
      .values({ ...input.replacement, userId: ctx.userId })
      .returning();
    if (!replacement) throw new Error("Codex binding replacement insert failed");
    return { archived, replacement };
  });
}

/**
 * The migration trigger is the final guard. This helper supplies only the
 * exact legal same-row `needs_rebind -> active` refresh shape.
 */
export async function rebindCodexBindingWith(
  db: CodexDb,
  ctx: CodexAgentContext,
  input: {
    binding: CodexInternalBindingLocator;
    expectedRevision: number;
    expectedBindingGeneration: number;
    relaySessionId: string;
    desktopSessionId: string;
    capabilityRevision: number;
    workspaceRef: string;
    workspaceRevision: number;
    workspaceIssuedAt: Date;
    workspaceExpiresAt: Date;
    childGeneration: number;
    expected: {
      parentTaskId: string | null;
      bindingKind: "task";
      relayId: string;
      pairingGenerationRef: string;
      workspaceFingerprint: string;
      accountProfileId: string;
      codexThreadId: string;
      profileGeneration: number;
      accountGeneration: number;
      runtimeGeneration: number;
      selectedModel: string | null;
      codexSandboxMode: "default" | "workspace-write" | "danger-full-access";
      codexApprovalPolicy: "default" | "on-request" | "never";
    };
  },
) {
  const [row] = await scoped(db, ctx, (tx) =>
    tx
      .update(codexThreadBindings)
      .set({
        state: "active",
        relaySessionId: input.relaySessionId,
        desktopSessionId: input.desktopSessionId,
        capabilityRevision: input.capabilityRevision,
        workspaceRef: input.workspaceRef,
        workspaceRevision: input.workspaceRevision,
        workspaceIssuedAt: input.workspaceIssuedAt,
        workspaceExpiresAt: input.workspaceExpiresAt,
        childGeneration: input.childGeneration,
        bindingGeneration: input.expectedBindingGeneration + 1,
        revision: input.expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(codexThreadBindings.id, input.binding.id),
          eq(codexThreadBindings.userId, ctx.userId),
          eq(codexThreadBindings.sourceAgentId, ctx.agentId),
          eq(codexThreadBindings.taskId, input.binding.taskId),
          eq(codexThreadBindings.taskRunId, input.binding.taskRunId),
          eq(codexThreadBindings.jobId, input.binding.jobId),
          eq(codexThreadBindings.roomId, input.binding.roomId),
          eq(codexThreadBindings.laneKey, input.binding.laneKey),
          input.expected.parentTaskId === null
            ? isNull(codexThreadBindings.parentTaskId)
            : eq(
                codexThreadBindings.parentTaskId,
                input.expected.parentTaskId,
              ),
          eq(codexThreadBindings.bindingKind, input.expected.bindingKind),
          eq(codexThreadBindings.state, "needs_rebind"),
          eq(codexThreadBindings.relayId, input.expected.relayId),
          eq(
            codexThreadBindings.pairingGenerationRef,
            input.expected.pairingGenerationRef,
          ),
          eq(
            codexThreadBindings.workspaceFingerprint,
            input.expected.workspaceFingerprint,
          ),
          eq(
            codexThreadBindings.accountProfileId,
            input.expected.accountProfileId,
          ),
          eq(codexThreadBindings.codexThreadId, input.expected.codexThreadId),
          eq(
            codexThreadBindings.profileGeneration,
            input.expected.profileGeneration,
          ),
          eq(
            codexThreadBindings.accountGeneration,
            input.expected.accountGeneration,
          ),
          eq(
            codexThreadBindings.runtimeGeneration,
            input.expected.runtimeGeneration,
          ),
          input.expected.selectedModel === null
            ? isNull(codexThreadBindings.selectedModel)
            : eq(
                codexThreadBindings.selectedModel,
                input.expected.selectedModel,
              ),
          eq(
            codexThreadBindings.codexSandboxMode,
            input.expected.codexSandboxMode,
          ),
          eq(
            codexThreadBindings.codexApprovalPolicy,
            input.expected.codexApprovalPolicy,
          ),
          eq(codexThreadBindings.revision, input.expectedRevision),
          eq(
            codexThreadBindings.bindingGeneration,
            input.expectedBindingGeneration,
          ),
          isNull(codexThreadBindings.archivedAt),
        ),
      )
      .returning(),
  );
  return row;
}
