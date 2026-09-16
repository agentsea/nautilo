/**
 * Lives in `tests/unit-isolated/` because it calls
 * `mock.module("@nautilo/trust", …)` which persists for the lifetime of
 * the bun process and would otherwise pollute later test imports.
 */
/**
 * M058 / M213 — `buildResolveBearer` shared helper (Logto-only post-M072).
 *
 * Logto helpers and M213 read-model entry points are mocked so coverage stays
 * hermetic with no external infrastructure.
 */
import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { CanonicalPrincipal, PolicyResolver, RbacProjection, RuntimePolicyContext } from "@nautilo/trust";

interface LogtoPayloadLike {
  sub: string;
  [k: string]: unknown;
}

const DEFAULT_PRINCIPAL: CanonicalPrincipal = {
  logtoSub: "logto-sub-default",
  userId: "user-default",
  disabledAt: null,
  actorId: "actor-default",
  actorDisplayName: "Actor",
  handle: "user",
  displayName: "User",
  server: "server",
  federatedId: "@user@server",
  workbenchChannelBinding: null,
  personalAgent: null,
};

const DEFAULT_RBAC: RbacProjection = {
  highestRole: "owner",
  capabilitySlugs: ["manage_users"],
  groupChips: [],
};

const verifyLogtoAccessTokenSpy = mock<
  (bearer: string) => Promise<LogtoPayloadLike>
>(async () => ({ sub: "logto-sub-default" }));
const checkLogtoRevocationSpy = mock<(sub: string) => Promise<boolean>>(
  async () => true,
);
const resolveCanonicalPrincipalByLogtoSubSpy = mock<
  (sub: string) => Promise<CanonicalPrincipal | null>
>(async () => DEFAULT_PRINCIPAL);
const projectUserRbacSpy = mock<
  (userId: string) => Promise<RbacProjection>
>(async () => DEFAULT_RBAC);

const realTrustResolveBearer = await import("@nautilo/trust");

mock.module("@nautilo/trust", () => ({
  ...realTrustResolveBearer,
  verifyLogtoAccessToken: verifyLogtoAccessTokenSpy,
  checkLogtoRevocation: checkLogtoRevocationSpy,
  resolveCanonicalPrincipalByLogtoSub: resolveCanonicalPrincipalByLogtoSubSpy,
  projectUserRbac: projectUserRbacSpy,
}));

import {
  buildResolveBearer,
  isResolveBearerPolicyOk,
  isResolveBearerRbacOk,
} from "../../src/auth/resolve-bearer";

const FAKE_CTX = {
  laneKey: "tui:owner",
  actorId: "actor-default",
  agentId: "agent-default",
  roomId: "",
  roomType: "",
  graphThreadId: "",
  actorLabel: "Owner",
  actorFederatedId: "@user@server",
  agentFederatedId: "@agent@server",
  speakerTrust: "verified",
  laneScope: "private",
  actorRole: "owner",
  memoryAccess: {
    ownerId: "owner",
    actorId: "actor-default",
    agentId: "agent-default",
    roomId: "",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: {},
  },
} as unknown as RuntimePolicyContext;

function makePolicyResolver(): PolicyResolver {
  return {
    resolveContext: mock(async () => FAKE_CTX),
  } as unknown as PolicyResolver;
}

function makePolicyResolverWithSpy(
  spy: ReturnType<typeof mock>,
): PolicyResolver {
  return {
    resolveContext: spy,
  } as unknown as PolicyResolver;
}

describe("buildResolveBearer", () => {
  afterAll(() => {
    mock.restore();
  });

  afterEach(() => {
    verifyLogtoAccessTokenSpy.mockClear();
    checkLogtoRevocationSpy.mockClear();
    resolveCanonicalPrincipalByLogtoSubSpy.mockClear();
    resolveCanonicalPrincipalByLogtoSubSpy.mockImplementation(async () => DEFAULT_PRINCIPAL);
    projectUserRbacSpy.mockClear();
    projectUserRbacSpy.mockImplementation(async () => DEFAULT_RBAC);
  });

  test("forwards requestedRoomId on policy depth (workbench channel)", async () => {
    const resolveContextSpy = mock(async () => FAKE_CTX);
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolverWithSpy(resolveContextSpy),
    });
    const roomId = "55555555-5555-4555-8555-555555555555";
    const result = await resolve("jwt", { requestedRoomId: roomId, depth: "policy" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isResolveBearerPolicyOk(result)).toBe(true);
      const args = resolveContextSpy.mock.calls[0] as unknown[];
      expect(args[0]).toBe("workbench");
      expect(args[3]).toBe(roomId);
    }
  });

  test("revoked sub → reason=logto.revoked", async () => {
    checkLogtoRevocationSpy.mockImplementationOnce(async () => false);
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolver(),
    });
    const result = await resolve("any-jwt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("logto.revoked");
  });

  test("unseen sub → reason=logto.unknown_sub", async () => {
    resolveCanonicalPrincipalByLogtoSubSpy.mockImplementationOnce(async () => null);
    verifyLogtoAccessTokenSpy.mockImplementationOnce(async () => ({
      sub: "never-seen-sub",
    }));
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolver(),
    });
    const result = await resolve("valid-jwt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("logto.unknown_sub");
  });

  test("disabled user → reason=user_disabled", async () => {
    resolveCanonicalPrincipalByLogtoSubSpy.mockImplementationOnce(async () => ({
      ...DEFAULT_PRINCIPAL,
      disabledAt: new Date("2026-01-01T00:00:00.000Z"),
    }));
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolver(),
    });
    const result = await resolve("valid-jwt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("user_disabled");
  });

  test("missing federated id → reason=logto.no_federated_id", async () => {
    resolveCanonicalPrincipalByLogtoSubSpy.mockImplementationOnce(async () => ({
      ...DEFAULT_PRINCIPAL,
      handle: null,
      federatedId: "",
    }));
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolver(),
    });
    const result = await resolve("any-jwt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("logto.no_federated_id");
  });

  test("missing policy resolver at policy depth → reason=logto.no_policy_resolver", async () => {
    const resolve = buildResolveBearer({
      policyResolver: null,
    });
    const result = await resolve("any-jwt", { depth: "policy" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("logto.no_policy_resolver");
  });

  test("rbac depth succeeds without policy resolver", async () => {
    const resolve = buildResolveBearer({
      policyResolver: null,
    });
    const result = await resolve("any-jwt", { depth: "rbac" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isResolveBearerRbacOk(result)).toBe(true);
      if (isResolveBearerRbacOk(result)) {
        expect(result.rbacProjection).toEqual(DEFAULT_RBAC);
        expect("policyContext" in result).toBe(false);
      }
    }
  });

  test("identity depth skips rbac and policy", async () => {
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolver(),
    });
    const result = await resolve("any-jwt", { depth: "identity" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.depth).toBe("identity");
      expect(projectUserRbacSpy).not.toHaveBeenCalled();
    }
  });

  test("rbac depth does not invoke policy resolver", async () => {
    const resolveContextSpy = mock(async () => FAKE_CTX);
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolverWithSpy(resolveContextSpy),
    });
    const result = await resolve("any-jwt", { depth: "rbac" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isResolveBearerRbacOk(result)).toBe(true);
    }
    expect(resolveContextSpy).not.toHaveBeenCalled();
    expect(projectUserRbacSpy).toHaveBeenCalledTimes(1);
  });

  test("known sub resolves + returns policy context at policy depth", async () => {
    resolveCanonicalPrincipalByLogtoSubSpy.mockImplementationOnce(async () => ({
      ...DEFAULT_PRINCIPAL,
      actorId: "actor-logto-1",
      userId: "user-logto-1",
    }));
    verifyLogtoAccessTokenSpy.mockImplementationOnce(async () => ({
      sub: "logto-sub-default",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    }));
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolver(),
    });
    const result = await resolve("valid-jwt", { depth: "policy" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isResolveBearerPolicyOk(result)).toBe(true);
      expect(result.sessionActorId).toBe("actor-logto-1");
      expect(result.sessionUserId).toBe("user-logto-1");
      expect(result.accessTokenIssuedAt).toBe(1_700_000_000);
      expect(result.accessTokenExpiresAt).toBe(1_700_003_600_000);
      expect(result.principal.userId).toBe("user-logto-1");
      expect(verifyLogtoAccessTokenSpy).toHaveBeenCalledTimes(1);
    }
  });

  test("verifier throwing → reason=exception (caught, not propagated)", async () => {
    verifyLogtoAccessTokenSpy.mockImplementationOnce(async () => {
      throw new Error("jwt expired");
    });
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolver(),
    });
    const result = await resolve("stale-jwt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("exception");
      expect((result.err as Error).message).toBe("jwt expired");
    }
  });

  test("zero personal agent → ok with empty preferredAgentId (no bootstrap fallback)", async () => {
    resolveCanonicalPrincipalByLogtoSubSpy.mockImplementationOnce(async () => ({
      ...DEFAULT_PRINCIPAL,
      actorId: "actor-orphan",
      userId: "user-orphan",
      personalAgent: null,
    }));
    const resolveContextSpy = mock(async () => FAKE_CTX);
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolverWithSpy(resolveContextSpy),
    });
    const result = await resolve("valid-jwt", { depth: "policy" });
    expect(result.ok).toBe(true);
    const args = resolveContextSpy.mock.calls[0] as unknown[];
    expect(args[2]).toBe("");
  });

  test("resolveCanonicalPrincipalByLogtoSub throws → reason=agent_resolution_failed", async () => {
    resolveCanonicalPrincipalByLogtoSubSpy.mockImplementationOnce(async () => {
      throw new Error("db blip");
    });
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolver(),
    });
    const result = await resolve("any-jwt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("agent_resolution_failed");
      expect((result.err as Error).message).toBe("db blip");
    }
  });

  test("personalAgent.agentId is preferred for policy resolveContext", async () => {
    resolveCanonicalPrincipalByLogtoSubSpy.mockImplementationOnce(async () => ({
      ...DEFAULT_PRINCIPAL,
      personalAgent: {
        agentId: "agent-from-owned",
        handle: "h",
        displayName: "d",
      },
    }));
    const resolveContextSpy = mock(async () => FAKE_CTX);
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolverWithSpy(resolveContextSpy),
    });
    const result = await resolve("valid-jwt", { depth: "policy" });
    expect(result.ok).toBe(true);
    const args = resolveContextSpy.mock.calls[0] as unknown[];
    expect(args[2]).toBe("agent-from-owned");
  });

  test("uses resolveContextFromPrincipal when implemented (skips resolveContext)", async () => {
    const resolveContextFromPrincipalSpy = mock(async () => FAKE_CTX);
    const resolveContextSpy = mock(async () => FAKE_CTX);
    const resolve = buildResolveBearer({
      policyResolver: {
        resolveContext: resolveContextSpy,
        resolveContextFromPrincipal: resolveContextFromPrincipalSpy,
      } as unknown as PolicyResolver,
    });
    const result = await resolve("valid-jwt", {
      depth: "policy",
      requestedRoomId: "room-1",
    });
    expect(result.ok).toBe(true);
    expect(resolveContextFromPrincipalSpy).toHaveBeenCalledTimes(1);
    expect(resolveContextSpy).not.toHaveBeenCalled();
    const firstCall = resolveContextFromPrincipalSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const input = (firstCall as unknown as [{
      principal: CanonicalPrincipal;
      rbacProjection: RbacProjection;
      preferredAgentId: string;
      requestedRoomId?: string;
    }])[0];
    expect(input.principal).toEqual(DEFAULT_PRINCIPAL);
    expect(input.rbacProjection).toEqual(DEFAULT_RBAC);
    expect(input.preferredAgentId).toBe("");
    expect(input.requestedRoomId).toBe("room-1");
  });

  test("forwards Human-only requested Room admission for content surfaces", async () => {
    const resolveContextFromPrincipalSpy = mock(async () => FAKE_CTX);
    const resolve = buildResolveBearer({
      policyResolver: {
        resolveContext: mock(async () => FAKE_CTX),
        resolveContextFromPrincipal: resolveContextFromPrincipalSpy,
      } as unknown as PolicyResolver,
    });
    const result = await resolve("valid-jwt", {
      depth: "policy",
      requestedRoomId: "room-content",
      requestedRoomAdmission: "human",
    });
    expect(result.ok).toBe(true);
    const firstCall = resolveContextFromPrincipalSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const input = (firstCall as unknown as [{
      requestedRoomId?: string;
      requestedRoomAdmission?: string;
    }])[0];
    expect(input.requestedRoomId).toBe("room-content");
    expect(input.requestedRoomAdmission).toBe("human");
  });

  test("falls back to resolveContext when resolveContextFromPrincipal is absent", async () => {
    const resolveContextSpy = mock(async () => FAKE_CTX);
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolverWithSpy(resolveContextSpy),
    });
    const result = await resolve("valid-jwt", { depth: "policy" });
    expect(result.ok).toBe(true);
    expect(resolveContextSpy).toHaveBeenCalledTimes(1);
  });
});
