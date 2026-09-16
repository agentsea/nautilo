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
});
