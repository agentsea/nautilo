import { describe, expect, test } from "bun:test";
import { smokeTestVenice } from "../../src/providers/venice-smoke";

const VENICE_SMOKE_TIMEOUT_MS = 35_000;

describe("smokeTestVenice (live)", () => {
  const key = process.env["VENICE_API_KEY"]?.trim();
  if (!key) {
    test.skip(
      "one-token completion succeeds (missing VENICE_API_KEY)",
      () => {},
    );
  } else {
    test(
      "one-token completion succeeds when VENICE_API_KEY is set",
      async () => {
        const r = await smokeTestVenice(key);
        expect(r.ok).toBe(true);
        expect(r.latencyMs).toBeDefined();
        if (r.balanceUsdRemaining !== undefined) {
          expect(Number.isFinite(r.balanceUsdRemaining)).toBe(true);
        }
      },
      VENICE_SMOKE_TIMEOUT_MS,
    );
  }
});
