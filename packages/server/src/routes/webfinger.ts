import type { FastifyInstance } from "fastify";
import {
  composeFederatedId,
  getServerHostname,
  normalizeHandle,
  parseFederatedId,
  validateHandle,
} from "@nautilo/config";
import {
  PROFILE_AVATAR_URL,
  SHELL_AGENT_NAME,
  SHELL_AVATAR_REF,
  type WebFingerCard,
} from "@nautilo/types";
import {
  findActorByHandle,
  findUsersWithCapability,
} from "@nautilo/trust";
import { getProfile } from "@nautilo/agent";
import { log, warn } from "@nautilo/logger";

/**
 * M042C — `GET /.well-known/webfinger` (RFC 7033) plus the companion
 * `GET /api/profile/:handle` public lookup the JRD's `self` link
 * points at.
 *
 * WebFinger resolves an `acct:<handle>@<server>` resource to a JSON
 * Resource Descriptor (JRD) for federation partners (and local LAN
 * discovery). The endpoint is public by spec and always served, but
 * we emit a boot-time warning when `NAUTILO_HOSTNAME` ends in `.local`
 * because mDNS hostnames aren't resolvable off-LAN — federation won't
 * work with them. Iteration 5 will require a public domain; this
 * warning surfaces the readiness gap early.
 */

/**
 * Log a one-time boot warning if the configured hostname is mDNS-only.
 * Called from `createApp` at startup.
 */
export function logFederationReadinessWarning(): void {
  const host = getServerHostname();
  if (host.endsWith(".local")) {
    warn(
      `[webfinger] Hostname '${host}' ends with .local — WebFinger is served ` +
        `but not federation-ready (mDNS hostnames can't be resolved off-LAN). ` +
        `Iteration 5 will require a public domain.`,
    );
  } else {
    log(`[webfinger] Hostname '${host}' — WebFinger ready for federation discovery.`);
  }
}

interface WebfingerQuery {
  resource?: string;
}

export function webfingerRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: WebfingerQuery }>(
    "/.well-known/webfinger",
    async (request, reply) => {
      const resource = request.query.resource;
      if (!resource || !resource.startsWith("acct:")) {
        return reply.code(400).send({ error: "missing or invalid 'resource' query (expected acct:<handle>@<server>)" });
      }

      // The RFC 7033 spec wants `acct:alex@nautilo.local`. parseFederatedId
      // expects a leading `@`, so prepend before parsing.
      const parsed = parseFederatedId(`@${resource.slice("acct:".length)}`);
      if (!parsed) {
        return reply.code(404).send({ error: "invalid resource format" });
      }

      const server = getServerHostname();
      if (parsed.server !== server) {
        // Cross-server WebFinger (resolving handles on other servers)
        // is out of scope for M042C — we only serve our own residents.
        return reply.code(404).send({ error: "server mismatch" });
      }

      const hit = await findActorByHandle(parsed.handle);
      if (!hit) {
        return reply.code(404).send({ error: "unknown user" });
      }

      const subject = `acct:${parsed.handle}@${server}`;
      const profileHref = `https://${server}/api/profile/${parsed.handle}`;
      return reply
        .header("content-type", "application/jrd+json")
        .send({
          subject,
          links: [
            {
              rel: "self",
              type: "application/json",
              href: profileHref,
            },
            // Iteration 5 will add an MLS KeyPackage rel — intentionally
            // empty in M042C since the federation protocol doesn't exist
            // yet.
          ],
        });
    },
  );

  /**
   * Publicly-safe handle-indexed profile lookup. This is the URL
   * WebFinger's `self` link points at, so the JRD actually resolves
   * to content. Exposes only what a Mastodon/ActivityPub profile-card
   * consumer expects — no UUID, no soul file, no personality prompt,
   * no voice/model config.
   */
  app.get<{ Params: { handle: string } }>(
    "/api/profile/:handle",
    async (request, reply) => {
      // Use the same normalization + validation rules as onboarding.
      const raw = request.params.handle ?? "";
      const handle = normalizeHandle(raw);
      if (!validateHandle(handle).ok) {
        return reply.code(404).send({ error: "unknown handle" });
      }

      const hit = await findActorByHandle(handle);
      if (!hit) {
        return reply.code(404).send({ error: "unknown handle" });
      }

      const server = getServerHostname();
      const federatedId = composeFederatedId(handle, server);

      if (hit.kind === "user") {
        const card: WebFingerCard = {
          kind: "user",
          handle,
          displayName: hit.displayName,
          identity: federatedId,
        };
        return reply.send(card);
      }

      const card: WebFingerCard = {
        kind: "agent",
        handle,
        identity: federatedId,
      };

      // M128: post-M128 there is no per-Agent ownership group; every
      // Agent's "public profile owner" is the server's primary
      // `owners`-Group member (the bootstrap claimer). We use that
      // Human's profile row as the public card. If `owners` is empty
      // somehow, we fall through to the no-profile WebFinger card.
      const agentId = hit.agentId;
      if (!agentId) {
        return reply.send(card);
      }
      const owners = await findUsersWithCapability("manage_server_security");
      const ownerProfileUserId = owners[0] ?? null;
      const profile = ownerProfileUserId
        ? await getProfile(ownerProfileUserId)
        : null;
      if (profile?.publicProfile) {
        card.profile = {
          name: SHELL_AGENT_NAME,
          avatar: SHELL_AVATAR_REF,
          avatarUrl: PROFILE_AVATAR_URL,
        };
      }
      return reply.send(card);
    },
  );
}
