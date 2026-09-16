import { createStore } from "../core/store.js";
import { createClock } from "../core/clock.js";
import { invariant, responseError } from "../core/errors.js";
import { seedDevelopment } from "../core/seed.js";
import { createTokens } from "../identity/tokens.js";
import { authenticate, issueSession } from "../identity/sessions.js";
import { createAccessCache } from "../projects/access-cache.js";
import { createBus, subscribeOrganization } from "../events/bus.js";
import { drainExports, runExport } from "../jobs/runner.js";
import { runPublication } from "../jobs/publisher.js";
import { projectRoutes } from "./project-routes.js";
import { documentRoutes } from "./document-routes.js";
import { workRoutes } from "./work-routes.js";

export function createApplication({ secret, now }) {
  const store = createStore();
  const clock = createClock(now);
  const ctx = { store, clock, tokens: createTokens(secret, clock), accessCache: createAccessCache(), bus: createBus() };
  seedDevelopment(store);
  const routes = [];
  function route(method, pattern, handler, options = {}) {
    routes.push({ method, parts: pattern.split("/").filter(Boolean), handler, public: options.public === true });
  }
  projectRoutes(ctx, route);
  documentRoutes(ctx, route);
  workRoutes(ctx, route);
  function dispatch(request) {
    try {
      const parts = request.path.split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
      const candidate = routes.find((item) => item.method === request.method && item.parts.length === parts.length &&
        item.parts.every((part, index) => part.startsWith(":") || part === parts[index]));
      invariant(candidate, 404, "route_missing", "Route was not found");
      const params = Object.fromEntries(candidate.parts.flatMap((part, index) => part.startsWith(":") ? [[part.slice(1), parts[index]]] : []));
      const actor = candidate.public ? null : authenticate(ctx, request.authorization);
      return { status: 200, body: candidate.handler(actor, params, request.body ?? {}) };
    } catch (error) { return responseError(error); }
  }
  return {
    ctx, dispatch,
    session: (userId, expiresAt) => issueSession(ctx, userId, expiresAt),
    runExport: (jobId) => runExport(ctx, jobId),
    drainExports: () => drainExports(ctx),
    runPublication: (publicationId) => runPublication(ctx, publicationId),
    subscribe(authorization, organizationId, listener) {
      return subscribeOrganization(ctx, authenticate(ctx, authorization), organizationId, listener);
    },
  };
}
