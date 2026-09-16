import { describe, expect, test } from "bun:test";
import { redactServerAdminValue } from "../../src/lib/server-admin-output.ts";

describe("signed server-admin output redaction", () => {
  test("removes nested token, URL, header, and stack fields without mutating safe data", () => {
    const redacted = redactServerAdminValue({
      handle: "alice",
      nested: {
        accessToken: "ACCESS_SECRET",
        refresh_token: "REFRESH_SECRET",
        authorization: "Bearer ACCESS_SECRET",
        url: "https://user:password@example.test/path",
        headers: { cookie: "secret" },
        stack: "Error: ACCESS_SECRET",
        retained: "ok",
      },
      rows: [{ token: "OTHER_SECRET", profile: "prod" }],
    });
    const rendered = JSON.stringify(redacted);
    expect(rendered).toContain("alice");
    expect(rendered).toContain("retained");
    expect(rendered).toContain("prod");
    expect(rendered).not.toContain("ACCESS_SECRET");
    expect(rendered).not.toContain("REFRESH_SECRET");
    expect(rendered).not.toContain("password@example");
    expect(rendered).not.toContain("OTHER_SECRET");
  });

  test("drops raw Error, cause, and message projections", () => {
    const upstream = new Error("request failed for https://user:pass@example.test?token=RAW_SECRET", {
      cause: new Error("Bearer RAW_SECRET"),
    });
    const rendered = JSON.stringify(redactServerAdminValue({
      upstream,
      error: { message: upstream.message, cause: upstream.cause },
      safe: "retained",
    }));

    expect(rendered).toBe('{"safe":"retained"}');
  });

  test("redacts secret fields at arbitrary nesting and preserves safe siblings", () => {
    const unsafeKeys = [
      "accessToken", "refresh_token", "Authorization", "cookie", "password",
      "clientSecret", "api-key", "stack", "headers", "requestUrl", "cause",
      "error", "message",
    ];

    for (let depth = 0; depth < 32; depth += 1) {
      const secret = `CANARY_${depth}_DO_NOT_PRINT`;
      let nested: Record<string, unknown> = {
        retained: `safe-${depth}`,
        [unsafeKeys[depth % unsafeKeys.length]!]: secret,
      };
      for (let index = 0; index < depth; index += 1) {
        nested = { retained: `safe-${depth}-${index}`, child: [nested] };
      }

      const rendered = JSON.stringify(redactServerAdminValue(nested));
      expect(rendered).not.toContain(secret);
      expect(rendered).toContain("retained");
    }
  });

  test("cancellation output cannot project an upstream reason", () => {
    const rendered = JSON.stringify(redactServerAdminValue({
      code: "login_cancelled",
      message: "SIGINT while exchanging Bearer CANCEL_SECRET",
      cancellation: {
        cause: "https://user:pass@example.test/callback?token=CANCEL_SECRET",
      },
    }));

    expect(rendered).toBe('{"code":"login_cancelled","cancellation":{}}');
    expect(rendered).not.toContain("CANCEL_SECRET");
  });
});
