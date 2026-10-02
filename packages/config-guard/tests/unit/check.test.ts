import { afterEach, describe, expect, test } from "bun:test";
import { check } from "../../src/index";

const originalFetch = globalThis.fetch;

describe("check()", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  test("reports missing when env var absent", async () => {
    const prev = process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    try {
      const r = await check({ validate: false });
      const openai = r.keys.find((k) => k.id === "openai");
      expect(openai?.status).toBe("missing");
    } finally {
      if (prev !== undefined) {
        process.env["OPENAI_API_KEY"] = prev;
      }
    }
  });

  test("reports present for valid-format key in process.env", async () => {
    const prev = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-123456789012345678901234567890";
    try {
      const r = await check({ validate: false });
      const openai = r.keys.find((k) => k.id === "openai");
      expect(openai?.status).toBe("present");
      expect(openai?.masked).toBeTruthy();
    } finally {
      if (prev === undefined) {
        delete process.env["OPENAI_API_KEY"];
      } else {
        process.env["OPENAI_API_KEY"] = prev;
      }
    }
  });

  test("rejects invalid input with ConfigGuardError VALIDATION", () => {
    return expect(check({ validate: "yes" } as unknown)).rejects.toMatchObject({
      code: "VALIDATION",
      name: "ConfigGuardError",
    });
  });

  test("with validate true, provider 401 maps openai key to invalid_key", async () => {
    const prev = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-123456789012345678901234567890";
    globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    try {
      const r = await check({ validate: true });
      const openai = r.keys.find((k) => k.id === "openai");
      expect(openai?.status).toBe("invalid_key");
      expect(r.summary.invalid).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev === undefined) {
        delete process.env["OPENAI_API_KEY"];
      } else {
        process.env["OPENAI_API_KEY"] = prev;
      }
    }
  });

  test("targeted validation probes one provider and retains the full report", async () => {
    const previousOpenAi = process.env["OPENAI_API_KEY"];
    const previousAnthropic = process.env["ANTHROPIC_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-123456789012345678901234567890";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-123456789012345678901234567890";
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await check({ validate: true, providerId: "openai" });
      expect(urls).toEqual(["https://api.openai.com/v1/models"]);
      expect(result.keys.find(({ id }) => id === "openai")?.status).toBe("verified");
      expect(result.keys.find(({ id }) => id === "anthropic")?.status).toBe("present");
      expect(result.keys.length).toBeGreaterThan(2);
      expect(result.summary.verified).toBe(1);
    } finally {
      if (previousOpenAi === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = previousOpenAi;
      if (previousAnthropic === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previousAnthropic;
    }
  });

  test("rejects an unknown targeted provider before any network request", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const caught = await check({ validate: true, providerId: "unknown-provider" })
      .catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: "VALIDATION" });
    expect(requests).toBe(0);
  });
});
