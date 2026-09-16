import { listProjects } from "../projects/service.js";
import { overview, membershipView } from "../projects/overview.js";
import { updateSettings } from "../projects/settings.js";
import { createInvitation, redeemInvitation } from "../identity/invitations.js";
import { listActivity } from "../events/activity.js";

export function projectRoutes(ctx, route) {
  route("GET", "/projects", (actor) => listProjects(ctx, actor));
  route("GET", "/projects/:projectId", (actor, params) => overview(ctx, actor, params.projectId));
  route("GET", "/projects/:projectId/membership", (actor, params) => membershipView(ctx, actor, params.projectId));
  route("PATCH", "/projects/:projectId/settings", (actor, params, body) => updateSettings(ctx, actor, params.projectId, body));
  route("POST", "/projects/:projectId/invitations", (actor, params, body) => createInvitation(ctx, actor, params.projectId, body));
  route("POST", "/invitations/redeem", (actor, _params, body) => redeemInvitation(ctx, actor, body.token));
  route("GET", "/projects/:projectId/activity", (actor, params) => listActivity(ctx, actor, params.projectId));
}
