import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json";
import { COMPUTER_USE_HOST_VERSION } from "../../src/version.ts";

describe("Computer Use Host build identity", () => {
  test("keeps the closed health version equal to the packaged manifest source", () => {
    expect(COMPUTER_USE_HOST_VERSION).toBe(packageJson.version);
  });
});
