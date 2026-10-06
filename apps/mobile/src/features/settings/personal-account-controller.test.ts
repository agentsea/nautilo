/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { ProviderCredentialApiError, type CredentialMetadata, type PersonalCostsSummary } from "@nautilo/api-client/browser";

import { createPersonalCostsController, createPersonalCredentialsController, personalCredentialLoadKind, type PersonalAccountApi } from "./personal-account-controller";

const scopeOne = { serverId: "one", userId: "human-one", actorId: "actor-one" };
const scopeTwo = { serverId: "two", userId: "human-two", actorId: "actor-two" };
const credential: CredentialMetadata = {
  provider: "surplus", id: "credential", revision: 1,
  createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z",
  validationStatus: "accepted", validatedAt: "2026-10-05T00:00:00Z",
  requiresReplacement: false, masked: "si-…", destination: "https://api.surplus.ai/v1",
  receiptReadStatus: "unavailable",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function costs(totalCostUsd: number): PersonalCostsSummary {
  return {
    currency: "USD", range: { key: "30d", since: "2026-09-05T00:00:00Z", until: "2026-10-05T00:00:00Z" }, pricingVersion: "v1",
    entry: { available: true, hasPersonalCredentials: true, hasHistory: totalCostUsd > 0 },
    totals: { calls: 1, providerOperations: 0, unknownProviderOperations: 0, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0, actualCostUsd: totalCostUsd, totalCostUsd, pendingAttempts: 0, unknownAttempts: 0, retryableAttempts: 0, blockedAttempts: 0 },
    byModel: [], byCallType: [], byProvider: [], byTask: [], timeSeries: [], recovery: { attempts: [], pendingAttempts: 0, retryableAttempts: 0, blockedAttempts: 0, unknownAttempts: 0 },
  };
}

describe("personal account Settings controllers", () => {
  test("classifies policy, permission, session, and transient credential reads separately", () => {
    expect(personalCredentialLoadKind(new ProviderCredentialApiError(404, "personal_credentials_disabled", false, false, null))).toBe("disabled");
    expect(personalCredentialLoadKind(new ProviderCredentialApiError(403, "personal_credentials_forbidden", false, false, null))).toBe("forbidden");
    expect(personalCredentialLoadKind({ status: 401 })).toBe("signedOut");
    expect(personalCredentialLoadKind({ status: 503 })).toBe("error");
  });

  test("credential writes use the current revision and reload canonical metadata", async () => {
    const calls: unknown[] = [];
    const api: PersonalAccountApi = {
      listProviderCredentials: async () => ({ credentials: [{ ...credential, revision: 2 }], providers: [] }),
      putProviderCredential: async (provider, input) => { calls.push([provider, input]); },
      validateProviderCredential: async () => {}, deleteProviderCredential: async () => {},
      getPersonalCosts: async () => costs(0),
    };
    const controller = createPersonalCredentialsController(() => api);
    controller.setScope(scopeOne);
    await controller.load();
    await controller.save("surplus", " si-secret ", credential);
    expect(calls).toEqual([["surplus", { apiKey: "si-secret", expectedRevision: 1 }]]);
    expect(controller.data.getState().data?.credentials[0]?.revision).toBe(2);
  });

  test("late cost reads cannot cross an account switch", async () => {
    const first = deferred<PersonalCostsSummary>();
    const controller = createPersonalCostsController((scope) => ({
      getPersonalCosts: async () => scope.serverId === "one" ? first.promise : costs(2),
    }));
    controller.setScope(scopeOne);
    const oldLoad = controller.load();
    controller.setScope(scopeTwo);
    await controller.load();
    first.resolve(costs(1));
    expect(await oldLoad).toEqual({ status: "ignored" });
    expect(controller.data.getState().data?.totals.totalCostUsd).toBe(2);
  });
});
