import { describe, expect, test } from "bun:test";
import { bearerResolutionDepthForRoute } from "../../src/auth/bearer-resolution-depth";

describe("bearerResolutionDepthForRoute (M213)", () => {
  test("exact GET /api/auth/whoami → rbac", () => {
    expect(bearerResolutionDepthForRoute("GET", "/api/auth/whoami")).toBe("rbac");
  });

  test("other protected routes remain policy", () => {
    expect(bearerResolutionDepthForRoute("GET", "/api/rooms")).toBe("policy");
    expect(bearerResolutionDepthForRoute("POST", "/api/chat")).toBe("policy");
    expect(bearerResolutionDepthForRoute("GET", "/api/auth/pin-enrollment")).toBe(
      "policy",
    );
  });

  test("whoami-like paths that are not exact whoami stay policy", () => {
    expect(bearerResolutionDepthForRoute("GET", "/api/auth/whoami/extra")).toBe(
      "policy",
    );
    expect(bearerResolutionDepthForRoute("POST", "/api/auth/whoami")).toBe("policy");
  });
});
