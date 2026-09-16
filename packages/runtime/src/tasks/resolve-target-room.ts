import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  actors,
  namespaces,
  rooms,
  roomMembers,
  privateNamespaceBoundarySql,
  updateTask,
  type DirectDatabase,
  type Task,
} from "@nautilo/db";
import {
  createRoomFromMembers,
  findLocalUserByHandle,
  isUuidString,
  type RoomDetailPayload,
} from "@nautilo/trust";
import {
  ACP_RELAY_MAX_OPAQUE_ID_BYTES,
  ACP_RELAY_PROTOCOL_VERSION,
  OPENCODE_ACP_RELAY_PROTOCOL_VERSION,
} from "@nautilo/relay";
import { botThreadId } from "../conductor/thread-id";

/** Subagent thread prefix (kept in lockstep with `@nautilo/agent`'s
 * `SUBAGENT_GRAPH_THREAD_PREFIX`) so orphan task runs inherit the existing
 * chat-pagination exclusion (`excludeSubagentTranscriptSessions`). */
const SUBAGENT_THREAD_PREFIX = "subagent:";

export interface ResolveTargetRoomDeps {
  db: DirectDatabase;
}

export interface ResolvedTargetRoom {
  /** The room the run's transcript is anchored to. */
  roomId: string;
  /** The LangGraph thread the run executes on. */
  graphThreadId: string;
  /**
   * Human members of a Room created during this resolution. Server
   * composition uses this once, before the first Room event, to refresh the
   * live websocket audience and invalidate each affected Room catalogue.
   * Existing/memoized Rooms omit it.
   */
  createdHumanRoomMembers?: readonly HumanRoomMember[];
}

export interface HumanRoomMember {
  readonly userId: string;
  readonly actorId: string;
}

function humanMembersOfCreatedRoom(room: RoomDetailPayload): HumanRoomMember[] {
  return room.members.flatMap((member) =>
    member.kind === "user" && member.userId
      ? [{ userId: member.userId, actorId: member.actorId }]
      : []
  );
}

/**
 * D453 — an internal, server-authored execution descriptor for a native-Genie
 * harness Task. This is intentionally not a public `target_chat` value: the
 * generic task API remains unaware of provider routing. Require the exact
 * shape so unrelated task metadata can never select this behavior.
 */
type HarnessExecutionDescriptor = "codex" | "claude-code" | "hermes-acp" | "opencode-acp";

function isSafeOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && new TextEncoder().encode(value).byteLength <= ACP_RELAY_MAX_OPAQUE_ID_BYTES;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function hasClaudeCodeExecutionDescriptor(value: unknown): boolean {
  if (!hasExactKeys(value, ["execution"])) return false;
  const execution = value["execution"];
  if (!hasExactKeys(execution, [
    "version", "harnessId", "source", "profileRef", "catalogModelId", "selectedModel",
  ])) return false;
  return execution["version"] === 1
    && execution["harnessId"] === "claude-code"
    && execution["source"] === "genie"
    && isSafeOpaqueId(execution["profileRef"])
    && isSafeOpaqueId(execution["catalogModelId"])
    && isSafeOpaqueId(execution["selectedModel"]);
}

function hasAcpReadinessReceipt(value: unknown, minimumProtocolVersion: number): boolean {
  if (!hasExactKeys(value, ["relayId", "relaySessionId", "pairingGenerationRef", "desktopSessionId", "selectedProtocolVersion", "capabilityRevision"])) return false;
  return isSafeOpaqueId(value["relayId"])
    && isSafeOpaqueId(value["relaySessionId"])
    && isSafeOpaqueId(value["pairingGenerationRef"])
    && isSafeOpaqueId(value["desktopSessionId"])
    && typeof value["selectedProtocolVersion"] === "number"
    && Number.isSafeInteger(value["selectedProtocolVersion"])
    && value["selectedProtocolVersion"] >= minimumProtocolVersion
    && typeof value["capabilityRevision"] === "number"
    && Number.isSafeInteger(value["capabilityRevision"])
    && value["capabilityRevision"] >= 0;
}

function hasCodexReadinessReceipt(value: unknown): boolean {
  if (!hasExactKeys(value, ["relayId", "pairingGenerationRef", "capabilityRevision"])) return false;
  return isSafeOpaqueId(value["relayId"])
    && isSafeOpaqueId(value["pairingGenerationRef"])
    && typeof value["capabilityRevision"] === "number"
    && Number.isSafeInteger(value["capabilityRevision"])
    && value["capabilityRevision"] >= 0;
}

function hasCodexOutputContract(value: unknown): boolean {
  if (!hasExactKeys(value, [
    "version", "capabilityModelId", "catalogVersion", "contextTokens", "outputTokens",
  ])) return false;
  return value["version"] === 1
    && typeof value["capabilityModelId"] === "string"
    && /^openai:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value["capabilityModelId"])
    && typeof value["catalogVersion"] === "string"
    && value["catalogVersion"].length > 0
    && Number.isSafeInteger(value["contextTokens"])
    && (value["contextTokens"] as number) > 0
    && Number.isSafeInteger(value["outputTokens"])
    && (value["outputTokens"] as number) > 0
    && (value["outputTokens"] as number) <= (value["contextTokens"] as number);
}

function harnessExecutionDescriptor(task: Task): HarnessExecutionDescriptor | null {
  const taskMetadata = task.metadata;
  if (hasClaudeCodeExecutionDescriptor(taskMetadata)) return "claude-code";
  const execution = taskMetadata?.["execution"];
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) return null;
  const record = execution as Record<string, unknown>;
  const harnessModelId = record["harnessModelId"];
  const workingDirectory = record["workingDirectory"];
  const hasCodexExecutionKeys = hasExactKeys(record, [
    "version", "harnessId", "source", "collaborationMode", "harnessModelId", "readiness",
  ]) || hasExactKeys(record, [
    "version", "harnessId", "source", "collaborationMode", "harnessModelId", "readiness", "workingDirectory",
  ]) || hasExactKeys(record, [
    "version", "harnessId", "source", "collaborationMode", "harnessModelId", "outputContract", "readiness",
  ]) || hasExactKeys(record, [
    "version", "harnessId", "source", "collaborationMode", "harnessModelId", "outputContract", "readiness", "workingDirectory",
  ]);
  if (hasExactKeys(taskMetadata, ["execution"])
    && hasCodexExecutionKeys
    && record["version"] === 1
    && record["harnessId"] === "codex"
    && record["source"] === "genie"
    && (record["collaborationMode"] === "work" || record["collaborationMode"] === "plan")
    && typeof harnessModelId === "string"
    && harnessModelId.length > 0
    && new TextEncoder().encode(harnessModelId).byteLength <= 512
    && hasCodexReadinessReceipt(record["readiness"])
    && (record["outputContract"] === undefined || hasCodexOutputContract(record["outputContract"]))
    && (workingDirectory === undefined || (
      typeof workingDirectory === "string"
      && workingDirectory.length > 0
      && new TextEncoder().encode(workingDirectory).byteLength <= 4096
    ))) return "codex";
  if (hasExactKeys(taskMetadata, ["execution"])
    && hasExactKeys(record, ["version", "harnessId", "source", "readiness"])
    && record["version"] === 1
    && record["harnessId"] === "hermes-acp"
    && record["source"] === "genie"
    && hasAcpReadinessReceipt(record["readiness"], ACP_RELAY_PROTOCOL_VERSION)) return "hermes-acp";
  if (hasExactKeys(taskMetadata, ["execution"])
    && hasExactKeys(record, ["version", "harnessId", "source", "executionProfile", "readiness"])
    && record["version"] === 1
    && record["harnessId"] === "opencode-acp"
    && record["source"] === "genie"
    && record["executionProfile"] === "autonomous"
    && hasAcpReadinessReceipt(record["readiness"], OPENCODE_ACP_RELAY_PROTOCOL_VERSION)) return "opencode-acp";
  return null;
}

/**
 * M142 (spec §5.3) — resolve the room + graph thread a task run targets.
 *
 * 2a implements `orphan` + the namespace targets only. The `*_dm` branch is a
 * Phase-7 seam that throws explicitly. Room creation reuses the trust helpers
 * rather than re-implementing namespace/room SQL.
 */
export async function resolveTargetRoom(
  task: Task,
  deps: ResolveTargetRoomDeps,
): Promise<ResolvedTargetRoom> {
  const { db } = deps;
  const pin = ordinaryArtifactPeerPin(task);
  if (pin !== undefined && (task.preset !== "ask_peer" || (task.targetChat !== "last_dm" && task.targetChat !== "new_dm"))) {
    throw new Error("Ordinary Artifact contact requires the exact approved peer DM");
  }

  switch (task.targetChat) {
    case "orphan":
      return resolveOrphan(task, db);
    case "last_in_namespace":
      return resolveLastInNamespace(task, db);
    case "new_in_namespace":
      return resolveNewInNamespace(task, db);
    case "last_dm":
    case "new_dm":
      return resolveDm(task, db);
    default:
      throw new Error(
        `resolveTargetRoom: unknown target_chat "${String(task.targetChat)}"`,
      );
  }
}

/** Build the orphan run's graph thread: a fresh subagent thread per run so the
 * existing subagent-thread chat-pagination exclusion applies. */
function orphanRunThreadId(task: Task): string {
  const callingThread = task.callingRoomId
    ? `room:${task.callingRoomId}`
    : `task:${task.id}`;
  return `${SUBAGENT_THREAD_PREFIX}${callingThread}:${randomUUID()}`;
}

async function resolveOrphan(
  task: Task,
  db: DirectDatabase,
): Promise<ResolvedTargetRoom> {
  // Memoized on `tasks.target_room_id` — reuse across recurring fires.
  if (task.targetRoomId) {
    return { roomId: task.targetRoomId, graphThreadId: orphanRunThreadId(task) };
  }

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `task:${task.id}` })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("resolveTargetRoom(orphan): failed to create namespace");

  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: task.ownerId,
    type: "private",
    kind: "task",
    label: `Task ${task.id.slice(0, 8)}`,
    graphThreadId: `room:${roomId}`,
    namespaceId: ns.id,
    humanActorIds: [],
  });

  // Persist the room id back so later fires (and `task read`) reuse it.
  await updateTask(db, task.id, { targetRoomId: roomId });

  return { roomId, graphThreadId: orphanRunThreadId(task) };
}

/** Resolve the user-actor ids (`actors.kind='user'`) for the task's targets. */
async function resolveTargetUserActorIds(
  task: Task,
  db: DirectDatabase,
): Promise<string[]> {
  if (task.targetUserIds.length === 0) return [];
  const rows = await db
    .select({ id: actors.id })
    .from(actors)
    .where(
      and(
        eq(actors.kind, "user"),
        // M145: `inArray` over the uuid[] target list. The previous
        // `ANY(${task.targetUserIds}::uuid[])` form bound the array as a bare
        // scalar param → Postgres "malformed array literal". `last_in_namespace`
        // was unexercised until M145's `schedule` shortcut became its first
        // consumer; the early `length === 0` guard keeps the empty case safe.
        inArray(actors.ownerId, task.targetUserIds),
      ),
    );
  return rows.map((r) => r.id);
}

async function resolveLastInNamespace(
  task: Task,
  db: DirectDatabase,
): Promise<ResolvedTargetRoom> {
  const harness = harnessExecutionDescriptor(task);
  if (harness && task.targetRoomId) {
    return {
      roomId: task.targetRoomId,
      // Codex is an intentional same-Room turn and keeps its established
      // serialization semantics. Each ACP harness owns a separate Room-local
      // queue: sibling Tasks remain serialized, while the Genie's
      // conversational checkpoint stays free for task controls.
      graphThreadId: harness === "codex"
        ? botThreadId(task.targetRoomId, task.agentId)
        : `${SUBAGENT_THREAD_PREFIX}harness:${harness}:room:${task.targetRoomId}:agent:${task.agentId}`,
    };
  }

  // Retained for existing workspace-artifact pings. Harness tasks use the
  // strict internal descriptor above rather than overloading this shortcut.
  if (task.preset === "ping" && task.targetRoomId) {
    return {
      roomId: task.targetRoomId,
      graphThreadId: botThreadId(task.targetRoomId, task.agentId),
    };
  }

  const actorIds = await resolveTargetUserActorIds(task, db);
  if (actorIds.length > 0) {
    const [room] = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        and(
          eq(rooms.ownerId, task.ownerId),
          isNull(rooms.archivedAt),
          inArray(rooms.kind, ["private", "group", "multi_agent", "open"]),
          sql`${rooms.humanActorIds} @> ARRAY[${sql.join(
            actorIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::uuid[]`,
          inArray(
            rooms.id,
            db
              .select({ roomId: roomMembers.roomId })
              .from(roomMembers)
              .innerJoin(actors, eq(roomMembers.actorId, actors.id))
              .where(
                and(
                  eq(actors.kind, "agent"),
                  eq(actors.agentId, task.agentId),
                ),
              ),
          ),
          privateNamespaceBoundarySql(rooms.namespaceId),
        ),
      )
      .orderBy(desc(rooms.createdAt))
      .limit(1);
    if (room) {
      return {
        roomId: room.id,
        graphThreadId: botThreadId(room.id, task.agentId),
      };
    }
  }
  // Fall back to a fresh room when none matches.
  return resolveNewInNamespace(task, db);
}

async function resolveNewInNamespace(
  task: Task,
  db: DirectDatabase,
): Promise<ResolvedTargetRoom> {
  const [ownerActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, task.ownerId), eq(actors.kind, "user")))
    .orderBy(asc(actors.createdAt))
    .limit(1);
  if (!ownerActor) {
    throw new Error(
      `resolveTargetRoom(new_in_namespace): no user actor for owner ${task.ownerId}`,
    );
  }

  // The owner's own user actor MUST be a member — `createRoomFromMembers`
  // rejects a member set that doesn't contain `ownerActorId`. M144's
  // `in_background` only ever used `target_chat:"orphan"`, so this
  // `new_in_namespace` path was unexercised until M146 made it reachable from
  // the low-level `task create`; a requester-only task has an empty
  // `targetUserIds`, so prepend the owner explicitly (deduped).
  const memberUserIds = task.targetUserIds.includes(task.ownerId)
    ? task.targetUserIds
    : [task.ownerId, ...task.targetUserIds];
  const members: Array<{ kind: "user" | "agent"; id: string }> = [
    { kind: "agent", id: task.agentId },
    ...memberUserIds.map((id) => ({ kind: "user" as const, id })),
  ];

  const room = await createRoomFromMembers({
    ownerUserId: task.ownerId,
    ownerActorId: ownerActor.id,
    label: `Task ${task.id.slice(0, 8)}`,
    members,
  });

  return {
    roomId: room.id,
    graphThreadId: botThreadId(room.id, task.agentId),
    createdHumanRoomMembers: humanMembersOfCreatedRoom(room),
  };
}

/**
 * M151 (Phase 7b, spec §5.3) — resolve (or create) the DM room shared by the
 * requesting agent + the peer named by `target_chat_handle`. The run executes
 * on the DM's bot thread so its messages are VISIBLE to the peer. Persists the
 * resolved peer into `tasks.target_user_ids` (deduped, requester stays element
 * 0) so the await/resume reply-hook (`findAwaitingTaskForRoom`) matches on the
 * peer's reply.
 */
function ordinaryArtifactPeerPin(task: Task): string | undefined {
  const metadata = task.metadata;
  if (metadata?.["ordinaryArtifactPeer"] === undefined && metadata?.["expectedArtifactPeerActorId"] === undefined) return undefined;
  const pin = metadata?.["expectedArtifactPeerActorId"];
  if (metadata?.["ordinaryArtifactPeer"] !== true || typeof pin !== "string" || !isUuidString(pin)) {
    throw new Error("Ordinary Artifact contact is missing its exact approved recipient");
  }
  return pin;
}

async function resolveDm(
  task: Task,
  db: DirectDatabase,
): Promise<ResolvedTargetRoom> {
  const pinnedActorId = ordinaryArtifactPeerPin(task);
  // Memoized — reuse the resolved DM on a re-dispatch (unpause / resume).
  if (task.targetRoomId) {
    if (pinnedActorId !== undefined) {
      // Do not reinterpret a renamed/reassigned handle on a memoized DM.
      const [peerActor] = await db.select({ ownerId: actors.ownerId }).from(actors)
        .where(and(eq(actors.id, pinnedActorId), eq(actors.kind, "user"))).limit(1);
      if (!peerActor || !task.targetUserIds.includes(peerActor.ownerId)
        || await findExistingDmRoom(db, task.agentId, peerActor.ownerId, {
          actorId: pinnedActorId, roomId: task.targetRoomId,
        }) !== task.targetRoomId) throw new Error("The approved Artifact peer DM is no longer valid");
    }
    return {
      roomId: task.targetRoomId,
      graphThreadId: botThreadId(task.targetRoomId, task.agentId),
    };
  }

  const handle = (task.targetChatHandle ?? "").trim().replace(/^@/, "");
  if (!handle) {
    throw new Error("resolveTargetRoom(dm): missing target_chat_handle");
  }
  const peer = await findLocalUserByHandle(handle);
  if (!peer) {
    throw new Error(`resolveTargetRoom(dm): unknown peer handle "${handle}"`);
  }
  if (pinnedActorId !== undefined) {
    const [peerActor] = await db.select({ id: actors.id }).from(actors)
      .where(and(eq(actors.id, pinnedActorId), eq(actors.ownerId, peer.id), eq(actors.kind, "user"))).limit(1);
    if (!peerActor) throw new Error("The peer handle no longer identifies the approved Artifact recipient");
  }

  const targetUserIds = task.targetUserIds.includes(peer.id)
    ? task.targetUserIds
    : [...task.targetUserIds, peer.id];

  // last_dm: try to find an existing agent<->peer DM room first.
  if (task.targetChat === "last_dm") {
    const existing = await findExistingDmRoom(db, task.agentId, peer.id,
      pinnedActorId === undefined ? undefined : { actorId: pinnedActorId });
    if (existing) {
      await updateTask(db, task.id, {
        targetRoomId: existing,
        targetUserIds,
      });
      return {
        roomId: existing,
        graphThreadId: botThreadId(existing, task.agentId),
      };
    }
  }

  // new_dm (or last_dm with no match): create a kind='private' room (1 human +
  // 1 agent — the trust layer's DM shape). The DM is between the REQUESTER'S
  // agent and the PEER; the requester is NOT a member (decision 2 — the peer
  // sees a clean DM with the agent). `createRoomFromMembers` requires the room
  // owner's actor to be a member, so the PEER owns the room (the only human
  // member). The run's transcript session is owned by this peer (a room
  // member) via `dispatchTaskRun`'s `transcriptOwnerId`, so the agent's
  // question persists (sessions RLS human-membership branch) AND renders for
  // the peer (`getRoomMessagesAcrossMemberSessions` returns member-owned only).
  // Migration `0079` additionally grants an agent-membership RLS branch on
  // `sessions` as belt-and-suspenders (not strictly required given the above).
  const [peerActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, peer.id), eq(actors.kind, "user"),
      pinnedActorId === undefined ? undefined : eq(actors.id, pinnedActorId)))
    .orderBy(asc(actors.createdAt))
    .limit(1);
  if (!peerActor) {
    throw new Error(
      `resolveTargetRoom(dm): no user actor for peer ${peer.id}`,
    );
  }

  const room = await createRoomFromMembers({
    ownerUserId: peer.id,
    ownerActorId: peerActor.id,
    label: `DM with @${handle}`,
    members: [
      { kind: "agent", id: task.agentId },
      { kind: "user", id: peer.id },
    ],
  });
  await updateTask(db, task.id, {
    targetRoomId: room.id,
    targetUserIds,
  });
  return {
    roomId: room.id,
    graphThreadId: botThreadId(room.id, task.agentId),
    createdHumanRoomMembers: humanMembersOfCreatedRoom(room),
  };
}

/**
 * The most recent room that is EXACTLY the requesting agent + the peer — a true
 * 1-human-1-agent DM. `kind='private'` is NOT a sufficient filter on its own:
 * `deriveInitialKind` also labels a 2-human-2-agent "Multi-chat" group as
 * `private`, so a `@> [peer]` (contains) match would falsely reuse a group room
 * the peer merely belongs to (this caused `ask_peer` to post into the
 * requester's own multi-chat instead of a 1:1 DM). We therefore require:
 *   - `human_actor_ids` is EXACTLY `[peer]` (the peer is the ONLY human), and
 *   - the room has EXACTLY 2 members, one of which is the requesting agent
 *     ⇒ the other member is precisely that agent, so the room is {agent, peer}.
 */
async function findExistingDmRoom(
  db: DirectDatabase,
  agentId: string,
  peerUserId: string,
  pinnedPeer?: { actorId: string; roomId?: string },
): Promise<string | undefined> {
  const [peerActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, peerUserId), eq(actors.kind, "user"),
      pinnedPeer === undefined ? undefined : eq(actors.id, pinnedPeer.actorId)))
    .limit(1);
  const [agentActor] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!peerActor || !agentActor) return undefined;

  const [room] = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(
      and(
        eq(rooms.kind, "private"),
        pinnedPeer?.roomId === undefined ? undefined : eq(rooms.id, pinnedPeer.roomId),
        pinnedPeer === undefined ? undefined : isNull(rooms.archivedAt),
        // EXACTLY one human, and it is the peer (not merely "contains peer").
        sql`${rooms.humanActorIds} = ARRAY[${peerActor.id}]::uuid[]`,
        // Ordinary Artifact contact additionally proves the real Human
        // membership, not only the denormalized human_actor_ids projection.
        pinnedPeer === undefined ? undefined : inArray(rooms.id,
          db.select({ roomId: roomMembers.roomId }).from(roomMembers)
            .where(eq(roomMembers.actorId, pinnedPeer.actorId))),
        // The requesting agent is a member …
        inArray(
          rooms.id,
          db
            .select({ roomId: roomMembers.roomId })
            .from(roomMembers)
            .where(eq(roomMembers.actorId, agentActor.id)),
        ),
        // … and the room has exactly 2 members total ⇒ {requesting agent, peer}
        // (excludes multi-agent / multi-human rooms the peer also belongs to).
        sql`(SELECT count(*) FROM room_members rm2 WHERE rm2.room_id = ${rooms.id}) = 2`,
      ),
    )
    .orderBy(desc(rooms.createdAt))
    .limit(1);
  return room?.id;
}
