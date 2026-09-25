/**
 * M213 Phase 6 — bearer stage single-flight (hermetic, mock.module isolated).
 * This is unit coverage: trust and policy dependencies are mocked and no
 * database, server, or external service is used.
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
  serverAccessAllowed: true,
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

let principalDelayMs = 0;
let principalGate: Promise<void> | null = null;
let releasePrincipalGate: (() => void) | null = null;

function defaultVerifyImpl(): Promise<LogtoPayloadLike> {
  return (async () => {
    if (principalGate) {
      await principalGate;
    } else if (principalDelayMs > 0) {
      await Bun.sleep(principalDelayMs);
    }
    return { sub: "logto-sub-default" };
  })();
}

const verifyLogtoAccessTokenSpy = mock<
  (bearer: string) => Promise<LogtoPayloadLike>
>(async () => defaultVerifyImpl());
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
  bearerResolutionDigest,
  buildResolveBearer,
  isResolveBearerPolicyOk,
  isResolveBearerRbacOk,
  policyResolutionStageKey,
  POLICY_STAGE_NO_ROOM_KEY,
} from "../../src/auth/resolve-bearer";

function makeMutablePolicyContext(roomId: string): RuntimePolicyContext {
  return {
    laneKey: "tui:owner",
    actorId: "actor-default",
    agentId: "agent-default",
    roomId,
    roomType: "private",
    graphThreadId: "room:test",
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
      roomId,
      readableNamespaces: ["ns-a"],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: { flag: true },
    },
  } as unknown as RuntimePolicyContext;
}

function makePolicyResolverForRoom(
  roomId: string,
): PolicyResolver {
  return {
    resolveContext: mock(async () => makeMutablePolicyContext(roomId)),
  } as unknown as PolicyResolver;
}

describe("buildResolveBearer M213 single-flight", () => {
  afterAll(() => {
    mock.restore();
  });

  afterEach(() => {
    principalDelayMs = 0;
    principalGate = null;
    releasePrincipalGate = null;
    verifyLogtoAccessTokenSpy.mockClear();
    verifyLogtoAccessTokenSpy.mockImplementation(async () => defaultVerifyImpl());
    checkLogtoRevocationSpy.mockClear();
    checkLogtoRevocationSpy.mockImplementation(async () => true);
    resolveCanonicalPrincipalByLogtoSubSpy.mockClear();
    resolveCanonicalPrincipalByLogtoSubSpy.mockImplementation(async () => DEFAULT_PRINCIPAL);
    projectUserRbacSpy.mockClear();
    projectUserRbacSpy.mockImplementation(async () => DEFAULT_RBAC);
  });

  test("20 concurrent same-bearer no-room policy calls coalesce all stages", async () => {
    const resolveContextSpy = mock(async () => makeMutablePolicyContext(""));
    const resolve = buildResolveBearer({
      policyResolver: { resolveContext: resolveContextSpy } as unknown as PolicyResolver,
    });
    const bearer = "same-bearer-token-for-coalesce";

    const results = await Promise.all(
      Array.from({ length: 20 }, () => resolve(bearer, { depth: "policy" })),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(verifyLogtoAccessTokenSpy).toHaveBeenCalledTimes(1);
    expect(checkLogtoRevocationSpy).toHaveBeenCalledTimes(1);
    expect(resolveCanonicalPrincipalByLogtoSubSpy).toHaveBeenCalledTimes(1);
    expect(projectUserRbacSpy).toHaveBeenCalledTimes(1);
    expect(resolveContextSpy).toHaveBeenCalledTimes(1);
  });

  test("concurrent rbac-depth and policy-depth reuse principal and rbac", async () => {
    const resolveContextSpy = mock(async () => makeMutablePolicyContext("room-ws"));
    const resolve = buildResolveBearer({
      policyResolver: { resolveContext: resolveContextSpy } as unknown as PolicyResolver,
    });
    const bearer = "shared-http-ws-bearer";

    const [rbacResult, policyResult] = await Promise.all([
      resolve(bearer, { depth: "rbac" }),
      resolve(bearer, {
        depth: "policy",
        requestedRoomId: "room-ws",
      }),
    ]);

    expect(rbacResult.ok).toBe(true);
    expect(policyResult.ok).toBe(true);
    if (rbacResult.ok) {
      expect(isResolveBearerRbacOk(rbacResult)).toBe(true);
    }
    if (policyResult.ok) {
      expect(isResolveBearerPolicyOk(policyResult)).toBe(true);
    }
    expect(verifyLogtoAccessTokenSpy).toHaveBeenCalledTimes(1);
    expect(resolveCanonicalPrincipalByLogtoSubSpy).toHaveBeenCalledTimes(1);
    expect(projectUserRbacSpy).toHaveBeenCalledTimes(1);
    expect(resolveContextSpy).toHaveBeenCalledTimes(1);
  });

  test("different requested rooms isolate policy stage while sharing principal/rbac", async () => {
    const roomA = "room-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const roomB = "room-bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const resolveContextSpy = mock(async (_lane, _fed, _agent, requestedRoomId) =>
      makeMutablePolicyContext(String(requestedRoomId ?? "")),
    );
    const resolve = buildResolveBearer({
      policyResolver: { resolveContext: resolveContextSpy } as unknown as PolicyResolver,
    });
    const bearer = "multi-room-bearer";

    const [a, b] = await Promise.all([
      resolve(bearer, { depth: "policy", requestedRoomId: roomA }),
      resolve(bearer, { depth: "policy", requestedRoomId: roomB }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok && isResolveBearerPolicyOk(a) && isResolveBearerPolicyOk(b)) {
      expect(a.policyContext.roomId).toBe(roomA);
      expect(b.policyContext.roomId).toBe(roomB);
    }
    expect(verifyLogtoAccessTokenSpy).toHaveBeenCalledTimes(1);
    expect(projectUserRbacSpy).toHaveBeenCalledTimes(1);
    expect(resolveContextSpy).toHaveBeenCalledTimes(2);
  });

  test("failed principal stage evicts in-flight entry and retries on next call", async () => {
    let calls = 0;
    verifyLogtoAccessTokenSpy.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient jwt");
      }
      return { sub: "logto-sub-default" };
    });

    const resolve = buildResolveBearer({
      policyResolver: { resolveContext: mock(async () => makeMutablePolicyContext("")) } as unknown as PolicyResolver,
    });
    const bearer = "retry-after-failure-bearer";

    const first = await resolve(bearer, { depth: "policy" });
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.reason).toBe("exception");
    }

    const second = await resolve(bearer, { depth: "policy" });
    expect(second.ok).toBe(true);
    expect(verifyLogtoAccessTokenSpy).toHaveBeenCalledTimes(2);
  });

  test("digest/key helpers never expose raw bearer; in-flight keys are digest-only", async () => {
    const bearer = "super-secret-jwt-plaintext-value";
    const digest = bearerResolutionDigest(bearer);

    expect(digest).not.toBe(bearer);
    expect(digest).not.toContain(bearer);
    expect(policyResolutionStageKey(digest)).toContain(POLICY_STAGE_NO_ROOM_KEY);
    expect(policyResolutionStageKey(digest, "room-1")).toBe(`${digest}\0room-1`);
    expect(policyResolutionStageKey(digest, "room-1", "human")).toBe(
      `${digest}\0room-1\0human`,
    );

    principalGate = new Promise<void>((resolveGate) => {
      releasePrincipalGate = resolveGate;
    });
    const resolve = buildResolveBearer({
      policyResolver: { resolveContext: mock(async () => makeMutablePolicyContext("")) } as unknown as PolicyResolver,
    });

    const inFlight = resolve(bearer, { depth: "policy" });
    await Bun.sleep(1);
    const keys = resolve.__m213TestHooks.snapshotInFlightKeys();

    expect(keys.principal).toEqual([digest]);
    expect(keys.rbac).toEqual([digest]);
    expect(keys.policy).toEqual([policyResolutionStageKey(digest)]);
    for (const key of [...keys.principal, ...keys.rbac, ...keys.policy]) {
      expect(key).not.toContain(bearer);
    }

    releasePrincipalGate?.();
    await inFlight;
    const settled = resolve.__m213TestHooks.snapshotInFlightKeys();
    expect(settled.principal).toEqual([]);
    expect(settled.rbac).toEqual([]);
    expect(settled.policy).toEqual([]);
  });

  test("abandoned waiter does not cancel shared resolution for other awaiters", async () => {
    principalGate = new Promise<void>((resolveGate) => {
      releasePrincipalGate = resolveGate;
    });
    const resolveContextSpy = mock(async () => makeMutablePolicyContext(""));
    const resolve = buildResolveBearer({
      policyResolver: { resolveContext: resolveContextSpy } as unknown as PolicyResolver,
    });
    const bearer = "abandon-one-keep-shared";

    const abandoned = resolve(bearer, { depth: "policy" });
    const waiter = resolve(bearer, { depth: "policy" });

    await Bun.sleep(5);
    expect(verifyLogtoAccessTokenSpy).toHaveBeenCalledTimes(1);

    const abandonedOutcome = await Promise.race([
      abandoned,
      Bun.sleep(1).then(() => "abandoned-early" as const),
    ]);
    expect(abandonedOutcome).toBe("abandoned-early");

    releasePrincipalGate?.();
    const shared = await waiter;
    expect(shared.ok).toBe(true);
    expect(resolveContextSpy).toHaveBeenCalledTimes(1);

    const late = await abandoned;
    expect(late.ok).toBe(true);
  });

  test("policy results are cloned per caller — downstream mutation does not leak", async () => {
    const resolve = buildResolveBearer({
      policyResolver: makePolicyResolverForRoom("room-clone"),
    });
    const bearer = "clone-isolation-bearer";

    const [a, b] = await Promise.all([
      resolve(bearer, { depth: "policy", requestedRoomId: "room-clone" }),
      resolve(bearer, { depth: "policy", requestedRoomId: "room-clone" }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) {
      return;
    }
    expect(isResolveBearerPolicyOk(a)).toBe(true);
    expect(isResolveBearerPolicyOk(b)).toBe(true);
    if (!isResolveBearerPolicyOk(a) || !isResolveBearerPolicyOk(b)) {
      return;
    }

    (a.policyContext.memoryAccess as { readableNamespaces: string[] }).readableNamespaces.push("mutated");
    (a.policyContext as { roomId: string }).roomId = "mutated-room";

    expect(b.policyContext.roomId).toBe("room-clone");
    expect(b.policyContext.memoryAccess.readableNamespaces).toEqual(["ns-a"]);
    expect(a.policyContext).not.toBe(b.policyContext);
  });
});
