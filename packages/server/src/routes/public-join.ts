import type { FastifyInstance } from "fastify";

const INVITE_TOKEN = /^inv_[A-Za-z0-9_-]{32}$/u;

const UNAVAILABLE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Community enrollment unavailable</title></head>
<body style="font-family:system-ui;background:#0f1420;color:#f7f9fc;display:grid;place-items:center;min-height:100vh;margin:0">
  <main style="max-width:34rem;padding:2rem;text-align:center">
    <h1>Community enrollment is unavailable</h1>
    <p style="color:#b8c0d4;line-height:1.5">Existing members can still sign in. Please check back later to create a new community account.</p>
  </main>
</body>
</html>`;

export type PublicJoinRouteOptions = Readonly<{
  inviteToken?: string | undefined;
}>;

export function publicJoinInviteToken(value: string | undefined): string | null {
  const token = value?.trim();
  return token && INVITE_TOKEN.test(token) ? token : null;
}

/**
 * Stable public enrollment entry backed by one ordinary revocable Invite.
 * The token stays in operator runtime configuration so it can rotate without
 * changing a client or publishing another server image.
 */
export function publicJoinRoutes(app: FastifyInstance, options: PublicJoinRouteOptions = {}): void {
  const inviteToken = publicJoinInviteToken(options.inviteToken);
  app.get("/join", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-robots-tag", "noindex, nofollow");
    if (inviteToken === null) {
      return reply.code(503).type("text/html; charset=utf-8").send(UNAVAILABLE_PAGE);
    }
    return reply.redirect(`/redeem/${encodeURIComponent(inviteToken)}`, 302);
  });
}
