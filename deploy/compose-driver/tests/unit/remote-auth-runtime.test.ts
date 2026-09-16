import { describe, expect, test } from "bun:test";

import {
  buildRemoteAuthRuntimeInspectScript,
  mergeManagedRemoteEnv,
  parseRemoteAuthRuntimePorts,
} from "../../src/remote-auth-runtime.ts";

describe("remote adopted auth runtime discovery", () => {
  test("parses beta-style host port bindings independently from operator-local ports", () => {
    expect(
      parseRemoteAuthRuntimePorts(
        "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
      ),
    ).toEqual({
      logtoCoreContainer: 6301,
      logtoCore: 6301,
      logtoAdmin: 6302,
      logtoDb: 8432,
    });
  });

  test("refuses missing, malformed, and out-of-range bindings", () => {
    expect(() =>
      parseRemoteAuthRuntimePorts(
        "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\n",
      ),
    ).toThrow(/logto_db/);
    expect(() =>
      parseRemoteAuthRuntimePorts(
        "logto_core_container=6301\nlogto_core=6301\nlogto_admin=nope\nlogto_db=8432\n",
      ),
    ).toThrow(/logto_admin/);
    expect(() =>
      parseRemoteAuthRuntimePorts(
        "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=70000\n",
      ),
    ).toThrow(/logto_db/);
  });

  test("inspection script is project/service scoped and never prints full container env", () => {
    const script = buildRemoteAuthRuntimeInspectScript("nautilo-beta");

    expect(script).toContain(
      "label=com.docker.compose.project=$project",
    );
    expect(script).toContain(
      "label=com.docker.compose.service=$service",
    );
    expect(script).toContain("find_one logto-postgres");
    expect(script).toContain("sed -n 's/^PORT=//p'");
    expect(script).toContain("sed -n 's/^ADMIN_PORT=//p'");
    expect(script).not.toContain("LOGTO_DB_PASSWORD");
    expect(script).not.toContain("cat /proc");
    expect(script).not.toContain("env |");
  });

  test("merges only managed values into the latest remote environment", () => {
    const current =
      "# canonical remote config\n" +
      "PROVIDER_KEY=concurrent-change\n" +
      "LOGTO_ENDPOINT=https://old.example.test\n" +
      "UNCHANGED='keep exact quoting'\n";
    const reconciled =
      "PROVIDER_KEY=stale-snapshot\n" +
      "LOGTO_ENDPOINT=https://auth.example.test\n" +
      "LOGTO_M2M_APP_SECRET=\"new secret\"\n";

    expect(
      mergeManagedRemoteEnv(current, reconciled, [
        "LOGTO_ENDPOINT",
        "LOGTO_M2M_APP_SECRET",
      ]),
    ).toBe(
      "# canonical remote config\n" +
        "PROVIDER_KEY=concurrent-change\n" +
        "LOGTO_ENDPOINT=https://auth.example.test\n" +
        "UNCHANGED='keep exact quoting'\n" +
        'LOGTO_M2M_APP_SECRET="new secret"\n',
    );
  });

  test("refuses to publish a partial managed environment", () => {
    expect(() =>
      mergeManagedRemoteEnv(
        "PROVIDER_KEY=current\n",
        "LOGTO_ENDPOINT=https://auth.example.test\n",
        ["LOGTO_ENDPOINT", "LOGTO_M2M_APP_SECRET"],
      ),
    ).toThrow(/missing managed key LOGTO_M2M_APP_SECRET/);
  });
});
