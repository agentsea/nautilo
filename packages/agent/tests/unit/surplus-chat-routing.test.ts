import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import * as db from "@nautilo/db";
import * as credentials from "../../src/chat/model-runtime-credentials";
import * as eligible from "../../src/config/eligible-models";
import * as keys from "../../src/resolve-provider-key";
import * as surplusAttempt from "../../src/providers/surplus-attempt";
import * as surplusRoutes from "../../src/providers/surplus-route";
import * as universal from "../../src/providers/universal";
import { PersonalDirectFundingUnavailableError, type ForegroundChatFundingSession } from "../../src/runtime/foreground-chat-funding";
import { invokeChatModelWithFallback } from "../../src/utils/chat-model-invocation";

const MODEL = "openrouter:anthropic/claude-sonnet-4.6";
const reply = new AIMessage({ content: "Synthetic answer", response_metadata: { finish_reason: "stop" } });
const restore: (() => void)[] = [];
afterEach(() => { for (const undo of restore.splice(0).reverse()) undo(); });

function harness(options: {
  directKey?: boolean;
  personal?: boolean;
  allowBroadening?: boolean;
  failure?: Error;
  recheckError?: Error;
  recoveryError?: Error;
  noPersonalRecovery?: boolean;
  retryUnpinned?: boolean;
} = {}) {
  const retain = eligible.resolveRetainedModels;
  const retained = spyOn(eligible, "resolveRetainedModels").mockImplementation((ids, opts) => retain(ids, { ...opts, env: {} }));
  const refresh = spyOn(db, "kickServerModelConfigRefresh").mockImplementation(() => {});
  const config = spyOn(db, "getCachedServerModelConfigRow").mockReturnValue({ preferSurplus: true } as ReturnType<typeof db.getCachedServerModelConfigRow>);
  const key = spyOn(keys, "resolveProviderKey").mockImplementation(provider => provider === "surplus" ? "synthetic-server-surplus" : null);
  const runnable = spyOn(credentials, "modelHasRunnableCredentials").mockReturnValue(options.directKey === true);
  const attempts: surplusAttempt.SurplusChatAttemptInput[] = [];
  const marketplace = spyOn(surplusAttempt, "invokeSurplusChatAttempt").mockImplementation(async input => {
    attempts.push(input);
    await input.assertStillAuthorized?.();
    return options.failure
      ? { kind: "direct_fallback", failure: options.failure, ...(options.retryUnpinned ? { retryUnpinned: true } : {}) }
      : { kind: "served", response: reply };
  });
  const direct = spyOn(universal, "createUniversalModel").mockImplementation(async () => {
    const bound = { invoke: async () => reply };
    return { ...bound, bindTools: () => bound } as Awaited<ReturnType<typeof universal.createUniversalModel>>;
  });
  restore.push(...[retained, refresh, config, key, runnable, marketplace, direct].map(mock => () => mock.mockRestore()));
  const rechecks: (string | undefined)[] = [];
  const admissions: (string | undefined)[] = [];
  const session: ForegroundChatFundingSession = {
    kind: options.personal ? "personal" : "server",
    ...(options.allowBroadening !== false ? { allowUnpinnedSurplusRetry: true as const } : {}),
    async recheckAttempt(_model, transport) {
      rechecks.push(transport);
      if (options.recheckError) throw options.recheckError;
    },
    async runAttempt(_model, run, transport) {
      admissions.push(transport);
      if (transport === "direct" && !options.directKey) {
        throw Object.assign(new Error("No direct credential"), { code: "provider_credentials_missing" });
      }
      return run(options.personal ? {
        usageFunding: { kind: "personal", providerRoute: "surplus", humanUserId: "human", payerHumanId: "human", credentialId: "credential", credentialRevision: 1 },
        personalCredential: { apiKey: "synthetic-personal-surplus" },
      } : { usageFunding: { kind: "server", humanUserId: "human", providerRoute: transport === "direct" ? "openrouter" : "surplus" } });
    },
    ...(!options.noPersonalRecovery ? {
      async openPersonalRecovery() { throw options.recoveryError ?? new PersonalDirectFundingUnavailableError(); },
    } : {}),
  };
  const invoke = (model = MODEL, maxOutputTokens?: number) => invokeChatModelWithFallback(
    [new HumanMessage("Synthetic routing check")], [], model, "", null, "synthetic-route", {},
    { fundingSession: session, modelFallbackMode: "none", sameModelRetryMode: "none", ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) },
  );
  return { attempts, direct, invoke, rechecks, admissions };
}

describe("Surplus chat request envelope and recovery", () => {
  test("ordinary Surplus-only server chat starts with any seller and the qualified output budget", async () => {
    const h = harness();
    expect((await h.invoke()).response).toBe(reply);
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]).toMatchObject({ providerMode: "any", maxOutputTokens: 64_000, funding: { kind: "server", providerRoute: "surplus" } });
    expect(h.rechecks).toEqual(["surplus"]);
    expect(h.direct).not.toHaveBeenCalled();
  });

  test("an explicit smaller request budget remains smaller", async () => {
    const h = harness();
    await h.invoke(MODEL, 1_024);
    expect(h.attempts[0]?.maxOutputTokens).toBe(1_024);
  });

  test("a matching server direct credential retains the pinned first attempt", async () => {
    const h = harness({ directKey: true });
    await h.invoke();
    expect(h.attempts[0]?.providerMode).toBeUndefined();
    expect(h.rechecks).toEqual([]);
  });

  test("a protected operation cannot broaden its seller selection", async () => {
    const h = harness({ allowBroadening: false });
    await h.invoke();
    expect(h.attempts[0]?.providerMode).toBeUndefined();
  });

  test("provider-bound privacy models retain their seller pin", async () => {
    const h = harness();
    await h.invoke("venice:claude-sonnet-4-6");
    expect(h.attempts[0]?.providerMode).toBeUndefined();
    expect(h.attempts[0]?.route.providerPin).toBe("venice");
  });

  test("personal routing does not infer the payer's direct keys from the server environment", async () => {
    const h = harness({ personal: true });
    await h.invoke();
    expect(h.attempts[0]).toMatchObject({ apiKey: "synthetic-personal-surplus", funding: { kind: "personal" } });
    expect(h.attempts[0]?.providerMode).toBeUndefined();
  });

  test.each([false, true])("unavailable optional recovery preserves the original failure (no personal recovery=%s)", async noPersonalRecovery => {
    const original = Object.assign(new Error("Surplus could not serve the model"), { code: "no_healthy_sellers", status: 503 });
    const h = harness({ failure: original, noPersonalRecovery, retryUnpinned: true });
    expect(await h.invoke().catch((error: unknown) => error)).toBe(original);
    expect(h.attempts).toHaveLength(1);
    expect(h.direct).not.toHaveBeenCalled();
    expect(h.admissions).toEqual([undefined, "direct"]);
  });

  test.each([
    "personal_credentials_disabled", "personal_credentials_forbidden", "server_credentials_forbidden",
    "funding_source_changed", "personal_credential_stale", "personal_credential_unavailable", "credential_custody_unavailable",
  ])("%s during recovery remains terminal", async code => {
    const denied = Object.assign(new Error(code), { code });
    const h = harness({ failure: new Error("Marketplace unavailable"), recoveryError: denied });
    expect(await h.invoke().catch((error: unknown) => error)).toBe(denied);
    expect(h.direct).not.toHaveBeenCalled();
  });

  test("an absent server-first personal recovery key retains the marketplace failure", async () => {
    const original = Object.assign(new Error("Surplus unavailable"), { status: 503 });
    const missing = Object.assign(new Error("No personal credential"), { code: "personal_credential_missing" });
    const h = harness({ failure: original, recoveryError: missing });
    expect(await h.invoke().catch((error: unknown) => error)).toBe(original);
    expect(h.direct).not.toHaveBeenCalled();
  });

  test("post-admission funding recheck failure prevents provider dispatch and recovery", async () => {
    const denied = new Error("Funding permission changed");
    const h = harness({ recheckError: denied });
    expect(await h.invoke().catch((error: unknown) => error)).toBe(denied);
    expect(h.admissions).toEqual([undefined]);
    expect(h.direct).not.toHaveBeenCalled();
  });

  test("revoked seller-broadening authority prevents provider dispatch and recovery", async () => {
    const h = harness();
    let checks = 0;
    const broadening = spyOn(surplusRoutes, "canBroadenSurplusModelRoute").mockImplementation(() => ++checks <= 2);
    restore.push(() => broadening.mockRestore());
    const error = await h.invoke().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("seller broadening is no longer authorized");
    expect(h.direct).not.toHaveBeenCalled();
  });

  test("Surplus-specific output limits do not lower a direct recovery budget", async () => {
    const h = harness({ directKey: true, allowBroadening: false, failure: new Error("Surplus unavailable") });
    expect((await h.invoke()).response).toBe(reply);
    expect(h.attempts[0]?.maxOutputTokens).toBe(64_000);
    expect(h.direct).toHaveBeenCalledWith(MODEL, expect.objectContaining({ maxTokens: 128_000 }));
  });

  test("a direct provider failure cannot masquerade as an absent recovery key", async () => {
    const h = harness({ directKey: true, failure: new Error("Marketplace failed") });
    const providerFailure = Object.assign(new Error("Direct provider rejected the request"), { code: "personal_credential_missing" });
    h.direct.mockImplementation(async () => {
      const bound = { invoke: async () => { throw providerFailure; } };
      return { ...bound, bindTools: () => bound } as Awaited<ReturnType<typeof universal.createUniversalModel>>;
    });
    expect(await h.invoke().catch((error: unknown) => error)).toBe(providerFailure);
  });
});
