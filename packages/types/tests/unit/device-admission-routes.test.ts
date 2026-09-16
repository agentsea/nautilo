import { describe, expect, test } from "bun:test";
import { isPreAdmissionRequest, PRE_ADMISSION_ROUTE_INVENTORY, preAdmissionRouteKind } from "../../src/device-admission-routes";

describe("shared pre-admission route inventory", () => {
  test("concrete client paths and exact server templates agree", () => {
    for (const { route, kind } of PRE_ADMISSION_ROUTE_INVENTORY) {
      const [method, path] = route.split(" ");
      expect(preAdmissionRouteKind(method!, path)).toBe(kind);
      expect(isPreAdmissionRequest(method!, path!.replace(/:[^/]+/g, "test-id"))).toBe(true);
      expect(isPreAdmissionRequest(method!, `${path!}/extra`)).toBe(false);
    }
  });
  test("does not admit generic admin, content, wrong methods or empty coordinates", () => {
    expect(isPreAdmissionRequest("GET", "/api/admin/users")).toBe(false);
    expect(isPreAdmissionRequest("GET", "/api/rooms")).toBe(false);
    expect(isPreAdmissionRequest("POST", "/api/encryption-transition/policy")).toBe(false);
    expect(isPreAdmissionRequest("POST", "/api/protected/devices/membership//join")).toBe(false);
  });
});
