/**
 * M087 — end-to-end chat-route time-awareness.
 *
 * Drives the canonical room-message route through the agent-mediated DM path
 * and asserts on the job `input` that `executeAgentMediatedRoomMessage` hands
 * to `createForegroundJob` (which we override to capture, short-circuiting the
 * real executor). Covers the four ISSUE-M087 §6 / Phase 6 cases:
 *
 *   1. valid request tz → `input.userTimezone` carries it + `users.timezone`
 *      is persisted on drift; first message in a room → `previousUserMessageAt`
 *      is null.
 *   2. a second turn (prior persisted user message in the room) →
 *      `previousUserMessageAt` is that message's ISO timestamp.
 *   3. invalid request tz → NOT persisted; resolves to the stored value.
 *   4. brand-new user, no request tz, no stored tz → resolves to "UTC" and
 *      `users.timezone` is NOT written (persist on drift only, not default).
 *
 * Ordered so the four cases share one owner fixture: case 4 (no tz) runs
 * first while the owner's `users.timezone` is still null, then the drift +
 * stored-fallback + previous-message cases.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CreateForegroundJobResult } from "@nautilo/runtime";
import { eq, sessionMessages, sessions, users } from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;
const capturedInputs: Record<string, unknown>[] = [];

function lastInput(): Record<string, unknown> {
  const input = capturedInputs.at(-1);
  if (!input) throw new Error("no createForegroundJob input captured");
  return input;
}

/** Poll `users.timezone` until it equals `expected` (persist is fire-and-forget). */
async function waitForStoredTimezone(
  expected: string | null,
  timeoutMs = 3000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let current: string | null = null;
  do {
    const [row] = await fx.db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, fx.ownerId))
      .limit(1);
    current = row?.timezone ?? null;
    if (current === expected) return current;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < deadline);
  return current;
}

async function readStoredTimezone(): Promise<string | null> {
  const [row] = await fx.db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, fx.ownerId))
    .limit(1);
  return row?.timezone ?? null;
}

beforeAll(async () => {
  capturedInputs.length = 0;
  fx = await setupOwnerAppFixture({
    suiteName: "chattz",
    withDefaultAgentGraph: true,
    createAppExtras: {
      chatRoutesDeps: {
        createForegroundJob: async (_ownerId, _requestorId, _laneKey, input) => {
          capturedInputs.push(input);
          return {
            id: "chattz-job",
            virtualJobId: "chattz-job",
          } as CreateForegroundJobResult;
        },
      },
    },
  });
});

afterAll(async () => {
  await fx?.cleanup();
});

describe("M087 chat time-awareness (e2e job input)", () => {
  test("case 4 — no request tz, no stored tz → resolves UTC, no persist", async () => {
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("missing defaultRoomId");
    expect(await readStoredTimezone()).toBeNull();

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: await fx.mintOwnerBearer(),
      payload: { content: "no tz here" },
    });
    expect(res.statusCode).toBe(202);

    expect(lastInput()["userTimezone"]).toBe("UTC");
    expect(lastInput()["previousUserMessageAt"]).toBeNull();
    // No drift persist on the default — stays null.
    expect(await readStoredTimezone()).toBeNull();
  });

  test("case 1 — valid request tz → input carries it + persisted on drift; first message null", async () => {
    const roomId = fx.defaultRoomId!;
    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: await fx.mintOwnerBearer(),
      payload: { content: "from tokyo", userTimezone: "Asia/Tokyo" },
    });
    expect(res.statusCode).toBe(202);

    expect(lastInput()["userTimezone"]).toBe("Asia/Tokyo");
    // Still no persisted user message in this room (executor was short-circuited).
    expect(lastInput()["previousUserMessageAt"]).toBeNull();
    // Drift persist (fire-and-forget) eventually writes the new tz.
    expect(await waitForStoredTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  test("case 3 — invalid request tz → not persisted; resolves to stored value", async () => {
    const roomId = fx.defaultRoomId!;
    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: await fx.mintOwnerBearer(),
      payload: { content: "from mars", userTimezone: "Mars/Olympus" },
    });
    expect(res.statusCode).toBe(202);

    // Falls back to the stored Asia/Tokyo; garbage never overwrites the column.
    expect(lastInput()["userTimezone"]).toBe("Asia/Tokyo");
    expect(await readStoredTimezone()).toBe("Asia/Tokyo");
  });

  test("case 2 — prior user message in room → previousUserMessageAt is its ISO timestamp", async () => {
    const roomId = fx.defaultRoomId!;
    const priorAt = new Date("2026-05-09T15:58:00.000Z");

    const [session] = await fx.db
      .insert(sessions)
      .values({
        threadId: `chattz-prior-${Date.now()}`,
        ownerId: fx.ownerId,
        personaId: "owner",
        roomId,
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error("failed to insert prior session");

    await fx.db.insert(sessionMessages).values({
      sessionId: session.id,
      role: "user",
      content: "earlier message",
      createdAt: priorAt,
    });

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      bearer: await fx.mintOwnerBearer(),
      payload: { content: "follow up", userTimezone: "Asia/Tokyo" },
    });
    expect(res.statusCode).toBe(202);

    const prev = lastInput()["previousUserMessageAt"];
    expect(typeof prev).toBe("string");
    expect(Date.parse(prev as string)).toBe(priorAt.getTime());
  });
});
