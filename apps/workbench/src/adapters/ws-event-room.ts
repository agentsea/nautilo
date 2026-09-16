import type { ServerEvent } from "@nautilo/types";

const GLOBAL_EVENT_TYPES = new Set<ServerEvent["type"]>([
  "voice.status",
  "voice.stop",
  "policy.changed",
  "profile.updated",
  "revisions.state_changed",
  "room.catalog.changed",
]);

/**
 * M134 — extract the bare room uuid from a room lane key, tolerating the
 * Conductor's per-single-user / per-bot suffixes
 * (`room:<id>:user:<actor>:bot:<agentId>`). A naive `slice("room:".length)`
 * returns the whole suffix, so group-room agent events never match the active
 * room and get filtered out client-side ("I @-mention a bot, nothing renders").
 */
export function roomIdFromLaneKey(
  laneKey: string,
  laneKeyToRoomId?: ReadonlyMap<string, string>,
): string | null {
  const mapped = laneKeyToRoomId?.get(laneKey);
  if (mapped) return mapped;
  // First segment after `room:` is the roomId; ignore Conductor suffixes
  // (`:user:<actor>:bot:<agentId>`).
  const m = /^room:([^:]+)/.exec(laneKey);
  return m ? m[1] : null;
}

/**
 * D106 Phase 2 — decide whether a WS event should mutate the visible chat /
 * tool UI for the currently selected Room.
 *
 * When `activeRoomId` is null (guest, loading, or no server rooms), all chat
 * events apply — legacy single-lane behavior.
 */
export function shouldApplyWsEventForActiveRoom(params: {
  event: ServerEvent;
  activeRoomId: string | null;
  laneKeyToRoomId: ReadonlyMap<string, string>;
  jobIdToRoomId: ReadonlyMap<string, string>;
  /** Last `message.tokens` / `message.new` laneKey observed for chat streaming. */
  lastStreamLaneKey: string | null;
}): boolean {
  const { event, activeRoomId, laneKeyToRoomId, jobIdToRoomId, lastStreamLaneKey } =
    params;

  if (event.type === "room_members_changed") {
    return true;
  }

  if (event.type === "room.silence.changed") {
    if (!activeRoomId) return true;
    return event.roomId === activeRoomId;
  }

  if (event.type === "room.conductor_mode.changed") {
    if (!activeRoomId) return true;
    return event.roomId === activeRoomId;
  }

  // D570 — delayed peer report-back audio is requester-private but not
  // globally foreground. Every client independently admits it only for the
  // exact Room it is currently showing. Missing provenance fails closed.
  if (event.type === "voice.audio" || event.type === "voice.sentence") {
    return activeRoomId !== null && event.roomId === activeRoomId;
  }

  if (GLOBAL_EVENT_TYPES.has(event.type)) {
    return true;
  }

  if (!activeRoomId) {
    return true;
  }

  let resolved: string | null | undefined;

  switch (event.type) {
    case "message.tokens":
    case "agent.progress":
    case "message.new":
      resolved = roomIdFromLaneKey(event.laneKey, laneKeyToRoomId);
      break;
    case "job.status":
    case "job.progress":
    case "worker.complete": {
      const mapped = jobIdToRoomId.get(event.jobId);
      if (mapped) {
        resolved = mapped;
        break;
      }
      // D353 — the jobId→room map is bounded (WS_ROUTE_MAP_CAP=64) while the
      // client's live-job set is unbounded, so a long / fork-heavy session can
      // evict a still-live job's mapping before its terminal `job.status`
      // arrives. With map-only resolution that terminal event resolves to null
      // → gets filtered here → the job is never retired from `liveJobIdsRef`
      // → `isRunning` stays stuck ("Genie is responding" never clears and Stop
      // reports no-target). Fall back to the lane key the event itself carries
      // (M075 on job.status/job.progress) when the map misses. worker.complete
      // has no laneKey → stays null (unchanged), which is fine: it does not
      // drive live-job retirement.
      const laneKey = (event as { laneKey?: string }).laneKey;
      resolved = laneKey ? roomIdFromLaneKey(laneKey, laneKeyToRoomId) : null;
      break;
    }
    // D353 — `job.forked` / `fork.spliced` (M085 fork-on-busy) carry a
    // `room:<id>…` laneKey just like `job.dispatched`, so they route the same
    // way. They have no client handler today (forks are tracked via the
    // `job.dispatched` the same dispatch path emits first); without this they
    // fall through to `default → true` and apply globally. Harmless while
    // unhandled, but a future `case "job.forked"` would then misfire in every
    // room — route by laneKey now so that day is safe.
    case "job.dispatched":
    case "job.coalesced":
    case "job.forked":
    case "fork.spliced":
      resolved = roomIdFromLaneKey(event.laneKey, laneKeyToRoomId);
      break;
    case "reaction.added":
    case "reaction.removed":
      // D212 P2 — scope reaction deltas to their room lane so a reaction
      // in another room never churns the active thread's message store.
      resolved = roomIdFromLaneKey(event.laneKey, laneKeyToRoomId);
      break;
    case "message.deleted":
      // ISSUE-M172 — scope the hard-delete to its room lane so a delete in
      // another room never mutates the active thread's message store.
      resolved = roomIdFromLaneKey(event.laneKey, laneKeyToRoomId);
      break;
    case "tool.start":
    case "tool.end":
    case "tool.run_shell.progress":
    case "tool.structured_ssh.progress": {
      if (event.laneKey) {
        resolved = roomIdFromLaneKey(event.laneKey, laneKeyToRoomId);
        break;
      }
      // Legacy direct HTTP dispatch emitted tools without provenance. Keep the
      // no-active-stream path global for old servers, but never use another
      // room's last stream as tool provenance.
      if (!lastStreamLaneKey) {
        return true;
      }
      return false;
    }
    case "connected_web.action_attention":
      // An owner-private interruption belongs only to its action's room/lane;
      // never surface a sign-in card while another Room is foregrounded.
      resolved = roomIdFromLaneKey(event.laneKey, laneKeyToRoomId);
      break;
    case "identity.challenge":
    case "prove_it.challenge":
    case "approval.ask":
      // M164 — Task/subagent-originated approval prompts are owner-scoped and
      // must surface regardless of the active room (their lane is
      // `task:<taskId>`, not `room:<id>`). This carve-out is Task-only; main-
      // thread approvals with a `room:<id>` lane still go through the room
      // filter below exactly as before.
      if (event.origin === "task" || event.laneKey.startsWith("task:")) {
        return true;
      }
      resolved = roomIdFromLaneKey(event.laneKey, laneKeyToRoomId);
      break;
    case "conductor.ask_user":
    case "conductor.focus_changed":
    case "conductor.routing":
      resolved = roomIdFromLaneKey(event.laneKey, laneKeyToRoomId);
      break;
    case "model.fallback":
      // D323 — the fallback status pill is room-scoped: it must only surface
      // in the room whose turn hit the provider hiccup. Without this case the
      // event falls through to `default → true` and the pill flashes in
      // whatever room the user is currently viewing (cross-room misfire).
      // `laneKey` is always "room:<id>…" for chat turns (emitter no-ops when
      // there is no lane), so this mirrors `message.tokens` routing.
      resolved = roomIdFromLaneKey(event.laneKey, laneKeyToRoomId);
      break;
    default:
      return true;
  }

  if (resolved === null) {
    return false;
  }
  return resolved === activeRoomId;
}
