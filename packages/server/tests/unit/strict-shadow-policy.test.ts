import { describe, expect, test } from "bun:test";

import {
  classifyLiveShadowBoundaryFailure,
  installStrictShadowPlaintextRouteGate,
  rejectChangedStrictShadowPolicy,
  StrictShadowDispatchError,
  strictShadowHttpBody,
  strictShadowHttpStatus,
} from "../../src/lib/strict-shadow-policy";

describe("M302 server Strict Shadow boundary mapping", () => {
  test.each([
    ["namespace_unavailable", "waiting_for_authority", "namespace_authority_converging", true],
    ["recipient_sync_required", "waiting_for_authority", "namespace_authority_converging", true],
    ["domain_unavailable", "waiting_for_authority", "domain_authority_converging", true],
    ["agent_authority_unavailable", "waiting_for_authority", "domain_authority_converging", true],
    ["device_unavailable", "failed", "device_not_enrolled", false],
    ["policy_unavailable", "failed", "unknown_result", false],
    ["reservation_unavailable", "failed", "publication_failure", false],
    ["request_failed", "failed", "publication_failure", false],
    ["invalid_plan", "failed", "integrity_failure", false],
    ["client_not_browser", "unsupported", "unsupported_operation", false],
    ["room_topology_unsupported", "unsupported", "unsupported_operation", false],
    ["request_shape_unsupported", "unsupported", "unsupported_operation", false],
  ] as const)("classifies failed planning diagnostic %s", (input, state, reason, retryable) => {
    expect(classifyLiveShadowBoundaryFailure(input)).toEqual({ state, reason, retryable });
  });

  test.each(["journal_full", "journal_unavailable"])("classifies %s as publication failure, not integrity failure", (reason) => {
    expect(classifyLiveShadowBoundaryFailure(reason)).toEqual({
      state: "failed", reason: "publication_failure", retryable: false,
    });
  });

  test("keeps legitimate authority catch-up yellow and terminal defects red", () => {
    expect(classifyLiveShadowBoundaryFailure("recipient_sync_required"))
      .toEqual({
        state: "waiting_for_authority",
        reason: "namespace_authority_converging",
        retryable: true,
      });
    expect(classifyLiveShadowBoundaryFailure("agent_authority_unavailable"))
      .toEqual({
        state: "waiting_for_authority",
        reason: "domain_authority_converging",
        retryable: true,
      });
    expect(classifyLiveShadowBoundaryFailure("profile_unavailable")).toEqual({
      state: "failed",
      reason: "device_not_enrolled",
      retryable: false,
    });
    expect(classifyLiveShadowBoundaryFailure("authority_stale")).toEqual({
      state: "failed",
      reason: "stale_authority",
      retryable: false,
    });
  });

  test("uses retryable 425 only for withheld authority work", () => {
    const wait = {
      disposition: "withhold" as const,
      decision: {
        boundaryId: "conversation.write.foreground",
        family: "message",
        operation: "write",
        actorClass: "human" as const,
        state: "waiting_for_authority" as const,
        reason: "domain_authority_converging" as const,
        retryable: true,
        policyRevision: 7,
      },
    };
    expect(strictShadowHttpStatus(wait)).toBe(425);
    expect(strictShadowHttpBody(wait)).toEqual({
      error: "strict_shadow_protected_content_required",
      state: "waiting_for_authority",
      reason: "domain_authority_converging",
      retryable: true,
    });
    expect(strictShadowHttpStatus({
      ...wait,
      disposition: "reject",
    })).toBe(409);
  });

  test("invalidates an in-flight foreground policy snapshot after revision change", () => {
    const observed = {
      policy: {
        id: "server" as const,
        mode: "shadow_encryption" as const,
        shadowBehavior: "strict" as const,
        revision: 8,
        shadowEncryptionStartedAt: new Date(),
        updatedAt: new Date(),
      },
      result: {
        disposition: "protected" as const,
        decision: {
          boundaryId: "conversation.read.foreground_history",
          family: "message",
          operation: "read_repair",
          actorClass: "agent" as const,
          state: "verified" as const,
          reason: "none" as const,
          retryable: false,
          policyRevision: 8,
        },
      },
    };
    expect(() => rejectChangedStrictShadowPolicy({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 7,
    }, observed)).toThrow(StrictShadowDispatchError);
    expect(() => rejectChangedStrictShadowPolicy({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      revision: 8,
    }, observed)).not.toThrow();
  });

  test("blocks only legacy Workspace Artifact routes when Strict rejects", async () => {
    let hook: ((request: {
      routeOptions: { url?: string };
    }, reply: {
      code(status: number): unknown;
      send(body: unknown): unknown;
    }) => Promise<unknown>) | undefined;
    const app = {
      addHook: (_name: string, candidate: typeof hook) => { hook = candidate; },
    };
    installStrictShadowPlaintextRouteGate(
      app as never,
      async () => ({
        policy: {
          mode: "shadow_encryption",
          shadowBehavior: "strict",
          revision: 7,
          shadowEncryptionStartedAt: new Date(),
          updatedAt: new Date(),
        },
        result: {
          disposition: "reject",
          decision: {
            boundaryId: "artifact.api.workspace",
            family: "artifact",
            operation: "process",
            actorClass: "human",
            state: "unsupported",
            reason: "unsupported_operation",
            retryable: false,
            policyRevision: 7,
          },
        },
      }),
    );
    if (hook === undefined) throw new Error("preHandler was not installed");
    let status = 200;
    let body: unknown;
    const reply = {
      code(next: number) { status = next; return this; },
      send(next: unknown) { body = next; return next; },
    };
    await hook({ routeOptions: { url: "/api/protected/artifacts" } }, reply);
    expect(status).toBe(200);
    await hook({ routeOptions: { url: "/api/workspace/artifacts/:id" } }, reply);
    expect(status).toBe(409);
    expect(body).toMatchObject({
      error: "strict_shadow_protected_content_required",
      state: "unsupported",
    });
  });
});
