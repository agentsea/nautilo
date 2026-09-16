/**
 * D086 Phase 4 review blocker #1 — Venice China-routing runtime gate.
 *
 * `getEligibleModels()` already hides curated `china-anonymized` Venice rows
 * from the picker unless `allowChinaUpstream` is true, but a custom `venice:*`
 * id can still be saved as a profile defaultModel and invoked directly through
 * `createUniversalModel`. The gate in `universal.ts` (`assertVeniceRoutingAllowed`)
 * blocks both paths at runtime before any wire request is issued.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { createUniversalModel } from "../../src/providers/universal";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env["VENICE_API_KEY"] = "test-venice-key";
  delete process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"];
});
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
});

async function expectThrows(p: Promise<unknown>, match: RegExp): Promise<string> {
  try {
    await p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toMatch(match);
    return msg;
  }
  throw new Error("expected promise to reject");
}

describe("Venice China-routing runtime gate", () => {
  it("rejects curated china-anonymized SKUs without opt-in", async () => {
    await expectThrows(
      createUniversalModel("venice:qwen-3-8-max"),
      /china-anonymized upstream/i,
    );
  });

  it("rejects custom (non-curated) venice:* ids without opt-in", async () => {
    await expectThrows(
      createUniversalModel("venice:some-unlisted-model-id"),
      /not in the curated catalog/i,
    );
  });

  it("allows china-anonymized SKUs when allowChinaUpstream: true is passed via options", async () => {
    const llm = await createUniversalModel("venice:qwen-3-8-max", {
      allowChinaUpstream: true,
    });
    expect(typeof (llm as { invoke?: unknown }).invoke).toBe("function");
  });

  it("routing consent cannot make an uncatalogued custom Venice model executable", async () => {
    await expectThrows(
      createUniversalModel("venice:custom-experimental", {
        allowChinaUpstream: true,
      }),
      /not present in the active signed catalog/i,
    );
  });

  it("allows china-anonymized SKUs when NAUTILO_ALLOW_CHINA_UPSTREAM=1", async () => {
    process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "1";
    const llm = await createUniversalModel("venice:qwen-3-8-max");
    expect(typeof (llm as { invoke?: unknown }).invoke).toBe("function");
  });

  it("treats env values 'true' and 'yes' as opt-in", async () => {
    for (const v of ["true", "TRUE", "yes", "Yes"]) {
      process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = v;
      const llm = await createUniversalModel("venice:qwen-3-8-max");
      expect(typeof (llm as { invoke?: unknown }).invoke).toBe("function");
    }
  });

  it("rejects when env value is not a recognized truthy form", async () => {
    process.env["NAUTILO_ALLOW_CHINA_UPSTREAM"] = "0";
    await expectThrows(
      createUniversalModel("venice:qwen-3-8-max"),
      /china-anonymized upstream/i,
    );
  });

  it("allows curated venice-hosted SKUs without any opt-in", async () => {
    const llm = await createUniversalModel("venice:zai-org-glm-5-2");
    expect(typeof (llm as { invoke?: unknown }).invoke).toBe("function");
  });

  it("allows curated western-anonymized SKUs without any opt-in", async () => {
    const llm = await createUniversalModel("venice:claude-sonnet-4-6");
    expect(typeof (llm as { invoke?: unknown }).invoke).toBe("function");
  });

  it("gate fires before VENICE_API_KEY check (routing error must not mention VENICE_API_KEY)", async () => {
    delete process.env["VENICE_API_KEY"];
    const msg = await expectThrows(
      createUniversalModel("venice:qwen-3-8-max"),
      /china-anonymized upstream/i,
    );
    expect(msg).not.toMatch(/VENICE_API_KEY/);
  });
});
