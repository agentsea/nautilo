import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect } from "bun:test";
import {
  MUST_NOT_BYPASS_TRUST_ROUTES,
  TRUST_BYPASS_ROUTE_LIST,
  routeSkipsTrustPreHandler,
} from "../../../src/trust-bypass-routes";

describe("trust bypass route list (M067B meta)", () => {
  test("every configured bypass template is recognized", () => {
    for (const p of TRUST_BYPASS_ROUTE_LIST) {
      expect(routeSkipsTrustPreHandler(p)).toBe(true);
    }
  });

  test("sensitive routes are never bypass templates", () => {
    for (const p of MUST_NOT_BYPASS_TRUST_ROUTES) {
      expect(routeSkipsTrustPreHandler(p)).toBe(false);
    }
  });

  test("keeps every grouped relay-device route behind trust resolution", () => {
    for (const route of [
      "/api/relay/devices/v2",
      "/api/relay/devices/v2/:deviceManagementId",
      "/api/relay/devices/v2/historical/cleanup",
    ]) {
      expect(MUST_NOT_BYPASS_TRUST_ROUTES).toContain(route);
    }
  });

  test("bypasses trust only for the exact body-capability owner prepare route", () => {
    const exact = "/api/owner-claim/prepare-auth";
    expect(TRUST_BYPASS_ROUTE_LIST).toContain(exact);
    expect(routeSkipsTrustPreHandler(exact)).toBe(true);

    // The bypass matcher operates on Fastify's exact route template, never a
    // public prefix or a URL substring. Adjacent controller and arbitrary
    // owner-claim routes must continue through normal trust resolution.
    for (const route of [
      "/api/owner-claim/prepare-auth/extra",
      "/api/owner-claim/prepare-authentication",
      "/api/owner-claim/other",
      "/api/setup/owner-claim",
      "/api/setup/owner-claim/redeem",
    ]) {
      expect(routeSkipsTrustPreHandler(route)).toBe(false);
    }
  });
});
