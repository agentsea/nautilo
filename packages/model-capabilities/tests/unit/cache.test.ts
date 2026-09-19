import { afterEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readCapabilitiesCacheFromDisk } from "../../src";

const tempDirs: string[] = [];

async function writeCache(raw: unknown): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nautilo-model-cap-cache-"));
  tempDirs.push(dir);
  const file = path.join(dir, "cache.json");
  await fsp.writeFile(file, `${JSON.stringify(raw)}\n`, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("readCapabilitiesCacheFromDisk", () => {
  test("loads valid OpenRouter cache rows", async () => {
    const file = await writeCache({
      fetchedAt: "2026-04-30T00:00:00.000Z",
      models: {
        "openai/gpt-5.5": {
          input: ["text", "image"],
          output: ["text"],
          features: {
            tools: true,
            structuredOutputs: false,
            reasoning: true,
            visualGrounding: null,
          },
        },
        "vendor/grounded": {
          input: ["text", "image"],
          output: ["text"],
          features: { tools: false, structuredOutputs: false, reasoning: false, visualGrounding: true },
        },
        "vendor/not-grounded": {
          input: ["text", "image"],
          output: ["text"],
          features: { tools: false, structuredOutputs: false, reasoning: false, visualGrounding: false },
        },
      },
    });

    const cache = await readCapabilitiesCacheFromDisk(file);
    expect(cache?.models["openai/gpt-5.5"]?.input).toEqual(["text", "image"]);
    expect(cache?.models["openai/gpt-5.5"]?.features?.reasoning).toBe(true);
    expect(cache?.models["openai/gpt-5.5"]?.features?.visualGrounding).toBeNull();
    expect(cache?.models["vendor/grounded"]?.features?.visualGrounding).toBe(true);
    expect(cache?.models["vendor/not-grounded"]?.features?.visualGrounding).toBe(false);
  });

  test("ignores malformed rows instead of trusting invalid modalities", async () => {
    const file = await writeCache({
      fetchedAt: "2026-04-30T00:00:00.000Z",
      models: {
        "bad/model": {
          input: ["system", "image"],
          output: ["text"],
        },
        "also/bad": {
          input: ["text"],
          output: ["video"],
        },
      },
    });

    const cache = await readCapabilitiesCacheFromDisk(file);
    expect(cache?.models).toEqual({
      "bad/model": { input: ["image"], output: ["text"] },
    });
  });

  test("rejects invalid cache envelope", async () => {
    const file = await writeCache({ fetchedAt: "not-a-date", models: {} });
    expect(await readCapabilitiesCacheFromDisk(file)).toBeNull();
  });
});
