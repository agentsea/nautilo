import { describe, test, expect, afterEach } from "bun:test";
import { __setStubModelForTests, createUniversalModel } from "../../src/providers/universal";
import type { ChatModel } from "../../src/providers/types";

describe("createUniversalModel stub seam (M067D)", () => {
  afterEach(() => {
    if (process.env["NAUTILO_TEST_MODE"] === "stub") {
      __setStubModelForTests(null);
    }
    delete process.env["NAUTILO_TEST_MODE"];
  });

  test("__setStubModelForTests throws when NAUTILO_TEST_MODE is not stub", () => {
    delete process.env["NAUTILO_TEST_MODE"];
    const stub: ChatModel = {
      async invoke() {
        return { content: "" } as never;
      },
    };
    expect(() => __setStubModelForTests(stub)).toThrow(/NAUTILO_TEST_MODE=stub/);
  });

  test("with NAUTILO_TEST_MODE=stub, createUniversalModel returns injected model", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const stub: ChatModel = {
      async invoke() {
        return { content: "x" } as never;
      },
    };
    __setStubModelForTests(stub);
    const m = await createUniversalModel("openai:anything");
    expect(m).toBe(stub);
    __setStubModelForTests(null);
  });

  test("without stub registered, createUniversalModel does not use test path", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    __setStubModelForTests(null);
    try {
      await createUniversalModel("");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toMatch(/Invalid modelId/);
    }
  });
});
