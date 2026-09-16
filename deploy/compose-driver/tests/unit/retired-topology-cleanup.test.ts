import { describe, expect, test } from "bun:test";

import {
  buildRetiredTopologyCleanupScript,
  RETIRED_TOPOLOGY_CLEANUP_EXIT,
  RETIRED_TOPOLOGY_CLEANUP_FAILURE,
} from "../../src/retired-topology-cleanup.ts";

describe("M215 retired topology cleanup", () => {
  test("cleanup script is project- and service-label scoped only", () => {
    const script = buildRetiredTopologyCleanupScript("nautilo-omega");
    expect(script).toContain('label=com.docker.compose.project=$project');
    expect(script).toContain('label=com.docker.compose.service=$service');
    expect(script).toContain("neon-proxy");
    expect(script).toContain("db-host");
    expect(script).not.toContain("down -v");
    expect(script).not.toContain("remove-orphans");
    expect(script).not.toContain("prune");
    expect(script).not.toMatch(/docker rm[^\n]*nautilo-server/);
  });

  test("cleanup script uses docker rm -f and does not swallow failures", () => {
    const script = buildRetiredTopologyCleanupScript("nautilo-omega");
    expect(script).toContain('docker rm -f "$id"');
    expect(script).not.toContain("|| true");
    expect(script).not.toContain("docker stop");
  });

  test("cleanup script re-queries and fails closed when containers remain", () => {
    const script = buildRetiredTopologyCleanupScript("nautilo-omega");
    expect(script).toContain('remaining="$(docker ps -aq');
    expect(script).toContain(RETIRED_TOPOLOGY_CLEANUP_FAILURE);
    expect(script).toContain(`exit ${RETIRED_TOPOLOGY_CLEANUP_EXIT}`);
    expect(script).toMatch(/for service in .*; do[\s\S]*remaining=/);
  });
});
