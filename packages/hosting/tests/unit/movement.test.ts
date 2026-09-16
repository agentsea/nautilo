import { describe, expect, test } from "bun:test";
import {
  evaluatePreMutationMovement,
  type CapabilityStatus,
  type HostingCapability,
  type PreMutationMovementInput,
} from "../../src";

const repairTarget = { kind: "admin-providers" } as const;

function capability(name: HostingCapability): CapabilityStatus {
  return {
    capability: name,
    experience: "enhanced",
    impact: `${name} is qualified.`,
    repairTarget,
  };
}

function qualifiedCapabilities(): readonly CapabilityStatus[] {
  return (["chat", "embeddings", "search", "tts", "stt"] as const).map(capability);
}

function input(
  overrides: Partial<PreMutationMovementInput> = {},
): PreMutationMovementInput {
  return {
    mode: "noninteractive",
    yes: true,
    allowCoreDegraded: false,
    backend: "railway",
    release: "verified",
    cost: { payer: "customer Railway workspace", estimate: "$20/month" },
    infrastructure: "planned",
    capabilities: qualifiedCapabilities(),
    credentialSourcesValid: true,
    authorization: "authorized",
    ...overrides,
  };
}

function expectOutcome(
  overrides: Partial<PreMutationMovementInput>,
  outcome: ReturnType<typeof evaluatePreMutationMovement>["outcome"],
  nextAction: ReturnType<typeof evaluatePreMutationMovement>["nextAction"],
): void {
  const result = evaluatePreMutationMovement(input(overrides));
  expect(result.outcome).toBe(outcome);
  expect(result.nextAction).toBe(nextAction);
}

describe("evaluatePreMutationMovement", () => {
  test("reaches the first provider mutation only after the complete noninteractive path", () => {
    const result = evaluatePreMutationMovement(input());

    expect(result).toMatchObject({
      outcome: "ready-to-provision",
      nextAction: "provision",
      infrastructure: "planned",
      coreReadiness: "useful-ready",
      mutationAuthorized: true,
      coreDegradedConsent: false,
    });
  });

  test("uses one engine for TTY and noninteractive ordinary confirmation", () => {
    expectOutcome(
      { mode: "tty", yes: false, billableMutationConfirmed: undefined },
      "needs-input",
      "confirm-billable-mutation",
    );
    expectOutcome(
      { mode: "tty", yes: true, billableMutationConfirmed: false },
      "cancelled",
      "none",
    );
    expectOutcome(
      { mode: "tty", yes: false, billableMutationConfirmed: true },
      "ready-to-provision",
      "provision",
    );
    expectOutcome({ yes: false }, "blocked", "none");
  });

  test("never allows yes to imply core-degraded consent", () => {
    const coreGap = qualifiedCapabilities().map((status) =>
      status.capability === "embeddings"
        ? { ...status, experience: "unavailable" as const, impact: "Embeddings are absent." }
        : status,
    );

    const yesOnly = evaluatePreMutationMovement(
      input({ capabilities: coreGap, yes: true, allowCoreDegraded: false }),
    );
    const explicitFlag = evaluatePreMutationMovement(
      input({ capabilities: coreGap, yes: true, allowCoreDegraded: true }),
    );

    expect(yesOnly).toMatchObject({
      outcome: "blocked",
      coreReadiness: "blocked",
      coreDegradedConsent: false,
      mutationAuthorized: false,
    });
    expect(yesOnly.notices).toEqual([
      expect.objectContaining({
        severity: "blocking",
        code: "hosting.core-capability-missing",
        capability: "embeddings",
      }),
    ]);
    expect(explicitFlag).toMatchObject({
      outcome: "ready-to-provision",
      coreReadiness: "degraded",
      coreDegradedConsent: true,
      mutationAuthorized: true,
    });
  });

  test("routes every TTY core-gap choice through the same pure result", () => {
    const capabilities = qualifiedCapabilities().filter(
      (status) => status.capability !== "chat",
    );

    expectOutcome(
      { mode: "tty", capabilities, coreGapDecision: undefined },
      "needs-input",
      "choose-core-gap-action",
    );
    expectOutcome(
      { mode: "tty", capabilities, coreGapDecision: "add-key" },
      "needs-input",
      "repair-credentials",
    );
    expectOutcome(
      { mode: "tty", capabilities, coreGapDecision: "exit" },
      "cancelled",
      "none",
    );
    const accepted = evaluatePreMutationMovement(
      input({ mode: "tty", yes: false, capabilities, coreGapDecision: "accept-core-degraded" }),
    );
    expect(accepted).toMatchObject({
      outcome: "needs-input",
      nextAction: "confirm-billable-mutation",
      coreReadiness: "degraded",
      coreDegradedConsent: true,
    });
  });

  test("keeps ElevenLabs and Tavily omissions as warnings with useful-ready core", () => {
    const capabilities = qualifiedCapabilities().map((status) => {
      if (status.capability === "tts") {
        return {
          ...status,
          experience: "baseline" as const,
          enhancement: {
            provider: "elevenlabs" as const,
            availability: "absent" as const,
            impact: "Premium voice is unavailable.",
            repairTarget,
          },
        };
      }
      if (status.capability === "search") {
        return {
          ...status,
          experience: "baseline" as const,
          enhancement: {
            provider: "tavily" as const,
            availability: "invalid" as const,
            impact: "Dedicated research is unavailable.",
            repairTarget,
          },
        };
      }
      return status;
    });

    const result = evaluatePreMutationMovement(input({ capabilities }));
    expect(result).toMatchObject({
      outcome: "ready-to-provision",
      coreReadiness: "useful-ready",
      mutationAuthorized: true,
    });
    expect(result.notices).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "hosting.optional-enhancement-unavailable",
        capability: "search",
      }),
      expect.objectContaining({
        severity: "warning",
        code: "hosting.optional-enhancement-unavailable",
        capability: "tts",
      }),
    ]);
  });

  test("covers credential validation repair, skip, exit, and deterministic noninteractive failure", () => {
    expectOutcome(
      { mode: "tty", credentialSourcesValid: false, invalidCredentialDecision: undefined },
      "needs-input",
      "repair-credentials",
    );
    expectOutcome(
      {
        mode: "tty",
        credentialSourcesValid: false,
        invalidCredentialDecision: "repair-source",
      },
      "needs-input",
      "repair-credentials",
    );
    expectOutcome(
      {
        mode: "tty",
        credentialSourcesValid: false,
        invalidCredentialDecision: "masked-entry",
      },
      "needs-input",
      "repair-credentials",
    );
    expectOutcome(
      {
        mode: "tty",
        credentialSourcesValid: false,
        invalidCredentialDecision: "skip-optional",
        invalidCredentialScope: "optional-only",
      },
      "needs-input",
      "confirm-billable-mutation",
    );
    expectOutcome(
      {
        mode: "tty",
        credentialSourcesValid: false,
        invalidCredentialDecision: "skip-optional",
        invalidCredentialScope: "includes-core",
      },
      "blocked",
      "none",
    );
    expectOutcome(
      { mode: "tty", credentialSourcesValid: false, invalidCredentialDecision: "exit" },
      "cancelled",
      "none",
    );
    expectOutcome({ credentialSourcesValid: false }, "blocked", "none");
  });

  test("blocks missing backend and release but never blocks on cost uncertainty", () => {
    expectOutcome({ backend: undefined }, "blocked", "none");
    expectOutcome({ mode: "tty", backend: undefined }, "needs-input", "choose-backend");
    expectOutcome({ release: "missing" }, "blocked", "none");
    expectOutcome({ release: "invalid" }, "blocked", "none");
    const missingCost = evaluatePreMutationMovement(input({ cost: undefined }));
    expect(missingCost).toMatchObject({
      outcome: "ready-to-provision",
      mutationAuthorized: true,
    });
    expect(missingCost.notices.some((item) =>
      item.severity === "warning" && item.code === "hosting.cost-unavailable",
    )).toBe(true);
  });

  test("models host authorization and all failed-authorization recovery choices", () => {
    expectOutcome(
      { authorization: "pending" },
      "requires-authorization",
      "authorize-host",
    );
    expectOutcome(
      {
        mode: "tty",
        authorization: "failed",
        billableMutationConfirmed: true,
        authorizationFailureDecision: undefined,
      },
      "needs-input",
      "choose-authorization-recovery",
    );
    expectOutcome({ authorization: "failed" }, "blocked", "none");
    expectOutcome(
      { authorization: "failed", authorizationFailureDecision: "retry" },
      "requires-authorization",
      "authorize-host",
    );
    expectOutcome(
      { authorization: "failed", authorizationFailureDecision: "exit" },
      "cancelled",
      "none",
    );
    expectOutcome(
      { authorization: "failed", authorizationFailureDecision: "switch-backend" },
      "blocked",
      "none",
    );
    expectOutcome(
      {
        authorization: "failed",
        authorizationFailureDecision: "switch-backend",
        switchBackendTo: "digitalocean-droplet",
      },
      "requires-replan",
      "restart-backend-plan",
    );
    expect(
      evaluatePreMutationMovement(
        input({
          authorization: "failed",
          authorizationFailureDecision: "switch-backend",
          switchBackendTo: "digitalocean-droplet",
        }),
      ),
    ).toMatchObject({ restartBackend: "digitalocean-droplet", mutationAuthorized: false });
  });

  test("models every incomplete-receipt terminal and recovery path before lifecycle work", () => {
    const receipt = { incompleteReceipt: true } as const;
    expectOutcome(receipt, "requires-receipt-inspection", "inspect-incomplete-receipt");
    expectOutcome(
      { ...receipt, incompleteReceiptInspected: true, mode: "tty" },
      "needs-input",
      "choose-receipt-action",
    );
    expectOutcome({ ...receipt, incompleteReceiptInspected: true }, "blocked", "none");
    expectOutcome(
      { ...receipt, incompleteReceiptInspected: true, incompleteReceiptDecision: "exit" },
      "resources-retained",
      "none",
    );
    expectOutcome(
      { ...receipt, incompleteReceiptInspected: true, incompleteReceiptDecision: "destroy" },
      "ready-to-destroy",
      "destroy-incomplete-receipt",
    );
    const destroy = evaluatePreMutationMovement(
      input({ ...receipt, incompleteReceiptInspected: true, incompleteReceiptDecision: "destroy" }),
    );
    expect(destroy.mutationAuthorized).toBe(false);
    expectOutcome(
      {
        ...receipt,
        incompleteReceiptInspected: true,
        incompleteReceiptDecision: "resume",
        authorization: "pending",
      },
      "requires-authorization",
      "authorize-host",
    );
    expectOutcome(
      {
        ...receipt,
        incompleteReceiptInspected: true,
        incompleteReceiptDecision: "resume",
        authorization: "authorized",
      },
      "ready-to-resume",
      "resume-provisioning",
    );
    const degradedCapabilities = qualifiedCapabilities().map((status) =>
      status.capability === "embeddings"
        ? { ...status, experience: "unavailable" as const, impact: "Embeddings are absent." }
        : status,
    );
    const noStoredConsent = evaluatePreMutationMovement(
      input({
        ...receipt,
        incompleteReceiptInspected: true,
        incompleteReceiptDecision: "resume",
        authorization: "authorized",
        capabilities: degradedCapabilities,
      }),
    );
    const storedConsent = evaluatePreMutationMovement(
      input({
        ...receipt,
        incompleteReceiptInspected: true,
        incompleteReceiptDecision: "resume",
        authorization: "authorized",
        capabilities: degradedCapabilities,
        incompleteReceiptCoreDegradedConsent: true,
      }),
    );
    expect(noStoredConsent).toMatchObject({
      outcome: "blocked",
      coreReadiness: "blocked",
      mutationAuthorized: false,
    });
    const pendingWithoutStoredConsent = evaluatePreMutationMovement(
      input({
        ...receipt,
        incompleteReceiptInspected: true,
        incompleteReceiptDecision: "resume",
        authorization: "pending",
        capabilities: degradedCapabilities,
      }),
    );
    expect(pendingWithoutStoredConsent).toMatchObject({
      outcome: "blocked",
      nextAction: "none",
      coreReadiness: "blocked",
      mutationAuthorized: false,
    });
    expect(storedConsent).toMatchObject({
      outcome: "ready-to-resume",
      coreReadiness: "degraded",
      coreDegradedConsent: true,
      mutationAuthorized: true,
    });
  });

  test("warns on blank payer or estimate without blocking deployment", () => {
    for (const cost of [
      { payer: "   ", estimate: "$20/month" },
      { payer: "customer Railway workspace", estimate: "\t" },
    ]) {
      const result = evaluatePreMutationMovement(input({ cost }));
      expect(result).toMatchObject({ outcome: "ready-to-provision", mutationAuthorized: true });
      expect(result.notices.some((item) =>
        item.severity === "warning" && item.code === "hosting.cost-unavailable",
      )).toBe(true);
    }
  });

  test("does not let invalid input or presentation severity overwrite readiness axes", () => {
    const duplicate = evaluatePreMutationMovement(
      input({ capabilities: [...qualifiedCapabilities(), capability("chat")] }),
    );
    const warning = evaluatePreMutationMovement(
      input({
        capabilities: qualifiedCapabilities().map((status) =>
          status.capability === "tts"
            ? {
                ...status,
                experience: "baseline" as const,
                enhancement: {
                  provider: "elevenlabs" as const,
                  availability: "absent" as const,
                  impact: "Premium voice is unavailable.",
                  repairTarget,
                },
              }
            : status,
        ),
      }),
    );

    expect(duplicate).toMatchObject({
      outcome: "blocked",
      coreReadiness: "blocked",
      infrastructure: "planned",
      mutationAuthorized: false,
    });
    expect(duplicate.notices[0]).toMatchObject({
      severity: "blocking",
      code: "hosting.input-invalid",
    });
    expect(warning).toMatchObject({
      outcome: "ready-to-provision",
      coreReadiness: "useful-ready",
      infrastructure: "planned",
      mutationAuthorized: true,
    });
  });
});
