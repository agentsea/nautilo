/**
 * M155 investigation — in ONE shared room (owner + member + one agent),
 * the resolved per-turn tool policy MUST follow the HUMAN SENDER:
 *   - owner-sent turn  → owner's capability tool policy (more tools)
 *   - member-sent turn → member's capability tool policy (fewer tools)
 *
 * This test captures the `memoryAccessEnvelope.toolPolicy` that each turn
 * carries into the foreground job and asserts the owner's allowed-tool count
 * is strictly greater than the member's. If the member's turn is silently
 * elevated to the owner's policy (the reported symptom), the counts come out
 * equal and this test FAILS — which is exactly what we want it to reveal.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actors, agents, and, eq, jobs, roomMembers, rooms, sessionMessages, sessions } from "@nautilo/db";
import {
  setupOwnerAppFixture,
  seatPeerUser,
  type AppFixture,
} from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;

/** requestorId → the toolPolicy captured from that turn's job input. */
const capturedPolicies = new Map<string, Record<string, string>>();

function allowedCount(policy: Record<string, string>): number {
  return Object.values(policy).filter((v) => v !== "forbidden").length;
}

function allowedNames(policy: Record<string, string>): Set<string> {
  return new Set(
    Object.entries(policy)
      .filter(([, v]) => v !== "forbidden")
      .map(([name]) => name),
  );
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 6_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  capturedPolicies.clear();
  fx = await setupOwnerAppFixture({
    suiteName: "tpbr",
    withDefaultAgentGraph: true,
    createAppExtras: {
      chatRoutesDeps: {
        createForegroundJob: async (_memOwner, requestorId, _laneKey, input) => {
          const env = input["memoryAccessEnvelope"] as
            | { toolPolicy?: Record<string, string> }
            | undefined;
          if (env?.toolPolicy) {
            capturedPolicies.set(requestorId, env.toolPolicy);
          }
          return { id: `job-${requestorId}`, virtualJobId: `job-${requestorId}` };
        },
      },
    },
  });
});

afterAll(async () => {
  if (!fx) return;
  if (fx.defaultRoomId) {
    const srows = await fx.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, fx.defaultRoomId));
    for (const s of srows) {
      await fx.db.delete(sessionMessages).where(eq(sessionMessages.sessionId, s.id));
      await fx.db.delete(sessions).where(eq(sessions.id, s.id));
    }
  }
  await fx.cleanup();
});

describe("M155 — per-turn tool policy follows the human sender in a shared room", () => {
  test("owner-sent and member-sent turns in the SAME room yield different tool counts", async () => {
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("defaultRoomId missing");

    // Seat a real `member`-role peer (canonical members Group → member caps).
    const member = await seatPeerUser(fx.db, {
      suiteName: "tpbr",
      groupType: "members",
    });

    // Add the member to the shared room + keep the denormalized human set
    // in sync so room-membership resolution + the subset rule see both humans.
    await fx.db
      .insert(roomMembers)
      .values({ roomId, actorId: member.actorId, roomRole: "member" })
      .onConflictDoNothing();
    await fx.db
      .update(rooms)
      .set({ humanActorIds: [fx.ownerActorId, member.actorId] })
      .where(eq(rooms.id, roomId));

    // The fixture seeds the agent member with a NULL response mode →
    // mention-gated. Flip it to `active` so a plain message fires the LLM
    // turn for BOTH senders (we don't depend on @mention parsing here).
    if (!fx.defaultAgentId) throw new Error("defaultAgentId missing");
    const [agentActorRow] = await fx.db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.agentId, fx.defaultAgentId), eq(actors.kind, "agent")))
      .limit(1);
    if (!agentActorRow) throw new Error("agent actor row missing");
    await fx.db
      .update(roomMembers)
      .set({ agentResponseMode: "active" })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.actorId, agentActorRow.id),
        ),
      );

    // In a 2-human room the Conductor mediates; @mention the agent so the
    // turn wakes deterministically via direct-address (no Floor Manager LLM
    // call, no LLM-key dependency, no non-determinism).
    const [agentRow] = await fx.db
      .select({ handle: agents.handle })
      .from(agents)
      .where(eq(agents.id, fx.defaultAgentId))
      .limit(1);
    if (!agentRow?.handle) throw new Error("agent handle missing");
    const mention = `@${agentRow.handle}`;

    // --- Owner-sent turn ---
    const ownerToken = await fx.mintOwnerBearer();
    const ownerRes = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: ownerToken,
      payload: { content: `${mention} owner turn — what tools do you have?` },
    });
    expect(ownerRes.statusCode).toBe(202);

    // --- Member-sent turn (same room, same agent) ---
    const memberRes = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: member.bearer,
      payload: { content: `${mention} member turn — what tools do you have?` },
    });
    expect(memberRes.statusCode).toBe(202);

    await waitForCondition(
      () => capturedPolicies.has(fx.ownerId) && capturedPolicies.has(member.userId),
    );

    const ownerPolicy = capturedPolicies.get(fx.ownerId);
    const memberPolicy = capturedPolicies.get(member.userId);

    expect(ownerPolicy).toBeDefined();
    expect(memberPolicy).toBeDefined();

    const ownerN = allowedCount(ownerPolicy!);
    const memberN = allowedCount(memberPolicy!);

    // Diagnostic surface: which tools the member is missing relative to owner.
    const ownerNames = allowedNames(ownerPolicy!);
    const memberNames = allowedNames(memberPolicy!);
    const ownerOnly = [...ownerNames].filter((n) => !memberNames.has(n)).sort();
     
    console.log(
      `[tpbr] owner allowed=${ownerN} member allowed=${memberN} ownerOnly=${JSON.stringify(ownerOnly)}`,
    );

    // The core assertion: the member must NOT be elevated to the owner's policy.
    // discover_tools counts via catalog.getFiltered(toolPolicy, …), which excludes
    // only `forbidden` entries — so a smaller non-forbidden set here means a smaller
    // discover_tools count too (the relay/health exclusions apply equally to both).
    expect(memberN).toBeLessThan(ownerN);

    await fx.db.delete(jobs).where(eq(jobs.roomId, roomId));
  });
});
