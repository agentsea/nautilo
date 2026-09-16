import { describe, expect, test } from "bun:test";
import { resolveComputerUseHostInvocationRequest } from "../../src/runtime/computer-use-admission";

describe("generic Host Computer Use dispatch", () => {
  test("attaches the exact signed descriptor and validated JSON arguments", () => {
    const request = resolveComputerUseHostInvocationRequest("computer_observe", { operation: "desktop_state" });
    expect(request?.contract.contractId).toBeDefined();
    expect(request?.arguments).toEqual({ operation: "desktop_state" });
  });
  test("does not admit unknown model tool names", () => {
    expect(resolveComputerUseHostInvocationRequest("computer_future_unpublished", {})).toBeNull();
  });
});
