import { afterEach, describe, expect, mock, test } from "bun:test";
import { checkProviderHealth } from "../../src/health-checker";
import {
  getApprovedMindSwapperDestinations,
  isApprovedMindSwapperDestination,
  normalizeMindSwapperBaseUrl,
} from "../../src/mindswapper";
import { validateOperations } from "../../src/validator";

const first = "https://first.example/v1";
const second = "https://second.example/tenant/v1";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("MindSwapper server configuration", () => {
  test("matches exact normalized HTTPS roots and requires explicit approval", () => {
    const env = {
      MINDSWAPPER_BASE_URL: first,
      MINDSWAPPER_APPROVED_BASE_URLS: ` ${second}/, ${second}, https://user:pass@third.example/v1`,
    };
    expect(normalizeMindSwapperBaseUrl("HTTPS://FIRST.example:443/v1/")).toBe(first);
    expect(normalizeMindSwapperBaseUrl(first + "?")).toBeNull();
    expect(normalizeMindSwapperBaseUrl(first + "#")).toBeNull();
    expect(normalizeMindSwapperBaseUrl("http://localhost:3000/v1", {})).toBeNull();
    expect(normalizeMindSwapperBaseUrl("http://localhost:3000/v1", { NAUTILO_TEST_MODE: "1" }))
      .toBe("http://localhost:3000/v1");
    expect(normalizeMindSwapperBaseUrl("http://first.example/v1", { NAUTILO_TEST_MODE: "1" })).toBeNull();
    expect(getApprovedMindSwapperDestinations(env)).toEqual([second]);
    expect(isApprovedMindSwapperDestination(first, env)).toBe(false);
    expect(isApprovedMindSwapperDestination(second + "/", env)).toBe(true);
    expect(isApprovedMindSwapperDestination("https://second.example/other/v1", env)).toBe(false);
  });

  test("rejects a server destination change that would keep using the previous key", () => {
    const options = { overwrite: true, existingEnv: { MINDSWAPPER_BASE_URL: first, MINDSWAPPER_API_KEY: "old-key" } };
    const url = { type: "set" as const, key: "MINDSWAPPER_BASE_URL", value: second };
    expect(validateOperations([url], options).errors).toEqual(["Provide the MindSwapper key for the new API URL."]);
    expect(validateOperations([url, { type: "set", key: "MINDSWAPPER_API_KEY", value: "new-key" }], options).errors).toEqual([]);
    expect(validateOperations([url], { overwrite: true, existingEnv: {} }).errors).toEqual([]);
  });

  test("checks the key through a read-only request at the exact root without redirects", async () => {
    const check = mock(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json({ data: { label: "test key" } }));
    globalThis.fetch = check as unknown as typeof fetch;
    expect(await checkProviderHealth("mindswapper", "opaque-key", { MINDSWAPPER_BASE_URL: second })).toEqual({ status: "verified" });
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]?.[0]).toBe(second + "/key");
    expect(check.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error", headers: { Authorization: "Bearer opaque-key" },
    });
    expect(await checkProviderHealth("mindswapper", "opaque-key", { MINDSWAPPER_BASE_URL: second + "?x=y" }))
      .toMatchObject({ status: "unreachable" });
    expect(check).toHaveBeenCalledTimes(1);
  });
});
