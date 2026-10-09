import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and, db, eq, groups, invites, rooms, serverPublicJoin,
} from "@nautilo/db";
import { getUserCapabilities } from "@nautilo/trust";

const INVITE_TOKEN = /^inv_[A-Za-z0-9_-]{32}$/u;
const selectionInput = z.object({
  inviteId: z.string().uuid().nullable(),
  revision: z.number().int().min(0),
}).strict();

type Selection = { inviteId: string | null; revision: number };
export type PublicJoinRouteOptions = Readonly<{
  joinUrl: string;
  isEnrollmentOpen: () => Promise<boolean>;
  /** Import an existing deployment's configured shortcut once; the saved selection then owns it. */
  legacyInviteToken?: string | undefined;
  services?: {
    readSelection: () => Promise<Selection>;
    updateSelection: (inviteId: string | null, revision: number, userId: string) => Promise<Selection | null>;
    eligibleToken: (inviteId: string) => Promise<string | null>;
    hasCapabilities: (userId: string) => Promise<boolean>;
  };
}>;

export function publicJoinInviteToken(value: string | undefined): string | null {
  const token = value?.trim();
  return token && INVITE_TOKEN.test(token) ? token : null;
}

/** The role and live invite state are checked at selection and on every public visit. */
async function eligibleToken(inviteId: string): Promise<string | null> {
  const [invite] = await db.select().from(invites).where(eq(invites.id, inviteId)).limit(1);
  if (!invite || invite.kind !== "server" || !invite.token || !publicJoinInviteToken(invite.token)
    || invite.revokedAt || (invite.expiresAt && invite.expiresAt.getTime() <= Date.now())
    || (invite.maxUses !== null && invite.usedCount >= invite.maxUses)
    || !invite.targetGroupId) return null;
  const [group] = await db.select({ type: groups.type }).from(groups)
    .where(eq(groups.id, invite.targetGroupId)).limit(1);
  if (!group || !["communities", "guests"].includes(group.type)) return null;
  if (invite.targetRoomId) {
    const [room] = await db.select({ archivedAt: rooms.archivedAt }).from(rooms)
      .where(eq(rooms.id, invite.targetRoomId)).limit(1);
    if (!room || room.archivedAt) return null;
  }
  return invite.token;
}

async function readSelection(): Promise<Selection> {
  const [row] = await db.select({ inviteId: serverPublicJoin.inviteId, revision: serverPublicJoin.revision })
    .from(serverPublicJoin).where(eq(serverPublicJoin.singleton, true)).limit(1);
  return row ?? { inviteId: null, revision: 0 };
}

async function updateSelection(inviteId: string | null, revision: number, userId: string): Promise<Selection | null> {
  if (revision === 0) {
    const [row] = await db.insert(serverPublicJoin)
      .values({ inviteId, updatedBy: userId })
      .onConflictDoNothing({ target: serverPublicJoin.singleton })
      .returning({ inviteId: serverPublicJoin.inviteId, revision: serverPublicJoin.revision });
    return row ?? null;
  }
  const [row] = await db.update(serverPublicJoin)
    .set({ inviteId, revision: revision + 1, updatedBy: userId, updatedAt: new Date() })
    .where(and(eq(serverPublicJoin.singleton, true), eq(serverPublicJoin.revision, revision)))
    .returning({ inviteId: serverPublicJoin.inviteId, revision: serverPublicJoin.revision });
  return row ?? null;
}

async function hasCapabilities(userId: string): Promise<boolean> {
  const capabilities = await getUserCapabilities(userId);
  return capabilities.includes("manage_members") && capabilities.includes("manage_server_enrollment");
}

/** Existing env-configured shortcuts become a saved selection once, with no ongoing env authority. */
async function importLegacySelection(rawToken: string | undefined): Promise<void> {
  const token = publicJoinInviteToken(rawToken);
  if (!token || (await readSelection()).revision !== 0) return;
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const [invite] = await db.select({ id: invites.id, token: invites.token, kind: invites.kind })
    .from(invites).where(eq(invites.tokenHash, hash)).limit(1);
  if (!invite || invite.kind !== "server") return;
  if (!invite.token) {
    await db.update(invites).set({ token }).where(and(eq(invites.id, invite.id), eq(invites.tokenHash, hash)));
  }
  if (!(await eligibleToken(invite.id))) return;
  await db.insert(serverPublicJoin).values({ inviteId: invite.id })
    .onConflictDoNothing({ target: serverPublicJoin.singleton });
}

/** Stable same-origin enrollment entry backed by an Admin-selected ordinary invite. */
export function publicJoinRoutes(app: FastifyInstance, options: PublicJoinRouteOptions): void {
  const services = options.services ?? { readSelection, updateSelection, eligibleToken, hasCapabilities };
  const current = async () => {
    if (!options.services) await importLegacySelection(options.legacyInviteToken);
    return services.readSelection();
  };
  const currentEligibleToken = async (): Promise<string | null> => {
    try {
      const selection = await current();
      if (!selection.inviteId || !(await options.isEnrollmentOpen())) return null;
      return await services.eligibleToken(selection.inviteId);
    } catch {
      // Availability is public, so authority outages must fail closed without
      // disclosing which backing check failed.
      return null;
    }
  };
  app.get("/join", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-robots-tag", "noindex, nofollow");
    const token = await currentEligibleToken();
    // Browser navigation has no Workbench bearer header. Let the client decide
    // whether an existing session enters the app or a guest needs this invite.
    return reply.redirect(token
      ? `/join/continue?invite=${encodeURIComponent(token)}`
      : "/join/continue", 302);
  });
  app.get("/api/public-join", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { available: (await currentEligibleToken()) !== null };
  });
  app.get("/api/admin/public-join", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.sessionUserId) return reply.code(401).send({ error: "unauthorized" });
    if (!(await services.hasCapabilities(request.sessionUserId))) return reply.code(403).send({ error: "forbidden" });
    return { ...await current(), joinUrl: options.joinUrl };
  });
  app.put("/api/admin/public-join", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.sessionUserId) return reply.code(401).send({ error: "unauthorized" });
    if (!(await services.hasCapabilities(request.sessionUserId))) return reply.code(403).send({ error: "forbidden" });
    const parsed = selectionInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    await current();
    if (parsed.data.inviteId && !(await services.eligibleToken(parsed.data.inviteId))) {
      return reply.code(409).send({ error: "invite_unavailable" });
    }
    const saved = await services.updateSelection(parsed.data.inviteId, parsed.data.revision, request.sessionUserId);
    if (!saved) return reply.code(409).send({ error: "stale_revision" });
    return { ...saved, joinUrl: options.joinUrl };
  });
}
