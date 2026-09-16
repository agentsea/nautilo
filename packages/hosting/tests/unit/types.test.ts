import { describe, expect, test } from "bun:test";
import type {
  AuthorizedHostingPlan,
  CapabilityStatus,
  HostingReconcileRequest,
  HostingSnapshot,
} from "../../src";

const repairTarget = { kind: "admin-providers" } as const;

const capabilities: readonly CapabilityStatus[] = [
  { capability: "chat", experience: "enhanced", impact: "", repairTarget },
  { capability: "embeddings", experience: "enhanced", impact: "", repairTarget },
  { capability: "search", experience: "baseline", impact: "", repairTarget },
  { capability: "tts", experience: "baseline", impact: "", repairTarget },
  { capability: "stt", experience: "enhanced", impact: "", repairTarget },
];

describe("hosting contract", () => {
  test("plans desired resources before provider IDs exist", () => {
    const plan: AuthorizedHostingPlan = {
      backend: "railway",
      infrastructure: "planned",
      coreReadiness: "useful-ready",
      capabilities,
      notices: [],
      resourceIntents: [
        { logicalName: "nautilo-server", kind: "service" },
        { logicalName: "app-postgres", kind: "database" },
      ],
      knownResources: [],
      coreDegradedConsent: false,
      mutationAuthorized: true,
    };

    expect(plan.resourceIntents).toEqual([
      { logicalName: "nautilo-server", kind: "service" },
      { logicalName: "app-postgres", kind: "database" },
    ]);
    expect(plan.knownResources).toEqual([]);
  });

  test("reconcile consumes the authorized plan and its known realized references", () => {
    const plan: AuthorizedHostingPlan = {
      backend: "railway",
      infrastructure: "provisioning",
      coreReadiness: "useful-ready",
      capabilities,
      notices: [],
      resourceIntents: [{ logicalName: "nautilo-server", kind: "service" }],
      knownResources: [{ kind: "service", id: "service_123", name: "nautilo-server" }],
      coreDegradedConsent: false,
      mutationAuthorized: true,
    };
    const request: HostingReconcileRequest = { backend: "railway", plan };

    expect(request.plan.resourceIntents[0]).toEqual({
      logicalName: "nautilo-server",
      kind: "service",
    });
    expect(request.plan.knownResources[0]).toEqual({
      kind: "service",
      id: "service_123",
      name: "nautilo-server",
    });
  });

  test("an error notice coexists with independent readiness axes", () => {
    const snapshot: HostingSnapshot = {
      backend: "railway",
      infrastructure: "claimable",
      coreReadiness: "useful-ready",
      capabilities,
      notices: [
        {
          severity: "error",
          code: "hosting.operation-failed",
          message: "A later provider operation failed.",
          resources: [{ kind: "service", id: "service_123" }],
        },
      ],
      resources: [{ kind: "service", id: "service_123" }],
    };

    expect(snapshot.infrastructure).toBe("claimable");
    expect(snapshot.coreReadiness).toBe("useful-ready");
    expect(snapshot.notices[0]?.severity).toBe("error");
  });
});
