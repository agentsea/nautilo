import type { FastifyInstance, FastifyRequest } from "fastify";
import { error as logError } from "@nautilo/logger";
import { isLocalhostIp } from "@nautilo/config-guard";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import {
  HANDLE_INVALID_MESSAGE,
  HANDLE_RE,
  normalizeHandle,
  PROFILE_AVATAR_URL,
  SHELL_AGENT_NAME,
  SHELL_AVATAR_REF,
  type AgentProfileResponse,
  type OwnedAgentSummary,
  type ProfileVoices,
  type ViewerRole,
  type VoiceRef,
} from "@nautilo/types";
import { curatedVoiceDisplayNameForId } from "@nautilo/voice";
import {
  consumePersonalSoulAttempt,
  renameAgentProfileIdentity,
  setAgentHandle,
  SoulGenerationRateLimitError,
} from "@nautilo/db";
import {
  getProfile,
  getProfileByAgentId,
  getVoices,
  upsertProfile,
  upsertVoiceAssignment,
  removeVoiceAssignment,
  assertValidVoiceLangKey,
  updateFallbackPolicy,
  generateSoulFile,
  generateSoulFileStream,
  SOUL_GENERATION_FAILED_MESSAGE,
  type NautiloProfile,
  type UpsertProfileInput,
  type SoulFileInput,
} from "@nautilo/agent";
import {
  assertCanUseServerFundedOwnSoul,
  CAP_USE_SERVER_PROVIDER_CREDENTIALS,
  findAgentById,
  findPersonalAgentsForUser,
  getUserCapabilities,
  persistUserTimezoneIfChanged,
  ServerProviderCredentialsDeniedError,
  toActionCapabilityHttpDenial,
} from "@nautilo/trust";
import { validateIanaTimezone } from "../lib/timezone";
import { eventBus } from "@nautilo/runtime";
import {
  resolveCallerModelAvailability,
  type CallerModelAvailability,
} from "./config";

/** Never project a provider/catalog alias for a curated Nautilo voice. */
export function canonicalizeProfileVoices(voices: ProfileVoices | undefined): ProfileVoices {
  return Object.fromEntries(Object.entries(voices ?? {}).map(([slot, ref]) => [
    slot,
    {
      ...ref,
      voiceName: curatedVoiceDisplayNameForId(ref.voiceId) ?? ref.voiceName,
    },
  ]));
}

type SseResponse = NodeJS.WritableStream & {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  end(): void;
};

type CloseEmitter = {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
};

function isSseClosed(raw: SseResponse): boolean {
  return raw.destroyed || raw.writableEnded;
}

function writeSse(raw: SseResponse, event: string, data: unknown): boolean {
  if (isSseClosed(raw)) return false;
  try {
    raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return !isSseClosed(raw);
  } catch {
    return false;
  }
}

/** Bind all HTTP close paths to the provider-generation cancellation signal. */
export function bindSoulStreamCloseAbort(
  sources: { readonly request: CloseEmitter; readonly response: CloseEmitter; readonly socket: CloseEmitter },
  controller: AbortController,
): { readonly clientClosed: () => boolean; readonly dispose: () => void } {
  let closed = false;
  const abortForClientClose = () => {
    closed = true;
    controller.abort();
  };
  sources.request.once("aborted", abortForClientClose);
  sources.response.once("close", abortForClientClose);
  sources.socket.once("close", abortForClientClose);

  return {
    clientClosed: () => closed,
    dispose: () => {
      sources.request.off("aborted", abortForClientClose);
      sources.response.off("close", abortForClientClose);
      sources.socket.off("close", abortForClientClose);
    },
  };
}

export function profileRoutes(
  app: FastifyInstance,
  deps?: {
    ownerId?: string | undefined;
    findPersonalAgentsForUser?: typeof findPersonalAgentsForUser;
    updateFallbackPolicy?: (
      agentId: string,
      policy: { enabled: boolean; chain: string[] },
    ) => Promise<{ fallbackEnabled: boolean; fallbackChain: string[] }>;
    assertCanUseServerFundedOwnSoul?: typeof assertCanUseServerFundedOwnSoul;
    isPersonalSoulServiceCaller?: (humanUserId: string) => Promise<boolean>;
    consumePersonalSoulAttempt?: typeof consumePersonalSoulAttempt;
    generateSoulFile?: typeof generateSoulFile;
    generateSoulFileStream?: typeof generateSoulFileStream;
    upsertSoulProfile?: (
      ownerId: string,
      agentId: string,
      input: UpsertProfileInput,
    ) => Promise<unknown>;
    resolveCallerAvailability?: (
      humanUserId: string,
      modelId: string,
    ) => Promise<CallerModelAvailability>;
  },
) {
  // Keep one server-paid personalization request active per Human in this
  // process; the durable attempt limit below coordinates across processes.
  const activeSoulGeneration = new Set<string>();
  const isPersonalSoulServiceCaller = deps?.isPersonalSoulServiceCaller ?? (async (humanUserId: string) =>
    !(await getUserCapabilities(humanUserId)).includes(CAP_USE_SERVER_PROVIDER_CREDENTIALS));
  const consumeSoulAttempt = deps?.consumePersonalSoulAttempt ?? consumePersonalSoulAttempt;
  const resolveSubjectUserId = (request: FastifyRequest): string =>
    request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? deps?.ownerId ?? "";
  const resolveModelAvailability =
    deps?.resolveCallerAvailability ??
    ((humanUserId: string, modelId: string) =>
      resolveCallerModelAvailability(humanUserId, modelId, { purpose: "chat-tools" }));

  // M132 — the Profile is agent-keyed. Profile writes resolve the
  // subject's personal Agent at the (full-priv) route layer and pass it
  // to `upsertProfile`. Doing the `actors` lookup here (not inside the
  // agent package) keeps the D129 full-priv-in-tools lint satisfied.
  const resolveSubjectAgentId = async (request: FastifyRequest): Promise<string | null> => {
    const subjectUserId = resolveSubjectUserId(request);
    if (!subjectUserId) return null;
    const owned = await (deps?.findPersonalAgentsForUser ?? findPersonalAgentsForUser)(subjectUserId);
    return owned[0]?.agentId ?? null;
  };

  // D112: resolves the **subject** user (owner fallback when guest), not
  // multi-user setup `viewer.*`. Prefer `GET /api/setup/status` for setup UX.
  app.get("/api/profile/status", async (request, reply) => {
    try {
      const ownerId = resolveSubjectUserId(request);
      const localhostRelay = isLocalhostIp(request.ip);
      const relayBootstrap = localhostRelay ? { relayUserId: ownerId } : {};
      const profile = await getProfile(ownerId);
      if (!profile) {
        return reply.send({
          exists: false,
          onboardingCompleted: false,
          ...relayBootstrap,
        });
      }
      return reply.send({
        exists: true,
        onboardingCompleted: profile.onboardingCompleted === true,
        ...relayBootstrap,
      });
    } catch (e) {
      logError("[profile] GET /api/profile/status failed:", e instanceof Error ? e.stack ?? e.message : String(e));
      return reply.code(500).send({ error: "Failed to load profile status." });
    }
  });

  app.get("/api/profile", async (request, reply) => {
    try {
      const viewerRole = getViewerRole(request);
      if (viewerRole === "guest" || viewerRole === "stranger") {
        return reply.send(publicProfileResponse(viewerRole));
      }

      const profile = await getProfile(resolveSubjectUserId(request));
      if (!profile) return reply.code(404).send({ error: "no profile" });
      // M125 Phase 2.1 — viewer-scoped agentId. `owned[0]` is the
      // viewer's primary agent (deterministic post Phase 0). Pre-M125
      // every viewer got the bootstrap default agent, which surfaced
      // the operator's `agentIdentity` on alice's profile screen. One
      // findAgentsOwnedByUser call serves both `ownedAgents` and the
      // per-viewer `agentIdentity`.
      const ownedAgents = await resolveOwnedAgentsForViewer(request);
      const agentId = ownedAgents[0]?.agentId ?? "";
      return reply.send(
        await projectProfile(profile, viewerRole, agentId, ownedAgents),
      );
    } catch (e) {
      logError("[profile] GET /api/profile failed:", e instanceof Error ? e.stack ?? e.message : String(e));
      return reply.code(500).send({ error: "Failed to load profile." });
    }
  });

  app.put<{ Body: UpsertProfileInput }>("/api/profile", async (request, reply) => {
    // M128 D4-A: profile write is self-edit by construction —
    // `resolveSubjectUserId` always returns the session user's id, so
    // any authenticated caller can only edit their own profile through
    // this surface. The previous `isOwnerRequest` owner-only gate was a
    // pre-multi-user artifact (see comment block on /generate-soul). If
    // a future surface adds a `?userId=` target parameter, that surface
    // must enforce the two-gate `agents.ownerId === sessionUserId ||
    // caps.includes("manage_agents")` per permission-model.md §7 item 9.
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    // Agent identity media has durable ownership, capacity, revision, and
    // recovery semantics.  It must never be smuggled through the generic
    // profile merge, even when the value happens to be unchanged.
    if (request.body && Object.prototype.hasOwnProperty.call(request.body, "avatar")) {
      return reply.code(409).send({
        error: "avatar_mutation_requires_library",
        code: "avatar_mutation_requires_library",
      });
    }
    let validatedDefaultModelId: string | undefined;
    if (typeof request.body?.defaultModel === "string") {
      const availability = await resolveModelAvailability(
        request.sessionUserId,
        request.body.defaultModel,
      );
      if (!availability.selectableInThisRelease) {
        const model = availability.model;
        return reply.code(422).send({
          code: "model_unavailable",
          error: `Model "${request.body.defaultModel}" is unavailable: ${model.unavailableReason ?? "not runnable now"}`,
          model: {
            modelId: model.id,
            availability: model.availability,
            reason: model.unavailableReason,
          },
        });
      }
      validatedDefaultModelId = request.body.defaultModel;
    }
    try {
      const agentId = await resolveSubjectAgentId(request);
      if (!agentId) {
        return reply.code(409).send({ error: "no_personal_agent" });
      }
      const subjectUserId = resolveSubjectUserId(request);
      // M156 — when the rename arrives, the Agent's name is identity-critical:
      // `profiles.name`, the agent-kind `actors.display_name` cache, and the
      // auto-derived `agents.handle` must commit together. Route name changes
      // through the transactional helper; non-name fields keep using the
      // normal profile writer (their drift is not identity-critical).
      let profile: NautiloProfile;
      const nameProvided =
        typeof request.body.name === "string" && request.body.name.trim().length > 0;
      if (nameProvided) {
        const { name: _name, timezone: _timezone, ...profilePatch } = request.body;
        if (Object.keys(profilePatch).length > 0) {
          await upsertProfile(subjectUserId, agentId, profilePatch, validatedDefaultModelId);
        }
        await renameAgentProfileIdentity({
          ownerUserId: subjectUserId,
          agentId,
          name: request.body.name as string,
        });
        const refreshed = await getProfileByAgentId(agentId);
        if (!refreshed) {
          return reply.code(500).send({ error: "Failed to save profile." });
        }
        profile = refreshed;
      } else {
        profile = await upsertProfile(
          subjectUserId,
          agentId,
          request.body,
          validatedDefaultModelId,
        );
      }
      // M087 — onboarding-captured timezone persists to `users.timezone`
      // (account-level), best-effort: a failure logs but never fails the
      // profile write. Invalid values are dropped by the validator.
      const onboardingTz = validateIanaTimezone(request.body.timezone);
      if (onboardingTz) {
        void persistUserTimezoneIfChanged(resolveSubjectUserId(request), onboardingTz).catch(
          (err) => {
            logError(
              "[profile] timezone persist failed (profile write succeeded):",
              err instanceof Error ? err.message : String(err),
            );
          },
        );
      }
      eventBus.emit({
        type: "profile.updated",
        profileId: profile.id,
        name: profile.name,
        onboardingCompleted: profile.onboardingCompleted,
        userId: resolveSubjectUserId(request),
      });
      const ownedAgents = await resolveOwnedAgentsForViewer(request);
      return reply.send(
        await projectProfile(profile, "owner", agentId, ownedAgents),
      );
    } catch (e) {
      logError("[profile] PUT /api/profile failed:", e instanceof Error ? e.stack ?? e.message : String(e));
      return reply.code(500).send({ error: "Failed to save profile." });
    }
  });

  // M156 — set the Agent's @handle by hand. Validates format client-side
  // and again here; on Save the server returns 409 `handle_taken` if the
  // handle collides with another Agent OR a local Human. Customizing the
  // handle freezes auto-derivation (renaming no longer re-derives it).
  app.patch<{ Body: { handle?: unknown } }>(
    "/api/profile/agent-handle",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const raw = typeof request.body?.handle === "string" ? request.body.handle : "";
      const handle = normalizeHandle(raw);
      if (!HANDLE_RE.test(handle)) {
        return reply.code(400).send({ error: HANDLE_INVALID_MESSAGE, code: "invalid_handle" });
      }
      const agentId = await resolveSubjectAgentId(request);
      if (!agentId) {
        return reply.code(409).send({ error: "no_personal_agent", code: "no_personal_agent" });
      }
      try {
        const result = await setAgentHandle(agentId, handle);
        if (!result.ok) {
          return reply.code(409).send({ error: "handle_taken", code: "handle_taken" });
        }
        return reply.send({ handle });
      } catch (e) {
        logError(
          "[profile] PATCH /api/profile/agent-handle failed:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        return reply.code(500).send({ error: "Failed to update handle." });
      }
    },
  );

  /**
   * D141 P2 / LD-1 — update per-user opt-in fallback policy.
   *
   * Owner-gated (same posture as PUT /api/profile). Body shape:
   *   { enabled: boolean; chain: string[] }
   *
   * Chain entries MUST be valid catalog model IDs (validated against
   * `getModelById`); unknown IDs return 400. Empty chain is allowed
   * and behaves like `enabled: false` per LD-1.
   *
   * Returns the updated `{ enabled, chain }` policy on success.
   */
  app.put<{ Params: { lang: string }; Body: VoiceRef }>(
    "/api/profile/voices/:lang",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const agentId = await resolveSubjectAgentId(request);
      if (!agentId) {
        return reply.code(409).send({ error: "no_personal_agent" });
      }
      const lang = request.params.lang;
      const body = request.body ?? {};
      if (typeof body.voiceId !== "string" || typeof body.voiceName !== "string") {
        return reply.code(400).send({ error: "voiceId and voiceName are required strings" });
      }
      try {
        assertValidVoiceLangKey(lang);
        await upsertVoiceAssignment(agentId, lang, {
          voiceId: body.voiceId,
          voiceName: curatedVoiceDisplayNameForId(body.voiceId) ?? body.voiceName,
        });
        const voices = await getVoices(agentId);
        const profile = await getProfile(resolveSubjectUserId(request));
        if (profile) {
          eventBus.emit({
            type: "profile.updated",
            profileId: profile.id,
            name: profile.name,
            onboardingCompleted: profile.onboardingCompleted,
            userId: resolveSubjectUserId(request),
          });
        }
        return reply.send({ voices: canonicalizeProfileVoices(voices) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Invalid voice language key")) {
          return reply.code(400).send({ error: msg });
        }
        logError("[profile] PUT /api/profile/voices/:lang failed:", msg);
        return reply.code(500).send({ error: "Failed to save voice assignment." });
      }
    },
  );

  app.delete<{ Params: { lang: string } }>(
    "/api/profile/voices/:lang",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const agentId = await resolveSubjectAgentId(request);
      if (!agentId) {
        return reply.code(409).send({ error: "no_personal_agent" });
      }
      const lang = request.params.lang;
      try {
        assertValidVoiceLangKey(lang);
        await removeVoiceAssignment(agentId, lang);
        const voices = await getVoices(agentId);
        const profile = await getProfile(resolveSubjectUserId(request));
        if (profile) {
          eventBus.emit({
            type: "profile.updated",
            profileId: profile.id,
            name: profile.name,
            onboardingCompleted: profile.onboardingCompleted,
            userId: resolveSubjectUserId(request),
          });
        }
        return reply.send({ voices: canonicalizeProfileVoices(voices) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Invalid voice language key") || msg.includes('Cannot remove the primary voice')) {
          return reply.code(400).send({ error: msg });
        }
        logError("[profile] DELETE /api/profile/voices/:lang failed:", msg);
        return reply.code(500).send({ error: "Failed to remove voice assignment." });
      }
    },
  );

  app.patch<{ Body: { enabled?: unknown; chain?: unknown } }>(
    "/api/profile/fallback",
    async (request, reply) => {
      // M128 D4-A: self-edit by construction (writes to subject = session user).
      const humanUserId = request.sessionUserId;
      if (!humanUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const body = request.body ?? {};
      if (typeof body.enabled !== "boolean") {
        return reply.code(400).send({ error: "`enabled` must be a boolean" });
      }
      if (!Array.isArray(body.chain) || !body.chain.every((m): m is string => typeof m === "string")) {
        return reply.code(400).send({ error: "`chain` must be an array of strings" });
      }
      const chain: string[] = body.chain;
      const enabled = body.enabled;
      const resolved = await Promise.all(
        chain.map((modelId) => resolveModelAvailability(humanUserId, modelId)),
      );
      const unavailable = resolved
        .filter((availability) => !availability.selectableInThisRelease)
        .map((availability) => availability.model);
      if (unavailable.length > 0) {
        return reply.code(422).send({
          code: "model_unavailable",
          error: "Fallback chain contains models that are not currently runnable.",
          models: unavailable.map((model) => ({
            modelId: model.id,
            availability: model.availability,
            reason: model.unavailableReason,
          })),
        });
      }
      try {
        const agentId = await resolveSubjectAgentId(request);
        if (!agentId) {
          return reply.code(409).send({ error: "no_personal_agent" });
        }
        const profile = await (deps?.updateFallbackPolicy ?? updateFallbackPolicy)(agentId, { enabled, chain });
        return reply.send({ enabled: profile.fallbackEnabled, chain: profile.fallbackChain });
      } catch (e) {
        logError(
          "[profile] PATCH /api/profile/fallback failed:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        return reply.code(500).send({ error: "Failed to update fallback policy." });
      }
    },
  );

  // Both generation routes are self-scoped: they resolve the authenticated
  // Human's exact personal Genie and never accept a caller-selected target.
  // Server-funded dispatch still has its own live capability, policy, and
  // ownership admission below and inside the generator.
  app.post<{ Body: Partial<SoulFileInput> }>("/api/profile/generate-soul", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const humanUserId = request.sessionUserId;
    let acquired = false;
    try {
      const agentId = await resolveSubjectAgentId(request);
      if (!agentId) {
        return reply.code(409).send({ error: "no_personal_agent" });
      }
      const assertOwnSoulSetup = deps?.assertCanUseServerFundedOwnSoul
        ?? assertCanUseServerFundedOwnSoul;
      await assertOwnSoulSetup({
        humanUserId,
        agentId,
        origin: "profile_soul_generation",
      });
      if (activeSoulGeneration.has(humanUserId)) {
        return reply.code(409).send({ error: "soul_generation_in_progress" });
      }
      activeSoulGeneration.add(humanUserId);
      acquired = true;
      if (await isPersonalSoulServiceCaller(humanUserId)) {
        await consumeSoulAttempt(humanUserId);
      }
      const soulFile = await (deps?.generateSoulFile ?? generateSoulFile)(request.body, undefined, {
        humanUserId,
        agentId,
        admission: "own_soul_setup_service",
        ...(deps?.assertCanUseServerFundedOwnSoul
          ? { assertOwnSoulSetupService: deps.assertCanUseServerFundedOwnSoul }
          : {}),
      });
      await (deps?.upsertSoulProfile ?? upsertProfile)(resolveSubjectUserId(request), agentId, { soulFile });
      return reply.send({ soulFile });
    } catch (e) {
      if (e instanceof SoulGenerationRateLimitError) {
        return reply.code(429).send({
          error: "soul_generation_limit_reached",
          message: "Soul personalization is available again after the rolling daily limit resets. Continue without it for now.",
        });
      }
      if (e instanceof ServerProviderCredentialsDeniedError) {
        return reply.code(403).send(toActionCapabilityHttpDenial(e));
      }
      logError("[profile] generate-soul failed:", e instanceof Error ? e.stack ?? e.message : String(e));
      return reply.code(500).send({ error: "Failed to generate soul file." });
    } finally {
      if (acquired) activeSoulGeneration.delete(humanUserId);
    }
  });

  app.post<{ Body: Partial<SoulFileInput> }>("/api/profile/generate-soul/stream", async (request, reply) => {
    // M128 D4-A: self-edit by construction (writes to subject = session user).
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const humanUserId = request.sessionUserId;
    let agentId: string;
    let acquired = false;
    try {
      const resolvedAgentId = await resolveSubjectAgentId(request);
      if (!resolvedAgentId) {
        return reply.code(409).send({ error: "no_personal_agent" });
      }
      agentId = resolvedAgentId;
      await (deps?.assertCanUseServerFundedOwnSoul
        ?? assertCanUseServerFundedOwnSoul)({
          humanUserId,
          agentId,
          origin: "profile_soul_generation_stream",
        });
      if (activeSoulGeneration.has(humanUserId)) {
        return reply.code(409).send({ error: "soul_generation_in_progress" });
      }
      activeSoulGeneration.add(humanUserId);
      acquired = true;
      if (await isPersonalSoulServiceCaller(humanUserId)) {
        await consumeSoulAttempt(humanUserId);
      }
    } catch (error) {
      if (acquired) activeSoulGeneration.delete(humanUserId);
      if (error instanceof SoulGenerationRateLimitError) {
        return reply.code(429).send({
          error: "soul_generation_limit_reached",
          message: "Soul personalization is available again after the rolling daily limit resets. Continue without it for now.",
        });
      }
      if (error instanceof ServerProviderCredentialsDeniedError) {
        return reply.code(403).send(toActionCapabilityHttpDenial(error));
      }
      throw error;
    }

    let generationAbort: AbortController;
    let closeGuard: ReturnType<typeof bindSoulStreamCloseAbort>;
    try {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      generationAbort = new AbortController();
      closeGuard = bindSoulStreamCloseAbort({
        request: request.raw,
        response: reply.raw,
        socket: request.raw.socket,
      }, generationAbort);
    } catch (error) {
      activeSoulGeneration.delete(humanUserId);
      throw error;
    }

    try {
      for await (const event of (deps?.generateSoulFileStream ?? generateSoulFileStream)(request.body, generationAbort.signal, {
        humanUserId,
        agentId,
        admission: "own_soul_setup_service",
        ...(deps?.assertCanUseServerFundedOwnSoul
          ? { assertOwnSoulSetupService: deps.assertCanUseServerFundedOwnSoul }
          : {}),
      })) {
        if (closeGuard.clientClosed() || isSseClosed(reply.raw)) break;
        if (event.type === "started") {
          writeSse(reply.raw, "soul.started", {});
          continue;
        }
        if (event.type === "delta") {
          writeSse(reply.raw, "soul.delta", { text: event.text });
          continue;
        }
        if (event.type === "completed") {
          // Preview-only endpoint: the wizard saves with PUT /api/profile after
          // the final response resolves. If the user closes the wizard mid-run,
          // no partial or completed soul should be persisted behind their back.
          writeSse(reply.raw, "soul.completed", { soulFile: event.soulFile });
          continue;
        }
        writeSse(reply.raw, "soul.error", {
          // Do not trust an upstream adapter to have sanitized this payload:
          // this HTTP boundary is the final line before browser/Desktop.
          error: SOUL_GENERATION_FAILED_MESSAGE,
          fallback: event.fallback,
        });
      }
    } catch (e) {
      logError("[profile] generate-soul stream failed:", e instanceof Error ? e.stack ?? e.message : String(e));
      if (!closeGuard.clientClosed() && !isSseClosed(reply.raw)) {
        writeSse(reply.raw, "soul.error", { error: SOUL_GENERATION_FAILED_MESSAGE });
      }
    } finally {
      // A normal response completion must remove the close listener before
      // ending the stream; otherwise the server's own `end()` looks like a
      // client disconnect and can spuriously abort completed work.
      closeGuard.dispose();
      activeSoulGeneration.delete(humanUserId);
      if (!isSseClosed(reply.raw)) {
        reply.raw.end();
      }
    }
  });

}

export function getViewerRole(request: Pick<FastifyRequest, "policyContext" | "sessionUserId">): ViewerRole {
  const role = request.policyContext?.actorRole;
  // Genuinely public callers see the shell projection.
  if (role === "stranger") return "stranger";
  if (role == null || role === "guest" || role === "anonymous" || !request.sessionUserId) {
    return "guest";
  }
  // M129 follow-up (M125 self-agent model) — ANY authenticated, verified
  // user views their OWN profile as its owner. The previous check only
  // matched the legacy slugs (owner/household/teammate), so post-M128
  // canonical roles (member/admin/superuser/contributor) fell through to
  // "guest" and saw the public shell instead of their own Agent: empty
  // ownedAgents, blank soul, default name. `/api/profile` is self-scoped
  // (subject = session user), so "owner" here means "owner of their own
  // profile". See ISSUE-M129 investigation.
  return "owner";
}

function publicProfileResponse(viewerRole: "guest" | "stranger"): AgentProfileResponse {
  return {
    viewerRole,
    agent: {
      name: SHELL_AGENT_NAME,
      avatar: SHELL_AVATAR_REF,
      avatarUrl: PROFILE_AVATAR_URL,
    },
  };
}

async function resolveOwnedAgentsForViewer(
  request: FastifyRequest,
): Promise<OwnedAgentSummary[]> {
  const userId = request.sessionUserId;
  if (!userId) return [];
  // M128 unify follow-up — show the viewer their OWN Agents
  // (personal Genie), not the admin-scoped manageable-agents list.
  return findPersonalAgentsForUser(userId);
}

async function projectProfile(
  profile: NautiloProfile,
  viewerRole: ViewerRole,
  agentId: string,
  ownedAgents: OwnedAgentSummary[],
): Promise<AgentProfileResponse> {
  if (viewerRole === "guest" || viewerRole === "stranger") {
    return publicProfileResponse(viewerRole);
  }

  const agentIdentity = await resolveAgentIdentity(agentId);
  // M156 — surface the Agent's editable @handle on the owner view.
  const handle = ownedAgents.find((a) => a.agentId === agentId)?.handle ?? "";
  const avatar = profile.avatar ?? SHELL_AVATAR_REF;

  return {
    viewerRole: "owner",
    ownedAgents,
    agent: {
      name: profile.name,
      language: profile.language,
      voices: canonicalizeProfileVoices(profile.voices),
      avatar,
      avatarUrl: PROFILE_AVATAR_URL,
      defaultModel: profile.defaultModel,
      personality: {
        prompt: profile.personalityPrompt,
        tone: profile.personalityTone,
        motherAnswer: profile.motherAnswer,
      },
      privacySpectrum: profile.privacySpectrum,
      workLifeMode: toWorkLifeMode(profile.workLifeMode),
      soulFile: profile.soulFile,
      onboardingCompleted: profile.onboardingCompleted,
      welcomeMessageSent: profile.welcomeMessageSent,
      agentIdentity,
      handle,
      publicProfile: profile.publicProfile,
      // D141 P2 / LD-1 — surface fallback policy on the owner view so
      // the workbench Settings → Providers chain-editor renders the
      // current state without an extra fetch round-trip.
      fallback: {
        enabled: profile.fallbackEnabled,
        chain: profile.fallbackChain,
      },
    },
  };
}

async function resolveAgentIdentity(agentId: string): Promise<string> {
  if (!agentId) {
    return composeFederatedId("agent", getServerHostname());
  }
  const agent = await findAgentById(agentId);
  return composeFederatedId(agent?.handle ?? "agent", getServerHostname());
}

function toWorkLifeMode(value: string | null): "work" | "life" | "both" | null {
  return value === "work" || value === "life" || value === "both" ? value : null;
}
