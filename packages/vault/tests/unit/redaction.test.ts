import { describe, expect, test } from "bun:test";

import {
  StreamScrubber,
  clearRegisteredSecretsForRedaction,
  redactSecretLikeValues,
  redactSecrets,
  registerSecretForRedaction,
  scrubSecrets,
} from "../../src/index.ts";

describe("secret scrubbing", () => {
  test("non-streaming scrub prefers longer overlapping values", () => {
    const result = scrubSecrets("abc123 abc", ["abc", "abc123"]);

    expect(result.text).toBe("[REDACTED CONNECTION] [REDACTED CONNECTION]");
    expect(result.redactions).toBe(2);
  });

  test("stream scrubber handles split tokens across chunks", () => {
    const scrubber = new StreamScrubber(["super-secret-token"]);

    const out =
      scrubber.push("prefix super-") +
      scrubber.push("secret-") +
      scrubber.push("token suffix") +
      scrubber.flush();

    expect(out).toBe("prefix [REDACTED CONNECTION] suffix");
  });

  test("stream scrubber emits safe prefixes without leaking partial secrets", () => {
    const scrubber = new StreamScrubber(["super-secret-token"]);

    const first = scrubber.push("prefix super-");
    const second = scrubber.push("secret-");
    const third = scrubber.push("token suffix plus extra text");
    const flush = scrubber.flush();

    expect(`${first}${second}${third}${flush}`).toBe(
      "prefix [REDACTED CONNECTION] suffix plus extra text",
    );
    expect(`${first}${second}${third}`).not.toContain("super-secret");
  });

  test("registered exact secrets redact before regex scanner", () => {
    clearRegisteredSecretsForRedaction();
    registerSecretForRedaction("sk-proj-knownsecret1234567890");

    const result = redactSecrets("value=sk-proj-knownsecret1234567890");

    expect(result.text).toBe("value=[REDACTED CONNECTION]");
    expect(result.exactRedactions).toBe(1);
    expect(result.leakFindings).toEqual([]);
  });
});

describe("secret-like leak scanner", () => {
  test("redacts common token shapes without exposing findings values", () => {
    const result = redactSecretLikeValues(
      [
        "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
        "url=postgres://user:password@example.com/db",
      ].join("\n"),
    );

    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.text).not.toContain("password@example.com");
    expect(result.findings.map((finding) => finding.id)).toContain("openai_key");
    expect(result.findings.map((finding) => finding.id)).toContain(
      "authorization_header",
    );
    expect(result.findings.map((finding) => finding.id)).toContain("db_url");
  });
});

