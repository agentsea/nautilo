import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  channelIdentities,
  eq,
  groupMembers,
  profiles,
  users,
} from "@nautilo/db";
import { seatPeerUser, setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

interface MutationReceipt {
  stateChanged: boolean | "unknown";
  auditRecorded: boolean | "unknown";
  retrySafe: boolean | "unknown";
  receiptId: string | null;
  recovery: Array<{ kind: string; inviteId?: string }>;
}

interface InvitePageBody {
  invites: Array<{ id: string; displayName: string | null }>;
  page: {
    returned: number;
    complete: boolean;
    hasMore: boolean;
    nextCursor: string | null;
    continuationAvailable: boolean;
  };
}

async function cleanupPeer(fixture: AppFixture, userId: string): Promise<void> {
  await fixture.db.delete(profiles).where(eq(profiles.userId, userId));
  await fixture.db
    .delete(channelIdentities)
    .where(eq(channelIdentities.userId, userId));
  await fixture.db.delete(groupMembers).where(eq(groupMembers.userId, userId));
  const agentActors = await fixture.db
    .select({ agentId: actors.agentId })
    .from(actors)
    .where(eq(actors.ownerId, userId));
  await fixture.db.delete(actors).where(eq(actors.ownerId, userId));
  for (const actor of agentActors) {
    if (actor.agentId) {
      await fixture.db.delete(agents).where(eq(agents.id, actor.agentId));
    }
  }
  await fixture.db.delete(users).where(eq(users.id, userId));
}

describe("D518 invite administration contract", () => {
  let fixture!: AppFixture;
  let bearer: string;
  let contributor!: Awaited<ReturnType<typeof seatPeerUser>>;
  let member!: Awaited<ReturnType<typeof seatPeerUser>>;

  beforeAll(async () => {
    fixture = await setupOwnerAppFixture({
      suiteName: `d518-${randomUUID().slice(0, 8)}`,
    });
    bearer = await fixture.mintOwnerBearer();
    contributor = await seatPeerUser(fixture.db, {
      suiteName: "m260-invite-auth",
      groupType: "contributors",
    });
    member = await seatPeerUser(fixture.db, {
      suiteName: "m307-self-invite",
      groupType: "members",
    });
  });

  afterAll(async () => {
    try {
      if (fixture && contributor) {
        await cleanupPeer(fixture, contributor.userId);
      }
      if (fixture && member) {
        await cleanupPeer(fixture, member.userId);
      }
    } finally {
      if (fixture) await fixture.cleanup();
    }
  });

  test("a Human with a personal Agent but without manage_members cannot mint or revoke", async () => {
    const deniedMint = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer: contributor.bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "guest",
        maxUses: null,
      },
    });
    expect(deniedMint.statusCode).toBe(403);
    expect(deniedMint.json<{ error: string }>()).toEqual({ error: "forbidden" });

    const created = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: { kind: "server", targetGroupRoleSlug: "guest", maxUses: null },
    });
    expect(created.statusCode).toBe(200);
    const deniedRevoke = await authedInject(fixture.app, {
      method: "DELETE",
      url: `/api/invites/${created.json<{ id: string }>().id}`,
      bearer: contributor.bearer,
    });
    expect(deniedRevoke.statusCode).toBe(403);
    expect(deniedRevoke.json<{ error: string }>()).toEqual({ error: "forbidden" });
  });

  test("create returns one secret handoff plus a truthful non-retryable receipt", async () => {
    const response = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "member",
        maxUses: 1,
        displayName: "D518 receipt",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      id: string;
      token: string;
      url: string;
      mutation: MutationReceipt;
    }>();
    expect(body.token).toMatch(/^inv_[A-Za-z0-9_-]{32}$/);
    expect(body.url).toContain("/redeem/");
    expect(body.mutation).toEqual({
      stateChanged: true,
      auditRecorded: true,
      retrySafe: false,
      receiptId: body.id,
      recovery: [{ kind: "revoke_invite", inviteId: body.id }],
    });
  });

  test("a Member can manage only bounded, creator-scoped invitations", async () => {
    const forbiddenRole = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer: member.bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "admin",
        maxUses: 1,
      },
    });
    expect(forbiddenRole.statusCode).toBe(403);
    expect(forbiddenRole.json<{ error: string }>()).toEqual({
      error: "target_role_forbidden",
    });

    const created = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer: member.bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "guest",
        maxUses: 1,
        displayName: "Member-created invite",
      },
    });
    expect(created.statusCode).toBe(200);
    const ownId = created.json<{ id: string }>().id;

    const ownInventory = await authedInject(fixture.app, {
      method: "GET",
      url: "/api/invites?limit=100",
      bearer: member.bearer,
    });
    expect(ownInventory.statusCode).toBe(200);
    expect(ownInventory.json<InvitePageBody>().invites.map((invite) => invite.id))
      .toContain(ownId);

    const forbiddenGlobalInventory = await authedInject(fixture.app, {
      method: "GET",
      url: "/api/invites?all=true",
      bearer: member.bearer,
    });
    expect(forbiddenGlobalInventory.statusCode).toBe(403);

    const adminCreated = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: { kind: "server", targetGroupRoleSlug: "guest", maxUses: 1 },
    });
    const forbiddenPeerRevoke = await authedInject(fixture.app, {
      method: "DELETE",
      url: `/api/invites/${adminCreated.json<{ id: string }>().id}`,
      bearer: member.bearer,
    });
    expect(forbiddenPeerRevoke.statusCode).toBe(403);

    const ownRevoke = await authedInject(fixture.app, {
      method: "DELETE",
      url: `/api/invites/${ownId}`,
      bearer: member.bearer,
    });
    expect(ownRevoke.statusCode).toBe(200);
    expect(ownRevoke.json<{ mutation: MutationReceipt }>().mutation.stateChanged)
      .toBeTrue();
  });

  test("list is bounded, stable, and continuable without duplicate rows", async () => {
    for (const label of ["page-a", "page-b", "page-c"]) {
      const created = await authedInject(fixture.app, {
        method: "POST",
        url: "/api/invites",
        bearer,
        payload: {
          kind: "server",
          targetGroupRoleSlug: "member",
          maxUses: 1,
          displayName: label,
        },
      });
      expect(created.statusCode).toBe(200);
    }

    const first = await authedInject(fixture.app, {
      method: "GET",
      url: "/api/invites?limit=2",
      bearer,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<InvitePageBody>();
    expect(firstBody.page).toMatchObject({
      returned: 2,
      complete: false,
      hasMore: true,
      continuationAvailable: true,
    });
    expect(firstBody.page.nextCursor).toBeString();

    const second = await authedInject(fixture.app, {
      method: "GET",
      url: `/api/invites?limit=2&cursor=${encodeURIComponent(firstBody.page.nextCursor!)}`,
      bearer,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<InvitePageBody>();
    expect(secondBody.page.returned).toBeGreaterThan(0);
    const firstIds = new Set(firstBody.invites.map((invite) => invite.id));
    expect(secondBody.invites.every((invite) => !firstIds.has(invite.id))).toBe(true);
  });

  test("invalid limit/cursor fail before query and revoke is idempotent", async () => {
    const invalidLimit = await authedInject(fixture.app, {
      method: "GET",
      url: "/api/invites?limit=101",
      bearer,
    });
    expect(invalidLimit.statusCode).toBe(400);
    expect(invalidLimit.json<{ error: string }>()).toEqual({ error: "invalid_limit" });

    const invalidCursor = await authedInject(fixture.app, {
      method: "GET",
      url: "/api/invites?cursor=not-a-cursor",
      bearer,
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json<{ error: string }>()).toEqual({ error: "invalid_cursor" });

    const created = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: { kind: "server", targetGroupRoleSlug: "member", maxUses: 1 },
    });
    const id = created.json<{ id: string }>().id;

    const first = await authedInject(fixture.app, {
      method: "DELETE",
      url: `/api/invites/${id}`,
      bearer,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ mutation: MutationReceipt }>().mutation.stateChanged).toBe(true);

    const repeated = await authedInject(fixture.app, {
      method: "DELETE",
      url: `/api/invites/${id}`,
      bearer,
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json<{ mutation: MutationReceipt }>().mutation).toMatchObject({
      stateChanged: false,
      auditRecorded: true,
      retrySafe: true,
      receiptId: id,
    });
  });
});
