/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { ProviderCredentialApiError, type CredentialMetadata, type PersonalCostsSummary } from "@nautilo/api-client/browser";

import { createPersonalCostsController, createPersonalCredentialsController, personalAccountErrorMessage, personalCredentialLoadKind, type PersonalAccountApi } from "./personal-account-controller";

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

function costs(totalCostUsd: number, range: PersonalCostsSummary["range"]["key"] = "30d"): PersonalCostsSummary {
  return {
    currency: "USD", range: { key: range, since: "2026-09-05T00:00:00Z", until: "2026-10-05T00:00:00Z" }, pricingVersion: "v1",
    entry: { available: true, hasPersonalCredentials: true, hasHistory: totalCostUsd > 0 },
    totals: { calls: 1, providerOperations: 0, unknownProviderOperations: 0, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0, actualCostUsd: totalCostUsd, totalCostUsd, pendingAttempts: 0, unknownAttempts: 0, retryableAttempts: 0, blockedAttempts: 0 },
    byModel: [], byCallType: [], byProvider: [], byTask: [], timeSeries: [], recovery: { attempts: [], pendingAttempts: 0, retryableAttempts: 0, blockedAttempts: 0, unknownAttempts: 0 },
  };
}

describe("personal account Settings controllers", () => {
  test("classifies policy, permission, session, and transient credential reads separately", () => {
    const disabled = new ProviderCredentialApiError(404, "personal_credentials_disabled", false, false, null);
    expect(personalCredentialLoadKind(disabled)).toBe("disabled");
    expect(personalAccountErrorMessage(disabled)).toBe("Personal API keys are disabled on this server.");
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

  test("denies save and validation locally when the loaded policy is off", async () => {
    const calls: string[] = [];
    const api: PersonalAccountApi = {
      listProviderCredentials: async () => ({ allowPersonalProviderKeys: false, credentials: [credential], providers: [] }),
      putProviderCredential: async () => { calls.push("save"); },
      validateProviderCredential: async () => { calls.push("validate"); },
      deleteProviderCredential: async () => { calls.push("delete"); },
      getPersonalCosts: async () => costs(0),
    };
    const controller = createPersonalCredentialsController(() => api);
    controller.setScope(scopeOne);

    expect(await controller.save("surplus", "si-secret", credential)).toEqual({ status: "ignored" });
    expect(await controller.validate("surplus", credential)).toEqual({ status: "ignored" });
    expect(await controller.remove("surplus", credential)).toEqual({ status: "ignored" });
    await controller.load();

    expect(await controller.save("surplus", "si-secret", credential)).toEqual({ status: "ignored" });
    expect(await controller.validate("surplus", credential)).toEqual({ status: "ignored" });
    expect(calls).toEqual([]);
  });

  test("deletes a stored key by revision while policy is off and reloads the compact state", async () => {
    const calls: unknown[] = [];
    let reads = 0;
    const api: PersonalAccountApi = {
      listProviderCredentials: async () => ({
        allowPersonalProviderKeys: false,
        credentials: reads++ === 0 ? [credential] : [],
        providers: [],
      }),
      putProviderCredential: async () => {},
      validateProviderCredential: async () => {},
      deleteProviderCredential: async (provider, input) => { calls.push([provider, input]); },
      getPersonalCosts: async () => costs(0),
    };
    const controller = createPersonalCredentialsController(() => api);
    controller.setScope(scopeOne);
    await controller.load();

    expect(await controller.remove("surplus", credential)).toMatchObject({ status: "applied" });
    expect(calls).toEqual([["surplus", { expectedRevision: 1 }]]);
    expect(controller.data.getState().data).toEqual({
      allowPersonalProviderKeys: false,
      credentials: [],
      providers: [],
    });
  });

  test("rereads a delete conflict without replaying and retries with the refreshed revision", async () => {
    const deleteInputs: unknown[] = [];
    let reads = 0;
    let deletes = 0;
    const api: PersonalAccountApi = {
      listProviderCredentials: async () => ({
        allowPersonalProviderKeys: false,
        credentials: reads++ < 2 ? [{ ...credential, revision: reads === 1 ? 4 : 5 }] : [],
        providers: [],
      }),
      putProviderCredential: async () => {},
      validateProviderCredential: async () => {},
      deleteProviderCredential: async (_provider, input) => {
        deleteInputs.push(input);
        if (deletes++ === 0) {
          throw new ProviderCredentialApiError(409, "credential_conflict", false, false, "reread_metadata");
        }
      },
      getPersonalCosts: async () => costs(0),
    };
    const controller = createPersonalCredentialsController(() => api);
    controller.setScope(scopeOne);
    await controller.load();

    expect(await controller.remove("surplus", { ...credential, revision: 4 })).toMatchObject({ status: "failed" });
    expect(deleteInputs).toEqual([{ expectedRevision: 4 }]);
    expect(controller.data.getState().data?.credentials[0]?.revision).toBe(5);
    expect(personalAccountErrorMessage(controller.data.getState().mutationError)).toBe("This key changed elsewhere. Try again after current key details have loaded.");

    const refreshed = controller.data.getState().data?.credentials[0];
    if (!refreshed) throw new Error("Expected refreshed credential metadata");
    expect(await controller.remove("surplus", refreshed)).toMatchObject({ status: "applied" });
    expect(deleteInputs).toEqual([{ expectedRevision: 4 }, { expectedRevision: 5 }]);
    expect(controller.data.getState().data?.credentials).toEqual([]);
  });

  test("rereads a missing delete target and leaves canonical disappearance inert", async () => {
    let reads = 0;
    const api: PersonalAccountApi = {
      listProviderCredentials: async () => ({
        allowPersonalProviderKeys: false,
        credentials: reads++ === 0 ? [{ ...credential, revision: 4 }] : [],
        providers: [],
      }),
      putProviderCredential: async () => {},
      validateProviderCredential: async () => {},
      deleteProviderCredential: async () => { throw new ProviderCredentialApiError(404, "credential_not_found", false, false, null); },
      getPersonalCosts: async () => costs(0),
    };
    const controller = createPersonalCredentialsController(() => api);
    controller.setScope(scopeOne);
    await controller.load();

    expect(await controller.remove("surplus", { ...credential, revision: 4 })).toMatchObject({ status: "failed" });
    expect(controller.data.getState().data?.credentials).toEqual([]);
    expect(personalAccountErrorMessage(controller.data.getState().mutationError)).toBe("This key no longer exists.");
  });

  test("keeps delete conflict and reload errors visible when reconciliation fails", async () => {
    let reads = 0;
    const api: PersonalAccountApi = {
      listProviderCredentials: async () => {
        if (reads++ > 0) throw new Error("reload failed");
        return { allowPersonalProviderKeys: false, credentials: [{ ...credential, revision: 4 }], providers: [] };
      },
      putProviderCredential: async () => {},
      validateProviderCredential: async () => {},
      deleteProviderCredential: async () => { throw new ProviderCredentialApiError(409, "credential_conflict", false, false, "reread_metadata"); },
      getPersonalCosts: async () => costs(0),
    };
    const controller = createPersonalCredentialsController(() => api);
    controller.setScope(scopeOne);
    await controller.load();

    expect(await controller.remove("surplus", { ...credential, revision: 4 })).toMatchObject({ status: "failed" });
    expect(controller.data.getState().data?.credentials[0]?.revision).toBe(4);
    expect(controller.data.getState().loadError?.message).toBe("reload failed");
    expect(await controller.remove("surplus", { ...credential, revision: 4 })).toEqual({ status: "ignored" });
    expect(personalAccountErrorMessage(controller.data.getState().mutationError)).toBe("This key changed elsewhere. Try again after current key details have loaded.");
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

  test("keeps a failed range request authoritative through retry", async () => {
    const requested: string[] = [];
    let failSevenDays = true;
    const controller = createPersonalCostsController(() => ({
      getPersonalCosts: async (range) => {
        requested.push(range);
        if (range === "7d" && failSevenDays) {
          failSevenDays = false;
          throw new Error("offline");
        }
        return costs(range === "7d" ? 7 : 30, range);
      },
    }));
    controller.setScope(scopeOne);

    await controller.load();
    expect(controller.data.getState().data?.range.key).toBe("30d");
    expect(await controller.setRange("7d")).toMatchObject({ status: "failed" });
    expect(controller.data.getState().draft).toEqual({ range: "7d" });
    expect(controller.data.getState().data?.range.key).toBe("30d");

    expect(await controller.retry()).toMatchObject({ status: "applied" });
    expect(controller.data.getState().data?.range.key).toBe("7d");
    expect(requested).toEqual(["30d", "7d", "7d"]);
  });

  test("resets the requested cost range when identity scope changes", async () => {
    const requested: Array<[string, string]> = [];
    const controller = createPersonalCostsController((scope) => ({
      getPersonalCosts: async (range) => {
        requested.push([scope.serverId, range]);
        return costs(scope.serverId === "one" ? 1 : 2, range);
      },
    }));
    controller.setScope(scopeOne);
    await controller.setRange("7d");
    controller.setScope(scopeTwo);

    expect(controller.data.getState().draft).toBeNull();
    await controller.load();
    expect(controller.data.getState().data?.range.key).toBe("30d");
    expect(requested).toEqual([["one", "7d"], ["two", "30d"]]);
  });
});
