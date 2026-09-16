import { describe, expect, test } from "bun:test";
import { HarnessControlPlane, type HarnessExecution } from "@nautilo/runtime";
import {
  createHermesAcpHarnessRegistration,
  HERMES_ACP_HARNESS_DESCRIPTOR,
} from "../../src/acp/harness-registration";

const execution: HarnessExecution = { async *start() {} };

describe("D452 Hermes ACP server registration", () => {
  test("lists static descriptor without reading readiness or constructing a driver", () => {
    let inspected = 0;
    let created = 0;
    const control = new HarnessControlPlane([createHermesAcpHarnessRegistration({
      readiness: { inspect: async () => { inspected += 1; return { executableBasename: "hermes", versionOutput: null, preflight: "missing" }; } },
      createExecution: () => { created += 1; return execution; },
    })]);
    expect(control.listDescriptors()).toEqual([HERMES_ACP_HARNESS_DESCRIPTOR]);
    expect(inspected).toBe(0);
    expect(created).toBe(0);
  });

  test("creates an isolated driver only after exact ready selection and retries a failed readiness", async () => {
    let attempts = 0;
    let created = 0;
    const control = new HarnessControlPlane([createHermesAcpHarnessRegistration({
      readiness: { inspect: async () => {
        attempts += 1;
        return attempts === 1
          ? { executableBasename: "hermes", versionOutput: null, preflight: "missing" } as const
          : { executableBasename: "hermes", versionOutput: new TextEncoder().encode("0.20.4"), preflight: "passed" } as const;
      } },
      createExecution: () => { created += 1; return execution; },
    })]);
    let failure: unknown;
    try { await control.driverFor("hermes-acp"); } catch (error) { failure = error; }
    expect(failure).toMatchObject({
      code: "harness_factory_failed",
      cause: { name: "HermesAcpReadinessError", state: "missing" },
    });
    expect(created).toBe(0);
    const driver = await control.driverFor("hermes-acp");
    expect(driver.execution.start).toBeFunction();
    expect(created).toBe(1);
  });

  test("locks every optional control and request facet out of the Hermes driver", async () => {
    const executionWithOptionalFacets: HarnessExecution = {
      async *start() {},
      async *resume() {},
      stop: async () => undefined,
      steer: async () => undefined,
      respond: async () => undefined,
    };
    const control = new HarnessControlPlane([createHermesAcpHarnessRegistration({
      readiness: { inspect: async () => ({ executableBasename: "hermes", versionOutput: new TextEncoder().encode("0.20.4"), preflight: "passed" }) },
      createExecution: () => executionWithOptionalFacets,
    })]);
    const driver = await control.driverFor("hermes-acp");
    expect(driver.execution.start).toBeFunction();
    expect(driver.execution.resume).toBeUndefined();
    expect(driver.execution.stop).toBeUndefined();
    expect(driver.execution.steer).toBeUndefined();
    expect(driver.execution.respond).toBeUndefined();
    expect(await control.capabilitySnapshot("hermes-acp")).toEqual({
      execution: { declared: "supported", probed: "supported" },
      resume: { declared: "unsupported", probed: "unsupported" },
      stop: { declared: "unsupported", probed: "unsupported" },
      steer: { declared: "unsupported", probed: "unsupported" },
      requests: { declared: "unsupported", probed: "unsupported" },
    });
  });
});
