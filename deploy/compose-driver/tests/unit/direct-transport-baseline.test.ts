import { describe, expect, test } from "bun:test";

import {
  AMBIGUOUS_SERVER_REFUSAL,
  buildDirectTransportBaselineInspectScript,
  DIRECT_TRANSPORT_BASELINE_EXIT,
  DIRECT_TRANSPORT_BASELINE_REFUSAL,
  isDirectTransportConnectionString,
  STALE_TOPOLOGY_WITHOUT_SERVER_REFUSAL,
} from "../../src/direct-transport-baseline.ts";

describe("M215 direct-transport baseline", () => {
  test("accepts direct app-postgres postgres/postgresql URLs on non-4444 ports", () => {
    expect(
      isDirectTransportConnectionString(
        "postgres://nautilo:pw@app-postgres:5432/nautilo",
      ),
    ).toBe(true);
    expect(
      isDirectTransportConnectionString(
        "postgresql://nautilo_agent:pw@app-postgres:5432/nautilo",
      ),
    ).toBe(true);
    expect(
      isDirectTransportConnectionString(
        "postgres://nautilo:pw@app-postgres/nautilo",
      ),
    ).toBe(true);
  });

  test("rejects non-app-postgres hosts, db.localtest.me, proxy hosts, and Neon HTTP port", () => {
    expect(
      isDirectTransportConnectionString(
        "postgres://nautilo:pw@db.localtest.me:5432/nautilo",
      ),
    ).toBe(false);
    expect(
      isDirectTransportConnectionString(
        "postgresql://nautilo_agent:pw@neon-proxy:4444/nautilo",
      ),
    ).toBe(false);
    expect(
      isDirectTransportConnectionString(
        "postgres://nautilo:pw@app-postgres:4444/nautilo",
      ),
    ).toBe(false);
    expect(
      isDirectTransportConnectionString(
        "postgres://nautilo:pw@localhost:5432/nautilo",
      ),
    ).toBe(false);
    expect(
      isDirectTransportConnectionString("http://app-postgres:5432/nautilo"),
    ).toBe(false);
  });

  test("inspect script uses docker ps -aq for stopped or running servers", () => {
    const script = buildDirectTransportBaselineInspectScript("nautilo-beta");
    expect(script).toContain("docker ps -aq");
    expect(script).toContain("com.docker.compose.service=nautilo-server");
    expect(script).not.toContain("docker ps -q --filter");
    expect(script).toContain(`exit ${DIRECT_TRANSPORT_BASELINE_EXIT}`);
    expect(script).toContain(DIRECT_TRANSPORT_BASELINE_REFUSAL);
    expect(script).toContain(STALE_TOPOLOGY_WITHOUT_SERVER_REFUSAL);
    expect(script).toContain(AMBIGUOUS_SERVER_REFUSAL);
    expect(script).toContain('host" != "app-postgres"');
    expect(script).toContain("db.localtest.me");
  });

  test("inspect script refuses ambiguous multiple servers", () => {
    const script = buildDirectTransportBaselineInspectScript("nautilo-gamma");
    expect(script).toContain('if [ "$server_count" -gt 1 ]; then refuse "$ambiguous_refusal"; fi');
    expect(script).toContain(AMBIGUOUS_SERVER_REFUSAL);
  });

  test("inspect script refuses stale retired topology without any server", () => {
    const script = buildDirectTransportBaselineInspectScript("nautilo-delta");
    expect(script).toContain("count_retired");
    expect(script).toContain('if [ "$retired_count" -gt 0 ]; then refuse "$stale_refusal"; fi');
    expect(script).toContain("com.docker.compose.service=$service");
    expect(script).toContain("neon-proxy");
    expect(script).toContain("db-host");
  });

  test("inspect script exits 0 only when zero server and zero retired containers", () => {
    const script = buildDirectTransportBaselineInspectScript("nautilo-qa-source");
    expect(script).toMatch(
      /if \[ "\$server_count" -eq 0 \]; then[\s\S]*exit 0[\s\S]*fi/,
    );
    expect(script).toContain('validate_db_url "$db_url"');
    expect(script).toContain('validate_db_url "$agent_url"');
  });

  test("inspect script validates env from a single stopped-or-running server", () => {
    const script = buildDirectTransportBaselineInspectScript("nautilo-zeta");
    expect(script).toContain(
      'env_raw="$(docker inspect --format \'{{range .Config.Env}}{{println .}}{{end}}\' "$server_id")"',
    );
    expect(script).toContain('read_env DB_CONNECTION_STRING');
    expect(script).toContain('read_env DB_AGENT_CONNECTION_STRING');
  });
});
