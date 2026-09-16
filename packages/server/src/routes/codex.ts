import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { CodexAdminControlPlane } from "../codex/admin-control-plane";
import { CodexAdminControlFailure } from "../codex/admin-control-plane";
import type {
  CodexConnectionProfile,
  CodexConnectionSummary,
  CodexPosture,
  CodexRuntimeSummary,
  CodexUserPreference,
} from "@nautilo/types";
import {
  codexUserPreferenceMutationSchema,
} from "@nautilo/types";
import type { CodexUsageSnapshot, CodexUsageSnapshotPatch } from "@nautilo/db";
import type { CodexHostStatus } from "@nautilo/relay";
import {
  CodexUsageCache,
  requestedUsageRefreshFailure,
  withCodexUsageFreshness,
} from "../codex/usage-cache";

type StoredProfile = {
  readonly id: string;
  readonly relayId: string;
  readonly homeHandle: string;
  readonly label: string;
  readonly accountEmail: string | null;
  readonly authState: string;
  readonly planType: string | null;
  readonly usageSnapshot: CodexUsageSnapshot | null;
  readonly usageObservedAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly revision: number;
  readonly profileGeneration: number;
  readonly accountGeneration: number;
  readonly registrationState: "provisional" | "registered";
  readonly removalState: string;
};

type ProfileStatusUpdate = {
  readonly userId: string;
  readonly profileId: string;
  readonly authState: "signed_out" | "login_pending" | "signed_in" | "expired" | "error";
  readonly profileGeneration: number;
  readonly accountGeneration: number;
  readonly accountEmail?: string | null;
  readonly planType?: string | null;
  readonly expectedRegistrationState?: "provisional" | "registered";
  readonly expectedRevision: number;
};

type RuntimeInspection = Awaited<ReturnType<CodexAdminControlPlane["inspectRuntime"]>>;
type AccountProjection = Awaited<ReturnType<CodexAdminControlPlane["readAccount"]>>;
type AttachedProfile = {
  readonly row: StoredProfile;
  readonly account: AccountProjection | null;
  readonly reconciliationState: "current" | "reconnecting" | "cleanup_required";
};
type StoredUserPreference = {
  readonly enabled: boolean;
  readonly accountProfileId: string | null;
  readonly defaultPosture: string;
  readonly revision: number;
};

/**
 * Server-private identity retained by the DB tombstone coordinator. The
 * browser supplies only an opaque profile id plus its optimistic revision;
 * relay/home/generation authority is always read back from this row.
 */
type StoredProfileRemoval = {
  readonly id: string;
  readonly relayId: string;
  readonly homeHandle: string;
  readonly profileGeneration: number;
  readonly accountGeneration: number;
  readonly revision: number;
};

type BeginProfileRemoval =
  | { readonly status: "begun" | "already_removing" | "already_removed"; readonly profile: StoredProfileRemoval }
  | { readonly status: "conflict" };
type ArchiveProfileBindingsForRemoval =
  | { readonly status: "archived"; readonly count: number }
  | { readonly status: "conflict" };
type FinalizeProfileRemoval =
  | { readonly status: "finalized" | "already_removed"; readonly profile: StoredProfileRemoval }
  | { readonly status: "blocked"; readonly selectingPreferenceCount: number; readonly unarchivedBindingCount: number }
  | { readonly status: "conflict" };

type ProfileRemovalTurnDrain = {
  readonly userId: string;
  readonly profile: StoredProfileRemoval;
};

/** Server-observed identity for a live v8 Codex host, never browser input. */
export type HostInspectionScope = {
  readonly relaySessionId: string;
  readonly desktopSessionId: string;
  readonly capabilityRevision: number;
};

export interface CodexConnectionsRouteDeps {
  readonly control: CodexAdminControlPlane;
  /** Resolve an exact reachable v8 Electron Codex relay for this owner. */
  readonly resolveHost: (
    userId: string,
    relayId?: string,
  ) => Promise<{ readonly relayId: string } | null>;
  /** Fresh relay projection after an admin command; never browser supplied. */
  readonly readHostStatus: (userId: string, relayId: string) => CodexHostStatus | null;
  /** Exact live session identity used only to scope server-owned inspect snapshots. */
  readonly readHostInspectionScope: (userId: string, relayId: string) => HostInspectionScope | null;
  readonly listProfiles: (userId: string) => Promise<readonly StoredProfile[]>;
  readonly getProfile: (userId: string, profileId: string) => Promise<StoredProfile | undefined>;
  readonly createProfile: (input: { id: string; userId: string; relayId: string; homeHandle: string; label: string; profileGeneration: number; accountGeneration: number; authState: "signed_out"; registrationState: "provisional" }) => Promise<StoredProfile>;
  readonly renameProfile: (input: { userId: string; profileId: string; label: string; expectedRevision: number }) => Promise<StoredProfile | undefined>;
  readonly updateProfileStatus: (input: ProfileStatusUpdate) => Promise<StoredProfile | undefined>;
  readonly registerProfileFromOfficialAccount: (input: {
    userId: string; profileId: string; profileGeneration: number; accountGeneration: number;
    accountEmail?: string | null; planType?: string | null; expectedRevision: number;
  }) => Promise<StoredProfile | undefined>;
  /** Exact-generation, optimistic snapshot write; no raw provider data. */
  readonly updateProfileUsageSnapshot: (input: {
    readonly userId: string;
    readonly profileId: string;
    readonly profileGeneration: number;
    readonly accountGeneration: number;
    readonly expectedRevision: number;
    readonly patch: CodexUsageSnapshotPatch;
    readonly observedAt: Date;
  }) => Promise<StoredProfile | undefined>;
  /** Starts/retries the owner DB tombstone before the host destructive flow. */
  readonly beginProfileRemoval: (input: {
    readonly userId: string;
    readonly profileId: string;
    readonly expectedRevision: number;
  }) => Promise<BeginProfileRemoval>;
  /**
   * Server-owned canonical Task/Job drain. It runs after the DB tombstone
   * disables selection but before the paired host begins destructive cleanup.
   */
  readonly drainProfileTurns: (input: ProfileRemovalTurnDrain) => Promise<void>;
  /** Archives retained binding history only after exact host cleanup succeeds. */
  readonly archiveProfileBindingsForRemoval: (input: {
    readonly userId: string;
    readonly profile: StoredProfileRemoval;
  }) => Promise<ArchiveProfileBindingsForRemoval>;
  /** Finalizes exactly the tombstone revision that the host just cleaned up. */
  readonly finalizeProfileRemoval: (input: {
    readonly userId: string;
    readonly profile: StoredProfileRemoval;
  }) => Promise<FinalizeProfileRemoval>;
  readonly getUserPreference: (userId: string) => Promise<StoredUserPreference>;
  readonly upsertUserPreference: (input: {
    userId: string;
    profileId: string | null;
    posture: CodexUserPreference["posture"];
    enabled: boolean;
    expectedRevision: number;
  }) => Promise<StoredUserPreference | undefined>;
  /** Testable bounds for the passive exact-session inspection cache. */
  readonly runtimeInspectionCache?: {
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly maxEntries?: number;
  };
  /** Testable bounds for explicit, exact-profile usage refresh singleflight. */
  readonly usageRefreshCache?: {
    readonly now?: () => Date;
    readonly maxInFlight?: number;
  };
}

const label = z.object({ label: z.string().trim().min(1).max(120) }).strict();
const connect = z.object({}).strict();
const revision = z.object({ expectedRevision: z.number().int().nonnegative() }).strict();
const activate = z.object({ runtimeGeneration: z.number().int().nonnegative() }).strict();
const loginCancel = z.object({ loginRef: z.string().min(1).max(512) }).strict();
const DEFAULT_RUNTIME_INSPECTION_TTL_MS = 30_000;
const DEFAULT_MAX_RUNTIME_INSPECTIONS = 32;
const codexHostRelayId = z.string().min(1).max(512);

type AuthenticatedCodexRequest = {
  readonly sessionUserId: string | null;
  readonly policyContext?: { readonly actorRole?: string } | null;
};

type CachedRuntimeInspection = {
  readonly inspected: RuntimeInspection;
  readonly expiresAt: number;
};

/** Owner-authenticated Connections facade; relay scopes and host material stay server-only. */
export function codexConnectionRoutes(app: FastifyInstance, deps: CodexConnectionsRouteDeps): void {
  // Inspection can cold-start a launcher and app-server. Keep the successful
  // semantic result for the exact v8 host session instead of re-probing on
  // every passive Connections summary read. A reconnect/capability revision
  // naturally selects a new key; explicit inspect requests bypass this cache.
  const cacheNow = deps.runtimeInspectionCache?.now ?? Date.now;
  const cacheTtlMs = deps.runtimeInspectionCache?.ttlMs ?? DEFAULT_RUNTIME_INSPECTION_TTL_MS;
  const maxCachedRuntimeInspections =
    deps.runtimeInspectionCache?.maxEntries ?? DEFAULT_MAX_RUNTIME_INSPECTIONS;
  if (
    !Number.isSafeInteger(cacheTtlMs) ||
    cacheTtlMs <= 0 ||
    !Number.isSafeInteger(maxCachedRuntimeInspections) ||
    maxCachedRuntimeInspections <= 0
  ) {
    throw new Error("invalid Codex runtime inspection cache bounds");
  }
  const runtimeInspections = new Map<string, CachedRuntimeInspection>();
  const latestRuntimeInspectionKeys = new Map<string, string>();
  const usageCache = new CodexUsageCache(deps.usageRefreshCache);
  const guarded = async <T>(reply: FastifyReply, operation: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await operation();
    } catch (error) {
      const code = error instanceof CodexAdminControlFailure
        ? error.code
        : "CODEX_UNAVAILABLE";
      reply.code(code === "CODEX_FORBIDDEN" ? 403 : 409).send({ code });
      return undefined;
    }
  };
  const authenticatedUser = (
    request: AuthenticatedCodexRequest,
    reply: FastifyReply,
  ): string | null => {
    const userId = request.sessionUserId;
    if (!userId) {
      reply.code(401).send({ error: "Authentication required" });
      return null;
    }
    if (request.policyContext?.actorRole === "guest") {
      reply.code(403).send({ code: "CODEX_FORBIDDEN" });
      return null;
    }
    return userId;
  };
  app.addHook("preHandler", (request, reply, done) => {
    const pathname = request.url.split("?", 1)[0] ?? "";
    if (pathname !== "/api/codex" && !pathname.startsWith("/api/codex/")) {
      done();
      return;
    }
    if (!request.sessionUserId) {
      void reply.code(401).send({ error: "Authentication required" });
      return;
    }
    if (request.policyContext?.actorRole === "guest") {
      void reply.code(403).send({ code: "CODEX_FORBIDDEN" });
      return;
    }
    done();
  });
  const host = async (
    request: AuthenticatedCodexRequest & { readonly headers: Readonly<Record<string, unknown>> },
    reply: FastifyReply,
  ) => {
    const userId = authenticatedUser(request, reply);
    if (!userId) return null;
    const rawRelayId = request.headers["x-nautilo-codex-relay-id"];
    const parsedRelayId = rawRelayId === undefined
      ? undefined
      : codexHostRelayId.safeParse(rawRelayId);
    if (parsedRelayId !== undefined && !parsedRelayId.success) {
      reply.code(400).send({ error: "invalid Codex Desktop identity" });
      return null;
    }
    const target = await deps.resolveHost(userId, parsedRelayId?.data);
    if (!target) { reply.code(409).send({ code: "CODEX_UNAVAILABLE" }); return null; }
    return { userId, relayId: target.relayId };
  };
  const profile = async (
    request: AuthenticatedCodexRequest & { params: { profileId: string } },
    reply: FastifyReply,
  ) => {
    const userId = authenticatedUser(request, reply);
    if (!userId) return null;
    const row = await deps.getProfile(userId, request.params.profileId);
    // Do not reveal whether an unowned UUID exists.
    if (!row) { reply.code(404).send({ code: "CODEX_PROFILE_UNAVAILABLE" }); return null; }
    return {
      userId,
      relayId: row.relayId,
      profileHandle: row.id,
      profileGeneration: row.profileGeneration,
      accountGeneration: row.accountGeneration,
      row,
    };
  };
  const finishProfileRemoval = async (userId: string, removal: StoredProfileRemoval): Promise<void> => {
    await deps.drainProfileTurns({ userId, profile: removal });
    await deps.control.removeProfile({
      userId,
      relayId: removal.relayId,
      profileHandle: removal.id,
      profileGeneration: removal.profileGeneration,
      accountGeneration: removal.accountGeneration,
    });
    const archived = await deps.archiveProfileBindingsForRemoval({ userId, profile: removal });
    if (archived.status !== "archived") throw new CodexAdminControlFailure("CODEX_CONFLICT");
    const finalized = await deps.finalizeProfileRemoval({ userId, profile: removal });
    if (finalized.status === "blocked" || finalized.status === "conflict") {
      throw new CodexAdminControlFailure("CODEX_CONFLICT");
    }
  };
  const runtime = (
    facts: { userId: string; relayId: string },
    fallback: { state: "absent" | "installing" | "ready" | "incompatible" | "draining" | "failed"; runtimeGeneration?: number },
  ): CodexRuntimeSummary => projectRuntime(deps.readHostStatus(facts.userId, facts.relayId), fallback);
  const inspectionKey = (facts: { userId: string; relayId: string }): string | null => {
    const scope = deps.readHostInspectionScope(facts.userId, facts.relayId);
    return scope
      ? [facts.userId, facts.relayId, scope.relaySessionId, scope.desktopSessionId, scope.capabilityRevision].join("\u0000")
      : null;
  };
  const inspectionOwnerKey = (facts: { userId: string; relayId: string }): string =>
    [facts.userId, facts.relayId].join("\u0000");
  const cacheRuntimeInspection = (
    facts: { userId: string; relayId: string },
    key: string,
    inspected: RuntimeInspection,
  ): void => {
    const now = cacheNow();
    for (const [cachedKey, cached] of runtimeInspections) {
      if (cached.expiresAt <= now) evictRuntimeInspection(cachedKey);
    }
    const owner = inspectionOwnerKey(facts);
    const previous = latestRuntimeInspectionKeys.get(owner);
    if (previous && previous !== key) runtimeInspections.delete(previous);
    latestRuntimeInspectionKeys.set(owner, key);
    runtimeInspections.delete(key);
    runtimeInspections.set(key, { inspected, expiresAt: now + cacheTtlMs });
    while (runtimeInspections.size > maxCachedRuntimeInspections) {
      const oldest = runtimeInspections.keys().next().value;
      if (oldest === undefined) break;
      evictRuntimeInspection(oldest);
    }
  };
  const evictRuntimeInspection = (key: string): void => {
    runtimeInspections.delete(key);
    for (const [owner, latest] of latestRuntimeInspectionKeys) {
      if (latest === key) latestRuntimeInspectionKeys.delete(owner);
    }
  };
  const readCachedRuntimeInspection = (key: string): RuntimeInspection | null => {
    const cached = runtimeInspections.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= cacheNow()) {
      evictRuntimeInspection(key);
      return null;
    }
    // Map insertion order is the LRU order.
    runtimeInspections.delete(key);
    runtimeInspections.set(key, cached);
    return cached.inspected;
  };
  const inspectRuntime = async (
    facts: { userId: string; relayId: string },
    options: { readonly force?: boolean } = {},
  ): Promise<RuntimeInspection> => {
    const before = inspectionKey(facts);
    if (!before) throw new CodexAdminControlFailure("CODEX_UNAVAILABLE");
    if (!options.force) {
      const cached = readCachedRuntimeInspection(before);
      if (cached) return cached;
    }
    const inspected = await deps.control.inspectRuntime(facts);
    // Never attach a result to a session that changed while the command was
    // in flight. The next passive read will inspect that new exact scope.
    if (inspectionKey(facts) === before) cacheRuntimeInspection(facts, before, inspected);
    return inspected;
  };
  const replaceRuntimeInspection = (
    facts: { userId: string; relayId: string },
    inspected: RuntimeInspection,
  ): void => {
    const key = inspectionKey(facts);
    if (key) cacheRuntimeInspection(facts, key, inspected);
  };
  const runtimeMutation = async (
    facts: { userId: string; relayId: string },
    operation: () => Promise<RuntimeInspection>,
  ): Promise<RuntimeInspection> => {
    const inspected = await operation();
    replaceRuntimeInspection(facts, inspected);
    return inspected;
  };
  /**
   * Account operations are authoritative at the paired host and may advance a
   * generation while a concurrent owner edit consumes the row revision. One
   * owner-scoped reload/retry prevents that harmless race from permanently
   * stranding the persisted profile behind the live host generation.
   */
  const persistStatus = async (
    facts: NonNullable<Awaited<ReturnType<typeof profile>>>,
    input: Omit<ProfileStatusUpdate, "userId" | "profileId" | "expectedRevision">,
  ): Promise<StoredProfile> => {
    const write = async (expectedRevision: number) => {
      try {
        return await deps.updateProfileStatus({
          ...input,
          userId: facts.userId,
          profileId: facts.profileHandle,
          expectedRevision,
        });
      } catch {
        return undefined;
      }
    };
    const first = await write(facts.row.revision);
    if (first) return first;
    const refreshed = await deps.getProfile(facts.userId, facts.profileHandle);
    if (!refreshed || refreshed.profileGeneration !== input.profileGeneration) {
      throw new CodexAdminControlFailure("CODEX_STALE");
    }
    if (refreshed.accountGeneration > input.accountGeneration) return refreshed;
    if (
      input.expectedRegistrationState === "provisional"
      && refreshed.registrationState === "registered"
      && refreshed.authState === "signed_in"
      && refreshed.accountGeneration >= input.accountGeneration
    ) return refreshed;
    if (
      input.expectedRegistrationState !== undefined
      && refreshed.registrationState !== input.expectedRegistrationState
    ) throw new CodexAdminControlFailure("CODEX_STALE");
    const retried = await write(refreshed.revision);
    if (!retried) throw new CodexAdminControlFailure("CODEX_STALE");
    return retried;
  };
  const persistAccount = async (
    facts: NonNullable<Awaited<ReturnType<typeof profile>>>,
    account: AccountProjection,
  ): Promise<StoredProfile> => {
    if (facts.row.registrationState === "provisional" && account.state === "signed_in") {
      const write = (expectedRevision: number) => deps.registerProfileFromOfficialAccount({
          userId: facts.userId,
          profileId: facts.profileHandle,
          profileGeneration: facts.profileGeneration,
          accountGeneration: account.accountGeneration,
          ...(account.accountEmail !== undefined ? { accountEmail: account.accountEmail } : {}),
          ...(account.planType !== undefined ? { planType: account.planType } : {}),
          expectedRevision,
        }).catch(() => undefined);
      let registered = await write(facts.row.revision);
      if (!registered) {
        const refreshed = await deps.getProfile(facts.userId, facts.profileHandle);
        if (
          refreshed?.registrationState === "registered"
          && refreshed.profileGeneration === facts.profileGeneration
          && refreshed.accountGeneration >= account.accountGeneration
        ) return refreshed;
        if (
          refreshed?.registrationState === "provisional"
          && refreshed.profileGeneration === facts.profileGeneration
          && refreshed.accountGeneration <= account.accountGeneration
        ) registered = await write(refreshed.revision);
      }
      if (!registered) throw new CodexAdminControlFailure("CODEX_STALE");
      return registered;
    }
    return persistStatus(facts, {
      authState: account.state === "reauth_required" ? "expired" : account.state,
      profileGeneration: facts.profileGeneration,
      accountGeneration: account.accountGeneration,
      ...(account.accountEmail !== undefined ? { accountEmail: account.accountEmail } : {}),
      ...(account.planType !== undefined ? { planType: account.planType } : {}),
    });
  };
  const saveAccount = async (
    facts: NonNullable<Awaited<ReturnType<typeof profile>>>,
    account: AccountProjection,
  ) => {
    const row = await persistAccount(facts, account);
    return { authState: project(row, account).authState, profile: project(row, account) };
  };
  const refreshUsage = async (
    facts: NonNullable<Awaited<ReturnType<typeof profile>>>,
  ) => usageCache.refresh({
    userId: facts.userId,
    profileId: facts.profileHandle,
    profileGeneration: facts.profileGeneration,
    accountGeneration: facts.accountGeneration,
    expectedRevision: facts.row.revision,
  }, {
    readUsage: () => deps.control.readUsage(facts),
    readRateLimits: () => deps.control.readRateLimits(facts),
    persist: ({ identity, patch, observedAt }) => deps.updateProfileUsageSnapshot({
      userId: identity.userId,
      profileId: identity.profileId,
      profileGeneration: identity.profileGeneration,
      accountGeneration: identity.accountGeneration,
      expectedRevision: identity.expectedRevision,
      patch,
      observedAt,
    }),
  });
  const reattachSummaryProfiles = async (
    facts: { readonly userId: string; readonly relayId: string },
    profiles: readonly StoredProfile[],
  ): Promise<readonly AttachedProfile[]> => {
    const attached: AttachedProfile[] = [];
    for (const candidate of profiles) {
      if (candidate.relayId !== facts.relayId) continue;
      if (candidate.removalState === "removing" && candidate.registrationState === "provisional") {
        attached.push({ row: candidate, account: null, reconciliationState: "cleanup_required" });
        continue;
      }
      if (candidate.removalState !== "active") continue;
      if (isCurrentHostProfile(candidate, facts.relayId, deps.readHostStatus(facts.userId, facts.relayId))) {
        // Current host status deliberately omits provider identity. Read the
        // bounded account projection so Connections can distinguish multiple
        // isolated homes without exposing auth material or filesystem paths.
        const profileFacts = {
          userId: facts.userId,
          relayId: candidate.relayId,
          profileHandle: candidate.id,
          profileGeneration: candidate.profileGeneration,
          accountGeneration: candidate.accountGeneration,
          row: candidate,
        };
        const account = await deps.control.readAccount(profileFacts).catch(() => null);
        if (!account) {
          attached.push({ row: candidate, account: null, reconciliationState: "reconnecting" });
          continue;
        }
        if (account.accountGeneration < candidate.accountGeneration) {
          attached.push({ row: candidate, account: null, reconciliationState: "reconnecting" });
          continue;
        }
        const nextAuthState = account.state === "reauth_required" ? "expired" : account.state;
        const identityChanged = (account.accountEmail !== undefined && account.accountEmail !== candidate.accountEmail)
          || (account.planType !== undefined && account.planType !== candidate.planType);
        if (candidate.authState !== nextAuthState || identityChanged
          || (candidate.registrationState === "provisional" && account.state === "signed_in")) {
          try {
            const saved = await persistAccount(profileFacts, account);
            attached.push({ row: saved, account, reconciliationState: "current" });
          } catch {
            attached.push({ row: candidate, account: null, reconciliationState: "reconnecting" });
          }
        } else {
          attached.push({ row: candidate, account, reconciliationState: "current" });
        }
        continue;
      }
      try {
        const account = await deps.control.readAccount({
          userId: facts.userId,
          relayId: candidate.relayId,
          profileHandle: candidate.id,
          profileGeneration: candidate.profileGeneration,
          accountGeneration: candidate.accountGeneration,
        });
        const saved = await persistAccount({
          userId: facts.userId,
          relayId: candidate.relayId,
          profileHandle: candidate.id,
          profileGeneration: candidate.profileGeneration,
          accountGeneration: candidate.accountGeneration,
          row: candidate,
        }, account);
        attached.push({ row: saved, account, reconciliationState: "current" });
      } catch {
        // A persisted row may outlive its local private home or exact host
        // generation. Keep that stale profile unavailable rather than
        // projecting DB state as current host truth. Retain the durable row so
        // restart-safe private-home reconciliation remains visible and honest.
        attached.push({ row: candidate, account: null, reconciliationState: "reconnecting" });
      }
    }
    return attached;
  };

  app.get("/api/codex", async (request, reply) => guarded(reply, async () => {
    const userId = authenticatedUser(request, reply); if (!userId) return;
    const storedProfiles = await deps.listProfiles(userId);
    const rawRelayId = request.headers["x-nautilo-codex-relay-id"];
    const hintedRelayId = rawRelayId === undefined
      ? undefined
      : codexHostRelayId.safeParse(rawRelayId);
    if (hintedRelayId !== undefined && !hintedRelayId.success) {
      return reply.code(400).send({ error: "invalid Codex Desktop identity" });
    }
    const exactHint = hintedRelayId?.data === undefined
      ? null
      : await deps.resolveHost(userId, hintedRelayId.data);
    const relayIds = exactHint
      ? [exactHint.relayId]
      : [...new Set(storedProfiles.map((profile) => profile.relayId))]
        .filter((relayId) => deps.readHostInspectionScope(userId, relayId) !== null);
    // Connections never guesses among every connected relay. Electron may
    // provide its persisted relay identity, which the server resolves against
    // this owner; otherwise an existing owner-scoped profile is the exact host
    // binding. First-time browser-only loading remains deliberately unbound.
    if (relayIds.length !== 1) {
      const body: CodexConnectionSummary = {
        runtime: {
          state: "absent",
          available: false,
          runtimeGeneration: null,
          collaborationModeAvailable: false,
        },
        profiles: storedProfiles.map((row) => project(
          row,
          null,
          row.registrationState === "provisional" && row.removalState === "removing"
            ? "cleanup_required"
            : "reconnecting",
        )),
      };
      return reply.send(body);
    }
    const facts = { userId, relayId: relayIds[0]! };
    const [hostRuntime, profiles] = await Promise.all([
      inspectRuntime(facts),
      Promise.resolve(storedProfiles),
    ]);
    const attachedProfiles = await reattachSummaryProfiles(facts, profiles);
    const status = deps.readHostStatus(facts.userId, facts.relayId);
    const body: CodexConnectionSummary = {
      runtime: projectRuntime(status, hostRuntime),
      profiles: attachedProfiles
        .map(({ row, account, reconciliationState }) => project(row, account, reconciliationState)),
    };
    return reply.send(body);
  }));
  app.post("/api/codex/runtime/inspect", async (request, reply) => guarded(reply, async () => {
    const facts = await host(request, reply); return facts
      ? reply.send(runtime(facts, await inspectRuntime(facts, { force: true }))) : undefined;
  }));
  app.post("/api/codex/runtime/install", async (request, reply) => guarded(reply, async () => {
    const facts = await host(request, reply); return facts
      ? reply.send(runtime(facts, await runtimeMutation(facts, () => deps.control.installRuntime(facts)))) : undefined;
  }));
  app.post("/api/codex/runtime/cancel", async (request, reply) => guarded(reply, async () => {
    const facts = await host(request, reply); return facts
      ? reply.send(runtime(facts, await runtimeMutation(facts, () => deps.control.cancelRuntimeInstall(facts)))) : undefined;
  }));
  app.post("/api/codex/runtime/activate", async (request, reply) => guarded(reply, async () => {
    const body = activate.safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "Invalid request body" });
    const facts = await host(request, reply); return facts
      ? reply.send(runtime(facts, await runtimeMutation(
        facts,
        () => deps.control.activateRuntime({ ...facts, ...body.data }),
      ))) : undefined;
  }));
  app.post("/api/codex/profiles", async (request, reply) => guarded(reply, async () => {
    const body = connect.safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "Invalid request body" });
    const facts = await host(request, reply); if (!facts) return;
    const created = await deps.control.createProfile(facts);
    const createdFacts = {
      userId: facts.userId,
      relayId: facts.relayId,
      profileHandle: created.profileHandle,
      profileGeneration: created.profileGeneration,
      accountGeneration: 0,
    };
    let row: StoredProfile | undefined;
    let login: Awaited<ReturnType<CodexAdminControlPlane["startAccountLogin"]>> | undefined;
    try {
      row = await deps.createProfile({
        id: created.profileHandle,
        userId: facts.userId,
        relayId: facts.relayId,
        homeHandle: created.homeHandle,
        label: "Codex account",
        profileGeneration: created.profileGeneration,
        accountGeneration: 0,
        authState: "signed_out",
        registrationState: "provisional",
      });
      const provisionalFacts = { ...createdFacts, row };
      login = await deps.control.startAccountLogin(provisionalFacts);
      const accountGeneration = deps.readHostStatus(facts.userId, facts.relayId)
        ?.profiles?.find((candidate) => candidate.profileHandle === created.profileHandle
          && candidate.profileGeneration === created.profileGeneration)?.accountGeneration ?? row.accountGeneration;
      const pending = await persistStatus(provisionalFacts, {
        authState: "login_pending",
        profileGeneration: row.profileGeneration,
        accountGeneration,
        expectedRegistrationState: "provisional",
      });
      return reply.send({ profile: project(pending), loginRef: login.loginRef });
    } catch {
      if (row) {
        const current = await deps.getProfile(facts.userId, row.id).catch(() => undefined);
        if (current?.registrationState === "registered" && current.authState === "signed_in" && login) {
          return reply.send({ profile: project(current), loginRef: login.loginRef });
        }
        if (login) await deps.control.cancelAccountLogin(createdFacts, login.loginRef).catch(() => undefined);
        if (current?.registrationState === "provisional") {
          const started = await deps.beginProfileRemoval({
            userId: facts.userId,
            profileId: current.id,
            expectedRevision: current.revision,
          }).catch(() => ({ status: "conflict" as const }));
          if (started.status === "conflict" && login) {
            const winner = await deps.getProfile(facts.userId, row.id).catch(() => undefined);
            if (winner?.registrationState === "registered" && winner.authState === "signed_in") {
              return reply.send({ profile: project(winner), loginRef: login.loginRef });
            }
          }
          if (started.status === "begun" || started.status === "already_removing") {
            await finishProfileRemoval(facts.userId, started.profile).catch(() => undefined);
          }
        }
      } else {
        await deps.control.removeProfile(createdFacts).catch(() => undefined);
      }
      throw new CodexAdminControlFailure("CODEX_CONFLICT");
    }
  }));
  app.patch<{ Params: { profileId: string } }>("/api/codex/profiles/:profileId", async (request, reply) => guarded(reply, async () => {
    const body = label.merge(revision).safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "Invalid request body" });
    const userId = authenticatedUser(request, reply);
    if (!userId) return;
    const row = await deps.renameProfile({ userId, profileId: request.params.profileId, ...body.data });
    return row ? reply.send(project(row)) : reply.code(409).send({ code: "CODEX_CONFLICT" });
  }));
  app.delete<{ Params: { profileId: string } }>("/api/codex/profiles/:profileId", async (request, reply) => guarded(reply, async () => {
    const body = revision.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request body" });
    const userId = authenticatedUser(request, reply);
    if (!userId) return;

    // This irreversible workflow is intentionally ordered: persist the
    // `removing` gate (which clears every selecting preference) before the
    // host command; only the host's exact logout/drain/reap/home-cleanup proof
    // permits historical bindings to be archived and the row finalized.
    const started = await deps.beginProfileRemoval({
      userId,
      profileId: request.params.profileId,
      expectedRevision: body.data.expectedRevision,
    });
    if (started.status === "conflict") {
      return reply.code(409).send({ code: "CODEX_CONFLICT" });
    }
    if (started.status === "already_removed") {
      return reply.code(204).send();
    }
    await finishProfileRemoval(userId, started.profile);
    return reply.code(204).send();
  }));
  app.post<{ Params: { profileId: string } }>("/api/codex/profiles/:profileId/login", async (request, reply) => guarded(reply, async () => {
    const facts = await profile(request, reply); if (!facts) return;
    const login = await deps.control.startAccountLogin(facts);
    const refreshed = deps.readHostStatus(facts.userId, facts.relayId)
      ?.profiles?.find((candidate) =>
        candidate.profileHandle === facts.profileHandle &&
        candidate.profileGeneration === facts.profileGeneration,
      );
    try {
      await persistStatus(facts, {
        authState: "login_pending",
        profileGeneration: facts.profileGeneration,
        accountGeneration: refreshed?.accountGeneration ?? facts.accountGeneration,
        ...(facts.row.registrationState === "provisional"
          ? { expectedRegistrationState: "provisional" as const }
          : {}),
      });
      return reply.send({ loginRef: login.loginRef });
    } catch (error) {
      // The browser receipt is not useful unless the owner-visible pending
      // state committed. Revoke the just-issued host login best-effort.
      await deps.control.cancelAccountLogin(facts, login.loginRef).catch(() => undefined);
      throw error instanceof CodexAdminControlFailure
        ? error
        : new CodexAdminControlFailure("CODEX_CONFLICT");
    }
  }));
  app.post<{ Params: { profileId: string } }>("/api/codex/profiles/:profileId/login/cancel", async (request, reply) => guarded(reply, async () => {
    const body = loginCancel.safeParse(request.body); if (!body.success) return reply.code(400).send({ error: "Invalid request body" });
    const facts = await profile(request, reply); if (!facts) return;
    if (facts.row.registrationState === "provisional" && facts.row.removalState === "removing") {
      await finishProfileRemoval(facts.userId, facts.row);
      return reply.send({ state: "profile_removed" });
    }
    let account;
    try {
      account = await deps.control.cancelAccountLogin(facts, body.data.loginRef);
    } catch (error) {
      // The host owns the short-lived receipt and may already have expired
      // and cancelled it. Cancellation remains recoverable for its owner: an
      // expired/replayed receipt grants no authority, so read and persist the
      // exact profile's current account state instead of stranding the UI in
      // login_pending forever.
      if (
        !(error instanceof CodexAdminControlFailure) ||
        (error.code !== "CODEX_CORRELATION_REPLAY" && error.code !== "CODEX_TIMEOUT")
      ) throw error;
      account = await deps.control.readAccount(facts);
    }
    if (facts.row.registrationState === "provisional") {
      const started = await deps.beginProfileRemoval({
        userId: facts.userId,
        profileId: facts.profileHandle,
        expectedRevision: facts.row.revision,
      });
      if (started.status === "conflict") throw new CodexAdminControlFailure("CODEX_CONFLICT");
      if (started.status !== "already_removed") {
        await finishProfileRemoval(facts.userId, started.profile);
      }
      return reply.send({ state: "profile_removed" });
    }
    return reply.send(await saveAccount(facts, account));
  }));
  app.post<{ Params: { profileId: string } }>("/api/codex/profiles/:profileId/account", async (request, reply) => guarded(reply, async () => {
    const facts = await profile(request, reply); return facts
      ? reply.send(await saveAccount(facts, await deps.control.readAccount(facts))) : undefined;
  }));
  app.post<{ Params: { profileId: string } }>("/api/codex/profiles/:profileId/logout", async (request, reply) => guarded(reply, async () => {
    const facts = await profile(request, reply); return facts
      ? reply.send(await saveAccount(facts, await deps.control.logoutAccount(facts))) : undefined;
  }));
  app.get<{ Params: { profileId: string } }>("/api/codex/profiles/:profileId/usage", async (request, reply) => guarded(reply, async () => {
    const facts = await profile(request, reply); if (!facts) return;
    const refreshed = await refreshUsage(facts);
    const failure = requestedUsageRefreshFailure(refreshed, "usage");
    if (failure) throw failure;
    if (!refreshed.row?.usageSnapshot?.usage) {
      throw new CodexAdminControlFailure("CODEX_STALE");
    }
    return reply.send(
      withCodexUsageFreshness(
        refreshed.row.usageSnapshot.usage,
        refreshed.row.usageObservedAt,
      ),
    );
  }));
  app.get<{ Params: { profileId: string } }>("/api/codex/profiles/:profileId/rate-limits", async (request, reply) => guarded(reply, async () => {
    const facts = await profile(request, reply); if (!facts) return;
    const refreshed = await refreshUsage(facts);
    const failure = requestedUsageRefreshFailure(refreshed, "rateLimits");
    if (failure) throw failure;
    if (!refreshed.row?.usageSnapshot?.rateLimits) {
      throw new CodexAdminControlFailure("CODEX_STALE");
    }
    return reply.send(
      withCodexUsageFreshness(
        refreshed.row.usageSnapshot.rateLimits,
        refreshed.row.usageObservedAt,
      ),
    );
  }));
  app.get<{ Params: { profileId: string } }>("/api/codex/profiles/:profileId/models", async (request, reply) => guarded(reply, async () => {
    const facts = await profile(request, reply); return facts
      ? reply.send(await deps.control.listModels(facts)) : undefined;
  }));
  app.get("/api/codex/preference", async (request, reply) => {
    const userId = authenticatedUser(request, reply);
    if (!userId) return;
    return reply.send(projectUserPreference(await deps.getUserPreference(userId)));
  });
  app.put("/api/codex/preference", async (request, reply) =>
    guarded(reply, async () => {
      const userId = authenticatedUser(request, reply);
      if (!userId) return;
      const parsed = codexUserPreferenceMutationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request body" });
      }
      if (parsed.data.enabled) {
        const target = await deps.resolveHost(userId);
        if (
          !target ||
          !deps.readHostInspectionScope(userId, target.relayId)
        ) {
          throw new CodexAdminControlFailure("CODEX_PROFILE_UNAVAILABLE");
        }
        const selected = parsed.data.profileId
          ? await deps.getProfile(userId, parsed.data.profileId)
          : undefined;
        const status = deps.readHostStatus(userId, target.relayId);
        if (
          !selected ||
          selected.authState !== "signed_in" ||
          !isCurrentHostProfile(selected, target.relayId, status, "signed_in")
        ) {
          throw new CodexAdminControlFailure("CODEX_PROFILE_UNAVAILABLE");
        }
      }
      const row = await deps.upsertUserPreference({
        userId,
        profileId: parsed.data.profileId,
        posture: parsed.data.posture,
        enabled: parsed.data.enabled,
        expectedRevision: parsed.data.expectedRevision,
      });
      if (!row) throw new CodexAdminControlFailure("CODEX_CONFLICT");
      return reply.send(projectUserPreference(row));
    }),
  );
}

function projectUserPreference(row: StoredUserPreference): CodexUserPreference {
  return {
    enabled: row.enabled,
    profileId: row.accountProfileId,
    posture: projectPosture(row.defaultPosture),
    revision: row.revision,
  };
}

function projectPosture(value: string): CodexPosture {
  switch (value) {
    case "prompted_workspace":
    case "full_access_headless":
      return value;
    default:
      return "codex_default";
  }
}

function project(
  row: StoredProfile,
  account: AccountProjection | null = null,
  reconciliationState: "current" | "reconnecting" | "cleanup_required" = "current",
): CodexConnectionProfile {
  const snapshot = row.usageSnapshot
    ? withCodexUsageFreshness(row.usageSnapshot, row.usageObservedAt)
    : null;
  return {
    id: row.id,
    label: row.label,
    accountEmail: account?.accountEmail ?? row.accountEmail,
    authState: projectAuthState(row.authState),
    registrationState: row.registrationState,
    reconciliationState,
    planType: account?.planType ?? row.planType,
    rateLimits: snapshot?.rateLimits ?? null,
    usage: snapshot?.usage
      ? { ...snapshot.usage, daily: [...snapshot.usage.daily] }
      : null,
    usageObservedAt: row.usageObservedAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    revision: row.revision,
  };
}

function projectAuthState(value: string): CodexConnectionProfile["authState"] {
  switch (value) {
    case "signed_out":
    case "login_pending":
    case "signed_in":
    case "expired":
    case "error":
      return value;
    default:
      return "error";
  }
}

function isCurrentHostProfile(
  row: StoredProfile,
  relayId: string,
  host: CodexHostStatus | null,
  requiredState?: "signed_in",
): boolean {
  if (row.relayId !== relayId) return false;
  const live = host?.profiles?.find((candidate) =>
    candidate.profileHandle === row.id &&
    candidate.profileGeneration === row.profileGeneration &&
    candidate.accountGeneration === row.accountGeneration
  );
  return live !== undefined && (requiredState === undefined || live.state === requiredState);
}

function projectRuntime(
  host: CodexHostStatus | null,
  fallback: { state: "absent" | "installing" | "ready" | "incompatible" | "draining" | "failed"; runtimeGeneration?: number },
): CodexRuntimeSummary {
  // This projection is affordance-only. Execution rechecks the exact relay
  // session in CodexAuthorityService before it admits a Plan task.
  const collaborationModeAvailable = host?.features?.collaborationMode === true
    && (host.state === "ready" || host.state === "limited");
  if (host) {
    if (host.state === "limited") {
      // Limited is a selected/active runtime with fewer feature gates, not a
      // candidate waiting for activation.
      return withRuntimeDetails({ state: "limited", available: true, runtimeGeneration: host.runtimeGeneration ?? null, collaborationModeAvailable }, host);
    }
    if (host.state === "runtime_incompatible") {
      return withRuntimeDetails({ state: "incompatible", available: false, runtimeGeneration: host.runtimeGeneration ?? null, collaborationModeAvailable }, host);
    }
    if (host.state === "ready") {
      return withRuntimeDetails({ state: "ready", available: true, runtimeGeneration: host.runtimeGeneration ?? null, collaborationModeAvailable }, host);
    }
    // Host status is published out-of-band and may still describe the state
    // from before this exact admin inspection. A generation-bearing result is
    // the activation capability the user just requested; do not discard it
    // merely because the next status publication has not arrived yet.
    if (fallback.runtimeGeneration !== undefined) {
      return withRuntimeDetails({
        state: fallback.state,
        available: false,
        runtimeGeneration: fallback.runtimeGeneration,
        collaborationModeAvailable,
      }, host);
    }
    if (host.runtime) {
      return withRuntimeDetails({
        state: host.runtime.state,
        available: false,
        runtimeGeneration: host.runtimeGeneration ?? null,
        collaborationModeAvailable,
      }, host);
    }
  }
  return withRuntimeDetails({
    state: fallback.state,
    // A semantic inspect result of `ready` only proves a candidate exists.
    // It becomes usable only after the host has selected/published it.
    available: false,
    runtimeGeneration: fallback.runtimeGeneration ?? null,
    collaborationModeAvailable,
  }, host);
}

function withRuntimeDetails(summary: CodexRuntimeSummary, host: CodexHostStatus | null): CodexRuntimeSummary {
  const base = summary.state === "installing" ? { ...summary, source: "managed" as const } : summary;
  const runtime = host?.runtime;
  const identityMatches = runtime?.state === base.state || (base.state === "limited" && runtime?.state === "ready");
  if (!runtime || !identityMatches) return base;
  const phase = runtime.installation?.phase;
  const installation = phase && ["resolving", "downloading", "verifying", "staging", "activating", "ready", "cancelled", "failed"].includes(phase)
    ? { phase: phase as NonNullable<CodexRuntimeSummary["installation"]>["phase"], receivedBytes: runtime.installation.receivedBytes, totalBytes: runtime.installation.totalBytes, canCancel: runtime.installation.canCancel, ...(runtime.installation.code ? { code: runtime.installation.code } : {}) }
    : undefined;
  return {
    ...base,
    ...(runtime.source ? { source: runtime.source } : {}),
    ...(runtime.version ? { version: runtime.version } : {}),
    ...(runtime.compatibilityDiagnostics
      ? { compatibilityDiagnostics: runtime.compatibilityDiagnostics.map((diagnostic) => ({ ...diagnostic })) }
      : {}),
    ...(runtime.state === base.state && installation ? { installation } : {}),
  };
}
