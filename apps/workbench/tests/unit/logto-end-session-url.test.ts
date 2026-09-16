import { describe, expect, it } from "bun:test";
import { mapLogtoEndSessionEndpointForBrowser } from "../../src/lib/nautilo-logto-browser-client";

describe("mapLogtoEndSessionEndpointForBrowser", () => {
  it("rewrites discovery end_session to session/end", () => {
    expect(
      mapLogtoEndSessionEndpointForBrowser("http://localhost:3301/oidc/end_session"),
    ).toBe("http://localhost:3301/oidc/session/end");
  });

  it("leaves session/end unchanged", () => {
    const u = "http://localhost:3301/oidc/session/end";
    expect(mapLogtoEndSessionEndpointForBrowser(u)).toBe(u);
  });

  it("returns original on parse failure", () => {
    expect(mapLogtoEndSessionEndpointForBrowser("not-a-url")).toBe("not-a-url");
  });
});
