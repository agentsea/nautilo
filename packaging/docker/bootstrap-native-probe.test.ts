import { describe, expect, test } from "bun:test";
import { evaluateBootstrapFailureProbes, type BootstrapProbeCommandResult } from "./bootstrap-native-probe-cli.ts";

function result(output: unknown, stream: "stdout" | "stderr" = "stdout"): BootstrapProbeCommandResult {
  return {
    exitCode: 1,
    stdout: stream === "stdout" ? `${JSON.stringify(output)}\n` : "",
    stderr: stream === "stderr" ? `${JSON.stringify(output)}\n` : "",
  };
}

function passingInput() {
  return {
    missingEnvironment: result({
      status: "failed",
      clusters: [],
      failure: { kind: "invalid-environment", code: "missing-app-postgres-admin-url" },
    }),
    invalidMode: result({ status: "failed", code: "invalid-bootstrap-mode" }, "stderr"),
    missingDatabase: result({
      status: "failed",
      clusters: [{
        status: "failed",
        checkpoints: [],
        failure: { kind: "adapter-failure", cluster: "app", stage: "ensure-primary-role", retryable: true },
      }],
      failure: { kind: "reconciliation-failed", cluster: "app" },
    }),
  };
}

describe("D488 bootstrap native failure probes", () => {
  test("accepts bounded invalid-input and missing-database failures", () => {
    expect(evaluateBootstrapFailureProbes(passingInput())).toMatchObject({
      missingEnvironment: { status: "failed" },
      invalidMode: { code: "invalid-bootstrap-mode" },
      missingDatabase: { failure: { kind: "reconciliation-failed", cluster: "app" } },
    });
  });

  test("rejects success, timeout, extra output, and non-retryable database failure", () => {
    expect(() => evaluateBootstrapFailureProbes({
      ...passingInput(),
      missingEnvironment: { ...passingInput().missingEnvironment, exitCode: 0 },
    })).toThrow("exit code 1");
    expect(() => evaluateBootstrapFailureProbes({
      ...passingInput(),
      invalidMode: { ...passingInput().invalidMode, timedOut: true },
    })).toThrow("fail promptly");
    expect(() => evaluateBootstrapFailureProbes({
      ...passingInput(),
      invalidMode: { ...passingInput().invalidMode, stdout: "unexpected" },
    })).toThrow("exactly one JSON stream");
    const missingDatabase = JSON.parse(passingInput().missingDatabase.stdout) as { clusters: Array<{ failure: { retryable: boolean } }> };
    missingDatabase.clusters[0]!.failure.retryable = false;
    expect(() => evaluateBootstrapFailureProbes({
      ...passingInput(),
      missingDatabase: result(missingDatabase),
    })).toThrow("retryable idempotent");
  });
});
