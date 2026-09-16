import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NautiloApiClient } from "../../src/client";
import { skillToolOptionsResponseSchema, skillsListResponseSchema } from "../../src/schemas/skills";

const base = "http://127.0.0.1:9";

const listPayload = {
  skills: [{
    name: "writing-guide",
    description: "Keep prose concise.",
    enabled: true,
    source: "user",
    requiresTools: [],
    tokenEstimate: 4,
    updatedAt: "2026-08-09T12:00:00.000Z",
    official: false,
    forked: false,
  }],
  summary: { total: 1, enabled: 1, disabled: 0 },
  catalog: [{ name: "writing-guide", description: "Keep prose concise." }],
};

const detailPayload = { skill: { ...listPayload.skills[0], body: "# Writing guide" } };
const toolOptionsPayload = {
  tools: [{
    name: "run_web_search",
    label: "Web search",
    description: "Search the public web.",
    category: "search",
  }],
};

function url(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function requestBody(init?: RequestInit): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
}

describe("Skills shared client contract", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("parses the server's list, summary, and enabled catalogue without a consumer DTO", () => {
    expect(skillsListResponseSchema.parse(listPayload)).toEqual(listPayload);
    expect(skillToolOptionsResponseSchema.parse(toolOptionsPayload)).toEqual(toolOptionsPayload);
  });

  test("uses the authenticated canonical list, detail, customize, save, enable, reset, and delete endpoints", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("skill-token");
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const requestUrl = url(input);
      const body = requestBody(init);
      seen.push({ url: requestUrl, method: init?.method ?? "GET", body });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer skill-token");
      const payload = requestUrl.endsWith("/api/skills/tool-options")
        ? toolOptionsPayload
        : requestUrl.endsWith("/api/skills") && (init?.method ?? "GET") === "GET"
        ? listPayload
        : requestUrl.endsWith("/reset") || init?.method === "DELETE"
          ? { ok: true }
          : detailPayload;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    expect((await client.listSkills()).summary.enabled).toBe(1);
    expect(await client.listSkillToolOptions()).toEqual(toolOptionsPayload.tools);
    expect((await client.getSkill("writing guide")).body).toContain("Writing");
    await client.customizeSkill("writing guide");
    await client.setSkillEnabled("writing guide", false);
    await client.saveSkill({
      name: "writing-guide",
      description: "Keep prose concise.",
      body: "# Writing guide",
      enabled: false,
      requiresTools: ["file"],
    });
    expect(await client.resetSkill("writing guide")).toEqual({ ok: true });
    expect(await client.deleteSkill("writing guide")).toEqual({ ok: true });

    expect(seen).toEqual([
      { url: `${base}/api/skills`, method: "GET", body: undefined },
      { url: `${base}/api/skills/tool-options`, method: "GET", body: undefined },
      { url: `${base}/api/skills/writing%20guide`, method: "GET", body: undefined },
      { url: `${base}/api/skills/writing%20guide/customize`, method: "POST", body: {} },
      { url: `${base}/api/skills/writing%20guide`, method: "PATCH", body: { enabled: false } },
      { url: `${base}/api/skills`, method: "PUT", body: {
        name: "writing-guide", description: "Keep prose concise.", body: "# Writing guide", enabled: false, requiresTools: ["file"],
      } },
      { url: `${base}/api/skills/writing%20guide/reset`, method: "POST", body: {} },
      { url: `${base}/api/skills/writing%20guide`, method: "DELETE", body: undefined },
    ]);
  });
});
