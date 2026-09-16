import { describe, expect, test } from "bun:test";

import {
  buildServerCompletionSummary,
  parseServerFinishMode,
  renderServerCompletionSummary,
  resolveServerCompletionDestinations,
} from "../../src/lib/server-completion.ts";

describe("server completion contract", () => {
  test("accepts only the two locked finish modes and defaults to guide", () => {
    expect(parseServerFinishMode(undefined)).toBe("guide");
    expect(parseServerFinishMode("guide")).toBe("guide");
    expect(parseServerFinishMode("product")).toBe("product");
    expect(() => parseServerFinishMode("https://attacker.invalid")).toThrow("--finish");
    expect(() => parseServerFinishMode("Guide")).toThrow("--finish");
  });

  test("derives exact guide and product destinations from a server origin", () => {
    expect(resolveServerCompletionDestinations("https://nautilo.example", "guide")).toEqual({
      serverUrl: "https://nautilo.example",
      guideUrl: "https://nautilo.example/help/server",
      productUrl: "https://nautilo.example/",
      finalUrl: "https://nautilo.example/help/server",
    });
    expect(resolveServerCompletionDestinations("http://localhost:3001/", "product").finalUrl)
      .toBe("http://localhost:3001/");
  });

  test("rejects credentials, arbitrary paths, queries, fragments and non-http schemes", () => {
    for (const value of [
      "https://user:secret@example.com",
      "https://example.com/arbitrary",
      "https://example.com?claim=secret",
      "https://example.com/#secret",
      "file:///tmp/server",
    ]) {
      expect(() => resolveServerCompletionDestinations(value, "guide")).toThrow();
    }
  });

  test("builds stable redacted JSON and human summaries without provider authority", () => {
    const summary = buildServerCompletionSummary({
      backend: "railway",
      operation: "resume",
      outcome: "action-required",
      finish: "guide",
      serverUrl: "https://nautilo.example",
      browser: "not-requested",
      launchId: "00000000-0000-4000-8000-000000000001",
      payer: "customer",
      recoveryCode: "resume-exact-launch",
      nextCommand: "nautilo host resume --launch exact",
      ownerSetupErrorCode: "timeout",
    });
    expect(summary).toMatchObject({
      schemaVersion: 1,
      backend: "railway",
      finish: "guide",
      destinations: { finalUrl: "https://nautilo.example/help/server" },
      recoveryCode: "resume-exact-launch",
    });
    expect(summary).not.toHaveProperty("claim");
    expect(summary).not.toHaveProperty("receipt");
    expect(summary).not.toHaveProperty("credentials");
    expect(renderServerCompletionSummary(summary)).toBe(
      "Nautilo railway resume: action required\n" +
      "Post-claim destination: https://nautilo.example/help/server\n" +
      "Next: nautilo host resume --launch exact\n" +
      "Browser: owner setup not opened; use the exact resume command above.\n" +
      "Owner setup error: timeout\n",
    );
  });
});
