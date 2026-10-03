import { createHash, randomUUID } from "node:crypto";
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
  invites,
  profiles,
  users,
} from "@nautilo/db";
import { seatPeerUser, setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { cleanupInvitee, redeemServerInviteToken } from "./helpers/invite-redeem-helpers";
import { authedInject } from "./helpers/request-helpers";

async function cleanupPeer(fixture: AppFixture, userId: string): Promise<void> {
  await fixture.db.delete(profiles).where(eq(profiles.userId, userId));
  await fixture.db.delete(channelIdentities).where(eq(channelIdentities.userId, userId));
  await fixture.db.delete(groupMembers).where(eq(groupMembers.userId, userId));
  const peerAgents = await fixture.db
    .select({ agentId: actors.agentId })
    .from(actors)
    .where(eq(actors.ownerId, userId));
  await fixture.db.delete(actors).where(eq(actors.ownerId, userId));
  for (const peerAgent of peerAgents) {
    if (peerAgent.agentId) {
      await fixture.db.delete(agents).where(eq(agents.id, peerAgent.agentId));
    }
  }
  await fixture.db.delete(users).where(eq(users.id, userId));
}

describe("recoverable ordinary invitation codes", () => {
  let fixture!: AppFixture;
  let ownerBearer: string;
  let creator!: Awaited<ReturnType<typeof seatPeerUser>>;
  let unauthorizedPeer!: Awaited<ReturnType<typeof seatPeerUser>>;

  beforeAll(async () => {
    fixture = await setupOwnerAppFixture({
      suiteName: `recoverable-invites-${randomUUID().slice(0, 8)}`,
    });
    ownerBearer = await fixture.mintOwnerBearer();
    creator = await seatPeerUser(fixture.db, {
      suiteName: "recoverable-invite-creator",
      groupType: "members",
    });
    unauthorizedPeer = await seatPeerUser(fixture.db, {
      suiteName: "recoverable-invite-peer",
      groupType: "contributors",
    });
  });

  afterAll(async () => {
    if (!fixture) return;
    if (creator) await cleanupPeer(fixture, creator.userId);
    if (unauthorizedPeer) await cleanupPeer(fixture, unauthorizedPeer.userId);
    await fixture.cleanup();
  });

  test("new codes remain recoverable without leaking through inventory", async () => {
    const minted = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer: creator.bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "guest",
        maxUses: 1,
      },
    });
    expect(minted.statusCode).toBe(200);
    const created = minted.json<{ id: string; token: string; url: string }>();

    const [persisted] = await fixture.db
      .select({ token: invites.token, tokenHash: invites.tokenHash })
      .from(invites)
      .where(eq(invites.id, created.id))
      .limit(1);
    expect(persisted).toEqual({ token: created.token, tokenHash: null });

    const creatorShare = await authedInject(fixture.app, {
      method: "GET",
      url: `/api/invites/${encodeURIComponent(created.id)}/share`,
      bearer: creator.bearer,
    });
    expect(creatorShare.statusCode).toBe(200);
    expect(creatorShare.json<{ code: string; url: string }>()).toEqual({
      code: created.token,
      url: created.url,
    });

    const adminShare = await authedInject(fixture.app, {
      method: "GET",
      url: `/api/invites/${encodeURIComponent(created.id)}/share`,
      bearer: ownerBearer,
    });
    expect(adminShare.statusCode).toBe(200);

    const deniedShare = await authedInject(fixture.app, {
      method: "GET",
      url: `/api/invites/${encodeURIComponent(created.id)}/share`,
      bearer: unauthorizedPeer.bearer,
    });
    expect(deniedShare.statusCode).toBe(403);

    const inventory = await authedInject(fixture.app, {
      method: "GET",
      url: "/api/invites",
      bearer: creator.bearer,
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.body).not.toContain(created.token);
    const listed = inventory.json<{ invites: Array<Record<string, unknown>> }>()
      .invites.find((invite) => invite["id"] === created.id);
    expect(listed).toMatchObject({ id: created.id, codeAvailable: true });
    expect(listed).not.toHaveProperty("token");
    expect(listed).not.toHaveProperty("tokenHash");

    const preview = await fixture.app.inject({
      method: "GET",
      url: `/api/invites/${encodeURIComponent(created.token)}`,
    });
    expect(preview.statusCode).toBe(200);
  });

  test("legacy hash-only codes still resolve but cannot be recovered", async () => {
    const minted = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer: ownerBearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "guest",
        maxUses: 1,
      },
    });
    expect(minted.statusCode).toBe(200);
    const created = minted.json<{ id: string; token: string }>();
    const hash = createHash("sha256").update(created.token, "utf8").digest("hex");
    await fixture.db
      .update(invites)
      .set({ token: null, tokenHash: hash })
      .where(eq(invites.id, created.id));

    const preview = await fixture.app.inject({
      method: "GET",
      url: `/api/invites/${encodeURIComponent(created.token)}`,
    });
    expect(preview.statusCode).toBe(200);

    const share = await authedInject(fixture.app, {
      method: "GET",
      url: `/api/invites/${encodeURIComponent(created.id)}/share`,
      bearer: ownerBearer,
    });
    expect(share.statusCode).toBe(409);
    expect(share.json<{ error: string; code: string }>()).toEqual({
      error: "invite_code_unavailable",
      code: "invite_code_unavailable",
    });

    const inventory = await authedInject(fixture.app, {
      method: "GET",
      url: "/api/invites?all=true",
      bearer: ownerBearer,
    });
    const listed = inventory.json<{ invites: Array<Record<string, unknown>> }>()
      .invites.find((invite) => invite["id"] === created.id);
    expect(listed).toMatchObject({ id: created.id, codeAvailable: false });

    const redeemed = await redeemServerInviteToken(created.token, `legacy${randomUUID().slice(0, 8)}`);
    expect(redeemed.ok).toBe(true);
    if (redeemed.ok) await cleanupInvitee(fixture, redeemed.newUserId);
  });

  test("admin chooses the ordinary invite served by /join and revocation closes the shortcut", async () => {
    const minted = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer: ownerBearer,
      payload: { kind: "server", targetGroupRoleSlug: "community", maxUses: null },
    });
    expect(minted.statusCode).toBe(200);
    const created = minted.json<{ id: string; token: string }>();
    const initial = await authedInject(fixture.app, {
      method: "GET", url: "/api/admin/public-join", bearer: ownerBearer,
    });
    expect(initial.statusCode).toBe(200);
    const current = initial.json<{ inviteId: string | null; revision: number; joinUrl: string }>();
    expect(current.joinUrl.endsWith("/join")).toBe(true);
    const selected = await authedInject(fixture.app, {
      method: "PUT", url: "/api/admin/public-join", bearer: ownerBearer,
      payload: { inviteId: created.id, revision: current.revision },
    });
    expect(selected.statusCode).toBe(200);
    const selectedState = selected.json<{ inviteId: string | null; revision: number }>();
    expect(selectedState.inviteId).toBe(created.id);
    const joined = await fixture.app.inject({ method: "GET", url: "/join" });
    expect(joined.statusCode).toBe(302);
    expect(joined.headers.location).toBe(`/join/continue?invite=${created.token}`);

    const revoked = await authedInject(fixture.app, {
      method: "DELETE", url: `/api/invites/${created.id}`, bearer: ownerBearer,
    });
    expect(revoked.statusCode).toBe(200);
    const unavailable = await fixture.app.inject({ method: "GET", url: "/join" });
    expect(unavailable.statusCode).toBe(302);
    expect(unavailable.headers.location).toBe("/join/continue");
    const cleared = await authedInject(fixture.app, {
      method: "PUT", url: "/api/admin/public-join", bearer: ownerBearer,
      payload: { inviteId: null, revision: selectedState.revision },
    });
    expect(cleared.statusCode).toBe(200);
  });
});
