import { describe, expect, test } from "bun:test";
import { ClassifiedDataOperationError, type DataOperationFailureClass } from "@nautilo/lattice-bridge";
import { routeConductorWithDataOwner } from "../../src/messaging/dispatch";

describe("Conductor actual data-operation composition", () => {
  test.each([
    ["plaintext_only", "fallback", ["ordinary"]],
    ["shadow_encryption", "fallback", ["protected"]],
    ["shadow_encryption", "strict", ["protected"]],
    ["encrypted_only", "strict", ["protected"]],
  ] as const)("%s/%s lazily invokes the selected route", async (mode, shadowBehavior, expected) => {
    const calls: string[] = [];
    expect(await routeConductorWithDataOwner({
      readPolicy: async () => ({ mode, shadowBehavior, revision: 4 }),
      ordinary: async () => { calls.push("ordinary"); return "decision"; },
      protected: async () => { calls.push("protected"); return "decision"; },
    })).toBe("decision");
    expect(calls).toEqual([...expected]);
  });

  test.each([
    ["key_waiting", true], ["recoverable_availability", true],
    ["authority", false], ["integrity", false], ["stale", false],
    ["unsupported", false], ["unknown", false], ["cancelled", false],
  ] satisfies readonly (readonly [DataOperationFailureClass, boolean])[])(
    "Fallback %s ordinary allowed=%s", async (failure, allowed) => {
      const calls: string[] = [];
      const routed = routeConductorWithDataOwner({
        readPolicy: async () => ({
          mode: "shadow_encryption", shadowBehavior: "fallback", revision: 2,
        }),
        ordinary: async () => { calls.push("ordinary"); return "fallback decision"; },
        protected: async () => {
          calls.push("protected");
          throw new ClassifiedDataOperationError(failure, "route unavailable");
        },
      });
      if (allowed) expect(await routed).toBe("fallback decision");
      else expect(await routed.catch((error: unknown) => error)).toBeInstanceOf(ClassifiedDataOperationError);
      expect(calls).toEqual(allowed ? ["protected", "ordinary"] : ["protected"]);
    },
  );

  test("retry suppression is a completed protected outcome, never a second model call", async () => {
    let ordinaryCalls = 0;
    expect(await routeConductorWithDataOwner({
      readPolicy: async () => ({
        mode: "shadow_encryption", shadowBehavior: "fallback", revision: 2,
      }),
      ordinary: async () => { ordinaryCalls++; return null; },
      protected: async () => null,
    })).toBeNull();
    expect(ordinaryCalls).toBe(0);
  });

  test("a policy change during protected routing cannot fall back on the old revision", async () => {
    let revision = 2;
    let ordinaryCalls = 0;
    const error = await routeConductorWithDataOwner({
      readPolicy: async () => ({
        mode: "shadow_encryption", shadowBehavior: "fallback", revision,
      }),
      ordinary: async () => { ordinaryCalls++; return "ordinary"; },
      protected: async () => {
        revision++;
        throw new ClassifiedDataOperationError("key_waiting", "waiting");
      },
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect((error as Error).message).toContain("policy changed");
    expect(ordinaryCalls).toBe(0);
  });
});
