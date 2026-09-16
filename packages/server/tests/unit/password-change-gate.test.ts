import { describe, expect, test } from "bun:test";
import {
  passwordChangeRequiredError,
  restrictedPasswordChangeRouteAllowed,
} from "../../src/auth/password-change-gate";

describe("restricted password-change route gate", () => {
  test("allows only identity inspection and exact password-change recovery", () => {
    expect(restrictedPasswordChangeRouteAllowed("GET", "/api/auth/whoami")).toBe(true);
    expect(restrictedPasswordChangeRouteAllowed("GET", "/api/account/security")).toBe(true);
    expect(restrictedPasswordChangeRouteAllowed("POST", "/api/account/password/change")).toBe(true);
    expect(restrictedPasswordChangeRouteAllowed("GET", "/api/admin/users")).toBe(false);
    expect(restrictedPasswordChangeRouteAllowed("POST", "/api/chat")).toBe(false);
    expect(restrictedPasswordChangeRouteAllowed("GET", "/ws")).toBe(false);
    expect(restrictedPasswordChangeRouteAllowed("GET", "/api/account/password/change")).toBe(false);
  });

  test("returns a stable fail-closed public error", () => {
    expect(passwordChangeRequiredError()).toMatchObject({
      statusCode: 403,
      code: "password_change_required",
      publicError: "Password change required",
    });
  });
});
