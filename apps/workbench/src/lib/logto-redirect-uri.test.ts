import { describe, expect, test } from "bun:test";
import {
  buildWorkbenchPostLogoutRedirectUri,
  buildWorkbenchRedirectUri,
  canonicalizeLoopbackOrigin,
} from "./logto-redirect-uri";

describe("Workbench Logto redirect URI loopback canonicalization", () => {
  test("rewrites 127.0.0.1 to the canonical localhost origin on the same port", () => {
    expect(
      canonicalizeLoopbackOrigin("http://127.0.0.1:3001", [
        "http://localhost:3001",
        "http://localhost:3000",
      ]),
    ).toBe("http://localhost:3001");
  });

  test("rewrites localhost to canonical 127.0.0.1 when the instance declares it", () => {
    expect(
      canonicalizeLoopbackOrigin("http://localhost:3001", [
        "http://127.0.0.1:3001",
      ]),
    ).toBe("http://127.0.0.1:3001");
  });

  test("does not cross-canonicalize Vite and server ports", () => {
    expect(
      canonicalizeLoopbackOrigin("http://127.0.0.1:3000", [
        "http://localhost:3001",
      ]),
    ).toBe("http://127.0.0.1:3000");
  });

  test("does not rewrite non-loopback origins", () => {
    expect(
      canonicalizeLoopbackOrigin("https://workbench.example.test", [
        "http://localhost:3001",
      ]),
    ).toBe("https://workbench.example.test");
  });

  test("builds callback paths from the current origin", () => {
    expect(
      buildWorkbenchRedirectUri("/auth/callback", "http://127.0.0.1:3001", [
        "http://localhost:3001",
      ]),
    ).toBe("http://127.0.0.1:3001/auth/callback");
  });

  test("normalizes callback paths without changing browser origin", () => {
    expect(
      buildWorkbenchRedirectUri("auth/callback", "http://localhost:3001", [
        "http://127.0.0.1:3001",
      ]),
    ).toBe("http://localhost:3001/auth/callback");
  });

  test("uses the registered root URI for ordinary logout", () => {
    expect(
      buildWorkbenchPostLogoutRedirectUri(undefined, "http://127.0.0.1:3001", [
        "http://localhost:3001",
      ]),
    ).toBe("http://localhost:3001");
  });

  test("uses the closed claim URI without query, fragment, or capability data", () => {
    const uri = buildWorkbenchPostLogoutRedirectUri(
      "/claim",
      "http://127.0.0.1:3001",
      ["http://localhost:3001"],
    );
    const parsed = new URL(uri);
    expect(uri).toBe("http://localhost:3001/claim");
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("");
    expect(uri).not.toContain("inv_");
    expect(uri).not.toContain("capability");
  });
});
