/**
 *  NFR-C1 / every `ServerEvent` variant must be classified for
 * WebSocket routing (`inferDeliveryScope` in `packages/server`). Global
 * types (`policy.changed`, `worker.complete`, …) require an explicit
 * `{ kind: "all", acknowledgedGlobalLeak: true }` audience when emitted
 * outside the runtime `eventBus` bridge; the bridge sets that automatically
 * (`event-bridge.ts` + `audienceForBridgedServerEvent`).
 */
import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import {
  WS_GLOBAL_FANOUT_EVENT_TYPES,
  WS_VOICE_CONTROL_GLOBAL_EVENT_TYPES,
} from "@nautilo/types";

/** Matches `ws-publisher` explicit-global branches (shared with `@nautilo/types`). */
const EXPLICIT_GLOBAL_WS_TYPES = new Set<ServerEvent["type"]>([
  ...WS_GLOBAL_FANOUT_EVENT_TYPES,
  ...WS_VOICE_CONTROL_GLOBAL_EVENT_TYPES,
]);

const EVENT_ROUTING = {
  "message.tokens": "scoped",
  "message.new": "scoped",
  "message.updated": "scoped",
  // protected live siblings stay on the originating Room lane.
  "message.shadow_stream_start": "scoped",
  "message.shadow_stream_frame": "scoped",
  "message.shadow_durable": "scoped",
  // the Human-key sibling is delivered only on its canonical Room lane.
  "message.human_peer_shadow": "scoped",
  // shared Human/Agent protected traffic remains on the canonical Room
  // lane; the authorization request is additionally filtered to its issuer.
  "message.shared_agent_shadow": "scoped",
  "message.shared_agent_authorization_required": "scoped",
  "message.runtime_invocation_authorization_required": "scoped",
  "message.shared_agent_stream_start": "scoped",
  "message.shared_agent_stream_frame": "scoped",
  "message.shared_agent_output_shadow": "scoped",
  "thread.summary.changed": "scoped",
  // room-scoped via `laneKey: "room:<id>"`; not globally fanned out.
  "reaction.added": "scoped",
  "reaction.removed": "scoped",
  // hard-delete fan-out is room-lane-scoped (not global).
  "message.deleted": "scoped",
  "job.status": "scoped",
  "job.progress": "scoped",
  "tool.start": "scoped",
  // per-tool stream observations stay in the originating room lane.
  "tool.run_shell.progress": "scoped",
  "tool.end": "scoped",
  "prove_it.challenge": "scoped",
  "approval.ask": "scoped",
  "host.choice": "scoped",
  // Connected website sign-in and recovery are private to the owning Human.
  "connected_web.action_attention": "scoped",
  "connected_web.action_resume_failed": "scoped",
  "worker.complete": "global",
  "voice.status": "global",
  "voice.sentence": "scoped",
  "voice.suggestion": "scoped",
  "voice.audio": "scoped",
  "voice.stop": "global",
  "profile.updated": "scoped",
  "identity.challenge": "scoped",
  "policy.changed": "global",
  "encryption.policy.changed": "global",
  "revisions.state_changed": "global",
  "session.persistence_failed": "global",
  "maintenance.status": "global",
  "job.coalesced": "scoped",
  "job.dispatched": "scoped",
  "job.forked": "scoped",
  "fork.spliced": "scoped",
  "room.catalog.changed": "scoped",
  // identifier-free durable-feed invalidation, delivered through an
  // explicit user audience supplied out of band by the server publisher.
  "event_feed.changed": "scoped",
  room_members_changed: "scoped",
  "typing.ping": "scoped",
  "model.fallback": "scoped",
  "room.notification.changed": "scoped",
  "notification.message.important": "scoped",
  "room.silence.changed": "scoped",
  "room.conductor_mode.changed": "scoped",
  //  (D-C) — room-scoped via `laneKey: "room:<id>"`; not in
  // WS_GLOBAL_FANOUT_EVENT_TYPES.
  "conductor.ask_user": "scoped",
  //  follow-up — room-scoped via `laneKey: "room:<id>"`, viewer-gated on
  // `userActorId`; not in WS_GLOBAL_FANOUT_EVENT_TYPES.
  "conductor.focus_changed": "scoped",
  "conductor.routing": "scoped",
  // Stack-162 — requester-private decision receipt; user-scoped via
  // `inferDeliveryScope` (routes by `userId`, NOT room-fanned-out). Not in
  // WS_GLOBAL_FANOUT_EVENT_TYPES.
  "conductor.decision": "scoped",
  "voice.turn.end": "scoped",
  // requester-private terminal approval receipt; routed by userId.
  "approval.resolved": "scoped",
  // M088C: SSE-only artifact lifecycle events. Not WS-fanned-out (not
  // in WS_GLOBAL_FANOUT_EVENT_TYPES); the workspace-artifacts SSE
  // route subscribes to the bus directly.
  "workspace.artifact.changed": "scoped",
  "workspace.artifact.renamed": "scoped",
  "workspace.artifact.deleted": "scoped",
  "document.patch.applied": "scoped",
  "document.mutation.committed": "scoped",
  // content-free Room-scoped wake-ups for opportunistic Domain-key
  // request fulfilment and durable target delivery.
  "crypto.domain_key_catch_up_requested": "scoped",
  "crypto.domain_key_catch_up_delivered": "scoped",
  // emitted with an explicit user audience; the frame itself is empty.
  "crypto.background_authorization_requested": "scoped",
  // Codex-native approval/input requests and their terminal receipts
  // are owner-scoped. They are not dynamic Nautilo Tool callbacks.
  "codex.request": "scoped",
  "codex.request.resolved": "scoped",
  // task lifecycle events; owner-user-scoped via `inferDeliveryScope`
  // (not in WS_GLOBAL_FANOUT_EVENT_TYPES).
  "task.fired": "scoped",
  "task.completed": "scoped",
  "task.errored": "scoped",
  // task lifecycle (pause/unpause/stop); owner-user-scoped via
  // `inferDeliveryScope` (not in WS_GLOBAL_FANOUT_EVENT_TYPES).
  "task.status": "scoped",
  // task parked awaiting a human reply; owner-user-scoped.
  "task.awaiting_reply": "scoped",
  // owner-scoped mid-run progress for subagent activity cards.
  "task.progress": "scoped",
  // room-scoped in-thread working affordance (routed like message.tokens).
  "agent.progress": "scoped",
  // room-scoped, redacted Structured SSH activity projection.
  "tool.structured_ssh.progress": "scoped",
  // controller-private authoritative host projection, routed by userId.
  "remote.host.snapshot": "scoped",
  "remote.host.connected": "scoped",
  "remote.host.updated": "scoped",
  "remote.host.disconnected": "scoped",
  "remote.host.revoked": "scoped",
} as const satisfies Record<ServerEvent["type"], "global" | "scoped">;

describe("ServerEvent routing contract ()", () => {
  test("every ServerEvent type is classified (exhaustive Record)", () => {
    const entries = Object.entries(EVENT_ROUTING) as Array<
      [ServerEvent["type"], "global" | "scoped"]
    >;
    expect(entries.length).toBeGreaterThan(0);
    for (const [type, kind] of entries) {
      if (kind === "global") {
        expect(EXPLICIT_GLOBAL_WS_TYPES.has(type)).toBe(true);
      } else {
        expect(EXPLICIT_GLOBAL_WS_TYPES.has(type)).toBe(false);
      }
    }
  });
});
