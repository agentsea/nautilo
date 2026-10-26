import { describe, expect, test } from "bun:test";
import { resolveCatalogModel } from "@nautilo/agent";
import type { EligibleModel } from "@nautilo/trust";
import {
  resolveCallerImageInput,
  openImageAssistance,
  selectCallerImageAssistance,
  type ImageAssistanceExecutionDeps,
} from "../../src/lib/image-assistance";
import { ModelFundingError, type ModelFundingDecision } from "../../src/lib/model-funding";

const HUMAN = "synthetic-human";
const base = resolveCatalogModel("anthropic:claude-sonnet-4-6", { env: {} });
function model(id: string): EligibleModel {
  return {
    id, displayName: id, provider: "openai", priority: 1, costCoefficient: 1,
    enabled: false, availability: "missing-key",
    capabilities: { tools: false, vision: true, reasoning: false, e2ee: false, webSearch: false },
  };
}
function decision(modelId: string, kind: "server" | "personal" = "personal"): ModelFundingDecision {
  const fields = { humanUserId: HUMAN, modelId, providerRoute: "openai", workload: "image_assistance" as const };
  return kind === "server" ? { ...fields, kind }
    : { ...fields, kind, payerHumanId: HUMAN, credentialId: "00000000-0000-4000-8000-000000000001", credentialRevision: 1 };
}
function harness(ids: string[], costs: Record<string, number> = {}) {
  const calls: Array<{ modelId: string; fundingKind?: string }> = [];
  const unavailable = new Set<string>();
  const filtered = new Set<string>();
  const textOnly = new Set<string>(["openai:main", "openai:other-main"]);
  const encrypted = new Set<string>();
  const deps: ImageAssistanceExecutionDeps = {
    commitInput: (_jobId, digest) => `hmac-sha256:${digest}`,
    readPreferences: async () => ({ revision: 0, overrides: {} }),
    getServerSelection: () => null,
    listModels: () => ids.map(model),
    resolveCatalog: (id) => ({
      ...base, id, availability: filtered.has(id) ? "routing_filtered" : "missing_credentials",
      input: textOnly.has(id) ? ["text"] : ["text", "image"],
      features: { ...base.features, tools: false, e2ee: encrypted.has(id) },
    }),
    resolvePrice: (id) => ({ price: { inputPerMtok: costs[id] ?? 1, outputPerMtok: costs[id] ?? 1 }, source: "catalog_coefficient" }),
    resolveFunding: async (input) => {
      calls.push(input);
      if (unavailable.has(input.modelId)) throw new ModelFundingError("personal_credential_missing");
      return decision(input.modelId, input.fundingKind);
    },
  };
  return { deps, calls, unavailable, filtered, textOnly, encrypted };
}

describe("automatic caller image selection", () => {
  test("selects inexpensive image/text routes without requiring tools or a fixed shortlist", async () => {
    const h = harness(["openai:new-vision", "openai:costly", "openai:cheap"], {
      "openai:new-vision": 2, "openai:costly": 8, "openai:cheap": 1,
    });
    h.unavailable.add("openai:cheap");
    expect(await selectCallerImageAssistance({ humanUserId: HUMAN, fundingKind: "personal", mainModelId: "openai:main" }, h.deps))
      .toMatchObject({ modelId: "openai:new-vision", kind: "personal" });
    expect(h.calls.map((call) => call.modelId)).toEqual(["openai:cheap", "openai:new-vision"]);
    expect(h.calls[0]).toMatchObject({ workload: "image_assistance", fundingKind: "personal" });
  });

  test("breaks equal estimated cost ties deterministically and never ranks unknown prices as free", async () => {
    const h = harness(["openai:z", "openai:unknown", "openai:a"], { "openai:unknown": Number.NaN });
    expect(await selectCallerImageAssistance({ humanUserId: HUMAN, fundingKind: "personal" }, h.deps))
      .toMatchObject({ modelId: "openai:a" });
  });

  test("preserves native personal vision without an auxiliary invocation", async () => {
    const h = harness(["openai:vision"]);
    expect(await resolveCallerImageInput({ humanUserId: HUMAN, modelId: "openai:vision",
      funding: decision("openai:vision") }, h.deps)).toBe("direct");
    expect(h.calls).toEqual([]);
  });

  test("a native vision model with an unqualified marketplace image route cannot advertise assistance", async () => {
    const h = harness(["openai:vision"]);
    const hydrated: string[][] = [];
    const deps = { ...h.deps, hydrateSurplusChatCatalog: async (input: {
      readonly catalogModelIds?: readonly string[];
    } = {}) => { hydrated.push([...(input.catalogModelIds ?? [])]); } };
    expect(await resolveCallerImageInput({ humanUserId: HUMAN, modelId: "openai:vision",
      funding: { ...decision("openai:vision"), providerRoute: "surplus" } }, deps)).toBe("unavailable");
    expect(hydrated).toEqual([["openai:vision"]]);
    expect(h.calls).toEqual([]);
  });

  test("projects assistance for text-only main and unavailable when no authorized route exists", async () => {
    const h = harness(["openai:vision"]);
    const input = { humanUserId: HUMAN, modelId: "openai:main", funding: decision("openai:main") };
    expect(await resolveCallerImageInput(input, h.deps)).toBe("assisted");
    h.unavailable.add("openai:vision");
    expect(await resolveCallerImageInput(input, h.deps)).toBe("unavailable");
  });

  test("rechecks catalog/key eligibility on a fresh operation and preserves E2EE privacy", async () => {
    const h = harness(["openai:cheap", "openai:encrypted"], { "openai:cheap": 1, "openai:encrypted": 2 });
    h.encrypted.add("openai:main");
    h.encrypted.add("openai:encrypted");
    const input = { humanUserId: HUMAN, fundingKind: "personal" as const, mainModelId: "openai:main" };
    expect(await selectCallerImageAssistance(input, h.deps)).toMatchObject({ modelId: "openai:encrypted" });
    h.filtered.add("openai:encrypted");
    expect(await selectCallerImageAssistance(input, h.deps)).toBeNull();
    h.filtered.add("openai:main");
    expect(await selectCallerImageAssistance(input, h.deps)).toBeNull();
  });

  test("one catalog response shares its same-payer privacy selection instead of scanning per model", async () => {
    const h = harness(["openai:vision"]);
    const deps = { ...h.deps, selectionCache: new Map<string, Promise<ModelFundingDecision | null>>() };
    const inputs = ["openai:main", "openai:other-main"].map((modelId) => ({
      humanUserId: HUMAN, fundingKind: "personal" as const, mainModelId: modelId,
    }));
    await Promise.all(inputs.map((input) => selectCallerImageAssistance(input, deps)));
    expect(h.calls).toHaveLength(1);
    await selectCallerImageAssistance(inputs[0]!, h.deps);
    expect(h.calls).toHaveLength(2);
  });

  test("an unsupported local main cannot acquire a hosted image helper", async () => {
    const h = harness(["openai:vision"]);
    const resolve = h.deps.resolveCatalog!;
    const selected = await selectCallerImageAssistance({
      humanUserId: HUMAN, fundingKind: "personal", mainModelId: "local:private-model",
    }, { ...h.deps, resolveCatalog: (id) => id.startsWith("local:")
      ? resolveCatalogModel(id, { env: {} }) : resolve(id) });
    expect(selected).toBeNull();
    expect(h.calls).toEqual([]);
  });

  test("personal execution remains tool-free and rechecks current Room invocation authority before credential access", async () => {
    const h = harness(["openai:vision"]);
    let ownRoom = true;
    let decrypted = 0;
    let invoked = 0;
    const session = await openImageAssistance({
      humanUserId: HUMAN, modelId: "openai:main", roomId: "synthetic-room", agentId: "synthetic-agent",
      entrypoint: "foreground.main", fundingKind: "personal", jobId: "job-main", turnId: "turn-main", inputDigest: "a".repeat(64),
    }, {
      ...h.deps,
      assertRoomAuthority: async () => { if (!ownRoom) throw new ModelFundingError("unsupported_workload"); },
      readAdmission: async () => null, pinAdmission: async (_identity, value) => value, assertReplaySafe: async () => {}, claimDispatch: async () => true,
      withCredential: async (_decision, useKey) => { decrypted++; return useKey("synthetic-key"); },
    });
    expect(session?.fundingSession.personalTaskControls).toBeUndefined();
    expect(await session!.fundingSession.runAttempt("openai:vision", async (attempt) => {
      invoked++;
      return attempt.usageFunding;
    })).toMatchObject({ kind: "personal", humanUserId: HUMAN, payerHumanId: HUMAN });
    expect(decrypted).toBe(1);
    ownRoom = false;
    const roomError = await session!.fundingSession.runAttempt("openai:vision", async () => { invoked++; })
      .then(() => null, (error: unknown) => error);
    expect(roomError).toMatchObject({ code: "unsupported_workload" });
    expect(decrypted).toBe(1);
    expect(invoked).toBe(1);
  });

  test("a filtered selected route or changed credential cannot spend or select another payer", async () => {
    const h = harness(["openai:vision"]);
    let stale = false;
    let invoked = 0;
    const resolveFunding = h.deps.resolveFunding!;
    const session = await openImageAssistance({
      humanUserId: HUMAN, modelId: "openai:main", roomId: "synthetic-room", agentId: "synthetic-agent",
      entrypoint: "foreground.fork", fundingKind: "personal", jobId: "job-fork", turnId: "turn-fork", inputDigest: "b".repeat(64),
    }, {
      ...h.deps,
      assertRoomAuthority: async () => undefined,
      readAdmission: async () => null, pinAdmission: async (_identity, value) => value, assertReplaySafe: async () => {}, claimDispatch: async () => true,
      resolveFunding: async (input) => {
        if (stale && input.priorDecision) throw new ModelFundingError("personal_credential_stale");
        return resolveFunding(input);
      },
      withCredential: async (_decision, useKey) => useKey("synthetic-key"),
    });
    stale = true;
    const credentialError = await session!.fundingSession.runAttempt("openai:vision", async () => { invoked++; })
      .then(() => null, (error: unknown) => error);
    expect(credentialError).toMatchObject({ code: "personal_credential_stale" });
    stale = false;
    h.filtered.add("openai:vision");
    const routeError = await session!.fundingSession.runAttempt("openai:vision", async () => { invoked++; })
      .then(() => null, (error: unknown) => error);
    expect(routeError).toMatchObject({ code: "unsupported_workload" });
    expect(invoked).toBe(0);
    expect(h.calls.every((call) => call.fundingKind === "personal")).toBe(true);
  });
});

const invocation = {
  humanUserId: HUMAN, modelId: "openai:main", roomId: "synthetic-room", agentId: "synthetic-agent",
  entrypoint: "foreground.main" as const, fundingKind: "personal" as const,
  jobId: "job-admitted", turnId: "turn-admitted", inputDigest: "c".repeat(64),
};

describe("durable helper admission", () => {
  test("retains the first model and preference across a settings edit, then blocks duplicate dispatch", async () => {
    const h = harness(["openai:vision", "openai:new-vision"]);
    let preference = { revision: 1, overrides: { imageUnderstanding: "openai:vision" } };
    let retained: import("@nautilo/types").ImageAssistanceAdmission | null = null;
    let claims = 0;
    const deps = {
      ...h.deps, readPreferences: async () => preference,
      assertRoomAuthority: async () => undefined,
      readAdmission: async () => retained,
      pinAdmission: async (_identity: unknown, value: import("@nautilo/types").ImageAssistanceAdmission) => retained ??= value,
      assertReplaySafe: async () => {},
      claimDispatch: async () => {
        claims++;
        if (retained?.state !== "admitted") return false;
        retained = { ...retained, state: "dispatched" };
        return true;
      },
      withCredential: async (_binding: unknown, useKey: (value: string) => unknown) => useKey("synthetic-key"),
    };
    await openImageAssistance(invocation, deps as never);
    preference = { revision: 2, overrides: { imageUnderstanding: "openai:new-vision" } };
    const resumed = await openImageAssistance(invocation, deps as never);
    expect(resumed).toMatchObject({ modelId: "openai:vision", preferenceRevision: 1, operationId: "image-assistance:job-admitted" });
    const competing = await openImageAssistance(invocation, deps as never);
    expect(await resumed!.fundingSession.runAttempt("openai:vision", async () => "answer")).toBe("answer");
    expect(await competing!.fundingSession.runAttempt("openai:vision", async () => "duplicate")
      .then(() => null, (error: unknown) => error)).toMatchObject({ code: "funding_source_changed" });
    expect(await openImageAssistance(invocation, deps as never)
      .then(() => null, (error: unknown) => error)).toMatchObject({ code: "funding_source_changed" });
    expect(claims).toBe(2);
  });

  test("one dispatch claim covers Surplus then exact same-payer direct fallback", async () => {
    const h = harness(["openai:vision"]);
    const calls: Array<{ transport?: string; priorDecision?: ModelFundingDecision }> = [];
    const marketplace = { ...decision("openai:vision"), providerRoute: "surplus" } as ModelFundingDecision;
    let claims = 0;
    const session = await openImageAssistance(invocation, {
      ...h.deps, assertRoomAuthority: async () => undefined,
      readAdmission: async () => null, pinAdmission: async (_identity, value) => value,
      assertReplaySafe: async () => {},
      claimDispatch: async () => { claims++; return true; },
      resolveFunding: async (input) => { calls.push(input); return input.transport === "direct" ? decision(input.modelId) : marketplace; },
      withCredential: async (binding, useKey) => useKey(binding.providerRoute === "surplus" ? "marketplace-key" : "direct-key"),
    });
    expect(await session!.fundingSession.runAttempt("openai:vision", async (attempt) => attempt.personalCredential?.apiKey)).toBe("marketplace-key");
    expect(await session!.fundingSession.runAttempt("openai:vision", async (attempt) => attempt.personalCredential?.apiKey, "direct")).toBe("direct-key");
    expect(calls.slice(1).map((call) => call.transport)).toEqual(["surplus", "direct"]);
    expect(calls.slice(1).every((call) => call.priorDecision?.providerRoute === "surplus")).toBe(true);
    expect(claims).toBe(1);
    expect(await session!.fundingSession.runAttempt("openai:new-model", async () => "bad", "direct")
      .then(() => null, (error: unknown) => error)).toMatchObject({ code: "unsupported_workload" });
  });

  test("a direct admitted helper cannot acquire Surplus after policy changes", async () => {
    const h = harness(["openai:vision"]);
    const session = await openImageAssistance(invocation, {
      ...h.deps, assertRoomAuthority: async () => undefined,
      readAdmission: async () => null, pinAdmission: async (_identity, value) => value,
      assertReplaySafe: async () => {},
      claimDispatch: async () => true,
      withCredential: async (_binding, useKey) => useKey("direct-key"),
    });
    expect(await session!.fundingSession.runAttempt("openai:vision", async () => "bad", "surplus")
      .then(() => null, (error: unknown) => error)).toMatchObject({ code: "funding_source_changed" });
  });
});
