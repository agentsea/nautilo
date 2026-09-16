import { describe, expect, test } from "bun:test";
import { parseGenieRecoveryResultV1 } from "@nautilo/types";
import { genieRecoveryResult, genieRecoveryResultFor } from "../../src/tools/genie-recovery";

describe("genie recovery", () => {
  test("serializes only closed semantic producer metadata", () => {
    expect(parseGenieRecoveryResultV1(JSON.parse(genieRecoveryResult("google_workspace", "Sign in.")))).toMatchObject({ recovery: { target: "connections.google", requirement: "login", domainTool: "google_workspace" } });
  });
  test("builds the structured SSH pin recovery without routes", () => {
    expect(genieRecoveryResultFor({ target: "connections.ssh", requirement: "pin", domainTool: "structured_ssh_auth" }, "Enable SSH.")).toMatchObject({ recovery: { target: "connections.ssh", requirement: "pin" } });
  });

  test("keeps old-client fallback text readable and free of routes and sentinels", () => {
    for (const domainTool of ["google_workspace", "task", "in_background", "launch_customization"] as const) {
      const parsed = parseGenieRecoveryResultV1(JSON.parse(genieRecoveryResult(domainTool, "Ask the authorized Human to complete setup, then retry.")));
      expect(parsed.text.length).toBeGreaterThan(0);
      expect(parsed.text).not.toMatch(/NAUTILO_ACTION:|\/connections#|\/settings#/);
    }
  });
});
