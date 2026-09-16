import { describe, expect, test } from "bun:test";
import { classifyVeniceMediaFailure, sanitizeVeniceProviderCode } from "../../src/media-generation";

describe("Venice media error/refusal classifier", () => {
  test("covers all documented admission validation, account, consent, and refusal conditions", () => {
    expect(classifyVeniceMediaFailure({ phase: "quote", status: 400 })).toMatchObject({ code: "VENICE_INVALID_REQUEST", retrySafe: false, completionCertainty: "not_started", recoveryActions: ["refresh_catalog", "revise_request"] });
    expect(classifyVeniceMediaFailure({ phase: "quote", status: 413 })).toMatchObject({ code: "VENICE_PAYLOAD_TOO_LARGE" });
    expect(classifyVeniceMediaFailure({ phase: "quote", status: 415 })).toMatchObject({ code: "VENICE_UNSUPPORTED_MEDIA" });
    expect(classifyVeniceMediaFailure({ phase: "quote", status: 401 })).toMatchObject({ code: "VENICE_AUTHENTICATION", retrySafe: true, recoveryActions: ["repair_credentials"] });
    expect(classifyVeniceMediaFailure({ phase: "quote", status: 402 })).toMatchObject({ code: "VENICE_BILLING", recoveryActions: ["repair_billing"] });
    const denied = classifyVeniceMediaFailure({ phase: "quote", status: 403 });
    expect(denied).toMatchObject({ code: "VENICE_ACCESS", retrySafe: false });
    expect(denied.message.toLowerCase()).not.toContain("vpn");
    expect(classifyVeniceMediaFailure({ phase: "admission", status: 409, code: "needs_consent" })).toMatchObject({ code: "VENICE_NEEDS_CONSENT", retrySafe: false, recoveryActions: ["provider_consent", "switch_model"] });
    expect(classifyVeniceMediaFailure({ phase: "admission", status: 422, creditsRefunded: true })).toMatchObject({ code: "VENICE_CONTENT_POLICY", retrySafe: false, creditsRefunded: true, chargeCertainty: "refunded", recoveryActions: ["revise_request", "switch_model"] });
  });

  test("allows only safe admission retries before queue acceptance", () => {
    expect(classifyVeniceMediaFailure({ phase: "admission", status: 429 })).toMatchObject({ code: "VENICE_RATE_LIMITED", retrySafe: true, stateChanged: false, recoveryActions: ["wait", "retry_admission"] });
    expect(classifyVeniceMediaFailure({ phase: "admission", status: 503 })).toMatchObject({ code: "VENICE_CAPACITY", retrySafe: true, stateChanged: false, completionCertainty: "not_started", chargeCertainty: "not_charged", recoveryActions: ["wait", "retry_admission"] });
    expect(classifyVeniceMediaFailure({ phase: "admission", transportFailure: true })).toMatchObject({ code: "VENICE_QUEUE_COMPLETION_UNKNOWN", retrySafe: false });
  });

  test("classifies transient quote failures as free and safely retryable", () => {
    for (const input of [
      { phase: "quote" as const, transportFailure: true },
      { phase: "quote" as const, status: 429 },
      { phase: "quote" as const, status: 500 },
      { phase: "quote" as const, status: 503 },
    ]) {
      expect(classifyVeniceMediaFailure(input)).toMatchObject({
        retrySafe: true,
        stateChanged: false,
        completionCertainty: "not_started",
        chargeCertainty: "not_charged",
        recoveryActions: ["wait"],
      });
    }
  });

  test("retries an accepted receipt rather than queueing again for retrieve/download and local failures", () => {
    for (const phase of ["retrieve", "download"] as const) {
      expect(classifyVeniceMediaFailure({ phase, status: 503, acceptedReceipt: true })).toMatchObject({ retrySafe: true, stateChanged: true, completionCertainty: "accepted", chargeCertainty: "charged_or_committed" });
    }
    expect(classifyVeniceMediaFailure({ phase: "persistence" })).toMatchObject({ recoveryActions: ["retry_persistence"], retrySafe: true });
    expect(classifyVeniceMediaFailure({ phase: "cleanup" })).toMatchObject({ recoveryActions: ["retry_cleanup"], retrySafe: true });
    expect(classifyVeniceMediaFailure({ phase: "retrieve", status: 404, acceptedReceipt: true })).toMatchObject({ code: "VENICE_MEDIA_EXPIRED", retrySafe: false, recoveryActions: ["start_new_generation"] });
  });

  test("keeps accepted work fenced when a provider delivery URL fails server-side SSRF policy", () => {
    expect(classifyVeniceMediaFailure({ phase: "download", acceptedReceipt: true, unsafeDeliveryUrl: true })).toMatchObject({
      code: "VENICE_SIGNED_DELIVERY_REJECTED",
      retrySafe: false,
      stateChanged: true,
      completionCertainty: "accepted",
      chargeCertainty: "charged_or_committed",
      recoveryActions: ["contact_support"],
    });
  });

  test("never lets unknown codes, URLs, echoed prompts, or raw bodies become public codes/messages", () => {
    expect(sanitizeVeniceProviderCode("needs_consent")).toBe("needs_consent");
    expect(sanitizeVeniceProviderCode("https://provider.example/?token=secret&prompt=private lyrics")).toBeUndefined();
    const unknown = classifyVeniceMediaFailure({ phase: "quote", status: 418, code: "prompt=private lyrics https://secret.example" });
    expect(unknown.code).toBe("VENICE_418");
    expect(unknown.message).not.toContain("private");
    expect(unknown.message).not.toContain("https://");
  });
});
