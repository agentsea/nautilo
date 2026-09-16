import { describe, expect, test } from "bun:test";
import { resolveVeniceSmokeModelId, smokeTestVenice, DEFAULT_VENICE_SMOKE_MODEL_ID } from "../../src/providers/venice-smoke";

describe("smokeTestVenice", () => {
  test("empty apiKey returns ok: false", async () => {
    const r = await smokeTestVenice("  ");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("empty");
  });

  test("non-OK response returns error with status", async () => {
    const r = await smokeTestVenice("k", undefined, {
      fetchImpl: async () =>
        new Response('{"error":"no"}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("401");
    expect(r.latencyMs).toBeDefined();
  });

  test("parses X-Balance-Remaining on success", async () => {
    const r = await smokeTestVenice("k", undefined, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Balance-Remaining": "12.34",
          },
        }),
    });
    expect(r.ok).toBe(true);
    expect(r.balanceUsdRemaining).toBe(12.34);
    expect(r.latencyMs).toBeDefined();
  });

  test("maps venice:sku id to Venice API model field", async () => {
    let body: unknown;
    const r = await smokeTestVenice("k", "venice:zai-org-glm-5-1", {
      fetchImpl: async (_u, init) => {
        const raw = init?.body;
        const text = typeof raw === "string" ? raw : "{}";
        body = JSON.parse(text);
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    expect(r.ok).toBe(true);
    expect((body as { model?: string }).model).toBe("zai-org-glm-5-1");
  });

  test("fetch error becomes ok: false without throw", async () => {
    const r = await smokeTestVenice("k", undefined, {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("network down");
  });
});

describe("resolveVeniceSmokeModelId", () => {
  test("defaults when omitted", () => {
    expect(resolveVeniceSmokeModelId()).toBe(DEFAULT_VENICE_SMOKE_MODEL_ID);
  });

  test("strips venice: prefix", () => {
    expect(resolveVeniceSmokeModelId("venice:my-model")).toBe("my-model");
  });
});
