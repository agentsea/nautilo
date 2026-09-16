import type { ToolCall } from "@langchain/core/messages/tool";
import { log, warn } from "@nautilo/logger";
import type {
  PolicyResolver,
  RuntimePolicyContext,
  MemoryAccessEnvelope,
  NamespaceMemoryEnvelope,
  ToolAccess,
  ToolAccessDecision,
  ApprovalRoute,
  ApprovalRequest,
  ResolveContextFromPrincipalInput,
} from "./types";
import { M213_WORKBENCH_CHANNEL } from "./m213-read-models";
import {
  findUserByChannelIdentity,
  findActorByOwnerId,
  findActorById,
  findUserById,
  findAgentById,
  findDefaultRoomForActor,
  findRoomForUserAndAgentMembers,
  findRoomForUserMember,
  findUserHighestRoleSlug,
  getUserCapabilities,
  findUsersWithCapability,
  // M044 — Room-derived Namespace access.
  getRoomWithAccess,
  findReadableNamespacesForSubset,
} from "./queries";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import { getToolCatalog } from "@nautilo/catalog";
import { getToolPolicy, getRegisteredToolNames } from "./tool-policies";
import {
  resolveFileCommandPolicy,
} from "./file-tool-policies";

/**
 * Personal mode PolicyResolver — single owner, approvals route to the
 * users with `role='owner'` in the running agent's `agent_ownership`
 * group.
 *
 * Pre-M042D this class hinged on an `ownerActorId` UUID equality check.
 * M042D rewrote it to look the actor up inside the ownership group on
 * every resolve. M043 completes the RBAC canonicalization: Subject
 * queries key on `users.id` directly, Role reads via the `group_roles`
 * junction (M131; was `groups.role_id` pre-M131), every role computes
 * its tool policy via the same Capability path.
 *
 * M044 separates Namespace access from the Role branch entirely:
 * `readableNamespaces` / `mutableNamespaces` / `writableNamespaces`
 * are now Room-derived per
 * REL-NSP-RMS + REL-HUM-NSP (subset rule). The Role + ownership-group
 * path continues to drive `toolPolicy` (M043's capability lookup).
 * `sharedWriteMode` is gone from the envelope — canonical model doesn't
 * differentiate write-modes per Role (every Room-member writes directly
 * to the Room's Namespace).
 */
export class PersonalPolicyResolver implements PolicyResolver {
  /**
   * `ownerId` is resolved on every read so the resolver tracks the
   * current bootstrap-state-cache value (D120 A1.P1) after a claim
   * redeem refreshes it, without a server restart.
   *
   * History (D112 P18/19 → D120 A1.P1): pre-D112 the ctor stored
   * `ownerId` as a string snapshot captured at server boot. The server
   * boots with the bootstrap dummy `users` row as owner (see
   * `seedDefaultOwner`). The claim redeem replaced the dummy row in
   * place (or inserted a new one in Logto mode) but NOTHING moved the
   * resolver's stored `ownerId` to match. Net effect: every
   * `MemoryAccessEnvelope` carried `ownerId = <bootstrap-dummy>` for
   * the lifetime of the server post-claim, the chat route handed that
   * envelope to the agent runtime as `state.userId`, `post-model.ts`
   * stamped it onto `approval.ask` events, and the WS publisher
   * routed those events to a userId no authenticated socket had bound
   * — every approval prompt silently dropped (2026-05-08 smoke run).
   *
   * D112 fixed it via an env-var round-trip + a callback that
   * read the env on every request. D120 A1.P1 retired the env var:
   * the callback now reads from the bootstrap-state-cache,
   * populated at boot from `findClaimedOwnerId()` and refreshed
   * inside the redeem transaction tail.
   *
   * Accepts either a plain string (legacy / tests — pre-claim
   * fixtures still want a stable owner) or a `() => string` callback.
   */
  private readonly ownerIdSource: string | (() => string);
  /**
   * Default agent id used when `checkToolAccess` / `buildEnvelope` /
   * `resolveContext` is called without an explicit agentId (defensive
   * fallback for tests and edge paths). Production hot path always
   * has the value threaded through; this fallback matches the M042A
   * pattern and prevents empty-agentId semantics from silently
   * downgrading to the guest envelope.
   */
  private readonly defaultAgentId: string;

  constructor(
    ownerId: string | (() => string),
    defaultAgentId: string = "",
  ) {
    this.ownerIdSource = ownerId;
    this.defaultAgentId = defaultAgentId;
  }

  private get ownerId(): string {
    return typeof this.ownerIdSource === "function"
      ? this.ownerIdSource()
      : this.ownerIdSource;
  }

  private resolveAgentId(agentId: string): string {
    // D120 A1.P1b: fallback no longer reads NAUTILO_DEFAULT_AGENT_ID.
    // The constructor's `defaultAgentId` arg is the wired-at-boot value
    // (sourced from the bootstrap-state-cache by bin/nautilo-server). If
    // a caller forgot to pass agentId AND the resolver was constructed
    // with `""`, "" is the right answer — the policy-resolver downgrade
    // path turns that into a guest envelope rather than fabricating an
    // agent id behind the caller's back.
    return agentId || this.defaultAgentId || "";
  }

  // -----------------------------------------------------------------------
  // resolveContext
  // -----------------------------------------------------------------------

  async resolveContext(
    channel: string,
    externalId: string,
    agentId: string,
    requestedRoomId?: string,
  ): Promise<RuntimePolicyContext> {
    const server = getServerHostname();
    const effectiveAgentId = this.resolveAgentId(agentId);

    // Always compute agent's federated id so both owner and stranger
    // paths can stamp it. Single DB round-trip; fine in the hot path.
    let agentFederatedId = "";
    if (effectiveAgentId) {
      const agent = await findAgentById(effectiveAgentId);
      if (agent) {
        agentFederatedId = composeFederatedId(agent.handle, server);
      }
    }

    // M043: single source of truth — `channel_identities` now FKs
    // directly to users.id. The owner path fires only when a verified
    // row exists for (channel, externalId) that resolves to this
    // resolver's owner user. We look up the owner's user-kind actor
    // separately (sessions + room_members still join on actors.id).
    const binding = externalId
      ? await findUserByChannelIdentity(channel, externalId)
      : null;

    if (binding && binding.verifiedAt) {
      const userActor = await findActorByOwnerId(binding.userId);
      if (!userActor) {
        throw new Error(
          `channel_identity for (channel=${channel}, externalId=${externalId}) resolved to user ${binding.userId} but no user-kind actor row exists`,
        );
      }
      const user = await findUserById(binding.userId);
      // M047: `this.ownerId` is the local owner by construction (one
      // resolver instance per local-Server owner). `user.server` is
      // always NULL on this path, so the local-hostname fallback is
      // correct; no need to thread `user.server ?? server` here.
      const actorFederatedId = composeFederatedId(
        user?.handle ?? "owner",
        server,
      );

      // M042B + M065: resolve room — honor `requestedRoomId` when both
      // the user actor and the running agent are members; else fall back
      // to deterministic `findDefaultRoomForActor`.
      let room: { id: string; type: string; graphThreadId: string } | null =
        null;
      if (effectiveAgentId) {
        if (requestedRoomId) {
          const requested = await findRoomForUserAndAgentMembers(
            requestedRoomId,
            userActor.id,
            effectiveAgentId,
          );
          if (requested) {
            room = requested;
          } else {
            warn(
              `[trust] tui.room_request_not_member room=${requestedRoomId} user=${userActor.id}`,
            );
          }
        }
        if (!room) {
          room = await findDefaultRoomForActor(userActor.id, effectiveAgentId);
        }
      }
      const roomId = room?.id ?? "";
      const roomType = room?.type ?? "";
      const graphThreadId = room?.graphThreadId ?? "";
      const laneKey = roomId ? `room:${roomId}` : `${channel}:${externalId}`;

      // M128 — `actorRole` is the highest-rank Role across every
      // canonical server-wide Group the user is in (ladder:
      // owner > admin > superuser > member > contributor > guest).
      // Server-wide model: agentId is not part of role derivation.
      // The fallback ladder for users in no Group is intentionally
      // shorter post-D219: only bootstrap-owner equality maps to `owner`
      // (since a fresh server seeds the bootstrap claimer into the
      // `owners` Group, this fallback only fires for tests / pre-bootstrap
      // edge paths). The retired `serverRole='admin'` branch is gone.
      let roleSlug: string = (await findUserHighestRoleSlug(binding.userId)) ?? "";
      if (!roleSlug) {
        if (binding.userId === this.ownerId) {
          roleSlug = "owner";
        } else {
          // D219: the `serverRole === "admin"` fallback branch is gone
          // (the enum is retired). Post-M128 every real user is seated in
          // a Group, so this only fires for pre-bootstrap / test edge
          // paths: bootstrap-owner equality → owner, else guest.
          // Non-bootstrap verified Human with no Group membership.
          // M128 retires the `stranger` sentinel: an unaffiliated
          // verified user is a `guest` (cap bundle empty). Anything
          // stricter must come from removing them from the server
          // (no user row → buildAnonymousContext at the route).
          roleSlug = "guest";
          warn(
            `[trust] Verified channel binding ${channel}/${externalId} resolved to user ${binding.userId} with no Group membership; treating as guest`,
          );
        }
      }

      const envelope = await this.buildEnvelope(
        userActor.id,
        laneKey,
        effectiveAgentId,
        roomId,
      );
      return {
        laneKey,
        actorId: userActor.id,
        agentId: effectiveAgentId,
        roomId,
        roomType,
        graphThreadId,
        actorLabel: userActor.displayName,
        actorFederatedId,
        agentFederatedId,
        speakerTrust: "verified",
        laneScope: "private",
        actorRole: roleSlug,
        memoryAccess: envelope,
      };
    }

    // Guest path — unchanged shape; M128 retires the `stranger`
    // sentinel. Unverified channel bindings come back as `guest`
    // (empty cap bundle, no namespace access). Anonymous unbinded
    // requests are routed through `buildAnonymousContext` at the
    // server route layer, not here.
    const guestPolicy = buildGuestToolPolicy();
    const envelope: NamespaceMemoryEnvelope = {
      ownerId: this.ownerId,
      actorId: externalId,
      agentId: effectiveAgentId,
      roomId: "",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: guestPolicy,
    };

    return {
      laneKey: `${channel}:${externalId}`,
      actorId: externalId,
      agentId: effectiveAgentId,
      roomId: "",
      roomType: "",
      graphThreadId: "",
      actorLabel: "Unknown",
      actorFederatedId: "",
      agentFederatedId,
      speakerTrust: "unverified",
      laneScope: "private",
      actorRole: "guest",
      memoryAccess: envelope,
    };
  }

  // -----------------------------------------------------------------------
  // resolveContextFromPrincipal — M213 Phase 3
  // -----------------------------------------------------------------------

  async resolveContextFromPrincipal(
    input: ResolveContextFromPrincipalInput,
  ): Promise<RuntimePolicyContext> {
    const {
      principal,
      rbacProjection,
      preferredAgentId,
      requestedRoomId,
      requestedRoomAdmission = "human_and_agent",
    } = input;
    const channel = M213_WORKBENCH_CHANNEL;
    // M213: bearer path passes explicit preferredAgentId; empty is valid and
    // must not fall back to the resolver's wired defaultAgentId.
    const effectiveAgentId = preferredAgentId || "";

    let agentFederatedId = "";
    if (
      effectiveAgentId &&
      principal.personalAgent?.agentId === effectiveAgentId
    ) {
      agentFederatedId = composeFederatedId(
        principal.personalAgent.handle,
        getServerHostname(),
      );
    }

    const binding = principal.workbenchChannelBinding;
    if (binding?.isVerified) {
      const actorFederatedId = principal.federatedId;

      let room: { id: string; type: string; graphThreadId: string } | null =
        null;
      let requestedRoomRejected = false;
      if (requestedRoomId) {
        const requested =
          requestedRoomAdmission === "human"
            ? await findRoomForUserMember(
                requestedRoomId,
                principal.actorId,
              )
            : effectiveAgentId
              ? await findRoomForUserAndAgentMembers(
                  requestedRoomId,
                  principal.actorId,
                  effectiveAgentId,
                )
              : null;
        if (requested) {
          room = requested;
        } else {
          requestedRoomRejected = true;
          warn(
            `[trust] tui.room_request_not_member room=${requestedRoomId} user=${principal.actorId}`,
          );
        }
      }
      if (
        !room &&
        effectiveAgentId &&
        (!requestedRoomRejected ||
          requestedRoomAdmission === "human_and_agent")
      ) {
        room = await findDefaultRoomForActor(
          principal.actorId,
          effectiveAgentId,
        );
      }
      const roomId = room?.id ?? "";
      const roomType = room?.type ?? "";
      const graphThreadId = room?.graphThreadId ?? "";
      const laneKey = roomId
        ? `room:${roomId}`
        : `${channel}:${principal.federatedId}`;

      let roleSlug: string = rbacProjection.highestRole ?? "";
      if (!roleSlug) {
        if (principal.userId === this.ownerId) {
          roleSlug = "owner";
        } else {
          roleSlug = "guest";
          warn(
            `[trust] Verified channel binding ${channel}/${principal.federatedId} resolved to user ${principal.userId} with no Group membership; treating as guest`,
          );
        }
      }

      const envelope = await this.buildEnvelopeWithSubject(
        principal.actorId,
        principal.userId,
        rbacProjection.capabilitySlugs,
        effectiveAgentId,
        roomId,
      );
      return {
        laneKey,
        actorId: principal.actorId,
        agentId: effectiveAgentId,
        roomId,
        roomType,
        graphThreadId,
        actorLabel: principal.actorDisplayName,
        actorFederatedId,
        agentFederatedId,
        speakerTrust: "verified",
        laneScope: "private",
        actorRole: roleSlug,
        memoryAccess: envelope,
      };
    }

    const guestPolicy = buildGuestToolPolicy();
    const envelope: NamespaceMemoryEnvelope = {
      ownerId: this.ownerId,
      actorId: principal.federatedId,
      agentId: effectiveAgentId,
      roomId: "",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: guestPolicy,
    };

    return {
      laneKey: `${channel}:${principal.federatedId}`,
      actorId: principal.federatedId,
      agentId: effectiveAgentId,
      roomId: "",
      roomType: "",
      graphThreadId: "",
      actorLabel: "Unknown",
      actorFederatedId: "",
      agentFederatedId,
      speakerTrust: "unverified",
      laneScope: "private",
      actorRole: "guest",
      memoryAccess: envelope,
    };
  }

  // -----------------------------------------------------------------------
  // buildEnvelope
  // -----------------------------------------------------------------------

  async buildEnvelope(
    actorId: string,
    _laneKey: string,
    agentId: string | undefined,
    roomId: string = "",
  ): Promise<NamespaceMemoryEnvelope> {
    // Human content-read reauthorization must never acquire the configured
    // default Agent. Preserve the old semantics for every existing string call.
    const effectiveAgentId = agentId === undefined ? "" : this.resolveAgentId(agentId);

    // -----------------------------------------------------------------
    // Tool-policy path (M128 — server-wide capability union).
    //
    // Capabilities come from the union across every canonical
    // server-wide Group the Human is in (`getUserCapabilities`); no
    // per-Agent ownership-group lookup. Two Agents that share a
    // Namespace see the same Human-Capability set, by design.
    // Namespace access is ORTHOGONAL — Role does not gate Namespace
    // visibility (REL-NSP-ROL).
    // -----------------------------------------------------------------

    // Subject queries take users.id; translate at the interface edge.
    const actor = await findActorById(actorId);

    // Defense-in-depth (M155): a non-human actor (e.g. an `agent`) has no
    // capability subject — the capability model (M128/M133) is human-keyed.
    // Feeding an agent actor here would silently collapse `toolPolicy` to the
    // guest 5-set (D300 regression). Fail loud instead of degrading silently.
    // A `null` actor is still the legitimate guest/unknown defensive path.
    if (actor && actor.kind !== "user") {
      throw new Error(
        `agent_actor_has_no_capability_subject: buildEnvelope was handed a non-human actor (actorId=${actorId}, kind=${actor.kind}); resolve the owning human before building an authorization envelope`,
      );
    }

    const subjectUserId = actor?.kind === "user" ? actor.ownerId : null;

    const caps = subjectUserId
      ? await getUserCapabilities(subjectUserId)
      : null;
    return this.buildNamespaceEnvelope(
      actorId,
      subjectUserId,
      caps,
      effectiveAgentId,
      roomId,
    );
  }

  /**
   * M213 Phase 3 — envelope builder that accepts a pre-resolved human
   * subject and capability list (no `findActorById` / `getUserCapabilities`).
   */
  private async buildEnvelopeWithSubject(
    actorId: string,
    subjectUserId: string,
    capabilitySlugs: readonly string[],
    effectiveAgentId: string,
    roomId: string = "",
  ): Promise<NamespaceMemoryEnvelope> {
    const caps = capabilitySlugs.length > 0 ? capabilitySlugs : null;
    return this.buildNamespaceEnvelope(
      actorId,
      subjectUserId,
      caps,
      effectiveAgentId,
      roomId,
    );
  }

  private async buildNamespaceEnvelope(
    actorId: string,
    subjectUserId: string | null,
    caps: readonly string[] | null,
    effectiveAgentId: string,
    roomId: string,
  ): Promise<NamespaceMemoryEnvelope> {
    const toolPolicy =
      caps && caps.length > 0
        ? buildToolPolicyFromCapabilities(caps)
        : buildGuestToolPolicy();

    // -----------------------------------------------------------------
    // Namespace path (M044 — REL-NSP-RMS + REL-HUM-NSP subset rule).
    // -----------------------------------------------------------------

    let readableNamespaces: string[] = [];
    let writableNamespaces: string[] = [];

    if (roomId) {
      const room = await getRoomWithAccess(roomId);
      if (room) {
        writableNamespaces = [room.namespaceId];
        const supersetNamespaces = await findReadableNamespacesForSubset(
          room.humanActorIds,
          {
            isPublicNamespaceBoundary: room.isPublicNamespaceBoundary,
          },
        );
        readableNamespaces = [
          ...new Set([...supersetNamespaces, room.namespaceId]),
        ];
      }
    }

    const mutableNamespaces = [...readableNamespaces];

    return {
      ownerId: subjectUserId ?? this.ownerId,
      actorId,
      agentId: effectiveAgentId,
      roomId,
      readableNamespaces,
      mutableNamespaces,
      writableNamespaces,
      toolPolicy,
    };
  }

  // -----------------------------------------------------------------------
  // checkToolAccess — reads from the envelope's toolPolicy
  // -----------------------------------------------------------------------

  async checkToolAccess(
    actorId: string,
    tool: ToolCall,
    envelope?: MemoryAccessEnvelope | null,
  ): Promise<ToolAccessDecision> {
    // D079 Phase 4 — the unified `file` tool dispatches on a `command`
    // arg with per-command severity that can't be captured by a
    // single tool-level ToolImpact. The tool-level policy registers
    // `file` as `destructive` (the conservative default for tier
    // routing); without this short-circuit trust says
    // `require_approval`, verb map says `auto` (because
    // effectiveFileToolImpact downgrades workspace writes to low),
    // and the verb-map/trust disagreement path in post-model
    // escalates to ask — so literally every directory listing AND
    // every workspace save triggers an approval dock.
    //
    // This block mirrors `effectiveFileToolImpact` so trust and the
    // verb map AGREE on which (command, zone) pairs auto-approve.
    // Both must stay in sync (tests in both packages lock the
    // behavior — see file-tool-policies.test.ts + this file's
    // resolver tests + post-model's approval-mapping test).
    //
    // Mapping:
    //   read_only                          → read_only (universal)
    //   destructive_low  + zone=workspace  → allow (workspace is
    //                                        the agent's drawer)
    //   destructive      + zone=workspace  → allow
    //   destructive_high (delete, always)  → require_approval
    //   destructive_low/destructive + any  → fall through to policy
    //     non-workspace zone                 path (normally HIL via
    //                                        envelope's require_prove_it)
    //
    // Delete always flows through the policy path so the normal
    // HIL gating applies even inside workspace (delete is the one
    // command where even "her drawer" doesn't auto-approve).
    if (tool.name === "file") {
      const args = (tool.args ?? {}) as Record<string, unknown>;
      const command = typeof args["command"] === "string" ? args["command"] : null;
      const zone = typeof args["zone"] === "string" ? args["zone"] : null;
      if (command) {
        const severity = resolveFileCommandPolicy(command);
        if (severity === "read_only") {
          // D079 PR-011 security port — absolute-zone READS must flow
          // through envelope policy so guest / stranger actors (whose
          // envelope sets `policy["file"] = "forbidden"`) don't get
          // blanket read access to arbitrary paths. The short-circuit's
          // job is to auto-approve reads in BOUNDED zones (workspace /
          // current / home / scratch) where the zone resolver + the
          // realpath-containment check already confirm the target is
          // under an allowed root.
          //
          // D087 Phase 1 carve-out — every command that routes
          // through the staged-patch substrate (content stages +
          // structural stages + the apply_patch / list_patches agent
          // verbs) short-circuits to read_only in every zone, including
          // absolute. Staging is inert at call time — proposing a
          // change to /etc/whatever doesn't touch disk, only produces
          // a patch the user reviews.
          //
          // SECURITY NOTE — the short-circuit deliberately runs BEFORE
          // the envelope.toolPolicy check below. That is safe ONLY
          // because the upstream catalog filter
          // (`packages/catalog/src/tool-catalog.ts::getFiltered`) has
          // already dropped tool entries whose
          // `toolPolicy[name] === "forbidden"` so a forbidden-envelope
          // actor never reaches this resolver with `tool.name === "file"`
          // in the first place. The catalog filter is THE gate.
          //
          // If a future caller bypasses the catalog filter — a
          // server-side sub-graph, an MCP stdio surface, a
          // direct-invoke API — it MUST re-apply the forbidden check
          // before delegating to this resolver, or MUST extend the
          // block below to gate staging commands on
          // `envelope?.toolPolicy?.[tool.name] !== "forbidden"` too.
          //
          // Tests pinning this invariant live in:
          //   packages/trust/tests/unit/personal-policy-resolver.test.ts
          //     → describe("staging commands × forbidden envelope")
          //   packages/catalog/tests/unit/tool-catalog.test.ts
          //     → filter-drops-forbidden test
          const STAGING_COMMANDS = new Set([
            // content stages
            "write",
            "insert",
            "str_replace",
            // structural stages (D087 §1.3.5)
            "delete",
            "move",
            "copy",
          ]);
          if (zone !== "absolute" || STAGING_COMMANDS.has(command)) {
            return { type: "read_only" };
          }
          // Pure read (read / grep / stat / list) in absolute zone.
          // Historically this fell through to envelope policy so a
          // guest actor (envelope policy["file"] === "forbidden") could
          // not read arbitrary paths. For any actor whose envelope DOES
          // grant access to the file tool (owner gets
          // `require_prove_it`, a capable household member gets
          // `require_approval`, etc.), that fall-through was painting
          // an approval dock with a confusingly contradictory
          // "read-only action — auto-approved" reason line every time
          // the owner asked the Agent to read a file under /tmp or /etc.
          // The security property we actually want is "guests can't
          // read"; gate THAT specifically and let any non-forbidden
          // envelope policy trust the actor for reads.
          if (envelope?.toolPolicy) {
            const access = envelope.toolPolicy[tool.name];
            // Undefined policy = no explicit grant; fall through so the
            // envelope-less catalog path decides (cap check).
            // `access` is a string union (ToolAccess), not an object —
            // compare the value directly.
            if (access && access !== "forbidden") {
              return { type: "read_only" };
            }
          }
          // No envelope → fall through to the capability-driven fallback.
        } else {
          // Workspace zone is the agent's personal drawer — auto-approve
          // everything EXCEPT destructive_high (delete recursive).
          const isWorkspaceZone = zone === "workspace" || zone === "home" || zone === "scratch";
          if (isWorkspaceZone && severity !== "destructive_high") {
            return { type: "allow" };
          }
          // Destructive + non-workspace → fall through to envelope policy
          // (normally require_approval via require_prove_it).
        }
      }
      // Unknown command or missing command arg → fall through. The
      // Zod layer should reject unknown commands but we fail closed
      // here by not short-circuiting.
    }

    // D306 — the dedicated `convert` tool gates on NETWORK EGRESS, not on
    // artifact creation. A local-backend convert (Markdown -> PDF/DOCX
    // landing as the user's own artifact) is the same trust event as a
    // workspace file write: the user asked for it, nothing leaves the
    // machine — so auto-approve it (no approval dock). Only the CloudConvert
    // cloud backend sends bytes to a third party; let those fall through to
    // the envelope's HIL gate (convert is registered requiresApproval, so the
    // policy below resolves cloud calls to require_approval). The local-vs-
    // cloud predicate must stay in sync with the convert backend resolver
    // (packages/agent/src/tools/convert/backend-resolver.ts).
    if (tool.name === "convert") {
      if (isLocalConvertCall((tool.args ?? {}) as Record<string, unknown>)) {
        return { type: "allow" };
      }
      // Cloud egress → fall through to envelope policy (HIL gated).
    }

    // D503 — `manage_local_mcp.install` is a single exact-effect approval.
    // It deliberately enters the ordinary ask path even for a standard user;
    // post-model then disables workstation overrides and standing/auto
    // approval for this action.
    // Legacy enable remains gated for route/internal compatibility.
    //
    // SECURITY NOTE — like the `file` / `convert` short-circuits, this runs
    // BEFORE the envelope policy check and returns `allow` for the
    // non-enable verbs. That is safe only because the catalog filter
    // (`getFiltered`) has already dropped `manage_local_mcp` for any actor
    // whose envelope marks it `forbidden` (guests / capless users), so a
    // forbidden actor never reaches this resolver with this tool name.
    if (tool.name === "manage_local_mcp") {
      const action = ((tool.args ?? {}) as Record<string, unknown>)["action"];
      if (action === "install" || action === "enable") {
        const agentIdForRouting = this.resolveAgentId(envelope?.agentId ?? "");
        return {
          type: "require_approval",
          route: await this.routeApproval(
            actorId,
            tool.name,
            {
              toolName: tool.name,
              params: (tool.args ?? {}) as Record<string, unknown>,
              impact: "high",
            },
            agentIdForRouting,
          ),
        };
      }
      return { type: "allow" };
    }

    if (envelope?.toolPolicy) {
      const access = envelope.toolPolicy[tool.name];
      if (access) {
        const agentIdForRouting = this.resolveAgentId(envelope.agentId);
        return toolAccessToDecision(
          access,
          actorId,
          tool,
          this,
          agentIdForRouting,
        );
      }
    }

    // Envelope-less fallback path. Compute caps for this actor inside
    // the running agent's ownership group. Pre-M042D this branch had
    // an `isOwnerActor` shortcut; post-M042D it resolves via the
    // group membership, just like the envelope path would. M043:
    // Subject query is now keyed on users.id — translate actorId at
    // the interface edge.
    const cat = getToolCatalog();
    const toolInfo = cat
      ? cat.getToolPolicy(tool.name)
      : getToolPolicy(tool.name);
    const requiredCap =
      "requiredCapability" in toolInfo ? toolInfo.requiredCapability : null;

    if (!requiredCap) {
      if (toolInfo.impact === "read-only") return { type: "read_only" };
      return { type: "allow" };
    }

    const agentIdForRouting = this.resolveAgentId("");
    const actor = await findActorById(actorId);
    const subjectUserId = actor?.kind === "user" ? actor.ownerId : null;
    const caps = subjectUserId
      ? await getUserCapabilities(subjectUserId)
      : [];
    const requiresApproval =
      "requiresApproval" in toolInfo && toolInfo.requiresApproval === true;
    if (caps.includes(requiredCap)) {
      if (requiresApproval) {
        return {
          type: "require_approval",
          route: await this.routeApproval(
            actorId,
            tool.name,
            {
              toolName: tool.name,
              params: (tool.args ?? {}) as Record<string, unknown>,
              impact: toolInfo.impact as "low" | "high" | "destructive",
            },
            agentIdForRouting,
          ),
        };
      }
      return { type: "allow" };
    }

    log(`[trust] Actor ${actorId} denied ${tool.name}: missing ${requiredCap}`);
    return {
      type: "require_approval",
      route: await this.routeApproval(
        actorId,
        tool.name,
        {
          toolName: tool.name,
          params: (tool.args ?? {}) as Record<string, unknown>,
          impact: toolInfo.impact as "low" | "high" | "destructive",
        },
        agentIdForRouting,
      ),
    };
  }

  // -----------------------------------------------------------------------
  // routeApproval
  // -----------------------------------------------------------------------

  /**
   * M128: server-wide approver pool. Resolves to every Human holding
   * the `approve_destructive_actions` Capability — i.e. every member
   * of `owners` ∪ `admins` ∪ `superusers` (the three Roles whose
   * bundle includes the cap, per permission-model.md §6 grid).
   * `agentId` is unused (kept on the PolicyResolver interface for
   * backwards-compat; will be removed in a follow-up).
   *
   * Returns `{ type: "forbidden" }` when the pool is empty — caught
   * at server boot by the seedTrustPersonal approver-pool invariant
   * warning, so production hot paths always find at least the
   * bootstrap claimer.
   */
  async routeApproval(
    _actorId: string,
    _action: string,
    _details: ApprovalRequest,
    _agentId: string,
  ): Promise<ApprovalRoute> {
    const approvers = await findUsersWithCapability(
      "approve_destructive_actions",
    );
    if (approvers.length > 0) {
      return { type: "prove_it", approvers };
    }
    warn(
      "[trust] routeApproval: no Human holds approve_destructive_actions — denying",
    );
    return { type: "forbidden" };
  }
}

// ---------------------------------------------------------------------------
// Tool policy builders
// ---------------------------------------------------------------------------

const GUEST_ALLOWED_TOOLS = new Set([
  "run_web_search",
  "read_webpage",
  "verify_identity",
  "discover_tools",
  "activate_tools",
  "deactivate_tools",
  "view_skill",
]);

/**
 * Get tool names and policy info. Reads from the catalog when available
 * (production server), from TOOL_POLICIES when not (tests without catalog).
 */
function getToolNamesAndPolicies(): Array<{
  name: string;
  impact: string;
  executor: string;
  requiredCapability: string | null;
  requiresApproval: boolean;
}> {
  const catalog = getToolCatalog();
  if (catalog) {
    const entries = catalog.query({ enabled: true });
    return entries.map((e) => ({
      name: e.name,
      impact: e.impact,
      executor: e.executor,
      requiredCapability:
        e.requiredCapabilities.length > 0 ? e.requiredCapabilities[0]! : null,
      requiresApproval: e.requiresApproval,
    }));
  }
  return getRegisteredToolNames().map((name) => {
    const entry = getToolPolicy(name);
    return {
      name,
      impact: entry.impact,
      executor: entry.executor,
      requiredCapability: entry.requiredCapability,
      requiresApproval: entry.requiresApproval === true,
    };
  });
}

export function buildGuestToolPolicy(): Record<string, ToolAccess> {
  const policy: Record<string, ToolAccess> = {};
  for (const tool of getToolNamesAndPolicies()) {
    const guestVisibleEmbeddedBrowser =
      tool.name.startsWith("browser_") &&
      tool.executor === "relay" &&
      tool.requiredCapability === "control_browser";

    if (GUEST_ALLOWED_TOOLS.has(tool.name)) {
      policy[tool.name] = "allow";
    } else if (
      guestVisibleEmbeddedBrowser &&
      !tool.requiresApproval &&
      (tool.impact === "read-only" || tool.impact === "low")
    ) {
      // The embedded Browser is a physically visible, Desktop-owned surface.
      // Guest access remains bounded by the catalog's live relay capability,
      // model capability, host admission, and exact relay ownership checks.
      // Preserve each browser tool's ordinary impact semantics here instead
      // of turning the guest exception into an approval or PIN bypass.
      policy[tool.name] = tool.impact === "read-only" ? "read_only" : "allow";
    } else {
      policy[tool.name] = "forbidden";
    }
  }
  return policy;
}

/**
 * M043: unified capability-driven tool policy. Every role walks the
 * same Capability path — the pre-M043 `buildToolPolicyForSlug` /
 * `buildOwnerToolPolicy` slug-branch is gone. For the owner Role —
 * whose seeded bundle carries all 8 Capabilities — the output map is
 * identical to the pre-M043 owner branch: tools with
 * `impact === "destructive"` resolve to `require_prove_it`,
 * `read-only` to `read_only`, everything else to `allow`. Tools with
 * no `requiredCapability` behave the same regardless of caps.
 */
/**
 * D306 — decide whether a `convert` tool call runs on the LOCAL backend (no
 * network egress). Kept here as a small pure predicate because trust must not
 * depend on the agent package; it mirrors the local-capability check in the
 * convert backend resolver (`@nautilo/agent` convert/backend-resolver.ts) and
 * the two must stay in sync (same discipline as `effectiveFileToolImpact`
 * mirroring the file command-severity table).
 *
 * Local iff: explicit `backend: "local"`, OR (`backend` "auto"/unset AND the
 * requested pair is one the local backend handles — a Markdown source ->
 * pdf/docx). Explicit `cloud`, or `auto` with any other pair (e.g. inline
 * HTML -> pdf, xlsx -> pdf), is cloud egress.
 */
function isLocalConvertCall(args: Record<string, unknown>): boolean {
  const backend = typeof args["backend"] === "string" ? args["backend"] : undefined;
  if (backend === "local") return true;
  if (backend === "cloud") return false;
  // auto / unset → local only when the pair is locally capable.
  const format = typeof args["format"] === "string" ? args["format"].toLowerCase() : "";
  const isLocalFormat = format === "pdf" || format === "docx";
  const hasInlineMarkdown = typeof args["markdown"] === "string";
  const sourcePath =
    typeof args["sourcePath"] === "string" ? args["sourcePath"].toLowerCase() : "";
  const isMarkdownSource =
    hasInlineMarkdown || sourcePath.endsWith(".md") || sourcePath.endsWith(".markdown");
  return isLocalFormat && isMarkdownSource;
}

function buildToolPolicyFromCapabilities(
  caps: readonly string[],
): Record<string, ToolAccess> {
  const policy: Record<string, ToolAccess> = {};
  for (const { name, impact, requiredCapability, requiresApproval } of getToolNamesAndPolicies()) {
    if (!requiredCapability) {
      policy[name] = impact === "read-only" ? "read_only" : "allow";
    } else if (caps.includes(requiredCapability)) {
      policy[name] = impact === "destructive" || requiresApproval
        ? "require_prove_it"
        : "allow";
    } else {
      policy[name] = "forbidden";
    }
  }
  return policy;
}

function toolAccessToDecision(
  access: ToolAccess,
  actorId: string,
  tool: ToolCall,
  resolver: PersonalPolicyResolver,
  agentId: string,
): ToolAccessDecision | Promise<ToolAccessDecision> {
  switch (access) {
    case "allow":
      return { type: "allow" };
    case "read_only":
      return { type: "read_only" };
    case "forbidden":
      return {
        type: "forbidden",
        reason: `Tool ${tool.name} is not available to this actor`,
      };
    case "require_prove_it":
      return resolver
        .routeApproval(
          actorId,
          tool.name,
          {
            toolName: tool.name,
            params: (tool.args ?? {}) as Record<string, unknown>,
            impact: "destructive",
          },
          agentId,
        )
        .then((route) => ({ type: "require_approval" as const, route }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
//
// M044: `writeModeForRole` + `WRITE_MODE_ORDER` removed. The canonical
// model has no per-Role write-mode distinction (REL-HUM-NSP: "Everyone
// who's in the Room writes directly to its Namespace; anyone who
// shouldn't be writing shouldn't be in the Room"). `sharedWriteMode`
// is gone from `MemoryAccessEnvelope`.
