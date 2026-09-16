/**
 * M129 follow-up — `/api/profile` self-agent resolution.
 *
 * Regression guard for the bug where post-M128 canonical roles
 * (member / admin / superuser / contributor) fell through to "guest" in
 * `getViewerRole`, so a verified member saw the public shell projection
 * (empty ownedAgents, blank soul, default name) instead of their own
 * Agent. The fix: any authenticated, verified user views their OWN
 * profile as its owner.
 */
import { describe, expect, test } from "bun:test";
import type { FastifyRequest } from "fastify";
import { getViewerRole } from "../../src/routes/profile";
import { M128_ROLE_SLUGS } from "@nautilo/db";

type ViewerRoleRequest = Pick<FastifyRequest, "policyContext" | "sessionUserId">;

function req(actorRole: string | undefined, sessionUserId: string | null): ViewerRoleRequest {
  return {
    sessionUserId,
    policyContext: actorRole == null ? undefined : { actorRole },
  } as unknown as ViewerRoleRequest;
}

describe("getViewerRole — M129 self-agent resolution", () => {
  test("every authenticated non-guest M128 role views their own profile as owner", () => {
    for (const slug of M128_ROLE_SLUGS) {
      const result = getViewerRole(req(slug, "user-1"));
      if (slug === "guest") {
        expect(result).toBe("guest");
      } else {
        // owner / admin / superuser / member / contributor → owner-of-self
        expect(result).toBe("owner");
      }
    }
  });

  test("member specifically resolves to owner (the reported upgraded-instance bug)", () => {
    expect(getViewerRole(req("member", "user-1"))).toBe("owner");
  });

  test("stranger → stranger (public shell, distinct from guest)", () => {
    expect(getViewerRole(req("stranger", null))).toBe("stranger");
  });

  test("guest / anonymous / missing role → guest", () => {
    expect(getViewerRole(req("guest", null))).toBe("guest");
    expect(getViewerRole(req("anonymous", null))).toBe("guest");
    expect(getViewerRole(req(undefined, null))).toBe("guest");
  });

  test("a verified role with NO session id fails closed to guest", () => {
    // Defense in depth: a role string without an authenticated session
    // must not unlock the owner projection.
    expect(getViewerRole(req("member", null))).toBe("guest");
  });
});
