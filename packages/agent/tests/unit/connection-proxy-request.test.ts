import { describe, expect, test } from "bun:test";

import { buildConnectionProxyRequest } from "../../src/tools/connections/proxy-request";

const requirement = {
  service: "github",
  field: "token",
  category: "user",
  required: false,
  authShape: "bearer_token",
  displayLabel: "GitHub token",
} as const;

describe("Connection proxy request helper", () => {
  test("builds an opaque proxy request without values", () => {
    const out = buildConnectionProxyRequest({
      requirement,
      url: "https://api.github.com/user",
      method: "POST",
      body: JSON.stringify({ query: "nautilo" }),
    });

    expect(out).toEqual({
      service: "github",
      request: {
        field: "token",
        url: "https://api.github.com/user",
        method: "POST",
        category: "user",
        authShape: "bearer_token",
        headers: undefined,
        body: "{\"query\":\"nautilo\"}",
      },
    });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  test("strips caller-supplied auth and local proxy headers", () => {
    const out = buildConnectionProxyRequest({
      requirement,
      url: "https://api.github.com/user",
      headers: {
        Authorization: "Bearer attacker",
        Cookie: "session=attacker",
        "Proxy-Authorization": "Basic attacker",
        "x-nautilo-connection-id": "local",
        Accept: "application/json",
      },
    });

    expect(out.request.headers).toEqual({ Accept: "application/json" });
  });
});
