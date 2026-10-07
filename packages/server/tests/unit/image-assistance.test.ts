import { describe, expect, test } from "bun:test";
import { resolveCatalogModel } from "@nautilo/agent";
import type { EligibleModel } from "@nautilo/trust";
import {
  resolveCallerImageInput,
  openImageAssistance,
  selectCallerImageAssistance,
  type ImageAssistanceSelectionDeps,
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
    : { ...fields, kind, payerHumanId: HUMAN, credentialId: "synthetic-credential", credentialRevision: 1 };
}
function harness(ids: string[], costs: Record<string, number> = {}) {
  const calls: Array<{ modelId: string; fundingKind?: string }> = [];
  const unavailable = new Set<string>();
  const filtered = new Set<string>();
  const textOnly = new Set<string>(["openai:main", "openai:other-main"]);
  const encrypted = new Set<string>();
  const deps: ImageAssistanceSelectionDeps = {
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
    expect(h.calls[0]).toMatchObject({ workload: "image_assistance", transport: "direct", fundingKind: "personal" });
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
    expect(await resolveCallerImageInput({ humanUserId: HUMAN, modelId: "openai:vision",
      funding: { ...decision("openai:vision"), providerRoute: "surplus" } }, h.deps)).toBe("unavailable");
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

  test("personal execution remains tool-free and rechecks exact Room ownership before credential access", async () => {
    const h = harness(["openai:vision"]);
    let ownRoom = true;
    let decrypted = 0;
    let invoked = 0;
    const session = await openImageAssistance({
      humanUserId: HUMAN, modelId: "openai:main", roomId: "synthetic-room", agentId: "synthetic-agent",
      entrypoint: "foreground.main", fundingKind: "personal",
    }, {
      ...h.deps,
      privateRoom: async () => ownRoom,
      assertInvocation: async () => undefined,
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
      entrypoint: "foreground.fork", fundingKind: "personal",
    }, {
      ...h.deps,
      privateRoom: async () => true,
      assertInvocation: async () => undefined,
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
