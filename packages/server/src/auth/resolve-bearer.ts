/**
 * M058 — shared "bearer → policyContext" closure.
 *
 * The HTTP preHandler at `app.ts` and the `/ws` first-message auth gate
 * (`routes/ws.ts`) need the SAME work: validate the Logto JWT, look up
 * the matching `users` row by `external_id` (M126 retired the JIT path —
 * invites are now the only path to a `users` row), resolve the policy
 * context.
 *
 * Pulling that out of the preHandler keeps both call sites aligned
 * — the WS path can't drift from HTTP (a notorious "where do I add
 * the new revocation check?" trap). `policyResolver` and identity
 * strings are not module-level singletons; they're closures inside
 * `createApp(...)`. The builder-shape lets `createApp` mint one closure
 * and hand it to both consumers.
 *
 * M213 — resolution depth (`identity` | `rbac` | `policy`) stages JWT,
 * canonical principal, RBAC, and policy so shallow routes skip work they
 * do not need. Default depth remains `policy`.
 *
 * M213 Phase 6 — HTTP/WS bearer stage single-flight coalesces reusable
 * in-flight principal, RBAC, and policy work keyed by bearer digest
 * (never raw bearer). Entries are in-flight only and removed on settlement.
 *
 * This module returns a structured Result rather than throwing on
 * the failure path so the preHandler keeps its bit-identical
 * `fallbackToGuest(reason, err)` semantics. The WS path turns the
 * same Result into a `{type:"auth.rejected", error:<reason>}`
 * frame.
 */

import { createHash } from "node:crypto";
import { log } from "@nautilo/logger";
import {
  checkLogtoRevocation,
  projectUserRbac,
  resolveCanonicalPrincipalByLogtoSub,
  verifyLogtoAccessToken,
  type CanonicalPrincipal,
  type MemoryAccessEnvelope,
  type PolicyResolver,
  type RequestedRoomAdmission,
  type RbacProjection,
  type RuntimePolicyContext,
} from "@nautilo/trust";
import { timeStage } from "../telemetry/request-telemetry";

function accessTokenIssuedAtFromPayload(iat: unknown): number | null {
  if (typeof iat !== "number" || !Number.isFinite(iat) || iat <= 0) return null;
  return Math.trunc(iat);
}

function accessTokenExpiresAtFromPayload(exp: unknown): number | null {
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
  const milliseconds = Math.trunc(exp * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

/** Stable digest for bearer single-flight keys; never log or persist raw bearer. */
export function bearerResolutionDigest(bearer: string): string {
  return createHash("sha256").update(bearer, "utf8").digest("base64url");
}

/** Policy-stage key suffix: explicit room id or a stable no-room sentinel. */
export const POLICY_STAGE_NO_ROOM_KEY = "\0no-room";

export function policyResolutionStageKey(
  digest: string,
  requestedRoomId?: string,
  requestedRoomAdmission: RequestedRoomAdmission = "human_and_agent",
): string {
  const roomKey =
    requestedRoomId === undefined ? POLICY_STAGE_NO_ROOM_KEY : requestedRoomId;
  const admissionKey =
    requestedRoomAdmission === "human" ? "\0human" : "";
  return `${digest}\0${roomKey}${admissionKey}`;
}

export type ResolutionDepth = "identity" | "rbac" | "policy";

export interface BuildResolveBearerDeps {
  /** Null when createApp ran without a resolver (test harness path). The
   *  closure returns `{ ok: false, reason: "logto.no_policy_resolver" }`
   *  only when depth is `policy`. */
  policyResolver: PolicyResolver | null;
  /**
   * @deprecated M125 Phase 1.3: no longer consulted; remove after M125 stabilizes.
   *
   * Default Agent UUID for the personal-policy-resolver hot path. Accepts
   * either a plain string (legacy / tests) or a callback that returns the
   * current value on each request.
   *
   * D120 A1.P1b (was D112 Phase 18): the bootstrap-claim redeem
   * refreshes the in-process bootstrap-state-cache to the claimer's
   * per-user Agent. If this dep were a const snapshot from boot, the
   * in-process resolver would still see the pre-claim seed Agent and
   * the freshly-claimed admin would land as `stranger` until the
   * operator restarted the server. The callback shape lets app.ts
   * pass `() => getBootstrapDefaultAgentId()` so the refresh takes
   * effect on the very next request without a restart. For non-test
   * production processes the value still only shifts on the first
   * claim, never mid-session.
   */
  defaultAgentId?: string | (() => string) | undefined;
}

export type ResolveBearerReason =
  | "logto.revoked"
  | "logto.unknown_sub"
  | "logto.no_federated_id"
  | "logto.no_policy_resolver"
  | "agent_resolution_failed"
  // D219 — the resolved `users` row has `disabled_at IS NOT NULL`. The
  // HTTP preHandler turns this into a hard 401 (`user_disabled`); the WS
  // gate turns it into an `auth.rejected` close. Distinct from
  // `logto.unknown_sub` so logs/audit can tell "disabled" from "no row".
  | "user_disabled"
  | "server_access_withdrawn"
  | "exception";

interface ResolveBearerSuccessBase {
  readonly ok: true;
  readonly depth: ResolutionDepth;
  readonly principal: CanonicalPrincipal;
  readonly sessionActorId: string;
  readonly sessionUserId: string;
  readonly accessTokenIssuedAt: number | null;
  readonly accessTokenExpiresAt: number | null;
}

export interface ResolveBearerIdentityOk extends ResolveBearerSuccessBase {
  readonly depth: "identity";
}

export interface ResolveBearerRbacOk extends ResolveBearerSuccessBase {
  readonly depth: "rbac";
  readonly rbacProjection: RbacProjection;
}

export interface ResolveBearerPolicyOk extends ResolveBearerSuccessBase {
  readonly depth: "policy";
  readonly rbacProjection: RbacProjection;
  readonly policyContext: RuntimePolicyContext;
  readonly memoryEnvelope: MemoryAccessEnvelope;
}

export type ResolveBearerOk =
  | ResolveBearerIdentityOk
  | ResolveBearerRbacOk
  | ResolveBearerPolicyOk;

export interface ResolveBearerError {
  readonly ok: false;
  readonly reason: ResolveBearerReason;
  readonly err?: unknown;
}

export type ResolveBearerResult = ResolveBearerOk | ResolveBearerError;

export type ResolveBearerOpts = {
  requestedRoomId?: string;
  requestedRoomAdmission?: RequestedRoomAdmission;
  /** Minimum resolution depth. Defaults to `policy`. */
  depth?: ResolutionDepth;
};

export type ResolveBearer = (
  bearer: string,
  opts?: ResolveBearerOpts,
) => Promise<ResolveBearerResult>;

export interface ResolveBearerM213TestHooks {
  snapshotInFlightKeys(): {
    principal: string[];
    rbac: string[];
    policy: string[];
  };
}

export type ResolveBearerWithTestHooks = ResolveBearer & {
  readonly __m213TestHooks: ResolveBearerM213TestHooks;
};

export function isResolveBearerPolicyOk(
  result: ResolveBearerOk,
): result is ResolveBearerPolicyOk {
  return result.depth === "policy";
}

export function isResolveBearerRbacOk(
  result: ResolveBearerOk,
): result is ResolveBearerRbacOk {
  return result.depth === "rbac";
}

type PrincipalStageSuccess = {
  readonly ok: true;
  readonly principal: CanonicalPrincipal;
  readonly sessionActorId: string;
  readonly sessionUserId: string;
  readonly accessTokenIssuedAt: number | null;
  readonly accessTokenExpiresAt: number | null;
};

type PrincipalStageResult = PrincipalStageSuccess | ResolveBearerError;

type RbacStageSuccess = PrincipalStageSuccess & {
  readonly rbacProjection: RbacProjection;
};

type RbacStageResult = RbacStageSuccess | ResolveBearerError;

type PolicyStageSuccess = RbacStageSuccess & {
  readonly policyContext: RuntimePolicyContext;
};

type PolicyStageResult = PolicyStageSuccess | ResolveBearerError;

function clonePolicyContext(ctx: RuntimePolicyContext): RuntimePolicyContext {
  return structuredClone(ctx);
}

function settleInFlight<K, V>(
  map: Map<K, Promise<V>>,
  key: K,
  run: () => Promise<V>,
): Promise<V> {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const promise = run().finally(() => {
    map.delete(key);
  });
  map.set(key, promise);
  return promise;
}

/**
 * Build a closure that resolves a bearer string to a policy context.
 * Both the HTTP preHandler and the `/ws` auth gate consume the same
 * closure, ensuring a single source of truth (Logto JWT only post-M072).
 *
 * Zero owned agents → `{ ok: true }` with empty `preferredAgentId` so
 * the policy resolver shapes a no-agent / stranger context (no bootstrap
 * fallback). DB failure during principal lookup →
 * `{ ok: false, reason: "agent_resolution_failed" }`.
 */
export function buildResolveBearer(
  deps: BuildResolveBearerDeps,
): ResolveBearerWithTestHooks {
  const principalInFlight = new Map<string, Promise<PrincipalStageResult>>();
  const rbacInFlight = new Map<string, Promise<RbacStageResult>>();
  const policyInFlight = new Map<string, Promise<PolicyStageResult>>();

  async function runPrincipalStage(
    digest: string,
    bearer: string,
  ): Promise<PrincipalStageResult> {
    return settleInFlight(principalInFlight, digest, async () => {
      try {
        const payload = await timeStage("jwt", () => verifyLogtoAccessToken(bearer));
        const revoked = await timeStage("revocation", () =>
          checkLogtoRevocation(payload.sub),
        );
        if (!revoked) {
          return { ok: false, reason: "logto.revoked" };
        }

        let principal: CanonicalPrincipal;
        try {
          const resolved = await timeStage("principal", () =>
            resolveCanonicalPrincipalByLogtoSub(payload.sub),
          );
          if (!resolved) {
            return { ok: false, reason: "logto.unknown_sub" };
          }
          principal = resolved;
        } catch (err) {
          return { ok: false, reason: "agent_resolution_failed", err };
        }

        if (principal.disabledAt !== null) {
          return { ok: false, reason: "user_disabled" };
        }
        if (!principal.serverAccessAllowed) {
          return { ok: false, reason: "server_access_withdrawn" };
        }
        if (!principal.federatedId) {
          return { ok: false, reason: "logto.no_federated_id" };
        }

        return {
          ok: true,
          principal,
          sessionActorId: principal.actorId,
          sessionUserId: principal.userId,
          accessTokenIssuedAt: accessTokenIssuedAtFromPayload(payload.iat),
          accessTokenExpiresAt: accessTokenExpiresAtFromPayload(payload.exp),
        };
      } catch (err) {
        return { ok: false, reason: "exception", err };
      }
    });
  }

  async function runRbacStage(
    digest: string,
    bearer: string,
  ): Promise<RbacStageResult> {
    return settleInFlight(rbacInFlight, digest, async () => {
      const principalResult = await runPrincipalStage(digest, bearer);
      if (!principalResult.ok) {
        return principalResult;
      }

      const rbacProjection = await timeStage("rbac", () =>
        projectUserRbac(principalResult.principal.userId),
      );

      return {
        ...principalResult,
        rbacProjection,
      };
    });
  }

  async function runPolicyStage(
    digest: string,
    bearer: string,
    requestedRoomId: string | undefined,
    requestedRoomAdmission: RequestedRoomAdmission,
  ): Promise<PolicyStageResult> {
    const stageKey = policyResolutionStageKey(
      digest,
      requestedRoomId,
      requestedRoomAdmission,
    );
    return settleInFlight(policyInFlight, stageKey, async () => {
      const rbacResult = await runRbacStage(digest, bearer);
      if (!rbacResult.ok) {
        return rbacResult;
      }

      if (!deps.policyResolver) {
        return { ok: false, reason: "logto.no_policy_resolver" };
      }

      const { principal, rbacProjection } = rbacResult;
      const preferredAgentId = principal.personalAgent?.agentId ?? "";
      if (!preferredAgentId) {
        log(`[auth] bearer_no_personal_agent userId=${principal.userId}`);
      }

      const policyContext = await timeStage("policy", () => {
        const resolver = deps.policyResolver!;
        if (typeof resolver.resolveContextFromPrincipal === "function") {
          return resolver.resolveContextFromPrincipal({
            principal,
            rbacProjection,
            preferredAgentId,
            ...(requestedRoomId !== undefined ? { requestedRoomId } : {}),
            ...(requestedRoomAdmission !== "human_and_agent"
              ? { requestedRoomAdmission }
              : {}),
          });
        }
        return resolver.resolveContext(
          "workbench",
          principal.federatedId,
          preferredAgentId,
          requestedRoomId,
        );
      });

      return {
        ...rbacResult,
        policyContext,
      };
    });
  }

  async function resolveBearer(
    bearer: string,
    opts?: ResolveBearerOpts,
  ): Promise<ResolveBearerResult> {
    const depth: ResolutionDepth = opts?.depth ?? "policy";
    const digest = bearerResolutionDigest(bearer);

    if (depth === "identity") {
      const principalResult = await runPrincipalStage(digest, bearer);
      if (!principalResult.ok) {
        return principalResult;
      }
      return { ...principalResult, depth: "identity" };
    }

    if (depth === "rbac") {
      const rbacResult = await runRbacStage(digest, bearer);
      if (!rbacResult.ok) {
        return rbacResult;
      }
      return { ...rbacResult, depth: "rbac" };
    }

    const policyResult = await runPolicyStage(
      digest,
      bearer,
      opts?.requestedRoomId,
      opts?.requestedRoomAdmission ?? "human_and_agent",
    );
    if (!policyResult.ok) {
      return policyResult;
    }

    const policyContext = clonePolicyContext(policyResult.policyContext);
    return {
      ok: true,
      depth: "policy",
      principal: policyResult.principal,
      sessionActorId: policyResult.sessionActorId,
      sessionUserId: policyResult.sessionUserId,
      accessTokenIssuedAt: policyResult.accessTokenIssuedAt,
      accessTokenExpiresAt: policyResult.accessTokenExpiresAt,
      rbacProjection: policyResult.rbacProjection,
      policyContext,
      memoryEnvelope: policyContext.memoryAccess,
    };
  }

  const testHooks: ResolveBearerM213TestHooks = {
    snapshotInFlightKeys() {
      return {
        principal: [...principalInFlight.keys()],
        rbac: [...rbacInFlight.keys()],
        policy: [...policyInFlight.keys()],
      };
    },
  };

  return Object.assign(resolveBearer, { __m213TestHooks: testHooks }) as ResolveBearerWithTestHooks;
}
