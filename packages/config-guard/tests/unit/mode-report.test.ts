import { describe, expect, test } from "bun:test";
import { getModeReport } from "../../src";
import { MODE_REGISTRY } from "../../src/mode-registry";

describe("getModeReport", () => {
  test("every entry under empty env reports as missing", () => {
    const report = getModeReport({});
    for (const entry of report.entries) {
      expect(entry.status).toBe("missing");
      expect(entry.value).toBeNull();
    }
  });

  test("LOGTO entries reflect set values", () => {
    const env = {
      LOGTO_ENDPOINT: "http://localhost:3301",
      LOGTO_M2M_APP_SECRET: "supersecretvalue1234567890abcdef",
    };
    const report = getModeReport(env);

    const endpoint = report.entries.find((e) => e.envVar === "LOGTO_ENDPOINT");
    expect(endpoint?.status).toBe("set");
    expect(endpoint?.value).toBe("http://localhost:3301");
    expect(endpoint?.redacted).toBe(false);
  });

  test("LOGTO_M2M_APP_SECRET is masked, not returned in clear", () => {
    const env = {
      LOGTO_M2M_APP_SECRET: "supersecretvalue1234567890abcdef",
    };
    const report = getModeReport(env);
    const secret = report.entries.find((e) => e.envVar === "LOGTO_M2M_APP_SECRET");
    expect(secret?.status).toBe("set");
    expect(secret?.redacted).toBe(true);
    // Value present but masked — the original must NOT appear in `value`.
    expect(secret?.value).not.toBe("supersecretvalue1234567890abcdef");
    expect(secret?.value).not.toBeNull();
    expect(secret?.value?.startsWith("super")).toBe(true);
    expect(secret?.value?.endsWith("...")).toBe(true);
  });

  test("non-redact entries return values verbatim (trimmed)", () => {
    const env = { LOGTO_WORKBENCH_APP_ID: "  abc-123  " };
    const report = getModeReport(env);
    const wb = report.entries.find((e) => e.envVar === "LOGTO_WORKBENCH_APP_ID");
    expect(wb?.value).toBe("abc-123");
    expect(wb?.redacted).toBe(false);
  });

  test("entry order matches MODE_REGISTRY", () => {
    const report = getModeReport({});
    const reportOrder = report.entries.map((e) => e.envVar);
    const registryOrder = MODE_REGISTRY.map((m) => m.envVar);
    expect(reportOrder).toEqual(registryOrder);
  });

  test("whitespace-only env values report as missing", () => {
    const env = { LOGTO_ENDPOINT: "   " };
    const report = getModeReport(env);
    const endpoint = report.entries.find((e) => e.envVar === "LOGTO_ENDPOINT");
    expect(endpoint?.status).toBe("missing");
    expect(endpoint?.value).toBeNull();
  });

  test("NAUTILO_HOSTNAME entry is marked deprecated when set", () => {
    const report = getModeReport({ NAUTILO_HOSTNAME: "legacy.local" });
    const row = report.entries.find((e) => e.envVar === "NAUTILO_HOSTNAME");
    expect(row?.deprecated).toBe(true);
    expect(row?.status).toBe("set");
    expect(row?.value).toBe("legacy.local");
  });
});
