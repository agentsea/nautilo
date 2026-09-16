import { invariant } from "../core/errors.js";

export function issueSession(ctx, userId, expiresAt) {
  const user = ctx.store.users.get(userId);
  invariant(user?.active, 403, "inactive_user", "An active user is required");
  return ctx.tokens.issue({ audience: "workspace", purpose: "session", userId, expiresAt });
}
export function authenticate(ctx, authorization) {
  invariant(typeof authorization === "string" && authorization.startsWith("Bearer "), 401, "session_required", "A workspace session is required");
  const claims = ctx.tokens.verify(authorization.slice("Bearer ".length), { audience: "workspace", purpose: "session" });
  const user = ctx.store.users.get(claims.userId);
  invariant(user?.active, 401, "inactive_user", "The session user is not active");
  return { userId: user.id, organizationIds: [...user.organizationIds] };
}
