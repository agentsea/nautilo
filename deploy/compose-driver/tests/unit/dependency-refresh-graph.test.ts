import { describe, expect, test } from "bun:test";
import type { ComposeDriverProfile } from "../../src/types.ts";
import {
  computeDependencyRefreshRecreate,
  DEPENDENCY_REFRESH_GRAPH,
  FULL_DEPLOY_CHANGED_UPSTREAMS,
  refreshUpstreamsFor,
} from "../../src/dependency-refresh-graph.ts";

const leProfile: ComposeDriverProfile = {
  name: "local-le",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
  domain: "nautilo.example.com",
  https: "letsencrypt",
  acme_email: "ops@example.com",
};

describe("dependency refresh graph (M215)", () => {
  test("caddy recreates after nautilo-server or logto upstream change", () => {
    expect(computeDependencyRefreshRecreate(["nautilo-server"], leProfile)).toEqual([
      "caddy",
    ]);
    expect(computeDependencyRefreshRecreate(["logto"], leProfile)).toEqual(["caddy"]);
  });

  test("full deploy changed upstreams recreate caddy only under LE", () => {
    const recreate = computeDependencyRefreshRecreate(
      FULL_DEPLOY_CHANGED_UPSTREAMS,
      leProfile,
    );
    expect(recreate).toEqual(["caddy"]);
  });

  test("non-LE profile omits caddy from refresh graph", () => {
    const recreate = computeDependencyRefreshRecreate(FULL_DEPLOY_CHANGED_UPSTREAMS, {
      https: "off",
    });
    expect(recreate).toEqual([]);
  });

  test("graph no longer references retired neon-proxy/db-host services", () => {
    const dependents = DEPENDENCY_REFRESH_GRAPH.map((e) => e.dependent);
    const upstreams = DEPENDENCY_REFRESH_GRAPH.flatMap((e) => e.upstreams);
    expect(dependents).not.toContain("db-host");
    expect(dependents).not.toContain("neon-proxy");
    expect(upstreams).not.toContain("neon-proxy");
    expect(FULL_DEPLOY_CHANGED_UPSTREAMS).not.toContain("neon-proxy");
  });

  test("refreshUpstreamsFor(caddy) lists nautilo-server and logto", () => {
    expect(refreshUpstreamsFor("caddy", leProfile)).toEqual([
      "nautilo-server",
      "logto",
    ]);
    expect(refreshUpstreamsFor("db-host", leProfile)).toEqual([]);
  });
});
