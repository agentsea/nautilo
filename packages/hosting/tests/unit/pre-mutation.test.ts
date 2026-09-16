import { describe, expect, test } from "bun:test";
import {
  evaluatePreMutation,
  type CapabilityStatus,
  type HostingCapability,
  type HostingNotice,
} from "../../src";

const repairTarget = { kind: "admin-providers" } as const;

function capability(
  name: HostingCapability,
  overrides: Partial<CapabilityStatus> = {},
): CapabilityStatus {
  return {
    capability: name,
    experience: "enhanced",
    impact: `${name} is available.`,
    repairTarget,
    ...overrides,
  };
}

function qualifiedCapabilities(): readonly CapabilityStatus[] {
  return [
    capability("chat"),
    capability("embeddings"),
    capability("search"),
    capability("tts"),
    capability("stt"),
  ];
}

function noticeSeverities(notices: readonly HostingNotice[]): readonly string[] {
  return notices.map((notice) => notice.severity);
}

describe("evaluatePreMutation", () => {
  test("keeps useful-ready core beside baseline optional capabilities", () => {
    const result = evaluatePreMutation({
      infrastructure: "claimable",
      coreDegradedConsent: false,
      capabilities: [
        capability("chat"),
        capability("embeddings"),
        capability("search", {
          experience: "baseline",
          impact: "Baseline search remains available; dedicated research is reduced.",
          enhancement: {
            provider: "tavily",
            availability: "absent",
            impact: "Tavily is absent; dedicated research/search is reduced.",
            repairTarget,
          },
        }),
        capability("tts", {
          experience: "baseline",
          impact: "Baseline voice remains available; premium voice is reduced.",
          enhancement: {
            provider: "elevenlabs",
            availability: "invalid",
            impact: "ElevenLabs is invalid; premium voice is reduced.",
            repairTarget,
          },
        }),
        capability("stt"),
      ],
    });

    expect(result).toMatchObject({
      outcome: "authorized",
      infrastructure: "claimable",
      coreReadiness: "useful-ready",
      mutationAuthorized: true,
    });
    expect(noticeSeverities(result.notices)).toEqual(["warning", "warning"]);
  });

  test("keeps claimable infrastructure separate from core degradation", () => {
    const result = evaluatePreMutation({
      infrastructure: "claimable",
      coreDegradedConsent: true,
      capabilities: qualifiedCapabilities().map((status) =>
        status.capability === "embeddings"
          ? { ...status, experience: "unavailable", impact: "Embeddings are unavailable." }
          : status,
      ),
    });

    expect(result).toMatchObject({
      outcome: "authorized",
      infrastructure: "claimable",
      coreReadiness: "degraded",
      coreDegradedConsent: true,
      mutationAuthorized: true,
    });
  });

  test("blocks a missing core capability before mutation without explicit consent", () => {
    const result = evaluatePreMutation({
      infrastructure: "planned",
      coreDegradedConsent: false,
      capabilities: qualifiedCapabilities().filter(
        (status) => status.capability !== "embeddings",
      ),
    });

    expect(result).toMatchObject({
      outcome: "blocked",
      infrastructure: "planned",
      coreReadiness: "blocked",
      coreDegradedConsent: false,
      mutationAuthorized: false,
    });
    expect(
      result.notices.some(
        (notice) =>
          notice.severity === "blocking" &&
          notice.code === "hosting.core-capability-missing" &&
          notice.capability === "embeddings",
      ),
    ).toBe(true);
  });

  test("explicit core-degraded consent authorizes the limited plan", () => {
    const result = evaluatePreMutation({
      infrastructure: "planned",
      coreDegradedConsent: true,
      capabilities: qualifiedCapabilities().map((status) =>
        status.capability === "embeddings"
          ? { ...status, experience: "invalid", impact: "Embeddings validation failed." }
          : status,
      ),
    });

    expect(result).toMatchObject({
      outcome: "authorized",
      coreReadiness: "degraded",
      coreDegradedConsent: true,
      mutationAuthorized: true,
    });
    expect(noticeSeverities(result.notices)).toEqual(["warning"]);
  });

  test("an invalid optional enhancement with a baseline remains only a warning", () => {
    const result = evaluatePreMutation({
      infrastructure: "provisioning",
      coreDegradedConsent: false,
      capabilities: qualifiedCapabilities().map((status) =>
        status.capability === "tts"
          ? {
              ...status,
              experience: "baseline",
              impact: "Baseline voice remains available.",
              enhancement: {
                provider: "elevenlabs",
                availability: "invalid",
                impact: "ElevenLabs needs repair.",
                repairTarget,
              },
            }
          : status,
      ),
    });

    expect(result).toMatchObject({
      outcome: "authorized",
      coreReadiness: "useful-ready",
      mutationAuthorized: true,
    });
    expect(result.notices).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "hosting.optional-enhancement-unavailable",
        capability: "tts",
      }),
    ]);
  });

  test("notice severity never overwrites readiness axes", () => {
    const useful = evaluatePreMutation({
      infrastructure: "claimable",
      coreDegradedConsent: false,
      capabilities: qualifiedCapabilities().map((status) =>
        status.capability === "search"
          ? {
              ...status,
              experience: "baseline",
              impact: "Baseline search remains available.",
              enhancement: {
                provider: "tavily",
                availability: "absent",
                impact: "Tavily is optional and absent.",
                repairTarget,
              },
            }
          : status,
      ),
    });
    const blocked = evaluatePreMutation({
      infrastructure: "claimable",
      coreDegradedConsent: false,
      capabilities: qualifiedCapabilities().map((status) =>
        status.capability === "chat"
          ? { ...status, experience: "unavailable", impact: "Chat is unavailable." }
          : status,
      ),
    });

    expect(useful.coreReadiness).toBe("useful-ready");
    expect(noticeSeverities(useful.notices)).toEqual(["warning"]);
    expect(blocked.infrastructure).toBe("claimable");
    expect(blocked.coreReadiness).toBe("blocked");
    expect(noticeSeverities(blocked.notices)).toEqual(["blocking"]);
  });

  test("fails closed on duplicate capability inputs rather than choosing one", () => {
    const result = evaluatePreMutation({
      infrastructure: "planned",
      coreDegradedConsent: true,
      capabilities: [...qualifiedCapabilities(), capability("chat", { experience: "invalid" })],
    });

    expect(result).toMatchObject({
      outcome: "blocked",
      coreReadiness: "blocked",
      coreDegradedConsent: false,
      mutationAuthorized: false,
    });
    expect(result.notices).toEqual([
      expect.objectContaining({
        severity: "blocking",
        code: "hosting.input-invalid",
        capability: "chat",
      }),
    ]);
  });
});
