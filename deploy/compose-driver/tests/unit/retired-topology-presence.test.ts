import { describe, expect, test } from "bun:test";

import {
  buildRetiredTopologyPresenceInspectScript,
  buildRetiredTopologyPresenceQueryScript,
  RETIRED_TOPOLOGY_PRESENCE_EXIT,
  RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT,
  RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT,
  RETIRED_TOPOLOGY_PRESENCE_REFUSAL,
} from "../../src/retired-topology-presence.ts";

describe("M215 retired topology presence preflight", () => {
  test("presence script is read-only and project/service-label scoped", () => {
    const script = buildRetiredTopologyPresenceInspectScript("nautilo-beta");
    expect(script).toContain('label=com.docker.compose.project=$project');
    expect(script).toContain('label=com.docker.compose.service=$service');
    expect(script).toContain("neon-proxy");
    expect(script).toContain("db-host");
    expect(script).toContain("docker ps -aq");
    expect(script).not.toContain("docker rm");
    expect(script).not.toContain("docker stop");
    expect(script).not.toContain("down -v");
  });

  test("presence script refuses with stable --full guidance", () => {
    const script = buildRetiredTopologyPresenceInspectScript("nautilo");
    expect(script).toContain(RETIRED_TOPOLOGY_PRESENCE_REFUSAL);
    expect(script).toContain("nautilo upgrade --full");
    expect(script).toContain(`exit ${RETIRED_TOPOLOGY_PRESENCE_EXIT}`);
  });

  test("presence query script shares exact label filters and returns boolean exit codes", () => {
    const inspect = buildRetiredTopologyPresenceInspectScript("nautilo-beta");
    const query = buildRetiredTopologyPresenceQueryScript("nautilo-beta");
    expect(query).toContain('label=com.docker.compose.project=$project');
    expect(query).toContain('label=com.docker.compose.service=$service');
    expect(query).toContain("neon-proxy");
    expect(query).toContain("db-host");
    expect(query).toContain("docker ps -aq");
    expect(query).not.toContain("docker rm");
    expect(query).not.toContain('refuse "$refusal"');
    expect(query).toContain(`exit ${RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT}`);
    expect(query).toContain(`exit ${RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT}`);
    expect(inspect).toContain('label=com.docker.compose.project=$project');
    expect(inspect).toContain('label=com.docker.compose.service=$service');
  });
});
